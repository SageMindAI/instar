#!/usr/bin/env node
/**
 * Pre-publish upgrade guide check + finalization.
 *
 * Every release must ship with an upgrade guide so agents understand
 * what changed and can relay meaningful context to users.
 *
 * This script does TWO things:
 *   1. VALIDATES the guide exists, is well-formed, and has required sections
 *   2. FINALIZES the guide by renaming NEXT.md → {version}.md
 *      (the "CI rename step" that was previously missing)
 *
 * After finalization, a fresh NEXT.md template is created so the NEXT
 * publish is blocked until new content is written.
 *
 * Workflow:
 *   1. Developer writes `upgrades/NEXT.md` alongside code changes
 *   2. Version is bumped in package.json
 *   3. `npm publish` triggers `prepublishOnly` which runs this script
 *   4. Script validates NEXT.md → renames to {version}.md → creates template
 *   5. Published package contains the versioned guide
 *   6. Agent's UpgradeGuideProcessor finds the versioned file and delivers it
 *   7. UpgradeNotifyManager spawns a session to notify the user
 *
 * Required sections in every guide:
 *   - "## What Changed" — technical description for the agent
 *   - "## What to Tell Your User" — user-facing narrative the agent relays
 *   - "## Summary of New Capabilities" — concise list for MEMORY.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_SECTIONS,
  NEXT_TEMPLATE,
  validateGuideContent,
  parseBumpType,
} from './upgrade-guide-validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkg.version;
const guidePath = path.join(ROOT, 'upgrades', `${version}.md`);
const nextPath = path.join(ROOT, 'upgrades', 'NEXT.md');
const guideExists = fs.existsSync(guidePath);
const nextExists = fs.existsSync(nextPath);

/**
 * Validate a guide file. Thin wrapper around validateGuideContent that handles
 * the file read.
 */
function validateGuide(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return validateGuideContent(content);
}

/**
 * Determine what kind of version bump actually happened
 * by comparing the new version against the latest published version.
 */
function detectActualBump(newVersion, latestPublished) {
  if (!latestPublished) return null; // Can't determine

  const [newMaj, newMin, newPatch] = newVersion.split('.').map(Number);
  const [pubMaj, pubMin, pubPatch] = latestPublished.split('.').map(Number);

  if (newMaj > pubMaj) return 'major';
  if (newMin > pubMin) return 'minor';
  if (newPatch > pubPatch) return 'patch';
  return null; // Same or downgrade
}

/**
 * Get the latest published version from the upgrades/ directory.
 * This is the highest versioned guide file, which approximates the last published version.
 */
function getLatestPublishedVersion() {
  if (!fs.existsSync(upgradesDir)) return null;

  const versions = fs.readdirSync(upgradesDir)
    .map(f => /^(\d+)\.(\d+)\.(\d+)\.md$/.exec(f))
    .filter(Boolean)
    .map(m => ({ str: `${m[1]}.${m[2]}.${m[3]}`, parts: [+m[1], +m[2], +m[3]] }))
    .filter(v => v.str !== version) // Exclude current version — we want the PREVIOUS latest
    .sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
      }
      return 0;
    });

  return versions.length > 0 ? versions[versions.length - 1].str : null;
}

/**
 * Validate that the declared bump type matches the actual version change.
 * Returns warnings (not errors) — advisory, not blocking.
 */
function validateBumpType(content) {
  const warnings = [];
  const declaredBump = parseBumpType(content);

  if (!declaredBump) {
    warnings.push('No <!-- bump: TYPE --> declaration found. Add one (patch, minor, or major) to declare the scope of changes.');
    return warnings;
  }

  const latestPublished = getLatestPublishedVersion();
  if (!latestPublished) return warnings; // Can't validate without history

  const actualBump = detectActualBump(version, latestPublished);

  if (!actualBump) return warnings; // Same version or can't determine

  if (declaredBump === 'minor' && actualBump === 'patch') {
    warnings.push(
      `Guide declares "bump: minor" but version ${version} is only a PATCH bump from ${latestPublished}.` +
      ` New features and APIs should use a minor version bump (e.g., npm version minor).`
    );
  } else if (declaredBump === 'major' && actualBump !== 'major') {
    warnings.push(
      `Guide declares "bump: major" but version ${version} is not a major bump from ${latestPublished}.` +
      ` Breaking changes should use a major version bump (e.g., npm version major).`
    );
  } else if (declaredBump === 'patch' && actualBump === 'minor') {
    // This is fine — minor bump for a patch is conservative, not wrong
  }

  // The key enforcement: if the content describes new features but declares "patch"
  const hasNewFeatures = /new (api|endpoint|feature|command|capability)/i.test(content) ||
    /\bPOST\b.*\/\w+/.test(content) ||
    /\bGET\b.*\/\w+/.test(content);

  if (declaredBump === 'patch' && hasNewFeatures && actualBump === 'patch') {
    warnings.push(
      `Guide declares "bump: patch" but appears to describe new features/APIs.` +
      ` New capabilities should be a MINOR version bump. Consider: npm version minor`
    );
  }

  return warnings;
}

