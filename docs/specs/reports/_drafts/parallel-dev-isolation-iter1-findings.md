# Iteration 1 — Internal Reviewer Findings (raw, deduplicated)

Spec: docs/specs/PARALLEL-DEV-ISOLATION-SPEC.md

Reviewers: Security, Scalability, Adversarial, Integration

## CRITICAL

| # | Title | Reviewer(s) | Description | Fix direction |
|---|-------|-------------|-------------|---------------|
| C1 | Env-var auth collapses fence | Security#1, Adversarial#2/#11 | INSTAR_SESSION_ID/INSTAR_TOPIC_ID/INSTAR_READ_ONLY are env vars; any agent can `unset` and bypass. Soft-warn when missing → entire isolation defeated by one shell line. | Move authority to per-cwd `.session-context.json` written by SessionManager + verified against lock. Inside an instar worktree, missing context = BLOCK. Subprocess must inherit context via file, not env. |
| C2 | Bindings file is unauthenticated root-of-trust | Security#2, Adversarial#11 | Pre-commit fence resolves binding from JSON file the agent can write. Agent rewrites topic 2317's worktreePath to its current cwd → fence approves. | Bindings written only via authenticated server endpoint (POST /worktrees/bind). Each entry HMAC-signed with server-held key. Pre-commit reads via API, not disk. |
| C3 | Pre-commit gate has 5+ documented bypasses | Security#3, Adversarial#1/#2 | --no-verify, core.hooksPath=/dev/null, GIT_INDEX_FILE, git commit-tree pipeline, server-side commits via gh api. Trailer audit (AC-13) is post-push CI — wrong-worktree commits already in history. | Authoritative gate is server-side: pre-receive hook on canonical remote (or wrapped git shim in PATH) that validates trailer + lock + binding signature. Local pre-commit is UX nicety. |
| C4 | npm install per worktree blocks spawn 60-180s | Scalability#2 | If install runs in spawnSession path, p99 spawn latency >2 min. Telegram acks (mandated <5s) fail; SessionManager callers time out. | `cp -al node_modules` (hardlinks, ~2s on APFS) at create; background `npm install` reconciles if package-lock differs. Spawn returns before install completes. |
| C5 | Migration backfill grep matches zero branches | Integration#1 | Spec says backfill via `git branch \| grep ^topic/` — but the topic/* namespace doesn't exist yet. Backfill produces empty bindings → every existing in-flight session has no binding → block or unsafe. | Backfill scans `git worktree list --porcelain` + `.instar/state/build/build-state.json`; synthesizes `build:<task>` and `platform` bindings for every existing worktree. |
| C6 | Today's incident remediation hand-waved | Integration#2 | InitiativeTracker work currently staged on main; spec says "manually unstage and move" in 3 sentences with no commands. Auto-commit job will sweep it before fix lands. | Concrete sequence: `git stash --keep-index`, `git checkout -b topic/initiative-tracker-core`, `git stash pop`, commit, push, revert main index. Block auto-commit job until done. |
| C7 | /build wrapper schema incoherent | Integration#3 | Spec says `/build` wraps `bindTopic("build:<task>", ...)` but bindings file declares topic key as number. /build has no topic ID; conflates two namespaces. | Either widen bindings key to string + fix schema example, or `/build` resolves to caller's INSTAR_TOPIC_ID with `platform` fallback. |

## HIGH

