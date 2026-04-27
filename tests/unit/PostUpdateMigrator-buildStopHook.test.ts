/**
 * Verifies the PostUpdateMigrator installs build-stop-hook.sh on every run
 * and that validateHookReferences flags missing files.
 *
 * Regression: on 2026-04-19 an echo session running /build emitted six
 * "Stop hook error: bash: .instar/hooks/instar/build-stop-hook.sh:
 * No such file or directory" messages during a single 18-minute stall.
 *
 * Root cause: init.ts copied the hook once, conditionally on absence,
 * using a path resolved from the package source tree. Agents initialized
 * before that block was added never received the file, and the upgrade
 * migrator did not re-deploy it. settings.json still referenced the
 * file, so every Stop event failed silently (non-blocking status).
 *
 * Fix: move the hook to the canonical PostUpdateMigrator.migrateHooks
 * pattern — unconditional overwrite on every upgrade, shared content
 * with init.ts via getHookContent('build-stop-hook').
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runMigrateHooks(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateHooks(r: MigrationResult): void }).migrateHooks(result);
  return result;
}

describe('PostUpdateMigrator — build-stop-hook.sh deployment', () => {
  let projectDir: string;
  let hooksDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-build-stop-hook-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    hooksDir = path.join(projectDir, '.instar', 'hooks', 'instar');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('installs build-stop-hook.sh when it is missing', () => {
    const migrator = newMigrator(projectDir);

    const dst = path.join(hooksDir, 'build-stop-hook.sh');
    expect(fs.existsSync(dst)).toBe(false);

    const result = runMigrateHooks(migrator);

    expect(fs.existsSync(dst)).toBe(true);
    const contents = fs.readFileSync(dst, 'utf8');
    expect(contents).toContain('#!/bin/bash');
    expect(contents).toContain('Build Stop Hook');
    expect(contents).toContain('build-state.json');
    expect((fs.statSync(dst).mode & 0o111)).not.toBe(0);
    expect(result.upgraded.some(u => u.includes('build-stop-hook.sh'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('overwrites existing build-stop-hook.sh (idempotent upgrade)', () => {
    fs.mkdirSync(hooksDir, { recursive: true });
    const dst = path.join(hooksDir, 'build-stop-hook.sh');
    fs.writeFileSync(dst, '#!/bin/bash\n# stale content\n');

    const migrator = newMigrator(projectDir);
    const result = runMigrateHooks(migrator);

    expect(result.errors).toEqual([]);
    const contents = fs.readFileSync(dst, 'utf8');
    expect(contents).toContain('Build Stop Hook');
    expect(contents).not.toContain('stale content');
  });

  it('getHookContent("build-stop-hook") matches file written to disk', () => {
    const migrator = newMigrator(projectDir);
    runMigrateHooks(migrator);

    const inline = migrator.getHookContent('build-stop-hook');
    const onDisk = fs.readFileSync(path.join(hooksDir, 'build-stop-hook.sh'), 'utf8');
    expect(onDisk).toBe(inline);
    expect(inline).toContain('#!/bin/bash');
  });
});

describe('PostUpdateMigrator — validateHookReferences', () => {
  let projectDir: string;
  let settingsPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-validate-hooks-'));
    fs.mkdirSync(path.join(projectDir, '.instar', 'hooks', 'instar'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    settingsPath = path.join(projectDir, '.claude', 'settings.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  function validate(): MigrationResult {
    const migrator = newMigrator(projectDir);
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    migrator.validateHookReferences(path.join(projectDir, '.instar', 'hooks'), result);
    return result;
  }

  it('flags settings.json hook references that do not exist on disk', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'bash .instar/hooks/instar/build-stop-hook.sh', timeout: 10000 }] },
        ],
      },
    }));

    const result = validate();
    expect(result.errors.some(e => e.includes('build-stop-hook.sh'))).toBe(true);
    expect(result.errors.some(e => e.includes('Stop'))).toBe(true);
  });

  it('passes when every referenced hook exists', () => {
    const hookFile = path.join(projectDir, '.instar', 'hooks', 'instar', 'build-stop-hook.sh');
    fs.writeFileSync(hookFile, '#!/bin/bash\nexit 0\n');

    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'bash .instar/hooks/instar/build-stop-hook.sh', timeout: 10000 }] },
        ],
      },
    }));

    const result = validate();
    expect(result.errors).toEqual([]);
  });

  it('ignores hooks outside the .instar/hooks/instar/ tree (custom hooks)', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'bash .instar/hooks/custom/my-hook.sh', timeout: 10000 }] },
          { matcher: '', hooks: [{ type: 'command', command: '/usr/local/bin/unrelated', timeout: 10000 }] },
        ],
      },
    }));

    const result = validate();
    expect(result.errors).toEqual([]);
  });

  it('is a no-op when settings.json does not exist', () => {
    const result = validate();
    expect(result.errors).toEqual([]);
  });
});
