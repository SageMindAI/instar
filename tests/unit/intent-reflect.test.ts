/**
 * Unit tests for `instar intent reflect` command.
 *
 * Tests cover:
 * - Intent section extraction from AGENT.md (via intentReflect behavior)
 * - Template-only content detection (HTML comments only = no real content)
 * - Missing AGENT.md handling
 * - Empty decision journal handling
 * - Formatted output with journal entries
 *
 * Since extractIntentSection() is not exported, we test its behavior
 * through the public intentReflect() function and verify console output.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../../src/core/Config.js';

// Mock loadConfig to avoid dependency on tmux/Claude CLI being installed (CI)
vi.mock('../../src/core/Config.js', () => ({
  loadConfig: vi.fn(),
}));

describe('intent reflect', () => {
  let tmpDir: string;
  let stateDir: string;
  let originalExit: typeof process.exit;
  let consoleLogs: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Configure the loadConfig mock to return config pointing at our tmpDir
    vi.mocked(loadConfig).mockReturnValue({
      projectName: 'test-project',
      projectDir: tmpDir,
      stateDir,
    } as any);

    consoleLogs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      consoleLogs.push(args.map(String).join(' '));
    });

    // Prevent process.exit from killing the test runner
    originalExit = process.exit;
    process.exit = vi.fn() as any;
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows "no intent section" message when AGENT.md does not exist', async () => {
    const { intentReflect } = await import('../../src/commands/intent.js');
    await intentReflect({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('No Intent section found');
  });

  it('shows "no intent section" when AGENT.md has no ## Intent heading', async () => {
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), `# My Agent\n\n## Overview\nSome overview text.\n`);

    const { intentReflect } = await import('../../src/commands/intent.js');
    await intentReflect({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('No Intent section found');
  });

  it('detects template-only content (HTML comments only) as no intent', async () => {
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# My Agent',
      '',
      '## Intent',
      '<!-- This is a template comment -->',
      '### Mission',
      '<!-- Define your mission here -->',
      '### Tradeoffs',
      '<!-- Define your tradeoffs here -->',
      '',
      '## Other Section',
      'Some content.',
    ].join('\n'));

    const { intentReflect } = await import('../../src/commands/intent.js');
    await intentReflect({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('No Intent section found');
  });

  it('displays the intent section when it has real content', async () => {
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# My Agent',
      '',
      '## Intent',
      '### Mission',
      'Build lasting customer relationships.',
      '### Tradeoffs',
      '- When speed conflicts with thoroughness: prefer thoroughness.',
      '',
      '## Other Section',
      'Other stuff.',
    ].join('\n'));

    const { intentReflect } = await import('../../src/commands/intent.js');
    await intentReflect({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('Stated Intent');
    expect(output).toContain('Build lasting customer relationships');
    expect(output).toContain('thoroughness');
  });

  it('shows "no decision journal entries" when journal is empty', async () => {
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# Agent',
      '## Intent',
      '### Mission',
      'Do good work.',
    ].join('\n'));

    const { intentReflect } = await import('../../src/commands/intent.js');
    await intentReflect({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('Stated Intent');
    expect(output).toContain('No decision journal entries found');
  });

  it('displays journal summary and recent entries', async () => {
    // Create AGENT.md with intent
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# Agent',
      '## Intent',
      '### Mission',
      'Ship reliable software.',
    ].join('\n'));

    // Create journal entries — use relative timestamps so they fall within default 7-day window
    const now = Date.now();
    const entries = [
      {
        timestamp: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
        sessionId: 'sess-1',
        decision: 'Used integration tests over unit tests for API layer',
        principle: 'reliability',
        confidence: 0.85,
        jobSlug: 'testing',
      },
      {
        timestamp: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
        sessionId: 'sess-2',
        decision: 'Skipped code review for hotfix',
        principle: 'speed',
        confidence: 0.6,
        conflict: true,
        alternatives: ['Wait for review', 'Pair program'],
      },
    ];
    fs.writeFileSync(
      path.join(stateDir, 'decision-journal.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    );

    const { intentReflect } = await import('../../src/commands/intent.js');
    await intentReflect({ dir: tmpDir });

    const output = consoleLogs.join('\n');

    // Should show journal summary
    expect(output).toContain('Journal Summary');
    expect(output).toContain('2'); // total entries

    // Should show principle distribution
    expect(output).toContain('Principle Distribution');
    expect(output).toContain('reliability');
    expect(output).toContain('speed');

    // Should show recent decisions
    expect(output).toContain('Recent Decisions');
    expect(output).toContain('Used integration tests');
    expect(output).toContain('Skipped code review');
    expect(output).toContain('CONFLICT');

    // Should show alternatives
    expect(output).toContain('Wait for review');
  });

  it('respects the --days option', async () => {
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '## Intent\n### Mission\nTest.\n');

    const now = Date.now();
    const entries = [
      {
        timestamp: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
        sessionId: 's1',
        decision: 'Recent decision',
      },
      {
        timestamp: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
        sessionId: 's2',
        decision: 'Old decision',
      },
    ];
    fs.writeFileSync(
      path.join(stateDir, 'decision-journal.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    );

    const { intentReflect } = await import('../../src/commands/intent.js');
    await intentReflect({ dir: tmpDir, days: 3 });

    const output = consoleLogs.join('\n');
    expect(output).toContain('Recent decision');
    // The "Old decision" would only appear in the full journal (stats count),
    // but the shown entries are filtered by days
    expect(output).toContain('last 3 days');
  });

  it('respects the --limit option', async () => {
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '## Intent\n### Mission\nTest.\n');

    const now = Date.now();
    const entries = Array.from({ length: 5 }, (_, i) => ({
      timestamp: new Date(now - (i + 1) * 60 * 60 * 1000).toISOString(), // 1-5 hours ago
      sessionId: `s${i}`,
      decision: `Decision number ${i}`,
    }));
    fs.writeFileSync(
      path.join(stateDir, 'decision-journal.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    );

    const { intentReflect } = await import('../../src/commands/intent.js');
    await intentReflect({ dir: tmpDir, limit: 2 });

    const output = consoleLogs.join('\n');
    expect(output).toContain('up to 2 entries');
  });

  it('shows intent section content including subsections', async () => {
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
      '# Agent',
      '',
      '## Intent',
      '### Mission',
      'Build great things.',
      '### Boundaries',
      '- Never expose secrets.',
      '- Always validate inputs.',
      '',
      '## Configuration',
      'Some config info.',
    ].join('\n'));

    const { intentReflect } = await import('../../src/commands/intent.js');
    await intentReflect({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    // Should include subsections (### headings are part of the Intent section)
    expect(output).toContain('Build great things');
    expect(output).toContain('Never expose secrets');
    expect(output).toContain('Always validate inputs');
    // Should NOT include content from the next ## section
    expect(output).not.toContain('Some config info');
  });
});