| # | Title | Reviewer(s) | Description | Fix direction |
|---|-------|-------------|-------------|---------------|
| H1 | Lock O_EXCL not symlink-safe | Security#4 | O_EXCL follows pre-planted symlinks → lock created at attacker-chosen path outside worktree. | `open(O_EXCL\|O_NOFOLLOW)` + `fstat` to verify regular-file + uid + parent dir via O_DIRECTORY\|O_NOFOLLOW. |
| H2 | PID reuse after reboot | Security#5 | `kill -0 <pid>` post-reboot succeeds for whatever process took the pid. False-alive lock that's never reclaimed, or false-verify of a real session sharing the pid. | Store boot ID in lock (Darwin: `kern.boottime`; Linux: `/proc/sys/kernel/random/boot_id`). Liveness counts only when boot ID matches. |
| H3 | realpath insufficient for cwd compare | Security#6 | Bind mounts, APFS firmlinks, case-insensitive HFS, `..` in binding string itself defeat realpath equality. | realpath both sides + assert child of `<repo>/.instar/worktrees/` + compare device+inode of opened directory fds. |
| H4 | Force-take loses in-flight work, no audit | Security#7, Adversarial#6 | When B force-takes A's lock, A's writes can collide. No fencing token, no signal to A, no journal. | Fencing token (monotonic counter); A's writes rejected without token. SIGTERM A's pid before take; `git stash push -u` first; append to `.lock-history.jsonl`; high-priority attention-queue alert with stash ref. |
| H5 | Multi-machine binding injection | Security#8, Integration#5 | Compromised machine commits bindings.json with `worktreePath: /etc` or path traversal. Reaper or worktree-add then targets /etc. Schema lacks machineId; cross-machine kill -0 meaningless. | Validate every binding on load: relative path, must start with `.instar/worktrees/`, no `..`, must resolve under repo root, must already exist in `git worktree list`. Reject + quarantine. Bindings become per-(topic, machine). |
| H6 | Quarantine slug path traversal | Security#9 | Reaper reads existing dirnames; if attacker created `.instar/worktrees/../../etc/passwd-thing/`, rename target escapes quarantine. | Reaper `basename()` + re-slugify before quarantine; reject any name containing `/`, `\0`, `..`. |
| H7 | Concurrent reaper + session race | Security#10 | Reaper renames worktree dir while session is acquiring its lock → session spawns into nonexistent path. | Directory-level advisory lock (flock) on worktree dir. Order: dir-flock → session-lock. Reaper takes same lock first. |
| H8 | Heartbeat × git-sync = commit storm | Scalability#3 | 30s lock rewrite × N sessions × auto-commit = commit every 6s with 5 sessions. Spec doesn't say locks are gitignored. | Add `.session.lock` and heartbeat fields to global gitignore + `BLOCKED_PATH_PREFIXES` for git-sync. Split bindings into stable (committed) + heartbeat (untracked). |
| H9 | Pre-commit fence p99 unbounded | Scalability#4 | Every commit reads JSON, does `realpath × 2`, reads lock, `kill -0`. With 200KB bindings + cold disk: 50-100ms/commit. /build does many small commits → seconds added. | Cache bindings parse via mtime check; split active vs archived bindings; keep active <20 entries. |
| H10 | Disk math undercount | Scalability#1 | Real instar checkout ~1.4GB; at 30 topics + quarantine = 45-60GB, not 15. AC-15 unachievable in month 2. | Per-worktree disk budget enforced by reaper (LRU evict beyond N GB); add `dist/`, coverage to per-worktree gitignore overlay. |
| H11 | Server-start binding squat | Adversarial#3 | Misbehaving session iterates topics and bindings them all at startup, denying legit sessions. | Bind requires proof-of-work for that topic — session must have an existing thread/message in the topic (server-verified). Cap binds-per-session-per-minute. |
| H12 | Auto-promote on first commit | Adversarial#4 | Combined with #11, attacker triggers auto-promote on every read-only topic. | Auto-promote requires user ratification via attention-queue (not silent log). Lean: explicit `/promote-topic` skill. |
| H13 | Heartbeat future-dating | Adversarial#5 | Lockholder writes heartbeatAt: 2099-01-01; lock never expires. | Reject heartbeats >60s in the future; treat as stale. Better: heartbeat is server-issued (POST /worktree/heartbeat), server timestamps + signs. |
| H14 | Branch creation outside manager | Adversarial#7 | Manual `git checkout -b topic/2317-shadow` in main creates duplicate; merges race. | Pre-push hook rejects topic/N-* branches whose name doesn't match topic N's binding. Periodic reconciler quarantines unbound topic branches. |
| H15 | Pre-commit blocks legit doc fixes | Adversarial#8 | Read-only chat session spots typo, commits, fence blocks with "promote" message; agent has no authority. Fix dies silently. | Non-source paths (`*.md`, `docs/**`) get lighter "doc-only commit" path allowed from main without promotion. Or `/quick-doc-fix` → one-shot `docs/<slug>` worktree. |
| H16 | Stale-binding silent fallback | Adversarial#9 | Binding exists, worktree deleted out-of-band; chdir fails → SessionManager falls back to projectDir = main. Original incident recurs. | resolveCwdForTopic must verify path exists AND is in `git worktree list` AND lock is reclaimable. Missing path = HARD ERROR with rebind prompt; never silent main-fallback. |
| H17 | Reaper duplicates WorktreeMonitor | Integration#4 | Existing monitor has orphan/unmerged/stale-age detection. Spec adds reaper without saying replace/wrap/compose. Two scanners with different thresholds → conflicting alerts. | Reaper delegates detection to WorktreeMonitor.scanWorktrees(); adds quarantine() step. One scanner, one threshold, two actions. |
| H18 | Multi-machine schema missing | Integration#5, Security#8 | Side-effects line says "machine-id" but schema has no machineId field; pids not unique across machines. | Add machineId (from `.instar/machines/registry.json`) to bindings + lock entries. acquireLock verifies machineId === currentMachine. |
| H19 | AC-13 trailer CI check unspecified | Integration#6 | Trailer added by whom? CI workflow path? GitHub Actions has no access to local bindings. | Trailer added by pre-commit via `git interpret-trailers`. CI workflow at `.github/workflows/worktree-binding-trailer-check.yml` only verifies trailer presence + path-prefix sanity. |
| H20 | Cutover UX missing | Integration#7 | Sessions running before flip have no binding. Local commits succeed (soft-warn), push fails (CI requires trailer). Worst failure mode. | Cutover gate checks process tree; pre-flip sessions grandfathered for 24h via INSTAR_GRANDFATHER_UNTIL env file. Document 24h cliff. |
| H21 | Skill update sequencing — user-installed | Integration#8 | /build, /instar-dev, /spec-converge are user-installed. Existing installations don't auto-update. | Skill-shim at server start: SHA-compare local skill vs shipped version; on mismatch, attention-queue alert with one-line update; auto-overwrite if file unmodified vs prior shipped. |

