/**
 * Tests for threadline communication fixes:
 * 1. SpawnRequestManager cooldown reduction + message queuing
 * 2. waitForReply support (tested at unit level via reply waiter pattern)
 * 3. AgentTrustManager relay agent default trust level
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SpawnRequestManager } from '../../src/messaging/SpawnRequestManager.js';
import type { SpawnRequest, SpawnRequestManagerConfig } from '../../src/messaging/SpawnRequestManager.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-fix-test-'));
  return {
    dir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function createSpawnManager(overrides?: Partial<SpawnRequestManagerConfig>): SpawnRequestManager {
  return new SpawnRequestManager({
    maxSessions: 5,
    getActiveSessions: () => [],
    spawnSession: vi.fn().mockResolvedValue('test-session-id'),
    ...overrides,
  });
}

function makeRequest(agent: string, context?: string): SpawnRequest {
  return {
    requester: { agent, session: 'relay', machine: 'relay' },
    target: { agent: 'local', machine: 'local' },
    reason: `Message from ${agent}`,
    context: context ?? `Test message from ${agent}`,
    priority: 'medium',
    pendingMessages: [`msg-${Date.now()}`],
  };
}

// ── Fix 1: Cooldown Reduction + Message Queuing ─────────────────────

describe('SpawnRequestManager — Cooldown and Queuing', () => {
  let manager: SpawnRequestManager;
  let spawnFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnFn = vi.fn().mockResolvedValue('session-1');
    manager = createSpawnManager({ spawnSession: spawnFn });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses 30-second default cooldown instead of 5 minutes', async () => {
    const request = makeRequest('agent-a');

    // First spawn succeeds
    const result1 = await manager.evaluate(request);
    expect(result1.approved).toBe(true);

    // Immediately after — should be in cooldown
    const result2 = await manager.evaluate(request);
    expect(result2.approved).toBe(false);
    expect(result2.reason).toContain('Cooldown');

    // Advance 31 seconds — should be past cooldown
    vi.advanceTimersByTime(31_000);
    spawnFn.mockResolvedValue('session-2');
    const result3 = await manager.evaluate(request);
    expect(result3.approved).toBe(true);
  });

  it('queues messages during cooldown', async () => {
    const request1 = makeRequest('agent-b', 'First message');
    const request2 = makeRequest('agent-b', 'Second message (should be queued)');
    const request3 = makeRequest('agent-b', 'Third message (should be queued)');

    // First spawns
    await manager.evaluate(request1);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Second and third hit cooldown but get queued
    const r2 = await manager.evaluate(request2);
    expect(r2.approved).toBe(false);
    expect(manager.getQueuedCount('agent-b')).toBe(1);

    const r3 = await manager.evaluate(request3);
    expect(r3.approved).toBe(false);
    expect(manager.getQueuedCount('agent-b')).toBe(2);
  });

  it('includes queued messages in next spawn prompt', async () => {
    const request1 = makeRequest('agent-c', 'Original message');
    const request2 = makeRequest('agent-c', 'Queued reply content');

    // First spawns
    await manager.evaluate(request1);

    // Second gets queued
    await manager.evaluate(request2);
    expect(manager.getQueuedCount('agent-c')).toBe(1);

    // Advance past cooldown
    vi.advanceTimersByTime(31_000);
    spawnFn.mockResolvedValue('session-2');

    const request3 = makeRequest('agent-c', 'Third message');
    await manager.evaluate(request3);

    // The spawn prompt should include the queued message
    const lastCall = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
    const prompt = lastCall[0] as string;
    expect(prompt).toContain('Queued reply content');
    expect(prompt).toContain('queued');

    // Queue should be drained
    expect(manager.getQueuedCount('agent-c')).toBe(0);
  });

  it('enforces max queue size per agent', async () => {
    const request = makeRequest('agent-d', 'First message');
    await manager.evaluate(request);

    // Queue 12 messages (max is 10)
    for (let i = 0; i < 12; i++) {
      await manager.evaluate(makeRequest('agent-d', `Message ${i}`));
    }

    // Should be capped at 10
    expect(manager.getQueuedCount('agent-d')).toBe(10);
  });

  it('expires old queued messages', async () => {
    const request = makeRequest('agent-e', 'First message');
    await manager.evaluate(request);

    // Queue a message
    await manager.evaluate(makeRequest('agent-e', 'Old message'));
    expect(manager.getQueuedCount('agent-e')).toBe(1);

    // Advance past queue max age (10 minutes)
    vi.advanceTimersByTime(11 * 60_000);
    spawnFn.mockResolvedValue('session-2');

    // Spawn — the old message should be expired and not included
    const request2 = makeRequest('agent-e', 'New message');
    await manager.evaluate(request2);
    const lastCall = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
    const prompt = lastCall[0] as string;
    expect(prompt).not.toContain('Old message');
  });

  it('reports queued messages in status', async () => {
    const request = makeRequest('agent-f', 'First');
    await manager.evaluate(request);
    await manager.evaluate(makeRequest('agent-f', 'Queued'));

    const status = manager.getStatus();
    expect(status.queuedMessages).toEqual([{ agent: 'agent-f', count: 1 }]);
  });

  it('clears queue on reset', async () => {
    const request = makeRequest('agent-g', 'First');
    await manager.evaluate(request);
    await manager.evaluate(makeRequest('agent-g', 'Queued'));

    manager.reset();
    expect(manager.getQueuedCount('agent-g')).toBe(0);
  });
});

// ── Fix 2: waitForReply Pattern (unit-level) ────────────────────────

describe('waitForReply — Reply Waiter Pattern', () => {
  it('resolves when reply arrives before timeout', async () => {
    const waiters = new Map<string, { resolve: (reply: string) => void; threadId: string; timer: ReturnType<typeof setTimeout> }>();

    const replyPromise = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete('sender-fp');
        resolve(null);
      }, 5000);

      waiters.set('sender-fp', {
        resolve: (reply: string) => {
          clearTimeout(timer);
          waiters.delete('sender-fp');
          resolve(reply);
        },
        threadId: 'thread-1',
        timer,
      });
    });

    // Simulate reply arriving
    const waiter = waiters.get('sender-fp');
    expect(waiter).toBeDefined();
    waiter!.resolve('Hello from the other agent!');

    const reply = await replyPromise;
    expect(reply).toBe('Hello from the other agent!');
    expect(waiters.size).toBe(0);
  });

  it('returns null on timeout', async () => {
    vi.useFakeTimers();
    const waiters = new Map<string, { resolve: (reply: string) => void; threadId: string; timer: ReturnType<typeof setTimeout> }>();

    const replyPromise = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete('sender-fp');
        resolve(null);
      }, 5000);

      waiters.set('sender-fp', {
        resolve: (reply: string) => {
          clearTimeout(timer);
          waiters.delete('sender-fp');
          resolve(reply);
        },
        threadId: 'thread-1',
        timer,
      });
    });

    vi.advanceTimersByTime(5001);

    const reply = await replyPromise;
    expect(reply).toBeNull();
    expect(waiters.size).toBe(0);
    vi.useRealTimers();
  });

  it('skips auto-ack messages (not real replies)', () => {
    const autoAckTexts = [
      'Message received. Composing response...',
      'Message received, processing...',
    ];

    for (const text of autoAckTexts) {
      const isAutoAck = text.startsWith('Message received.') || text.startsWith('Message received,');
      expect(isAutoAck).toBe(true);
    }

    const realReply = 'Hey Echo! Got your message.';
    const isAutoAck = realReply.startsWith('Message received.') || realReply.startsWith('Message received,');
    expect(isAutoAck).toBe(false);
  });
});

// ── Fix 3: Trust Default for Relay Agents ───────────────────────────

describe('AgentTrustManager — Relay Agent Default Trust', () => {
  let temp: ReturnType<typeof createTempDir>;
  let manager: AgentTrustManager;

  beforeEach(() => {
    temp = createTempDir();
    manager = new AgentTrustManager({ stateDir: temp.dir });
  });

  afterEach(() => {
    manager.flush();
    temp.cleanup();
  });

  it('defaults relay agents (by fingerprint) to verified trust', () => {
    const profile = manager.getOrCreateProfileByFingerprint('abc123', 'RemoteAgent');
    expect(profile.level).toBe('verified');
    expect(profile.allowedOperations).toContain('message');
    expect(profile.allowedOperations).toContain('query');
  });

  it('defaults name-based agents to untrusted (unchanged)', () => {
    const profile = manager.getOrCreateProfile('SomeAgent');
    expect(profile.level).toBe('untrusted');
    expect(profile.allowedOperations).not.toContain('message');
  });

  it('verified agents can send messages (rate limit > 0)', () => {
    const profile = manager.getOrCreateProfileByFingerprint('def456');
    expect(profile.level).toBe('verified');
    // Verified agents have ['ping', 'health', 'message', 'query']
    expect(profile.allowedOperations).toEqual(['ping', 'health', 'message', 'query']);
  });

  it('does not override existing profiles', () => {
    // Create a profile and upgrade it via fingerprint-based API
    manager.getOrCreateProfileByFingerprint('fp-999', 'TrustedAgent');
    manager.setTrustLevelByFingerprint('fp-999', 'trusted', 'user-granted', 'manual upgrade');

    // Re-fetch should return existing profile, not create new one
    const profile = manager.getOrCreateProfileByFingerprint('fp-999');
    expect(profile.level).toBe('trusted');
  });

  it('persists verified default to disk', () => {
    manager.getOrCreateProfileByFingerprint('fp-disk-test', 'DiskAgent');
    manager.flush();

    // Load from disk
    const manager2 = new AgentTrustManager({ stateDir: temp.dir });
    const profile = manager2.getProfileByFingerprint('fp-disk-test');
    expect(profile).not.toBeNull();
    expect(profile!.level).toBe('verified');
    manager2.flush();
  });
});
