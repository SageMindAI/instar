/**
 * Tests for `instar migrate sync-session-hook --v2-mode={inject|overwrite}`.
 *
 * Spec: docs/specs/integrated-being-ledger-v2.md §"Interactions" /
 *       §"Divergent-hook migration policy".
 *
 * Slice 2 scope.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncSessionHook } from '../../src/commands/migrate.js';

function makeProject(): { projectDir: string; stateDir: string; hookPath: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-sync-hook-test-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const hookDir = path.join(projectDir, '.claude', 'hooks', 'instar');
  fs.mkdirSync(hookDir, { recursive: true });
  return {
    projectDir,
    stateDir,
    hookPath: path.join(hookDir, 'session-start.sh'),
  };
}

const CFG_OVERRIDE = (p: { projectDir: string; stateDir: string }) => ({
  projectDir: p.projectDir,
  stateDir: p.stateDir,
  port: 4042,
  projectName: 'test',
  hasTelegram: false,
});

describe('sync-session-hook --v2-mode=inject', () => {
  let project: ReturnType<typeof makeProject>;

  beforeEach(() => {
    project = makeProject();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(project.projectDir, { recursive: true, force: true });
  });

  it('writes the canonical template on fresh install (no existing hook)', async () => {
    const res = await syncSessionHook({
      v2Mode: 'inject',
      _configOverride: CFG_OVERRIDE(project),
    });
    expect(res.changed).toBe(true);
    const content = fs.readFileSync(project.hookPath, 'utf8');
    expect(content).toContain('# BEGIN integrated-being-v2');
    expect(content).toContain('# END integrated-being-v2');
  });

  it('injects v2 section into a custom hook preserving other content', async () => {
    const customHook = `#!/bin/bash
# My custom hook — lots of customizations
echo "[custom] startup"

# Some unrelated block
export MY_FLAG=1
`;
    fs.writeFileSync(project.hookPath, customHook, { mode: 0o755 });

    const res = await syncSessionHook({
      v2Mode: 'inject',
      _configOverride: CFG_OVERRIDE(project),
    });
    expect(res.changed).toBe(true);
    const content = fs.readFileSync(project.hookPath, 'utf8');
    // Preserves original customizations.
    expect(content).toContain('[custom] startup');
    expect(content).toContain('MY_FLAG=1');
    // Adds the v2 section.
    expect(content).toContain('# BEGIN integrated-being-v2');
    expect(content).toContain('/shared-state/session-bind');
    expect(content).toContain('# END integrated-being-v2');
  });

  it('is idempotent — re-running does not change anything if section already current', async () => {
    // First run seeds the v2 section.
    fs.writeFileSync(project.hookPath, '#!/bin/bash\necho "custom"\n', { mode: 0o755 });
    await syncSessionHook({
      v2Mode: 'inject',
      _configOverride: CFG_OVERRIDE(project),
    });
    // Second run should no-op.
    const res = await syncSessionHook({
      v2Mode: 'inject',
      _configOverride: CFG_OVERRIDE(project),
    });
    expect(res.changed).toBe(false);
    expect(res.reason).toContain('already up to date');
  });

  it('updates in place when the v2 section content has drifted', async () => {
    // Write a hook with a stale v2 section.
    const stale = `#!/bin/bash
echo "custom"

# BEGIN integrated-being-v2
# (stale v2 body from earlier release)
STALE=1
# END integrated-being-v2
`;
    fs.writeFileSync(project.hookPath, stale, { mode: 0o755 });

    const res = await syncSessionHook({
      v2Mode: 'inject',
      _configOverride: CFG_OVERRIDE(project),
    });
    expect(res.changed).toBe(true);
    const content = fs.readFileSync(project.hookPath, 'utf8');
    expect(content).not.toContain('STALE=1');
    expect(content).toContain('/shared-state/session-bind');
    expect(content).toContain('custom');
  });
});

describe('sync-session-hook --v2-mode=overwrite', () => {
  let project: ReturnType<typeof makeProject>;

  beforeEach(() => {
    project = makeProject();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(project.projectDir, { recursive: true, force: true });
  });

  it('saves a pre-v2 backup when an existing hook is present', async () => {
    fs.writeFileSync(project.hookPath, '#!/bin/bash\necho "old"\n', { mode: 0o755 });
    const res = await syncSessionHook({
      v2Mode: 'overwrite',
      _configOverride: CFG_OVERRIDE(project),
    });
    expect(res.changed).toBe(true);
    // Backup file with .pre-v2. prefix should exist.
    const hookDir = path.dirname(project.hookPath);
    const files = fs.readdirSync(hookDir);
    const backup = files.find((f) => f.includes('.pre-v2.'));
    expect(backup).toBeTruthy();
    if (backup) {
      const backupContent = fs.readFileSync(path.join(hookDir, backup), 'utf8');
      expect(backupContent).toContain('echo "old"');
    }
  });

  it('does not create a backup on fresh install', async () => {
    const res = await syncSessionHook({
      v2Mode: 'overwrite',
      _configOverride: CFG_OVERRIDE(project),
    });
    expect(res.changed).toBe(true);
    const hookDir = path.dirname(project.hookPath);
    const files = fs.readdirSync(hookDir);
    expect(files.some((f) => f.includes('.pre-v2.'))).toBe(false);
  });

  it('writes the canonical template (including v2 section)', async () => {
    await syncSessionHook({
      v2Mode: 'overwrite',
      _configOverride: CFG_OVERRIDE(project),
    });
    const content = fs.readFileSync(project.hookPath, 'utf8');
    expect(content).toContain('# BEGIN integrated-being-v2');
    expect(content).toContain('# END integrated-being-v2');
  });
});