## MEDIUM

| # | Title | Reviewer(s) | Description | Fix direction |
|---|-------|-------------|-------------|---------------|
| M1 | Trailer audit unauthenticated | Security#12, Adversarial#1 | Anyone can write any trailer; CI sees presence and passes. | Sign trailer: `Instar-Worktree-Sig: HMAC(treeHash + worktreePath, sessionKey)`; CI verifies via `POST /audit/verify-commit`. |
| M2 | Compaction-recovery as prompt-injection sink | Security#13, Adversarial#12 | topicTitle is user-supplied (Telegram). Malicious title flows verbatim into model context after compaction. | Sanitize before emission (strip newlines, length cap, escape backticks); render as fenced JSON; inject via system-reminder, not free-form prose. |
| M3 | Backup/restore reintroduces stale bindings | Security#14, Integration#11 | Snapshot from machine A restored on B yields bindings whose paths don't exist; could resolve into a different repo if same slug exists. | On restore, walk bindings, validate paths against current `git worktree list`, mark mismatches `status: stale-after-restore`, refuse spawn until rebound. |
| M4 | Cross-tenant via threadline | Security#15 | bindings.json git-syncs; threadline allows cross-agent git PRs → agent X ships malicious bindings to Y. | bindings.json is machine-local (`.instar/local-state/`, gitignore). Topic→branch mapping can sync; topic→path cannot. |
| M5 | Kill-switch is global env var | Security#16 | INSTAR_PARALLEL_ISOLATION=off in any subshell disables enforcement for that process tree. | Make kill-switch a flag file (`.instar/state/isolation-disabled.flag`) writable only via CLI command; logs to attention queue; auto-expires 1h. |
| M6 | State file write contention | Scalability#5 | Concurrent spawnSession calls race object-replacement; lost-update. | Tempfile + rename(2) atomic swap; in-process mutex in WorktreeManager. |
| M7 | Lock-recovery 2-min visible stall | Scalability#6 | Crashed session; user retries; 90s heartbeat + grace before reclaim. | Drop staleness to 45s (heartbeat 15s); on `kill -0` failure reclaim immediately; surface "reclaiming stale lock from PID X (dead)". |
| M8 | Reaper cost grows linearly | Scalability#7 | 30+ worktrees × per-worktree git calls = 5s daily. Bites if reaper called on-demand. | Cache `git worktree list --porcelain` for one pass; parallelize per-worktree checks (concurrency=4). |
| M9 | Cold-start latency for new topic | Scalability#8 | Branch+worktree+npm-install+lock+spawn → p50=90s, p99=3min without #C4 fix. | Pre-warm template worktree with node_modules; first-bind clones via `cp -al`. |
| M10 | Slug collision | Adversarial#10 | Two topics with similar 40-char slugs. | Disk paths use topicId prefix (already collision-free); binding lookup always by topicId. Append `-<shortHash>` on creation collision. |
| M11 | Reaper as weapon | Adversarial#11 | Session updates another's lastActivityAt; reaper deletes it. | lastActivityAt server-derived from commit timestamps + signed lock heartbeats. Bindings server-owned; sessions mutate via API. |
| M12 | Platform sentinel becomes new main | Adversarial#13 | platform/main-dev becomes long-lived multi-session contention point. | platform/<slug> per discrete task; cap concurrent sessions on platform to 1 with mandatory queueing. |
| M13 | Migration warn-period silent compounding | Adversarial#14 | Warnings ignored during day 0-7; cutover finds backlog. | Warn mode emits attention-queue items + daily digest; cutover gated on "zero violations in 48h," not fixed date. |
| M14 | Internal spawn callers without topic | Integration#9 | Internal jobs (worktree-monitor, ci-fix loops, scheduled triggers) spawn with no topic; default `null` lands in main. Broken for jobs that commit. | Enumerate internal callers, classify each. Default unbound → `topicId="platform"` for any committing job. |
| M15 | Compaction-recovery hook fragility | Integration#10 | Hook crashes if bindings file missing/corrupt during the moment agent most needs identity. | `set +e` around lookup; fallback message "binding not found, run /worktree-bind"; never crash recovery. |
| M16 | Backup interaction half-spec | Integration#11 | Bindings sync but lock files would too — restoring stale locks from another machine. | Bindings filtered through machine-id on read. Locks excluded via `.gitignore` `.session.lock`. |
| M17 | AC-11 reaper can't see integrated-being-v1 | Integration#12 | Orphan has no .git → not in `git worktree list`; reaper as designed misses it. | Reaper walks both `git worktree list` AND `readdir(.instar/worktrees/)`; symmetric difference = orphan classification. |
| M18 | Test infra gap for two-session ACs | Integration#13 | Vitest is single-process; no harness for spawning two sessions concurrently. | Add `tests/integration/parallel-session-harness.ts` using spawnSync + INSTAR_SESSION_ID env vars; mock lock acquire/release. |
| M19 | Side-effects artifact path confusion | Integration#14 | Trace written under worktree's `.instar/...`; if user merges manually from main, trace is missing. | Document: traces staged with commit; cross-worktree commits via main checkout explicitly unsupported. |

