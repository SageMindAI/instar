/**
 * Unit tests — Upgrade guide finalization (check-upgrade-guide.js logic).
 *
 * Tests the critical pipeline that renames NEXT.md → {version}.md during
 * prepublishOnly. This is the exact failure category that caused guides
 * to exist but never reach agents (27 guides for 219 published versions).
 *
 * Coverage:
 *   1. NEXT.md → {version}.md rename happens automatically
 *   2. Version header is updated in the renamed file
 *   3. Fresh template is created after rename
 *   4. Template placeholders are detected and block publish
 *   5. Missing required sections block publish
 *   6. Too-short guides block publish
 *   7. Already-existing version file is validated, not overwritten
 *   8. No guide at all blocks publish
 *   9. Guide content is preserved through rename
 *  10. Malformed existing guides are reported
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

describe('Upgrade guide finalization', () => {
  let tmpDir: string;
  let upgradesDir: string;
  let packageJsonPath: string;
  const scriptPath = path.resolve(__dirname, '../../scripts/check-upgrade-guide.js');

  function writePackageJson(version: string) {
    fs.writeFileSync(packageJsonPath, JSON.stringify({ name: 'test', version }, null, 2));
  }

  function writeNextMd(content: string) {
    fs.writeFileSync(path.join(upgradesDir, 'NEXT.md'), content);
  }

  function writeVersionGuide(version: string, content: string) {
    fs.writeFileSync(path.join(upgradesDir, `${version}.md`), content);
  }

  const VALID_GUIDE = `# Upgrade Guide — vNEXT

## What Changed

This release adds hybrid search combining BM25 keyword matching with vector
similarity for better results across all query types. The FTS5 index is
automatically created and maintained alongside existing vector indexes.

## What to Tell Your User

- **Better search**: "When I search my memory, I now use both exact keyword matching and semantic similarity together. This means I find things more reliably."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Hybrid search | POST /semantic/search with alpha parameter |
| Search stats | GET /semantic/search-stats |
`;

  const TEMPLATE_GUIDE = `# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

<!-- Describe what changed technically. What new features, APIs, behavioral changes? -->
<!-- Write this for the AGENT — they need to understand the system deeply. -->

## What to Tell Your User

<!-- Write talking points the agent should relay to their user. -->
<!-- This should be warm, conversational, user-facing — not a changelog. -->
<!-- Focus on what THEY can now do, not internal plumbing. -->

- **[Feature name]**: "[Brief, friendly description of what this means for the user]"

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| [Capability] | [Endpoint, command, or "automatic"] |
`;

  function runScript(): { stdout: string; exitCode: number } {
    try {
      const stdout = execSync(`node ${scriptPath}`, {
        cwd: tmpDir,
        encoding: 'utf-8',
        env: { ...process.env, NODE_PATH: '' },
      });
      return { stdout, exitCode: 0 };
    } catch (err: any) {
      return { stdout: err.stdout || '', exitCode: err.status || 1 };
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-guide-test-'));
    upgradesDir = path.join(tmpDir, 'upgrades');
    packageJsonPath = path.join(tmpDir, 'package.json');

    fs.mkdirSync(upgradesDir, { recursive: true });

    // The script resolves ROOT from __dirname relative to scripts/ — we need to
    // create the script in the right location relative to tmpDir
    const scriptsDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    // Copy the actual script into our temp project so it resolves paths correctly
    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    fs.writeFileSync(path.join(scriptsDir, 'check-upgrade-guide.js'), scriptContent);
    // Copy the validator module the script imports from
    const validatorPath = path.resolve(__dirname, '../../scripts/upgrade-guide-validator.mjs');
    fs.writeFileSync(
      path.join(scriptsDir, 'upgrade-guide-validator.mjs'),
      fs.readFileSync(validatorPath, 'utf-8'),
    );
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runLocalScript(): { stdout: string; exitCode: number } {
    const localScript = path.join(tmpDir, 'scripts', 'check-upgrade-guide.js');
    try {
      const stdout = execSync(`node ${localScript}`, {
        cwd: tmpDir,
        encoding: 'utf-8',
        env: { ...process.env, NODE_PATH: '' },
      });
      return { stdout, exitCode: 0 };
    } catch (err: any) {
      return { stdout: err.stdout || '', exitCode: err.status || 1 };
    }
  }

  // 1. NEXT.md → {version}.md rename
  it('renames NEXT.md to version file during validation', () => {
    writePackageJson('1.2.3');
    writeNextMd(VALID_GUIDE);

    const result = runLocalScript();

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(upgradesDir, '1.2.3.md'))).toBe(true);
    expect(result.stdout).toContain('Finalized: NEXT.md');
    expect(result.stdout).toContain('1.2.3.md');
  });

  // 2. Version header is updated
  it('updates H1 header from vNEXT to actual version', () => {
    writePackageJson('1.2.3');
    writeNextMd(VALID_GUIDE);

    runLocalScript();

    const content = fs.readFileSync(path.join(upgradesDir, '1.2.3.md'), 'utf-8');
    expect(content).toContain('# Upgrade Guide — v1.2.3');
    expect(content).not.toContain('vNEXT');
  });

  // 3. Fresh template created
  it('creates fresh NEXT.md template after rename', () => {
    writePackageJson('1.2.3');
    writeNextMd(VALID_GUIDE);

    runLocalScript();

    expect(fs.existsSync(path.join(upgradesDir, 'NEXT.md'))).toBe(true);
    const template = fs.readFileSync(path.join(upgradesDir, 'NEXT.md'), 'utf-8');
    expect(template).toContain('<!-- Describe what changed');
    expect(template).toContain('## What Changed');
    expect(template).toContain('## What to Tell Your User');
    expect(template).toContain('## Summary of New Capabilities');
  });

  // 4. Template placeholders block publish
  it('blocks publish when NEXT.md has unfilled template placeholders', () => {
    writePackageJson('1.2.3');
    writeNextMd(TEMPLATE_GUIDE);

    const result = runLocalScript();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('template placeholder');
    // Should NOT have renamed
    expect(fs.existsSync(path.join(upgradesDir, '1.2.3.md'))).toBe(false);
    expect(fs.existsSync(path.join(upgradesDir, 'NEXT.md'))).toBe(true);
  });

  // 5. Missing required sections block publish
  it('blocks publish when required sections are missing', () => {
    writePackageJson('1.2.3');
    writeNextMd(`# Upgrade Guide — vNEXT

## What Changed

Added some things that are pretty cool and useful.
This description is long enough to pass the minimum length check.
It has multiple sentences describing the changes made in this release.
The changes are substantial and meaningful and affect multiple areas.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Feature A | POST /api/feature-a |
`);

    const result = runLocalScript();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('missing "## What to Tell Your User"');
  });

  // 6. Too-short guides block publish
  it('blocks publish when guide is too short', () => {
    writePackageJson('1.2.3');
    writeNextMd(`# Guide

## What Changed
Short.

## What to Tell Your User
Brief.

## Summary of New Capabilities
| A | B |
`);

    const result = runLocalScript();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('too short');
  });

  // 7. Already-existing version file is validated, not overwritten
  it('validates existing version file without touching NEXT.md', () => {
    writePackageJson('1.2.3');
    writeVersionGuide('1.2.3', VALID_GUIDE.replace('vNEXT', 'v1.2.3'));
    writeNextMd(TEMPLATE_GUIDE); // Even if NEXT.md has placeholders

    const result = runLocalScript();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Upgrade guide validated for v1.2.3');
    // NEXT.md should be untouched (not renamed, since version file already exists)
    const nextContent = fs.readFileSync(path.join(upgradesDir, 'NEXT.md'), 'utf-8');
    expect(nextContent).toContain('[Feature name]'); // Still template
  });

  // 8. No guide at all blocks publish
  it('blocks publish when no guide exists', () => {
    writePackageJson('1.2.3');
    // No NEXT.md, no 1.2.3.md

    const result = runLocalScript();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('No upgrade guide found');
    expect(result.stdout).toContain('Create: upgrades/NEXT.md');
  });

  // 9. Guide content preserved through rename
  it('preserves full guide content through rename', () => {
    writePackageJson('1.2.3');
    writeNextMd(VALID_GUIDE);

    runLocalScript();

    const content = fs.readFileSync(path.join(upgradesDir, '1.2.3.md'), 'utf-8');
    expect(content).toContain('hybrid search');
    expect(content).toContain('BM25 keyword matching');
    expect(content).toContain('POST /semantic/search');
    expect(content).toContain('Better search');
  });

  // 10. Malformed existing guides reported (informational, not blocking)
  it('reports malformed existing guides as warnings', () => {
    writePackageJson('1.2.3');
    writeVersionGuide('1.2.3', VALID_GUIDE.replace('vNEXT', 'v1.2.3'));
    // Write a malformed old guide
    writeVersionGuide('0.9.1', '# Short guide\nNot enough content here');

    const result = runLocalScript();

    // Current version guide is valid — should pass
    expect(result.exitCode).toBe(0);
    // But should warn about the old malformed guide
    expect(result.stdout).toContain('0.9.1.md');
  });

  // 11. Idempotent — running twice doesn't break things
  it('is idempotent when run twice', () => {
    writePackageJson('1.2.3');
    writeNextMd(VALID_GUIDE);

    // First run — should finalize
    const result1 = runLocalScript();
    expect(result1.exitCode).toBe(0);
    expect(result1.stdout).toContain('Finalized');

    // Second run — version file exists, should validate it
    const result2 = runLocalScript();
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout).toContain('Upgrade guide validated');
    expect(result2.stdout).not.toContain('Finalized');
  });

  // 12. Fresh template includes bump declaration
  it('fresh template includes bump type declaration', () => {
    writePackageJson('1.2.3');
    writeNextMd(VALID_GUIDE);

    runLocalScript();

    const template = fs.readFileSync(path.join(upgradesDir, 'NEXT.md'), 'utf-8');
    expect(template).toContain('<!-- bump: patch -->');
    expect(template).toContain('patch = bug fixes');
    expect(template).toContain('minor = new features');
    expect(template).toContain('major = breaking changes');
  });

  // 13. Warns when guide has no bump declaration
  it('warns when existing guide has no bump type declaration', () => {
    writePackageJson('1.2.3');
    // Write a valid guide WITHOUT the bump declaration
    writeVersionGuide('1.2.3', VALID_GUIDE.replace('vNEXT', 'v1.2.3'));

    const result = runLocalScript();

    expect(result.exitCode).toBe(0); // Advisory, not blocking
    expect(result.stdout).toContain('bump: TYPE');
  });

  // 14. Warns when declared bump mismatches actual version change
  it('warns when bump: minor declared but only a patch bump happened', () => {
    // Write a "previous version" guide so the script can compare
    writeVersionGuide('1.2.0', VALID_GUIDE.replace('vNEXT', 'v1.2.0'));

    // Current version is 1.2.1 (patch bump) but guide declares minor
    writePackageJson('1.2.1');
    const minorGuide = `# Upgrade Guide — v1.2.1

<!-- bump: minor -->

## What Changed

Added a major new search feature with new API endpoints.

## What to Tell Your User

- **New feature**: "Better search across your knowledge base."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| New search | POST /semantic/search |
`;
    writeVersionGuide('1.2.1', minorGuide);

    const result = runLocalScript();

    expect(result.exitCode).toBe(0); // Advisory, not blocking
    expect(result.stdout).toContain('minor');
    expect(result.stdout).toContain('PATCH bump');
  });

  // 15. Warns when content describes new features but declares patch
  it('warns when patch declared but guide describes new APIs', () => {
    // Previous version guide
    writeVersionGuide('1.2.0', VALID_GUIDE.replace('vNEXT', 'v1.2.0'));

    // Current version is 1.2.1 (patch) but has new features
    writePackageJson('1.2.1');
    const patchWithFeatures = `# Upgrade Guide — v1.2.1

<!-- bump: patch -->

## What Changed

Added a new API endpoint for exporting memory and a new command.

## What to Tell Your User

- **Memory export**: "Your knowledge can now be exported as markdown."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Export memory | POST /semantic/export-memory |
`;
    writeVersionGuide('1.2.1', patchWithFeatures);

    const result = runLocalScript();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('new features');
    expect(result.stdout).toContain('MINOR version bump');
  });
});
