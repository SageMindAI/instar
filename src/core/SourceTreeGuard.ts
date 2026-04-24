/**
 * SourceTreeGuard — refuses destructive operations against the instar source tree.
 *
 * Background: on 2026-04-22 an e2e test fixture ran `git add -A && git commit`
 * against the real instar source checkout (1,893 files wiped, force-push
 * recovery). Root cause: destructive components trusted an incoming
 * `projectDir` with zero verification it was the intended target.
 *
 * This module is the tactical guardrail described in
 * `docs/specs/DESTRUCTIVE-TOOL-TARGET-GUARDS-SPEC.md`. It is deliberately a
 * brittle blocker — the `docs/signal-vs-authority.md` "safety guards on
 * irreversible actions" carve-out applies (false-pass cost is catastrophic,
 * false-block cost is trivial).
 *
 * Detection is OR of three layers:
 *   (a) marker file `.instar-source-tree` at the resolved root.
 *   (b) canonical `origin` remote URL in the resolved common git dir's config.
 *   (c) source identity signature: package.json name === "instar" AND at
 *       least TWO of a set of instar-specific files exist.
 *
 * Fail-closed is TWO-TIER:
 *   - Detector-level errors (cannot canonicalize, cannot ascend to any
 *     existing ancestor, EACCES on all candidate ancestors) return TRUE.
 *   - Layer-level errors (one layer cannot evaluate) return FALSE for that
 *     sub-check; the OR across the other two layers decides.
 *
 * See the spec for the full rationale.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Canonical remote URLs ────────────────────────────────────────────
//
// Exact-match list (post-normalization). Forks running on their own package
// name and without the marker file will legitimately NOT be caught by layer
// (b) — that is intentional. Layer (c) still catches unrenamed forks, and
// the marker catches any fork that deliberately opts in.
//
// If instar ever moves org/repo, add an entry here — never substitute.
// Old URLs stay to catch legacy checkouts.
export const CANONICAL_INSTAR_REMOTES: readonly string[] = Object.freeze([
  'git@github.com:dawn/instar.git',
  'https://github.com/dawn/instar.git',
  'ssh://git@github.com/dawn/instar.git',
]);

// ── Source-identity signature files ──────────────────────────────────
//
// At least TWO of these (in addition to package.json name === "instar")
// must be present for layer (c) to match.
const SIGNATURE_FILES: readonly string[] = Object.freeze([
  'src/core/GitSync.ts',
  'src/core/BranchManager.ts',
  'src/core/HandoffManager.ts',
  'tsconfig.json',
  'skills/spec-converge/SKILL.md',
]);

const MARKER_FILENAME = '.instar-source-tree';
const MAX_WALK_LEVELS = 40;

// ── Error shape ──────────────────────────────────────────────────────

export class SourceTreeGuardError extends Error {
  readonly code = 'INSTAR_SOURCE_TREE_GUARD';
  readonly operation: string;
  readonly dir: string;
  readonly resolvedRoot: string;

  constructor(dir: string, resolvedRoot: string, operation: string) {
    super(
      `Refusing to run ${operation} against the instar source tree ` +
        `(requested dir: ${dir}, resolved git root: ${resolvedRoot}). ` +
        `This is a safety guard against the 2026-04-22 class of incident. ` +
        `See docs/specs/DESTRUCTIVE-TOOL-TARGET-GUARDS-SPEC.md for the documented ` +
        `escape hatch if this block is a genuine false-positive.`,
    );
    this.name = 'SourceTreeGuardError';
    this.operation = operation;
    this.dir = dir;
    this.resolvedRoot = resolvedRoot;
  }
}

// ── Path canonicalization ────────────────────────────────────────────

/**
 * Canonicalize `dir`. If it doesn't exist, walk upward via `path.dirname`
 * until an existing ancestor is found, then canonicalize THAT.
 *
 * Returns null if no existing ancestor can be found or canonicalized
 * (detector-level fail-closed — caller returns true from isInstarSourceTree).
 *
 * ENOENT and ENOTDIR during the walk are normal (keep ascending). EACCES
 * is also tolerated on stat — we keep ascending. Only if we hit the
 * filesystem root without finding any accessible existing ancestor do we
 * return null.
 */
