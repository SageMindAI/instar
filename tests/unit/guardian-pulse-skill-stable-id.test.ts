/**
 * Regression test for the guardian-pulse skill recipe.
 *
 * The recipe was previously instructing agents to surface degradations to
 * the attention queue with id = "degradation:{FEATURE}:{TIMESTAMP}". The
 * timestamp made the id unique per detection time, so each pulse spawned a
 * new Telegram topic for the SAME recurring feature — exactly the noise
 * pattern that prompted this fix.
 *
 * The recipe must use a stable id that collapses repeated detections of the
 * same feature onto the same attention item: "degradation:{FEATURE}".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBuiltinSkills } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('guardian-pulse skill — attention-id is stable per feature', () => {
  let tmpDir: string;
  let skillsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-pulse-id-'));
    skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/guardian-pulse-skill-stable-id.test.ts:cleanup' });
  });

  it('omits the per-detection timestamp from the attention id', () => {
    installBuiltinSkills(skillsDir, 4242);
    const skillFile = path.join(skillsDir, 'guardian-pulse', 'SKILL.md');
    expect(fs.existsSync(skillFile)).toBe(true);

    const content = fs.readFileSync(skillFile, 'utf8');

    // Negative assertion — the timestamp-suffixed id must be gone. If this
    // ever regresses, the tone-gate at /attention is the only thing keeping
    // an agent from spamming N topics for one recurring issue.
    expect(content).not.toMatch(/degradation:\$\{FEATURE\}:\$\{TIMESTAMP\}/);

    // Positive assertion — the recipe instructs a stable id.
    expect(content).toMatch(/degradation:\$\{FEATURE\}/);
  });
});
