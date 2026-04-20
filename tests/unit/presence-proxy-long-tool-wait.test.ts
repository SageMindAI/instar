/**
 * PresenceProxy long-tool-wait detector
 * (BUILD-STALL-VISIBILITY-SPEC Fix 3).
 *
 * Verifies:
 *   - Detector off (default) — never returns a swap message.
 *   - Detector on — emits swap after enterThresholdMs of unchanged snapshot.
 *   - Hysteresis exit — sustained new text for ≥ exitHysteresisMs leaves the state.
 *   - Escalation cap — fires once after escalationCapMs, then goes silent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function mkProxy(overrides: Record<string, unknown> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ltw-'));
  const config: any = {
    stateDir,
    intelligence: null,
    agentName: 'echo',
    captureSessionOutput: () => '',
    getSessionForTopic: () => 'sess-1',
    isSessionAlive: () => true,
    sendMessage: async () => { /* no-op */ },
    getAuthorizedUserIds: () => [],
    getProcessTree: () => [],
    longToolWaitDetector: { enabled: true, enterThresholdMs: 60_000, exitHysteresisMs: 5_000, escalationCapMs: 300_000 },
    ...overrides,
  };
  const proxy = new PresenceProxy(config);
  proxy.start();
  return proxy;
}

describe('PresenceProxy long-tool-wait detector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T00:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('off by default — never returns a swap message', () => {
    const proxy = mkProxy({ longToolWaitDetector: undefined });
    proxy.recordToolWait(1, 'Monitor');
    vi.advanceTimersByTime(20 * 60_000);
    expect(proxy.getLongToolWaitMessage(1)).toBeNull();
  });

  it('returns null before enterThresholdMs is reached', () => {
    const proxy = mkProxy();
    proxy.recordToolWait(1, 'Monitor');
    vi.advanceTimersByTime(30_000); // half of 60s threshold
    expect(proxy.getLongToolWaitMessage(1)).toBeNull();
  });

  it('emits swap message after enterThresholdMs of unchanged snapshot', () => {
    const proxy = mkProxy();
    proxy.recordToolWait(1, 'Monitor');
    vi.advanceTimersByTime(60_001);
    const msg = proxy.getLongToolWaitMessage(1);
    expect(msg).not.toBeNull();
    expect(msg).toContain('Monitor');
    expect(msg).toMatch(/elapsed \d+m/);
  });

  it('exits long-wait after sustained new text ≥ exitHysteresisMs', () => {
    const proxy = mkProxy();
    proxy.recordToolWait(1, 'Monitor');
    vi.advanceTimersByTime(61_000);
    expect(proxy.getLongToolWaitMessage(1)).not.toBeNull(); // entered

    // First text — starts the sustained window
    proxy.recordAgentText(1, 'h1');
    vi.advanceTimersByTime(2_000); // not yet at hysteresis
    proxy.recordAgentText(1, 'h2');
    expect(proxy.getLongToolWaitMessage(1)).toBeNull(); // suppressed (escalated path? no — still long-wait but quiet)

    // Cross hysteresis (5s)
    vi.advanceTimersByTime(4_000);
    proxy.recordAgentText(1, 'h3'); // 6s of sustained text → should exit

    // After exit, recordToolWait again must restart the timer from zero
    proxy.recordToolWait(1, 'Monitor');
    vi.advanceTimersByTime(30_000);
    expect(proxy.getLongToolWaitMessage(1)).toBeNull();
  });

  it('emits one-time escalation message at escalationCapMs, then stays silent', () => {
    const proxy = mkProxy();
    proxy.recordToolWait(1, 'Bash-test');
    vi.advanceTimersByTime(61_000);
    const first = proxy.getLongToolWaitMessage(1);
    expect(first).not.toBeNull();
    expect(first).not.toContain('escalating');

    // Advance past escalation cap (5 min total long-wait)
    vi.advanceTimersByTime(300_001);
    const escalation = proxy.getLongToolWaitMessage(1);
    expect(escalation).not.toBeNull();
    expect(escalation).toContain('escalating');

    // After escalation: silent forever (until exit).
    vi.advanceTimersByTime(60_000);
    expect(proxy.getLongToolWaitMessage(1)).toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    expect(proxy.getLongToolWaitMessage(1)).toBeNull();
  });

  it('keys per topic — one topic in long-wait does not affect another', () => {
    const proxy = mkProxy();
    proxy.recordToolWait(1, 'Monitor');
    proxy.recordToolWait(2, 'Bash-tsc');
    vi.advanceTimersByTime(61_000);
    const m1 = proxy.getLongToolWaitMessage(1);
    const m2 = proxy.getLongToolWaitMessage(2);
    expect(m1).toContain('Monitor');
    expect(m2).toContain('Bash-tsc');
  });
});
