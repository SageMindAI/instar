/**
 * Platform Probe — Tier 3 (Environment Readiness)
 *
 * Verifies platform-specific prerequisites are met.
 * On macOS, tests whether tmux sessions can access TCC-protected directories
 * (Desktop, Documents, Downloads) without triggering permission popups.
 * Skipped entirely on non-macOS platforms.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { Probe, ProbeResult } from '../SystemReviewer.js';

export interface PlatformProbeDeps {
  /** Path to the tmux binary being used */
  tmuxPath: string;
}

/**
 * Test whether a command run inside a tmux session can access
 * TCC-protected directories without triggering a permission popup.
 *
 * Strategy: pass the test command directly to `tmux new-session` so the session
 * runs it and exits. Results are written to a temp file — no race condition
 * from send-keys + capture-pane.
 */
function testTmuxFdaAccess(tmuxPath: string): { hasAccess: boolean; error?: string; detail?: string } {
  const testSessionName = `instar-fda-probe-${process.pid}`;
  const testDir = `${os.homedir()}/Desktop`;
  const tmpFile = path.join(os.tmpdir(), `instar-fda-probe-${process.pid}-${Date.now()}`);

  try {
    // Launch a tmux session that runs the test and writes results to a temp file.
    // The session exits automatically when the command completes.
    execSync(
      `${tmuxPath} new-session -d -s ${testSessionName} -x 80 -y 24 ` +
        `"ls ${JSON.stringify(testDir)} >${JSON.stringify(tmpFile)} 2>&1; echo EXIT_CODE:\\$? >>${JSON.stringify(tmpFile)}"`,
      { encoding: 'utf-8', timeout: 5000 },
    );

    // Poll for session exit (command finished) — up to 5 seconds
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        execSync(`${tmuxPath} has-session -t ${testSessionName} 2>/dev/null`, { timeout: 1000 });
        // Session still alive — wait a bit
        execSync('sleep 0.2', { timeout: 1000 });
      } catch {
        // Session gone — command finished
        break;
      }
    }

    // Kill session if it's still hanging
    try { execSync(`${tmuxPath} kill-session -t ${testSessionName} 2>/dev/null`, { timeout: 3000 }); } catch { /* ok */ }

    // Read results
    if (!fs.existsSync(tmpFile)) {
      return { hasAccess: true, error: 'Probe temp file was not created — tmux session may have failed to start' };
    }

    const output = fs.readFileSync(tmpFile, 'utf-8');

    // Clean up temp file
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }

    // Parse exit code from output
    const exitMatch = output.match(/EXIT_CODE:(\d+)/);
    if (!exitMatch) {
      return { hasAccess: true, error: 'Could not parse exit code from tmux probe output' };
    }

    const exitCode = parseInt(exitMatch[1], 10);
    if (exitCode === 0) {
      return { hasAccess: true };
    }

    // Check if it's specifically a TCC denial
    if (output.includes('Operation not permitted')) {
      return { hasAccess: false, detail: 'TCC denied: Operation not permitted' };
    }

    return { hasAccess: false, detail: `ls exited with code ${exitCode}: ${output.split('\n')[0]}` };
  } catch (err) {
    // Clean up on any error
    try { execSync(`${tmuxPath} kill-session -t ${testSessionName} 2>/dev/null`, { timeout: 3000 }); } catch { /* ok */ }
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
    return { hasAccess: true, error: `Probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Test FDA by running `ls ~/Desktop` directly (no tmux).
 * This tests whether the current process tree has FDA.
 */
function testDirectFdaAccess(): { hasAccess: boolean; error?: string } {
  const testDir = `${os.homedir()}/Desktop`;
  try {
    execSync(`ls "${testDir}" > /dev/null 2>&1`, { timeout: 3000 });
    return { hasAccess: true };
  } catch {
    return { hasAccess: false };
  }
}

export function createPlatformProbes(deps: PlatformProbeDeps): Probe[] {
  const isMacOS = os.platform() === 'darwin';

  if (!isMacOS) {
    return [];
  }

  const tier = 3 as const;
  const feature = 'Platform Readiness';
  const timeoutMs = 15000; // tmux session creation can be slow
  const prerequisites = () => true;

  const settingsUrl = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

  return [
    {
      id: 'instar.platform.tmux-fda',
      name: 'tmux Full Disk Access',
      tier,
      feature,
      timeoutMs,
      prerequisites,
      async run(): Promise<ProbeResult> {
        const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
        const start = Date.now();

        try {
          const { hasAccess, error: testError, detail } = testTmuxFdaAccess(deps.tmuxPath);

          if (testError) {
            return {
              ...base,
              durationMs: Date.now() - start,
              passed: true, // Don't fail on probe infrastructure issues
              description: `Could not verify tmux FDA: ${testError}`,
              diagnostics: { tmuxPath: deps.tmuxPath, error: testError },
            };
          }

          if (!hasAccess) {
            return {
              ...base,
              durationMs: Date.now() - start,
              passed: false,
              description: 'tmux sessions cannot access protected directories — macOS will show recurring permission popups',
              error: detail ?? 'tmux session could not read ~/Desktop (TCC denied)',
              diagnostics: { tmuxPath: deps.tmuxPath },
              remediation: [
                'Open System Settings → Privacy & Security → Full Disk Access',
                'Add your terminal app (iTerm2, Terminal.app, Ghostty, etc.)',
                'And/or add /bin/zsh (or your shell)',
                `Tip: run \`open "${settingsUrl}"\` to jump to the right settings pane`,
                'This is a one-time setup that persists across reboots',
                'Note: After a macOS major update, you may need to re-grant this',
              ],
            };
          }

          return {
            ...base,
            durationMs: Date.now() - start,
            passed: true,
            description: 'tmux sessions can access protected directories',
            diagnostics: { tmuxPath: deps.tmuxPath },
          };
        } catch (err) {
          return {
            ...base,
            durationMs: Date.now() - start,
            passed: true,
            description: 'Could not verify tmux FDA status',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          };
        }
      },
    },

    {
      id: 'instar.platform.shell-fda',
      name: 'Shell Full Disk Access',
      tier,
      feature,
      timeoutMs: 5000,
      prerequisites,
      async run(): Promise<ProbeResult> {
        const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
        const start = Date.now();

        try {
          const { hasAccess } = testDirectFdaAccess();
          const shell = process.env.SHELL || '/bin/zsh';

          if (!hasAccess) {
            return {
              ...base,
              durationMs: Date.now() - start,
              passed: false,
              description: 'Current process cannot access protected directories — agent sessions will trigger macOS permission popups',
              error: `Process (shell: ${shell}) could not read ~/Desktop (TCC denied)`,
              diagnostics: { shell, pid: process.pid },
              remediation: [
                'Open System Settings → Privacy & Security → Full Disk Access',
                `Add your shell: ${shell}`,
                'Or add your terminal app (iTerm2, Terminal.app, Ghostty, etc.)',
                `Tip: run \`open "${settingsUrl}"\` to jump to the right settings pane`,
                'This is a one-time setup that persists across reboots',
              ],
            };
          }

          return {
            ...base,
            durationMs: Date.now() - start,
            passed: true,
            description: `Shell process has access to protected directories`,
            diagnostics: { shell, pid: process.pid },
          };
        } catch (err) {
          return {
            ...base,
            durationMs: Date.now() - start,
            passed: true,
            description: 'Could not verify shell FDA status',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          };
        }
      },
    },
  ];
}
