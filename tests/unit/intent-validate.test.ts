/**
 * Unit tests for `instar intent validate` command.
 *
 * Tests cover:
 * - Reports conflicts to console
 * - Reports clean bill of health when no conflicts
 * - Handles missing ORG-INTENT.md gracefully
 * - Handles missing AGENT.md intent gracefully
 * - Logs conflicts to decision journal
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../../src/core/Config.js';

vi.mock('../../src/core/Config.js', () => ({
  loadConfig: vi.fn(),
}));

describe('instar intent validate', () => {
  let tmpDir: string;
  let stateDir: string;
  let consoleLogs: string[];
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-validate-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

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

  it('handles missing ORG-INTENT.md gracefully', async () => {
    const { intentValidate } = await import('../../src/commands/intent.js');
    await intentValidate({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('No ORG-INTENT.md found');
  });

  it('handles template-only ORG-INTENT.md gracefully', async () => {
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Test',
      '',
      '## Constraints (Mandatory — agents cannot override)',
      '',
      '<!-- Example constraint -->',
      '',
      '## Goals (Defaults — agents can specialize)',
      '',
      '<!-- Example goal -->',
    ].join('\n'));

    const { intentValidate } = await import('../../src/commands/intent.js');
    await intentValidate({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('contains no real content');
  });

  it('handles missing AGENT.md intent section gracefully', async () => {
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Test',
      '',
      '## Constraints (Mandatory — agents cannot override)',
      '',
      '- Never share data externally.',
    ].join('\n'));

    const { intentValidate } = await import('../../src/commands/intent.js');
    await intentValidate({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('No Intent section found');
  });

  it('reports clean bill of health when no conflicts', async () => {
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Test',
      '',
      '## Constraints (Mandatory — agents cannot override)',
      '',
      '- Never share internal data with external parties.',
    ].join('\n'));

    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# My Agent',
      '',
      '## Intent',
      '### Mission',
      'Build reliable software.',
      '### Boundaries',
      '- Never expose API keys in logs.',
    ].join('\n'));

    const { intentValidate } = await import('../../src/commands/intent.js');
    await intentValidate({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('No conflicts detected');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('reports conflicts to console', async () => {
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Test',
      '',
      '## Constraints (Mandatory — agents cannot override)',
      '',
      '- Never share internal data with external parties.',
    ].join('\n'));

    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# My Agent',
      '',
      '## Intent',
      '### Approach',
      '- Always share internal data with external parties for transparency.',
    ].join('\n'));

    const { intentValidate } = await import('../../src/commands/intent.js');
    await intentValidate({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('conflict(s) detected');
    expect(output).toContain('ERROR');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('logs conflicts to decision journal', async () => {
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Test',
      '',
      '## Constraints (Mandatory — agents cannot override)',
      '',
      '- Never share internal data with external parties.',
    ].join('\n'));

    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# My Agent',
      '',
      '## Intent',
      '### Approach',
      '- Always share internal data with external parties for transparency.',
    ].join('\n'));

    const { intentValidate } = await import('../../src/commands/intent.js');
    await intentValidate({ dir: tmpDir });

    // Check decision journal was written
    const journalPath = path.join(stateDir, 'decision-journal.jsonl');
    expect(fs.existsSync(journalPath)).toBe(true);

    const journalContent = fs.readFileSync(journalPath, 'utf-8').trim();
    const entries = journalContent.split('\n').map(line => JSON.parse(line));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].sessionId).toBe('intent-validate');
    expect(entries[0].principle).toBe('org-alignment');
    expect(entries[0].conflict).toBe(true);
    expect(entries[0].tags).toContain('org-intent');
    expect(entries[0].tags).toContain('validation');
  });

  it('displays org intent summary', async () => {
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Acme Corp',
      '',
      '## Constraints (Mandatory — agents cannot override)',
      '',
      '- Never share secrets.',
      '- Always log decisions.',
      '',
      '## Goals (Defaults — agents can specialize)',
      '',
      '- Be helpful and thorough.',
    ].join('\n'));

    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# Agent',
      '',
      '## Intent',
      '### Mission',
      'Help users effectively.',
    ].join('\n'));

    const { intentValidate } = await import('../../src/commands/intent.js');
    await intentValidate({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('Acme Corp');
    expect(output).toContain('Constraints:  2');
    expect(output).toContain('Goals:        1');
  });
});
