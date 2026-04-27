/**
 * E2E tests for the full intent lifecycle.
 *
 * Exercises the complete flow:
 *   org-init -> write real content -> create agent intent ->
 *   validate -> reflect shows org constraints
 *
 * This tests the file-based state across multiple operations,
 * using the actual classes (not mocks) against a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OrgIntentManager } from '../../src/core/OrgIntentManager.js';
import { DecisionJournal } from '../../src/core/DecisionJournal.js';
import { loadConfig } from '../../src/core/Config.js';

vi.mock('../../src/core/Config.js', () => ({
  loadConfig: vi.fn(),
}));

describe('Intent Lifecycle (e2e)', () => {
  let tmpDir: string;
  let stateDir: string;
  let consoleLogs: string[];
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-lifecycle-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    vi.mocked(loadConfig).mockReturnValue({
      projectName: 'lifecycle-project',
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

  it('complete lifecycle: org-init -> write content -> validate (clean) -> reflect', async () => {
    // Step 1: Create ORG-INTENT.md via orgInit
    const { orgInit } = await import('../../src/commands/org.js');
    await orgInit({ dir: tmpDir, name: 'Lifecycle Corp' });

    const orgIntentPath = path.join(stateDir, 'ORG-INTENT.md');
    expect(fs.existsSync(orgIntentPath)).toBe(true);

    let output = consoleLogs.join('\n');
    expect(output).toContain('Created ORG-INTENT.md');

    // Step 2: Write real content into ORG-INTENT.md
    fs.writeFileSync(orgIntentPath, [
      '# Organizational Intent: Lifecycle Corp',
      '',
      '> Shared purpose for all agents.',
      '',
      '## Constraints (Mandatory — agents cannot override)',
      '',
      '- Never share internal data with external parties.',
      '- Always validate user inputs before processing.',
      '',
      '## Goals (Defaults — agents can specialize)',
      '',
      '- Prefer thoroughness over speed when quality is measurable.',
      '',
      '## Values',
      '',
      '- Be transparent about limitations.',
      '- Prioritize user safety.',
      '',
      '## Tradeoff Hierarchy',
      '',
      '- Safety > Correctness > User Experience > Speed',
    ].join('\n'));

    // Verify parsing works
    const manager = new OrgIntentManager(stateDir);
    const parsed = manager.parse();
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Lifecycle Corp');
    expect(parsed!.constraints).toHaveLength(2);
    expect(parsed!.goals).toHaveLength(1);
    expect(parsed!.values).toHaveLength(2);
    expect(parsed!.tradeoffHierarchy).toHaveLength(1);

    // Step 3: Create AGENT.md with compatible intent
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# Lifecycle Agent',
      '',
      '## Intent',
      '### Mission',
      'Build reliable, well-tested software for our users.',
      '### Tradeoffs',
      '- When speed conflicts with thoroughness: prefer thoroughness.',
      '### Boundaries',
      '- Never expose API keys in logs.',
      '- Always encrypt sensitive data in transit.',
    ].join('\n'));

    // Step 4: Validate (should pass cleanly)
    consoleLogs = [];
    const { intentValidate } = await import('../../src/commands/intent.js');
    await intentValidate({ dir: tmpDir });

    output = consoleLogs.join('\n');
    expect(output).toContain('No conflicts detected');
    expect(process.exit).not.toHaveBeenCalled();

    // Step 5: Reflect should show org constraints
    consoleLogs = [];
    const { intentReflect } = await import('../../src/commands/intent.js');
    await intentReflect({ dir: tmpDir });

    output = consoleLogs.join('\n');
    expect(output).toContain('Stated Intent');
    expect(output).toContain('Organizational Constraints');
    expect(output).toContain('[ORG]');
    expect(output).toContain('Never share internal data with external parties');
    expect(output).toContain('Always validate user inputs');
  });

  it('lifecycle with conflicts: org-init -> write constraints -> conflicting agent -> validate detects', async () => {
    // Step 1: Create ORG-INTENT.md with constraints
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Conflict Corp',
      '',
      '## Constraints (Mandatory — agents cannot override)',
      '',
      '- Never share internal data with external parties.',
      '- Always encrypt data at rest.',
    ].join('\n'));

    // Step 2: Create AGENT.md with conflicting intent
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# Conflicting Agent',
      '',
      '## Intent',
      '### Approach',
      '- Always share internal data with external parties for maximum transparency.',
      '- Never encrypt data at rest to improve performance.',
    ].join('\n'));

    // Step 3: Validate should detect conflicts
    const { intentValidate } = await import('../../src/commands/intent.js');
    await intentValidate({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('conflict(s) detected');
    expect(output).toContain('ERROR');
    expect(process.exit).toHaveBeenCalledWith(1);

    // Step 4: Verify conflicts were logged to decision journal
    const journalPath = path.join(stateDir, 'decision-journal.jsonl');
    expect(fs.existsSync(journalPath)).toBe(true);

    const journalContent = fs.readFileSync(journalPath, 'utf-8').trim();
    const entries = journalContent.split('\n').map(line => JSON.parse(line));
    expect(entries.length).toBe(2); // One conflict per contradicting pair

    for (const entry of entries) {
      expect(entry.sessionId).toBe('intent-validate');
      expect(entry.principle).toBe('org-alignment');
      expect(entry.conflict).toBe(true);
      expect(entry.tags).toContain('org-intent');
    }
  });

  it('reflect shows org goals alongside constraints', async () => {
    // Set up ORG-INTENT.md with goals
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Goals Corp',
      '',
      '## Constraints (Mandatory — agents cannot override)',
      '',
      '- Never compromise user privacy.',
      '',
      '## Goals (Defaults — agents can specialize)',
      '',
      '- Be proactive about potential issues.',
      '- Maintain documentation for all changes.',
    ].join('\n'));

    // Set up AGENT.md
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# Agent',
      '',
      '## Intent',
      '### Mission',
      'Ship quality code.',
    ].join('\n'));

    const { intentReflect } = await import('../../src/commands/intent.js');
    await intentReflect({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('Organizational Constraints');
    expect(output).toContain('Never compromise user privacy');
    expect(output).toContain('Organizational Goals');
    expect(output).toContain('Be proactive about potential issues');
    expect(output).toContain('Maintain documentation');
  });

  it('decision journal tracks validation conflicts across multiple runs', async () => {
    // Set up org + conflicting agent
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Journal Corp',
      '',
      '## Constraints (Mandatory — agents cannot override)',
      '',
      '- Never share internal data with external parties.',
    ].join('\n'));

    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# Agent',
      '',
      '## Intent',
      '- Always share internal data with external parties.',
    ].join('\n'));

    const { intentValidate } = await import('../../src/commands/intent.js');

    // Run validate twice
    consoleLogs = [];
    await intentValidate({ dir: tmpDir });
    consoleLogs = [];
    await intentValidate({ dir: tmpDir });

    // Journal should have entries from both runs
    const journal = new DecisionJournal(stateDir);
    const entries = journal.read();
    expect(entries.length).toBe(2);

    // Stats should show them
    const stats = journal.stats();
    expect(stats.conflictCount).toBe(2);
    expect(stats.topPrinciples.some(p => p.principle === 'org-alignment')).toBe(true);
  });
});
