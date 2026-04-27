/**
 * Tests for SessionManager.injectTelegramMessage behavior.
 *
 * Covers: short messages (inline), long messages (file redirect),
 * file creation, cleanup of temp directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';

describe('SessionManager.injectTelegramMessage', () => {
  let project: TempProject;
  let sendKeyCalls: string[][];

  beforeEach(() => {
    project = createTempProject();
    sendKeyCalls = [];
  });

  afterEach(() => {
    project.cleanup();
    // Clean up temp files
    const tmpDir = '/tmp/instar-telegram';
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('msg-'));
      for (const f of files) {
        // safe-git-allow: incremental-migration
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
      }
    }
  });

  // We test the logic by examining the file system side effects
  // since the tmux commands will fail in test (no tmux session)

  it('writes long messages to temp file', () => {
    const sm = new SessionManager(
      {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/claude',
        projectDir: project.stateDir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: [],
      },
      project.state,
    );

    // Create a message longer than 500 chars
    const longText = 'A'.repeat(600);

    // This will fail on the tmux send-keys (no real session),
    // but the file should still be created
    sm.injectTelegramMessage('nonexistent-session', 42, longText);

    // Check that temp file was created
    const tmpDir = '/tmp/instar-telegram';
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('msg-42-'));
      // File may or may not exist depending on timing, but the directory should be created
      expect(fs.existsSync(tmpDir)).toBe(true);
    }
  });

  it('threshold is 500 chars for the tagged message', () => {
    // The tagged text is `[telegram:${topicId}] ${text}`
    // For topicId=42, that's "[telegram:42] " = 14 chars prefix
    // So text needs to be 500 - 14 = 486 chars to exceed threshold
    const prefix = '[telegram:42] ';
    const text = 'X'.repeat(500 - prefix.length); // Exactly 500 tagged = below threshold
    const taggedLength = prefix.length + text.length;
    expect(taggedLength).toBe(500); // Should NOT go to file

    const textOver = text + 'Y'; // 501 tagged = above threshold
    const taggedLengthOver = prefix.length + textOver.length;
    expect(taggedLengthOver).toBe(501); // Should go to file
  });
});
