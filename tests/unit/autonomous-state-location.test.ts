/**
 * Autonomous state file location — regression test.
 *
 * Root cause: The autonomous skill wrote its state file to
 * .claude/autonomous-state.local.md. Claude Code has a separate safety
 * layer for writes to .claude/ (settings self-modification protection)
 * that triggers a confirmation prompt even with --dangerously-skip-permissions.
 * This prompt can't be hooked via PermissionRequest, so it blocks
 * autonomous sessions silently.
 *
 * Fix: All autonomous state files (.autonomous-state.local.md,
 * autonomous-emergency-stop) moved to .instar/ which is the agent's
 * own state directory and doesn't trigger Claude Code's settings protection.
 *
 * These tests ensure autonomous files never reference .claude/ for state storage.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SKILL_DIR = path.join(process.cwd(), '.claude', 'skills', 'autonomous');

describe('Autonomous state files use .instar/ not .claude/', () => {
  describe('SKILL.md', () => {
    const content = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');

    it('references .instar/autonomous-state.local.md', () => {
      expect(content).toContain('.instar/autonomous-state.local.md');
    });

    it('does NOT reference .claude/autonomous-state', () => {
      // Exclude lines about .claude/settings.json which are legitimate
      const lines = content.split('\n').filter(
        l => !l.includes('settings.json') && !l.includes('skills/autonomous'),
      );
      const filtered = lines.join('\n');
      expect(filtered).not.toMatch(/\.claude\/autonomous-state/);
    });

    it('emergency stop file is in .instar/', () => {
      expect(content).toContain('.instar/autonomous-emergency-stop');
      expect(content).not.toContain('.claude/autonomous-emergency-stop');
    });
  });

  describe('setup-autonomous.sh', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'scripts', 'setup-autonomous.sh'),
      'utf-8',
    );

    it('writes state file to .instar/', () => {
      expect(content).toMatch(/cat > \.instar\/autonomous-state\.local\.md/);
    });

    it('creates .instar directory', () => {
      expect(content).toContain('mkdir -p .instar');
    });

    it('does NOT write to .claude/autonomous-state', () => {
      expect(content).not.toContain('.claude/autonomous-state');
    });
  });

  describe('autonomous-stop-hook.sh', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'hooks', 'autonomous-stop-hook.sh'),
      'utf-8',
    );

    it('reads state from .instar/', () => {
      expect(content).toMatch(/STATE_FILE="\.instar\/autonomous-state\.local\.md"/);
    });

    it('checks emergency stop in .instar/', () => {
      expect(content).toContain('.instar/autonomous-emergency-stop');
      expect(content).not.toContain('.claude/autonomous-emergency-stop');
    });

    it('does NOT reference .claude/ for any state files', () => {
      // Filter out comments about the skill's original location
      const lines = content.split('\n').filter(
        l => !l.startsWith('#') && !l.includes('skills/autonomous'),
      );
      const filtered = lines.join('\n');
      expect(filtered).not.toMatch(/\.claude\/autonomous-/);
    });
  });
});
