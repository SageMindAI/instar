/**
 * Unit tests — UpgradeNotifyManager.
 *
 * Tests the verified delivery of upgrade guides to agents via spawned
 * Claude sessions. Covers the model escalation chain, verification,
 * timeout handling, and prompt construction.
 *
 * Coverage:
 *   1. Returns success immediately when no pending guide exists
 *   2. Spawns session with haiku first
 *   3. On haiku failure, escalates to sonnet
 *   4. Reports success when guide is acknowledged
 *   5. Reports failure when all models exhausted
 *   6. Handles session spawn errors gracefully
 *   7. Handles session timeout
 *   8. Prompt contains guide content
 *   9. Prompt includes 3 required steps (notify, update memory, acknowledge)
 *  10. Prompt includes concrete details (dashboard URL, version)
 *  11. Logs activity on success
 *  12. Logs activity on failure
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  UpgradeNotifyManager,
  type UpgradeNotifyConfig,
  type SessionSpawner,
  type SessionCompletionChecker,
  type ActivityLogger,
} from '../../src/core/UpgradeNotifyManager.js';

describe('UpgradeNotifyManager', () => {
  let tmpDir: string;
  let pendingGuidePath: string;
  let config: UpgradeNotifyConfig;
  let sessionsComplete: Set<string>;
  let activityLog: Array<{ type: string; summary: string; metadata?: Record<string, unknown> }>;
  let spawnCalls: Array<{ name: string; prompt: string; model: string }>;
  let sessionIdCounter: number;

  const GUIDE_CONTENT = `# Instar Upgrade Guide

> You have 1 upgrade guide to process.

---

# Upgrade Guide — v0.9.86

## What Changed
Added hybrid search and MEMORY.md export.

## What to Tell Your User
- Better search and richer memory snapshots.

## Summary of New Capabilities
| Capability | How to Use |
|-----------|-----------|
| Hybrid search | POST /semantic/search |
`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-test-'));
    pendingGuidePath = path.join(tmpDir, 'pending-upgrade-guide.md');

    config = {
      pendingGuidePath,
      projectDir: tmpDir,
      stateDir: tmpDir,
      port: 3000,
      dashboardPin: '1234',
      tunnelUrl: 'https://test.tunnel.dev',
      currentVersion: '0.9.86',
      replyScript: '/path/to/telegram-reply.sh',
      notifyTopicId: 42,
    };

    sessionsComplete = new Set();
    activityLog = [];
    spawnCalls = [];
    sessionIdCounter = 0;
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSpawner(opts: { autoComplete?: boolean } = {}): SessionSpawner {
    return async ({ name, prompt, model }) => {
      sessionIdCounter++;
      const id = `session-${sessionIdCounter}`;
      spawnCalls.push({ name, prompt, model });
      if (opts.autoComplete !== false) {
        sessionsComplete.add(id);
      }
      return {
        id,
        name,
        status: 'running' as const,
        tmuxSession: `tmux-${id}`,
        startedAt: new Date().toISOString(),
        model,
        prompt,
      };
    };
  }

  function createChecker(): SessionCompletionChecker {
    return (sessionId: string) => sessionsComplete.has(sessionId);
  }

  function createLogger(): ActivityLogger {
    return (event) => activityLog.push(event);
  }

  function writePendingGuide() {
    fs.writeFileSync(pendingGuidePath, GUIDE_CONTENT);
  }

  function acknowledgeGuide() {
    // Simulate the agent running `instar upgrade-ack` which removes the pending file
    if (fs.existsSync(pendingGuidePath)) {
      // safe-git-allow: incremental-migration
      fs.unlinkSync(pendingGuidePath);
    }
  }

  // 1. No pending guide — immediate success
  it('returns success immediately when no pending guide exists', async () => {
    const manager = new UpgradeNotifyManager(
      config,
      createSpawner(),
      createChecker(),
      createLogger(),
      { sessionTimeoutMs: 1000, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    const result = await manager.notify();

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(0);
    expect(spawnCalls.length).toBe(0);
  });

  // 2. Spawns haiku first
  it('spawns session with haiku model first', async () => {
    writePendingGuide();

    const spawner = createSpawner();
    const manager = new UpgradeNotifyManager(
      config,
      async (opts) => {
        acknowledgeGuide(); // Simulate success
        return spawner(opts);
      },
      createChecker(),
      createLogger(),
      { sessionTimeoutMs: 1000, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    await manager.notify();

    expect(spawnCalls[0].model).toBe('haiku');
  });

  // 3. Escalates to sonnet on haiku failure
  it('escalates to sonnet when haiku fails to acknowledge', async () => {
    writePendingGuide();

    let attempt = 0;
    const manager = new UpgradeNotifyManager(
      config,
      async (opts) => {
        attempt++;
        const spawner = createSpawner();
        const session = await spawner(opts);
        // Only acknowledge on second attempt (sonnet)
        if (attempt >= 2) {
          acknowledgeGuide();
        }
        return session;
      },
      createChecker(),
      createLogger(),
      { sessionTimeoutMs: 1000, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    const result = await manager.notify();

    expect(result.success).toBe(true);
    expect(result.model).toBe('sonnet');
    expect(result.attempts).toBe(2);
    expect(spawnCalls[0].model).toBe('haiku');
    expect(spawnCalls[1].model).toBe('sonnet');
  });

  // 4. Reports success when acknowledged
  it('reports success when guide is acknowledged', async () => {
    writePendingGuide();

    const manager = new UpgradeNotifyManager(
      config,
      async (opts) => {
        acknowledgeGuide();
        return createSpawner()(opts);
      },
      createChecker(),
      createLogger(),
      { sessionTimeoutMs: 1000, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    const result = await manager.notify();

    expect(result.success).toBe(true);
    expect(result.model).toBe('haiku');
    expect(result.attempts).toBe(1);
  });

  // 5. Reports failure when all models exhausted
  it('reports failure when all models fail to acknowledge', async () => {
    writePendingGuide();

    const manager = new UpgradeNotifyManager(
      config,
      createSpawner(), // Sessions complete but don't acknowledge (don't delete file)
      createChecker(),
      createLogger(),
      { sessionTimeoutMs: 1000, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    const result = await manager.notify();

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.error).toContain('not acknowledged');
  });

  // 6. Handles spawn errors gracefully
  it('handles session spawn errors and continues to next model', async () => {
    writePendingGuide();

    let attempt = 0;
    const manager = new UpgradeNotifyManager(
      config,
      async (opts) => {
        attempt++;
        if (attempt === 1) throw new Error('Haiku spawn failed');
        acknowledgeGuide();
        return createSpawner()(opts);
      },
      createChecker(),
      createLogger(),
      { sessionTimeoutMs: 1000, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    const result = await manager.notify();

    expect(result.success).toBe(true);
    expect(result.model).toBe('sonnet');
    expect(result.attempts).toBe(2);
  });

  // 7. Handles session timeout
  it('handles session timeout and escalates model', async () => {
    writePendingGuide();

    let attempt = 0;
    const manager = new UpgradeNotifyManager(
      config,
      async (opts) => {
        attempt++;
        const id = `timeout-session-${attempt}`;
        if (attempt === 1) {
          // Don't mark session as complete → will timeout
          return {
            id,
            name: opts.name,
            status: 'running' as const,
            tmuxSession: `tmux-${id}`,
            startedAt: new Date().toISOString(),
            model: opts.model,
            prompt: opts.prompt,
          };
        }
        // Second attempt: complete and acknowledge
        sessionsComplete.add(id);
        acknowledgeGuide();
        return {
          id,
          name: opts.name,
          status: 'running' as const,
          tmuxSession: `tmux-${id}`,
          startedAt: new Date().toISOString(),
          model: opts.model,
          prompt: opts.prompt,
        };
      },
      createChecker(),
      createLogger(),
      { sessionTimeoutMs: 200, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    const result = await manager.notify();

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  // 8. Prompt contains guide content
  it('prompt contains the upgrade guide content', () => {
    const manager = new UpgradeNotifyManager(
      config,
      createSpawner(),
      createChecker(),
      createLogger(),
    );

    const prompt = manager.buildPrompt(GUIDE_CONTENT);

    expect(prompt).toContain('hybrid search');
    expect(prompt).toContain('MEMORY.md export');
    expect(prompt).toContain('--- UPGRADE GUIDE ---');
    expect(prompt).toContain('--- END GUIDE ---');
  });

  // 9. Prompt includes 3 required steps
  it('prompt includes all 3 required steps', () => {
    const manager = new UpgradeNotifyManager(
      config,
      createSpawner(),
      createChecker(),
      createLogger(),
    );

    const prompt = manager.buildPrompt(GUIDE_CONTENT);

    expect(prompt).toContain('Step 1: Notify your user');
    expect(prompt).toContain('Step 2: Update your memory');
    expect(prompt).toContain('Step 3: Acknowledge');
    expect(prompt).toContain('instar upgrade-ack');
  });

  // 10. Prompt includes concrete details
  it('prompt includes dashboard URL, PIN, version, and Telegram details', () => {
    const manager = new UpgradeNotifyManager(
      config,
      createSpawner(),
      createChecker(),
      createLogger(),
    );

    const prompt = manager.buildPrompt(GUIDE_CONTENT);

    expect(prompt).toContain('https://test.tunnel.dev/dashboard');
    expect(prompt).toContain('1234'); // PIN
    expect(prompt).toContain('0.9.86'); // version
    expect(prompt).toContain('telegram-reply.sh');
    expect(prompt).toContain('42'); // topic ID
  });

  // 11. Logs activity on success
  it('logs success activity event', async () => {
    writePendingGuide();

    const manager = new UpgradeNotifyManager(
      config,
      async (opts) => {
        acknowledgeGuide();
        return createSpawner()(opts);
      },
      createChecker(),
      createLogger(),
      { sessionTimeoutMs: 1000, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    await manager.notify();

    const successEvent = activityLog.find(e => e.type === 'upgrade_notify_success');
    expect(successEvent).toBeTruthy();
    expect(successEvent!.summary).toContain('acknowledged');
  });

  // 12. Logs activity on failure
  it('logs failure activity event', async () => {
    writePendingGuide();

    const manager = new UpgradeNotifyManager(
      config,
      createSpawner(), // Won't acknowledge
      createChecker(),
      createLogger(),
      { sessionTimeoutMs: 1000, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    await manager.notify();

    const failEvent = activityLog.find(e => e.type === 'upgrade_notify_failed');
    expect(failEvent).toBeTruthy();
    expect(failEvent!.summary).toContain('failed');
  });
});
