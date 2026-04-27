#!/usr/bin/env node
/**
 * Release Change Analyzer
 *
 * Analyzes the git diff between the last release tag and HEAD to produce
 * an intelligent assessment of what changed and what the version bump should be.
 *
 * This script does THREE things:
 *   1. CLASSIFIES every change by type (feature, fix, refactor, breaking, etc.)
 *   2. DETERMINES the appropriate version bump based on actual code changes
 *   3. VALIDATES the upgrade guide covers all significant changes
 *
 * Exit codes:
 *   0 — Analysis passed, guide adequately covers changes
 *   1 — Guide is missing coverage of significant changes, or bump type is wrong
 *
 * Output:
 *   JSON report to stdout with change classification, recommended bump, and coverage gaps.
 *   Human-readable summary to stderr.
 *
 * Usage:
 *   node scripts/analyze-release.js                    # Full analysis + validation
 *   node scripts/analyze-release.js --json             # JSON report only
 *   node scripts/analyze-release.js --recommend-only   # Just recommend bump type
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const JSON_ONLY = args.includes('--json');
const RECOMMEND_ONLY = args.includes('--recommend-only');

function log(msg) {
  if (!JSON_ONLY) process.stderr.write(msg + '\n');
}

// ── Git Helpers ──────────────────────────────────────────────────────

function getLastReleaseTag() {
  try {
    // safe-git-allow: incremental-migration
    return execSync('git describe --tags --abbrev=0', { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    // No tags at all — diff against the initial commit
    // safe-git-allow: incremental-migration
    return execSync('git rev-list --max-parents=0 HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
  }
}

function getCommitsSinceTag(tag) {
  try {
    // safe-git-allow: incremental-migration
    const raw = execSync(`git log ${tag}..HEAD --oneline --no-merges`, { cwd: ROOT, encoding: 'utf-8' });
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const [hash, ...rest] = line.split(' ');
      return { hash, message: rest.join(' ') };
    });
  } catch {
    return [];
  }
}

function getDiffStat(tag) {
  try {
    // safe-git-allow: incremental-migration
    return execSync(`git diff ${tag}..HEAD --stat`, { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function getChangedFiles(tag) {
  try {
    // safe-git-allow: incremental-migration
    const raw = execSync(`git diff ${tag}..HEAD --name-status`, { cwd: ROOT, encoding: 'utf-8' });
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const [status, ...pathParts] = line.split('\t');
      return { status: status.charAt(0), file: pathParts.join('\t') };
    });
  } catch {
    return [];
  }
}

function getFileDiff(tag, file) {
  try {
    // safe-git-allow: incremental-migration
    return execSync(`git diff ${tag}..HEAD -- "${file}"`, { cwd: ROOT, encoding: 'utf-8' });
  } catch {
    return '';
  }
}

// ── Change Detection ─────────────────────────────────────────────────

/**
 * Analyze route changes — new/modified/removed API endpoints.
 */
function analyzeRouteChanges(tag, changedFiles) {
  const routeFiles = changedFiles.filter(f =>
    f.file.startsWith('src/server/') && f.file.endsWith('.ts')
  );

  const changes = {
    newEndpoints: [],
    removedEndpoints: [],
    modifiedEndpoints: [],
  };

  for (const { file } of routeFiles) {
    const diff = getFileDiff(tag, file);
    const lines = diff.split('\n');

    for (const line of lines) {
      // Match router.get/post/put/delete/patch patterns
      const endpointMatch = line.match(/^[+-]\s*router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/);
      if (endpointMatch) {
        const [, method, path] = endpointMatch;
        const endpoint = `${method.toUpperCase()} ${path}`;

        if (line.startsWith('+')) {
          changes.newEndpoints.push({ endpoint, file });
        } else if (line.startsWith('-')) {
          changes.removedEndpoints.push({ endpoint, file });
        }
      }
    }
  }

  // Endpoints that appear in both added and removed are modifications
  const addedPaths = new Set(changes.newEndpoints.map(e => e.endpoint));
  const removedPaths = new Set(changes.removedEndpoints.map(e => e.endpoint));

  for (const endpoint of addedPaths) {
    if (removedPaths.has(endpoint)) {
      changes.modifiedEndpoints.push({ endpoint });
      changes.newEndpoints = changes.newEndpoints.filter(e => e.endpoint !== endpoint);
      changes.removedEndpoints = changes.removedEndpoints.filter(e => e.endpoint !== endpoint);
    }
  }

  return changes;
}