function canonicalizeNearestExistingAncestor(dir: string): string | null {
  // Absolute path so dirname walk terminates at filesystem root.
  let candidate: string;
  try {
    candidate = path.resolve(dir);
  } catch {
    return null;
  }

  for (let i = 0; i < MAX_WALK_LEVELS; i++) {
    try {
      const st = fs.statSync(candidate);
      if (st) {
        // Exists — now canonicalize with realpath (resolves symlinks).
        try {
          return fs.realpathSync(candidate);
        } catch {
          // realpath failed on an existing path — detector-level fail-closed.
          return null;
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Normal walk condition — keep ascending.
      } else if (code === 'EACCES' || code === 'EPERM') {
        // Cannot stat — keep ascending; we'll decide at the loop end.
      } else {
        // Unknown stat error — treat as unable to decide; keep ascending.
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      // Reached filesystem root without finding an existing ancestor.
      return null;
    }
    candidate = parent;
  }
  return null;
}

// ── Git root walk ────────────────────────────────────────────────────

interface GitRootResolution {
  /** The worktree root (directory containing `.git`). */
  worktreeRoot: string;
  /**
   * The path of the `.git` entry (file or dir) OR null if no `.git` found.
   * If null, `worktreeRoot` is just the canonicalized start.
   */
  dotGitPath: string | null;
  /** True if `.git` is a file (worktree), false if directory. */
  dotGitIsFile: boolean;
}

function findGitRoot(startDir: string): GitRootResolution {
  let current = startDir;
  for (let i = 0; i < MAX_WALK_LEVELS; i++) {
    const dotGit = path.join(current, '.git');
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(dotGit);
    } catch {
      // No .git here — keep ascending.
    }
    if (stat) {
      return {
        worktreeRoot: current,
        dotGitPath: dotGit,
        dotGitIsFile: stat.isFile(),
      };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { worktreeRoot: startDir, dotGitPath: null, dotGitIsFile: false };
}

// ── Worktree common-git-dir resolution ───────────────────────────────

/**
 * Given a `.git` FILE (worktree pointer), resolve the common git dir.
 *
 * The standard layout is `<common-git-dir>/worktrees/<name>` (i.e. the
 * `gitdir:` pointer targets a subdirectory of `worktrees/` inside the
 * main repo's `.git`). In that case the common git dir is
 * `dirname(dirname(gitdir))`.
 *
 * Any other layout (submodule worktree, custom core.worktreesDir, etc.)
 * returns null — layer (b) fails closed for the sub-check, and layers
 * (a)/(c) still evaluate at the worktree root.
 */
function resolveCommonGitDirFromWorktreeFile(
  dotGitFilePath: string,
): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(dotGitFilePath, 'utf8');
  } catch {
    return null;
  }
  const match = contents.match(/^\s*gitdir:\s*(.+?)\s*$/m);
  if (!match) return null;

  let gitdirRaw = match[1].trim();
  if (!gitdirRaw) return null;

  // Relative paths resolve against the directory containing the `.git` file
  // (the worktree root), per git-worktree(1).
  let gitdir: string;
  if (path.isAbsolute(gitdirRaw)) {
    gitdir = gitdirRaw;
  } else {
    gitdir = path.resolve(path.dirname(dotGitFilePath), gitdirRaw);
  }

  // Verify it exists and canonicalize.
  try {
    gitdir = fs.realpathSync(gitdir);
  } catch {
    return null;
  }

  // Standard layout: <common>/worktrees/<name>
  const parent = path.dirname(gitdir);
  if (path.basename(parent) !== 'worktrees') {
    return null;
  }
  return path.dirname(parent);
}

// ── Layer (a): marker file ───────────────────────────────────────────

function layerMarker(resolvedRoot: string): boolean {
  try {
    return fs.existsSync(path.join(resolvedRoot, MARKER_FILENAME));
  } catch {
    return false;
  }
}

// ── Layer (b): canonical remote URL ──────────────────────────────────

/**
 * Minimal canonicalization per spec:
 *   1. Strip leading/trailing whitespace and newlines.
 *   2. Strip a single trailing `/`.
 *   3. Strip a single trailing `.git`.
 */
function normalizeRemoteUrl(raw: string): string {
  let s = raw.trim();
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('.git')) s = s.slice(0, -'.git'.length);
  return s;
}

const NORMALIZED_CANONICAL_REMOTES: readonly string[] = Object.freeze(
  CANONICAL_INSTAR_REMOTES.map(normalizeRemoteUrl),
);

