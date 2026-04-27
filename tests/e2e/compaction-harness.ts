/**
 * Compaction harness — PR0d (context-death-pitfall-prevention spec § P0.1).
 *
 * Provides the test infrastructure needed to prove that post-compaction
 * context recovery works, without requiring a real Claude Code subprocess
 * in CI. The harness:
 *
 *   1. Stands up an isolated agent home (temp dir with `.instar/`,
 *      identity files, and hooks).
 *   2. Invokes `compaction-recovery.sh` directly with controlled env
 *      variables, capturing its stdout exactly as Claude Code's
 *      SessionStart:compact hook handler would receive it.
 *   3. Optionally drives a scripted plan file + commit so downstream
 *      tests (PR2) can assert that durable artifacts survive compaction.
 *   4. Tears everything down idempotently.
 *
 * Threat model: this is a *capability proof*, not a real end-to-end
 * test against the Anthropic API. Spec § P0.1 gates the whole spec on
 * this capability existing — PR0d ships the capability; PR2 uses it to
 * assert the actual post-compaction semantics.
 *
 * Spec: docs/specs/context-death-pitfall-prevention.md § P0.1
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export interface CompactionHarnessOptions {
  /** Agent identity name to write into AGENT.md. Defaults to 'TestAgent'. */
  agentName?: string;
  /** Content for MEMORY.md. Defaults to a minimal marker line. */
  memoryContent?: string;
  /** Optional initial plan file the harness creates + commits (path within agent home). */
  planFile?: { relativePath: string; content: string };
  /** Optional server port the recovery hook will poll for topic context.
   *  Set to 0 / undefined to skip the HTTP path (topic context absent in output). */
  serverPort?: number;
  /** Optional telegram topic id to inject into env. */
  telegramTopic?: string;
}

export interface CompactionHookResult {
  /** Exit code of compaction-recovery.sh. */
  exitCode: number;
  /** Full stdout, as Claude Code's SessionStart:compact handler would consume it. */
  stdout: string;
  /** Full stderr. */
  stderr: string;
  /** Wall-clock milliseconds the hook took to run. */
  durationMs: number;
}

export interface CompactionHarnessHandle {
  /** The isolated agent project root (also `CLAUDE_PROJECT_DIR`). */
  projectDir: string;
  /** `.instar/` subdirectory inside projectDir. */
  stateDir: string;

  /** Write (and optionally commit) a file relative to projectDir. */
  writeFile(relativePath: string, content: string, options?: { commit?: boolean; commitMessage?: string }): void;
  /** Read a file relative to projectDir. */
  readFile(relativePath: string): string;
  /** Set or overwrite an identity file. */
  setIdentity(name: 'AGENT.md' | 'MEMORY.md' | 'USER.md', content: string): void;

  /**
   * Invoke `.instar/hooks/instar/compaction-recovery.sh` directly,
   * mirroring Claude Code's invocation. Returns captured output.
   *
   * `env` is merged on top of the default harness env (which sets
   * `CLAUDE_PROJECT_DIR` and optionally `INSTAR_TELEGRAM_TOPIC`).
   */
  runCompactionRecovery(env?: Record<string, string>): CompactionHookResult;

  /** Absolute path to a fresh temp file inside the harness (cleaned on teardown). */
  tempPath(suffix?: string): string;

  /** Delete the temp directory tree. Idempotent. */
  teardown(): void;
}

/**
 * Create a fresh, fully-isolated compaction harness. Call `teardown()`
 * when done; idempotent — safe to call in afterEach regardless of
 * whether the harness was fully built.
 *
 * The harness always:
 *   - Creates a temp project dir (inside `os.tmpdir()`).
 *   - Initializes a git repo at that path (required for plan-file +
 *     durable-commit tests; cheap).
 *   - Writes `.instar/config.json` with the given port (if any).
 *   - Seeds `AGENT.md`, `MEMORY.md`, and `USER.md` with minimal content.
 *   - Copies the canonical `compaction-recovery.sh` into the harness
 *     `.instar/hooks/instar/` tree so the hook has a real script to
 *     invoke.
 */
