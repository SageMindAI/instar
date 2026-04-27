/**
 * Unit tests for PostUpdateMigrator.migratePrPipelineArtifacts (Phase A commit 4).
 *
 * Covers: content-hash verification (catches post-publish tamper),
 * idempotency (skips when on-disk content matches), Echo-repo gating
 * for workflow YAML and setup doc, always-ship behavior for schema
 * and push-gate.sh, push-gate.sh executable bit, and graceful error
 * handling on hash mismatch.
 *
 * Also asserts self-consistency of the shipped-content hash constants
 * — the module's _SHA256 strings must match sha256(the_content).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import {
  ELIGIBILITY_SCHEMA_SQL,
  ELIGIBILITY_SCHEMA_SQL_SHA256,
  PUSH_GATE_SH,
  PUSH_GATE_SH_SHA256,
  INSTAR_PR_GATE_WORKFLOW_YML,
  INSTAR_PR_GATE_WORKFLOW_YML_SHA256,
  PR_GATE_SETUP_MD,
  PR_GATE_SETUP_MD_SHA256,
} from '../../src/data/pr-gate-artifacts.js';

interface MigrationResult {
  upgraded: string[];
  errors: string[];
  skipped: string[];
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-prgate-artifacts-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

function initGitRepo(dir: string, originUrl: string | null): void {
  // safe-git-allow: incremental-migration
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  if (originUrl) {
    // safe-git-allow: incremental-migration
    execSync(`git remote add origin ${originUrl}`, { cwd: dir, stdio: 'ignore' });
  }
}

function writePackageJson(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }) + '\n');
}

describe('pr-gate-artifacts module self-consistency', () => {
  it('ELIGIBILITY_SCHEMA_SQL hash matches content', () => {
    const actual = crypto.createHash('sha256').update(ELIGIBILITY_SCHEMA_SQL).digest('hex');
    expect(actual).toBe(ELIGIBILITY_SCHEMA_SQL_SHA256);
  });

  it('PUSH_GATE_SH hash matches content', () => {
    const actual = crypto.createHash('sha256').update(PUSH_GATE_SH).digest('hex');
    expect(actual).toBe(PUSH_GATE_SH_SHA256);
  });

  it('INSTAR_PR_GATE_WORKFLOW_YML hash matches content', () => {
    const actual = crypto.createHash('sha256').update(INSTAR_PR_GATE_WORKFLOW_YML).digest('hex');
    expect(actual).toBe(INSTAR_PR_GATE_WORKFLOW_YML_SHA256);
  });

  it('PR_GATE_SETUP_MD hash matches content', () => {
    const actual = crypto.createHash('sha256').update(PR_GATE_SETUP_MD).digest('hex');
    expect(actual).toBe(PR_GATE_SETUP_MD_SHA256);
  });
});

describe('PostUpdateMigrator.migratePrPipelineArtifacts — non-instar agent', () => {
  let projectDir: string;
  let migrator: PostUpdateMigrator;
  let run: (result: MigrationResult) => void;

  beforeEach(() => {
    projectDir = createTempDir();
    initGitRepo(projectDir, 'https://github.com/some-other-user/some-project.git');
    writePackageJson(projectDir, 'some-project');
    migrator = new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
    run = (migrator as unknown as {
      migratePrPipelineArtifacts: typeof run;
    }).migratePrPipelineArtifacts.bind(migrator);
  });

  afterEach(() => cleanup(projectDir));

  it('writes the schema and push-gate.sh (always shipped)', () => {
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    const schemaPath = path.join(projectDir, 'scripts', 'pr-gate', 'eligibility-schema.sql');
    const pushGatePath = path.join(projectDir, '.claude', 'skills', 'fork-and-fix', 'scripts', 'push-gate.sh');

    expect(fs.existsSync(schemaPath)).toBe(true);
    expect(fs.readFileSync(schemaPath, 'utf-8')).toBe(ELIGIBILITY_SCHEMA_SQL);
    expect(fs.existsSync(pushGatePath)).toBe(true);
    expect(fs.readFileSync(pushGatePath, 'utf-8')).toBe(PUSH_GATE_SH);

    // Executable bit
    const mode = fs.statSync(pushGatePath).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);

    expect(result.errors).toEqual([]);
  });

  it('does NOT write the workflow or setup doc for non-instar repos', () => {
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    const workflowPath = path.join(projectDir, '.github', 'workflows', 'instar-pr-gate.yml');
    const setupPath = path.join(projectDir, 'docs', 'pr-gate-setup.md');

    expect(fs.existsSync(workflowPath)).toBe(false);
    expect(fs.existsSync(setupPath)).toBe(false);
  });
});

describe('PostUpdateMigrator.migratePrPipelineArtifacts — instar source repo', () => {
  let projectDir: string;
  let migrator: PostUpdateMigrator;
  let run: (result: MigrationResult) => void;

  beforeEach(() => {
    projectDir = createTempDir();
    initGitRepo(projectDir, 'https://github.com/JKHeadley/instar.git');
    writePackageJson(projectDir, 'instar');
    migrator = new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
    run = (migrator as unknown as {
      migratePrPipelineArtifacts: typeof run;
    }).migratePrPipelineArtifacts.bind(migrator);
  });

  afterEach(() => cleanup(projectDir));

  it('writes all four shipped files on fresh run', () => {
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    const files = [
      ['scripts/pr-gate/eligibility-schema.sql', ELIGIBILITY_SCHEMA_SQL],
      ['.claude/skills/fork-and-fix/scripts/push-gate.sh', PUSH_GATE_SH],
      ['.github/workflows/instar-pr-gate.yml', INSTAR_PR_GATE_WORKFLOW_YML],
      ['docs/pr-gate-setup.md', PR_GATE_SETUP_MD],
    ] as const;

    for (const [rel, content] of files) {
      const p = path.join(projectDir, rel);
      expect(fs.existsSync(p), `${rel} should exist`).toBe(true);
      expect(fs.readFileSync(p, 'utf-8')).toBe(content);
    }
    expect(result.errors).toEqual([]);
  });

  it('is idempotent — re-run skips files whose content already matches', () => {
    const first: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(first);
    expect(first.upgraded.length).toBeGreaterThan(0);

    const second: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(second);
    expect(second.upgraded).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
    expect(second.errors).toEqual([]);
  });

  it('rewrites files whose on-disk content drifted from shipped', () => {
    const schemaPath = path.join(projectDir, 'scripts', 'pr-gate', 'eligibility-schema.sql');
    fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
    fs.writeFileSync(schemaPath, '-- user-mangled content\n');

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    expect(fs.readFileSync(schemaPath, 'utf-8')).toBe(ELIGIBILITY_SCHEMA_SQL);
    expect(result.upgraded.some((m) => m.includes('eligibility-schema.sql'))).toBe(true);
  });

  it('accepts upstream remote when origin is a fork', () => {
    const forkDir = createTempDir();
    initGitRepo(forkDir, 'https://github.com/someone-forked/instar.git');
    // safe-git-allow: incremental-migration
    execSync('git remote add upstream https://github.com/JKHeadley/instar.git', {
      cwd: forkDir, stdio: 'ignore',
    });
    writePackageJson(forkDir, 'instar');

    const forkMigrator = new PostUpdateMigrator({
      projectDir: forkDir,
      stateDir: path.join(forkDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
    const forkRun = (forkMigrator as unknown as {
      migratePrPipelineArtifacts: typeof run;
    }).migratePrPipelineArtifacts.bind(forkMigrator);

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    forkRun(result);

    expect(fs.existsSync(path.join(forkDir, '.github', 'workflows', 'instar-pr-gate.yml'))).toBe(true);
    cleanup(forkDir);
  });
});

describe('PostUpdateMigrator.migratePrPipelineArtifacts — package-name gate', () => {
  it('rejects JKHeadley/instar remote when package.json.name is not "instar"', () => {
    const dir = createTempDir();
    initGitRepo(dir, 'https://github.com/JKHeadley/instar.git');
    writePackageJson(dir, 'fork-renamed-project');  // remote says instar, package says otherwise

    const migrator = new PostUpdateMigrator({
      projectDir: dir,
      stateDir: path.join(dir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
    const run = (migrator as unknown as {
      migratePrPipelineArtifacts: (result: MigrationResult) => void;
    }).migratePrPipelineArtifacts.bind(migrator);

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    expect(fs.existsSync(path.join(dir, '.github', 'workflows', 'instar-pr-gate.yml'))).toBe(false);
    cleanup(dir);
  });

  it('rejects when package.json is missing', () => {
    const dir = createTempDir();
    initGitRepo(dir, 'https://github.com/JKHeadley/instar.git');
    // no package.json

    const migrator = new PostUpdateMigrator({
      projectDir: dir,
      stateDir: path.join(dir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
    const run = (migrator as unknown as {
      migratePrPipelineArtifacts: (result: MigrationResult) => void;
    }).migratePrPipelineArtifacts.bind(migrator);

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    expect(fs.existsSync(path.join(dir, '.github', 'workflows', 'instar-pr-gate.yml'))).toBe(false);
    cleanup(dir);
  });
});

describe('PostUpdateMigrator.writeShippedArtifact — hash verification', () => {
  let projectDir: string;
  let migrator: PostUpdateMigrator;
  let write: (opts: {
    destPath: string;
    content: string;
    expectedSha256: string;
    label: string;
    mode?: number;
    result: MigrationResult;
  }) => void;

  beforeEach(() => {
    projectDir = createTempDir();
    migrator = new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
    write = (migrator as unknown as { writeShippedArtifact: typeof write }).writeShippedArtifact.bind(migrator);
  });

  afterEach(() => cleanup(projectDir));

  it('refuses to write when sha256(content) !== expectedSha256', () => {
    const destPath = path.join(projectDir, 'test-artifact.txt');
    const content = 'hello world';
    const wrongHash = 'deadbeef'.repeat(8);

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    write({ destPath, content, expectedSha256: wrongHash, label: 'test', result });

    expect(fs.existsSync(destPath)).toBe(false);
    expect(result.upgraded).toEqual([]);
    expect(result.errors.some((m) => m.includes('hash mismatch'))).toBe(true);
  });

  it('writes when hash matches', () => {
    const destPath = path.join(projectDir, 'test-artifact.txt');
    const content = 'hello world';
    const rightHash = crypto.createHash('sha256').update(content).digest('hex');

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    write({ destPath, content, expectedSha256: rightHash, label: 'test', result });

    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(destPath, 'utf-8')).toBe(content);
    expect(result.upgraded).toContain('test');
    expect(result.errors).toEqual([]);
  });
});
