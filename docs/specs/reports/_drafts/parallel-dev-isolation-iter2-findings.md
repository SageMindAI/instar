# Iteration 2 — Internal Reviewer Findings

Spec: docs/specs/PARALLEL-DEV-ISOLATION-SPEC.md (iteration 2)

Reviewers: Security, Scalability, Adversarial, Integration

## Iter-1 Resolution Summary

| Reviewer | Iter-1 critical/high count | RESOLVED in iter 2 | PARTIAL | NOT RESOLVED |
|----------|---------------------------|--------------------|---------|---------------|
| Security | 14 | 13 | 1 (concurrent reaper race) | 0 |
| Scalability | 8 | 6 | 3 (disk math, fence p99, reaper cost) | 0 |
| Adversarial | 14 | 12 | 2 (binding squat, branch creation outside manager) | 0 |
| Integration | 14 | 9 | 5 | 0 |

**Total ≈ 40/50 fully RESOLVED, ~10 PARTIAL, 0 NOT RESOLVED.** Iter 2 substantively closed the iter-1 surface.

## NEW Material Findings (iter 2)

### CRITICAL

| # | Reviewer | Title | Description | Fix direction |
|---|----------|-------|-------------|---------------|
| C1 | Security | Push-gate `git` PATH shim bypass-trivial | PATH is per-shell; `/usr/bin/git`, alias, fresh shell defeats it. With `origin` URL editable (rollback path), attacker can `git remote set-url origin <real>` and push direct, bypassing mirror entirely. | Drop shim option; mandate bare mirror as `origin`; add server job pinning origin URL on every operation; alert+block on drift. |
| C2 | Adversarial | Doc-only fast path content-vs-extension confusion | Attacker stages `docs/architecture-notes.md` containing 199-line code disguised as fenced block, then post-commit `git mv` to `src/exploit.sh` in follow-up commit (rename — no doc-fast-path requirement). | Doc-fast-path requires no rename history pointing source→non-doc within N commits; follow-up gate re-runs preflight on rename-to-source. |
| C3 | Integration | Push-gate mirror sync semantics undefined | `.instar/git-mirror.git/` is bare repo as `origin` but spec never says how mirror syncs with real GitHub origin: who pulls in, on what trigger; how rebases-after-pull preserve trailer signatures (rebased commits get new SHAs, breaking signed tree hashes). | Spec a `mirror-sync` daemon with fetch+push directions; rule that rebased commits re-sign at push time via server-trusted signer hook. |

### HIGH

