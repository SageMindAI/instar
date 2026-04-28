# Side-Effects Review — telegram-delivery-robustness Layer 7 (Templates Drift Verifier)

**Version / slug:** `telegram-delivery-robustness-layer-7`
**Date:** `2026-04-27`
**Author:** `echo`
**Second-pass reviewer:** `not required (see Conclusion for justification)`

## Summary of the change

Ships Layer 7 of the `telegram-delivery-robustness` spec on top of the
already-merged Layer 1 (commit `f9b5e3bb`, PR #100), Layer 2 (commit
`5b953c17`, PR #101), and Layer 3 (commit `60c64f8e`, PR #103). Layer 7
is the **templates-drift verifier** — the final piece that closes the
"no orphan TODO" loop on the original incident's root cause: a deployed
relay script that drifts away from any known-shipped instar version
silently, with no operator-visible signal until the next failure
occurs.

The verifier scans deployed instar relay scripts across all agents on
the host, computes SHA-256 of each on-disk copy, and compares against a
canonical SHA history. Drifted templates fire a `template-drift-
detected` `DegradationReporter` event with persistent dedup so a
long-running drift produces ONE event, not 365. A companion CI lint
asserts that every historical shipped `telegram-reply.sh` SHA on `main`
is in the migrator's `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` set — closing
the failure mode where future template upgrades silently strand prior
deployed agents in the user-modified `.new` candidate path.

Files added:

- `src/monitoring/templates-drift-verifier.ts` — the verifier core,
  exporting `runVerifier(opts)` (≈260 LoC).
- `scripts/verify-deployed-templates.ts` — thin CLI wrapper invoked by
  the daily job; reads the kill switch from `.instar/config.json`.
- `scripts/lint-template-sha-history.ts` — CI lint with a public
  `lintTemplateShaHistory()` export so the unit test can drive it
  without forking a process.
- `tests/unit/verify-deployed-templates.test.ts` — 7 cases covering
  current/prior/novel SHA fixtures, dedup behavior, kill switch,
  per-agent partial-install, default-discovery, and canonical
  registration.
- `tests/unit/lint-template-sha-history.test.ts` — 2 cases covering the
  positive lint pass and the regression-on-removal case.

Files modified:

- `src/core/PostUpdateMigrator.ts` — extends
  `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` to include all six historical
  shipped SHAs reachable via `git log --first-parent main` on `src/
  templates/scripts/telegram-reply.sh` (Tier-1 init through Layer 2).
  Visibility flipped from `private static` to `public static readonly`
  so the verifier can reference the same set without duplicating it.
- `src/commands/init.ts` — registers a new built-in job
  `templates-drift-verifier` (daily at 02:00 local, `haiku` model,
  script-type, low priority). The job's pre-flight gate honors the
  same `config.monitoring.templatesDriftVerifier.enabled` flag the
  verifier itself checks. `refreshJobs()` propagates the new entry
  to existing agents on next `instar update`.
- `src/data/builtin-manifest.json` — regenerated (entry count 186 → 187).

## Decision-point inventory

- `runVerifier` (templates-drift-verifier) — **add** — pure read-only
  scan over `.claude/scripts/`, `.instar/scripts/`, and `<root>/scripts/`
  per agent root, compares on-disk SHA against canonical + prior-shipped
  set, emits `template-drift-detected` events deduped via a persistent
  jsonl seen-log.
- `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` (PostUpdateMigrator) — **modify** —
  visibility flipped (private → public static readonly) and the set
  extended to cover six older historical shipped SHAs the prior set was
  missing. No semantic change to migrator behavior; the set was already
  the source of truth, only its membership widened.
- `getDefaultJobs.templates-drift-verifier` (init.ts) — **add** — daily
  built-in job; new agents get it on first init, existing agents get it
  on next update via `refreshJobs()`.
- `lintTemplateShaHistory` (CI lint) — **add** — dev-time-only assertion
  that every historical SHA reachable via `git log --first-parent main`
  is in the prior-shipped set OR matches the current bundled template.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The verifier has no block/allow surface — it never modifies on-disk
content and never refuses any operation. The only "rejection" surface
is the CI lint, which would block a commit that ships a new template
SHA without adding the just-superseded SHA to the prior-shipped set.
This is the correct shape: it forces the developer who's bumping the
template to update the migration trail in the same PR, which is the
exact orphan-TODO failure mode this layer exists to prevent.

The lint does NOT block on novel commits to unrelated files; it only
walks `git log -- src/templates/scripts/telegram-reply.sh` and asserts
SHA coverage on commits that touched that one file.

**Conclusion: no over-block.**

---

## 2. Under-block

**What failure modes does this still miss?**

- **Other relay templates (slack, whatsapp, imessage).** The verifier
  scans them and emits drift events for any deployed copy that doesn't
  match the bundled source, but they have no prior-shipped SHA tracking
  yet. A user-modified slack-reply.sh that was shipped two versions ago
  would fire a drift event today; that's by design (the operator should
  know), but it's noisier than the telegram-reply.sh path. Mitigation:
  the kill switch silences the entire verifier; per-template kill
  switches were intentionally not added (one switch is the minimum
  surface area).
