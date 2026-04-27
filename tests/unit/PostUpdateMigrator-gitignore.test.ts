/**
 * Unit tests for PostUpdateMigrator's gitignore helpers:
 *   - addGitignoreEntry (new in PR-REVIEW-HARDENING Phase A commit 3)
 *   - migrateGitignore (extended to add .instar/secrets/pr-gate/)
 *
 * Covers idempotency, missing-trailing-newline input, comment-safety
 * (commented-out entries don't count as present), empty-file input,
 * and file-not-exists input.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

interface MigrationResult {
  upgraded: string[];
  errors: string[];
  skipped?: string[];
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-gitignore-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('PostUpdateMigrator.addGitignoreEntry', () => {
  let projectDir: string;
  let migrator: PostUpdateMigrator;
  // Expose private helper for direct testing; the production migrateGitignore
  // tests below cover the call-site wiring.
  let addEntry: (gitignorePath: string, entry: string, result: MigrationResult, label: string) => void;

  beforeEach(() => {
    projectDir = createTempDir();
    migrator = new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
    addEntry = (migrator as unknown as {
      addGitignoreEntry: typeof addEntry;
    }).addGitignoreEntry.bind(migrator);
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  it('creates the .gitignore file if it does not exist', () => {
    const gitignore = path.join(projectDir, '.gitignore');
    expect(fs.existsSync(gitignore)).toBe(false);

    const result: MigrationResult = { upgraded: [], errors: [] };
    addEntry(gitignore, '.instar/secrets/pr-gate/', result, 'test');

    expect(fs.existsSync(gitignore)).toBe(true);
    expect(fs.readFileSync(gitignore, 'utf-8')).toBe('.instar/secrets/pr-gate/\n');
    expect(result.upgraded).toContain('test: added .instar/secrets/pr-gate/');
    expect(result.errors).toEqual([]);
  });

  it('appends to an empty file', () => {
    const gitignore = path.join(projectDir, '.gitignore');
    fs.writeFileSync(gitignore, '');

    const result: MigrationResult = { upgraded: [], errors: [] };
    addEntry(gitignore, '.instar/secrets/pr-gate/', result, 'test');

    expect(fs.readFileSync(gitignore, 'utf-8')).toBe('.instar/secrets/pr-gate/\n');
    expect(result.upgraded).toContain('test: added .instar/secrets/pr-gate/');
  });

  it('preserves existing content and ensures trailing newline before append', () => {
    const gitignore = path.join(projectDir, '.gitignore');
    // No trailing newline — helper must add one before the new entry.
    fs.writeFileSync(gitignore, 'node_modules\ndist');

    const result: MigrationResult = { upgraded: [], errors: [] };
    addEntry(gitignore, '.instar/secrets/pr-gate/', result, 'test');

    expect(fs.readFileSync(gitignore, 'utf-8')).toBe(
      'node_modules\ndist\n.instar/secrets/pr-gate/\n',
    );
  });

  it('is idempotent — re-run is a no-op and does not duplicate the entry', () => {
    const gitignore = path.join(projectDir, '.gitignore');
    fs.writeFileSync(gitignore, 'node_modules\n.instar/secrets/pr-gate/\n');

    const result: MigrationResult = { upgraded: [], errors: [] };
    addEntry(gitignore, '.instar/secrets/pr-gate/', result, 'test');
    addEntry(gitignore, '.instar/secrets/pr-gate/', result, 'test');

    const content = fs.readFileSync(gitignore, 'utf-8');
    expect(content).toBe('node_modules\n.instar/secrets/pr-gate/\n');
    const occurrences = (content.match(/\.instar\/secrets\/pr-gate\//g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(result.upgraded).toEqual([]);
  });

  it('does NOT treat a commented-out reference as present', () => {
    const gitignore = path.join(projectDir, '.gitignore');
    fs.writeFileSync(gitignore, '# .instar/secrets/pr-gate/ would block pr-gate tokens\nnode_modules\n');

    const result: MigrationResult = { upgraded: [], errors: [] };
    addEntry(gitignore, '.instar/secrets/pr-gate/', result, 'test');

    expect(fs.readFileSync(gitignore, 'utf-8')).toBe(
      '# .instar/secrets/pr-gate/ would block pr-gate tokens\nnode_modules\n.instar/secrets/pr-gate/\n',
    );
    expect(result.upgraded).toContain('test: added .instar/secrets/pr-gate/');
  });

  it('ignores blank lines during membership check', () => {
    const gitignore = path.join(projectDir, '.gitignore');
    fs.writeFileSync(gitignore, 'node_modules\n\n\n.instar/secrets/pr-gate/\n');

    const result: MigrationResult = { upgraded: [], errors: [] };
    addEntry(gitignore, '.instar/secrets/pr-gate/', result, 'test');

    expect(result.upgraded).toEqual([]);
    expect(fs.readFileSync(gitignore, 'utf-8')).toBe(
      'node_modules\n\n\n.instar/secrets/pr-gate/\n',
    );
  });
});

describe('PostUpdateMigrator.migrateGitignore — pr-gate entry', () => {
  let projectDir: string;
  let migrator: PostUpdateMigrator;
  let runMigrate: (result: MigrationResult) => void;

  beforeEach(() => {
    projectDir = createTempDir();
    migrator = new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
    runMigrate = (migrator as unknown as {
      migrateGitignore: typeof runMigrate;
    }).migrateGitignore.bind(migrator);
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  it('adds .instar/secrets/pr-gate/ to a fresh project .gitignore', () => {
    const result: MigrationResult = { upgraded: [], errors: [] };
    runMigrate(result);

    const gitignore = path.join(projectDir, '.gitignore');
    const content = fs.readFileSync(gitignore, 'utf-8');
    expect(content).toContain('.instar/secrets/pr-gate/');
    expect(result.upgraded.some((m) => m.includes('.instar/secrets/pr-gate/'))).toBe(true);
  });

  it('is idempotent on re-run', () => {
    const result1: MigrationResult = { upgraded: [], errors: [] };
    runMigrate(result1);
    const gitignore = path.join(projectDir, '.gitignore');
    const contentAfterFirst = fs.readFileSync(gitignore, 'utf-8');

    const result2: MigrationResult = { upgraded: [], errors: [] };
    runMigrate(result2);
    const contentAfterSecond = fs.readFileSync(gitignore, 'utf-8');

    expect(contentAfterSecond).toBe(contentAfterFirst);
    const occurrences = (contentAfterSecond.match(/\.instar\/secrets\/pr-gate\//g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(result2.upgraded.some((m) => m.includes('.instar/secrets/pr-gate/'))).toBe(false);
  });

  it('preserves existing entries when adding pr-gate', () => {
    const gitignore = path.join(projectDir, '.gitignore');
    fs.writeFileSync(gitignore, 'node_modules\ndist/\n*.log\n');

    const result: MigrationResult = { upgraded: [], errors: [] };
    runMigrate(result);

    const content = fs.readFileSync(gitignore, 'utf-8');
    expect(content).toContain('node_modules');
    expect(content).toContain('dist/');
    expect(content).toContain('*.log');
    expect(content).toContain('.instar/secrets/pr-gate/');
  });
});