## LOW

| # | Title | Reviewer(s) | Description | Fix direction |
|---|-------|-------------|-------------|---------------|
| L1 | Heartbeat 30s/90s tight under load | Security#17 | Node event-loop stalls under LLM streaming or npm install >90s → spurious force-takes. | Threshold ≥5× heartbeat (150s); separate liveness probe (TCP) before declaring stale. (Tension with M7 — pick a number.) |
| L2 | git worktree list parsing not porcelain | Security#18 | Whitespace-delimited locale-dependent output breaks for paths with spaces. | Always `git worktree list --porcelain -z`. |
| L3 | Compaction hook bloat | Scalability#9 | Negligible at current scale. | None unless MEMORY.md grows past 50KB. |
| L4 | Backup growth from bindings | Scalability#10 | 1KB × 500/year = 500KB. | Reaper archives merged bindings >30d to `bindings-archive-YYYY-MM.json`. |
| L5 | CI cost for trailer check | Scalability#11 | ~10s/PR negligible. | Local trailer parse + 5s timeout fail-open with audit log. |
| L6 | WorktreeManager memory | Scalability#12 | ~100KB resident at 100 bindings. | None. |
| L7 | Cross-topic refactor escape via platform | Adversarial#15 | Agents rationalize shared work into platform; isolation theatre. | Metric: % commits to platform; alert if >25% rolling 30d. |
| L8 | Binding-squat race on topic creation | Adversarial#16 | First-write-wins implicit. | Server-side `assignBinding(topicId, requestingSessionId)` triggered by topic creation. |
| L9 | Rollback "remains-but-inert" | Integration#15 | Stale bindings reactivate on flag flip with paths gone. | Rollback writes `isolation-disabled-at` timestamp; re-enable revalidates all bindings against `git worktree list`. |
| L10 | Dashboard badge scope drift | Integration#16 | Mentioned as mitigation, not specced. | Add explicit AC, or label "future work, tracked separately." |

## Cross-cutting themes

1. **Sessions treated as cooperative.** Every session-written field (heartbeat, lastActivity, trailer, env vars) is forgeable. Fix pattern: move authoritative state from session-written files to server-mediated APIs with signed/timestamped writes. Pre-commit is advisory; real gate is server-side.
2. **Authority concentrates on the bindings file.** Make it server-owned; sessions mutate via API.
3. **Migration plan needs concrete commands.** Backfill, today's incident remediation, /build reconciliation are all hand-waved.
4. **Multi-machine model is one paragraph.** Needs a schema with machineId and per-machine binding semantics.
5. **Pre-commit isn't enforcement.** Every push of authority into pre-commit must have a pre-receive companion to be real.
