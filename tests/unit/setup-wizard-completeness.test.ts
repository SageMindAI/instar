/**
 * Setup Wizard Completeness — ensures the AI-driven setup wizard
 * references all core features that affect the user setup experience.
 *
 * THE LESSON (v0.9.35 incident):
 * We shipped a two-tier secret management system with 61 passing tests,
 * but the setup wizard (the actual user-facing entry point) didn't know
 * about it. Users got the old flow that asked them to paste bot tokens
 * instead of offering Bitwarden or local encrypted storage first.
 *
 * The code worked. The tests passed. The feature was broken.
 *
 * Root cause (v0.9.39 resolution): Instar had TWO setup paths — a
 * programmatic CLI and an AI-driven wizard. They could silently diverge.
 * We eliminated the programmatic path entirely (Claude Code is a hard
 * requirement for Instar anyway). Now there's ONE path: the wizard.
 *
 * This test ensures the wizard skill covers all required features.
 * When adding a new feature that affects setup, add it to
 * requiredFeatures below and update the wizard skill to match.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const skillPath = path.join(process.cwd(), '.claude/skills/setup-wizard/SKILL.md');

// Only run if the skill file exists (it should in all normal builds)
const skillExists = fs.existsSync(skillPath);

describe('Setup Wizard Completeness', () => {
  it('setup-wizard SKILL.md exists', () => {
    expect(skillExists).toBe(true);
  });

  // Skip remaining tests if skill doesn't exist
  if (!skillExists) return;

  const skill = fs.readFileSync(skillPath, 'utf-8');

  // ── Required Features ─────────────────────────────────────────
  // When adding a new feature that affects the setup experience,
  // add it here. If the test fails, update the wizard skill.

  const requiredFeatures: Array<{ name: string; keywords: string[]; reason: string }> = [
    {
      name: 'SecretManager',
      keywords: ['SecretManager', 'secret'],
      reason: 'Secret management must be offered during setup before Telegram',
    },
    {
      name: 'Bitwarden option',
      keywords: ['bitwarden'],
      reason: 'Users must be offered Bitwarden as a secret storage option',
    },
    {
      name: 'Local encrypted store option',
      keywords: ['local encrypted store'],
      reason: 'Users must be offered local encrypted storage as a secret storage option',
    },
    // Future: add more as features are added
    // { name: 'SomeNewFeature', keywords: ['feature-keyword'], reason: 'Why this must be in the wizard' },
  ];

  describe('required features are referenced', () => {
    for (const { name, keywords, reason } of requiredFeatures) {
      it(`wizard references ${name} (${reason})`, () => {
        const found = keywords.some(kw =>
          skill.toLowerCase().includes(kw.toLowerCase())
        );
        expect(found).toBe(true);
      });
    }
  });

  // ── Core Feature References ──────────────────────────────────

  describe('secret management', () => {
    it('wizard skill mentions SecretManager by name', () => {
      expect(skill).toContain('SecretManager');
    });

    it('secret management phase comes BEFORE messaging phase', () => {
      const secretIndex = skill.toLowerCase().indexOf('secret management');
      const messagingIndex = skill.indexOf('Phase 3: Messaging');
      expect(secretIndex).toBeGreaterThan(-1);
      expect(messagingIndex).toBeGreaterThan(-1);
      expect(secretIndex).toBeLessThan(messagingIndex);
    });

    it('restore flow tries secret restoration before Telegram', () => {
      // Find the Restore Flow section
      const restoreFlowStart = skill.indexOf('### Restore Flow');
      const restoreFlowEnd = skill.indexOf('###', restoreFlowStart + 1);
      const restoreFlow = skill.substring(restoreFlowStart, restoreFlowEnd > -1 ? restoreFlowEnd : undefined);

      // Secret restoration should be mentioned
      expect(restoreFlow.toLowerCase()).toContain('secret');
      expect(restoreFlow).toContain('restoreTelegramConfig');
    });
  });

  // ── Phase Ordering ───────────────────────────────────────────

  describe('phase ordering', () => {
    it('identity phase exists and comes before secret management', () => {
      const identityIndex = skill.indexOf('Phase 2: Identity');
      const secretIndex = skill.indexOf('Phase 2.5');
      expect(identityIndex).toBeGreaterThan(-1);
      expect(secretIndex).toBeGreaterThan(-1);
      expect(identityIndex).toBeLessThan(secretIndex);
    });

    it('Messaging phase exists and comes after secret management', () => {
      const secretIndex = skill.indexOf('Phase 2.5');
      const messagingIndex = skill.indexOf('Phase 3: Messaging');
      expect(secretIndex).toBeGreaterThan(-1);
      expect(messagingIndex).toBeGreaterThan(-1);
      expect(secretIndex).toBeLessThan(messagingIndex);
    });

    it('server config phase exists and comes after messaging', () => {
      const messagingIndex = skill.indexOf('Phase 3: Messaging');
      const configIndex = skill.indexOf('Phase 4:');
      expect(messagingIndex).toBeGreaterThan(-1);
      expect(configIndex).toBeGreaterThan(-1);
      expect(messagingIndex).toBeLessThan(configIndex);
    });
  });

  // ── Messaging Skip Guard ─────────────────────────────────────
  // The wizard must check for existing valid credentials before
  // asking the user to set up messaging from scratch.

  describe('Messaging skip guard', () => {
    it('Phase 3 checks for existing credentials before full setup', () => {
      // Find Phase 3 content
      const phase3Start = skill.indexOf('Phase 3: Messaging');
      const phase4Start = skill.indexOf('Phase 4');
      const phase3 = skill.substring(phase3Start, phase4Start > -1 ? phase4Start : undefined);

      // Should mention checking/skipping if credentials already exist
      const hasSkipLogic =
        phase3.includes('skip') ||
        phase3.includes('already') ||
        phase3.includes('restored') ||
        phase3.includes('restoreTelegramConfig');

      expect(hasSkipLogic).toBe(true);
    });
  });

  // ── Mandatory Messaging Gate ─────────────────────────────────
  // Phase 3 must never be skipped due to other phases being skipped.
  // The "All done!" message must not appear without messaging configured.

  describe('Mandatory messaging gate', () => {
    // Use the ## heading to find the actual Phase 3 section, not menu references
    const phase3Heading = '## Phase 3: Messaging Setup';
    const phase3Start = skill.indexOf(phase3Heading);

    it('Phase 3 explicitly states skipping Bitwarden does NOT skip messaging', () => {
      const phase4Start = skill.indexOf('## Phase 4', phase3Start);
      const phase3 = skill.substring(phase3Start, phase4Start > -1 ? phase4Start : undefined);

      expect(phase3).toContain('skipped Phase 2.5');
      expect(phase3).toContain('does NOT mean');
    });

    it('Phase 3 states no previous skip cascades to messaging', () => {
      const phase4Start = skill.indexOf('## Phase 4', phase3Start);
      const phase3 = skill.substring(phase3Start, phase4Start > -1 ? phase4Start : undefined);

      expect(phase3).toContain('No previous skip cascades to messaging');
    });

    it('Pre-completion checklist exists before "All done"', () => {
      expect(skill).toContain('Pre-Completion Checklist');
      expect(skill).toContain('MESSAGING_NOT_CONFIGURED');
    });

    it('Pre-completion checklist sends back to Phase 3 if no messaging', () => {
      const checklistStart = skill.indexOf('Pre-Completion Checklist');
      const tellUserStart = skill.indexOf('Tell the User', checklistStart);
      const checklist = skill.substring(checklistStart, tellUserStart);

      // Should redirect to Phase 3 in both the checklist items and the verification block
      expect(checklist).toContain('Phase 3');
    });

    it('"no messaging configured" section does NOT declare setup complete', () => {
      const noMsgSection = skill.substring(
        skill.indexOf('If no messaging platform was configured'),
      );
      const sectionEnd = noMsgSection.indexOf('## Phase 6');
      const section = noMsgSection.substring(0, sectionEnd);

      expect(section).toContain('GO BACK');
      expect(section).not.toContain('All done');
    });
  });

  // ── Architecture Guard ───────────────────────────────────────
  // Ensure setup.ts is a launcher, not a parallel implementation.
  // This prevents the v0.9.35 incident from recurring.

  describe('single setup path', () => {
    const setupPath = path.join(process.cwd(), 'src/commands/setup.ts');
    const setupExists = fs.existsSync(setupPath);

    it('setup.ts exists', () => {
      expect(setupExists).toBe(true);
    });

    if (!setupExists) return;

    const setup = fs.readFileSync(setupPath, 'utf-8');

    it('setup.ts does NOT contain runClassicSetup (no classic fallback)', () => {
      expect(setup).not.toContain('runClassicSetup');
    });

    it('setup.ts does NOT contain promptForTelegram (no classic Telegram flow)', () => {
      expect(setup).not.toContain('promptForTelegram');
    });

    it('setup.ts uses @inquirer/prompts ONLY via dynamic import for phase gates', () => {
      // The classic setup imported @inquirer/prompts statically at the top.
      // Phase gates use dynamic import() — which is fine (one question, not a flow).
      // This test ensures we didn't regress to a static import.
      const staticImportPattern = /^import\s+.*from\s+['"]@inquirer\/prompts['"]/m;
      expect(staticImportPattern.test(setup)).toBe(false);
    });
  });
});
