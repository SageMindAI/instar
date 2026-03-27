/**
 * ClaudeCliIntelligenceProvider — Default IntelligenceProvider using the Claude CLI.
 *
 * Uses `claude -p` (print mode) to make judgment calls via the user's existing
 * Claude subscription. Zero extra cost — the subscription is already paid for.
 *
 * This is the DEFAULT provider for Instar agents. The Anthropic API provider
 * (AnthropicIntelligenceProvider) is an explicit opt-in alternative for users
 * who intentionally choose direct API access.
 *
 * Preference hierarchy:
 *   1. Claude CLI (subscription) — default, always available
 *   2. Anthropic API — explicit user choice only
 */

import { execFile } from 'node:child_process';
import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import { resolveCliFlag } from './models.js';
import { buildClaudeCliNotFoundMessage, isClaudeCliMissingError } from './ClaudeCliErrors.js';

const DEFAULT_MODEL = 'fast';
const DEFAULT_TIMEOUT_MS = 30_000;

export class ClaudeCliIntelligenceProvider implements IntelligenceProvider {
  private claudePath: string;

  constructor(claudePath: string) {
    this.claudePath = claudePath;
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const model = resolveCliFlag(options?.model ?? DEFAULT_MODEL);

    return new Promise((resolve, reject) => {
      const args = [
        '-p', prompt,
        '--model', model,
        '--max-turns', '1',
        '--output-format', 'text',
        // Exclude project/local CLAUDE.md to prevent identity context
        // from contaminating classification and evaluation prompts.
        '--setting-sources', 'user',
      ];

      // Strip Claude Code session markers to prevent "nested session" error.
      // When instar runs inside (or is started from) a Claude Code session, these
      // env vars propagate to child processes. The Claude CLI refuses to run if
      // CLAUDECODE is set. SessionManager already does this for tmux spawning.
      const childEnv = { ...process.env };
      delete childEnv.CLAUDECODE;
      delete childEnv.CLAUDE_SESSION_ID;

      const child = execFile(this.claudePath, args, {
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB
        env: childEnv,
      }, (error, stdout, stderr) => {
        if (error) {
          if (isClaudeCliMissingError(error, stderr)) {
            reject(new Error(buildClaudeCliNotFoundMessage()));
            return;
          }

          reject(new Error(`Claude CLI error: ${error.message}${stderr ? ` — ${stderr.slice(0, 200)}` : ''}`));
          return;
        }

        resolve(stdout.trim());
      });

      // Write prompt via stdin for very long prompts (belt and suspenders)
      child.stdin?.end();
    });
  }
}
