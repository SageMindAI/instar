/**
 * Integration-style test for HelperWatchdog's expected contract with
 * a SessionManager-shaped consumer — proves that stall and helper-failed
 * events produce injectable alert strings containing the agent id,
 * type, and failure reason. The real wire-up lives in
 * src/commands/server.ts; this test pins the event payload shape the
 * wire-up depends on so a payload rename can't silently regress it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';
import { HelperWatchdog } from '../../src/monitoring/HelperWatchdog.js';

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-wireup-'));
  // safe-git-allow: incremental-migration
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('HelperWatchdog wire-up contract', () => {
  it('helper-failed event carries the fields server.ts relies on', () => {
    const { dir, cleanup } = tmp();
    try {
      const tracker = new SubagentTracker({ stateDir: dir });
      const wd = new HelperWatchdog({ subagentTracker: tracker });
      wd.start();

      const captured: Array<{ record: { agentId: string; agentType: string; sessionId: string; lastMessage: string | null }; reason: string }> = [];
      wd.on('helper-failed', (e) => captured.push(e as typeof captured[0]));

      tracker.onStart('agent-X', 'Explore', 'sess-1');
      tracker.onStop('agent-X', 'sess-1', '429 rate limit hit');

      expect(captured.length).toBe(1);
      const e = captured[0];
      expect(e.record.agentId).toBe('agent-X');
      expect(e.record.agentType).toBe('Explore');
      expect(e.record.sessionId).toBe('sess-1');
      expect(e.reason).toBe('rate-limit');
      expect(typeof e.record.lastMessage).toBe('string');

      // The server wire-up constructs a message like this — verify the
      // derived alert string is non-empty and includes the key fields.
      const snippet = (e.record.lastMessage ?? '').slice(0, 160);
      const msg = `[helper-watchdog] Your ${e.record.agentType} helper (agent ${e.record.agentId}) died with reason=${e.reason}. Last message: ${snippet}`;
      expect(msg).toContain('Explore');
      expect(msg).toContain('agent-X');
      expect(msg).toContain('rate-limit');
      expect(msg).toContain('429');
    } finally {
      cleanup();
    }
  });

  it('stall event carries the fields server.ts relies on', () => {
    const { dir, cleanup } = tmp();
    try {
      const tracker = new SubagentTracker({ stateDir: dir });
      const fakeTimers: Array<() => void> = [];
      const wd = new HelperWatchdog({
        subagentTracker: tracker,
        stallTimeoutMs: 1000,
        setTimeoutFn: (fn) => {
          fakeTimers.push(fn);
          return 1 as unknown as NodeJS.Timeout;
        },
        clearTimeoutFn: () => {},
      });
      wd.start();

      const captured: Array<{ agentId: string; agentType: string; sessionId: string; elapsedMs: number }> = [];
      wd.on('stall', (e) => captured.push(e as typeof captured[0]));

      tracker.onStart('agent-Y', 'Plan', 'sess-2');
      fakeTimers[0]();

      expect(captured.length).toBe(1);
      const e = captured[0];
      expect(e.agentId).toBe('agent-Y');
      expect(e.agentType).toBe('Plan');
      expect(e.sessionId).toBe('sess-2');
      expect(typeof e.elapsedMs).toBe('number');
    } finally {
      cleanup();
    }
  });
});
