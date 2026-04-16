#!/usr/bin/env node
/**
 * write-trace.mjs — emit an instar-dev trace file.
 *
 * Called by the /instar-dev skill at Phase 6 (commit-time) after the
 * side-effects artifact is complete. The pre-commit hook reads the trace
 * to verify the commit came through the skill.
 *
 * Usage:
 *   node skills/instar-dev/scripts/write-trace.mjs \
 *     --artifact upgrades/side-effects/<slug>.md \
 *     --files "src/a.ts,src/b.ts,tests/x.test.ts" \
 *     [--spec docs/specs/<slug>.md] \
 *     [--second-pass true|false|not-required] \
 *     [--reviewer-concurred true|false]
 *
 * The --spec argument records which spec (converged + approved) drove the
 * change. The pre-commit hook verifies the referenced spec has both
 * review-convergence and approved tags before allowing the commit.
 * Bootstrap commits (installing /instar-dev itself or /spec-converge itself)
 * may omit --spec; all other commits REQUIRE it.
 *
 * The trace is written to .instar/instar-dev-traces/<timestamp>-<slug>.json.
 * Trace files are gitignored (runtime state, not source).
 *
 * Exit codes:
 *   0 — trace written, prints its path to stdout
 *   1 — usage error or artifact missing
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { artifact: null, files: [], spec: null, secondPass: 'not-required', reviewerConcurred: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--artifact') out.artifact = args[++i];
    else if (a === '--files') out.files = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--spec') out.spec = args[++i];
    else if (a === '--second-pass') out.secondPass = args[++i];
    else if (a === '--reviewer-concurred') out.reviewerConcurred = args[++i] === 'true';
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!out.artifact) {
    console.error('Missing --artifact');
    process.exit(1);
  }
  if (out.files.length === 0) {
    console.error('Missing --files');
    process.exit(1);
  }
  return out;
}

const { artifact, files, spec, secondPass, reviewerConcurred } = parseArgs();

const artifactPath = path.resolve(ROOT, artifact);
if (!fs.existsSync(artifactPath)) {
  console.error(`Artifact not found: ${artifact}`);
  process.exit(1);
}
const artifactContent = fs.readFileSync(artifactPath, 'utf8');
if (artifactContent.trim().length < 200) {
  console.error(`Artifact appears empty or stub (${artifactContent.trim().length} chars): ${artifact}`);
  process.exit(1);
}

const slug = path.basename(artifact, path.extname(artifact));
const timestamp = new Date().toISOString();
const traceId = crypto.randomBytes(4).toString('hex');
const traceDir = path.join(ROOT, '.instar', 'instar-dev-traces');
fs.mkdirSync(traceDir, { recursive: true });

const traceFile = path.join(traceDir, `${timestamp.replace(/[:.]/g, '-')}-${slug}-${traceId}.json`);
const trace = {
  version: 2,
  sessionId: process.env.INSTAR_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || 'unknown',
  timestamp,
  artifactPath: artifact,
  artifactSha256: crypto.createHash('sha256').update(artifactContent).digest('hex'),
  specPath: spec,
  coveredFiles: files.sort(),
  phase: 'complete',
  secondPass,
  reviewerConcurred,
};

fs.writeFileSync(traceFile, JSON.stringify(trace, null, 2) + '\n');

console.log(path.relative(ROOT, traceFile));
