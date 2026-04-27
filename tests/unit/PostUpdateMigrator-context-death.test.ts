/**
 * Unit tests for the context-death anti-pattern migration (PR1 — spec
 * § (a)). Validates:
 *
 *   - Fresh agent home gains the marker block in both CLAUDE.md and
 *     AGENT.md.
 *   - Re-running the migration is a no-op (idempotent by marker detection).
 *   - Pin file skip: entries in .instar/identity-pins.json skip the
 *     marker entirely, regardless of whether CLAUDE.md / AGENT.md
 *     already contain it.
 *   - Missing files are skipped cleanly (no errors).
 *   - Malformed pin file is soft-failed (treated as empty pins).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const MARKER = 'INSTAR:ANTI-PATTERN-CONTEXT-DEATH';
const OPEN = `<!-- ${MARKER} -->`;
const CLOSE = `<!-- /${MARKER} -->`;

function makeAgentHome(): {
  tmp: string;
  projectDir: string;
  stateDir: string;
  claudeMd: string;
  agentMd: string;
  pinsPath: string;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-context-death-'));
  const projectDir = path.join(tmp, 'agent');
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const claudeMd = path.join(projectDir, 'CLAUDE.md');
  const agentMd = path.join(stateDir, 'AGENT.md');
  const pinsPath = path.join(stateDir, 'identity-pins.json');
  return { tmp, projectDir, stateDir, claudeMd, agentMd, pinsPath };
}

function buildMigrator(projectDir: string, stateDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir,
    hasTelegram: false,
    port: 4042,
  });
}

describe('PostUpdateMigrator — context-death anti-pattern migration', () => {
  let home: ReturnType<typeof makeAgentHome>;

  beforeEach(() => {
    home = makeAgentHome();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(home.tmp, { recursive: true, force: true });
  });

  it('injects the marker block into CLAUDE.md under Critical Anti-Patterns', () => {
    fs.writeFileSync(
      home.claudeMd,
      '# CLAUDE.md\n\n## Critical Anti-Patterns\n\n**Existing anti-pattern.**\n\n## Next Section\n'
    );
    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();

    const content = fs.readFileSync(home.claudeMd, 'utf-8');
    expect(content).toContain(OPEN);
    expect(content).toContain(CLOSE);
    expect(content).toContain('Context-Death Self-Stop');
    // Marker should sit inside Critical Anti-Patterns (before next heading).
    const markerIdx = content.indexOf(OPEN);
    const nextHeadingIdx = content.indexOf('## Next Section');
    expect(markerIdx).toBeLessThan(nextHeadingIdx);
  });

  it('injects the marker block into AGENT.md under My Principles', () => {
    fs.writeFileSync(
      home.agentMd,
      '# Echo\n\n## My Principles\n\n1. Build, don\'t describe.\n\n## Next Section\n'
    );
    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();

    const content = fs.readFileSync(home.agentMd, 'utf-8');
    expect(content).toContain(OPEN);
    expect(content).toContain(CLOSE);
    expect(content).toContain('No context-death self-stops');
    const markerIdx = content.indexOf(OPEN);
    const nextHeadingIdx = content.indexOf('## Next Section');
    expect(markerIdx).toBeLessThan(nextHeadingIdx);
  });

  it('is idempotent — re-running the migration does not double-inject', () => {
    fs.writeFileSync(home.claudeMd, '# X\n\n## Critical Anti-Patterns\n\n**A**\n');
    fs.writeFileSync(home.agentMd, '# X\n\n## My Principles\n\n1. P1\n');

    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();
    const claudeOnce = fs.readFileSync(home.claudeMd, 'utf-8');
    const agentOnce = fs.readFileSync(home.agentMd, 'utf-8');

    migrator.migrate();
    const claudeTwice = fs.readFileSync(home.claudeMd, 'utf-8');
    const agentTwice = fs.readFileSync(home.agentMd, 'utf-8');

    expect(claudeTwice).toBe(claudeOnce);
    expect(agentTwice).toBe(agentOnce);

    // Count of marker occurrences should be exactly 1 open + 1 close in each file.
    const countIn = (s: string, needle: string) =>
      (s.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    expect(countIn(claudeTwice, OPEN)).toBe(1);
    expect(countIn(claudeTwice, CLOSE)).toBe(1);
    expect(countIn(agentTwice, OPEN)).toBe(1);
    expect(countIn(agentTwice, CLOSE)).toBe(1);
  });

  it('honors .instar/identity-pins.json — pinned markers are skipped', () => {
    fs.writeFileSync(home.claudeMd, '# X\n\n## Critical Anti-Patterns\n\n**A**\n');
    fs.writeFileSync(home.agentMd, '# X\n\n## My Principles\n\n1. P1\n');
    fs.writeFileSync(
      home.pinsPath,
      JSON.stringify({ [MARKER]: { contentHash: 'user-custom', pinnedAt: '2026-04-18T00:00:00Z' } }, null, 2)
    );

    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();

    const claudeContent = fs.readFileSync(home.claudeMd, 'utf-8');
    const agentContent = fs.readFileSync(home.agentMd, 'utf-8');
    expect(claudeContent).not.toContain(OPEN);
    expect(agentContent).not.toContain(OPEN);
  });

  it('soft-fails on malformed identity-pins.json — treats as empty pins', () => {
    fs.writeFileSync(home.claudeMd, '# X\n\n## Critical Anti-Patterns\n\n**A**\n');
    fs.writeFileSync(home.agentMd, '# X\n\n## My Principles\n\n1. P1\n');
    fs.writeFileSync(home.pinsPath, 'not valid json {');

    const migrator = buildMigrator(home.projectDir, home.stateDir);
    const result = migrator.migrate();

    expect(result.errors.filter(e => e.includes(MARKER))).toHaveLength(0);
    const claudeContent = fs.readFileSync(home.claudeMd, 'utf-8');
    expect(claudeContent).toContain(OPEN);
  });

  it('missing CLAUDE.md / AGENT.md are silently skipped', () => {
    // Neither file exists. Migration should not throw, just record no-op.
    const migrator = buildMigrator(home.projectDir, home.stateDir);
    const result = migrator.migrate();
    expect(result.errors.filter(e => e.includes(MARKER))).toHaveLength(0);
  });

  it('appends Critical Anti-Patterns section if missing entirely', () => {
    fs.writeFileSync(home.claudeMd, '# Empty CLAUDE.md with no sections\n');
    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();
    const content = fs.readFileSync(home.claudeMd, 'utf-8');
    expect(content).toContain('## Critical Anti-Patterns');
    expect(content).toContain(OPEN);
  });

  it('appends My Principles section if missing entirely in AGENT.md', () => {
    fs.writeFileSync(home.agentMd, '# Agent with no principles section\n');
    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();
    const content = fs.readFileSync(home.agentMd, 'utf-8');
    expect(content).toContain('## My Principles');
    expect(content).toContain(OPEN);
  });
});
