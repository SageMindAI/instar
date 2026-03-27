import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

describe('ClaudeCliIntelligenceProvider', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('translates ENOENT into an actionable Claude Code install error', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
      cb?.(error, '', '');
      return { stdin: { end: vi.fn() } };
    });

    const { ClaudeCliIntelligenceProvider } = await import('../../src/core/ClaudeCliIntelligenceProvider.js');
    const provider = new ClaudeCliIntelligenceProvider('claude');
    const result = provider.evaluate('test prompt');

    await expect(result).rejects.toThrow('Claude Code CLI not found.');
    await expect(result).rejects.toThrow('https://docs.anthropic.com/en/docs/claude-code');
  });

  it('preserves non-ENOENT Claude CLI failures as regular CLI errors', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const error = new Error('subprocess exited with code 1');
      cb?.(error, '', 'command not found: claude');
      return { stdin: { end: vi.fn() } };
    });

    const { ClaudeCliIntelligenceProvider } = await import('../../src/core/ClaudeCliIntelligenceProvider.js');
    const provider = new ClaudeCliIntelligenceProvider('claude');
    const result = provider.evaluate('test prompt');

    await expect(result).rejects.toThrow('Claude CLI error: subprocess exited with code 1 — command not found: claude');
    await expect(result).rejects.not.toThrow('Claude Code CLI not found.');
  });
});
