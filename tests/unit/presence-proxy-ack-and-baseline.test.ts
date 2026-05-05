/**
 * PresenceProxy: brief-ack + baseline scoping
 *
 * Two regression cases that were dropped in production:
 *
 *  1. Brief acks ("Got it, looking into this", "On it") were silently
 *     cancelling all pending tier timers, so users never saw the 20s/2m/5m
 *     progressive standby updates.
 *
 *  2. Tier prompts received the full terminal pane (which includes work
 *     the agent was doing BEFORE the user's latest message), so summaries
 *     described pre-message work instead of the agent's response to the
 *     user. The fix captures a baseline snapshot at user-message arrival
 *     and feeds only the post-baseline delta to the LLM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PresenceProxy,
  isBriefAck,
  extractDeltaSinceBaseline,
} from '../../src/monitoring/PresenceProxy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function createTestProxy(overrides: Record<string, unknown> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ack-test-'));
  const sentMessages: Array<{ topicId: number; text: string }> = [];
  const captureSpy = vi.fn(() => 'baseline pane line A\nbaseline pane line B\nbaseline pane line C');

  const config = {
    stateDir,
    intelligence: null,
    agentName: 'test-agent',
    captureSessionOutput: captureSpy,
    getSessionForTopic: () => 'test-session',
    isSessionAlive: () => true,
    sendMessage: async (topicId: number, text: string) => {
      sentMessages.push({ topicId, text });
    },
    getAuthorizedUserIds: () => [],
    getProcessTree: () => [],
    hasAgentRespondedSince: () => false,
    tier1DelayMs: 50,
    tier2DelayMs: 200,
    tier3DelayMs: 500,
    ...overrides,
  };

  const proxy = new PresenceProxy(config as any);
  proxy.start();

  return { proxy, sentMessages, captureSpy, stateDir };
}

describe('isBriefAck', () => {
  it('returns true for very short messages', () => {
    expect(isBriefAck('ok')).toBe(true);
    expect(isBriefAck('Got it.')).toBe(true);
    expect(isBriefAck('👍')).toBe(true);
  });

  it('returns true for forward-looking ack phrases under 280 chars', () => {
    expect(isBriefAck('Got it, looking into this now.')).toBe(true);
    expect(isBriefAck('On it — investigating both issues.')).toBe(true);
    expect(isBriefAck("I'll dig into that and report back shortly.")).toBe(true);
    expect(
      isBriefAck(
        'Got it — looking into both: the missing 5/10/15min progressive updates and the standby summary scoping. On it.',
      ),
    ).toBe(true);
  });

  it('returns false for substantive replies', () => {
    expect(
      isBriefAck(
        'Found both root causes — sharing the diagnosis before I patch. ' +
          'For the missing tier updates: the standby system has tier checks at 20 seconds, 2 minutes, ' +
          'and 5 minutes. Recently every agent was instructed to send an "On it" ack the second a ' +
          'Telegram message arrives — so that ack now silently kills the standby timers. The fix: ' +
          'treat brief agent acks as not-real-responses, so timers keep ticking until a substantive ' +
          'reply lands. Capture a baseline snapshot at the moment your message arrives, and feed the ' +
          'standby LLM only the new lines since that baseline.',
      ),
    ).toBe(false);
  });

  it('returns false for empty / whitespace', () => {
    expect(isBriefAck('')).toBe(false);
    expect(isBriefAck(null)).toBe(false);
    expect(isBriefAck(undefined)).toBe(false);
    expect(isBriefAck('   \n\t')).toBe(false);
  });

  it('caps at 280 chars regardless of pattern match', () => {
    const longAck = 'On it. ' + 'X'.repeat(300);
    expect(isBriefAck(longAck)).toBe(false);
  });
});

describe('extractDeltaSinceBaseline', () => {
  it('returns full current when baseline is empty', () => {
    const result = extractDeltaSinceBaseline('hello\nworld', null);
    expect(result.delta).toBe('hello\nworld');
    expect(result.anchored).toBe(false);
    expect(result.hasNewActivity).toBe(true);
  });

  it('returns empty when current is null', () => {
    const result = extractDeltaSinceBaseline(null, 'baseline');
    expect(result.delta).toBe('');
    expect(result.hasNewActivity).toBe(false);
  });

  it('returns post-anchor content when baseline is found in current', () => {
    const baseline = [
      'line 1',
      'line 2',
      'line 3 (last visible at user-message time)',
    ].join('\n');
    const current = [
      'line 1',
      'line 2',
      'line 3 (last visible at user-message time)',
      'NEW: agent started typing',
      'NEW: agent ran a tool',
    ].join('\n');
    const result = extractDeltaSinceBaseline(current, baseline);
    expect(result.anchored).toBe(true);
    expect(result.hasNewActivity).toBe(true);
    expect(result.delta).toContain('NEW: agent started typing');
    expect(result.delta).toContain('NEW: agent ran a tool');
    expect(result.delta).not.toContain('line 1');
  });

  it('reports hasNewActivity=false when no new lines after anchor', () => {
    const baseline = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const current = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const result = extractDeltaSinceBaseline(current, baseline);
    expect(result.anchored).toBe(true);
    expect(result.hasNewActivity).toBe(false);
    expect(result.delta).toBe('');
  });

  it('falls back to full current when anchor is not found (terminal scrolled)', () => {
    const baseline = ['old line A', 'old line B', 'old line C'].join('\n');
    const current = ['totally different content', 'no overlap whatsoever'].join('\n');
    const result = extractDeltaSinceBaseline(current, baseline);
    expect(result.anchored).toBe(false);
    expect(result.delta).toContain('totally different');
  });
});

describe('PresenceProxy brief-ack handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps tier timers running when agent sends a brief ack', async () => {
    const { proxy, sentMessages } = createTestProxy();

    proxy.onMessageLogged({
      messageId: 1,
      channelId: '900',
      text: 'Please fix the bug',
      fromUser: true,
      timestamp: new Date().toISOString(),
    });

    // Agent sends an immediate ack (the pattern that was killing timers)
    proxy.onMessageLogged({
      messageId: 2,
      channelId: '900',
      text: 'Got it, looking into this now.',
      fromUser: false,
      timestamp: new Date().toISOString(),
    });

    // Advance past tier 1 — it MUST still fire because the ack didn't cancel
    await vi.advanceTimersByTimeAsync(60);
    expect(sentMessages.length).toBe(1);

    // And tier 2 should also fire
    await vi.advanceTimersByTimeAsync(250);
    expect(sentMessages.length).toBe(2);
  });

  it('cancels tier timers on a substantive (non-ack) agent reply', async () => {
    const { proxy, sentMessages } = createTestProxy();

    proxy.onMessageLogged({
      messageId: 1,
      channelId: '901',
      text: 'Please fix the bug',
      fromUser: true,
      timestamp: new Date().toISOString(),
    });

    // Substantive response — not an ack — should cancel
    proxy.onMessageLogged({
      messageId: 2,
      channelId: '901',
      text:
        'I traced the bug to a missing null check on line 412 of the auth handler. ' +
        'The fix is straightforward: I added the guard, ran the test suite (all green), ' +
        'and pushed the patch. Verified end-to-end with the staging environment — ' +
        'login, logout, and refresh flows all behave correctly now. The change was ' +
        'minimal so I went straight to merge. Let me know if you spot any regression.',
      fromUser: false,
      timestamp: new Date().toISOString(),
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(sentMessages.length).toBe(0);
  });

  it('multiple brief acks still do not cancel; substantive reply finally does', async () => {
    const { proxy, sentMessages } = createTestProxy();

    proxy.onMessageLogged({
      messageId: 1,
      channelId: '902',
      text: 'Multi-step task please',
      fromUser: true,
      timestamp: new Date().toISOString(),
    });

    // Two acks
    proxy.onMessageLogged({
      messageId: 2, channelId: '902',
      text: 'On it.', fromUser: false,
      timestamp: new Date().toISOString(),
    });
    proxy.onMessageLogged({
      messageId: 3, channelId: '902',
      text: 'Digging in now — more soon.', fromUser: false,
      timestamp: new Date().toISOString(),
    });

    // Tier 1 fires
    await vi.advanceTimersByTimeAsync(60);
    expect(sentMessages.length).toBe(1);

    // Substantive reply now arrives — this should cancel
    proxy.onMessageLogged({
      messageId: 4, channelId: '902',
      text:
        'Here is the full plan with concrete file paths and a rollback strategy. ' +
        'Phase 1: refactor the X module to expose Y. Phase 2: wire Z into the call ' +
        'site at line 207. Phase 3: regenerate fixtures and run integration suite. ' +
        'Phase 4: ship. I will report after each phase.',
      fromUser: false,
      timestamp: new Date().toISOString(),
    });

    // Tier 2 should NOT fire
    await vi.advanceTimersByTimeAsync(250);
    expect(sentMessages.length).toBe(1);
  });
});

describe('PresenceProxy baseline capture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures the baseline snapshot at user-message arrival', () => {
    const { proxy, captureSpy } = createTestProxy();

    proxy.onMessageLogged({
      messageId: 1,
      channelId: '910',
      text: 'Status?',
      fromUser: true,
      timestamp: new Date().toISOString(),
    });

    // captureSessionOutput should have been called once for baseline
    expect(captureSpy).toHaveBeenCalled();
    const state = proxy.getState(910);
    expect(state).toBeDefined();
    expect(state!.userMessageBaselineSnapshot).toBeTruthy();
    expect(state!.userMessageBaselineSnapshot).toContain('baseline pane');
  });

  it('survives a baseline-capture failure without crashing', () => {
    const overrides = {
      captureSessionOutput: () => { throw new Error('boom'); },
    };
    const { proxy } = createTestProxy(overrides);

    expect(() => {
      proxy.onMessageLogged({
        messageId: 1,
        channelId: '911',
        text: 'Status?',
        fromUser: true,
        timestamp: new Date().toISOString(),
      });
    }).not.toThrow();

    const state = proxy.getState(911);
    expect(state).toBeDefined();
    expect(state!.userMessageBaselineSnapshot).toBeNull();
  });
});
