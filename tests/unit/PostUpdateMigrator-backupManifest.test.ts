/**
 * Unit tests for PostUpdateMigrator.migrateBackupManifest (Phase A commit 5).
 *
 * Covers: fresh config with no backup key (creates with pr-gate entries),
 * existing user entries preserved (set-union), full idempotency (no-op
 * re-run), atomic write (temp-file present only transiently), missing
 * config.json (graceful skip), secrets-path warning, malformed backup
 * key tolerated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

interface MigrationResult {
  upgraded: string[];
  errors: string[];
  skipped: string[];
}

const PR_GATE_ENTRIES = [
  '.instar/state/pr-pipeline.jsonl*',
  '.instar/state/pr-gate/phase-a-sha.json',
  '.instar/state/pr-debounce.jsonl',
  '.instar/state/pr-debounce-archive.jsonl',
  '.instar/state/pr-cost-ledger.jsonl',
  '.instar/state/security.jsonl*',
];

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-backup-manifest-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

function buildMigrator(projectDir: string) {
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const migrator = new PostUpdateMigrator({
    projectDir,
    stateDir,
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
  const run = (migrator as unknown as {
    migrateBackupManifest: (result: MigrationResult) => void;
  }).migrateBackupManifest.bind(migrator);
  return { stateDir, run };
}

describe('PostUpdateMigrator.migrateBackupManifest', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir();
  });

  afterEach(() => cleanup(projectDir));

  it('skips gracefully when config.json does not exist', () => {
    const { run } = buildMigrator(projectDir);
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);
    expect(result.errors).toEqual([]);
    expect(result.skipped.some((s) => s.includes('config.json not found'))).toBe(true);
  });

  it('adds all pr-gate entries to a config with no backup key', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    const configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'test', port: 4042 }, null, 2));

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.backup).toBeDefined();
    expect(config.backup.includeFiles).toEqual(PR_GATE_ENTRIES);
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((m) => m.includes('pr-gate state path'))).toBe(true);
  });

  it('preserves pre-existing user entries via set-union', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    const configPath = path.join(stateDir, 'config.json');
    const userEntries = ['.instar/custom-state.json', '.instar/other/thing.jsonl'];
    fs.writeFileSync(configPath, JSON.stringify({
      projectName: 'test',
      backup: { includeFiles: userEntries },
    }, null, 2));

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    for (const e of userEntries) expect(config.backup.includeFiles).toContain(e);
    for (const e of PR_GATE_ENTRIES) expect(config.backup.includeFiles).toContain(e);
    expect(config.backup.includeFiles).toHaveLength(userEntries.length + PR_GATE_ENTRIES.length);
  });

  it('dedupes when pr-gate entries already exist (idempotent re-run)', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    const configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'test' }, null, 2));

    const first: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(first);
    expect(first.upgraded.length).toBeGreaterThan(0);

    const second: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(second);
    expect(second.upgraded).toEqual([]);
    expect(second.skipped.some((s) => s.includes('already up to date'))).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    for (const e of PR_GATE_ENTRIES) {
      const count = config.backup.includeFiles.filter((x: string) => x === e).length;
      expect(count).toBe(1);
    }
  });

  it('flags a secrets-path entry as a warning but does not halt migration', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    const configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      projectName: 'test',
      backup: { includeFiles: ['.instar/secrets/pr-gate/tokens.json'] },
    }, null, 2));

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    expect(result.errors.some((e) => e.includes('secrets-prefix entry'))).toBe(true);
    // Migration still proceeds — the pr-gate entries are added
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    for (const e of PR_GATE_ENTRIES) expect(config.backup.includeFiles).toContain(e);
  });

  it('tolerates malformed backup.includeFiles (non-string entries filtered out)', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    const configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      projectName: 'test',
      backup: { includeFiles: ['.instar/valid.json', 123, null, { x: 'y' }, '.instar/also-valid.json'] },
    }, null, 2));

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.backup.includeFiles).toContain('.instar/valid.json');
    expect(config.backup.includeFiles).toContain('.instar/also-valid.json');
    for (const e of PR_GATE_ENTRIES) expect(config.backup.includeFiles).toContain(e);
    // Non-string entries dropped
    expect(config.backup.includeFiles.every((x: unknown) => typeof x === 'string')).toBe(true);
  });

  it('treats non-array backup.includeFiles as empty (gracefully recovers)', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    const configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      projectName: 'test',
      backup: { includeFiles: 'not-an-array' },
    }, null, 2));

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(Array.isArray(config.backup.includeFiles)).toBe(true);
    for (const e of PR_GATE_ENTRIES) expect(config.backup.includeFiles).toContain(e);
  });

  it('leaves no .tmp file behind on success (atomic rename completes)', () => {
    const { stateDir, run } = buildMigrator(projectDir);
    const configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'test' }, null, 2));

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    run(result);

    const leftoverTmps = fs.readdirSync(stateDir).filter((f) => f.includes('.migrate-backup-'));
    expect(leftoverTmps).toEqual([]);
  });
});