/**
 * Analyze CLI command changes.
 */
function analyzeCLIChanges(tag, changedFiles) {
  const cliFiles = changedFiles.filter(f =>
    f.file === 'src/cli.ts' || f.file.startsWith('src/commands/')
  );

  const changes = {
    newCommands: [],
    removedCommands: [],
    modifiedCommands: [],
  };

  for (const { file } of cliFiles) {
    const diff = getFileDiff(tag, file);
    const lines = diff.split('\n');

    for (const line of lines) {
      // Match .command('name') patterns
      const cmdMatch = line.match(/^[+-]\s*\.command\s*\(\s*['"`]([^'"`]+)['"`]/);
      if (cmdMatch) {
        const command = cmdMatch[1];
        if (line.startsWith('+')) {
          changes.newCommands.push({ command, file });
        } else if (line.startsWith('-')) {
          changes.removedCommands.push({ command, file });
        }
      }
    }
  }

  return changes;
}

/**
 * Analyze config schema changes.
 */
function analyzeConfigChanges(tag, changedFiles) {
  const configFiles = changedFiles.filter(f =>
    f.file === 'src/core/types.ts' || f.file === 'src/core/Config.ts'
  );

  const changes = {
    newConfigFields: [],
    removedConfigFields: [],
    changedInterfaces: [],
  };

  for (const { file } of configFiles) {
    const diff = getFileDiff(tag, file);
    const lines = diff.split('\n');

    let inInterface = false;
    let currentInterface = '';

    for (const line of lines) {
      // Track interface context
      const ifaceMatch = line.match(/^[+-]?\s*export\s+interface\s+(\w+)/);
      if (ifaceMatch) {
        currentInterface = ifaceMatch[1];
        inInterface = true;
        if (line.startsWith('+')) {
          changes.changedInterfaces.push(currentInterface);
        }
      }

      // Track field additions/removals within interfaces
      if (inInterface) {
        const fieldMatch = line.match(/^([+-])\s+(\w+)\??\s*:/);
        if (fieldMatch) {
          const [, sign, field] = fieldMatch;
          if (sign === '+') {
            changes.newConfigFields.push({ field, interface: currentInterface });
          } else {
            changes.removedConfigFields.push({ field, interface: currentInterface });
          }
        }
      }

      if (line.match(/^[+-]?\s*\}/)) {
        inInterface = false;
      }
    }
  }

  return changes;
}

/**
 * Analyze export changes in index.ts.
 */
function analyzeExportChanges(tag, changedFiles) {
  const indexChanged = changedFiles.some(f => f.file === 'src/index.ts');
  if (!indexChanged) return { newExports: [], removedExports: [] };

  const diff = getFileDiff(tag, 'src/index.ts');
  const lines = diff.split('\n');
  const changes = { newExports: [], removedExports: [] };

  for (const line of lines) {
    const exportMatch = line.match(/^([+-])\s*export\s+(?:type\s+)?{?\s*(\w+)/);
    if (exportMatch) {
      const [, sign, name] = exportMatch;
      if (sign === '+') changes.newExports.push(name);
      else changes.removedExports.push(name);
    }
  }

  return changes;
}

/**
 * Analyze file-level changes for high-level classification.
 */
function analyzeFileChanges(changedFiles) {
  const summary = {
    newFiles: changedFiles.filter(f => f.status === 'A'),
    deletedFiles: changedFiles.filter(f => f.status === 'D'),
    modifiedFiles: changedFiles.filter(f => f.status === 'M'),
    renamedFiles: changedFiles.filter(f => f.status === 'R'),
    srcChanges: changedFiles.filter(f => f.file.startsWith('src/')),
    testChanges: changedFiles.filter(f => f.file.startsWith('tests/')),
    docChanges: changedFiles.filter(f => f.file.endsWith('.md') || f.file.startsWith('docs/')),
    configChanges: changedFiles.filter(f =>
      f.file.endsWith('.json') || f.file.endsWith('.yml') || f.file.endsWith('.yaml')
    ),
    hookChanges: changedFiles.filter(f => f.file.includes('hooks/')),
    templateChanges: changedFiles.filter(f => f.file.includes('templates/')),
    dashboardChanges: changedFiles.filter(f => f.file.startsWith('dashboard/')),
  };

  return summary;
}

/**
 * Classify commits by conventional commit type.
 */
function classifyCommits(commits) {
  const classified = {
    features: [],
    fixes: [],
    refactors: [],
    docs: [],
    tests: [],
    chores: [],
    breaking: [],
    other: [],
  };

  for (const commit of commits) {
    const msg = commit.message.toLowerCase();

    if (msg.startsWith('feat') || msg.includes('add ') || msg.includes('new ')) {
      classified.features.push(commit);
    } else if (msg.startsWith('fix') || msg.includes('fix ') || msg.includes('patch')) {
      classified.fixes.push(commit);
    } else if (msg.startsWith('refactor') || msg.includes('refactor')) {
      classified.refactors.push(commit);
    } else if (msg.startsWith('docs') || msg.startsWith('doc:')) {
      classified.docs.push(commit);
    } else if (msg.startsWith('test') || msg.includes('test')) {
      classified.tests.push(commit);
    } else if (msg.startsWith('chore') || msg.startsWith('bump') || msg.includes('[skip ci]')) {
      classified.chores.push(commit);
    } else {
      classified.other.push(commit);
    }

    // Breaking change markers
    if (msg.includes('breaking') || msg.includes('!:') || msg.includes('removed ')) {
      classified.breaking.push(commit);
    }
  }

  return classified;
}

// ── Bump Type Recommendation ─────────────────────────────────────────

function recommendBumpType(analysis) {
  const { routes, cli, config, exports, files, commits } = analysis;

  // MAJOR indicators
  const majorSignals = [];

  if (routes.removedEndpoints.length > 0) {
    majorSignals.push(`${routes.removedEndpoints.length} API endpoint(s) removed`);
  }
  if (exports.removedExports.length > 0) {
    majorSignals.push(`${exports.removedExports.length} export(s) removed from public API`);
  }
  if (config.removedConfigFields.length > 0) {
    majorSignals.push(`${config.removedConfigFields.length} config field(s) removed`);
  }
  if (commits.breaking.length > 0) {
    majorSignals.push(`${commits.breaking.length} commit(s) marked as breaking`);
  }

  // MINOR indicators
  const minorSignals = [];

  if (routes.newEndpoints.length > 0) {
    minorSignals.push(`${routes.newEndpoints.length} new API endpoint(s)`);
  }
  if (cli.newCommands.length > 0) {
    minorSignals.push(`${cli.newCommands.length} new CLI command(s)`);
  }
  if (exports.newExports.length > 0) {
    minorSignals.push(`${exports.newExports.length} new export(s) added to public API`);
  }
  if (commits.features.length > 0) {
    minorSignals.push(`${commits.features.length} feature commit(s)`);
  }
  if (files.newFiles.filter(f => f.file.startsWith('src/')).length >= 3) {
    minorSignals.push(`${files.newFiles.filter(f => f.file.startsWith('src/')).length} new source files`);
  }

  // PATCH indicators (default)
  const patchSignals = [];

  if (commits.fixes.length > 0) {
    patchSignals.push(`${commits.fixes.length} fix commit(s)`);
  }
  if (commits.refactors.length > 0) {
    patchSignals.push(`${commits.refactors.length} refactor commit(s)`);
  }
  if (commits.tests.length > 0) {
    patchSignals.push(`${commits.tests.length} test commit(s)`);
  }
  if (commits.docs.length > 0) {
    patchSignals.push(`${commits.docs.length} doc commit(s)`);
  }

  // Decision
  let recommended;
  if (majorSignals.length > 0) {
    recommended = 'major';
  } else if (minorSignals.length > 0) {
    recommended = 'minor';
  } else {
    recommended = 'patch';
  }

  return {
    recommended,
    majorSignals,
    minorSignals,
    patchSignals,
  };
}

// ── Upgrade Guide Coverage Validation ────────────────────────────────

function validateGuideCoverage(analysis, guideContent) {
  const gaps = [];

  // Check that new endpoints are mentioned
  for (const { endpoint } of analysis.routes.newEndpoints) {
    const pathPart = endpoint.split(' ')[1]; // e.g., '/evolution/proposals'
    if (!guideContent.includes(pathPart)) {
      gaps.push({
        type: 'missing-endpoint',
        severity: 'high',
        detail: `New endpoint ${endpoint} not mentioned in upgrade guide`,
      });
    }
  }

  // Check that removed endpoints are mentioned (breaking!)
  for (const { endpoint } of analysis.routes.removedEndpoints) {
    const pathPart = endpoint.split(' ')[1];
    if (!guideContent.includes(pathPart)) {
      gaps.push({
        type: 'missing-breaking-change',
        severity: 'critical',
        detail: `Removed endpoint ${endpoint} not mentioned in upgrade guide — agents using this will break`,
      });
    }
  }

  // Check that new CLI commands are mentioned
  for (const { command } of analysis.cli.newCommands) {
    if (!guideContent.includes(command)) {
      gaps.push({
        type: 'missing-command',
        severity: 'medium',
        detail: `New CLI command '${command}' not mentioned in upgrade guide`,
      });
    }
  }

  // Check that removed exports are mentioned
  for (const name of analysis.exports.removedExports) {
    if (!guideContent.includes(name)) {
      gaps.push({
        type: 'missing-removed-export',
        severity: 'high',
        detail: `Removed export '${name}' not mentioned — consumers may break`,
      });
    }
  }

  // Check that new config fields are mentioned
  for (const { field } of analysis.config.newConfigFields) {
    if (!guideContent.includes(field)) {
      gaps.push({
        type: 'missing-config-field',
        severity: 'low',
        detail: `New config field '${field}' not mentioned in upgrade guide`,
      });
    }
  }

  // Check that feature commits are represented
  for (const commit of analysis.commits.features) {
    // Extract the key noun from the commit message
    const keywords = commit.message
      .replace(/^feat[:(]?\s*/i, '')
      .replace(/[()]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 4)
      .slice(0, 3);

    const mentioned = keywords.some(kw =>
      guideContent.toLowerCase().includes(kw.toLowerCase())
    );

    if (!mentioned && keywords.length > 0) {
      gaps.push({
        type: 'missing-feature',
        severity: 'medium',
        detail: `Feature commit "${commit.message}" may not be covered in upgrade guide`,
      });
    }
  }

  return gaps;
}

// ── Change Descriptions (for upgrade guide generation) ───────────────

function generateChangeDescriptions(analysis) {
  const descriptions = [];

  // New endpoints
  for (const { endpoint, file } of analysis.routes.newEndpoints) {
    descriptions.push({
      type: 'feature',
      summary: `New API endpoint: ${endpoint}`,
      detail: `Added in ${file}`,
      agentImpact: 'New capability available via HTTP API',
      userImpact: 'New feature accessible through the agent',
    });
  }

  // Removed endpoints
  for (const { endpoint, file } of analysis.routes.removedEndpoints) {
    descriptions.push({
      type: 'breaking',
      summary: `Removed API endpoint: ${endpoint}`,
      detail: `Removed from ${file}`,
      agentImpact: 'Agents using this endpoint will get 404 errors',
      userImpact: 'Feature no longer available',
    });
  }

  // New CLI commands
  for (const { command } of analysis.cli.newCommands) {
    descriptions.push({
      type: 'feature',
      summary: `New CLI command: instar ${command}`,
      detail: 'New command available from the terminal',
      agentImpact: 'New capability available via CLI',
      userImpact: 'Can be used directly or by the agent',
    });
  }

  // New config fields
  for (const { field, interface: iface } of analysis.config.newConfigFields) {
    descriptions.push({
      type: 'enhancement',
      summary: `New config option: ${field} (${iface})`,
      detail: 'New configuration setting available',
      agentImpact: 'Agent can use this setting to customize behavior',
      userImpact: 'More customization options',
    });
  }

  // Feature commits not captured by structural analysis
  for (const commit of analysis.commits.features) {
    const alreadyCovered = descriptions.some(d =>
      commit.message.toLowerCase().includes(d.summary.toLowerCase().split(':')[1]?.trim() || '___')
    );
    if (!alreadyCovered) {
      descriptions.push({
        type: 'feature',
        summary: commit.message,
        detail: `Commit: ${commit.hash}`,
        agentImpact: 'Review the commit for specifics',
        userImpact: 'Review the commit for user-facing changes',
      });
    }
  }

  // Fix commits
  for (const commit of analysis.commits.fixes) {
    descriptions.push({
      type: 'fix',
      summary: commit.message,
      detail: `Commit: ${commit.hash}`,
      agentImpact: 'Bug fix — previous behavior was incorrect',
      userImpact: 'Improved reliability',
    });
  }

  return descriptions;
}

// ── Main ─────────────────────────────────────────────────────────────

const lastTag = getLastReleaseTag();
const commits = getCommitsSinceTag(lastTag);
const changedFiles = getChangedFiles(lastTag);

if (commits.length === 0) {
  log('No commits since last release tag. Nothing to analyze.');
  process.exit(0);
}

log(`\n  Release Change Analysis`);
log(`  ${'─'.repeat(50)}`);
log(`  Last release: ${lastTag}`);
log(`  Commits since: ${commits.length}`);
log(`  Files changed: ${changedFiles.length}`);

// Run all analyses
const analysis = {
  routes: analyzeRouteChanges(lastTag, changedFiles),
  cli: analyzeCLIChanges(lastTag, changedFiles),
  config: analyzeConfigChanges(lastTag, changedFiles),
  exports: analyzeExportChanges(lastTag, changedFiles),
  files: analyzeFileChanges(changedFiles),
  commits: classifyCommits(commits),
};

// Generate recommendations
const bumpRecommendation = recommendBumpType(analysis);
const changeDescriptions = generateChangeDescriptions(analysis);

log(`\n  Commit Classification:`);
log(`    Features: ${analysis.commits.features.length}`);
log(`    Fixes:    ${analysis.commits.fixes.length}`);
log(`    Refactors: ${analysis.commits.refactors.length}`);
log(`    Tests:    ${analysis.commits.tests.length}`);
log(`    Docs:     ${analysis.commits.docs.length}`);
log(`    Breaking: ${analysis.commits.breaking.length}`);

log(`\n  Structural Changes:`);
log(`    New endpoints:     ${analysis.routes.newEndpoints.length}`);
log(`    Removed endpoints: ${analysis.routes.removedEndpoints.length}`);
log(`    New CLI commands:  ${analysis.cli.newCommands.length}`);
log(`    New config fields: ${analysis.config.newConfigFields.length}`);
log(`    New exports:       ${analysis.exports.newExports.length}`);
log(`    Removed exports:   ${analysis.exports.removedExports.length}`);

log(`\n  Recommended Bump: ${bumpRecommendation.recommended.toUpperCase()}`);
if (bumpRecommendation.majorSignals.length > 0) {
  log(`    Major signals:`);
  for (const s of bumpRecommendation.majorSignals) log(`      - ${s}`);
}
if (bumpRecommendation.minorSignals.length > 0) {
  log(`    Minor signals:`);
  for (const s of bumpRecommendation.minorSignals) log(`      - ${s}`);
}
if (bumpRecommendation.patchSignals.length > 0) {
  log(`    Patch signals:`);
  for (const s of bumpRecommendation.patchSignals) log(`      - ${s}`);
}

if (RECOMMEND_ONLY) {
  console.log(bumpRecommendation.recommended);
  process.exit(0);
}

// ── Guide Coverage Validation ────────────────────────────────────────

let exitCode = 0;
let guideCoverage = { gaps: [], guideFound: false };

// Find the upgrade guide (check both NEXT.md and version-specific)
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkg.version;
const guidePath = path.join(ROOT, 'upgrades', `${version}.md`);
const nextPath = path.join(ROOT, 'upgrades', 'NEXT.md');

let guideContent = '';
let guideFile = '';

if (fs.existsSync(guidePath)) {
  guideContent = fs.readFileSync(guidePath, 'utf-8');
  guideFile = `upgrades/${version}.md`;
} else if (fs.existsSync(nextPath)) {
  guideContent = fs.readFileSync(nextPath, 'utf-8');
  guideFile = 'upgrades/NEXT.md';
}

if (guideContent) {
  guideCoverage.guideFound = true;
  guideCoverage.gaps = validateGuideCoverage(analysis, guideContent);

  // Check declared bump type against recommendation
  const declaredMatch = /<!--\s*bump:\s*(patch|minor|major)\s*-->/.exec(guideContent);
  const declaredBump = declaredMatch ? declaredMatch[1] : null;

  if (declaredBump && declaredBump !== bumpRecommendation.recommended) {
    // Only block if the recommendation is MORE severe
    const severity = { patch: 0, minor: 1, major: 2 };
    if (severity[bumpRecommendation.recommended] > severity[declaredBump]) {
      guideCoverage.gaps.push({
        type: 'bump-mismatch',
        severity: 'critical',
        detail: `Guide declares "${declaredBump}" but analysis recommends "${bumpRecommendation.recommended}": ${
          bumpRecommendation.recommended === 'major'
            ? bumpRecommendation.majorSignals.join(', ')
            : bumpRecommendation.minorSignals.join(', ')
        }`,
      });
    }
  }

  const criticalGaps = guideCoverage.gaps.filter(g => g.severity === 'critical');
  const highGaps = guideCoverage.gaps.filter(g => g.severity === 'high');

  if (criticalGaps.length > 0 || highGaps.length > 0) {
    log(`\n  ✗ Upgrade guide coverage issues found:`);
    for (const gap of [...criticalGaps, ...highGaps]) {
      log(`    [${gap.severity.toUpperCase()}] ${gap.detail}`);
    }
    exitCode = 1;
  }

  const mediumGaps = guideCoverage.gaps.filter(g => g.severity === 'medium');
  const lowGaps = guideCoverage.gaps.filter(g => g.severity === 'low');

  if (mediumGaps.length > 0 || lowGaps.length > 0) {
    log(`\n  ⚠ Advisory coverage gaps:`);
    for (const gap of [...mediumGaps, ...lowGaps]) {
      log(`    [${gap.severity}] ${gap.detail}`);
    }
  }

  if (guideCoverage.gaps.length === 0) {
    log(`\n  ✓ Upgrade guide adequately covers all detected changes.`);
  }
} else {
  log(`\n  ⚠ No upgrade guide found — cannot validate coverage.`);
}

// ── Output Report ────────────────────────────────────────────────────

const report = {
  lastTag,
  commitCount: commits.length,
  fileCount: changedFiles.length,
  analysis: {
    routes: analysis.routes,
    cli: analysis.cli,
    config: analysis.config,
    exports: analysis.exports,
    commitClassification: {
      features: analysis.commits.features.length,
      fixes: analysis.commits.fixes.length,
      refactors: analysis.commits.refactors.length,
      tests: analysis.commits.tests.length,
      docs: analysis.commits.docs.length,
      breaking: analysis.commits.breaking.length,
    },
    fileClassification: {
      newFiles: analysis.files.newFiles.length,
      deletedFiles: analysis.files.deletedFiles.length,
      modifiedFiles: analysis.files.modifiedFiles.length,
      srcChanges: analysis.files.srcChanges.length,
      testChanges: analysis.files.testChanges.length,
    },
  },
  recommendation: bumpRecommendation,
  changeDescriptions,
  guideCoverage: {
    guideFile,
    guideFound: guideCoverage.guideFound,
    gaps: guideCoverage.gaps,
    criticalGaps: guideCoverage.gaps.filter(g => g.severity === 'critical').length,
    highGaps: guideCoverage.gaps.filter(g => g.severity === 'high').length,
  },
};

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2));
} else {
  log(`\n  Change Descriptions (${changeDescriptions.length} items):`);
  for (const desc of changeDescriptions) {
    log(`    [${desc.type}] ${desc.summary}`);
  }
  log('');
}

process.exit(exitCode);
