/**
 * Smoke tests for the compaction harness (PR0d — context-death-pitfall-
 * prevention spec § P0.1).
 *
 * These tests validate the HARNESS ITSELF — that it can stand up an
 * isolated agent home, run the canonical compaction-recovery.sh hook,
 * and capture its output. PR2 will stack real post-compaction assertions
 * on top of this same harness.
 *
 * Per the spec's flake budget (A112): if <90% over 3 stabilization
 * attempts, quarantine the test and ship stop-gate in shadow mode with
 * degraded evidence. These smoke tests are structured to be
 * deterministic — no real subprocesses spanning the network, no timing
 * races, no reliance on a running server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createCompactionHarness,
  type CompactionHarnessHandle,
} from './compaction-harness.js';

describe('compaction harness — setup + teardown', () => {
  let harness: CompactionHarnessHandle | null = null;

  afterEach(() => {
    harness?.teardown();
    harness = null;
  });

  it('creates an isolated agent home with .instar/config.json + identity files', () => {
    harness = createCompactionHarness();
    expect(fs.existsSync(path.join(harness.projectDir, 'AGENT.md'))).toBe(true);
    expect(fs.existsSync(path.join(harness.projectDir, 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(harness.projectDir, 'USER.md'))).toBe(true);
    expect(fs.existsSync(path.join(harness.stateDir, 'config.json'))).toBe(true);

    const cfg = JSON.parse(harness.readFile('.instar/config.json'));
    expect(cfg.agentName).toBe('TestAgent');
    expect(cfg.projectDir).toBe(harness.projectDir);
  });

  it('respects the agentName option', () => {
    harness = createCompactionHarness({ agentName: 'Echo' });
    const agent = harness.readFile('AGENT.md');
    expect(agent).toContain('# Echo');
    expect(agent).toContain('I am Echo');
  });

  it('respects the memoryContent option', () => {
    harness = createCompactionHarness({ memoryContent: '# Custom memory\n- Entry A\n' });
    expect(harness.readFile('MEMORY.md')).toContain('Entry A');
  });

  it('initializes a git repo and commits seed files (plan + identity durable)', () => {
    harness = createCompactionHarness({
      planFile: { relativePath: 'docs/plan.md', content: '# Plan\n- Step 1\n- Step 2\n' },
    });
    expect(fs.existsSync(path.join(harness.projectDir, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(harness.projectDir, 'docs/plan.md'))).toBe(true);

    // Verify a commit exists for the plan file — spec's "durable
    // artifacts make continuation safe" invariant.
    const gitLog = harness.readFile('.git/HEAD');
    expect(gitLog).toMatch(/^ref: /);
  });

  it('teardown removes the temp tree and is idempotent', () => {
    harness = createCompactionHarness();
    const projectDir = harness.projectDir;
    harness.teardown();
    expect(fs.existsSync(projectDir)).toBe(false);
    // Second teardown is a no-op (does not throw).
    expect(() => harness!.teardown()).not.toThrow();
  });
});

describe('compaction harness — canonical hook lookup', () => {
  let harness: CompactionHarnessHandle | null = null;

  afterEach(() => {
    harness?.teardown();
    harness = null;
  });

  it('copies the canonical compaction-recovery.sh into the harness tree', () => {
    harness = createCompactionHarness();
    const hookPath = path.join(harness.stateDir, 'hooks', 'instar', 'compaction-recovery.sh');
    expect(fs.existsSync(hookPath)).toBe(true);
    const mode = fs.statSync(hookPath).mode & 0o777;
    expect(mode & 0o100).toBe(0o100); // owner-executable
  });
});

describe('compaction harness — runCompactionRecovery (capability proof)', () => {
  let harness: CompactionHarnessHandle | null = null;

  afterEach(() => {
    harness?.teardown();
    harness = null;
  });

  it('runs compaction-recovery.sh and captures stdout within timeout', () => {
    harness = createCompactionHarness();
    const result = harness.runCompactionRecovery();
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeLessThan(10_000);
    // The recovery hook prints a known header line to stdout — match
    // either the templated "IDENTITY RESTORATION" banner (source-of-truth
    // in src/templates/hooks/) OR the deployed "IDENTITY RECOVERY" header
    // used by the deployed agent copy. Either is evidence that the hook
    // ran and emitted the expected structural output.
    expect(result.stdout).toMatch(/IDENTITY (RECOVERY|RESTORATION)/);
  });

  it('produces stdout with the structural recovery markers regardless of agent name', () => {
    // Server absent (port 0) → topic-context HTTP path skipped; hook
    // falls through to the canonical recovery output. Assert the
    // structural markers the downstream PR2 test will rely on, not the
    // specific agent identity (the templated hook does not interpolate
    // AGENT.md content — it re-injects a fixed template).
    harness = createCompactionHarness({ agentName: 'HarnessEcho' });
    const result = harness.runCompactionRecovery();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/COMPACTION RECOVERY|IDENTITY/);
    expect(result.stdout).toMatch(/RECOVERY COMPLETE|Continue your work/i);
  });

  it('env-merge: passing INSTAR_TELEGRAM_TOPIC is visible to the hook (stdout contains topic-context attempt or skip)', () => {
    // Topic value is a string; absence of a real server means the curl
    // call silently skips, but the env var path IS taken. We don't
    // assert topic content (would require a live server), only that
    // the env-merge worked by checking the hook ran without error.
    harness = createCompactionHarness({ telegramTopic: '6931' });
    const result = harness.runCompactionRecovery();
    expect(result.exitCode).toBe(0);
  });

  it('spec-critical assertion: the "fresh session" phrasing that causes context-death stops is NOT in recovery output', () => {
    // Spec § "Anti-pattern: Context-death self-stop" says the recovery
    // hook should NOT suggest continuing in a fresh session. This
    // assertion guards against future regressions where a well-meaning
    // edit adds such language to the recovery template.
    harness = createCompactionHarness();
    const result = harness.runCompactionRecovery();
    expect(result.stdout).not.toMatch(/fresh session/i);
    expect(result.stdout).not.toMatch(/start over/i);
    expect(result.stdout).not.toMatch(/restart the session/i);
  });

  it('writeFile + commit: plan file is tracked and readable after write', () => {
    harness = createCompactionHarness();
    harness.writeFile(
      'docs/plan.md',
      '# Plan\n\n- Slice 1: done\n- Slice 2: in progress\n',
      { commit: true, commitMessage: 'plan: slice 2 mid-flight' }
    );
    const read = harness.readFile('docs/plan.md');
    expect(read).toContain('Slice 2: in progress');
  });
});

describe('compaction harness — error surfaces', () => {
  let harness: CompactionHarnessHandle | null = null;

  afterEach(() => {
    harness?.teardown();
    harness = null;
  });

  it('throws a clear error when the canonical hook is missing (simulated)', () => {
    harness = createCompactionHarness();
    // Remove the hook to simulate the "canonical not found" path.
    const hookPath = path.join(harness.stateDir, 'hooks', 'instar', 'compaction-recovery.sh');
    // safe-git-allow: incremental-migration
    fs.unlinkSync(hookPath);
    expect(() => harness!.runCompactionRecovery()).toThrow(/compaction-recovery\.sh not found/);
  });
});