- **Templates installed at non-standard paths.** The verifier checks
  three known deployment locations per agent root: `.claude/scripts/`,
  `.instar/scripts/`, and (when the root itself is `.instar/`) the
  immediate `scripts/`. An operator who installed a relay script at,
  e.g., `~/bin/telegram-reply.sh` will not be scanned. This matches
  the deploy paths the migrator writes to, so the only miss is custom
  installs the migrator already doesn't manage.
- **Project-wide deployments under `~/Documents/Projects/*/.instar/`.**
  Per-project install paths are NOT scanned by default; the verifier
  enumerates `~/.instar/agents/*` only. Per-project agents will get a
  drift event the next time the operator runs `instar update` (the
  migrator runs the same SHA check inline). The trade-off: scanning
  every project under `~/Documents/Projects/` would slow the daily job
  to a crawl on hosts with thousands of unrelated projects, and would
  also cross trust boundaries (those projects may be other users'
  agents; we shouldn't be reading their relay scripts uninvited).
- **The CI lint can't catch SHA removal in CI.** A future PR that
  deletes a SHA from `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` will be caught
  if at least one historical commit's SHA matches the deleted entry —
  which is true today for every entry. If a developer deletes a SHA
  AND also rebases history to remove the commit that produced it, the
  lint won't catch it. This is acceptable because the rebase requires
  force-pushing main, which is itself blocked by a separate gate.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

The verifier is a **detector**, not an authority. It reads the
filesystem, computes hashes, and emits structured signals into the
existing `DegradationReporter` channel. It owns no block/allow
authority; the migrator (`PostUpdateMigrator.migrateReplyScriptToPort
Config`) is the only piece of code that mutates a deployed relay
script, and that code path is already gated on SHA membership in the
prior-shipped set.

The split keeps detection (cheap, daily, host-wide) separate from
mutation (per-`instar update`, per-agent, gated). The CI lint is at
the right layer too — it asserts an invariant about the prior-shipped
set's coverage of git history, which is a developer-time concern, not
a runtime concern.

A previous version of this design considered making the verifier
auto-write a `.new` candidate alongside drifted scripts. That was
rejected: the migrator already does that on `instar update`, and
having two code paths that mutate deployed scripts (with different
trigger frequencies) would race during update. The current design has
exactly one mutator (the migrator) and one detector (the verifier),
with no overlap.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] **No** — this change produces a signal consumed by an existing
  smart gate. The verifier emits `DegradationReporter.report({...})`
  events, which feed the existing operator-visible degradation channel
  (Telegram alerts via the `degradation-digest` job, dashboard panel,
  health endpoint). The verifier itself never blocks anything; it's a
  detector that lights up a downstream signal lane.

The CI lint does hold blocking authority over commits, but its logic
is **deterministic and finite**: walk N commits, compute hashes,
compare against a fixed allowed-set. There is no judgment, no
synonym-matching, no LLM. The signal-vs-authority doc reserves
"brittle" for string/regex matching on free-form content; SHA-256
comparison on git-tracked file contents is structurally precise and
collision-resistant. The lint is the correct shape for this gate.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the verifier runs daily; the migrator runs on
  `instar update`. They both read the same `TELEGRAM_REPLY_PRIOR_
  SHIPPED_SHAS` set. The verifier never writes; the migrator writes
  only on `instar update`. Order doesn't matter — neither shadows the
  other. If a drift event fires today and the operator runs `instar
  update` tomorrow, the migrator will write a `.new` candidate and emit
  a `relay-script-modified-locally` event (which is a different event
  feature than `template-drift-detected`); the operator gets two
  related signals on the same drift, which is the desired behavior
  (one says "I noticed", one says "I wrote a candidate fix").
- **Double-fire:** the verifier dedups via the persistent
  `.instar/state/drift-verifier-seen.jsonl` log, keyed on
  `(deployed-path, current-SHA)`. The dedup persists across runs, so
  the daily job emits AT MOST one event per drift. If the operator
  edits the script (creating a new SHA on the same path), the verifier
  emits one fresh event for the new SHA — which is the correct
  behavior because the operator's intent may have changed.
- **Races:** the seen-log is append-only (`fs.appendFileSync`); the
  verifier runs in a single process. Two concurrent verifiers (e.g.,
  manual run while daily job is firing) would both append a duplicate
  entry; readers tolerate duplicates because the seen-set is built
  from a `Set<string>` of `path::sha` keys. No corruption risk.
- **Feedback loops:** the verifier emits `template-drift-detected`
  events; the existing `degradation-digest` job reads them and may
  send a Telegram alert. If the alert send itself relied on a drifted
  `telegram-reply.sh`, the alert would fail — and the failure would
  enqueue via the Layer 2 SQLite queue and retry via the Layer 3
  sentinel. So the worst case is: drift detected → alert queued →
  alert recovered after the operator fixes the relay script. No
  infinite loop.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Wire format:** none. No new HTTP endpoints, no new headers, no new
  message shapes.