| # | Reviewer | Title | Description | Fix direction |
|---|----------|-------|-------------|---------------|
| H1 | Security | HMAC key management unspecified | Server signs bindings/locks/heartbeats/trailers with one HMAC key, but no spec for storage, rotation, backup-restore. Snapshot leak → forgery. Backup on different machine → cross-tenant or all-old-sigs-invalid. | Key in OS keychain (Keychain/libsecret), explicit "never backed up", rotation via signed `key-version` field in every artifact, AC for restore-on-new-machine. |
| H2 | Security | `Instar-Trailer-Sig` replayable across commits | HMAC over `treeHash + topicId + sessionId` collides for same-tree commits. Captured trailer can be pasted into hand-crafted commit B with same tree. | Include parent-commit-id and committer-date (or server-issued nonce/monotonic per-binding counter) in HMAC input; pre-receive rejects reused (binding, nonce). |
| H3 | Security | Fencing-token persistence forgery | `.instar/local-state/fencing.json` reset to 0 (corruption/restore/malice) collides with all old tokens; force-take audit becomes meaningless. | Persist counter as `max(disk, max-token-seen-in-active-locks+1)` on every read; HMAC the counter file; refuse to allocate on mismatch + attention-queue. |
| H4 | Security | Server compromise = total auth + total dev block on outage | Server is sole signer/binder/preflight/mirror-gate. Outage → no commits push, no sessions spawn → total dev halt. RCE in server (HTTP+bearer) → forges everything. | Explicit "server-down" mode (read-only fallback, no-bind sessions to main, doc-only path); separate signing keypair from API token; document blast radius. |
| H5 | Scalability | Server on critical path of every git op | Every spawn, heartbeat (15s × N), preflight (per commit), release, push hits `WorktreeManager`. With 5 sessions: ~20 heartbeats/min + commits + push-gate. No published p99, no rate-limit, no circuit breaker. | Hard preflight timeout (500ms) with fail-open-to-warn; load-test AC for 10 concurrent sessions × 1h; treat preflight as ambiguous-outcome on timeout. |
| H6 | Scalability | Push-gate mirror doubles disk for full history | Bare mirror at `.instar/git-mirror.git` ~600MB-1GB for instar today, growing monotonically per-machine. No GC policy. Every push = mirror-receive + mirror-push-to-origin (2× network). | Specify mirror gc/repack cadence; publish push-latency AC (+<300ms p99 vs direct); document mirror-disk in budget. |
| H7 | Adversarial | Mixed-path commits trivially bypassed by sequential commits | Read-only session can't commit `src/foo.ts + docs/bar.md` together → splits into two: docs first (passes), src/ rejected. First commit lowers reviewer suspicion when agent immediately requests promote. | Doc-fast-path commits in read-only mode don't count toward "topic activity" influencing promote ratification. |
| H8 | Adversarial | `Instar-Related-Topics` trailer no ownership check | Server validates IDs exist; attacker fabricates `Instar-Related-Topics: 2317,2401,2502` to launder commits touching files outside primary topic's footprint. | Server verifies committing session's principal has material activity (messages/commits/binding history) on every claimed related topic; reject otherwise. |
| H9 | Adversarial | `--cross-topic-confirm` no authority gradient | Buggy/malicious agent always passes the flag. 25%-over-30d alert is observability not enforcement; spec doesn't say what alert does. | Per-commit attention-queue ratification (not session-level); track per-session abuse rate; auto-revoke flag privilege after 3 unratified uses. |
| H10 | Adversarial | Push-URL substitution via separate clone | Pre-receive only fires on local mirror. Agent runs `git clone <origin>` in `/tmp/`, commits, pushes direct-to-origin → entirely bypasses mirror. Spec says "configured push URL or wrapped git shim" but doesn't enforce origin-side. | Branch-protection on origin requires trailer signature via GitHub Actions check (`worktree-trailer-sig-check` mentioned but not branch-required); unsigned commits to `topic/*` rejected at origin too. |
| H11 | Integration | `git` PATH shim install path missing | R1 leans toward visible mirror but mentions wrapped git shim as alt. No story for: install location (`~/bin`? agent-local?), Windows (`.cmd`), shell-restart survival, VS Code's bundled git. | Drop shim alternative or fully spec install/uninstall across darwin/linux/win + IDE bundles. |
| H12 | Integration | `cp -al` APFS/ext4-only | Hardlinks work on APFS/ext4 but NOT NTFS/exFAT/many network mounts. Windows (WSL2 DrvFs) silently falls back or fails. | Feature-detect link support; fall back to junction (Win) / symlink + reflink-when-available; add to AC-21. |
| H13 | Integration | Day -1 script chicken-and-egg | "Day -1 script ships in same PR as spec" but spec PR hasn't merged when remediation needs to run. | Ship `migrate-incident-2026-04-17.mjs` in prerequisite PR (or as `npx instar@next migrate ...`); spec PR depends on it. |
| H14 | Integration | `topic-branch-map.json` schema undefined; multi-machine fencing race | New git-synced file introduced for cross-machine topic→branch mapping, signed — but no schema, no migration, no conflict-resolution. Per-machine fencing counters mean machines A and B both have token=47; both push within heartbeat window → mirror sees two valid sigs at different worktrees. | Spec the file's schema; make fencing tokens `<machineId>:<counter>`; mirror enforces monotonic-per-(machine, topic) on push. |

