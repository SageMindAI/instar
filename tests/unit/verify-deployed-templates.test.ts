/**
 * Unit tests for the templates-drift verifier (Layer 7 of
 * telegram-delivery-robustness).
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 7.
 *
 * Fixture-based: spawns three fake agents under a tmp `homeDir`, each
 * with a `.claude/scripts/telegram-reply.sh` containing one of:
 *   (a) the canonical bundled SHA (current) — no event,
 *   (b) a known-prior-shipped SHA            — no event,
 *   (c) a totally novel SHA                  — emits exactly ONE event.
 *
 * Also asserts the dedup behavior: a second invocation against the same
 * three fixtures fires zero new events.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  runVerifier,
  getKnownTemplatesForTesting,
} from '../../src/monitoring/templates-drift-verifier.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'src', 'templates');

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('templates-drift verifier', () => {
  let homeDir: string;
  let agentRoots: string[];
  let seenLogPath: string;

  // The canonical SHA of the bundled telegram-reply.sh.
  const canonicalContent = fs.readFileSync(
    path.join(TEMPLATES_DIR, 'scripts', 'telegram-reply.sh'),
  );
  const canonicalSha = sha256(canonicalContent);
  // Pick the prior-shipped SHA that we have a fixture for on disk.
  // The Layer-1 spec retained this fixture as the canonical pre-port-
  // config shape (sha256:3d08c63c…).
  const priorSha = '3d08c63c6280d0a7ba94a345c259673a461ee5c1d116cb47c95c7626c67cee23';
  // A novel SHA is anything that doesn't match canonical or any prior.
  const novelContent = `#!/bin/bash\n# user customization ${Date.now()}\necho hi\n`;
  const novelSha = sha256(novelContent);

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-verifier-test-'));
    seenLogPath = path.join(homeDir, '.instar', 'state', 'drift-verifier-seen.jsonl');
    DegradationReporter.resetForTesting();

    // Three fake agent roots, each with a .claude/scripts/telegram-reply.sh.
    const make = (slug: string, body: Buffer | string) => {
      const root = path.join(homeDir, '.instar', 'agents', slug);
      const scripts = path.join(root, '.claude', 'scripts');
      fs.mkdirSync(scripts, { recursive: true });
      fs.writeFileSync(path.join(scripts, 'telegram-reply.sh'), body, { mode: 0o755 });
      return root;
    };

    agentRoots = [
      // (a) on canonical → no drift event
      make('agent-current', canonicalContent),
      // (b) on a known-prior shipped SHA → no drift event (migrator handles)
      make('agent-prior', synthesizeContentForSha(priorSha)),
      // (c) novel content → ONE drift event
      make('agent-drift', novelContent),
    ];
  });

  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(homeDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/verify-deployed-templates.test.ts:75',
      });
    } catch {
      // best-effort cleanup
    }
  });

  it('emits exactly one drift event for the novel-content agent and none for the others', async () => {
    const reporter = DegradationReporter.getInstance();
    const result = await runVerifier({
      homeDir,
      templatesDir: TEMPLATES_DIR,
      agentRoots,
      seenLogPath,
      reporter,
    });

    // 3 scanned, 1 drifted, 0 suppressed (this is the first run).
    expect(result.scanned).toBe(3);
    expect(result.drifted).toBe(1);
    expect(result.suppressed).toBe(0);

    const events = reporter.getEvents().filter(e => e.feature === 'template-drift-detected');
    expect(events).toHaveLength(1);
    expect(events[0].reason).toMatch(/agent-drift/);
    expect(events[0].reason).toMatch(/telegram-reply\.sh/);
  });

  it('dedups (path, sha) pairs across runs — long-running drift produces ONE event total', async () => {
    const reporter = DegradationReporter.getInstance();

    const first = await runVerifier({
      homeDir,
      templatesDir: TEMPLATES_DIR,
      agentRoots,
      seenLogPath,
      reporter,
    });
    expect(first.drifted).toBe(1);
    expect(first.suppressed).toBe(0);

    const eventsAfterFirst = reporter
      .getEvents()
      .filter(e => e.feature === 'template-drift-detected').length;

    const second = await runVerifier({
      homeDir,
      templatesDir: TEMPLATES_DIR,
      agentRoots,
      seenLogPath,
      reporter,
    });
    expect(second.drifted).toBe(1);
    expect(second.suppressed).toBe(1);

    const eventsAfterSecond = reporter
      .getEvents()
      .filter(e => e.feature === 'template-drift-detected').length;

    // Second run should NOT have added a new event for the same (path, sha).
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
  });

  it('honors the kill switch via opts.enabled = false', async () => {
    const reporter = DegradationReporter.getInstance();
    const result = await runVerifier({
      homeDir,
      templatesDir: TEMPLATES_DIR,
      agentRoots,
      seenLogPath,
      reporter,
      enabled: false,
    });
    expect(result.disabled).toBe(true);
    expect(result.scanned).toBe(0);
    expect(result.drifted).toBe(0);
    const events = reporter.getEvents().filter(e => e.feature === 'template-drift-detected');
    expect(events).toHaveLength(0);
  });

  it('emits a fresh event when the deployed SHA changes (drift moves to a new novel SHA)', async () => {
    const reporter = DegradationReporter.getInstance();

    // First run — pick up the original drift.
    await runVerifier({
      homeDir,
      templatesDir: TEMPLATES_DIR,
      agentRoots,
      seenLogPath,
      reporter,
    });

    // Operator (or attacker) edits the on-disk script to a SECOND novel SHA.
    const driftAgentScript = path.join(
      agentRoots[2],
      '.claude',
      'scripts',
      'telegram-reply.sh',
    );
    const second = `#!/bin/bash\n# different customization ${Date.now()}\necho bye\n`;
    fs.writeFileSync(driftAgentScript, second);

    const result = await runVerifier({
      homeDir,
      templatesDir: TEMPLATES_DIR,
      agentRoots,
      seenLogPath,
      reporter,
    });

    // The new (path, sha) hasn't been seen before — emit.
    expect(result.drifted).toBe(1);
    expect(result.suppressed).toBe(0);

    const events = reporter
      .getEvents()
      .filter(e => e.feature === 'template-drift-detected');
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('skips templates that aren\'t deployed at the agent (partial install)', async () => {
    // Empty agent root — no .claude/scripts at all.
    const empty = path.join(homeDir, '.instar', 'agents', 'agent-empty');
    fs.mkdirSync(empty, { recursive: true });

    const reporter = DegradationReporter.getInstance();
    const result = await runVerifier({
      homeDir,
      templatesDir: TEMPLATES_DIR,
      agentRoots: [empty],
      seenLogPath,
      reporter,
    });
    expect(result.scanned).toBe(0);
    expect(result.drifted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('discovers agents under <homeDir>/.instar/agents/* without an explicit list', async () => {
    // Default-discovery path: with no `agentRoots`, the verifier reads
    // `<homeDir>/.instar/agents/*`. This test confirms the auto-enumeration.
    const reporter = DegradationReporter.getInstance();
    const result = await runVerifier({
      homeDir,
      templatesDir: TEMPLATES_DIR,
      // no agentRoots — exercise default discovery
      seenLogPath,
      reporter,
    });
    expect(result.scanned).toBe(3);
    expect(result.drifted).toBe(1);
  });

  it('registers telegram-reply.sh in the canonical template list', () => {
    const known = getKnownTemplatesForTesting();
    const tg = known.find(t => t.deployedBasename === 'telegram-reply.sh');
    expect(tg).toBeDefined();
    expect(tg!.priorShas.size).toBeGreaterThan(0);
  });
});

/**
 * For the "known-prior" fixture, we need on-disk content whose SHA is
 * *exactly* one of the prior-shipped SHAs. That means we need the actual
 * historical bytes — not just any bytes that hash to it (collisions are
 * infeasible, so a synthesizer can't fabricate one). Pull the historical
 * content from the existing test fixture, which has the same SHA the
 * migrator's prior set tracks.
 */