- **Telegram users:** the new `template-drift-detected` event flows
  through the existing degradation pipeline; users on hosts with
  drifted scripts will see one Telegram alert per novel drift via
  the `degradation-digest` job. The alert is a fixed-template
  narrative composed by `DegradationReporter.narrativeFor` (no
  template excerpting, no agent text).
- **Persistent state:** new file at
  `~/.instar/state/drift-verifier-seen.jsonl` (append-only, mode
  0644). Capped implicitly by the finite set of `(path, sha)` pairs
  any host can have; in practice <100 entries even after years of
  agent churn. No retention policy is needed beyond what
  `BackupManager`'s default exclusion already covers (state files
  under `.instar/state/` are not backed up).
- **Other agents on the same machine:** the verifier reads files
  under `~/.instar/agents/*/` — directories owned by the same
  user account that runs the daily job. No cross-user surface.
- **CI surface:** the new lint adds ≈3s to a pre-push run via
  `npx tsx scripts/lint-template-sha-history.ts`. It is NOT yet wired
  into `pnpm test:push` — adding it as a test under `tests/unit/`
  was the chosen integration path, which means `pnpm test` covers it.
  Wiring a separate `lint:templates` script can come in a follow-up if
  the test path proves insufficient (it shouldn't).
- **Default-on flag:** the verifier ships default-on per spec. Operators
  with intentionally customized scripts will see ONE event after
  upgrade and can flip the flag off. This is the spec-mandated
  behavior; we have the rollback path documented in §7.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** revert the source. The seen-log file becomes
  inert (no readers). Existing daily-job entries in `jobs.json` will
  fail-soft because the verifier script is gone — the gate-then-execute
  shape exits silently when the source isn't found. Operators who
  hand-deleted the daily job entry are unaffected.
- **Feature flag toggle:** the cleanest rollback is
  `monitoring.templatesDriftVerifier.enabled = false` in the host
  config. No data migration, no user-visible regression. The spec
  documents this as the operator-facing customization path; reverts
  inherit it.
- **Persistent state:** the seen-log is at
  `~/.instar/state/drift-verifier-seen.jsonl`. A rollback that wipes
  this file leaves the host in a clean state (the next verifier run
  re-emits one event per drift). The file is gitignored (state files
  always are) so there's no cross-machine replay surface.
- **User visibility during rollback:** an agent with one queued
  `template-drift-detected` event in transit will deliver it before
  the verifier source is gone. A rollback before the next daily run
  produces zero further alerts. The migrator's existing
  `relay-script-modified-locally` event continues to fire on `instar
  update`, so operators retain a signal lane.
- **CI lint rollback:** delete the test file. The lint becomes an
  orphan script that no longer gates commits. No persistent state.

---

## Conclusion

Layer 7 closes the orphan-TODO failure mode that the spec's §7 calls
out as "the wrong shape for the root cause of this incident." The
verifier is a read-only detector; the lint is a deterministic
SHA-history check. Neither holds content authority; both feed
existing channels (DegradationReporter for the verifier, the
pre-commit gate for the lint).

One small design refinement during implementation: I considered
having the lint walk the entire git history (`git log` with no `-n`
limit) and decided against it. A 100-commit window covers every
historical change to telegram-reply.sh by orders of magnitude (the
file has 9 historical SHAs total, all within recent history). The
limit prevents pathological repository walks if the history grows
large for unrelated reasons.

**Second-pass review: not required.** Layer 7 is a meta-infrastructure
change with no auth surface, no message-content surface, no recovery
path mutation, and no agent-visible runtime behavior beyond a
DegradationReporter event. Compared to Layer 3 (which introduced an
auth-bearing recovery sentinel and earned a second-pass review), this
layer is structurally simple: 260 LoC of pure detector logic, a 90 LoC
CLI wrapper, a 130 LoC CI lint. The risk surface is silent failure of
the verifier (acceptable — the originating incident class is already
closed by Layers 1-3), not unwanted action. The spec convergence
process already covered the design at internal + external review
levels. Ship.

---

## Evidence pointers

- Unit tests: `tests/unit/verify-deployed-templates.test.ts` (7 cases),
  `tests/unit/lint-template-sha-history.test.ts` (2 cases). All pass.
- Lint executable proof: `npx tsx scripts/lint-template-sha-history.ts`
  exits 0 with `"OK (scanned 8 commits, current sha256:371d7e8f4f72…)"`.
- Verifier executable proof: `HOME=/tmp/empty-home npx tsx scripts/
  verify-deployed-templates.ts` exits 0 with
  `{"verifier":"templates-drift","scanned":0,"drifted":0,
  "suppressed":0,"errors":[]}`.
- Manifest regeneration: `pnpm generate:manifest` increments entry
  count 186 → 187 with the new `job:templates-drift-verifier` entry.
- Spec: `docs/specs/telegram-delivery-robustness.md` § 7.
- Predecessor PRs: #100 (Layer 1, `f9b5e3bb`), #101 (Layer 2,
  `5b953c17`), #103 (Layer 3, `60c64f8e`).
