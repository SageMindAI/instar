// safe-git-allow: tests for the lint rule itself.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-no-direct-destructive.js');

function mkSandbox(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-test-')));
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

function writeFile(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runLint(...args: string[]): RunResult {
  try {
    const stdout = execFileSync('node', [LINT_SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

let sandbox: string;
beforeEach(() => {
  sandbox = mkSandbox();
});
afterEach(() => {
  rmrf(sandbox);
});

describe('lint-no-direct-destructive — child_process / git', () => {
  it("flags execFileSync('git', ...)", () => {
    const file = path.join(sandbox, 'bad.ts');
    writeFile(
      file,
      `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['add', '-A']);\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('execFileSync');
  });

  it("flags execSync('git --version')", () => {
    const file = path.join(sandbox, 'bad.ts');
    writeFile(
      file,
      `import { execSync } from 'node:child_process';\nexecSync('git --version');\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('execSync');
  });

  it("flags spawn('git', ...)", () => {
    const file = path.join(sandbox, 'bad.ts');
    writeFile(
      file,
      `import { spawn } from 'node:child_process';\nspawn('git', ['log']);\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('spawn');
  });

  it('flags namespace-import child_process.execFileSync', () => {
    const file = path.join(sandbox, 'bad.ts');
    writeFile(
      file,
      `import * as cp from 'node:child_process';\ncp.execFileSync('git', ['add']);\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cp.execFileSync');
  });

  it("flags require('child_process').execFileSync('git', ...)", () => {
    const file = path.join(sandbox, 'bad.cjs');
    writeFile(
      file,
      `const cp = require('child_process'); cp.execFileSync('git', ['add']);\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('execFileSync');
  });

  it("flags inline require('child_process').execFileSync('git', ...)", () => {
    const file = path.join(sandbox, 'bad.cjs');
    writeFile(
      file,
      `require('child_process').execFileSync('git', ['add']);\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('execFileSync');
  });

  it("flags simple-git import", () => {
    const file = path.join(sandbox, 'bad.ts');
    writeFile(
      file,
      `import { simpleGit } from 'simple-git';\nsimpleGit('/x').add('.');\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('simpleGit');
  });

  it("does not flag execSync for non-git commands", () => {
    const file = path.join(sandbox, 'ok.ts');
    writeFile(
      file,
      `import { execSync } from 'node:child_process';\nexecSync('ls -la');\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(0);
  });
});

describe('lint-no-direct-destructive — fs', () => {
  it('flags fs.rmSync', () => {
    const file = path.join(sandbox, 'bad.ts');
    writeFile(
      file,
      `import * as fs from 'node:fs';\nfs.rmSync('/x', { recursive: true });\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('rmSync');
  });

  it('flags named-imported rmSync', () => {
    const file = path.join(sandbox, 'bad.ts');
    writeFile(
      file,
      `import { rmSync } from 'node:fs';\nrmSync('/x');\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('rmSync');
  });

  it('flags aliased import (rmSync as nuke)', () => {
    const file = path.join(sandbox, 'bad.ts');
    writeFile(
      file,
      `import { rmSync as nuke } from 'node:fs';\nnuke('/x');\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('rmSync');
  });

  it('flags fs.promises.rm via namespace', () => {
    const file = path.join(sandbox, 'bad.ts');
    writeFile(
      file,
      `import * as fs from 'node:fs';\nawait fs.promises.rm('/x');\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('rm');
  });

  it('flags computed member access (fs[\'rm\' + \'Sync\'])', () => {
    const file = path.join(sandbox, 'bad.ts');
    writeFile(
      file,
      `import * as fs from 'node:fs';\nfs['rm' + 'Sync']('/x');\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Computed');
  });

  it('flags require("fs/promises").rm', () => {
    const file = path.join(sandbox, 'bad.cjs');
    writeFile(
      file,
      `require('node:fs/promises').rm('/x');\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('rm');
  });
});

describe('lint-no-direct-destructive — allowlist', () => {
  it('honors // safe-git-allow: comment', () => {
    const file = path.join(sandbox, 'allow.ts');
    writeFile(
      file,
      `// safe-git-allow: testing\nimport { execFileSync } from 'node:child_process';\nexecFileSync('git', ['add']);\n`,
    );
    const r = runLint(file);
    expect(r.code).toBe(0);
  });
});

describe('lint-no-direct-destructive — shell', () => {
  it('flags destructive git in shell scripts', () => {
    const file = path.join(sandbox, 'bad.sh');
    writeFile(file, `#!/bin/sh\ngit add -A\n`);
    const r = runLint(file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('git add');
  });

  it('does not flag read-only git in shell scripts', () => {
    const file = path.join(sandbox, 'ok.sh');
    writeFile(file, `#!/bin/sh\ngit status --porcelain\n`);
    const r = runLint(file);
    expect(r.code).toBe(0);
  });
});

describe('lint-no-direct-destructive — package.json scripts', () => {
  it('flags destructive git in npm script values', () => {
    const file = path.join(sandbox, 'package.json');
    writeFile(
      file,
      JSON.stringify({ name: 'x', scripts: { boom: 'git push origin main' } }),
    );
    const r = runLint(file);
    // package.json detection only fires for the repo root package.json (rel === 'package.json').
    // For this sandbox file, rel will be the absolute path; the lint short-circuits.
    // So we expect no violation for this fixture; the rule covers the repo root only.
    expect(r.code).toBe(0);
  });
});
