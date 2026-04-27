/**
 * Unit tests for `instar intent org-init` command.
 *
 * Tests cover:
 * - Creates ORG-INTENT.md with correct template
 * - Refuses to overwrite existing file
 * - Uses provided name in heading
 * - Creates file in correct directory
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../../src/core/Config.js';

vi.mock('../../src/core/Config.js', () => ({
  loadConfig: vi.fn(),
}));

describe('instar intent org-init', () => {
  let tmpDir: string;
  let stateDir: string;
  let consoleLogs: string[];
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-init-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });

    vi.mocked(loadConfig).mockReturnValue({
      projectName: 'test-project',
      projectDir: tmpDir,
      stateDir,
    } as any);

    consoleLogs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      consoleLogs.push(args.map(String).join(' '));
    });

    originalExit = process.exit;
    process.exit = vi.fn() as any;
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates ORG-INTENT.md with correct template', async () => {
    const { orgInit } = await import('../../src/commands/org.js');
    await orgInit({ dir: tmpDir });

    const orgIntentPath = path.join(stateDir, 'ORG-INTENT.md');
    expect(fs.existsSync(orgIntentPath)).toBe(true);

    const content = fs.readFileSync(orgIntentPath, 'utf-8');
    expect(content).toContain('# Organizational Intent: test-project');
    expect(content).toContain('## Constraints (Mandatory');
    expect(content).toContain('## Goals (Defaults');
    expect(content).toContain('## Values');
    expect(content).toContain('## Tradeoff Hierarchy');

    const output = consoleLogs.join('\n');
    expect(output).toContain('Created ORG-INTENT.md');
  });

  it('uses provided name in heading', async () => {
    const { orgInit } = await import('../../src/commands/org.js');
    await orgInit({ dir: tmpDir, name: 'SageMind AI' });

    const content = fs.readFileSync(path.join(stateDir, 'ORG-INTENT.md'), 'utf-8');
    expect(content).toContain('# Organizational Intent: SageMind AI');
  });

  it('refuses to overwrite existing file', async () => {
    const orgIntentPath = path.join(stateDir, 'ORG-INTENT.md');
    fs.writeFileSync(orgIntentPath, '# Existing content\n');

    const { orgInit } = await import('../../src/commands/org.js');
    await orgInit({ dir: tmpDir });

    // File should NOT be overwritten
    const content = fs.readFileSync(orgIntentPath, 'utf-8');
    expect(content).toBe('# Existing content\n');

    const output = consoleLogs.join('\n');
    expect(output).toContain('already exists');
  });

  it('creates file in correct directory', async () => {
    const { orgInit } = await import('../../src/commands/org.js');
    await orgInit({ dir: tmpDir });

    expect(fs.existsSync(path.join(stateDir, 'ORG-INTENT.md'))).toBe(true);
  });

  it('defaults name to project name when not provided', async () => {
    const { orgInit } = await import('../../src/commands/org.js');
    await orgInit({ dir: tmpDir });

    const content = fs.readFileSync(path.join(stateDir, 'ORG-INTENT.md'), 'utf-8');
    expect(content).toContain('# Organizational Intent: test-project');
  });
});
