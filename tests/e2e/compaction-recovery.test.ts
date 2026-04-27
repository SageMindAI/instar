/**
 * E2E compaction-recovery test (PR2 — context-death-pitfall-prevention
 * spec § (c)).
 *
 * Shipped on top of the PR0d harness. Asserts the actual invariants the
 * spec cares about:
 *
 *   1. Recovery hook exits cleanly (non-zero would break autonomous
 *      continuation — and THAT is what causes context-death self-stop
 *      rationalizations in the first place).
 *   2. Output contains the structural identity markers downstream
 *      sessions depend on (RECOVERY COMPLETE phrase so the agent knows
 *      it can continue).
 *   3. Output does NOT contain the drift-inducing phrasings this spec
 *      exists to prevent ("fresh session", "start over", etc.).
 *   4. A committed plan file (durable artifact) survives the recovery
 *      invocation — the file is still on disk, at the same git sha, so
 *      continuation is demonstrably safe.
 *
 * Per spec's flake budget (A112): if <90% over 3 stabilization attempts,
 * quarantine the test and ship stop-gate in shadow mode. These tests
 * use only deterministic local operations (file-system + bash), no
 * network, no Anthropic API calls — so flake should be near-zero.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createCompactionHarness,
  type CompactionHarnessHandle,
} from './compaction-harness.js';

describe('e2e compaction-recovery — structural invariants (spec § (c))', () => {
  let harness: CompactionHarnessHandle | null = null;

  afterEach(() => {
    harness?.teardown();
    harness = null;
  });

  it('recovery hook exits 0 (non-zero would break autonomous continuation)', () => {
    harness = createCompactionHarness({
      planFile: {
        relativePath: 'docs/plan.md',
        content: '# Plan\n\n- Slice 1: done\n- Slice 2: in progress\n- Slice 3: TODO\n',
      },
    });
    const result = harness.runCompactionRecovery();
    expect(result.exitCode).toBe(0);
  });

  it('output contains the structural "continue your work" marker', () => {
    // The canonical recovery hook ends with a "RECOVERY COMPLETE —
    // You are grounded. Continue your work." banner. Downstream
    // sessions look for this signal to know they can keep going.
    harness = createCompactionHarness();
    const result = harness.runCompactionRecovery();
    expect(result.stdout).toMatch(/Continue your work/i);
  });

  it('output does NOT contain drift-inducing phrasings (spec regression guard)', () => {
    // This is the exact pattern the spec exists to prevent: recovery
    // output telling the agent to "start over" or resume in a "fresh
    // session." If a future template edit reintroduces such language,
    // this test fails and the PR is blocked.
    harness = createCompactionHarness({
      planFile: {
        relativePath: 'plans/topic-6931.md',
        content: '# topic 6931 plan\n\n- slice 2 done\n- slice 3 mid-flight\n',
      },
    });
    const result = harness.runCompactionRecovery();
    expect(result.stdout).not.toMatch(/fresh session/i);
    expect(result.stdout).not.toMatch(/start over/i);
    expect(result.stdout).not.toMatch(/restart the session/i);
    expect(result.stdout).not.toMatch(/open a new conversation/i);
    expect(result.stdout).not.toMatch(/continue in a new session/i);
  });

  it('committed plan file survives the recovery invocation (durability evidence)', () => {
    // Spec's premise: "with durable artifacts, context death is not a
    // real risk." We model this by committing a plan file, running the
    // recovery hook, and verifying the file is untouched and still at
    // the same commit sha.
    harness = createCompactionHarness({
      planFile: {
        relativePath: 'docs/slice-plan.md',
        content: '# Slice plan\n\n- do the thing\n- then the next thing\n',
      },
    });

    const planAbs = path.join(harness.projectDir, 'docs/slice-plan.md');
    const contentBefore = fs.readFileSync(planAbs, 'utf-8');
    // safe-git-allow: incremental-migration
    const commitBefore = execFileSync(
      'git',
      ['-C', harness.projectDir, 'rev-parse', 'HEAD'],
      { encoding: 'utf-8' }
    ).trim();

    const result = harness.runCompactionRecovery();
    expect(result.exitCode).toBe(0);

    const contentAfter = fs.readFileSync(planAbs, 'utf-8');
    // safe-git-allow: incremental-migration
    const commitAfter = execFileSync(
      'git',
      ['-C', harness.projectDir, 'rev-parse', 'HEAD'],
      { encoding: 'utf-8' }
    ).trim();

    expect(contentAfter).toBe(contentBefore);
    expect(commitAfter).toBe(commitBefore);
  });

  it('latency budget: recovery completes well under the 5-second safety ceiling', () => {
    // Spec doesn't pin a specific budget for the recovery hook itself,
    // but a hook that takes >5s to run will cause operator-visible lag
    // at session-start / post-compaction and erode the "just re-read
    // the plan, it's fine" premise. 5s is a soft ceiling; adjust if
    // the canonical hook legitimately needs longer.
    harness = createCompactionHarness();
    const result = harness.runCompactionRecovery();
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('handles the "autonomous session mid-plan" scenario without crashing', () => {
    // Exercise the exact failure mode this spec was written to prevent:
    // an autonomous agent in the middle of a plan hits compaction. The
    // recovery hook must succeed; no special behavior required beyond
    // not-crashing, because PR3's router will be the actual gate that
    // prevents an unjustified stop.
    harness = createCompactionHarness({
      planFile: {
        relativePath: '.instar/autonomous-plan.md',
        content: '# Autonomous plan\n\n- slice 2 committed\n- slice 3 in progress\n',
      },
      telegramTopic: '6931',
    });
    // Also mark autonomous state as active (file-presence convention).
    harness.writeFile(
      '.claude/autonomous-state.local.md',
      '# Autonomous: active\n- topic: 6931\n- started: 2026-04-18\n',
      { commit: true, commitMessage: 'autonomous: active marker' }
    );

    const result = harness.runCompactionRecovery();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Continue your work/i);
  });
});
