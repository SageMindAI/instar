# Side-Effects Review — Shard CI unit tests across 4 parallel runners

**Version / slug:** `ci-shard-unit-tests`
**Date:** `2026-04-19`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`.github/workflows/ci.yml` unit-test job is extended to run the pre-push test suite across 4 vitest shards per Node version, using vitest's built-in `--shard=N/M` file-partitioning. The matrix changes from `{ node-version: [20, 22] }` (2 runners, each ~9½ min serial) to `{ node-version: [20, 22], shard: [1,2,3,4] }` (8 runners, each ~2½ min serial inside its shard). `fileParallelism: false` in `vitest.push.config.ts` stays untouched — each shard still runs its files one-at-a-time to preserve the port / SQLite / npm isolation that commit `002a463` established. `fail-fast: false` is added so one flaky shard doesn't kill the others. Expected impact on CI wall-clock: unit-test phase 9½ min → ~3 min, which pulls overall PR-CI time from ~12 min toward ~5-6 min (next bottleneck becomes integration/e2e). Only file touched: `.github/workflows/ci.yml`.

## Decision-point inventory

- `ci.yml.unit` — **modify** — job matrix gains a `shard` dimension; test runner invoked with `--shard=${{ matrix.shard }}/4`.

No runtime / agent-behavior decision points touched.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface on message flow — over-block not applicable in the runtime sense.

In the CI sense: the change runs *exactly the same* set of tests as before, just partitioned across 4 runners per Node version. Vitest's sharding is deterministic and disjoint — the union of `--shard=1/4 … 4/4` is the full include set. A commit that passed unsharded would pass sharded. No new rejection surface.

---

## 2. Under-block

**What failure modes does this still miss?**

Same as before: anything `test:push` doesn't cover (the flaky-exclusion list in `vitest.push.config.ts` is unchanged — the same ~30 files that were excluded as flaky remain excluded; full suite still runs separately via `npm test` and is not part of CI gating). No new under-block introduced by this change.

One theoretical concern: if the shard hash assignment is not stable across vitest versions, a file could disappear from all shards after a vitest upgrade. This is vanishingly unlikely in practice because vitest's shard algorithm is documented and stable; the union is enforced by the CLI. If we ever suspect it, a simple sanity check is to run with `--shard=` omitted and compare the test count.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. File-level parallelism was disabled in `vitest.push.config.ts` because tests spawn HTTP servers, SQLite DBs, and real npm operations that collide when running in the same process pool (see commit `002a463`). Sharding at the CI-runner level (one process per shard on its own VM) sidesteps that collision entirely — each shard has its own ports, own filesystem, own npm cache — without re-enabling in-process parallelism. This is the right layer: the isolation problem was resource-contention across a single machine's pool; moving to multiple machines solves the resource contention without touching the isolation invariant.

Signal/authority lens: not applicable. CI test-pass is still an authority-grade signal computed over the same logical test set; we're just distributing the computation.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface on message flow or agent behavior.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic.

CI sharding is a runtime-distribution change. The test suite itself is unchanged — same authority (the full union of tests), same verdict logic (all must pass), just faster. Signal-vs-authority domain untouched.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** `unit` is a `needs:` target for `integration`, `e2e`, `contract`, and `build`. GitHub Actions' default behavior when a `needs:` target is a matrix is to wait for **all** combinations to succeed before downstream jobs run. With 8 combinations (2 node × 4 shard), downstream jobs now wait for all 8 instead of 2. This is a stricter gate, not weaker. No shadowing introduced.
- **Double-fire:** n/a — the old 2-runner unit matrix was the only thing that ran tests. The new 8-runner matrix replaces it; total test-run count remains "once per Node × shard" (1 per runner).
- **Races:** each shard runs in its own ephemeral GitHub-hosted runner VM. No shared filesystem, no shared ports, no shared npm cache across shards. No race surface.
- **Feedback loops:** none. CI result feeds into PR-level required status checks, unchanged by this.

One behavioral nuance worth noting: with `fail-fast: false`, a PR that has genuinely broken tests will now consume 8 runners (all reporting the same failure) instead of 2. Cost is small (GitHub-hosted free minutes; we're not anywhere near the cap), and the upside is clearer diagnostic signal — if only shard-3 fails, the problem is isolated; if all 8 fail, the problem is universal.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** no.
- **Other users of the install base:** no runtime behavior change. The shipped package is identical byte-for-byte.
- **External systems:** GitHub Actions runs more matrix combinations. Cost impact for public repos on GitHub-hosted free runners: negligible — Actions minutes are free for public repos. If a private fork is on a paid plan, the extra 6 runners per CI run will show up in billing; flag to callers who fork.
- **Persistent state:** none touched.
- **Status check names:** the job name becomes `Unit Tests (node 20, shard 1/4)` etc. instead of `Unit Tests (20)`. Only required status check in the branch ruleset today is `verify`; `Unit Tests` matrix jobs are **not** required checks (confirmed via `gh api repos/JKHeadley/instar/rules/branches/main` on 2026-04-19). So the rename does not break branch protection. If a watcher tool or dashboard specifically hardcoded `Unit Tests (20)` / `Unit Tests (22)` as an expected name, it would need updating — unlikely, but captured here.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivial. Revert the single `.github/workflows/ci.yml` change — restore the 2-runner matrix and the original `name:` / `run:` lines. No persistent state. No downstream code affected. Worst realistic "wrong" outcome: the shard hash algorithm has a pathological case that leaves one shard with most of the heavy tests, so the wall-clock win is smaller than projected. That's an optimization miss, not a correctness failure — still faster than pre-change, and the remediation is increasing shard count (6 or 8) rather than reverting. Full revert cost: one commit, no migration, no user impact.

---

## Conclusion

Pure CI distribution change with no runtime surface, no decision-point surface, no signal/authority interaction. Preserves the isolation invariant from commit `002a463` by sharding at the runner level instead of re-enabling in-process parallelism. Expected wall-clock win on unit-test phase: 9½ min → ~3 min; overall CI: ~12 min → ~5-6 min (next bottleneck likely integration/e2e, captured as follow-up). Rollback is one revert. Cleared to ship.

---

## Evidence pointers

- Root cause of current serial execution: commit `002a463` (2026-02-28) — "fix(test): disable file parallelism to prevent lock contention". Confirms the isolation problem is real and resource-contention-based; sharding at the VM level is the right remediation.
- Shard algorithm: [vitest docs — CLI `--shard`](https://vitest.dev/guide/cli.html) — deterministic file-path hash distribution; union of all shards equals the full include set.
- Required-check topology: `gh api repos/JKHeadley/instar/rules/branches/main` (2026-04-19) shows only `verify` as a required context. Unit-test matrix jobs are observed green on recent PRs but are not ruleset-required.