export function createCompactionHarness(options: CompactionHarnessOptions = {}): CompactionHarnessHandle {
  const agentName = options.agentName ?? 'TestAgent';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-harness-'));
  const projectDir = path.join(tmp, 'agent-home');
  const stateDir = path.join(projectDir, '.instar');

  let tornDown = false;

  // ── 1. Initialize project tree + git repo ──────────────────────────
  fs.mkdirSync(projectDir, { recursive: true });
  // safe-git-allow: incremental-migration
  execFileSync('git', ['-C', projectDir, 'init', '-q', '-b', 'main']);
  // safe-git-allow: incremental-migration
  execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'harness@instar.local']);
  // safe-git-allow: incremental-migration
  execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'Compaction Harness']);

  // ── 2. Identity files ──────────────────────────────────────────────
  fs.writeFileSync(
    path.join(projectDir, 'AGENT.md'),
    `# ${agentName}\n\nI am ${agentName}, a test harness agent.\n`
  );
  fs.writeFileSync(
    path.join(projectDir, 'MEMORY.md'),
    options.memoryContent ?? '# Auto-Memory\n\n- Harness marker entry\n'
  );
  fs.writeFileSync(
    path.join(projectDir, 'USER.md'),
    '# User\n\nJustin — test harness invoker.\n'
  );

  // ── 3. .instar/ state tree + config.json ───────────────────────────
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'hooks', 'instar'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify(
      {
        agentName,
        projectName: agentName,
        projectDir,
        stateDir,
        port: options.serverPort ?? 0,
        authToken: 'harness-token-' + crypto.randomBytes(4).toString('hex'),
      },
      null,
      2
    )
  );

  // ── 4. Copy the canonical compaction-recovery.sh into the harness ──
  //
  // We locate it relative to the test file's execution cwd by walking
  // up from `process.cwd()` until we find `.instar/hooks/instar/
  // compaction-recovery.sh`. This keeps the harness self-contained
  // regardless of which package dir the test runs from.
  const canonicalHook = locateCanonicalHook('compaction-recovery.sh');
  if (canonicalHook) {
    const dst = path.join(stateDir, 'hooks', 'instar', 'compaction-recovery.sh');
    fs.copyFileSync(canonicalHook, dst);
    fs.chmodSync(dst, 0o755);
  }
  // If canonical hook isn't findable, the test will get a clear failure
  // when it tries to run the hook — better than silently synthesizing
  // one.

  // ── 5. Optional plan file, committed so it's durable ───────────────
  if (options.planFile) {
    const planAbs = path.join(projectDir, options.planFile.relativePath);
    fs.mkdirSync(path.dirname(planAbs), { recursive: true });
    fs.writeFileSync(planAbs, options.planFile.content);
    // safe-git-allow: incremental-migration
    execFileSync('git', ['-C', projectDir, 'add', options.planFile.relativePath]);
    // safe-git-allow: incremental-migration
    execFileSync(
      'git',
      ['-C', projectDir, 'commit', '-q', '-m', `plan: ${options.planFile.relativePath}`]
    );
  }

  // ── 6. Also commit identity files so they're "durable" per the spec
  // safe-git-allow: incremental-migration
  execFileSync('git', ['-C', projectDir, 'add', 'AGENT.md', 'MEMORY.md', 'USER.md', '.instar/config.json']);
  // safe-git-allow: incremental-migration
  execFileSync('git', ['-C', projectDir, 'commit', '-q', '-m', 'harness: identity + config']);

  return {
    projectDir,
    stateDir,

    writeFile(relativePath, content, opts) {
      const abs = path.join(projectDir, relativePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      if (opts?.commit) {
        // safe-git-allow: incremental-migration
        execFileSync('git', ['-C', projectDir, 'add', relativePath]);
        // safe-git-allow: incremental-migration
        execFileSync(
          'git',
          ['-C', projectDir, 'commit', '-q', '-m', opts.commitMessage ?? `write: ${relativePath}`]
        );
      }
    },

    readFile(relativePath) {
      return fs.readFileSync(path.join(projectDir, relativePath), 'utf8');
    },

    setIdentity(name, content) {
      fs.writeFileSync(path.join(projectDir, name), content);
    },

    runCompactionRecovery(env = {}) {
      const hookPath = path.join(stateDir, 'hooks', 'instar', 'compaction-recovery.sh');
      if (!fs.existsSync(hookPath)) {
        throw new Error(
          `compaction-recovery.sh not found at ${hookPath}. ` +
          `The harness could not locate a canonical hook to copy. ` +
          `Either run tests from the instar repo root, or pass a pre-populated harness.`
        );
      }

      const mergedEnv: Record<string, string> = {
        // Minimal, deterministic env — do NOT inherit the parent env by
        // default to keep hook behavior reproducible.
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: projectDir,
        CLAUDE_PROJECT_DIR: projectDir,
      };
      if (options.telegramTopic) {
        mergedEnv.INSTAR_TELEGRAM_TOPIC = options.telegramTopic;
      }
      Object.assign(mergedEnv, env);

      const start = Date.now();
      const result = spawnSync('bash', [hookPath], {
        env: mergedEnv,
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 10_000,
      });
      const durationMs = Date.now() - start;

      return {
        exitCode: result.status ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        durationMs,
      };
    },

    tempPath(suffix = '') {
      return path.join(tmp, `tmp-${crypto.randomBytes(4).toString('hex')}${suffix}`);
    },

    teardown() {
      if (tornDown) return;
      tornDown = true;
      try {
        // safe-git-allow: incremental-migration
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort; harness cleanup should not break tests
      }
    },
  };
}

/**
 * Walk upward from `process.cwd()` until we find the hook file, either
 * under `src/templates/hooks/<hookName>` (canonical source-of-truth in
 * the instar repo) or `.instar/hooks/instar/<hookName>` (deployed agent
 * copy, used as fallback when tests run outside the instar repo).
 * Return the absolute path or null.
 */
function locateCanonicalHook(hookName: string): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const canonical = path.join(dir, 'src', 'templates', 'hooks', hookName);
    if (fs.existsSync(canonical)) return canonical;
    const deployed = path.join(dir, '.instar', 'hooks', 'instar', hookName);
    if (fs.existsSync(deployed)) return deployed;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
