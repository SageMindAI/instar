/**
 * Feature Delivery Completeness — ensures no gaps between init and migrate.
 *
 * The Three-Legged Stool of Feature Delivery in Instar:
 *   1. Server-side code (the feature itself)
 *   2. PostUpdateMigrator (so existing agents get local files on auto-update)
 *   3. Upgrade guide (so agents understand what they got)
 *
 * Without all three, new features ship to npm but existing agents never
 * actually get activated. This happened with External Operation Safety —
 * the code shipped in v0.9.14 but existing agents didn't get the hook,
 * settings, or config defaults until the migrator was updated. Then again
 * with Threadline relay — code shipped in 0.18.4 but the migration didn't
 * land until 0.18.5, leaving a window where existing agents got the feature
 * code but no awareness of it.
 *
 * This test prevents that gap by automatically extracting feature awareness
 * from source files and enforcing parity. Adding a feature to init/templates
 * without a corresponding PostUpdateMigrator section will fail CI.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.join(process.cwd(), 'src');
const initSource = fs.readFileSync(path.join(srcDir, 'commands/init.ts'), 'utf-8');
const migratorSource = fs.readFileSync(path.join(srcDir, 'core/PostUpdateMigrator.ts'), 'utf-8');
const templatesSource = fs.readFileSync(path.join(srcDir, 'scaffold/templates.ts'), 'utf-8');

describe('Feature Delivery Completeness', () => {
  describe('Hook parity: init installHooks() → PostUpdateMigrator migrateHooks()', () => {
    // Extract all hook filenames written in init.ts's installHooks function
    const hookFilePattern = /writeFileSync\(path\.join\(hooksDir,\s*'([^']+)'\)/g;
    const initHookFiles: string[] = [];
    let match;
    while ((match = hookFilePattern.exec(initSource)) !== null) {
      initHookFiles.push(match[1]);
    }

    it('init.ts installs at least 5 hooks (sanity check)', () => {
      expect(initHookFiles.length).toBeGreaterThanOrEqual(5);
    });

    for (const hookFile of initHookFiles) {
      it(`PostUpdateMigrator installs ${hookFile}`, () => {
        // The migrator must reference this hook file in its source
        expect(migratorSource).toContain(hookFile);
      });
    }
  });

  describe('Settings parity: init → PostUpdateMigrator migrateSettings()', () => {
    it('MCP matcher (mcp__.*) is in both init and migrator', () => {
      expect(initSource).toContain("'mcp__.*'");
      expect(migratorSource).toContain("'mcp__.*'");
    });

    it('dangerous-command-guard is referenced in both init and migrator', () => {
      expect(initSource).toContain('dangerous-command-guard');
      expect(migratorSource).toContain('dangerous-command-guard');
    });

    it('Playwright MCP server is in both init and migrator', () => {
      expect(initSource).toContain('playwright');
      expect(migratorSource).toContain('playwright');
    });
  });

  describe('Config parity: init config defaults → PostUpdateMigrator migrateConfig()', () => {
    // Feature config blocks are object-valued config keys that represent capabilities.
    // Both init.ts (for new agents) and PostUpdateMigrator (for existing agents) must
    // handle each one. If you add a feature config block, add it to this list.
    //
    // WHY THIS LIST EXISTS: The Threadline incident (0.18.4) showed that shipping
    // feature code without migration code leaves existing agents with capabilities
    // they don't know about. This list is the structural enforcement — if init.ts
    // has a config block that's not in the migrator (or vice versa), the test fails
    // and the version can't be published.
    const featureConfigBlocks = [
      'externalOperations',
      'threadline',
    ];

    for (const key of featureConfigBlocks) {
      it(`config.${key} is set in init.ts (new agents)`, () => {
        expect(initSource).toContain(key);
      });

      it(`config.${key} is migrated in PostUpdateMigrator (existing agents)`, () => {
        expect(migratorSource).toContain(key);
      });
    }

    // Auto-detect: if the migrator adds a config block we haven't listed, fail loudly.
    // Pattern: `if (!config.X)` followed by `config.X = {` means it's a feature block.
    const migratorConfigPattern = /if \(!config\.(\w+)\)\s*\{[\s\S]*?config\.\1\s*=/g;
    const detectedBlocks: string[] = [];
    let configMatch;
    while ((configMatch = migratorConfigPattern.exec(migratorSource)) !== null) {
      detectedBlocks.push(configMatch[1]);
    }

    it('all migrator config blocks are tracked in featureConfigBlocks', () => {
      for (const block of detectedBlocks) {
        expect(
          featureConfigBlocks.includes(block),
          `PostUpdateMigrator adds config.${block} but it's not in featureConfigBlocks — add it so parity is enforced`
        ).toBe(true);
      }
    });
  });

  describe('CLAUDE.md section parity: templates.ts ↔ PostUpdateMigrator', () => {
    // Feature CLAUDE.md sections that represent capabilities agents should know about.
    // Both templates.ts (via generateClaudeMd for new agents) and PostUpdateMigrator
    // (via migrateClaudeMd for existing agents) must include each one.
    //
    // When you add a new CLAUDE.md section to templates.ts, add a key phrase here.
    // The test will verify it exists in both files. If it's only in one, CI fails.
    const featureSections = [
      'Self-Discovery',
      'Private Viewing',
      'Dashboard',
      'File Viewer',
      'Threadline Network',
      'Playbook',
    ];

    for (const section of featureSections) {
      it(`"${section}" is in templates.ts (new agents)`, () => {
        expect(templatesSource).toContain(section);
      });

      it(`"${section}" is in PostUpdateMigrator (existing agents)`, () => {
        expect(migratorSource).toContain(section);
      });
    }

    // Auto-detect: if the migrator adds a CLAUDE.md section we haven't listed, fail.
    // Pattern: `if (!content.includes('SectionName'))` in migrateClaudeMd
    const migratorSectionPattern = /if \(!content\.includes\('([^']+)'\)/g;
    const detectedSections: string[] = [];
    let sectionMatch;
    while ((sectionMatch = migratorSectionPattern.exec(migratorSource)) !== null) {
      detectedSections.push(sectionMatch[1]);
    }

    // Some migrator sections are legacy patches for old agents that have since been
    // absorbed into the base template differently. These don't need template parity.
    const legacyMigratorSections = [
      'Coherence Gate',           // absorbed into base template
      'External Operation Safety', // absorbed into base template
      '/capabilities',            // alternate check for Self-Discovery
      'POST /view',               // alternate check for Private Viewing
      '/dashboard',               // alternate check for Dashboard
      '**Dashboard**',            // alternate check for Dashboard (bold markdown variant)
      '/coherence/check',         // alternate check for Coherence Gate
      '/operations/evaluate',     // alternate check for External Operation Safety
      'instar playbook',          // alternate check for Playbook
      '## Self-Observations',     // AGENT.md section, not CLAUDE.md — no template parity needed
      '## Identity History',      // AGENT.md section, not CLAUDE.md — no template parity needed
      'Session Continuity',       // conditional (Telegram-only), not a universal feature
      'CONTINUATION',             // alternate check for Session Continuity
      '/api/files/',              // alternate check for File Viewer
    ];

    it('all new migrator CLAUDE.md sections are tracked', () => {
      for (const section of detectedSections) {
        const isTracked = featureSections.includes(section) || legacyMigratorSections.includes(section);
        expect(
          isTracked,
          `PostUpdateMigrator adds CLAUDE.md section "${section}" but it's not tracked — add it to featureSections or legacyMigratorSections`
        ).toBe(true);
      }
    });
  });

  describe('Upgrade guide lifecycle', () => {
    const upgradesDir = path.join(process.cwd(), 'upgrades');
    const nextGuidePath = path.join(upgradesDir, 'NEXT.md');

    it('NEXT.md template exists', () => {
      expect(fs.existsSync(nextGuidePath)).toBe(true);
    });

    it('NEXT.md has required section headers', () => {
      const content = fs.readFileSync(nextGuidePath, 'utf-8');
      expect(content).toContain('## What Changed');
      expect(content).toContain('## What to Tell Your User');
      expect(content).toContain('## Summary of New Capabilities');
    });

    it('at least one versioned upgrade guide exists (proof of delivery)', () => {
      const files = fs.readdirSync(upgradesDir);
      const versionedGuides = files.filter(f => /^\d+\.\d+\.\d+\.md$/.test(f));
      expect(versionedGuides.length).toBeGreaterThan(0);
    });
  });
});
