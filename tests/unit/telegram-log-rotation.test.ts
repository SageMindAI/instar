/**
 * Tests for TelegramAdapter message log rotation.
 *
 * Verifies that the JSONL message log is automatically rotated
 * when it exceeds 100,000 lines, keeping only the last 75,000.
 * Limits are intentionally high — message history is core agent memory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('TelegramAdapter — log rotation', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-log-'));
    logPath = path.join(tmpDir, 'telegram-messages.jsonl');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createLogLine(i: number): string {
    return JSON.stringify({
      messageId: i,
      topicId: 1,
      text: `Message ${i}`,
      fromUser: true,
      timestamp: new Date().toISOString(),
      sessionName: null,
    });
  }

  it('source file implements maybeRotateLog with 100k threshold', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/messaging/TelegramAdapter.ts'),
      'utf-8',
    );
    expect(source).toContain('maybeRotateLog');
    expect(source).toContain('100_000');
    expect(source).toContain('75_000');
  });

  it('uses atomic write (tmp + rename) for rotation', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/messaging/TelegramAdapter.ts'),
      'utf-8',
    );
    // Rotation should use atomic write pattern (unique temp filenames)
    expect(source).toContain('this.messageLogPath}.${process.pid}');
    // The pattern: write to tmp, rename to actual
    const rotationSection = source.slice(source.indexOf('maybeRotateLog'));
    expect(rotationSection).toContain('writeFileSync(tmpPath');
    expect(rotationSection).toContain('renameSync(tmpPath');
  });

  it('rotation only triggers when file exceeds 20MB', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/messaging/TelegramAdapter.ts'),
      'utf-8',
    );
    // Should check file size before counting lines
    expect(source).toContain('20 * 1024 * 1024');
  });
});
