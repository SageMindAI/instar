/**
 * Tests for `instar migrate sync-session-hook` command (Integrated-Being v1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncSessionHook } from '../../src/commands/migrate.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-sync-test-'));
}

describe('migrate sync-session-hook', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    projectDir = tempDir();
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('writes the hook when no file exists', async () => {
    const result = await syncSessionHook({
      _configOverride: { projectDir, stateDir, port: 4042, projectName: 'x', hasTelegram: false },
    });
    expect(result.changed).toBe(true);
    const hookPath = path.join(projectDir, '.claude/hooks/instar/session-start.sh');
    expect(fs.existsSync(hookPath)).toBe(true);
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('/shared-state/render?limit=50');
    // Executable mode
    const mode = fs.statSync(hookPath).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('refuses to overwrite divergent hook without --force', async () => {
    const hookDir = path.join(projectDir, '.claude/hooks/instar');
    fs.mkdirSync(hookDir, { recursive: true });
    const hookPath = path.join(hookDir, 'session-start.sh');
    fs.writeFileSync(hookPath, '#!/bin/bash\n# divergent content');
    const result = await syncSessionHook({
      _configOverride: { projectDir, stateDir, port: 4042, projectName: 'x', hasTelegram: false },
    });
    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/divergent/);
  });

  it('overwrites divergent hook with --force', async () => {
    const hookDir = path.join(projectDir, '.claude/hooks/instar');
    fs.mkdirSync(hookDir, { recursive: true });
    const hookPath = path.join(hookDir, 'session-start.sh');
    fs.writeFileSync(hookPath, '#!/bin/bash\n# divergent content');
    const result = await syncSessionHook({
      force: true,
      _configOverride: { projectDir, stateDir, port: 4042, projectName: 'x', hasTelegram: false },
    });
    expect(result.changed).toBe(true);
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('/shared-state/render?limit=50');
  });

  it('is a no-op when hook is already up to date', async () => {
    await syncSessionHook({
      _configOverride: { projectDir, stateDir, port: 4042, projectName: 'x', hasTelegram: false },
    });
    const result = await syncSessionHook({
      _configOverride: { projectDir, stateDir, port: 4042, projectName: 'x', hasTelegram: false },
    });
    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/up to date/);
  });
});
