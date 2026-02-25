/**
 * Unit tests — Upgrade guide infrastructure validation.
 *
 * Ensures:
 * - All existing upgrade guides have required sections
 * - The upgrade-notify session prompt includes memory internalization
 * - The session-start hook loads the feature guide
 * - The UpgradeGuideProcessor correctly finds and delivers guides
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

describe('Upgrade Guide Infrastructure', () => {
  const upgradesDir = path.join(ROOT, 'upgrades');

  describe('existing guides are well-formed', () => {
    const guideFiles = fs.existsSync(upgradesDir)
      ? fs.readdirSync(upgradesDir).filter(f => f.endsWith('.md'))
      : [];

    it('has at least one upgrade guide', () => {
      expect(guideFiles.length).toBeGreaterThan(0);
    });

    for (const file of guideFiles) {
      describe(`upgrades/${file}`, () => {
        const content = fs.readFileSync(path.join(upgradesDir, file), 'utf-8');

        it('has "What Changed" section', () => {
          expect(content).toContain('## What Changed');
        });

        it('has "What to Tell Your User" section', () => {
          expect(content).toContain('## What to Tell Your User');
        });

        it('has "Summary of New Capabilities" section', () => {
          expect(content).toContain('## Summary of New Capabilities');
        });

        it('has substantial content (> 200 chars)', () => {
          expect(content.length).toBeGreaterThan(200);
        });

        it('filename matches semver pattern', () => {
          expect(file).toMatch(/^\d+\.\d+\.\d+\.md$/);
        });
      });
    }
  });

  describe('session-start hook loads feature guide', () => {
    const migrator = new PostUpdateMigrator({
      projectDir: ROOT,
      stateDir: path.join(ROOT, '.instar'),
      port: 4040,
      hasTelegram: true,
      projectName: 'test',
    });
    const hookContent = migrator.getHookContent('session-start');

    it('calls /capabilities endpoint', () => {
      expect(hookContent).toContain('/capabilities');
    });

    it('extracts and outputs featureGuide triggers', () => {
      expect(hookContent).toContain('featureGuide');
      expect(hookContent).toContain('YOUR CAPABILITIES');
    });

    it('loads topic context before identity', () => {
      const topicIdx = hookContent.indexOf('CONVERSATION CONTEXT');
      const identityIdx = hookContent.indexOf('Identity:');
      expect(topicIdx).toBeLessThan(identityIdx);
      expect(topicIdx).toBeGreaterThan(-1);
    });

    it('outputs actual summary and messages, not just pointers', () => {
      expect(hookContent).toContain('SUMMARY OF CONVERSATION SO FAR');
      expect(hookContent).toContain('RECENT MESSAGES');
      // Should NOT have the old placeholder
      expect(hookContent).not.toContain('Read the thread history file for details');
    });
  });

  describe('upgrade-notify session includes memory internalization', () => {
    const serverPath = path.join(ROOT, 'src', 'commands', 'server.ts');
    const serverContent = fs.readFileSync(serverPath, 'utf-8');

    it('instructs agent to update MEMORY.md', () => {
      // Find the upgrade-notify section
      const notifyIdx = serverContent.indexOf('upgrade-notify');
      expect(notifyIdx).toBeGreaterThan(-1);

      // Extract surrounding context (the full prompt area)
      const surroundingContent = serverContent.slice(
        Math.max(0, notifyIdx - 3000),
        notifyIdx + 3000,
      );

      expect(surroundingContent).toContain('Update your memory');
      expect(surroundingContent).toContain('MEMORY.md');
    });

    it('does NOT say "That is ALL" (allows memory update step)', () => {
      const notifyIdx = serverContent.indexOf('upgrade-notify');
      const surroundingContent = serverContent.slice(
        Math.max(0, notifyIdx - 3000),
        notifyIdx + 3000,
      );

      expect(surroundingContent).not.toContain('That is ALL');
    });
  });

  describe('PostUpdateMigrator includes memory internalization', () => {
    const migratorPath = path.join(ROOT, 'src', 'core', 'PostUpdateMigrator.ts');
    const migratorContent = fs.readFileSync(migratorPath, 'utf-8');

    it('instructs agent to update MEMORY.md in upgrade guide section', () => {
      expect(migratorContent).toContain('UPDATE YOUR MEMORY');
      expect(migratorContent).toContain('MEMORY.md');
    });

    it('loads feature guide from capabilities at session start', () => {
      expect(migratorContent).toContain('YOUR CAPABILITIES');
      expect(migratorContent).toContain('featureGuide');
    });
  });
});
