/**
 * Verifies migrateSkillPortHardcoding rewrites hardcoded localhost:NNNN
 * URLs in known-default skills to a runtime-expandable
 * ${INSTAR_PORT:-NNNN} pattern.
 *
 * Regression: before this migration, installBuiltinSkills templated the
 * port at install time. Users who later changed their server port still
 * had stale URLs in their skills, producing silent ECONNREFUSED on every
 * curl call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function runMigration(projectDir: string, port: number): MigrationResult {
  const migrator = new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port,
    hasTelegram: false,
    projectName: 'test',
  });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateSkillPortHardcoding(r: MigrationResult): void })
    .migrateSkillPortHardcoding(result);
  return result;
}

function writeSkill(projectDir: string, name: string, body: string): string {
  const dir = path.join(projectDir, '.claude', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, body);
  return file;
}

describe('PostUpdateMigrator — skill port hardcoding migration', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-skill-port-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('rewrites hardcoded ports in a default skill', () => {
    const skillFile = writeSkill(
      projectDir,
      'evolve',
      '# evolve\ncurl http://localhost:4041/evolution/proposals\ncurl http://localhost:4041/health\n',
    );

    const result = runMigration(projectDir, 4041);

    expect(result.errors).toEqual([]);
    expect(result.upgraded.length).toBe(1);

    const after = fs.readFileSync(skillFile, 'utf8');
    expect(after).toContain('http://localhost:${INSTAR_PORT:-4041}/evolution/proposals');
    expect(after).toContain('http://localhost:${INSTAR_PORT:-4041}/health');
    expect(after).not.toMatch(/http:\/\/localhost:4041\//);
  });

  it('leaves already-dynamic skills untouched (idempotent)', () => {
    const body = '# learn\ncurl http://localhost:${INSTAR_PORT:-4040}/evolution/learnings\n';
    const skillFile = writeSkill(projectDir, 'learn', body);

    const result = runMigration(projectDir, 4040);

    expect(result.upgraded).toEqual([]);
    expect(fs.readFileSync(skillFile, 'utf8')).toBe(body);
  });

  it('does not touch custom (non-default) skills', () => {
    const body = '# my-custom\ncurl http://localhost:4041/foo\n';
    const skillFile = writeSkill(projectDir, 'my-custom-skill', body);

    const result = runMigration(projectDir, 4041);

    expect(result.upgraded).toEqual([]);
    expect(fs.readFileSync(skillFile, 'utf8')).toBe(body);
  });

  it('is idempotent on a second run after migration', () => {
    writeSkill(projectDir, 'gaps', '# gaps\ncurl http://localhost:4041/evolution/gaps\n');

    const first = runMigration(projectDir, 4041);
    expect(first.upgraded.length).toBe(1);

    const second = runMigration(projectDir, 4041);
    expect(second.upgraded).toEqual([]);
  });

  it('skips when the skill file does not exist', () => {
    const result = runMigration(projectDir, 4041);
    expect(result.errors).toEqual([]);
    expect(result.upgraded).toEqual([]);
  });

  it('preserves the original port number in the fallback', () => {
    // User's skill was templated with 4040 but their server now runs on 4041.
    // The migration keeps 4040 as the default — the ${INSTAR_PORT:-4040}
    // expansion lets the user override via env without losing the old default.
    const skillFile = writeSkill(
      projectDir,
      'reflect',
      '# reflect\ncurl http://localhost:4040/reflection/record\n',
    );

    runMigration(projectDir, 4041);

    const after = fs.readFileSync(skillFile, 'utf8');
    expect(after).toContain('http://localhost:${INSTAR_PORT:-4040}/reflection/record');
  });
});
