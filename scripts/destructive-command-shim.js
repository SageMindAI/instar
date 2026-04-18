#!/usr/bin/env node
/**
 * destructive-command-shim.js — guard `git`/`rm` invocations inside topic worktrees.
 *
 * Per PARALLEL-DEV-ISOLATION-SPEC.md "Destructive-command interception (iter 4 — MANDATORY)".
 *
 * Behavior:
 *   - For non-destructive `git`/`rm` invocations: pass through transparently.
 *   - For destructive ones (git clean -fd, git reset --hard, rm -rf with >5 entries, etc.):
 *       1. Compute would-affect file count (dry-run).
 *       2. If snapshot needed: tar+zstd the worktree to .instar/worktrees/.snapshots/
 *          with chmod 0600. BLOCK if snapshot fails.
 *       3. Append event to .instar/worktrees/.lock-history.jsonl
 *       4. Forward to the real binary.
 *
 * Real binaries are resolved by stripping the shim dir from PATH and re-resolving.
 *
 * Usage: destructive-command-shim.js <git|rm> <original args...>
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SECURE_FILE_MODE = 0o600;
const DESTRUCTIVE_FILE_THRESHOLD = 5;

function findWorktreeRoot(startCwd) {
  let cwd = startCwd;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(cwd, '.session.lock'))) return cwd;
    const parent = path.dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return null;
}

function findStateRoot(worktreeRoot) {
  // .instar/worktrees/<wt>/ → .instar/worktrees/.snapshots/
  let cwd = worktreeRoot;
  for (let i = 0; i < 5; i++) {
    if (path.basename(cwd) === 'worktrees' && path.basename(path.dirname(cwd)) === '.instar') {
      return path.dirname(path.dirname(cwd));
    }
    cwd = path.dirname(cwd);
  }
  return null;
}

function resolveRealBinary(name) {
  const sessionShim = process.env.INSTAR_SHIM_DIR;
  // Strip shim dir from PATH and re-resolve
  let pathParts = (process.env.PATH ?? '').split(':');
  if (sessionShim) pathParts = pathParts.filter(p => p !== sessionShim);
  const cleanPath = pathParts.join(':');

  for (const dir of pathParts) {
    const candidate = path.join(dir, name);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && (st.mode & 0o111)) return { path: candidate, env: { ...process.env, PATH: cleanPath } };
    } catch { /* keep looking */ }
  }
  // Fallback: known absolute paths
  const known = name === 'git'
    ? ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']
    : ['/bin/rm', '/usr/bin/rm'];
  for (const k of known) {
    if (fs.existsSync(k)) return { path: k, env: { ...process.env, PATH: cleanPath } };
  }
  throw new Error(`could not resolve real ${name}`);
}

function isDestructiveGit(args) {
  if (args.length === 0) return false;
  const a = args[0];

  if (a === 'clean') {
    // -f with -d (or -fd) is destructive
    return args.some(x => /-.*[fd].*[fd]/.test(x) || x === '-fd' || x === '-fdx' || x === '-fx');
  }
  if (a === 'reset') {
    return args.includes('--hard');
  }
  if (a === 'checkout') {
    // git checkout -- . / git checkout HEAD -- .
    return args.includes('--') || args.includes('.');
  }
  if (a === 'rm') {
    return args.includes('-r') || args.includes('-rf') || args.includes('-fr');
  }
  return false;
}

function isDestructiveRm(args) {
  return args.some(x => /^-.*r/.test(x)) && args.some(x => /^-.*f/.test(x));
}

function dryRunGitClean(cwd, args) {
  // Use -n to count what would be removed
  const dryArgs = ['-C', cwd, 'clean', '-n', ...args.filter(a => a !== '-f')];
  try {
    const out = execFileSync('git', dryArgs, { encoding: 'utf-8', timeout: 5000 });
    return out.split('\n').filter(Boolean).length;
  } catch { return Number.POSITIVE_INFINITY; }
}