### MEDIUM

| # | Reviewer | Title | Description | Fix direction |
|---|----------|-------|-------------|---------------|
| M1 | Security | `.code-workspace` as VS Code path-following sink | Server writes binding paths as workspace folders; binding survives validation but contains symlink-out to sensitive dirs once VS Code follows it (extensions auto-run, tasks.json autoload). State validation checks binding path but not contents. | Also fstat the worktree dir at workspace-write time; refuse to include worktrees whose `.git` is a symlink or whose contents have non-SessionManager-authored `.vscode/tasks.json`. |
| M2 | Security | Migration script trusts `stash@{0}` | Step 1 verifies stash@{0} matches InitiativeTracker label. Stash list reorderable; another session can `git stash push -m "parallel-session: InitiativeTracker..."` between approval and execution → script pops wrong stash. | Verify by stash SHA captured at spec-approval time, not label substring. Refuse if SHA changed. |
| M3 | Security | `session-context.json` leaks fencing token | File contains sessionId + fencing token + serverSig at `<cwd>/.instar/session-context.json`. Any subprocess (test runner, npm script, MCP server) can read it and present valid heartbeat/release/preflight as the session. | Mode 0600 + uid check on every server read; bind token to (sessionId, parent-pid) requiring parent-pid match on heartbeat; or move to Unix-socket-only handshake at spawn. |
| M4 | Security | `instar where` is binding oracle | Prints active worktree path for current cwd's topic. Run from any cwd, enumerates which topics have active bindings — useful for force-take or `.lock-history.jsonl` race. | Require same auth token used for HTTP API; do not enumerate other topics. |
| M5 | Adversarial | Attention-queue flooding buries promote ratifications | `/promote-to-dev` requires user ratification via attention queue. Malicious agent floods with high-severity false alerts → user rubber-stamps everything. | Ratification items get separate, rate-limited, per-actor-quotad channel from observability alerts; one outstanding promote per session. |
| M6 | Adversarial | 24h grandfather window pre-cutover squat | Cutover gated on zero-violations digest (observable). Agent spawns N sessions just before cutover-decision to acquire 24h immunity. | Grandfather only sessions with ≥1 user message *before* cutover-decision timestamp; new sessions post-decision not grandfathered. |
| M7 | Adversarial | Migration script re-runnability | An agent crafting later stash with same label can re-trigger script's commit-and-push behavior. | Sentinel `.instar/local-state/migration-2026-04-17.completed`; refuse re-run; signed; git-synced. |
| M8 | Adversarial | Observability metrics file tampering | If file-backed and writable by agent, attacker zeroes own bypass-attempt counters. | Metrics in server-process-memory + append-only WAL under `.instar/local-state/metrics.wal`; signed rotation; never agent-writable. |
| M9 | Scalability | Heartbeat request volume | 15s × N × 24h = 5,760 req/session/day. N=10 = 57k/day for heartbeats + auth + HMAC + disk write. No batching, no exp backoff when idle. | Adaptive cadence (15s active, 60s idle); in-memory aggregation; write-coalesce to disk every 5 heartbeats. |
| M10 | Scalability | Force-take stash on 1GB worktree | `git stash push --include-untracked` on worktree with built `dist/`, etc. takes 30s+, balloons stash. `.gitignore` overlay helps untracked but modified-tracked still all hashed. | Scope stash to `git diff --name-only` paths + explicit untracked-WIP scan; cap stash size with refusal+alert if >100MB. |
| M11 | Scalability | Pre-warmed template staleness | `.template/` created once; no refresh policy. Stale template = silent build break (old `node_modules`). | Template refresh on every successful main `npm install`; template includes `package-lock.json` hash; mismatch triggers blocking install on first bind. |
| M12 | Scalability | `cp -al` APFS-specific (also flagged H12 from Integration) | Linux/ext4 fallback unspecified; cross-FS bind fails. | (See H12.) |
| M13 | Integration | `instar where` CLI packaging unspecified | New CLI introduced but no install path. Part of `npx instar`? bin entry? | Add to CLI section; one bullet in side-effects. |
| M14 | Integration | `.code-workspace` user-conflict | Auto-managed file at repo root will trample existing user file. | Write to `.instar/instar.code-workspace`; symlink or document opening explicitly; never overwrite user's. |
| M15 | Integration | `bindings-archive-YYYY-MM.json` git-ignored but presented as restorable | If archives only local and never backed up, restore-on-different-machine returns zero history. | Include in `BACKED_UP_PATHS` (separate from `BLOCKED_PATH_PREFIXES`) or state explicitly that archives are local-only and history is ephemeral. |
| M16 | Integration | Skill version-shim auto-overwrite threshold ambiguous | "Auto-overwrites unmodified user copies" — what counts as unmodified? Drift in baseline silently clobbers intentional local edits. | Maintain shipped-skill-SHA history; auto-overwrite only if local SHA matches *any* prior shipped SHA; otherwise alert-only. |
| M17 | Integration | `migrate-incident-2026-04-17.mjs` bypasses /instar-dev gate | Scripts/ files require trace+artifact under /instar-dev. Spec doesn't say how migration script ships. | State explicitly that migration script ships *with* artifact under `upgrades/side-effects/`, run through /instar-dev like any other change. |
| M18 | Integration | Pre-receive hook process ownership | Spec says "server-process-owned, NOT user-editable" — but git invokes hook as child of `git-receive-pack`, not agent server. How does it acquire HMAC key? Read from `.instar/local-state/`? Then key must be readable by the user that runs `git push` = same user as agent → "not user-editable" is hopeful, not enforced. | Spell out key-acquisition path; OR pre-receive becomes thin shim that POSTs to agent server for verification (server holds key in memory). |
| M19 | Integration | `instar-imessage-review` external worktree invisible to reaper rules | Live state has `/Users/justin/Documents/Projects/instar-imessage-review` — real `git worktree list` entry OUTSIDE `.instar/worktrees/`. Reaper's symmetric-difference walk doesn't have a matrix row for "valid git worktree, not under prefix, not in bindings." | Add explicit matrix row for "external worktree" — adopt with warning or leave alone with one-time alert; do not quarantine. |
| M20 | Scalability | 30-entry active map limit, no defined behavior at 31 | "Kept ≤30" but no eviction or rejection. With agent fan-out, 30 active topics plausible. | LRU eviction of `merged`/`abandoned` first; reject-with-prompt when 30 are all `active`. |
| M21 | Scalability | Bindings monthly archive no index/query | Archives accumulate ~12 months; reaper, observability, push-gate (commit-date) need historical lookup. No index = O(months) scan per push. | SQLite-backed binding-history table or single rolling JSONL with mtime index. |

