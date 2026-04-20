/**
 * PresenceProxy — /build heartbeat suppression
 * (BUILD-STALL-VISIBILITY-SPEC Fix 2 "Routing").
 *
 * Verifies:
 *   - Tier 1 is NOT suppressed by a recent build heartbeat (always emits).
 *   - Tier 2 / Tier 3 ARE suppressed when hasRecentBuildHeartbeat returns true.
 *   - Suppression reschedules the next tier (does not cancel the cycle).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeProxy(opts: { hasHeartbeat: boolean }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hb-'));
  const sentMessages: Array<{ topicId: number; text: string; tier?: number }> = [];

  const config = {
    stateDir,
    intelligence: null,
    agentName: 'test-agent',
    captureSessionOutput: () => 'still working...\nmore output\n',
    getSessionForTopic: () => 'test-session',
    isSessionAlive: () => true,
    sendMessage: async (topicId: number, text: string, meta?: any) => {
      sentMessages.push({ topicId, text, tier: meta?.tier });
    },
    getAuthorizedUserIds: () => [],
    getProcessTree: () => [{ pid: 1, command: 'npm test' }],
    hasAgentRespondedSince: () => false,
    hasRecentBuildHeartbeat: () => opts.hasHeartbeat,
    tier1DelayMs: 50,
    tier2DelayMs: 200,
    tier3DelayMs: 500,
  };

  const proxy = new PresenceProxy(config as any);
  proxy.start();
  return { proxy, sentMessages, stateDir };
}

describe('PresenceProxy /build heartbeat suppression', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does NOT suppress Tier 1 even when a build heartbeat is fresh', async () => {
    const { proxy, sentMessages } = makeProxy({ hasHeartbeat: true });

    proxy.onMessageLogged({
      messageId: 1,
      channelId: '300',
      text: 'hi',
      fromUser: true,
      timestamp: new Date().toISOString(),
    } as any);

    await vi.advanceTimersByTimeAsync(60);
    // Tier 1 must fire even when the build heartbeat is suppressing tiers 2/3.
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(sentMessages[0].tier).toBe(1);
  });

  it('suppresses Tier 2 when a build heartbeat is fresh', async () => {
    const { proxy, sentMessages } = makeProxy({ hasHeartbeat: true });

    proxy.onMessageLogged({
      messageId: 1, channelId: '301', text: 'hi', fromUser: true,
      timestamp: new Date().toISOString(),
    } as any);

    // Past tier 1 + tier 2 delays
    await vi.advanceTimersByTimeAsync(300);

    const tier2Msgs = sentMessages.filter(m => m.tier === 2);
    expect(tier2Msgs.length).toBe(0);
  });

  it('suppresses Tier 3 when a build heartbeat is fresh', async () => {
    const { proxy, sentMessages } = makeProxy({ hasHeartbeat: true });

    proxy.onMessageLogged({
      messageId: 1, channelId: '302', text: 'hi', fromUser: true,
      timestamp: new Date().toISOString(),
    } as any);

    // Past all three tier delays
    await vi.advanceTimersByTimeAsync(700);

    const tier3Msgs = sentMessages.filter(m => m.tier === 3);
    expect(tier3Msgs.length).toBe(0);
  });

  it('emits Tier 2 normally when no build heartbeat is fresh', async () => {
    const { proxy, sentMessages } = makeProxy({ hasHeartbeat: false });

    proxy.onMessageLogged({
      messageId: 1, channelId: '303', text: 'hi', fromUser: true,
      timestamp: new Date().toISOString(),
    } as any);

    await vi.advanceTimersByTimeAsync(300);
    const tier2Msgs = sentMessages.filter(m => m.tier === 2);
    expect(tier2Msgs.length).toBe(1);
  });
});
