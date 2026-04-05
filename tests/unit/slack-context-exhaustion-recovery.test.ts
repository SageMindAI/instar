import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

/**
 * Wiring integrity test: Slack context exhaustion recovery.
 *
 * The respawnSessionFresh dep in server.ts MUST handle Slack channels
 * (identified by synthetic negative topic IDs via slackProxyChannelMap).
 * Previously, it only handled Telegram topics — Slack sessions that hit
 * context exhaustion were silently dropped because the function returned
 * without spawning a replacement.
 *
 * This test reads the source code to verify the Slack code path exists.
 */

const SERVER_TS_PATH = 'src/commands/server.ts';

describe('Slack context exhaustion recovery wiring', () => {
  const source = fs.readFileSync(SERVER_TS_PATH, 'utf-8');

  // Find the respawnSessionFresh function block
  const fnStart = source.indexOf('respawnSessionFresh:');
  expect(fnStart).toBeGreaterThan(-1);

  // Get the block from respawnSessionFresh to the next dep function
  const block = source.slice(fnStart, fnStart + 5000);

  it('respawnSessionFresh checks slackProxyChannelMap', () => {
    expect(block).toContain('slackProxyChannelMap.get(topicId)');
  });

  it('respawnSessionFresh handles Slack channels before Telegram fallback', () => {
    const slackIdx = block.indexOf('slackProxyChannelMap');
    const telegramIdx = block.indexOf('if (telegram)');
    expect(slackIdx).toBeGreaterThan(-1);
    expect(telegramIdx).toBeGreaterThan(-1);
    // Slack path must come BEFORE Telegram fallback
    expect(slackIdx).toBeLessThan(telegramIdx);
  });

  it('respawnSessionFresh spawns a fresh session for Slack (not just kill)', () => {
    // Must call spawnInteractiveSession for Slack, not just killSession
    expect(block).toContain('spawnInteractiveSession');
  });

  it('respawnSessionFresh registers the new session with Slack adapter', () => {
    expect(block).toContain('registerChannelSession');
  });

  it('respawnSessionFresh writes recovery context file for Slack', () => {
    // Must create a recovery context file so the new session has thread history
    expect(block).toContain('recovery-');
    expect(block).toContain('instar-slack');
  });

  it('respawnSessionFresh includes thread history in Slack recovery', () => {
    expect(block).toContain('getChannelMessages');
  });

  it('respawnSessionFresh includes Slack relay instructions in recovery', () => {
    expect(block).toContain('slack-reply.sh');
  });

  it('respawnSession also handles Slack channels (for crash/stall recovery)', () => {
    const respawnSessionStart = source.indexOf('respawnSession:');
    const respawnBlock = source.slice(respawnSessionStart, respawnSessionStart + 1000);
    expect(respawnBlock).toContain('slackProxyChannelMap.get(topicId)');
  });

  // Death loop prevention: beforeSessionKill must NOT re-save resume UUIDs
  // during context exhaustion recovery, otherwise the next respawn loads
  // the same bloated conversation and dies immediately (infinite loop).
  it('beforeSessionKill skips Slack resume UUID save during context exhaustion', () => {
    const beforeKillBlock = source.slice(
      source.indexOf('beforeSessionKill'),
      source.indexOf('beforeSessionKill') + 3000,
    );
    expect(beforeKillBlock).toContain('contextExhaustionKills');
    // Must check the set BEFORE saving the resume UUID
    const checkIdx = beforeKillBlock.indexOf('contextExhaustionKills.has');
    const saveIdx = beforeKillBlock.indexOf('saveChannelResume');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(saveIdx);
  });

  it('beforeSessionKill skips Telegram resume UUID save during context exhaustion', () => {
    const beforeKillBlock = source.slice(
      source.indexOf('beforeSessionKill'),
      source.indexOf('beforeSessionKill') + 3000,
    );
    // Telegram path should also check contextExhaustionKills
    const telegramSection = beforeKillBlock.slice(0, beforeKillBlock.indexOf('Save Slack'));
    expect(telegramSection).toContain('contextExhaustionKills');
  });

  it('context exhaustion event populates the kill tracking set', () => {
    // SessionRecovery's recovery:context_exhaustion event must be listened for
    expect(source).toContain("recovery:context_exhaustion");
    expect(source).toContain('contextExhaustionKills.add');
  });

  it('respawnSessionFresh has reverse-lookup fallback for slackProxyChannelMap miss', () => {
    const fnStart = source.indexOf('respawnSessionFresh:');
    const block = source.slice(fnStart, fnStart + 5000);
    // Must have a fallback that resolves channel ID from registry when map misses
    expect(block).toContain('reverse lookup');
    expect(block).toContain('getChannelRegistry');
  });
});
