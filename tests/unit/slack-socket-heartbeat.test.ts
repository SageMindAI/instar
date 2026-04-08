/**
 * SocketModeClient heartbeat & liveness tests — verifies that:
 * 1. Heartbeat interval is 30s (not 1 hour)
 * 2. Dead silence threshold is 5 minutes (not 1 hour)
 * 3. Active liveness probes detect dead connections
 * 4. Ping timeout forces reconnect when no response
 * 5. Message receipt resets pending ping state
 * 6. _forceReconnect tears down and retries
 * 7. SlackAdapter tracks disconnect time and recovers missed messages
 *
 * Root cause: Slack Socket Mode connections die silently (no close event).
 * The old heartbeat waited 1 hour before noticing — way too long for an
 * agent that needs to respond within minutes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const socketClientPath = path.resolve(__dirname, '../../src/messaging/slack/SocketModeClient.ts');
const socketClientSource = readFileSync(socketClientPath, 'utf-8');

const slackAdapterPath = path.resolve(__dirname, '../../src/messaging/slack/SlackAdapter.ts');
const slackAdapterSource = readFileSync(slackAdapterPath, 'utf-8');

describe('Heartbeat timing constants', () => {
  it('checks connection health every 30 seconds', () => {
    expect(socketClientSource).toContain('HEARTBEAT_INTERVAL_MS = 30_000');
  });

  it('declares dead silence threshold at 5 minutes', () => {
    expect(socketClientSource).toContain('DEAD_SILENCE_MS = 300_000');
  });

  it('declares ping timeout at 10 seconds', () => {
    expect(socketClientSource).toContain('PING_TIMEOUT_MS = 10_000');
  });

  it('does NOT use the old 1-hour heartbeat timeout', () => {
    expect(socketClientSource).not.toContain('3_600_000');
    expect(socketClientSource).not.toContain('HEARTBEAT_TIMEOUT_MS');
  });
});

describe('Active liveness probe', () => {
  it('tracks lastPongAt timestamp', () => {
    expect(socketClientSource).toContain('private lastPongAt = 0');
  });

  it('tracks pendingPing state', () => {
    expect(socketClientSource).toContain('private pendingPing = false');
  });

  it('sends a ping probe when no events for DEAD_SILENCE_MS', () => {
    // After DEAD_SILENCE_MS of silence, sends a JSON ping
    expect(socketClientSource).toMatch(/sinceLastEvent > DEAD_SILENCE_MS[\s\S]*?ws\?\.send\(.*ping/);
  });

  it('forces reconnect when ping times out (no response within PING_TIMEOUT_MS)', () => {
    expect(socketClientSource).toMatch(/pendingPing[\s\S]*?sincePing > PING_TIMEOUT_MS[\s\S]*?_forceReconnect/);
  });

  it('resets pendingPing on any received message', () => {
    // The message event handler must clear pendingPing
    expect(socketClientSource).toMatch(/addEventListener\('message'[\s\S]*?pendingPing = false/);
  });

  it('forces reconnect if send() throws (socket already dead)', () => {
    expect(socketClientSource).toMatch(/catch[\s\S]*?Liveness probe send failed[\s\S]*?_forceReconnect/);
  });
});

describe('WebSocket readyState check', () => {
  it('checks readyState on each heartbeat interval', () => {
    expect(socketClientSource).toMatch(/readyState !== WebSocket\.OPEN[\s\S]*?_forceReconnect/);
  });
});

describe('_forceReconnect method', () => {
  it('exists as a dedicated method', () => {
    expect(socketClientSource).toContain('private _forceReconnect(): void');
  });

  it('clears the heartbeat timer', () => {
    expect(socketClientSource).toMatch(/_forceReconnect\(\)[\s\S]*?_clearHeartbeat\(\)/);
  });

  it('closes the websocket', () => {
    expect(socketClientSource).toMatch(/_forceReconnect\(\)[\s\S]*?this\.ws\.close\(\)/);
  });

  it('triggers _backoffReconnect if still started', () => {
    expect(socketClientSource).toMatch(/_forceReconnect\(\)[\s\S]*?this\.started[\s\S]*?_backoffReconnect/);
  });
});

describe('SlackAdapter missed message recovery', () => {
  it('tracks _lastDisconnectedAt timestamp', () => {
    expect(slackAdapterSource).toContain('private _lastDisconnectedAt = 0');
  });

  it('sets _lastDisconnectedAt on disconnect', () => {
    expect(slackAdapterSource).toMatch(/onDisconnected[\s\S]*?_lastDisconnectedAt = Date\.now\(\)/);
  });

  it('calls _recoverMissedMessages on reconnection', () => {
    expect(slackAdapterSource).toMatch(/onConnected[\s\S]*?_recoverMissedMessages/);
  });

  it('only recovers on reconnection, not initial connect', () => {
    // Should check wasStarted to avoid running on first connect
    expect(slackAdapterSource).toMatch(/wasStarted[\s\S]*?_lastDisconnectedAt > 0[\s\S]*?_recoverMissedMessages/);
  });

  it('has a _recoverMissedMessages method', () => {
    expect(slackAdapterSource).toContain('private async _recoverMissedMessages(): Promise<void>');
  });

  it('uses conversations.history API to fetch missed messages', () => {
    expect(slackAdapterSource).toMatch(/_recoverMissedMessages[\s\S]*?conversations\.history/);
  });

  it('checks active channels from both channelToSession and channelResumeMap', () => {
    expect(slackAdapterSource).toMatch(/_recoverMissedMessages[\s\S]*?channelToSession[\s\S]*?channelResumeMap/);
  });

  it('only replays the latest user message per channel to avoid duplicate sessions', () => {
    expect(slackAdapterSource).toMatch(/_recoverMissedMessages[\s\S]*?latestUserMsg/);
  });

  it('routes recovered message through _handleMessage', () => {
    expect(slackAdapterSource).toMatch(/_recoverMissedMessages[\s\S]*?this\._handleMessage/);
  });

  it('resets _lastDisconnectedAt after recovery', () => {
    expect(slackAdapterSource).toMatch(/_recoverMissedMessages[\s\S]*?_lastDisconnectedAt = 0/);
  });

  it('skips bot messages during recovery', () => {
    expect(slackAdapterSource).toMatch(/_recoverMissedMessages[\s\S]*?bot_id/);
  });

  it('only recovers messages from authorized users', () => {
    expect(slackAdapterSource).toMatch(/_recoverMissedMessages[\s\S]*?isAuthorized/);
  });
});

describe('SlackAdapter startup recovery (server restart case)', () => {
  it('calls _recoverOnStartup during start()', () => {
    expect(slackAdapterSource).toMatch(/start\(\)[\s\S]*?_recoverOnStartup\(\)/);
  });

  it('has a _recoverOnStartup method', () => {
    expect(slackAdapterSource).toContain('private async _recoverOnStartup(): Promise<void>');
  });

  it('uses the persisted channelResumeMap to find conversation channels', () => {
    expect(slackAdapterSource).toMatch(/_recoverOnStartup[\s\S]*?channelResumeMap/);
  });

  it('uses savedAt timestamp as the recovery start point', () => {
    expect(slackAdapterSource).toMatch(/_recoverOnStartup[\s\S]*?info\.savedAt/);
  });

  it('fetches messages via conversations.history API', () => {
    expect(slackAdapterSource).toMatch(/_recoverOnStartup[\s\S]*?conversations\.history/);
  });

  it('only replays the latest user message per channel', () => {
    expect(slackAdapterSource).toMatch(/_recoverOnStartup[\s\S]*?latestUserMsg/);
  });

  it('backfills older messages into ring buffer for context', () => {
    expect(slackAdapterSource).toMatch(/_recoverOnStartup[\s\S]*?channelHistory/);
  });

  it('routes the latest recovered message through _handleMessage', () => {
    expect(slackAdapterSource).toMatch(/_recoverOnStartup[\s\S]*?this\._handleMessage/);
  });

  it('skips system channels', () => {
    expect(slackAdapterSource).toMatch(/_recoverOnStartup[\s\S]*?isSystemChannel/);
  });

  it('skips bot messages', () => {
    expect(slackAdapterSource).toMatch(/_recoverOnStartup[\s\S]*?bot_id/);
  });

  it('only processes authorized users', () => {
    expect(slackAdapterSource).toMatch(/_recoverOnStartup[\s\S]*?isAuthorized/);
  });

  it('catches errors gracefully without crashing startup', () => {
    // Entire method wrapped in try/catch
    expect(slackAdapterSource).toMatch(/_recoverOnStartup[\s\S]*?catch \(err\)[\s\S]*?Startup recovery error/);
  });
});
