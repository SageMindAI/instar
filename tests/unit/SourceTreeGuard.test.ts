import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isInstarSourceTree,
  assertNotInstarSourceTree,
  SourceTreeGuardError,
  CANONICAL_INSTAR_REMOTES,
} from '../../src/core/SourceTreeGuard.js';

// ─── Fixture helpers ────────────────────────────────────────────────

function mkSandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stg-'));
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeMarker(root: string): void {
  writeFile(path.join(root, '.instar-source-tree'), 'marker\n');
}

function writeGitConfigWithOriginUrl(root: string, url: string): void {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const content = `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  writeFile(path.join(root, '.git', 'config'), content);
}

function writeSignatureFiles(root: string, files: string[]): void {
  for (const rel of files) {
    writeFile(path.join(root, rel), '// sig\n');
  }
}

function writeInstarPackageJson(root: string): void {
  writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'instar', version: '0.0.0' }),
  );
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('SourceTreeGuard — layer (a) marker file', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkSandbox();
  });
  afterEach(() => rmrf(sandbox));

  it('returns true when marker file is present', () => {
    writeMarker(sandbox);
    expect(isInstarSourceTree(sandbox)).toBe(true);
  });

  it('returns false when marker file is absent (and no other signals)', () => {
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });
});

describe('SourceTreeGuard — layer (b) canonical remote URL', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkSandbox();
  });
  afterEach(() => rmrf(sandbox));

  for (const url of CANONICAL_INSTAR_REMOTES) {
    it(`returns true for canonical URL: ${url}`, () => {
      writeGitConfigWithOriginUrl(sandbox, url);
      expect(isInstarSourceTree(sandbox)).toBe(true);
    });
  }

  it('returns true for trailing-slash normalization', () => {
    writeGitConfigWithOriginUrl(sandbox, 'https://github.com/dawn/instar.git/');
    expect(isInstarSourceTree(sandbox)).toBe(true);
  });

  it('returns true for missing-.git-suffix normalization', () => {
    writeGitConfigWithOriginUrl(sandbox, 'https://github.com/dawn/instar');
    expect(isInstarSourceTree(sandbox)).toBe(true);
  });

  it('returns true for trailing-whitespace normalization', () => {
    writeGitConfigWithOriginUrl(sandbox, 'https://github.com/dawn/instar.git  ');
    expect(isInstarSourceTree(sandbox)).toBe(true);
  });

  it('returns true for trailing-newline normalization (raw write)', () => {
    // The url value itself carries a trailing newline before the next line.
    fs.mkdirSync(path.join(sandbox, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(sandbox, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/dawn/instar.git\n',
    );
    expect(isInstarSourceTree(sandbox)).toBe(true);
  });

  it('returns false for a fork remote URL not on the canonical list', () => {
    writeGitConfigWithOriginUrl(sandbox, 'git@github.com:someuser/instar-fork.git');
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });

  it('returns false for an unrelated remote URL', () => {
    writeGitConfigWithOriginUrl(sandbox, 'git@github.com:acme/widgets.git');
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });

  it('does NOT substring-match on "instar" in non-canonical URLs', () => {
    writeGitConfigWithOriginUrl(sandbox, 'git@github.com:dawn/instar-extra.git');
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });
});

describe('SourceTreeGuard — layer (c) source identity signature', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkSandbox();
  });
  afterEach(() => rmrf(sandbox));

  it('returns true when package.json name === "instar" AND two signature files exist', () => {
    writeInstarPackageJson(sandbox);
    writeSignatureFiles(sandbox, ['src/core/GitSync.ts', 'src/core/BranchManager.ts']);
    expect(isInstarSourceTree(sandbox)).toBe(true);
  });

  it('returns false when package.json name === "instar" but only one signature file exists', () => {
    writeInstarPackageJson(sandbox);
    writeSignatureFiles(sandbox, ['src/core/GitSync.ts']);
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });

  it('returns false when package.json name is not "instar" even with many signature files', () => {
    writeFile(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'not-instar' }));
    writeSignatureFiles(sandbox, ['src/core/GitSync.ts', 'src/core/BranchManager.ts', 'tsconfig.json']);
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });

  it('layer (c) returns false when package.json is malformed (layer-level inconclusive)', () => {
    writeFile(path.join(sandbox, 'package.json'), '{ not valid json');
    writeSignatureFiles(sandbox, ['src/core/GitSync.ts', 'src/core/BranchManager.ts']);
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });
});

describe('SourceTreeGuard — git-root walk (subdirectory bypass)', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkSandbox();
  });
  afterEach(() => rmrf(sandbox));

  it('returns true for a subdirectory when the root has the marker', () => {
    writeMarker(sandbox);
    fs.mkdirSync(path.join(sandbox, '.git'), { recursive: true }); // make it look like a repo
    const subdir = path.join(sandbox, 'src', 'nested');
    fs.mkdirSync(subdir, { recursive: true });
    expect(isInstarSourceTree(subdir)).toBe(true);
  });

  it('uncreated subdirectory inside the repo: returns true via nearest-existing-ancestor', () => {
    writeMarker(sandbox);
    fs.mkdirSync(path.join(sandbox, '.git'), { recursive: true });
    const uncreated = path.join(sandbox, 'src', 'new_feature', 'does', 'not', 'exist');
    expect(isInstarSourceTree(uncreated)).toBe(true);
  });

  it('nonexistent path whose nearest existing ancestor is outside instar: returns false', () => {
    const nonexistent = path.join(sandbox, 'does', 'not', 'exist', 'anywhere');
    // sandbox has no marker, no .git, no instar package
    expect(isInstarSourceTree(nonexistent)).toBe(false);
  });

  it('ENOTDIR on an intermediate segment: walk continues past it', () => {
    writeMarker(sandbox);
    fs.mkdirSync(path.join(sandbox, '.git'), { recursive: true });
    // Create a regular file and then try to treat it as a directory with a deeper path.
    const fileSeg = path.join(sandbox, 'a-file');
    fs.writeFileSync(fileSeg, 'hi');
    const badPath = path.join(fileSeg, 'under', 'the', 'file');
    expect(isInstarSourceTree(badPath)).toBe(true);
  });
});

describe('SourceTreeGuard — worktree handling (.git as file)', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkSandbox();
  });
  afterEach(() => rmrf(tmpRoot));

  it('worktree with standard layout resolves common-git-dir and matches canonical remote', () => {
    // Build: <tmpRoot>/main/.git/worktrees/wt1 and <tmpRoot>/wt-root/.git (file pointing at it)
    const mainRepo = path.join(tmpRoot, 'main');
    const commonGitDir = path.join(mainRepo, '.git');
    const wtAdmin = path.join(commonGitDir, 'worktrees', 'wt1');
    fs.mkdirSync(wtAdmin, { recursive: true });
    // main/.git/config has canonical remote.
    fs.writeFileSync(
      path.join(commonGitDir, 'config'),
      '[remote "origin"]\n\turl = https://github.com/dawn/instar.git\n',
    );

    const wtRoot = path.join(tmpRoot, 'wt-root');
    fs.mkdirSync(wtRoot, { recursive: true });
    fs.writeFileSync(path.join(wtRoot, '.git'), `gitdir: ${wtAdmin}\n`);

    expect(isInstarSourceTree(wtRoot)).toBe(true);
  });

  it('worktree with relative gitdir pointer resolves against the worktree root', () => {
    // Place main and wt-root as siblings so a relative gitdir resolves.
    const mainRepo = path.join(tmpRoot, 'main');
    const commonGitDir = path.join(mainRepo, '.git');
    const wtAdmin = path.join(commonGitDir, 'worktrees', 'wt1');
    fs.mkdirSync(wtAdmin, { recursive: true });
    fs.writeFileSync(
      path.join(commonGitDir, 'config'),
      '[remote "origin"]\n\turl = https://github.com/dawn/instar.git\n',
    );

    const wtRoot = path.join(tmpRoot, 'wt-root');
    fs.mkdirSync(wtRoot, { recursive: true });
    // Relative pointer from wtRoot: ../main/.git/worktrees/wt1
    fs.writeFileSync(
      path.join(wtRoot, '.git'),
      'gitdir: ../main/.git/worktrees/wt1\n',
    );

    expect(isInstarSourceTree(wtRoot)).toBe(true);
  });

  it('worktree with non-standard layout (basename(dirname(gitdir)) !== "worktrees") → layer (b) inconclusive, layers (a)/(c) still decide', () => {
    const wtRoot = path.join(tmpRoot, 'wt-root');
    fs.mkdirSync(wtRoot, { recursive: true });
    const weirdGitdir = path.join(tmpRoot, 'weird-place', 'submodule-like', 'admin');
    fs.mkdirSync(weirdGitdir, { recursive: true });
    fs.writeFileSync(path.join(wtRoot, '.git'), `gitdir: ${weirdGitdir}\n`);

    // No marker, no signature → all layers fail → false.
    expect(isInstarSourceTree(wtRoot)).toBe(false);

    // Now add the marker at the worktree root → layer (a) wins.
    writeMarker(wtRoot);
    expect(isInstarSourceTree(wtRoot)).toBe(true);
  });

  it('worktree with malformed gitdir pointer: layer (b) inconclusive; other layers decide', () => {
    const wtRoot = path.join(tmpRoot, 'wt-root');
    fs.mkdirSync(wtRoot, { recursive: true });
    fs.writeFileSync(path.join(wtRoot, '.git'), 'garbage not a gitdir line\n');

    expect(isInstarSourceTree(wtRoot)).toBe(false);

    writeMarker(wtRoot);
    expect(isInstarSourceTree(wtRoot)).toBe(true);
  });
});

describe('SourceTreeGuard — layer-level fail-inconclusive (two-tier)', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkSandbox();
  });
  afterEach(() => rmrf(sandbox));

  it('unreadable package.json (malformed) + marker present → true (layer a wins)', () => {
    writeMarker(sandbox);
    writeFile(path.join(sandbox, 'package.json'), '{ not valid json');
    expect(isInstarSourceTree(sandbox)).toBe(true);
  });

  it('malformed package.json + no marker + no git config → false (detector completes)', () => {
    writeFile(path.join(sandbox, 'package.json'), '{ not valid json');
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });

  it('git config directory (not a file) + no marker + no signature → false', () => {
    // Create `.git/config` as a DIRECTORY, not a file.
    fs.mkdirSync(path.join(sandbox, '.git', 'config'), { recursive: true });
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });
});

describe('SourceTreeGuard — negative cases', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkSandbox();
  });
  afterEach(() => rmrf(sandbox));

  it('empty tmpdir returns false', () => {
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });

  it('git repo with unrelated remote returns false', () => {
    writeGitConfigWithOriginUrl(sandbox, 'https://github.com/acme/unrelated.git');
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });

  it('tmpdir with instar package.json but no signature files returns false', () => {
    writeInstarPackageJson(sandbox);
    expect(isInstarSourceTree(sandbox)).toBe(false);
  });
});

describe('SourceTreeGuard — symlink canonicalization', () => {
  let realDir: string;
  let linkDir: string;
  beforeEach(() => {
    realDir = mkSandbox();
    linkDir = path.join(os.tmpdir(), `stg-link-${process.pid}-${Date.now()}`);
    writeMarker(realDir);
    try {
      fs.symlinkSync(realDir, linkDir);
    } catch (err) {
      // On some filesystems symlinks may be denied — test will skip.
    }
  });
  afterEach(() => {
    try {
      fs.unlinkSync(linkDir);
    } catch {
      // ignore
    }
    rmrf(realDir);
  });

  it('returns true when input is a symlink to an instar source tree', () => {
    if (!fs.existsSync(linkDir)) return; // symlink creation failed; skip.
    expect(isInstarSourceTree(linkDir)).toBe(true);
  });
});

describe('SourceTreeGuard — assertion wrapper', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkSandbox();
  });
  afterEach(() => rmrf(sandbox));

  it('is a no-op on a clean tmpdir', () => {
    expect(() => assertNotInstarSourceTree(sandbox, 'TestOp')).not.toThrow();
  });

  it('throws SourceTreeGuardError with the right code/operation/dir/resolvedRoot', () => {
    writeMarker(sandbox);
    let caught: unknown;
    try {
      assertNotInstarSourceTree(sandbox, 'GitSyncManager');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SourceTreeGuardError);
    const e = caught as SourceTreeGuardError;
    expect(e.code).toBe('INSTAR_SOURCE_TREE_GUARD');
    expect(e.operation).toBe('GitSyncManager');
    expect(e.dir).toBe(sandbox);
    // resolvedRoot should be the canonicalized sandbox path.
    expect(e.resolvedRoot).toBe(fs.realpathSync(sandbox));
  });

  it('error message does NOT inline bypass instructions (tutorial-in-error avoidance)', () => {
    writeMarker(sandbox);
    try {
      assertNotInstarSourceTree(sandbox, 'GitSyncManager');
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      // Must NOT include the string "bypass:" or "set env var" or similar.
      expect(msg).not.toMatch(/\bbypass\s*[:=]/i);
      expect(msg).not.toMatch(/\bset\s+env\b/i);
      // Must reference the spec for the escape hatch.
      expect(msg).toContain('DESTRUCTIVE-TOOL-TARGET-GUARDS-SPEC.md');
    }
  });
});