function snapshotWorktree(worktreeRoot, stateRoot) {
  const snapshotsDir = path.join(stateRoot, 'worktrees', '.snapshots');
  fs.mkdirSync(snapshotsDir, { recursive: true });
  const ts = Date.now();
  const wtName = path.basename(worktreeRoot);
  const candidate = path.join(snapshotsDir, `${wtName}-${ts}.tar.zst`);
  const fallback = path.join(snapshotsDir, `${wtName}-${ts}.tar.gz`);

  const exclusions = ['node_modules', 'dist', '.next', 'build', 'target', '.cache'];
  const excludeArgs = exclusions.flatMap(x => ['--exclude', x]);

  // Try zstd first
  try {
    execFileSync('zstd', ['--version'], { stdio: 'pipe' });
    execFileSync('sh', ['-c',
      `tar -C "${path.dirname(worktreeRoot)}" ${excludeArgs.map(a => `'${a}'`).join(' ')} -cf - "${path.basename(worktreeRoot)}" | zstd -o "${candidate}"`,
    ], { stdio: 'inherit', timeout: 30_000 });
    fs.chmodSync(candidate, SECURE_FILE_MODE);
    return candidate;
  } catch {
    // Fallback: tar + gzip
    execFileSync('tar', [
      '-C', path.dirname(worktreeRoot),
      ...excludeArgs,
      '-czf', fallback,
      path.basename(worktreeRoot),
    ], { stdio: 'inherit', timeout: 30_000 });
    fs.chmodSync(fallback, SECURE_FILE_MODE);
    return fallback;
  }
}

function appendHistoryEvent(worktreeRoot, event) {
  const histFile = path.join(worktreeRoot, '.lock-history.jsonl');
  const entry = JSON.stringify({ ts: Date.now(), ...event });
  fs.appendFileSync(histFile, `${entry}\n`, { mode: SECURE_FILE_MODE });
}

function passthrough(realBin, args) {
  const child = spawn(realBin.path, args, {
    stdio: 'inherit',
    env: realBin.env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => { console.error(err.message); process.exit(127); });
}

async function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  if (!['git', 'rm'].includes(cmd)) {
    console.error(`destructive-command-shim: unknown command "${cmd}"`);
    process.exit(2);
  }

  const realBin = resolveRealBinary(cmd);
  const cwd = process.cwd();
  const worktreeRoot = findWorktreeRoot(cwd);

  // Not inside a managed worktree → passthrough silently
  if (!worktreeRoot) return passthrough(realBin, args);

  const isDestructive = cmd === 'git' ? isDestructiveGit(args) : isDestructiveRm(args);
  if (!isDestructive) return passthrough(realBin, args);

  // Determine if this would affect >5 files
  let affectedCount = Number.POSITIVE_INFINITY;
  if (cmd === 'git' && args[0] === 'clean') {
    affectedCount = dryRunGitClean(worktreeRoot, args);
  } else if (cmd === 'rm') {
    // rm -rf <paths>: count entries
    const targets = args.filter(a => !a.startsWith('-'));
    affectedCount = targets.length;
  }

  // For all other destructive cmds (reset --hard, checkout -- .): always snapshot
  const shouldSnapshot = affectedCount > DESTRUCTIVE_FILE_THRESHOLD || cmd === 'git' && (args[0] === 'reset' || args[0] === 'checkout');

  if (shouldSnapshot) {
    const stateRoot = findStateRoot(worktreeRoot);
    if (!stateRoot) {
      console.error('destructive-command-shim: BLOCK — could not locate .instar state root');
      process.exit(1);
    }
    let snapshotPath;
    try {
      snapshotPath = snapshotWorktree(worktreeRoot, stateRoot);
    } catch (err) {
      console.error(`destructive-command-shim: BLOCK — snapshot failed: ${err.message}`);
      process.exit(1);
    }
    appendHistoryEvent(worktreeRoot, {
      kind: 'destructive-cmd-snapshotted',
      cmd,
      args,
      snapshotPath,
      affectedCount,
    });
    console.error(`destructive-command-shim: snapshotted to ${snapshotPath} before "${cmd} ${args.join(' ')}"`);
  }

  return passthrough(realBin, args);
}

main().catch((err) => {
  console.error(`destructive-command-shim: BLOCK — ${err.message}`);
  process.exit(1);
});
