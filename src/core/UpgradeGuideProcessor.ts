/**
 * Upgrade Guide Processor — the "intelligence" layer of knowledge upgrades.
 *
 * PostUpdateMigrator handles mechanical patches (hooks, scripts, CLAUDE.md sections).
 * UpgradeGuideProcessor delivers higher-level guidance that each agent processes
 * intelligently based on its own evolved context.
 *
 * Each Instar version can ship with an upgrade guide (markdown file in upgrades/).
 * These guides contain:
 *   - What changed and why
 *   - Suggested actions the agent should take
 *   - Configuration hints
 *   - Behavioral guidance
 *
 * The agent reads the guide and decides how to integrate it — because every agent
 * is different, evolving separately, and best-positioned to know how new capabilities
 * fit into its own situation.
 *
 * Flow:
 *   1. `instar migrate` runs (from NEW binary after npm update)
 *   2. PostUpdateMigrator patches files mechanically
 *   3. UpgradeGuideProcessor finds unprocessed guides
 *   4. Writes pending guide to `.instar/state/pending-upgrade-guide.md`
 *   5. Session-start hook detects the file and injects it into agent context
 *   6. Agent reads, processes, and acts on the guidance
 *   7. Next `instar migrate` marks previous guides as processed
 *
 * Born from Justin's vision: "It's literally guidance. Each agent is different,
 * evolving separately — they are best-informed and most knowledgeable on how
 * to ingest these upgrades and apply to their own situation."
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface UpgradeGuideResult {
  /** Guides that were found and are pending processing by the agent */
  pendingGuides: string[];
  /** Guides already processed by the agent */
  alreadyProcessed: string[];
  /** The combined guide content for the agent to read (empty if none pending) */
  guideContent: string;
  /** Path where the pending guide was written (for session-start hook) */
  pendingGuidePath: string | null;
}

export interface UpgradeGuideConfig {
  /** The .instar state directory */
  stateDir: string;
  /** Current installed version (to determine which guides are new) */
  currentVersion: string;
  /** Version the agent upgraded FROM — only guides newer than this are delivered.
   *  If omitted, falls back to processed-upgrades.json state (legacy behavior). */
  previousVersion?: string;
}

export class UpgradeGuideProcessor {
  private stateDir: string;
  private currentVersion: string;
  private previousVersion: string | null;
  private processedFile: string;
  private pendingGuidePath: string;

  constructor(config: UpgradeGuideConfig) {
    this.stateDir = config.stateDir;
    this.currentVersion = config.currentVersion;
    this.previousVersion = config.previousVersion ?? null;
    this.processedFile = path.join(config.stateDir, 'state', 'processed-upgrades.json');
    this.pendingGuidePath = path.join(config.stateDir, 'state', 'pending-upgrade-guide.md');
  }

  /**
   * Find and deliver any unprocessed upgrade guides.
   *
   * Scans the `upgrades/` directory bundled with the instar package,
   * compares against the processed state, and writes any new guides
   * to a pending file for the agent to read.
   */
  process(): UpgradeGuideResult {
    const result: UpgradeGuideResult = {
      pendingGuides: [],
      alreadyProcessed: [],
      guideContent: '',
      pendingGuidePath: null,
    };

    // Find the upgrades directory relative to this module
    const upgradesDir = this.findUpgradesDir();
    if (!upgradesDir) {
      return result;
    }

    // Read available guides
    let availableGuides = this.getAvailableGuides(upgradesDir);
    if (availableGuides.length === 0) {
      return result;
    }

    // Filter by previousVersion — only deliver guides for versions the agent
    // hasn't seen yet. Without this, agents that update across multiple versions
    // (or whose processed-upgrades.json was lost) get ALL historical guides
    // concatenated, producing repetitive/confusing announcements.
    if (this.previousVersion) {
      const prevVer = this.previousVersion;
      availableGuides = availableGuides.filter(g => this.compareSemver(g.version, prevVer) > 0);
      if (availableGuides.length === 0) {
        return result;
      }
    }

    // Read processed state
    const processed = this.getProcessedVersions();

    // Find unprocessed guides (among version-filtered set)
    const pending: Array<{ version: string; filePath: string }> = [];
    for (const guide of availableGuides) {
      if (processed.includes(guide.version)) {
        result.alreadyProcessed.push(guide.version);
      } else {
        pending.push(guide);
        result.pendingGuides.push(guide.version);
      }
    }

    if (pending.length === 0) {
      // All guides already delivered — don't touch the pending file.
      // It may still be waiting for the agent to read and acknowledge it.
      // Only `clearPendingGuide()` (via `instar upgrade-ack`) should remove it.
      return result;
    }

    // Concatenate pending guides in version order
    const sections: string[] = [];
    for (const guide of pending) {
      try {
        const content = fs.readFileSync(guide.filePath, 'utf-8');
        sections.push(content);
      } catch {
        // Skip unreadable files
      }
    }

    if (sections.length === 0) {
      return result;
    }

    // Build the combined guide
    const header = `# Instar Upgrade Guide\n\n` +
      `> You have ${pending.length} upgrade guide${pending.length > 1 ? 's' : ''} to process.\n` +
      `> Read through each section and take the suggested actions based on YOUR context.\n` +
      `> **IMPORTANT**: All commands in these guides are for YOU (the agent) to execute directly.\n` +
      `> Never relay commands to the user for them to run manually. You have full shell access.\n` +
      `> After processing, these guides won't appear again.\n\n` +
      `---\n\n`;

    result.guideContent = header + sections.join('\n\n---\n\n');

    // Write to pending file
    try {
      const dir = path.dirname(this.pendingGuidePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.pendingGuidePath, result.guideContent);
      result.pendingGuidePath = this.pendingGuidePath;
    } catch {
      // Non-fatal — guide content is still in the result
    }

    // Mark these guides as processed (they've been delivered)
    this.markProcessed(pending.map(g => g.version));

    return result;
  }

