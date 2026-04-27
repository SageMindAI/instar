// safe-git-allow: this is the test file for SafeGitExecutor; direct git+fs usage is for fixture setup only.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SafeGitExecutor,
  SafeGitExecutorError,
  DESTRUCTIVE_GIT_VERBS,
  READONLY_GIT_VERBS,
  _internal,
} from '../../src/core/SafeGitExecutor.js';
import { SourceTreeGuardError } from '../../src/core/SourceTreeGuard.js';

// ── fixture helpers ───────────────────────────────────────────────

function mkSandbox(prefix = 'sge-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(dir);
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function initRepo(dir: string): void {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'seed'), 'seed');
  execFileSync('git', ['add', 'seed'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: dir, stdio: 'ignore' });
}

function makeFakeInstarSource(): string {
  // A sandbox with the marker file → assertNotInstarSourceTree returns true (layer a).
  const dir = mkSandbox('sge-fake-instar-');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, '.instar-source-tree'), 'marker');
  return dir;
}

// Disable real audit log writes during tests; use a tmp dir.
let auditDir: string;
beforeAll(() => {
  auditDir = mkSandbox('sge-audit-');
  process.env.INSTAR_AUDIT_LOG_DIR = auditDir;
});
afterAll(() => {
  delete process.env.INSTAR_AUDIT_LOG_DIR;
  rmrf(auditDir);
});

// ── execSync ──────────────────────────────────────────────────────

describe('SafeGitExecutor.execSync — source-tree guard', () => {
  let fakeInstar: string;
  let benignSandbox: string;
  beforeEach(() => {
    fakeInstar = makeFakeInstarSource();
    benignSandbox = mkSandbox();
    initRepo(benignSandbox);
  });
  afterEach(() => {
    rmrf(fakeInstar);
    rmrf(benignSandbox);
  });

  it('throws SourceTreeGuardError when cwd is the instar source', () => {
    expect(() =>
      SafeGitExecutor.execSync(['add', '-A'], { cwd: fakeInstar, operation: 'test' }),
    ).toThrow(SourceTreeGuardError);
  });

  it('succeeds when cwd is a benign tmpdir', () => {
    fs.writeFileSync(path.join(benignSandbox, 'newfile'), 'x');
    expect(() =>
      SafeGitExecutor.execSync(['add', '-A'], { cwd: benignSandbox, operation: 'test' }),
    ).not.toThrow();
  });

  it('blocks bypass via -C <instar source> while opts.cwd is benign', () => {
    expect(() =>
      SafeGitExecutor.execSync(['-C', fakeInstar, 'add', '-A'], {
        cwd: benignSandbox,
        operation: 'test-bypass',
      }),
    ).toThrow(SourceTreeGuardError);
  });

  it('blocks bypass when opts.cwd is the instar source even with -C tmpdir', () => {
    expect(() =>
      SafeGitExecutor.execSync(['-C', benignSandbox, 'add', '-A'], {
        cwd: fakeInstar,
        operation: 'test-bypass-2',
      }),
    ).toThrow(SourceTreeGuardError);
  });

  it('blocks bypass via --git-dir=<instar>/.git', () => {
    const gitDir = path.join(fakeInstar, '.git');
    expect(() =>
      SafeGitExecutor.execSync([`--git-dir=${gitDir}`, 'add', '-A'], {
        cwd: benignSandbox,
        operation: 'test-git-dir-bypass',
      }),
    ).toThrow(SourceTreeGuardError);
  });

  it('blocks bypass via --work-tree=<instar>', () => {
    expect(() =>
      SafeGitExecutor.execSync([`--work-tree=${fakeInstar}`, 'add', '-A'], {
        cwd: benignSandbox,
        operation: 'test-work-tree-bypass',
      }),
    ).toThrow(SourceTreeGuardError);
  });

  it('blocks bypass via symlink to the instar source', () => {
    const linkParent = mkSandbox();
    const link = path.join(linkParent, 'shadow');
    fs.symlinkSync(fakeInstar, link);
    try {
      expect(() =>
        SafeGitExecutor.execSync(['-C', link, 'add', '-A'], {
          cwd: benignSandbox,
          operation: 'test-symlink-bypass',
        }),
      ).toThrow(SourceTreeGuardError);
    } finally {
      rmrf(linkParent);
    }
  });

  it('throws on read-only verb (typo / wrong-method protection)', () => {
    expect(() =>
      SafeGitExecutor.execSync(['status'], { cwd: benignSandbox, operation: 'wrong-method' }),
    ).toThrow(SafeGitExecutorError);
  });

  it('throws on ambiguous verb in read-only shape', () => {
    expect(() =>
      SafeGitExecutor.execSync(['branch', '--list'], {
        cwd: benignSandbox,
        operation: 'wrong-method-2',
      }),
    ).toThrow(SafeGitExecutorError);
  });

  it('accepts ambiguous verb in destructive shape (branch <name>)', () => {
    expect(() =>
      SafeGitExecutor.execSync(['branch', 'newbranch'], {
        cwd: benignSandbox,
        operation: 'create-branch',
      }),
    ).not.toThrow();
  });
});

