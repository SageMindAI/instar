import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Package Completeness Tests
 *
 * Ensures that every file referenced at runtime via path resolution from
 * the package root is actually included in the published npm package.
 *
 * Born from the setup-wizard skill gap: the skill existed in the repo but
 * was silently excluded from every npm release because `package.json` `files`
 * didn't include it. The code had a graceful fallback, so no test ever caught
 * the regression. Users got the degraded experience for months.
 *
 * These tests guarantee that what the code expects to find at package root
 * actually ships.
 */

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');

/**
 * Get the list of files that would be included in `npm pack`.
 * This is the definitive source of truth for what ships.
 */
function getPackedFiles(): string[] {
  const output = execSync('npm pack --dry-run --json 2>/dev/null', {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  const parsed = JSON.parse(output);
  // npm pack --json returns an array with one entry
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return (entry.files as Array<{ path: string }>).map(f => f.path);
}

/**
 * Get all TypeScript source files.
 */
function getSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      files.push(...getSourceFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('Package completeness', () => {
  const packedFiles = getPackedFiles();

  it('npm pack --dry-run returns files', () => {
    expect(packedFiles.length).toBeGreaterThan(0);
  });

  /**
   * CRITICAL: Every path resolved via findInstarRoot() + fs access must ship.
   *
   * Pattern: code does findInstarRoot() or import.meta.url resolution to get
   * the package root, then joins a relative path and reads from disk.
   * If that relative path isn't in the package, npm-installed users get failures
   * or silent degradation.
   */
  it('all runtime-referenced package-root files are included in the package', () => {
    const sourceFiles = getSourceFiles(SRC_DIR);
    const missing: string[] = [];

    // Patterns that resolve paths relative to package root at runtime.
    // Each entry: { pattern, extractRelativePath }
    // We search source code for these patterns and verify the resolved
    // paths exist in the packed output.
    const runtimePathPatterns = [
      // findInstarRoot() + path.join for specific files
      // e.g., path.join(findInstarRoot(), '.claude', 'skills', 'setup-wizard', 'SKILL.md')
      /path\.join\((?:findInstarRoot\(\)|instarRoot),\s*([^)]+)\)/g,
      // import.meta.url resolution walking up to package root, then joining
      // e.g., path.join(moduleDir, 'upgrades', `${version}.md`)
      // e.g., path.resolve(thisDir, '..', '..', 'dashboard')
    ];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf-8');

      // Check for findInstarRoot() + path.join patterns
      // Match the full arguments to path.join, then extract quoted strings
      const instarRootPattern = /path\.join\((?:findInstarRoot\(\)|instarRoot),\s*((?:'[^']*'(?:,\s*)?)+)\)/g;
      let match;
      while ((match = instarRootPattern.exec(content)) !== null) {
        // Extract all quoted string arguments
        const argsStr = match[1];
        const parts: string[] = [];
        const argPattern = /'([^']*)'/g;
        let argMatch;
        while ((argMatch = argPattern.exec(argsStr)) !== null) {
          parts.push(argMatch[1]);
        }
        if (parts.length === 0) continue;

        const relativePath = parts.join('/');

        // Skip dynamic paths (containing template literals or variables)
        if (relativePath.includes('${') || relativePath.includes('...')) continue;

        // Skip paths that point to user project dirs (e.g., .instar/, CLAUDE.md in project)
        if (relativePath.startsWith('.instar/') || relativePath === 'CLAUDE.md') continue;

        // Check if this path (or a parent directory) exists in packed files
        const found = packedFiles.some(f =>
          f === relativePath || f.startsWith(relativePath + '/')
        );

        if (!found) {
          const relFile = path.relative(ROOT, file);
          missing.push(`${relFile}: references "${relativePath}" which is not in the package`);
        }
      }
    }

    if (missing.length > 0) {
      const message = [
        'Runtime code references files that are NOT included in the npm package.',
        'Either add them to package.json "files" or remove the runtime reference.',
        '',
        ...missing,
      ].join('\n');
      expect(missing, message).toEqual([]);
    }
  });

  /**
   * The `files` field in package.json must include every directory that
   * contains files needed at runtime. This is a known-good list that must
   * be explicitly updated when new runtime assets are added.
   */
  it('package.json files field includes all required runtime directories', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const filesField: string[] = pkg.files || [];

    // These directories contain files that runtime code resolves via
    // import.meta.url or findInstarRoot(). If you add a new runtime
    // asset directory, add it here AND to package.json files.
    const requiredDirs = [
      'dist',                           // Compiled JS — the actual code
      'dashboard',                      // Dashboard UI served by AgentServer
      'upgrades',                       // Upgrade guides read by UpgradeGuideProcessor + AutoUpdater
      '.claude/skills/setup-wizard',    // Setup wizard skill loaded by setup.ts
    ];

    const missingDirs = requiredDirs.filter(dir => !filesField.includes(dir));

    if (missingDirs.length > 0) {
      expect(missingDirs, [
        'package.json "files" is missing required runtime directories.',
        'These directories contain files that code resolves at runtime.',
        'Missing: ' + missingDirs.join(', '),
      ].join('\n')).toEqual([]);
    }
  });

  /**
   * Specific file-level checks for critical runtime assets.
   * These are the files that, if missing, cause silent degradation.
   */
  it('critical runtime files are present in packed output', () => {
    const criticalFiles = [
      // Setup wizard — without this, users get manual Telegram setup
      { path: '.claude/skills/setup-wizard/SKILL.md', purpose: 'Conversational setup wizard with Playwright automation' },
      // Dashboard — without this, /dashboard returns 404
      { path: 'dashboard/index.html', purpose: 'Agent dashboard UI' },
      // Package metadata — without this, version detection fails
      { path: 'package.json', purpose: 'Version detection and metadata' },
    ];

    const missing = criticalFiles.filter(f =>
      !packedFiles.some(packed => packed === f.path)
    );

    if (missing.length > 0) {
      const message = missing.map(f =>
        `  MISSING: ${f.path} — ${f.purpose}`
      ).join('\n');
      expect(missing, `Critical runtime files missing from npm package:\n${message}`).toEqual([]);
    }
  });

  /**
   * Guard against .npmignore creating false assumptions.
   *
   * When `files` is present in package.json, .npmignore is completely ignored
   * by npm. But developers may add entries to .npmignore thinking they control
   * what ships. This test ensures .npmignore doesn't contain "include" rules
   * (negation patterns like !.claude/skills/) that aren't backed by the
   * `files` field — because those rules are dead code.
   */
  it('.npmignore negation patterns are backed by package.json files field', () => {
    const npmignorePath = path.join(ROOT, '.npmignore');
    if (!fs.existsSync(npmignorePath)) return; // No .npmignore, no problem

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    if (!pkg.files) return; // No files field, .npmignore is the authority

    const npmignore = fs.readFileSync(npmignorePath, 'utf-8');
    const negationPatterns = npmignore
      .split('\n')
      .filter(line => line.startsWith('!') && !line.startsWith('#'))
      .map(line => line.slice(1).replace(/\/$/, '')); // Remove ! prefix and trailing /

    const filesField: string[] = pkg.files;
    const deadNegations: string[] = [];

    for (const pattern of negationPatterns) {
      // Check if the negation pattern is covered by the files field
      const covered = filesField.some(f =>
        pattern.startsWith(f) || f.startsWith(pattern)
      );
      if (!covered) {
        deadNegations.push(pattern);
      }
    }

    if (deadNegations.length > 0) {
      const message = [
        '.npmignore has negation (include) patterns that are DEAD CODE.',
        'The package.json "files" field overrides .npmignore entirely.',
        'These patterns give a false impression of inclusion:',
        '',
        ...deadNegations.map(p => `  !${p}  (not backed by "files" field)`),
        '',
        'Fix: Either add the directory to package.json "files" or remove',
        'the .npmignore negation to avoid misleading maintainers.',
      ].join('\n');
      expect(deadNegations, message).toEqual([]);
    }
  });

  /**
   * Verify upgrade guides exist and are well-formed.
   * This is a compile-time check that mirrors what check-upgrade-guide.js
   * does at publish time, ensuring we catch issues in tests too.
   */
  it('upgrade guide directory contains well-formed guides', () => {
    const upgradesDir = path.join(ROOT, 'upgrades');
    if (!fs.existsSync(upgradesDir)) {
      expect.fail('upgrades/ directory does not exist');
    }

    const guides = fs.readdirSync(upgradesDir).filter(f => f.endsWith('.md') && f !== 'NEXT.md');
    expect(guides.length).toBeGreaterThan(0);

    const requiredSections = [
      '## What Changed',
      '## What to Tell Your User',
      '## Summary of New Capabilities',
    ];

    const malformed: string[] = [];
    for (const guide of guides) {
      const content = fs.readFileSync(path.join(upgradesDir, guide), 'utf-8');
      const missing = requiredSections.filter(s => !content.includes(s));
      if (missing.length > 0) {
        malformed.push(`${guide}: missing ${missing.join(', ')}`);
      }
      if (content.length < 200) {
        malformed.push(`${guide}: too short (${content.length} chars, min 200)`);
      }
    }

    if (malformed.length > 0) {
      expect(malformed, `Malformed upgrade guides:\n${malformed.join('\n')}`).toEqual([]);
    }
  });
});
