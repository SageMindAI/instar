/**
 * Unit tests for `instar intent drift` CLI command.
 *
 * Tests cover:
 * - Shows analysis with formatted output
 * - Handles empty journal gracefully
 * - Respects --window option
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

/** Generate a timestamp N days ago from now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('intent drift', () => {
  let tmpDir: string;
  let stateDir: string;
  let originalExit: typeof process.exit;
  let consoleLogs: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-cli-test-'));
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

  it('shows empty journal message when no entries exist', async () => {
    const { intentDrift } = await import('../../src/commands/intent.js');
    await intentDrift({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('No decision journal entries found');
  });

  it('shows analysis with formatted output when journal has entries', async () => {
    // Create entries spanning both windows
    const entries = [
      // Previous window (15-28 days ago)
      ...Array.from({ length: 5 }, (_, i) => ({
        timestamp: daysAgo(15 + i),
        sessionId: `prev-${i}`,
        decision: `Previous decision ${i}`,
        principle: 'safety',
        confidence: 0.85,
      })),
      // Current window (1-13 days ago)
      ...Array.from({ length: 8 }, (_, i) => ({
        timestamp: daysAgo(1 + i),
        sessionId: `curr-${i}`,
        decision: `Current decision ${i}`,
        principle: 'safety',
        confidence: 0.8,
        conflict: i === 0,
      })),
    ];

    fs.writeFileSync(
      path.join(stateDir, 'decision-journal.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    );

    const { intentDrift } = await import('../../src/commands/intent.js');
    await intentDrift({ dir: tmpDir });

    const output = consoleLogs.join('\n');

    // Check key output sections
    expect(output).toContain('Intent Drift Analysis');
    expect(output).toContain('test-project');
    expect(output).toContain('Current Period');
    expect(output).toContain('Decisions');
    expect(output).toContain('Conflict Rate');
    expect(output).toContain('Drift Score');
    expect(output).toContain('Alignment Score');
    expect(output).toContain('Conflict Freedom');
    expect(output).toContain('Confidence Level');
    expect(output).toContain('Principle Consistency');
    expect(output).toContain('Journal Health');
  });

  it('respects --window option', async () => {
    // Create entries for a 7-day window test
    const entries = Array.from({ length: 10 }, (_, i) => ({
      timestamp: daysAgo(i + 1),
      sessionId: `s${i}`,
      decision: `Decision ${i}`,
      principle: 'safety',
      confidence: 0.8,
    }));

    fs.writeFileSync(
      path.join(stateDir, 'decision-journal.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    );

    const { intentDrift } = await import('../../src/commands/intent.js');
    await intentDrift({ dir: tmpDir, window: 7 });

    const output = consoleLogs.join('\n');
    // Should mention the 7-day window
    expect(output).toContain('7');
    expect(output).toContain('days');
  });
});
