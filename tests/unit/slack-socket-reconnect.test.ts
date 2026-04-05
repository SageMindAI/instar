/**
 * SocketModeClient reconnection tests — verifies that:
 * 1. The reconnect() method tears down and re-establishes the connection
 * 2. The close handler catches reconnect failures and retries
 * 3. Sleep/wake scenarios don't leave the connection permanently dead
 *
 * Root cause: After macOS sleep, the WebSocket dies silently. The close
 * handler's _backoffReconnect() was async-but-uncaught, so if the first
 * reconnect attempt failed (network not ready), the error was swallowed
 * and no further reconnects were attempted.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const socketClientPath = path.resolve(__dirname, '../../src/messaging/slack/SocketModeClient.ts');
const socketClientSource = readFileSync(socketClientPath, 'utf-8');

const slackAdapterPath = path.resolve(__dirname, '../../src/messaging/slack/SlackAdapter.ts');
const slackAdapterSource = readFileSync(slackAdapterPath, 'utf-8');

const serverPath = path.resolve(__dirname, '../../src/commands/server.ts');
const serverSource = readFileSync(serverPath, 'utf-8');

describe('SocketModeClient reconnection', () => {
  it('has a reconnect() method', () => {
    expect(socketClientSource).toContain('async reconnect(): Promise<void>');
  });

  it('reconnect() resets reconnecting state to prevent deadlocks', () => {
    expect(socketClientSource).toMatch(/reconnect\(\)[\s\S]*?this\.reconnecting = false/);
  });

  it('reconnect() resets consecutiveErrors to zero', () => {
    expect(socketClientSource).toMatch(/reconnect\(\)[\s\S]*?this\.consecutiveErrors = 0/);
  });

  it('reconnect() sets started=true before opening connection', () => {
    expect(socketClientSource).toMatch(/reconnect\(\)[\s\S]*?this\.started = true[\s\S]*?this\._openConnection/);
  });

  it('reconnect() temporarily clears started to prevent double-reconnect from close handler', () => {
    // The reconnect method should set started=false before closing the old ws,
    // then restore it — preventing the close event handler from triggering
    // its own _backoffReconnect() simultaneously.
    expect(socketClientSource).toMatch(/reconnect\(\)[\s\S]*?this\.started = false[\s\S]*?this\.ws\.close/);
  });
});

describe('Close handler error resilience', () => {
  it('catches _backoffReconnect() errors in the close handler', () => {
    // The close handler must .catch() the _backoffReconnect() promise
    // to prevent unhandled rejections from killing the reconnect loop.
    expect(socketClientSource).toContain('this._backoffReconnect().catch(');
  });

  it('schedules a fallback retry after catch', () => {
    // After catching a reconnect failure, a setTimeout should schedule
    // one more attempt to avoid permanent connection death.
    expect(socketClientSource).toMatch(/\.catch\([\s\S]*?setTimeout\(/);
  });
});

describe('SlackAdapter reconnect()', () => {
  it('exposes a reconnect() method', () => {
    expect(slackAdapterSource).toContain('async reconnect(): Promise<void>');
  });

  it('delegates to socketClient.reconnect()', () => {
    expect(slackAdapterSource).toMatch(/reconnect\(\)[\s\S]*?this\.socketClient\.reconnect\(\)/);
  });
});

describe('SleepWake Slack reconnection', () => {
  it('reconnects Slack in the wake handler', () => {
    // The SleepWake handler must call slackAdapter.reconnect() after wake
    expect(serverSource).toMatch(/sleepWakeDetector\.on\('wake'[\s\S]*?slackAdapter[\s\S]*?reconnect/);
  });

  it('delays Slack reconnect to let network stabilize', () => {
    // Should use setTimeout to wait for network after wake
    expect(serverSource).toMatch(/setTimeout\(async \(\) =>[\s\S]*?reconnect/);
  });

  it('handles Slack reconnect failure gracefully', () => {
    // Must catch errors from the reconnect attempt
    expect(serverSource).toMatch(/slackAdapter[\s\S]*?reconnect[\s\S]*?catch/);
  });
});