### LOW

| # | Reviewer | Title | Description | Fix direction |
|---|----------|-------|-------------|---------------|
| L1 | Security | Pre-receive bound to committer-date enables clock-skew | "Binding active at commit's committer-date" — committer-date is attacker-controllable (`GIT_COMMITTER_DATE`). | Validate against server receive-time; binding-history indexed by receive-time, not commit metadata. |
| L2 | Security | Doc-only fast path classifier widened by symlink | Staged symlink `docs/escape.md → ../src/server/AgentServer.ts` plus content edit could pass path check while modifying source. | Reject symlinks in staged set during doc-only mode; enforce mode==100644. |
| L3 | Security | Heartbeat × push-gate latency interaction | Slow push-gate verification could starve heartbeats → spurious force-take eligibility on healthy session. | Separate worker pool for push-gate vs heartbeat; AC for "heartbeat SLA under concurrent push verification." |
| L4 | Adversarial | `instar where` as recon | Compromised dependency learns full active-topic surface. | (See M4.) |
| L5 | Scalability | Migration backfill scan time | Synchronous scan blocks server start (~5-15s). | Background backfill, mark bindings `status: "backfilling"`. |
| L6 | Scalability | Observability metrics export cadence/storage unspecified | 11 counters/gauges, no scrape interval, retention, storage budget. | Specify Prometheus-style pull or fixed-interval push; cap retention. |
| L7 | Integration | Cross-topic trailer Telegram routing | Commits with `Instar-Related-Topics` trailer should fan out notifications per related topic. | One-line side-effect: "fan out per related topic." |
| L8 | Integration | Two-session AC test infrastructure | AC-3, AC-14, AC-15 require two real concurrent sessions. No harness in repo. | Add subsection naming fixture (e.g., `tests/fixtures/two-session-harness.ts`). |

