/**
 * Unit test — Init command includes external operations config.
 *
 * Verifies that `instar init` generates config.json with the
 * externalOperations section for fresh and existing project modes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../../src/commands/init.js';

describe('Init external operations config', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-init-extops-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readConfig(projectDir: string): Record<string, unknown> {
    const configPath = path.join(projectDir, '.instar', 'config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  it('fresh project includes externalOperations with collaborative defaults', async () => {
    const projectName = 'test-fresh-extops';

    await initProject({
      name: projectName,
      skipPrereqs: true,
    });

    const projectDir = path.join(tmpDir, projectName);
    const config = readConfig(projectDir);
    expect(config.externalOperations).toBeDefined();

    const extOps = config.externalOperations as Record<string, unknown>;
    expect(extOps.enabled).toBe(true);
    expect(extOps.sentinel).toEqual({ enabled: true });
    expect(extOps.services).toEqual({});
    expect(extOps.readOnlyServices).toEqual([]);

    const trust = extOps.trust as Record<string, unknown>;
    expect(trust.floor).toBe('collaborative');
    expect(trust.autoElevateEnabled).toBe(true);
    expect(trust.elevationThreshold).toBe(5);
  });

  it('existing project includes externalOperations with supervised defaults', async () => {
    // Create a minimal existing project structure
    const projectDir = path.join(tmpDir, 'existing-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');

    await initProject({
      dir: projectDir,
      skipPrereqs: true,
    });

    const config = readConfig(projectDir);
    expect(config.externalOperations).toBeDefined();

    const extOps = config.externalOperations as Record<string, unknown>;
    expect(extOps.enabled).toBe(true);

    const trust = extOps.trust as Record<string, unknown>;
    // Existing projects get supervised (conservative) defaults
    expect(trust.floor).toBe('supervised');
    expect(trust.autoElevateEnabled).toBe(false);
    expect(trust.elevationThreshold).toBe(5);
  });

  it('externalOperations config has all required fields', async () => {
    const projectName = 'test-fields-extops';

    await initProject({
      name: projectName,
      skipPrereqs: true,
    });

    const projectDir = path.join(tmpDir, projectName);
    const config = readConfig(projectDir);
    const extOps = config.externalOperations as Record<string, unknown>;

    // Verify complete structure
    expect(extOps).toHaveProperty('enabled');
    expect(extOps).toHaveProperty('sentinel');
    expect(extOps).toHaveProperty('services');
    expect(extOps).toHaveProperty('readOnlyServices');
    expect(extOps).toHaveProperty('trust');

    const trust = extOps.trust as Record<string, unknown>;
    expect(trust).toHaveProperty('floor');
    expect(trust).toHaveProperty('autoElevateEnabled');
    expect(trust).toHaveProperty('elevationThreshold');
  });
});
