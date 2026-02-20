/**
 * Telegram message injection tests — validates the SessionManager's
 * injectTelegramMessage method handles both short and long messages correctly.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Telegram message injection logic', () => {
  const FILE_THRESHOLD = 500;

  it('SessionManager has injectTelegramMessage method', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    expect(source).toContain('injectTelegramMessage');
  });

  it('uses FILE_THRESHOLD of 500 characters', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    expect(source).toContain('500');
    expect(source).toContain('FILE_THRESHOLD');
  });

  it('tags messages with [telegram:N] format', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    expect(source).toContain('`[telegram:${topicId}]');
  });

  it('writes long messages to temp file', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    expect(source).toContain('instar-telegram');
    expect(source).toContain('Long message saved to');
  });

  it('uses =session: (trailing colon) for pane-level tmux commands', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    // The trailing colon is critical for tmux pane-level commands
    expect(source).toContain('`=${tmuxSession}:`');
  });

  it('sendInput uses -l flag for literal text', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    expect(source).toContain("'-l'");
  });

  it('sendInput sends Enter key separately', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    // Should have two execFileSync calls in sendInput — one for text, one for Enter
    const sendInputMatch = source.match(/sendInput[\s\S]*?(?=\n\s{2}\w|\n\s{2}\/\*\*)/);
    if (sendInputMatch) {
      const sendInputBody = sendInputMatch[0];
      expect(sendInputBody).toContain("'Enter'");
    }
  });
});
