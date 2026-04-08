/**
 * SlackAdapter system channel exclusion — verifies that system channels
 * (dashboard, lifeline) block unprompted messages but allow @mentions
 * from authorized users through.
 *
 * Root cause: The dashboard channel had a stale session registered to it,
 * causing the SessionMonitor to send "session has stopped" messages hourly.
 * Fix was too aggressive — also blocked @mentions, making the lifeline
 * channel (the primary chat channel for some agents) unresponsive.
 */

import { describe, it, expect } from 'vitest';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';

const DASHBOARD_CHANNEL = 'C_DASHBOARD';
const LIFELINE_CHANNEL = 'C_LIFELINE';
const NORMAL_CHANNEL = 'C_NORMAL';

function createTestAdapter() {
  const messages: Array<{ content: string; channel: string }> = [];

  const adapter = new SlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    authorizedUserIds: ['U_TEST'],
    workspaceMode: 'dedicated',
    dashboardChannelId: DASHBOARD_CHANNEL,
    lifelineChannelId: LIFELINE_CHANNEL,
  } as any, '/tmp/slack-test-state');

  adapter.onMessage(async (msg) => {
    messages.push({ content: msg.content, channel: msg.channel.identifier });
  });

  return { adapter, messages };
}

describe('SlackAdapter system channel exclusion', () => {
  it('identifies dashboard channel as system channel', () => {
    const { adapter } = createTestAdapter();
    expect(adapter.isSystemChannel(DASHBOARD_CHANNEL)).toBe(true);
  });

  it('identifies lifeline channel as system channel', () => {
    const { adapter } = createTestAdapter();
    expect(adapter.isSystemChannel(LIFELINE_CHANNEL)).toBe(true);
  });

  it('does not identify normal channels as system channels', () => {
    const { adapter } = createTestAdapter();
    expect(adapter.isSystemChannel(NORMAL_CHANNEL)).toBe(false);
  });

  it('drops unprompted messages (no @mention) from system channels', async () => {
    const { adapter, messages } = createTestAdapter();
    const handleMessage = (adapter as any)._handleMessage.bind(adapter);

    await handleMessage({
      user: 'U_TEST',
      text: 'hello',
      channel: DASHBOARD_CHANNEL,
      ts: '1774829441.001',
    });

    await handleMessage({
      user: 'U_TEST',
      text: 'hello',
      channel: LIFELINE_CHANNEL,
      ts: '1774829441.002',
    });

    expect(messages.length).toBe(0);
  });

  it('allows @mention messages through in system channels', async () => {
    const { adapter, messages } = createTestAdapter();
    // Set bot user ID so _isBotMentioned can detect mentions
    (adapter as any).botUserId = 'U_BOT';
    const handleMessage = (adapter as any)._handleMessage.bind(adapter);

    await handleMessage({
      user: 'U_TEST',
      text: '<@U_BOT> please help',
      channel: LIFELINE_CHANNEL,
      ts: '1774829441.003',
    });

    expect(messages.length).toBe(1);
    expect(messages[0].channel).toBe(LIFELINE_CHANNEL);
  });

  it('still drops non-mention messages from lifeline channel', async () => {
    const { adapter, messages } = createTestAdapter();
    (adapter as any).botUserId = 'U_BOT';
    const handleMessage = (adapter as any)._handleMessage.bind(adapter);

    await handleMessage({
      user: 'U_TEST',
      text: 'random chatter without mention',
      channel: LIFELINE_CHANNEL,
      ts: '1774829441.004',
    });

    expect(messages.length).toBe(0);
  });

  it('does not treat normal channels as system channels', () => {
    const { adapter } = createTestAdapter();
    // Normal channels should pass the system channel check (not be dropped)
    expect(adapter.isSystemChannel(NORMAL_CHANNEL)).toBe(false);
    // And undefined config values shouldn't match either
    expect(adapter.isSystemChannel('C_RANDOM')).toBe(false);
  });

  it('refuses to register sessions for system channels', () => {
    const { adapter } = createTestAdapter();

    adapter.registerChannelSession(DASHBOARD_CHANNEL, 'test-session');
    const registry = adapter.getChannelRegistry();
    expect(registry[DASHBOARD_CHANNEL]).toBeUndefined();
  });

  it('allows registering sessions for normal channels', () => {
    const { adapter } = createTestAdapter();

    adapter.registerChannelSession(NORMAL_CHANNEL, 'test-session');
    const registry = adapter.getChannelRegistry();
    expect(registry[NORMAL_CHANNEL]).toBeDefined();
    expect(registry[NORMAL_CHANNEL].sessionName).toBe('test-session');
  });

  it('system channels should not enter the PresenceProxy feed', () => {
    // Simulates the server.ts wiring: onMessageLogged skips system channels
    // before calling slackChannelToSyntheticId / presenceProxy.onMessageLogged
    const { adapter } = createTestAdapter();
    const proxiedChannels: string[] = [];

    // Simulate the onMessageLogged → PresenceProxy pipeline from server.ts
    const processLogEntry = (channelId: string) => {
      if (!channelId) return;
      if (adapter.isSystemChannel(channelId)) return;
      proxiedChannels.push(channelId);
    };

    processLogEntry(DASHBOARD_CHANNEL);
    processLogEntry(LIFELINE_CHANNEL);
    processLogEntry(NORMAL_CHANNEL);

    expect(proxiedChannels).toEqual([NORMAL_CHANNEL]);
    expect(proxiedChannels).not.toContain(DASHBOARD_CHANNEL);
    expect(proxiedChannels).not.toContain(LIFELINE_CHANNEL);
  });

  it('monitoring sendToTopic should not route to system channels', () => {
    // Simulates the sendToTopic guard: system channels are silently skipped
    const { adapter } = createTestAdapter();
    const sentTo: string[] = [];

    const sendToTopic = (channelId: string | undefined, text: string) => {
      if (channelId && adapter.isSystemChannel(channelId)) return;
      if (channelId) sentTo.push(channelId);
    };

    sendToTopic(DASHBOARD_CHANNEL, 'session stopped');
    sendToTopic(LIFELINE_CHANNEL, 'session stopped');
    sendToTopic(NORMAL_CHANNEL, 'check-in');

    expect(sentTo).toEqual([NORMAL_CHANNEL]);
  });
});