// ── env handling ──────────────────────────────────────────────────

describe('SafeGitExecutor — env denylist', () => {
  it('strips GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / etc from caller env', () => {
    const sanitized = _internal.sanitizeEnv({
      GIT_DIR: '/evil',
      GIT_WORK_TREE: '/evil',
      GIT_INDEX_FILE: '/evil',
      GIT_OBJECT_DIRECTORY: '/evil',
      GIT_CONFIG_PARAMETERS: 'evil',
      GIT_CEILING_DIRECTORIES: '/',
      GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
      GIT_NAMESPACE: 'evil',
      GIT_COMMON_DIR: '/evil',
      GIT_CONFIG_KEY_0: 'core.editor',
      GIT_CONFIG_VALUE_0: 'rm -rf /',
      GIT_CONFIG_COUNT: '1',
      KEEP_ME: 'safe',
    });
    expect(sanitized.GIT_DIR).toBeUndefined();
    expect(sanitized.GIT_WORK_TREE).toBeUndefined();
    expect(sanitized.GIT_INDEX_FILE).toBeUndefined();
    expect(sanitized.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(sanitized.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(sanitized.GIT_CEILING_DIRECTORIES).toBeUndefined();
    expect(sanitized.GIT_DISCOVERY_ACROSS_FILESYSTEM).toBeUndefined();
    expect(sanitized.GIT_NAMESPACE).toBeUndefined();
    expect(sanitized.GIT_COMMON_DIR).toBeUndefined();
    expect(sanitized.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(sanitized.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(sanitized.GIT_CONFIG_COUNT).toBeUndefined();
    expect(sanitized.KEEP_ME).toBe('safe');
  });

  it('injects GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_SYSTEM=/dev/null + GIT_CONFIG_NOSYSTEM=1', () => {
    const sanitized = _internal.sanitizeEnv({});
    expect(sanitized.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(sanitized.GIT_CONFIG_SYSTEM).toBe('/dev/null');
    expect(sanitized.GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  it('the injected GIT_CONFIG_GLOBAL beats caller-supplied values', () => {
    const sanitized = _internal.sanitizeEnv({
      GIT_CONFIG_GLOBAL: '/tmp/evil',
      GIT_CONFIG_SYSTEM: '/tmp/evil',
    });
    expect(sanitized.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(sanitized.GIT_CONFIG_SYSTEM).toBe('/dev/null');
  });
});

// ── readSync ──────────────────────────────────────────────────────

describe('SafeGitExecutor.readSync', () => {
  let benignSandbox: string;
  let fakeInstar: string;
  beforeEach(() => {
    benignSandbox = mkSandbox();
    initRepo(benignSandbox);
    fakeInstar = makeFakeInstarSource();
  });
  afterEach(() => {
    rmrf(benignSandbox);
    rmrf(fakeInstar);
  });

  it('runs read-only verb successfully against benign cwd', () => {
    const out = SafeGitExecutor.readSync(['status', '--porcelain'], {
      cwd: benignSandbox,
      operation: 'test-status',
    });
    expect(typeof out).toBe('string');
  });

  it('throws on destructive verb in args[0]', () => {
    expect(() =>
      SafeGitExecutor.readSync(['add', '-A'], {
        cwd: benignSandbox,
        operation: 'misuse',
      }),
    ).toThrow(SafeGitExecutorError);
  });

  it('throws on ambiguous verb in destructive shape (branch <name>)', () => {
    expect(() =>
      SafeGitExecutor.readSync(['branch', 'newbranch'], {
        cwd: benignSandbox,
        operation: 'misuse',
      }),
    ).toThrow(SafeGitExecutorError);
  });

  it('accepts ambiguous verb in read-only shape (branch --list)', () => {
    expect(() =>
      SafeGitExecutor.readSync(['branch', '--list'], {
        cwd: benignSandbox,
        operation: 'list',
      }),
    ).not.toThrow();
  });

  it('extracts verb from -C <dir> form (args[1])', () => {
    expect(() =>
      SafeGitExecutor.readSync(['-C', benignSandbox, 'status', '--porcelain'], {
        cwd: benignSandbox,
        operation: 'with-C',
      }),
    ).not.toThrow();
  });

  it('blocks read against the instar source tree (defense-in-depth)', () => {
    expect(() =>
      SafeGitExecutor.readSync(['status', '--porcelain'], {
        cwd: fakeInstar,
        operation: 'read-blocked',
      }),
    ).toThrow(SourceTreeGuardError);
  });
});

// ── verb sets ─────────────────────────────────────────────────────

describe('verb classification sets', () => {
  it('DESTRUCTIVE_GIT_VERBS and READONLY_GIT_VERBS overlap only on shape-checked verbs', () => {
    const overlap = [...DESTRUCTIVE_GIT_VERBS].filter((v) => READONLY_GIT_VERBS.has(v));
    // Allowed overlap: ambiguous verbs that are shape-checked at runtime.
    expect(overlap.sort()).toEqual(
      ['branch', 'config', 'format-patch', 'remote', 'stash', 'worktree'].sort(),
    );
  });
});

// ── spawn ─────────────────────────────────────────────────────────

describe('SafeGitExecutor.spawn', () => {
  let benignSandbox: string;
  let fakeInstar: string;
  beforeEach(() => {
    benignSandbox = mkSandbox();
    initRepo(benignSandbox);
    fakeInstar = makeFakeInstarSource();
  });
  afterEach(() => {
    rmrf(benignSandbox);
    rmrf(fakeInstar);
  });

  it('returns a ChildProcess and the guard fires before spawn', () => {
    expect(() =>
      SafeGitExecutor.spawn(['add', '-A'], {
        cwd: fakeInstar,
        operation: 'spawn-blocked',
      }),
    ).toThrow(SourceTreeGuardError);
  });

  it('spawn against benign cwd returns a child process', async () => {
    fs.writeFileSync(path.join(benignSandbox, 'a'), 'a');
    const child = SafeGitExecutor.spawn(['add', '-A'], {
      cwd: benignSandbox,
      operation: 'spawn-ok',
    });
    expect(child).toBeDefined();
    await new Promise((resolve) => child.on('exit', resolve));
  });
});

// ── Incident-B regression ─────────────────────────────────────────

describe('Incident-B regression', () => {
  it('a fixture invoking add -A against the instar source is blocked', () => {
    const fakeInstar = makeFakeInstarSource();
    try {
      // Simulating exactly tests/e2e/branch-lifecycle.test.ts's prior pattern:
      //   execFileSync('git', ['add', '-A'], { cwd: <instar source root> })
      // After migration, this becomes:
      //   SafeGitExecutor.execSync(['add', '-A'], { cwd: <root>, operation: '...' })
      // Either way, the guard must throw.
      expect(() =>
        SafeGitExecutor.execSync(['add', '-A'], {
          cwd: fakeInstar,
          operation: 'incident-b-regression',
        }),
      ).toThrow(SourceTreeGuardError);
    } finally {
      rmrf(fakeInstar);
    }
  });
});