function synthesizeContentForSha(targetSha: string): Buffer {
  // The Layer-1 telegram-reply test ships a fixture for the pre-Layer-1
  // (3d08c63c…) SHA. If that's the prior SHA we picked, return that
  // fixture's content directly.
  const knownFixturePath = path.join(
    REPO_ROOT,
    'tests',
    'fixtures',
    'telegram-reply-pre-port-config.sh',
  );
  if (fs.existsSync(knownFixturePath)) {
    const content = fs.readFileSync(knownFixturePath);
    if (sha256(content) === targetSha) return content;
  }

  // The Layer-1 shipped SHA is whatever the bundled template was at
  // f9b5e3bb. We can reconstruct it by reading from `git show`, but
  // the unit test should not depend on git. Fall back to walking the
  // prior-set in order and matching the first one we have a fixture for.
  const candidates = Array.from(PostUpdateMigrator.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS);
  for (const candidateSha of candidates) {
    if (candidateSha === targetSha && fs.existsSync(knownFixturePath)) {
      const content = fs.readFileSync(knownFixturePath);
      if (sha256(content) === candidateSha) return content;
    }
  }

  // Last resort: skip into the next-best prior SHA we DO have a fixture
  // for. The test cares about "any known-prior" not "this exact prior".
  if (fs.existsSync(knownFixturePath)) {
    return fs.readFileSync(knownFixturePath);
  }

  throw new Error(
    `synthesizeContentForSha: no fixture available for SHA ${targetSha}; ` +
      `add tests/fixtures/telegram-reply-pre-port-config.sh or extend this helper.`,
  );
}