  /**
   * Check if there's a pending upgrade guide waiting for the agent.
   * Used by the session-start hook.
   */
  hasPendingGuide(): boolean {
    return fs.existsSync(this.pendingGuidePath);
  }

  /**
   * Get the pending guide content (for session-start hook injection).
   */
  getPendingGuide(): string | null {
    if (!fs.existsSync(this.pendingGuidePath)) return null;
    try {
      return fs.readFileSync(this.pendingGuidePath, 'utf-8');
    } catch {
      // @silent-fallback-ok — pending guide returns null
      return null;
    }
  }

  /**
   * Clear the pending guide (called after the agent has processed it).
   */
  clearPendingGuide(): void {
    this.cleanPendingGuide();
  }

  /**
   * Find the upgrades/ directory bundled with the instar package.
   * Resolves relative to this module's location on disk.
   */
  private findUpgradesDir(): string | null {
    try {
      // This file is at dist/core/UpgradeGuideProcessor.js
      // The upgrades/ dir is at the package root
      const moduleDir = path.resolve(
        __dirname,
        '..', '..'
      );
      const upgradesDir = path.join(moduleDir, 'upgrades');
      if (fs.existsSync(upgradesDir) && fs.statSync(upgradesDir).isDirectory()) {
        return upgradesDir;
      }
    } catch {
      // @silent-fallback-ok — upgrades dir returns null
    }
    return null;
  }

  /**
   * Get all available upgrade guides, sorted by version.
   */
  private getAvailableGuides(upgradesDir: string): Array<{ version: string; filePath: string }> {
    const guides: Array<{ version: string; filePath: string }> = [];

    try {
      const files = fs.readdirSync(upgradesDir);
      for (const file of files) {
        // Match files like "0.8.12.md", "1.0.0.md"
        const match = /^(\d+\.\d+\.\d+)\.md$/.exec(file);
        if (match) {
          guides.push({
            version: match[1],
            filePath: path.join(upgradesDir, file),
          });
        }
      }
    } catch {
      // @silent-fallback-ok — dir read returns empty
      return [];
    }

    // Sort by semver (ascending)
    guides.sort((a, b) => this.compareSemver(a.version, b.version));

    return guides;
  }

  /**
   * Get the list of versions whose guides have already been processed.
   */
  private getProcessedVersions(): string[] {
    if (!fs.existsSync(this.processedFile)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.processedFile, 'utf-8'));
      return data.processedVersions || [];
    } catch {
      // @silent-fallback-ok — processed versions reset
      return [];
    }
  }

  /**
   * Mark versions as processed (their guides have been delivered to the agent).
   */
  private markProcessed(versions: string[]): void {
    const existing = this.getProcessedVersions();
    const all = [...new Set([...existing, ...versions])];

    const dir = path.dirname(this.processedFile);
    fs.mkdirSync(dir, { recursive: true });

    const data = {
      processedVersions: all,
      lastProcessedAt: new Date().toISOString(),
      lastDeliveredVersion: versions[versions.length - 1],
    };

    // Atomic write
    const tmpPath = this.processedFile + `.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, this.processedFile);
    } catch {
      try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/core/UpgradeGuideProcessor.ts:290' }); } catch { /* ignore */ }
    }
  }

  /**
   * Remove the pending guide file.
   */
  private cleanPendingGuide(): void {
    try {
      if (fs.existsSync(this.pendingGuidePath)) {
        SafeFsExecutor.safeUnlinkSync(this.pendingGuidePath, { operation: 'src/core/UpgradeGuideProcessor.ts:301' });
      }
    } catch {
      // @silent-fallback-ok — cleanup, file persists
    }
  }

  /**
   * Compare two semver strings. Returns negative if a < b, positive if a > b, 0 if equal.
   */
  private compareSemver(a: string, b: string): number {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }
}
