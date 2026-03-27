export const CLAUDE_CODE_INSTALL_URL = 'https://docs.anthropic.com/en/docs/claude-code';

export function buildClaudeCliNotFoundMessage(): string {
  return [
    'Error: Claude Code CLI not found.',
    '',
    'Instar requires Claude Code to be installed. Install it from:',
    `  ${CLAUDE_CODE_INSTALL_URL}`,
    '',
    'After installing, make sure `claude` is available in your PATH, then try again.',
  ].join('\n');
}

export function isClaudeCliMissingError(error: unknown, output: string = ''): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { code?: unknown }).code === 'ENOENT';
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.toLowerCase().includes('enoent')) {
    return true;
  }

  const combinedOutput = `${message}\n${output}`;
  return /(?:^|\n)\s*(?:zsh|bash|sh): command not found: claude\b/i.test(combinedOutput)
    || /\bclaude: command not found\b/i.test(combinedOutput);
}
