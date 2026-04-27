/**
 * Unit tests for DeliveryRetryManager — retry, watchdog, and TTL expiry.
 *
 * Tests:
 * - Layer 2 retry: queued messages retried with 30s intervals, max 10 retries
 * - Layer 3 timeout: delivered messages escalated if ACK timeout exceeded
 * - Watchdog: post-injection monitoring detects session crash, regresses to queued
 * - TTL expiry: expired messages dead-lettered
 * - Escalation: critical/alert messages trigger callback on expiry
 * - Start/stop lifecycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageDelivery, type TmuxOperations } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { DeliveryRetryManager } from '../../src/messaging/DeliveryRetryManager.js';
import type { MessageEnvelope, AgentMessage } from '../../src/messaging/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-retry-test-'));
}

function makeMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: { agent: 'sender', session: 'session-1', machine: 'test-machine' },
    to: { agent: 'test-agent', session: 'target-session', machine: 'local' },
    type: 'info',
    priority: 'medium',
    subject: 'Test message',
    body: 'Hello, world!',
    createdAt: new Date().toISOString(),
    ttlMinutes: 30,
    ...overrides,
  };
}

function makeEnvelope(overrides?: Partial<AgentMessage>): MessageEnvelope {
  return {
    schemaVersion: 1,
    message: makeMessage(overrides),
    transport: {
      relayChain: [],
      originServer: 'http://localhost:3000',
      nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
      timestamp: new Date().toISOString(),
    },
    delivery: {
      phase: 'queued',
      transitions: [
        { from: 'created', to: 'sent', at: new Date().toISOString() },
        { from: 'sent', to: 'queued', at: new Date().toISOString() },
      ],
      attempts: 0,
    },
  };
}

function makeTmux(overrides?: Partial<TmuxOperations>): TmuxOperations {
  return {
    getForegroundProcess: () => 'bash',
    isSessionAlive: () => true,
    hasActiveHumanInput: () => false,
    sendKeys: () => true,
    getOutputLineCount: () => 100,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('DeliveryRetryManager', () => {
  let tmpDir: string;
  let store: MessageStore;
  let tmuxOps: TmuxOperations;
  let delivery: MessageDelivery;
  let manager: DeliveryRetryManager;
  let escalations: Array<{ envelope: MessageEnvelope; reason: string }>;

  beforeEach(async () => {
    tmpDir = createTempDir();
    store = new MessageStore(tmpDir);
    await store.initialize();
    tmuxOps = makeTmux();
    delivery = new MessageDelivery(new MessageFormatter(), tmuxOps);
    escalations = [];

    manager = new DeliveryRetryManager(store, delivery, {
      agentName: 'test-agent',
      onEscalate: (envelope, reason) => {
        escalations.push({ envelope, reason });
      },
    });
  });

  afterEach(() => {
    manager.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Layer 2 Retry ──────────────────────────────────────────

  describe('Layer 2 retry', () => {
    it('retries queued messages when delivery succeeds', async () => {
      const env = makeEnvelope();
      await store.save(env);

      const result = await manager.tick();
      expect(result.retried).toBe(1);

      // Check message is now delivered
      const updated = await store.get(env.message.id);
      expect(updated!.delivery.phase).toBe('delivered');
    });

    it('does not retry if delivery fails', async () => {
      tmuxOps = makeTmux({ isSessionAlive: () => false });
      delivery = new MessageDelivery(new MessageFormatter(), tmuxOps);
      manager = new DeliveryRetryManager(store, delivery, {
        agentName: 'test-agent',
      });

      const env = makeEnvelope();
      await store.save(env);

      const result = await manager.tick();
      expect(result.retried).toBe(0);

      const updated = await store.get(env.message.id);
      expect(updated!.delivery.phase).toBe('queued');
    });

    it('registers watchdog after successful retry', async () => {
      const env = makeEnvelope();
      await store.save(env);

      await manager.tick();

      // The watchdog map is private but we can verify behavior:
      // After 10s, the watchdog should check the session
      // For now, just verify the message was delivered
      const updated = await store.get(env.message.id);
      expect(updated!.delivery.phase).toBe('delivered');
    });

    it('skips messages that were just retried (respects interval)', async () => {
      const env = makeEnvelope();
      await store.save(env);

      // First tick retries
      const result1 = await manager.tick();
      expect(result1.retried).toBe(1);

      // Mark it as queued again (simulating a regression)
      const updated = await store.get(env.message.id);
      updated!.delivery.phase = 'queued';
      await store.updateEnvelope(updated!);

      // Second tick should skip (too soon)
      const result2 = await manager.tick();
      expect(result2.retried).toBe(0);
    });

    it('retries undelivered messages identically to queued (SpawnRequestManager handoff)', async () => {
      const env = makeEnvelope();
      env.delivery.phase = 'undelivered';
      env.delivery.transitions.push({
        from: 'queued',
        to: 'undelivered',
        at: new Date().toISOString(),
        reason: 'SpawnRequestManager dispose handoff',
      });
      await store.save(env);

      const result = await manager.tick();
      expect(result.retried).toBe(1);

      const updated = await store.get(env.message.id);
      expect(updated!.delivery.phase).toBe('delivered');
      // Transition must record the actual from-phase (undelivered), not hardcode 'queued'.
      const lastTransition = updated!.delivery.transitions.at(-1);
      expect(lastTransition).toMatchObject({
        from: 'undelivered',
        to: 'delivered',
      });
    });
  });

  // ── TTL Expiry ──────────────────────────────────────────────

  describe('TTL expiry', () => {
    it('dead-letters expired messages', async () => {
      const env = makeEnvelope({
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 1 hour ago
        ttlMinutes: 30, // 30 min TTL → expired
      });
      await store.save(env);

      const result = await manager.tick();
      expect(result.expired).toBe(1);

      // Should be in dead-letter
      const deadLetters = await store.queryDeadLetters();
      expect(deadLetters.find(d => d.message.id === env.message.id)).toBeDefined();
    });

    it('does not expire messages within TTL', async () => {
      const env = makeEnvelope({
        ttlMinutes: 60, // 1 hour TTL, fresh message
      });
      await store.save(env);

      // Should retry, not expire
      const result = await manager.tick();
      expect(result.expired).toBe(0);
    });

    it('escalates critical messages on expiry', async () => {
      const env = makeEnvelope({
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        ttlMinutes: 30,
        priority: 'critical',
      });
      await store.save(env);

      const result = await manager.tick();
      expect(result.escalated).toBe(1);
      expect(escalations.length).toBe(1);
      expect(escalations[0].reason).toContain('expired');
      expect(escalations[0].reason).toContain('critical');
    });

    it('escalates alert type messages on expiry', async () => {
      const env = makeEnvelope({
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        ttlMinutes: 30,
        type: 'alert',
      });
      await store.save(env);

      const result = await manager.tick();
      expect(result.escalated).toBe(1);
    });

    it('does not escalate low-priority info messages on expiry', async () => {
      const env = makeEnvelope({
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        ttlMinutes: 30,
        type: 'info',
        priority: 'low',
      });
      await store.save(env);

      const result = await manager.tick();
      expect(result.escalated).toBe(0);
    });
  });

  // ── Layer 3 ACK Timeout ────────────────────────────────────

  describe('Layer 3 ACK timeout', () => {
    it('escalates query messages after 5-minute ACK timeout', async () => {
      const sixMinAgo = new Date(Date.now() - 6 * 60_000).toISOString();
      const env = makeEnvelope({ type: 'query' });
      env.delivery.phase = 'delivered';
      env.delivery.transitions.push({
        from: 'queued',
        to: 'delivered',
        at: sixMinAgo,
      });
      await store.save(env);

      const result = await manager.tick();
      expect(result.escalated).toBe(1);
      expect(result.expired).toBe(1);
      expect(escalations[0].reason).toContain('ACK timeout');
      expect(escalations[0].reason).toContain('5 minutes');
    });

    it('escalates request messages after 10-minute ACK timeout', async () => {
      const elevenMinAgo = new Date(Date.now() - 11 * 60_000).toISOString();
      const env = makeEnvelope({ type: 'request' });
      env.delivery.phase = 'delivered';
      env.delivery.transitions.push({
        from: 'queued',
        to: 'delivered',
        at: elevenMinAgo,
      });
      await store.save(env);

      const result = await manager.tick();
      expect(result.escalated).toBe(1);
    });

    it('escalates wellness messages after 2-minute ACK timeout', async () => {
      const threeMinAgo = new Date(Date.now() - 3 * 60_000).toISOString();
      const env = makeEnvelope({ type: 'wellness' });
      env.delivery.phase = 'delivered';
      env.delivery.transitions.push({
        from: 'queued',
        to: 'delivered',
        at: threeMinAgo,
      });
      await store.save(env);

      const result = await manager.tick();
      expect(result.escalated).toBe(1);
    });

    it('does not timeout info messages (fire-and-forget)', async () => {
      const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
      const env = makeEnvelope({ type: 'info', ttlMinutes: 120 });
      env.delivery.phase = 'delivered';
      env.delivery.transitions.push({
        from: 'queued',
        to: 'delivered',
        at: hourAgo,
      });
      await store.save(env);

      const result = await manager.tick();
      expect(result.escalated).toBe(0);
      expect(result.expired).toBe(0);
    });

    it('does not timeout recently delivered messages', async () => {
      const justNow = new Date().toISOString();
      const env = makeEnvelope({ type: 'query' });
      env.delivery.phase = 'delivered';
      env.delivery.transitions.push({
        from: 'queued',
        to: 'delivered',
        at: justNow,
      });
      await store.save(env);

      const result = await manager.tick();
      expect(result.escalated).toBe(0);
    });
  });

  // ── Watchdog ────────────────────────────────────────────────

  describe('post-injection watchdog', () => {
    it('regresses delivered to queued when session crashes', async () => {
      const env = makeEnvelope();
      env.delivery.phase = 'delivered';
      env.delivery.transitions.push({
        from: 'queued',
        to: 'delivered',
        at: new Date().toISOString(),
      });
      await store.save(env);

      // Register watchdog with timestamp in the past (> 10s ago)
      manager.registerWatchdog(env.message.id);
      // Simulate time passing by directly setting the internal timestamp
      const watchdogMap = (manager as any).watchdogTargets as Map<string, number>;
      watchdogMap.set(env.message.id, Date.now() - 11_000); // 11 seconds ago

      // Session's foreground changed to something unsafe (crash/restart)
      tmuxOps = makeTmux({ getForegroundProcess: () => 'python' });
      delivery = new MessageDelivery(new MessageFormatter(), tmuxOps);
      (manager as any).delivery = delivery;

      await manager.tick();

      const updated = await store.get(env.message.id);
      expect(updated!.delivery.phase).toBe('queued');
      const lastTransition = updated!.delivery.transitions.at(-1);
      expect(lastTransition?.from).toBe('delivered');
      expect(lastTransition?.to).toBe('queued');
      expect(lastTransition?.reason).toContain('Watchdog');
    });

    it('leaves delivered messages alone when session is healthy', async () => {
      const env = makeEnvelope();
      env.delivery.phase = 'delivered';
      env.delivery.transitions.push({
        from: 'queued',
        to: 'delivered',
        at: new Date().toISOString(),
      });
      await store.save(env);

      manager.registerWatchdog(env.message.id);
      const watchdogMap = (manager as any).watchdogTargets as Map<string, number>;
      watchdogMap.set(env.message.id, Date.now() - 11_000);

      await manager.tick();

      const updated = await store.get(env.message.id);
      expect(updated!.delivery.phase).toBe('delivered');
    });

    it('ignores watchdog for messages not yet at 10s', async () => {
      const env = makeEnvelope();
      env.delivery.phase = 'delivered';
      await store.save(env);

      manager.registerWatchdog(env.message.id);
      // Default timestamp is Date.now(), so < 10s

      await manager.tick();

      // Watchdog should NOT have acted
      const watchdogMap = (manager as any).watchdogTargets as Map<string, number>;
      expect(watchdogMap.has(env.message.id)).toBe(true);
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('start and stop are idempotent', () => {
      manager.start();
      manager.start(); // No error
      manager.stop();
      manager.stop(); // No error
    });

    it('no escalation when callback not provided', async () => {
      const noEscalate = new DeliveryRetryManager(store, delivery, {
        agentName: 'test-agent',
        // No onEscalate
      });

      const env = makeEnvelope({
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        ttlMinutes: 30,
        priority: 'critical',
      });
      await store.save(env);

      // Should not throw
      const result = await noEscalate.tick();
      expect(result.expired).toBe(1);
      expect(result.escalated).toBe(0);

      noEscalate.stop();
    });

    it('handles empty inbox gracefully', async () => {
      const result = await manager.tick();
      expect(result.retried).toBe(0);
      expect(result.expired).toBe(0);
      expect(result.escalated).toBe(0);
    });
  });
});
