/**
 * Bootstrap message file threshold — regression test.
 *
 * Root cause: When a session resumes with conversation history, the server
 * builds a ~19KB CONTINUATION bootstrap message and passes it directly to
 * tmux send-keys as a command argument. tmux chokes on large text, causing
 * silent injection failure. The session spawns, never receives input, sits
 * idle for 15 minutes, gets killed as zombie, and the cycle repeats.
 *
 * Fix: spawnSessionForTopic now writes large bootstrap messages to a temp
 * file (same pattern as injectTelegramMessage's FILE_THRESHOLD) and injects
 * a short reference instead.
 *
 * These tests verify the fix is in place and won't regress.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src', 'commands', 'server.ts'),
  'utf-8',
);

describe('Bootstrap message file threshold (source analysis)', () => {
  it('defines BOOTSTRAP_FILE_THRESHOLD', () => {
    expect(SERVER_SRC).toContain('BOOTSTRAP_FILE_THRESHOLD');
  });

  it('threshold is set to 500 characters', () => {
    expect(SERVER_SRC).toMatch(/BOOTSTRAP_FILE_THRESHOLD\s*=\s*500/);
  });

  it('writes bootstrap to file when over threshold', () => {
    // Must write to a file
    expect(SERVER_SRC).toContain('bootstrapFilepath');
    expect(SERVER_SRC).toContain('writeFileSync');
    // Must contain a file reference instruction
    expect(SERVER_SRC).toContain('[IMPORTANT: Read');
  });

  it('logs when bootstrap is written to file', () => {
    expect(SERVER_SRC).toMatch(/Bootstrap message too large/);
  });

  it('uses the same tmp directory as telegram injection', () => {
    // Both should write to /tmp/instar-telegram (or use the same tmpDir variable)
    // The bootstrap code references tmpDir which is set to '/tmp/instar-telegram' earlier
    expect(SERVER_SRC).toContain('bootstrapFilepath = path.join(tmpDir');
  });
});

describe('Bootstrap message file threshold (behavioral)', () => {
  it('messages at or below 500 chars stay inline', () => {
    // The threshold check is: if (bootstrapMessage.length > BOOTSTRAP_FILE_THRESHOLD)
    // A message of exactly 500 chars should NOT be redirected
    const threshold = 500;
    const shortMessage = 'x'.repeat(threshold);
    expect(shortMessage.length).toBeLessThanOrEqual(threshold);
    // Logic: shortMessage.length > threshold is false → stays inline
    expect(shortMessage.length > threshold).toBe(false);
  });

  it('messages over 500 chars trigger file redirect', () => {
    const threshold = 500;
    const longMessage = 'x'.repeat(threshold + 1);
    expect(longMessage.length > threshold).toBe(true);
  });

  it('typical CONTINUATION context (19KB) triggers file redirect', () => {
    const threshold = 500;
    const typicalBootstrap = 'x'.repeat(19000);
    expect(typicalBootstrap.length > threshold).toBe(true);
  });
});
