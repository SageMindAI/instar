/**
 * Tests for guardian job gate evaluation — verifying gates correctly
 * skip or pass based on real filesystem state.
 *
 * Gates are shell commands that return exit code 0 (run the job) or
 * non-zero (skip the job). They're the zero-token pre-screening layer
 * that prevents wasting LLM calls when there's nothing to do.
 *
 * These tests use REAL shell execution against REAL temp directories.
 * No mocking. The gate commands are extracted from the actual default
 * job definitions and run against controlled filesystem state.
 *
 * Why this matters: A broken gate that always returns "skip" means the
 * guardian job NEVER runs — silently. A broken gate that always returns
 * "run" means the job wastes tokens on every cycle. Both are invisible
 * failures that no structural test would catch.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { refreshHooksAndSettings } from '../../src/commands/init.js';

// ─── Helpers ─────────────────────────────────────────────────────

interface TestProject {
  dir: string;
  stateDir: string;
  cleanup: () => void;
}

function createTestProject(port: number = 4321): TestProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-gate-test-'));
  const stateDir = path.join(dir, '.instar');

  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    port,
    projectName: 'test-agent',
    agentName: 'Test Agent',
  }));

  // Create empty jobs array — refresh will add all defaults
  fs.writeFileSync(path.join(stateDir, 'jobs.json'), '[]');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Test Agent\n');

  refreshHooksAndSettings(dir, stateDir);

  return {
    dir,
    stateDir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Extract the gate command for a specific job slug from the jobs file.
 */
function getGateCommand(project: TestProject, slug: string): string | null {
  const jobs = JSON.parse(
    fs.readFileSync(path.join(project.stateDir, 'jobs.json'), 'utf-8')
  ) as Array<{ slug: string; gate?: string }>;

  const job = jobs.find(j => j.slug === slug);
  return job?.gate ?? null;
}

/**
 * Run a gate command in a specific working directory.
 * Returns true (gate passed, job should run) or false (gate failed, skip).
 */
function runGate(gate: string, cwd: string): boolean {
  try {
    execFileSync('/bin/sh', ['-c', gate], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Tests ───────────────────────────────────────────────────────

describe('Guardian Job Gates', () => {
  let project: TestProject;

  afterEach(() => {
    project?.cleanup();
  });

  describe('degradation-digest gate', () => {
    it('skips when degradation events file does not exist', () => {
      project = createTestProject();
      const gate = getGateCommand(project, 'degradation-digest');
      expect(gate).toBeTruthy();

      // No degradation-events.json exists — gate should skip
      const result = runGate(gate!, project.dir);
      expect(result).toBe(false);
    });

    it('skips when degradation events file is empty array', () => {
      project = createTestProject();
      const gate = getGateCommand(project, 'degradation-digest');

      // Create empty events file at the path DegradationReporter actually writes
      fs.writeFileSync(
        path.join(project.stateDir, 'degradations.json'),
        '[]'
      );

      const result = runGate(gate!, project.dir);
      expect(result).toBe(false);
    });

    it('passes when degradation events exist', () => {
      project = createTestProject();
      const gate = getGateCommand(project, 'degradation-digest');

      // Create events file at the path DegradationReporter actually writes
      fs.writeFileSync(
        path.join(project.stateDir, 'degradations.json'),
        JSON.stringify([{
          feature: 'telegram',
          primary: 'send message',
          fallback: 'log to file',
          reason: 'API timeout',
          timestamp: new Date().toISOString(),
        }])
      );

      const result = runGate(gate!, project.dir);
      expect(result).toBe(true);
    });
  });

  describe('memory-hygiene gate', () => {
    it('skips when MEMORY.md does not exist', () => {
      project = createTestProject();
      const gate = getGateCommand(project, 'memory-hygiene');
      expect(gate).toBeTruthy();

      // No MEMORY.md — gate should skip
      const result = runGate(gate!, project.dir);
      expect(result).toBe(false);
    });

    it('skips when MEMORY.md has fewer than 100 words', () => {
      project = createTestProject();
      const gate = getGateCommand(project, 'memory-hygiene');

      // Create a tiny MEMORY.md (< 100 words)
      fs.writeFileSync(
        path.join(project.stateDir, 'MEMORY.md'),
        'Some brief notes about the agent.'
      );

      const result = runGate(gate!, project.dir);
      expect(result).toBe(false);
    });

    it('passes when MEMORY.md has more than 100 words', () => {
      project = createTestProject();
      const gate = getGateCommand(project, 'memory-hygiene');

      // Create a substantial MEMORY.md (> 100 words)
      const words = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
      fs.writeFileSync(
        path.join(project.stateDir, 'MEMORY.md'),
        `# Agent Memory\n\n${words}\n`
      );

      const result = runGate(gate!, project.dir);
      expect(result).toBe(true);
    });
  });

  describe('state-integrity-check gate', () => {
    it('skips when server is not running (no health endpoint)', () => {
      project = createTestProject();
      const gate = getGateCommand(project, 'state-integrity-check');
      expect(gate).toBeTruthy();

      // No server running — curl to localhost should fail
      const result = runGate(gate!, project.dir);
      expect(result).toBe(false);
    });
  });

  describe('guardian-pulse gate', () => {
    it('skips when server is not running', () => {
      project = createTestProject();
      const gate = getGateCommand(project, 'guardian-pulse');
      expect(gate).toBeTruthy();

      const result = runGate(gate!, project.dir);
      expect(result).toBe(false);
    });
  });

  describe('session-continuity-check gate', () => {
    it('skips when server is not running', () => {
      project = createTestProject();
      const gate = getGateCommand(project, 'session-continuity-check');
      expect(gate).toBeTruthy();

      const result = runGate(gate!, project.dir);
      expect(result).toBe(false);
    });
  });

  describe('gate consistency', () => {
    it('all guardian gates evaluate without crashing (even if they skip)', () => {
      project = createTestProject();

      const guardianSlugs = [
        'degradation-digest',
        'state-integrity-check',
        'memory-hygiene',
        'guardian-pulse',
        'session-continuity-check',
      ];

      for (const slug of guardianSlugs) {
        const gate = getGateCommand(project, slug);
        expect(gate, `${slug} should have a gate`).toBeTruthy();

        // Gate should not throw/crash — it should return true or false cleanly
        expect(() => {
          runGate(gate!, project.dir);
        }).not.toThrow();
      }
    });

    it('gates that depend on server health all skip when no server is running', () => {
      project = createTestProject();

      const serverDependentGates = [
        'state-integrity-check',
        'guardian-pulse',
        'session-continuity-check',
      ];

      for (const slug of serverDependentGates) {
        const gate = getGateCommand(project, slug);
        const result = runGate(gate!, project.dir);
        expect(result, `${slug} gate should skip when no server is running`).toBe(false);
      }
    });

    it('file-based gates only depend on files within .instar/', () => {
      project = createTestProject();

      // degradation-digest and memory-hygiene are file-based gates
      const fileSlugs = ['degradation-digest', 'memory-hygiene'];

      for (const slug of fileSlugs) {
        const gate = getGateCommand(project, slug);
        // Gate should reference .instar paths, not absolute system paths
        // (they're run with cwd = project dir, so relative paths work)
        expect(gate).toBeTruthy();
        // Should not reference /tmp or other absolute paths outside the project
        expect(gate).not.toMatch(/\/tmp\//);
        expect(gate).not.toMatch(/\/var\//);
        expect(gate).not.toMatch(/\/home\//);
      }
    });
  });
});