## Convergence verdict (internal reviewers, iter 2)

- 4 NEW critical findings.
- ~14 NEW high findings.
- ~21 NEW medium findings.
- ~8 NEW low findings.

**Not converged.** Per skill: "convergence is zero material findings in a new round."

## Iter 3 priorities (consolidated)

The new findings cluster:

1. **Push-gate enforcement model** (C1, C3, H10, H11) — drop the shim, mandate bare mirror as `origin`, server job pinning origin URL, document mirror sync semantics with daemon, GitHub-side branch protection requiring trailer signature.
2. **HMAC key lifecycle** (H1, H3, M18) — keychain, never-backed-up, rotation via versioned artifact, explicit key-acquisition path for pre-receive.
3. **Trailer replay defense** (H2, L1) — include parent-commit SHA + monotonic per-binding nonce in HMAC; validate against server receive-time.
4. **Server availability/compromise blast radius** (H4, H5) — server-down read-only fallback; separate signing keypair from API token; preflight timeout + fail-open-to-warn; load-test AC.
5. **Doc-only fast path content check** (C2, L2) — block staged symlinks, enforce mode==100644, follow-up gate on rename-to-source, mixed-mode trick rejection.
6. **Mixed-path / sequential commits / Related-Topics** (H7, H8, H9, M5) — doc-fast-path commits don't count toward promote activity; server checks principal activity on related topics; per-commit ratification for cross-topic; ratification queue separate from observability.
7. **Multi-machine fencing reconciliation** (H14) — fencing tokens become `<machineId>:<counter>`; mirror enforces monotonic-per-(machine, topic) on push; topic-branch-map.json schema spec.
8. **Path-following sinks** (M1, M14) — `.code-workspace` written to `.instar/instar.code-workspace`, never overwrite user's; fstat dir before workspace-write; reject `.vscode/tasks.json` not authored by SessionManager.
9. **`instar where` security** (M4, L4) — auth-required, no enumeration.
10. **Day -1 script ordering and gate** (H13, M2, M7, M17) — prerequisite PR; verify by stash SHA not label; sentinel against re-run; ships under /instar-dev with artifact.
11. **`cp -al` portability** (H12, M12) — feature-detect, per-FS fallback ladder.
12. **External worktree (`instar-imessage-review`) handling** (M19) — explicit matrix row.
13. **Server load** (H5, H6, M9, M10, M11) — hard preflight timeout, mirror gc/repack, adaptive heartbeat cadence, scoped force-take stash, template refresh policy.
14. **Bindings archive index + restore** (M15, M21) — SQLite or JSONL+mtime index; restore semantics.
15. **Skill version-shim threshold** (M16) — match any prior shipped SHA.
16. **Cross-topic Telegram fan-out** (L7) — one-line addition.
17. **Two-session test infra** (L8) — fixture spec.
18. **Observability tamper-resistance + cadence** (M8, L6) — server-memory + WAL + signed rotation; specified scrape.