/**
 * Finalize NEXT.md → {version}.md and create fresh template.
 */
function finalizeGuide() {
  // Rename NEXT.md to versioned file
  fs.renameSync(nextPath, guidePath);
  console.log(`  Finalized: NEXT.md → ${version}.md`);

  // Update the H1 header to include the actual version
  let content = fs.readFileSync(guidePath, 'utf-8');
  content = content.replace(/^# Upgrade Guide — vNEXT$/m, `# Upgrade Guide — v${version}`);
  fs.writeFileSync(guidePath, content);

  // Create fresh NEXT.md template for the next release
  fs.writeFileSync(nextPath, NEXT_TEMPLATE);
  console.log(`  Created fresh NEXT.md template for next release`);
}

// ── Report ──────────────────────────────────────────────────────────

console.log(`\n  Upgrade Guide Check — v${version}`);
console.log(`  ${'─'.repeat(40)}`);
console.log(`  Guide (${version}.md): ${guideExists ? 'YES' : 'NO'}`);
console.log(`  NEXT.md fallback:     ${nextExists ? 'YES' : 'NO'}`);

// Validate all existing guides (informational — doesn't block)
const upgradesDir = path.join(ROOT, 'upgrades');
let malformedGuides = [];

if (fs.existsSync(upgradesDir)) {
  const guideFiles = fs.readdirSync(upgradesDir).filter(f => f.endsWith('.md') && f !== 'NEXT.md');
  for (const file of guideFiles) {
    const issues = validateGuide(path.join(upgradesDir, file));
    if (issues.length > 0) {
      malformedGuides.push({ file, issues });
    }
  }
}

if (malformedGuides.length > 0) {
  console.log(`\n  Warning: ${malformedGuides.length} existing guide(s) have issues:`);
  for (const { file, issues } of malformedGuides) {
    console.log(`    ${file}: ${issues.join(', ')}`);
  }
}

// ── Enforce ─────────────────────────────────────────────────────────

let exitCode = 0;

if (guideExists) {
  // Version-specific guide already exists (manually created or previously finalized)
  const issues = validateGuide(guidePath);
  if (issues.length > 0) {
    console.log(`\n  ERROR: Guide for v${version} exists but is malformed:`);
    for (const issue of issues) {
      console.log(`    - ${issue}`);
    }
    exitCode = 1;
  } else {
    console.log(`\n  ✓ Upgrade guide validated for v${version}.`);
    // Advisory: check version bump type
    const content = fs.readFileSync(guidePath, 'utf-8');
    const bumpWarnings = validateBumpType(content);
    if (bumpWarnings.length > 0) {
      console.log(`\n  ⚠ Version bump advisory:`);
      for (const w of bumpWarnings) {
        console.log(`    ${w}`);
      }
    }
  }
} else if (nextExists) {
  // NEXT.md exists — validate it, then finalize (rename → version file)
  const issues = validateGuide(nextPath);
  if (issues.length > 0) {
    console.log(`\n  ERROR: NEXT.md exists but is malformed:`);
    for (const issue of issues) {
      console.log(`    - ${issue}`);
    }
    console.log(`\n  Fix the issues above before publishing.`);
    exitCode = 1;
  } else {
    // Check version bump type BEFORE finalizing (advisory, not blocking)
    const content = fs.readFileSync(nextPath, 'utf-8');
    const bumpWarnings = validateBumpType(content);

    // Validation passed — finalize the guide
    finalizeGuide();
    console.log(`\n  ✓ Upgrade guide finalized and validated for v${version}.`);
    console.log(`  The published package will include upgrades/${version}.md`);
    console.log(`  Agents will receive this guide on their next update.`);

    if (bumpWarnings.length > 0) {
      console.log(`\n  ⚠ Version bump advisory:`);
      for (const w of bumpWarnings) {
        console.log(`    ${w}`);
      }
      console.log(`\n  Consider aborting and re-versioning if the bump type is wrong.`);
      console.log(`  Semver policy: patch = fixes, minor = features, major = breaking`);
    }
  }
} else {
  // No guide at all — block the publish
  console.log(`\n  ERROR: No upgrade guide found for v${version}.`);
  console.log(`  Every release must include an upgrade guide so agents understand what changed.`);
  console.log(`\n  Create: upgrades/NEXT.md`);
  console.log(`  Required sections:`);
  for (const section of REQUIRED_SECTIONS) {
    console.log(`    - ${section}`);
  }
  console.log(`\n  The guide should tell the story of what changed, how it improves the`);
  console.log(`  user's experience, and what it means for the agent. This is how agents`);
  console.log(`  learn about updates and relay meaningful context to their users.`);
  console.log(`\n  Tip: Write the guide WHILE you're building the feature, not after.`);
  console.log(`  The "What to Tell Your User" section is especially important — it's`);
  console.log(`  the narrative the agent will relay to their human.`);
  exitCode = 1;
}

console.log('');
process.exit(exitCode);
