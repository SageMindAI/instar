/**
 * Unit tests for the rollback-from-artifact skill registration
 * (PR-REVIEW-HARDENING Phase A commit 6).
 *
 * Asserts the skill is installed by `installBuiltinSkills`, has the
 * expected structure (SKILL.md present, frontmatter valid, user_invocable
 * set to false), and that re-running installBuiltinSkills is idempotent
 * (does not overwrite a user's customized copy).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBuiltinSkills } from '../../src/commands/init.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rollback-skill-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('installBuiltinSkills — rollback-from-artifact', () => {
  let skillsDir: string;

  beforeEach(() => {
    skillsDir = createTempDir();
  });

  afterEach(() => cleanup(skillsDir));

  it('installs rollback-from-artifact/SKILL.md on fresh setup', () => {
    installBuiltinSkills(skillsDir, 4042);
    const skillFile = path.join(skillsDir, 'rollback-from-artifact', 'SKILL.md');
    expect(fs.existsSync(skillFile)).toBe(true);
  });

  it('SKILL.md carries valid frontmatter with name and description', () => {
    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(
      path.join(skillsDir, 'rollback-from-artifact', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: rollback-from-artifact');
    expect(content).toContain('description:');
  });

  it('is marked not user-invocable', () => {
    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(
      path.join(skillsDir, 'rollback-from-artifact', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toMatch(/user_invocable:\s*"false"/);
  });

  it('mentions the required sections (when-to-fire, procedure, hard rules)', () => {
    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(
      path.join(skillsDir, 'rollback-from-artifact', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain('When this fires');
    expect(content).toContain('Procedure');
    expect(content).toContain('Hard rules');
    expect(content).toContain('signal-vs-authority.md');
    // Spec requirement: the skill explicitly names §7 "Rollback cost" as input
    expect(content).toMatch(/Rollback cost/);
  });

  it('is idempotent — re-run does not overwrite a customized copy', () => {
    installBuiltinSkills(skillsDir, 4042);
    const skillFile = path.join(skillsDir, 'rollback-from-artifact', 'SKILL.md');
    const customMarker = '\n\n<!-- USER CUSTOMIZATION MARKER -->\n';
    fs.writeFileSync(skillFile, fs.readFileSync(skillFile, 'utf-8') + customMarker);

    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(skillFile, 'utf-8');
    expect(content).toContain('USER CUSTOMIZATION MARKER');
  });
});
