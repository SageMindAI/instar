/**
 * Unit tests — UpgradeGuideProcessor.
 *
 * Tests the guide delivery pipeline: finding versioned guides,
 * filtering by previousVersion, writing pending guide files,
 * and managing processed state.
 *
 * Coverage:
 *   1. Finds versioned guide files (X.Y.Z.md pattern)
 *   2. Ignores NEXT.md (not a versioned guide)
 *   3. Filters by previousVersion (only delivers newer guides)
 *   4. Writes pending-upgrade-guide.md for session-start hook
 *   5. Marks guides as processed (won't re-deliver)
 *   6. Concatenates multiple pending guides in version order
 *   7. clearPendingGuide removes the file
 *   8. hasPendingGuide reflects file existence
 *   9. Returns empty when no upgrades dir exists
 *  10. Returns empty when all guides already processed
 *  11. previousVersion filtering prevents flooding with old guides
 *  12. Processed state survives re-instantiation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpgradeGuideProcessor } from '../../src/core/UpgradeGuideProcessor.js';

describe('UpgradeGuideProcessor', () => {
  let tmpDir: string;
  let stateDir: string;
  let upgradesDir: string;

  const GUIDE_A = `# Upgrade Guide — v0.9.80
## What Changed
Added feature A.
## What to Tell Your User
- Feature A is available.
## Summary of New Capabilities
| Capability | How to Use |
|-----------|-----------|
| Feature A | POST /api/a |
`;

  const GUIDE_B = `# Upgrade Guide — v0.9.85
## What Changed
Added feature B with major improvements.
## What to Tell Your User
- Feature B makes things better.
## Summary of New Capabilities
| Capability | How to Use |
|-----------|-----------|
| Feature B | POST /api/b |
`;

  const GUIDE_C = `# Upgrade Guide — v0.9.86
## What Changed
Added feature C.
## What to Tell Your User
- Feature C is great.
## Summary of New Capabilities
| Capability | How to Use |
|-----------|-----------|
| Feature C | POST /api/c |
`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-proc-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });

    // Create upgrades dir at the expected location relative to the module.
    // UpgradeGuideProcessor resolves this from import.meta.url (dist/core/...),
    // so for testing we need to override findUpgradesDir. We'll test by creating
    // the processor and manually calling process() after setting up the file structure.
    upgradesDir = path.join(tmpDir, 'upgrades');
    fs.mkdirSync(upgradesDir, { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: create a processor that reads upgrades from our test dir
  function createProcessor(opts: {
    currentVersion?: string;
    previousVersion?: string;
  } = {}): UpgradeGuideProcessor {
    const proc = new UpgradeGuideProcessor({
      stateDir,
      currentVersion: opts.currentVersion ?? '0.9.86',
      previousVersion: opts.previousVersion,
    });

    // Override the private findUpgradesDir to use our test directory
    // @ts-expect-error — testing private method override
    proc.findUpgradesDir = () => upgradesDir;

    return proc;
  }

  function writeGuide(version: string, content: string) {
    fs.writeFileSync(path.join(upgradesDir, `${version}.md`), content);
  }

  // 1. Finds versioned guide files
  it('finds versioned guide files', () => {
    writeGuide('0.9.80', GUIDE_A);
    writeGuide('0.9.85', GUIDE_B);

    const proc = createProcessor();
    const result = proc.process();

    expect(result.pendingGuides).toContain('0.9.80');
    expect(result.pendingGuides).toContain('0.9.85');
    expect(result.pendingGuides.length).toBe(2);
  });

  // 2. Ignores NEXT.md
  it('ignores NEXT.md — only versioned files are delivered', () => {
    writeGuide('0.9.85', GUIDE_B);
    fs.writeFileSync(path.join(upgradesDir, 'NEXT.md'), '# Next\n## What Changed\nStuff');

    const proc = createProcessor();
    const result = proc.process();

    expect(result.pendingGuides).toEqual(['0.9.85']);
    expect(result.pendingGuides).not.toContain('NEXT');
  });

  // 3. Filters by previousVersion
  it('only delivers guides newer than previousVersion', () => {
    writeGuide('0.9.80', GUIDE_A);
    writeGuide('0.9.85', GUIDE_B);
    writeGuide('0.9.86', GUIDE_C);

    const proc = createProcessor({ previousVersion: '0.9.84' });
    const result = proc.process();

    expect(result.pendingGuides).toEqual(['0.9.85', '0.9.86']);
    expect(result.pendingGuides).not.toContain('0.9.80');
  });

  // 4. Writes pending-upgrade-guide.md
  it('writes pending guide file for session-start hook', () => {
    writeGuide('0.9.85', GUIDE_B);

    const proc = createProcessor();
    const result = proc.process();

    expect(result.pendingGuidePath).toBeTruthy();
    expect(fs.existsSync(result.pendingGuidePath!)).toBe(true);

    const content = fs.readFileSync(result.pendingGuidePath!, 'utf-8');
    expect(content).toContain('Feature B');
    expect(content).toContain('Instar Upgrade Guide');
  });

  // 5. Marks guides as processed
  it('marks delivered guides as processed', () => {
    writeGuide('0.9.85', GUIDE_B);

    const proc = createProcessor();
    proc.process();

    // Second call should find nothing new
    const result2 = proc.process();
    expect(result2.pendingGuides).toEqual([]);
    expect(result2.alreadyProcessed).toContain('0.9.85');
  });

  // 6. Concatenates multiple guides in version order
  it('concatenates multiple pending guides in ascending version order', () => {
    writeGuide('0.9.86', GUIDE_C);
    writeGuide('0.9.80', GUIDE_A);
    writeGuide('0.9.85', GUIDE_B);

    const proc = createProcessor();
    const result = proc.process();

    expect(result.pendingGuides).toEqual(['0.9.80', '0.9.85', '0.9.86']);

    const content = result.guideContent;
    const idxA = content.indexOf('Feature A');
    const idxB = content.indexOf('Feature B');
    const idxC = content.indexOf('Feature C');
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  // 7. clearPendingGuide removes the file
  it('clearPendingGuide removes pending guide file', () => {
    writeGuide('0.9.85', GUIDE_B);

    const proc = createProcessor();
    proc.process();

    expect(proc.hasPendingGuide()).toBe(true);

    proc.clearPendingGuide();

    expect(proc.hasPendingGuide()).toBe(false);
  });

  // 8. hasPendingGuide reflects file existence
  it('hasPendingGuide returns false when no guide exists', () => {
    const proc = createProcessor();
    expect(proc.hasPendingGuide()).toBe(false);
  });

  // 9. Returns empty when no upgrades dir
  it('returns empty result when upgrades dir does not exist', () => {
    // safe-git-allow: incremental-migration
    fs.rmSync(upgradesDir, { recursive: true, force: true });

    const proc = createProcessor();
    // Override to return null (no dir)
    // @ts-expect-error — testing private method override
    proc.findUpgradesDir = () => null;
    const result = proc.process();

    expect(result.pendingGuides).toEqual([]);
    expect(result.guideContent).toBe('');
  });

  // 10. Returns empty when all processed
  it('returns empty when all guides are already processed', () => {
    writeGuide('0.9.85', GUIDE_B);

    const proc = createProcessor();
    proc.process(); // First time — delivers

    const result = proc.process(); // Second time — all processed
    expect(result.pendingGuides).toEqual([]);
    expect(result.alreadyProcessed).toContain('0.9.85');
    expect(result.guideContent).toBe('');
  });

  // 11. previousVersion prevents flooding
  it('without previousVersion, delivers ALL unprocessed guides', () => {
    writeGuide('0.9.80', GUIDE_A);
    writeGuide('0.9.85', GUIDE_B);
    writeGuide('0.9.86', GUIDE_C);

    const proc = createProcessor({ previousVersion: undefined });
    const result = proc.process();

    // All 3 should be delivered (no version filter)
    expect(result.pendingGuides.length).toBe(3);
  });

  // 12. Processed state survives re-instantiation
  it('processed state persists across instances', () => {
    writeGuide('0.9.85', GUIDE_B);
    writeGuide('0.9.86', GUIDE_C);

    // First instance processes both
    const proc1 = createProcessor();
    proc1.process();

    // New instance with same stateDir
    const proc2 = createProcessor();
    const result = proc2.process();

    expect(result.pendingGuides).toEqual([]);
    expect(result.alreadyProcessed).toContain('0.9.85');
    expect(result.alreadyProcessed).toContain('0.9.86');
  });

  // 13. getPendingGuide returns content
  it('getPendingGuide returns guide content when pending', () => {
    writeGuide('0.9.85', GUIDE_B);

    const proc = createProcessor();
    proc.process();

    const content = proc.getPendingGuide();
    expect(content).toBeTruthy();
    expect(content).toContain('Feature B');
  });

  // 14. getPendingGuide returns null when nothing pending
  it('getPendingGuide returns null when no pending guide', () => {
    const proc = createProcessor();
    expect(proc.getPendingGuide()).toBeNull();
  });
});