function parseOriginUrlFromGitConfig(configText: string): string | null {
  // Find the [remote "origin"] section and its url = ... line.
  // Section is terminated by the next [section] header or EOF.
  const sectionRe = /\[\s*remote\s+"origin"\s*\]\s*([\s\S]*?)(?=\n\s*\[|\s*$)/i;
  const match = configText.match(sectionRe);
  if (!match) return null;
  const body = match[1];
  const urlMatch = body.match(/^\s*url\s*=\s*(.+?)\s*$/m);
  if (!urlMatch) return null;
  return urlMatch[1];
}

function layerRemoteUrl(
  worktreeRoot: string,
  dotGitPath: string | null,
  dotGitIsFile: boolean,
): boolean {
  if (!dotGitPath) return false;

  let configPath: string;
  if (dotGitIsFile) {
    const commonGitDir = resolveCommonGitDirFromWorktreeFile(dotGitPath);
    if (!commonGitDir) return false; // Layer-level inconclusive → FALSE.
    configPath = path.join(commonGitDir, 'config');
  } else {
    configPath = path.join(dotGitPath, 'config');
  }

  let configText: string;
  try {
    configText = fs.readFileSync(configPath, 'utf8');
  } catch {
    return false;
  }

  const rawUrl = parseOriginUrlFromGitConfig(configText);
  if (rawUrl == null) return false;

  const normalized = normalizeRemoteUrl(rawUrl);
  return NORMALIZED_CANONICAL_REMOTES.includes(normalized);
}

// ── Layer (c): source identity signature ─────────────────────────────

function layerSignature(resolvedRoot: string): boolean {
  const pkgPath = path.join(resolvedRoot, 'package.json');
  let pkgText: string;
  try {
    pkgText = fs.readFileSync(pkgPath, 'utf8');
  } catch {
    return false;
  }
  let pkg: { name?: unknown };
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return false;
  }
  if (pkg.name !== 'instar') return false;

  let hits = 0;
  for (const rel of SIGNATURE_FILES) {
    try {
      if (fs.existsSync(path.join(resolvedRoot, rel))) {
        hits++;
        if (hits >= 2) return true;
      }
    } catch {
      // Ignore individual file errors; a single stat failure is not enough
      // to fail the whole sub-check.
    }
  }
  return hits >= 2;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Returns true if `dir` — or any of its git-root ancestors — is the
 * instar source tree.
 *
 * See module header and the spec for full semantics.
 */
export function isInstarSourceTree(dir: string): boolean {
  // Step 1: resolve nearest-existing-ancestor and canonicalize.
  const canonicalStart = canonicalizeNearestExistingAncestor(dir);
  if (canonicalStart === null) {
    // Detector-level fail-closed.
    return true;
  }

  // Step 2: walk to the git root (or keep canonicalStart if none found).
  const { worktreeRoot, dotGitPath, dotGitIsFile } = findGitRoot(canonicalStart);

  // Step 3: OR across the three layers.
  if (layerMarker(worktreeRoot)) return true;
  if (layerRemoteUrl(worktreeRoot, dotGitPath, dotGitIsFile)) return true;
  if (layerSignature(worktreeRoot)) return true;

  return false;
}

/**
 * Throws `SourceTreeGuardError` if `dir` is the instar source tree.
 *
 * Callers MUST pass the raw projectDir from the original caller — NOT a
 * post-sanitization/post-normalization value. Sanitization would hide the
 * class of bug this guard exists to catch.
 */
export function assertNotInstarSourceTree(
  dir: string,
  operation: string,
): void {
  if (isInstarSourceTree(dir)) {
    // Compute resolved root for the error (best-effort — if resolution
    // fails we report the raw input).
    const resolved = canonicalizeNearestExistingAncestor(dir);
    let resolvedRoot = dir;
    if (resolved !== null) {
      const { worktreeRoot } = findGitRoot(resolved);
      resolvedRoot = worktreeRoot;
    }
    throw new SourceTreeGuardError(dir, resolvedRoot, operation);
  }
}

/**
 * Convenience alias per spec §"The guard primitive".
 */
export function checkSourceTree(dir: string): boolean {
  return isInstarSourceTree(dir);
}

/**
 * Test helper: resolve the canonical start + git root without running the
 * layer checks. Not part of the public API — exported only for test
 * introspection.
 *
 * @internal
 */
export function _resolveRootForTesting(dir: string): {
  canonicalStart: string | null;
  worktreeRoot: string | null;
  dotGitPath: string | null;
  dotGitIsFile: boolean;
} {
  const canonicalStart = canonicalizeNearestExistingAncestor(dir);
  if (canonicalStart === null) {
    return {
      canonicalStart: null,
      worktreeRoot: null,
      dotGitPath: null,
      dotGitIsFile: false,
    };
  }
  const { worktreeRoot, dotGitPath, dotGitIsFile } = findGitRoot(canonicalStart);
  return { canonicalStart, worktreeRoot, dotGitPath, dotGitIsFile };
}
