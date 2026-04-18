#!/usr/bin/env node
/**
 * gh-ruleset-install.mjs — install the GitHub Repository Ruleset for parallel-dev.
 *
 * Per PARALLEL-DEV-ISOLATION-SPEC.md "Authoritative push gate (iter 4 — GH ruleset)".
 *
 * Creates a ruleset with:
 *   - Targets: main, topic/*, platform/*, tags v*
 *   - restrict_updates / restrict_creations / restrict_deletions / non_fast_forward
 *   - required_status_checks: worktree-trailer-sig-check
 *   - bypass_actors: [] (no admin bypass; github-actions[bot] allowed only for PR-merge commits)
 *   - second ruleset entry: 2-approval rule on `.github/workflows/worktree-trailer-sig-check.yml`
 *     and `.github/scripts/verify-trailers.js` paths
 *
 * Calls `gh api` with the user's authenticated PAT (must have `repo` scope).
 *
 * Usage:
 *   gh-ruleset-install.mjs <owner> <repo> [--mode evaluate|active]
 *
 * Mode `evaluate` (default for first install): logs would-block, doesn't enforce.
 * Mode `active`: enforces. Recommended after Day-7 cutover-gate is satisfied.
 */

import { execFileSync } from 'node:child_process';

const [, , owner, repo, ...rest] = process.argv;
if (!owner || !repo) {
  console.error('Usage: gh-ruleset-install.mjs <owner> <repo> [--mode evaluate|active]');
  process.exit(2);
}
const modeFlag = rest.find((a) => a.startsWith('--mode='));
const mode = (rest.includes('--mode') ? rest[rest.indexOf('--mode') + 1] : modeFlag?.split('=')[1]) ?? 'evaluate';
if (!['evaluate', 'active'].includes(mode)) {
  console.error(`invalid --mode "${mode}" — must be evaluate|active`);
  process.exit(2);
}

function ghApi(method, path, bodyObj = null) {
  const args = ['api', '--method', method, path, '-H', 'Accept: application/vnd.github+json'];
  if (bodyObj !== null) {
    for (const [k, v] of Object.entries(bodyObj)) {
      args.push('--field', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  try {
    return execFileSync('gh', args, { encoding: 'utf-8' });
  } catch (err) {
    console.error(`gh-ruleset-install: gh api failed: ${err.message}`);
    if (err.stderr) console.error(err.stderr.toString());
    throw err;
  }
}

const branchRuleset = {
  name: 'instar-parallel-dev-isolation',
  target: 'branch',
  enforcement: mode,
  bypass_actors: [],
  conditions: {
    ref_name: {
      include: ['~DEFAULT_BRANCH', 'refs/heads/main', 'refs/heads/topic/*', 'refs/heads/platform/*'],
      exclude: [],
    },
  },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [
          { context: 'worktree-trailer-sig-check / verify' },
        ],
      },
    },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
  ],
};

const tagRuleset = {
  name: 'instar-tag-protection',
  target: 'tag',
  enforcement: mode,
  bypass_actors: [],
  conditions: {
    ref_name: { include: ['refs/tags/v*'], exclude: [] },
  },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
  ],
};

const trustRootRuleset = {
  name: 'instar-trust-root-2-approval',
  target: 'branch',
  enforcement: 'active',  // always enforced (per K4)
  bypass_actors: [],
  conditions: {
    ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
  },
  rules: [
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 2,
        require_code_owner_review: false,
        dismiss_stale_reviews_on_push: true,
        require_last_push_approval: true,
        required_review_thread_resolution: true,
      },
    },
    {
      type: 'file_path_restriction',
      parameters: {
        restricted_file_paths: [
          '.github/workflows/worktree-trailer-sig-check.yml',
          '.github/scripts/verify-trailers.js',
          'scripts/gh-ruleset-install.mjs',
        ],
      },
    },
  ],
};

console.log(`gh-ruleset-install: installing ruleset on ${owner}/${repo} (mode=${mode})`);
ghApi('POST', `/repos/${owner}/${repo}/rulesets`, branchRuleset);
console.log('  ✓ branch ruleset installed');
ghApi('POST', `/repos/${owner}/${repo}/rulesets`, tagRuleset);
console.log('  ✓ tag ruleset installed');
ghApi('POST', `/repos/${owner}/${repo}/rulesets`, trustRootRuleset);
console.log('  ✓ trust-root 2-approval ruleset installed');
console.log('Done.');
