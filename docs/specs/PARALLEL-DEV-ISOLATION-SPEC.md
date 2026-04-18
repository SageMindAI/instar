---
title: "Parallel Dev Isolation — Topic-Bound Worktrees as the Default Path"
slug: "parallel-dev-isolation"
author: "echo"
created: "2026-04-17"
review-iterations: 4
review-convergence: "converged"
review-report: "docs/specs/reports/parallel-dev-isolation-convergence.md"
review-external-models: ["gpt", "gemini", "grok"]
approved: true
approved-by: "justin"
approved-date: "2026-04-17"
approval-context: "Telegram topic 7000 parallel-dev-infra — 'approved! please proceed autonomously and build the full feature'"
---

# Parallel Dev Isolation — Topic-Bound Worktrees as the Default Path

> Two parallel instar-dev sessions on the same working tree is a foot-shotgun pointed at the user's commit history *and* their untracked work-in-progress. We have worktree infrastructure, but it's opt-in via `/build`, requires a manual `cd`, and isn't tied to topics — so the default failure mode is "second session sweeps first session's staged work into its commit, then `git clean` wipes the third session's untracked WIP." This spec makes collision-free parallel development the default — structurally enforced at session spawn (every session, including read-only ones, gets isolated cwd), at commit-msg-hook time (signed semantic trailer with replay defense), at push time via origin-side branch protection (the authoritative gate), and at destructive-command time (audit before `git clean`/`reset --hard` etc.). Lock heartbeats provide liveness; orphans get reaped.

## Problem statement

### The incident (2026-04-17, in two parts)

**Part one — staged-work cross-sweep:** Echo opened a session to ship the **compaction-resume v2** fix. Routine `git status` showed **1028 lines of unrelated work** staged on `main`:

```
new file:   src/core/InitiativeTracker.ts
new file:   tests/unit/InitiativeTracker.test.ts
new file:   tests/unit/routes-initiatives.test.ts
new file:   upgrades/side-effects/initiative-tracker-core-and-api.md
modified:   src/server/AgentServer.ts
modified:   src/server/routes.ts
modified:   src/commands/server.ts
new file:   .instar/instar-dev-traces/2026-04-17T23-50-00-000Z-initiative-tracker-core-and-api.json
```

A parallel session — `echo-github-prs` (session `928c605d`, topic 2317) — produced this work, exited without committing, and went silent. The compaction-resume session's `git commit` would have **swept the InitiativeTracker work in under its commit message and authorship**.

**Part two — untracked-work cleanup collateral (discovered while writing this spec):** The compaction-resume session was actually well-behaved: it ran `git stash push` of the InitiativeTracker staged files (preserved as `stash@{0}`) and committed only its own files. But the cleanup that followed appears to have been a `git clean -fd` (or equivalent), which **destroyed every untracked file in the tree** — including this spec's first draft, several other in-flight spec files, and source files for in-flight features. None of that untracked work was recoverable from git — it had never been added.

The pre-commit gate didn't catch any of this because it's file-scope, not session-scope, and `git clean` doesn't trigger pre-commit at all.

### Why this isn't a one-off

`SessionManager.spawnSession()` spawns every session with `cwd = this.config.projectDir` — the main checkout. Worktree creation only happens inside the `/build` skill, which is opt-in, requires manual `cd`, and has no enforcement. `WorktreeMonitor` is a post-hoc alerter. Topic-project bindings link topics to *projects*, not to *worktrees*. `.instar/worktrees/integrated-being-v1/` is an orphan — only `node_modules/`, no `.git`.

### The five failure modes

1. **Default-on-main.** Sessions land in main unless explicitly told otherwise.
2. **Manual cd.** Even when `worktree-create` runs, nothing forces the agent's process cwd to the worktree.
3. **No session-scoped commit fence.** Pre-commit checks artifacts; nothing checks "is this session committing in its own assigned worktree?"
4. **No protection for untracked WIP.** Cross-session cleanup destroys untracked files belonging to other sessions.
5. **No closed-loop teardown.** Orphans accumulate; the monitor alerts but doesn't reap.

## Threat model

Same as iter 2, plus iter-3 additions noted inline.

**Cross-session, manual-cd, concurrent attach, cross-topic refactor, platform self-dev work, lock liveness, disk pressure, external tooling expectations, backup creep, /build regression** (carried from iter 2).

**Adversarial / forgery / tampering (iter 2 + iter 3 additions):**

- Env-var spoofing, bindings tampering, pre-commit bypass paths, lock symlink/PID-reuse, force-take silent loss, server-start binding squat, trailer forgery, multi-machine binding injection, quarantine path traversal, topic-ID path injection, compaction prompt injection, cross-tenant via threadline, auto-promote abuse, reaper as weapon, slug collision, doc-fix lockout, branch creation outside the manager, heartbeat × git-sync commit storm, bootstrap latency.
- **(iter 3) Push-gate bypass via direct-to-origin push** — `git remote set-url origin <real>` or fresh clone in `/tmp/`, push direct, bypass mirror entirely. Does NOT require root.
- **(iter 3) Trailer replay** — captured trailer pasted into hand-crafted commit B with same tree.
- **(iter 3) HMAC key compromise** — backup snapshot leaks key; cross-machine restore reuses key; no rotation procedure.
- **(iter 3) Provenance overclaim** — push-gate "tree was produced inside the worktree" cannot be verified from git metadata alone (commit-tree / alternate-index / replay all break it).
- **(iter 3) Read-only session in main** — main remains a collision domain; sessions allegedly read-only can still write via subprocess.
- **(iter 3) Async-install half-initialized worktree** — agent uses worktree before deps are installed; flaky.
- **(iter 3) Destructive workspace commands not gated** — `git clean -fd`, `git reset --hard`, `rm -rf` destroy WIP without ever invoking pre-commit.
- **(iter 3) `git stash -u` misses ignored files** — `.env`, local config, `node_modules` overrides preserved nowhere; force-take loses them.
- **(iter 3) Doc-only fast path content tricks** — `docs/x.md` containing code, then `git mv` to `src/x.ts`; symlinks; mode!=100644.
- **(iter 3) Mixed-path commits split sequentially** to bypass fast path.
- **(iter 3) `Instar-Related-Topics` trailer claims topics the principal doesn't own.**
- **(iter 3) Attention-queue flooding buries promote ratifications.**
- **(iter 3) Same-topic concurrency contradiction** — iter 2 said "shared worktree, multiple sessions" but lock model is exclusive; ambiguity exploitable both ways.
- **(iter 3) Server compromise / outage** — server is sole signer/binder/preflight; outage = total dev block; RCE = forges everything.
- **(iter 3) Push-mirror → origin forwarder** — undefined; commits reach mirror but never origin (or worse, race condition).
- **(iter 3) `.code-workspace` path-following** — VS Code follows binding-derived paths; symlink-out → sensitive dir; auto-runs `.vscode/tasks.json`.
- **(iter 3) Pre-commit hook lifecycle bug** — pre-commit fires *before* commit message exists; trailer injection in pre-commit can't write to commit message.

**Adversarial / forgery / tampering (iter 4 additions):**

- **(iter 4) Direct-push-to-protected-branch via overlooked actor exemption** — admin/app/bot bypasses branch protection unless rulesets explicitly forbid.
- **(iter 4) Local kill-switch flag claimed to "disable GH check"** — control-plane contradiction; local file cannot affect origin-side enforcement.
- **(iter 4) Doc-fix-merge-to-main bypassing branch protection** — privileged path attacker abuses if `mode: doc-fix` short-circuits required checks.
- **(iter 4) GH-runner cross-repo oracle abuse** — public verify endpoint returns valid/invalid for arbitrary commit SHAs → leaks binding existence; rate-limit DoS.
- **(iter 4) Tunnel SPoF** — single Cloudflare Tunnel URL is sole liveness path; URL rotation or tunnel-down breaks GH check.
- **(iter 4) Online-verify race / replay-on-retry** — same commit pushed twice (network retry, parallel CI run) consumes nonce non-idempotently → second push fails legitimate retry.
- **(iter 4) Offline commit window** — developer commits, closes laptop, pushes 2 days later → 5-min trailer expiry rejects legitimate push.
- **(iter 4) Push-time HMAC verification key compromise on GH** — if GH-side verification needs HMAC key, embedding in GH secrets exposes key to GH employees / log injection / forks.
- **(iter 4) `git stash --include-ignored` repo bloat** — stashing `node_modules/` (ignored) writes hundreds of MB into `.git/objects`, bloats clone size for every future user.
- **(iter 4) `cp -al` cross-worktree inode aliasing** — file-level hardlinks on ext4 share inodes; in-place edits (sed, fs.writeFileSync) modify the file in *every* hardlinked worktree simultaneously, destroying isolation.
- **(iter 4) Headless-daemon keychain hang** — server starts as background daemon (no UI/DBus) → keychain access hangs on SecKeychain APIs / libsecret without active session.
- **(iter 4) Tunnel-cache paradox** — "force-verify-cache" stored locally is unreachable when the *only* path to it (the tunnel) is down. Cache must live where the verifier (GH runner) can reach independently.
- **(iter 4) /quick-doc-fix mode-switch promotion attack** — agent in read-only mode invokes `/quick-doc-fix` → server provisions doc-fix worktree without ratification → ships 199-line markdown that disables a sibling feature via documented config example.
- **(iter 4) `git commit -a` / `git commit <file>` index handling** — commit-msg hook's `git write-tree` must honor `$GIT_INDEX_FILE` (Git sets a temp index for partial commits); otherwise trailer signs the wrong tree.
- **(iter 4) IDE bypass of PATH shim** — VS Code, JetBrains, GitKraken invoke absolute `/usr/bin/git` (or bundled `node-git`/`isomorphic-git`); shim never sees the call.
- **(iter 4) GH-created merge commit lacks trailer** — PR squash/merge buttons create a new commit on `main` authored by `noreply@github.com`; that commit has no Instar trailer; required check fails on its own merge.
- **(iter 4) Multi-machine binding-history blindness** — machine A signs trailer with binding {nonce: X}; machine B never sees it; GH check on B's push to same topic can't verify nonce uniqueness across machines.
- **(iter 4) Snapshot tarball as secrets store** — `.snapshots/<wt>-<ts>.tar.zst` contains `.env`, kubeconfigs, AWS credentials — chmod 0644 default + 14d retention = effective secrets bucket discoverable via `find`.
- **(iter 4) Disk-imaging-derived machineId collision** — `system_profiler` Hardware UUID survives Time Machine restore / `dd` clone → two physical machines present same machineId → fencing token collision.
- **(iter 4) `Instar-Trailer-KeyVersion` mismatch DoS** — attacker repeatedly forces GH check to query for a key version the server has retired, exhausting cache.
- **(iter 4) Day -2 prerequisite-PR trust-on-first-use** — first installation of GH ruleset + workflow ships in a PR that, by definition, *cannot yet be verified by the system it installs* — implicit TOFU.

Every design element below maps to at least one of these.

## Design

### Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SessionManager.spawnSession({ topicId, mode })                         │
│   - Always isolates: every session gets a worktree, including read-only │
│   - mode: "dev" | "read-only" | "doc-fix" | "platform"                  │
│   - POST /worktrees/resolve → { cwd, sessionContextPath, fencingToken } │
│   - spawn(claude, ['-c', cwd, ...])                                     │
│   - On stop: POST /worktrees/release { sessionId, fencingToken }        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  WorktreeManager (server)                                               │
│   - resolveCwdForTopic — atomic create+bind+lock                        │
│   - Locks: O_NOFOLLOW + fstat owner check + boot-ID + atomic rename     │
│   - Fencing: <machineId>:<counter>; mirror enforces monotonic           │
│   - Force-take: FS snapshot → stash -u → audit → SIGTERM → bump token   │
│   - Heartbeat: server-stamped, server-signed, adaptive cadence          │
│   - Server-down mode: read-only fallback (no new binds; doc-fix path)   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Hook chain (commit time)                                               │
│   - pre-commit (advisory): preflight cwd vs binding, cache validation   │
│   - commit-msg (authoritative trailer injection):                       │
│       computes treeHash via `git write-tree`, calls server for signed   │
│       trailer over (treeHash, parentSha, topicId, sessionId, nonce,     │
│       expiry); injects via `git interpret-trailers --in-place`          │
│   - prepare-commit-msg / post-commit are not used                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Authoritative gate: ORIGIN-SIDE GitHub ruleset + Actions check         │
│   - GitHub Repository Ruleset (NOT branch protection) on main,          │
│     topic/*, platform/* — denies direct push unless required check      │
│     `worktree-trailer-sig-check` passes; no admin bypass; no app        │
│     bypass except explicitly allowlisted github-actions[bot] for        │
│     PR merge commits; force-push disabled; tag protection on            │
│     v*; deletion disabled                                               │
│   - Action verifies trailer Ed25519 signature OFFLINE using public key  │
│     baked into the workflow file (no live server call needed for        │
│     signature verification)                                             │
│   - Action calls server only for nonce-uniqueness AND binding-history   │
│     freshness (AUTHENTICATED via GH OIDC token + repo-scoped check)     │
│   - On nonce-check unreachable, falls back to GH Repo Variable cache    │
│     `INSTAR_VERIFY_CACHE` (server-pushed signed bundle, 1h freshness)   │
│   - This is the ONLY non-bypassable layer for managed branches          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Optional local mirror at .instar/git-mirror.git (fast feedback)        │
│   - Bare repo configured as `origin` push URL                           │
│   - Pre-receive verifies trailer locally → fast feedback (~ms)          │
│   - Post-receive forwards to `upstream-origin` (the real GitHub)        │
│   - Mirror is BYPASSABLE — that's why GitHub-side check is the gate     │
│   - Mirror is opt-in for users who want fast feedback                   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Destructive-command interception (MANDATORY for managed sessions)      │
│   - SessionManager wraps spawned shells: writes session-local           │
│     `~/.instar-session-bin/` directory containing `git`, `rm`           │
│     wrappers; PATH-prepends it; sets GIT_EXEC_PATH to wrapper           │
│   - Wrappers also enforced via bash-function injection in BASH_ENV /    │
│     ZDOTDIR for non-PATH shells, AND via fsnotify-watching the          │
│     worktree (catches IDE-direct invocations of /usr/bin/git)           │
│   - Block execution unless snapshot succeeds; snapshot stored at        │
│     .instar/worktrees/.snapshots/<wt>-<ts>.tar.zst, chmod 0600,         │
│     optionally age-encrypted via session keychain key                   │
│   - Fallback for unintercepted IDE/external tool deletions: matrix      │
│     reaper detects and quarantines via .git/index reflog scan + WAL     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Daily orphan-reaper job + WorktreeMonitor                              │
│   - Single scanner; consumes state-reconciliation matrix                │
│   - Quarantine-only first pass; 14d before delete                       │
│   - Walks BOTH `git worktree list --porcelain -z` AND                   │
│     readdir(.instar/worktrees/) AND .snapshots/                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Authority model — restated for iter 3

| Concern | Source of truth | Why |
|---------|----------------|-----|
| Topic→worktree binding | Server in-memory + machine-local file `.instar/local-state/topic-worktree-bindings.json` (gitignored) | Sessions cannot tamper; not git-synced (cross-tenant attack vector) |
| Session lock | Server, mirrored at `.instar/worktrees/<wt>/.session.lock` (gitignored) | Server is the writer; file is for crash-recovery readability |
| Heartbeat timestamp | Server (sessions POST, server stamps + signs) | Prevents future-dating + partial writes |
| Session context | `<cwd>/.instar/session-context.json` (mode 0600, server-signed, server-validates uid+pid on every read) | Tamper-resistant for subprocess inheritance via file, not env |
| Commit trailer | commit-msg hook injects via server-signed call | Authoritative gate is **GitHub-side branch-protection check**, not local |
| **Authoritative push gate** | **GitHub Repository Ruleset + required check `worktree-trailer-sig-check` on `topic/*`, `platform/*`, `main`** (Ed25519 signature verified offline by GH workflow; nonce-uniqueness checked against server OR GH Repo Variable cache fallback) | Origin-side; non-bypassable by any client tooling, including admins (no admin bypass), apps (only github-actions[bot] for PR merge), or direct push (rejected by ruleset) |
| Local mirror (fast feedback only) | `.instar/git-mirror.git` if user opts in | Catches errors at push time instead of PR-check time; bypassable, so not authoritative |
| Reap eligibility | Server-derived from commit timestamps + signed lock heartbeats + matrix | Sessions cannot poison `lastActivityAt` |
| Fencing token | `<machineId>:<counter>` ; counter persisted in `.instar/local-state/fencing.json`, HMAC-signed, monotonic-on-load via `max(disk, max-active-token+1)` | Defeats counter reset; per-machine for multi-machine cleanliness |

**Env vars (`INSTAR_*`) become hints only.** Authority is in `session-context.json` and server.

### Session modes (iter 3 — no session ever cwds main)

Every spawnable session resolves to a worktree:

- **dev**: full topic worktree, lock acquired, commits to `topic/<id>-<slug>` allowed.
- **read-only**: dedicated read-only worktree at `.instar/worktrees/topic-<id>-readonly/` (no branch, no lock-required, but isolated cwd). Commits BLOCKED by the commit-msg hook. **"Read-only" means "cannot produce authorized commits" — not OS-level filesystem immutability. Subprocesses can write; OS-level immutability requires sandbox/jail and is out of scope.**
- **doc-fix**: dedicated doc-fix worktree at `.instar/worktrees/topic-<id>-doc-fix/`; commits limited to allowlisted paths and ≤200 lines; commit-msg hook injects trailer with `mode: "doc-fix"`. **(iter 4) Doc-fix commits push to a `topic/<id>-doc-fix` branch and open a PR auto-labeled `instar-doc-fix`; merge queue auto-merges after the same `worktree-trailer-sig-check` passes.** No privileged direct-to-main path. Doc-only classification is re-evaluated server-side at GH check time using the actual diff (not just the trailer claim).
- **platform**: shared platform branch worktree, exclusive lock, commits to `platform/<slug>` allowed.

**Main checkout is never used as a session cwd.** Main is reserved for: human inspection, the user's own IDE root, and reading-only operations from the dashboard. The only commits to main are merge commits authored by `noreply@github.com` (the `github-actions[bot]` PR-merge actor) — explicitly allowlisted in the ruleset and exempt from trailer-required check (see "GitHub ruleset" section).

### Same-topic concurrency model (iter 3 — pinned exclusive)

**One session at a time per topic worktree.** Sessions on the same topic do NOT share a worktree concurrently. Resolution:

- Session A holds the lock → working in `topic-2317-github-prs/`.
- Session B for topic 2317 spawns: server returns 409 LockHeld with `holder` metadata.
- B's spawn surfaces the prompt; user can wait, force-take, or cancel.
- When A releases (clean exit OR force-take), B attaches to the same worktree (preserving uncommitted progress) — sequential.
- The "shared topic context" benefit is achieved through sequential attachment, not concurrency.

### Branch + path naming (canonical)

| Kind | Branch | Worktree path |
|------|--------|---------------|
| Topic dev | `topic/<id>-<slug>` | `.instar/worktrees/topic-<id>-<slug>/` |
| Topic read-only | (no branch) | `.instar/worktrees/topic-<id>-readonly/` |
| Topic doc-fix | `topic/<id>-doc-fix` | `.instar/worktrees/topic-<id>-doc-fix/` |
| Topic build (legacy /build) | `topic/<id>-build-<task-slug>` | `.instar/worktrees/topic-<id>-build-<task-slug>/` |
| Platform | `platform/<slug>` | `.instar/worktrees/topic-platform-<slug>/` |
| Quarantined orphan | (preserved) | `.instar/worktrees/.quarantine/<sanitized-name>-<ts>/` |
| Snapshot (destructive-command capture) | (none) | `.instar/worktrees/.snapshots/<wt>-<ts>.tar.zst` |
| External worktree (e.g., instar-imessage-review) | preserved | preserved (matrix row "external" — no quarantine) |

**Slug rules:** `topicId` matches `^[0-9]+$` or literal `platform`, else 400 at API. Slug derivation: lowercased, alnum + `-`, max 30 chars; collision append `-<6char-hash>`.

### Topic-binding state file (machine-local)

`.instar/local-state/topic-worktree-bindings.json` — schema unchanged from iter 2 except adding `machineId` to active entries and storing fencing tokens as `<machineId>:<counter>`.

`.instar/state/topic-branch-map.json` (git-synced, signed):

```json
{
  "schema": "v1",
  "topicBranches": {
    "2317": {
      "branch": "topic/2317-github-prs",
      "createdAt": "2026-04-17T20:30:00Z",
      "createdBy": "<machineId>:<sessionId>",
      "serverSignature": "<HMAC>"
    }
  }
}
```

This file syncs across machines so all machines agree on the topic→branch mapping; the *worktree path* for that branch is local and never syncs.

### Lock protocol (iter 3 hardened)

`.instar/worktrees/<wt>/.session.lock` (gitignored):

```json
{
  "schema": "v2",
  "machineId": "8a4f...",
  "bootId": "C5D8...",
  "pid": 84321,
  "processStartTime": 1776473309,
  "sessionId": "928c605d-...",
  "fencingToken": "8a4f:47",
  "topicId": 2317,
  "acquiredAt": "2026-04-17T23:50:00Z",
  "heartbeatAt": "2026-04-17T23:55:32Z",
  "serverSignature": "<HMAC over the rest, with key-version field>"
}
```

Acquire / heartbeat / release: as iter 2.

**Force-take protocol (iter 4 — FS snapshot + scoped stash, no `--include-ignored`):**

1. Server takes worktree-dir advisory `flock`.
2. **APFS / btrfs / xfs:** server creates filesystem snapshot or `cp -c` clone of the worktree (sub-second). Otherwise (ext4, HFS+, tmpfs, network mounts): `tar --use-compress-program=zstd -c` of worktree, excluding `node_modules/`, `dist/`, `.next/`, `build/`, `target/` via explicit `--exclude-from` list (NOT `.gitignore` honor — `.env` is in `.gitignore` and we *want* it). Output: `.instar/worktrees/.snapshots/<wt>-<ts>.tar.zst`. **Snapshot file is `chmod 0600` and optionally age-encrypted using a per-machine snapshot key derived from the keychain HMAC key (HKDF expand).**
3. Server runs `git -C <wt> stash push --include-untracked -m "instar-force-take from session <A> by <B> at <ts>"`. **`--include-ignored` is intentionally OMITTED** — stashing ignored content writes `node_modules/` (hundreds of MB) into `.git/objects` permanently bloating the repo. Ignored WIP (`.env`, local config) is preserved in step 2's snapshot tarball, not in git.
4. Server appends to `.lock-history.jsonl`.
5. Attention-queue alert with `stashRef`, `snapshotPath`, both session IDs. Severity: high. Channel: ratification (separate from observability flood). Alert text explicitly mentions "ignored files (e.g., .env) are in the snapshot, NOT the stash — restore via `instar worktree restore-snapshot <path>`."
6. SIGTERM A's pid (only if same machine + boot-ID match + pid alive).
7. Bump fencing token; write new lock; return to taker.
8. A's old token rejected on any operation; A's CLI surfaces "your lock was taken; work preserved at <stash> + snapshot at <path>".

**Conflict on attach:** server returns `409 LockHeld { holder, age, machineId }`. SessionManager surfaces interactive prompt; default = refuse after 10s timeout.

### Key management (iter 4 — Ed25519 + HMAC, headless fallback, server-derived machineId)

**Two key types:**

- **HMAC key (32-byte symmetric)** — used for bindings, locks, heartbeats, server-internal artifacts (anything verified only by the server itself).
- **Ed25519 keypair** — used exclusively for commit trailer signing. **Public key is baked into `.github/workflows/worktree-trailer-sig-check.yml` at install time, so the GH workflow verifies trailers offline without contacting the server.** Private key never leaves the agent machine.

**Storage:**

1. **Primary**: OS keychain (macOS Keychain Services, Linux libsecret/gnome-keyring/kwallet, Windows Credential Manager).
2. **Headless fallback**: if `os.platform()` keychain probe fails or returns within an interactive-prompt-required state, server falls back to flat file `.instar/local-state/keys.enc` with `chmod 0600`. Contents are AES-GCM encrypted using a key derived from the machine's `/etc/machine-id` (Linux) or `system_profiler` UUID (macOS) + a server-bootstrap salt persisted at `.instar/local-state/.boot-salt` (also `0600`). On Docker/headless: server logs a one-line warning at startup ("keychain unreachable; using flat-file fallback at <path>"); user can opt back into keychain with `instar worktree keychain migrate`.

**machineId derivation (iter 4 — server-keychain UUID, NOT OS-derived):**

- At server first-start, server generates a fresh `crypto.randomUUID()` and stores in keychain as `instar.machineId`. Never derived from `system_profiler` / `/etc/machine-id` / `wmic csproduct get UUID` — those survive Time Machine restores, `dd` clones, and disk imaging, producing collision risk.
- `bootId` continues to come from OS (used only for stale-lock detection within a single boot, not for cross-machine identity).

**Rotation:**

- `instar worktree rotate-keys` requires (a) successful keychain prompt (user presence verification), (b) attention-queue ratification on the `key-ops` channel (separate from `ratification` channel; rate-limited 1 per hour), and (c) re-signs all active bindings/locks/heartbeats with new HMAC key version. Ed25519 rotation requires updating the GH workflow public key — bundled into the rotation as a separate PR auto-opened by the rotation CLI.
- Each signed artifact carries `keyVersion: N`. Old key valid for 24h grace window. After grace, artifacts under retired key versions are rejected (DoS protection: rejected with HTTP 410 Gone, no cache lookup).

**Backup behavior:**

- Keys are **never** included in instar's snapshot/git-sync system. Restore on a new machine generates a fresh keypair. Any artifact signed under the old machine's keys is unverifiable — surfaced as "key restore needed" attention-queue prompt; user can manually transfer via secure channel (`instar worktree export-keys --to <secure-path>` + `instar worktree import-keys --from <secure-path>` requires the recipient machine's keychain prompt).

**Pre-receive hook key acquisition (optional mirror):** the local mirror's pre-receive shim POSTs to the agent server. Hook does not hold any key.

**GitHub-side check key acquisition:** Ed25519 *public* key is baked into the workflow YAML (verified by file hash at install time). For nonce-uniqueness check (which still needs server contact), see "Authoritative push gate" below.

### Commit trailer (iter 4 — Ed25519 + offline-friendly expiry + index-aware)

**Trailer format (server-issued; Ed25519 signature, replay-defended):**

```
Instar-Topic-Id: 2317
Instar-Session: 928c605d
Instar-Worktree-Branch: topic/2317-github-prs
Instar-Trailer-Nonce: <16-byte b64>
Instar-Trailer-Parent: <full SHA of HEAD at time of signing>
Instar-Trailer-Issued: <unix-ts, time of signing>
Instar-Trailer-MaxPushDelay: <seconds, default 7d>
Instar-Trailer-KeyVersion: 1
Instar-Trailer-Sig: <Ed25519 over: SHA256(treeHash || topicId || sessionId || nonce || parent || issued || maxPushDelay || keyVersion || repoOriginUrl)>
```

**Issued + max-push-delay replaces fixed 5-min expiry (iter 4).** Validity = `issued ≤ pushReceivedAt ≤ issued + maxPushDelay`. Default 7 days accommodates "commit local, close laptop, push later." MaxPushDelay can be tuned per-repo via server config; floor 5 min, ceiling 30 days. Replay across the window is prevented by the nonce uniqueness check (see below).

**`repoOriginUrl` is included in the signed payload** to prevent commits signed for repo A being replayed against repo B.

**Hook lifecycle (iter 3 fix, retained):**

- `pre-commit` runs preflight: cwd vs binding match, lock owner check, foreign-WIP scan, doc-only fast path policy if `mode: doc-fix`. **Does not touch commit message.**
- `commit-msg` runs trailer injection:
  - **Honor `$GIT_INDEX_FILE`** — if set (Git's `commit -a`, `commit <file>`, partial commit), `git write-tree --missing-ok` is invoked with that index env var inherited; otherwise it reads the default index. Hook test: `printenv GIT_INDEX_FILE` and pass through. Without this, partial commits sign the wrong tree.
  - Read `parentSha` via `git rev-parse HEAD` (or `0000...` for initial commit). For merge commits (multiple parents), pass an array of parent SHAs; signed payload becomes `treeHash || topicId || sessionId || nonce || parents.join(",") || ...`. **For commits where Git lifecycle indicates `$GIT_REFLOG_ACTION=merge`**, sign all parents in order.
  - POST `/commits/sign-trailer { sessionId, fencingToken, treeHash, parents[], indexFile }` → server returns nonce + signature + issued + maxPushDelay.
  - `git interpret-trailers --in-place --trailer "..."` writes them.
- **`prepare-commit-msg` is NOT used. `post-commit` is NOT used.** Trailers must land before commit hashes its own message.

**Amend / rebase / cherry-pick policy (iter 4):**

- `git commit --amend`: `commit-msg` re-fires; new trailer issued (new nonce, fresh issued timestamp).
- `git rebase` / `git cherry-pick`: each rewritten commit re-fires `commit-msg` → fresh trailer. Old nonces silently retire (never seen at push for the rewritten commit).
- Squash-merge via PR (executed by `github-actions[bot]`): see ruleset exemption below.

### Authoritative push gate (iter 4 — GH ruleset + offline Ed25519 verify + GH-side cache)

**GitHub Repository Ruleset** (NOT classic branch protection — rulesets give finer-grained actor restrictions):

- **Targets**: branches matching `main`, `topic/*`, `platform/*`. Tag protection on `v*`.
- **Rules**: 
  - `restrict_updates`: deny direct push from any actor without passing required check.
  - `restrict_creations`: deny branch creation outside `topic/<id>-<slug>` / `platform/<slug>` patterns.
  - `restrict_deletions`: deny branch deletion via API except by `instar-reaper` GitHub App (allowlisted, scoped to `merged + 14d` rule via API call).
  - `non_fast_forward`: deny force-push.
  - `required_status_checks`: `worktree-trailer-sig-check` is required and must be the latest passing run.
- **Bypass actors**: empty by default. The github-actions[bot] is allowlisted ONLY for the squash-merge commit on `main` (recognized by author email == `noreply@github.com` AND parent commits both pass trailer check); the merge commit itself does NOT need a trailer.
- **Admin bypass**: disabled. Admins must use `instar worktree gh-rulesets emergency-downgrade` (see Rollback section) which is audited.

**`worktree-trailer-sig-check` workflow** (`.github/workflows/worktree-trailer-sig-check.yml`):

1. Triggered on every push to `topic/*`, `platform/*`, `main`, AND on every `pull_request` against `main`. Permissions: `contents: read, id-token: write` (for OIDC).
2. For each commit in the push range, parse the 9 trailer lines.
3. **Step 1 — Offline signature verify**: Verify Ed25519 signature using public key baked into the workflow file (no server contact). Verifies `treeHash || topicId || sessionId || nonce || parents || issued || maxPushDelay || keyVersion || repoOriginUrl`. Reject if signature invalid, `repoOriginUrl ≠ ${{ github.server_url }}/${{ github.repository }}.git`, `issued + maxPushDelay < pushReceivedAt`, or keyVersion is in the workflow's allowed set.
4. **Step 2 — Nonce-uniqueness verify**: 
   - **Primary path**: Action authenticates via GitHub OIDC token to the agent server's `/gh-check/verify-nonce` endpoint (server validates the OIDC token's `repository`, `workflow_ref`, `ref` claims match an enrolled-repo allowlist). POST `{commitSha, nonce, binding, treeHash, parents[]}`. Server consults binding-history; returns `{nonce_status: "unseen" | "seen-for-same-commit" | "seen-for-different-commit"}`. **Idempotent**: same `(commitSha, nonce)` accepted on retry; different commitSha for same nonce rejected.
   - **Fallback path** (server unreachable or 5xx, after 3 retries with exponential backoff): read `INSTAR_VERIFY_CACHE` GitHub Repository Variable (server-pushed signed bundle). Bundle contains `{validNoncePairs: [{nonce, commitSha, binding, expiresAt}], cacheIssuedAt, cacheSignature}`. If a matching pair exists and `expiresAt > now`, accept. Cache freshness window: 1h.
   - On both paths unreachable for a managed branch with no cached entry: fail-closed.
5. Returns pass/fail; ruleset enforces.

**Hardening of `/gh-check/verify-nonce` endpoint (iter 4):**

- **Caller authentication**: GitHub OIDC token only (no shared secrets). Server validates the OIDC JWT against `https://token.actions.githubusercontent.com/.well-known/openid-configuration`.
- **Repo-scoping**: server maintains an enrolled-repo allowlist (`.instar/local-state/enrolled-repos.json`, signed). `repo` claim must match.
- **Rate limit**: 60 req/min per OIDC `repository`; HTTP 429 on excess; alert at 50/min.
- **Oracle protection**: response is a uniform schema; never leaks "binding does not exist" vs. "nonce was used" distinguishably (returns generic `verifier_says_no` with an internally-logged reason).
- **Idempotency cache**: `(repo, commitSha, nonce)` tuples cached for `maxPushDelay` window so retries return identical results.

**Tunnel SPoF mitigation (iter 4):**

- **Named tunnel REQUIRED** (not quick-tunnel) for any repo opting into worktree-trailer-sig-check. Quick tunnels rotate URLs; named tunnels persist.
- Server polls its own external URL every 10 min; on URL change, server calls `gh api repos/<owner>/<repo>/actions/variables/INSTAR_VERIFY_TUNNEL_URL --field value=<new>` to auto-update the GH repo variable. Stale URL triggers an attention-queue alert.
- `INSTAR_VERIFY_CACHE` push frequency: every 5 min, plus on every nonce issuance. Push uses `gh api repos/<owner>/<repo>/actions/variables/INSTAR_VERIFY_CACHE`.

**Bypass-coverage table** (must reject; ruleset + ed25519 verify):

| Bypass attempt | Caught by |
|----------------|-----------|
| `git commit --no-verify` (skip local hooks) | Ed25519 verify (no trailer at all → rejected) |
| `core.hooksPath` redirect | same as above |
| Fresh `/tmp/` clone, push direct | same as above |
| `git commit-tree` raw | same as above |
| `GIT_INDEX_FILE` index manipulation | same as above (no trailer injected) |
| libgit2 / JGit / isomorphic-git | same as above |
| `gh api` create-commit | same as above |
| Push to alternate remote / mirror | mirror is bypassable; user must push to origin eventually; same Ed25519 verify there |
| `git push --force` to topic/* | ruleset `non_fast_forward: true` rejects |
| Direct push by repo admin | ruleset `bypass_actors: []` rejects |
| Replay valid trailer to new commit (same tree) | server nonce-uniqueness check (or GH cache) rejects |
| Cross-repo replay | `repoOriginUrl` in signed payload mismatches |

### Local mirror (optional, fast feedback only)

Users who want commit-time feedback (vs. push-time) configure:

- `git remote add mirror file://<repo>/.instar/git-mirror.git`
- `git push mirror topic/...` runs the same trailer verification locally (instant) before forwarding.
- Mirror's `post-receive` hook forwards to `upstream-origin` (the real GitHub remote).
- **The mirror is bypassable — its purpose is feedback, not enforcement.** Documented as such.

### Pre-commit fence (advisory layer, iter 3)

- Reads `<cwd>/.instar/session-context.json`. Server-checked uid + parent-pid on every read by the server.
- Calls `POST /commits/preflight` with `{cwd, fencingToken}`. Server validates: binding/cwd/lock/no-foreign-WIP. Hard timeout: 500ms; on timeout → fail-open-to-warn (non-blocking) with attention-queue ambiguous-outcome record.
- Mode-specific:
  - `dev` mode: standard.
  - `doc-fix` mode: stages must (a) all match `*.md|docs/**|notes/**`, (b) sum to ≤200 lines, (c) all blobs have mode 100644 (no symlinks), (d) no rename history pointing source→non-doc paths in last 5 commits.
  - `read-only` mode: any commit attempt → BLOCK with "use /promote-to-dev or /quick-doc-fix".
- Doc-fix commits do NOT count toward "topic activity" for promote ratification.

### Destructive-command interception (iter 4 — MANDATORY for managed sessions)

**Auto-installed at session spawn.** SessionManager creates `~/.instar-session-bin/` per session, populates with shim scripts (`git`, `rm`), and:

1. **PATH injection**: spawned shell PATH = `~/.instar-session-bin:<inherited PATH>`.
2. **GIT_EXEC_PATH override**: child processes that bypass PATH but respect Git's exec-path get the shim too.
3. **Bash/Zsh function injection**: BASH_ENV/ZDOTDIR points at `~/.instar-session-bin/.shellrc` which defines bash functions for `git`, `rm`, `cp` (overriding aliases set by user dotfiles).
4. **Filesystem-watcher fallback**: server runs `fswatch`/`inotifywait` on `.instar/worktrees/topic-*/`. If file count drops by >5 or `.git/index` mtime changes without a corresponding hook invocation, server takes an emergency snapshot of `.git/objects` and posts a high-severity attention-queue alert.

**Intercepted commands:**

- `git clean -fd` (and variants `-fdx`, `-x`)
- `git reset --hard`
- `git checkout -- .` (and similar discarding pathspecs)
- `git rm -r` of >5 files
- `rm -rf` of >5 entries

**Behavior:**

1. Compute would-affect file count via dry-run.
2. If count > 5 OR any tracked file would be discarded: take FS snapshot to `.instar/worktrees/.snapshots/<wt>-<ts>.tar.zst` (chmod 0600, age-encrypted).
3. Append to `.lock-history.jsonl` with `event: "destructive-cmd-snapshotted"`.
4. **If snapshot fails: BLOCK the command.** No "fail-open" path.
5. Otherwise proceed with original command.
6. Snapshot reaper-eligible after 14 days.

**IDE bypass acknowledgment (iter 4):**

VS Code's built-in Git UI, JetBrains, GitKraken, etc. invoke absolute `/usr/bin/git` or bundled libgit2 — bypassing PATH shims. The fsnotify-watching layer (item 4 above) catches these. ACKNOWLEDGED LIMITATION: the IDE itself cannot be intercepted at the syscall level on macOS without root + `csrutil disable`; the fsnotify layer is the documented best-effort defense. If the IDE deletes 100 files in <50ms, the snapshot may capture a partial state. Documented: "for high-stakes worktrees, prefer terminal git over IDE git."

**Day-2 escape hatch:** `instar worktree shim disable --session <id> --duration <minutes>` permits temporary bypass for emergency operations (e.g., recovery from a corrupted index). Audit-logged on `key-ops` channel; max 30 minutes; auto-reverts.

### State reconciliation matrix (iter 3 — adds external + snapshot rows)

| Binding | Path | In `git worktree list` | Action |
|---------|------|------------------------|--------|
| present, active | exists | yes | normal — use |
| present, active | exists | no | repair: `git worktree add` reattaching binding's branch |
| present, active | missing | no/yes-stale | quarantine binding (`status: lost`); refuse spawn until rebound |
| present, active | exists | yes, **realpath/inode mismatch** | tamper alert; quarantine; refuse spawn |
| absent | exists, under `.instar/worktrees/topic-` | yes | adopt: synthesize binding |
| absent | exists, under `.instar/worktrees/topic-` | no | orphan candidate (e.g., `integrated-being-v1`) — quarantine |
| absent | exists, OUTSIDE `.instar/worktrees/` (e.g., peer dir) | yes | **external worktree** — adopt with one-time alert; never quarantine |
| absent | exists, under `.instar/worktrees/.snapshots/` | n/a | snapshot — reaper-eligible after 14d |
| present, merged | exists | yes | reaper-eligible after grace |
| present, abandoned | any | any | reaper-eligible immediately |

### Auto-creation policy & promotion (iter 4 — all mode-switches require ratification)

- **read-only** is the default for every new topic.
- **/promote-to-dev** requires explicit principal ratification via attention queue **on a separate "ratification" channel** that is rate-limited per actor (max 3 outstanding per session); ratification items cannot be displaced by observability alerts.
- **/promote-to-platform** similar; cap of 3 concurrent platform sessions globally; per-day commit budget of 50 commits to prevent platform from becoming the new main.
- **/quick-doc-fix** also requires ratification (iter 4 — closes mode-switch attack vector). Ratification is lightweight ("doc-fix on topic 2317, ≤200 lines, paths `docs/**, *.md`") but mandatory. UI auto-prefills the ratification with a 3-line preview of the staged diff so principal can decide instantly.
- Auto-promote inside any hook is permanently disallowed.
- **Squat protection:** binding creation requires the requesting session to have at least one user message (server-verified) in the topic.

### `/build` reconciliation

Same as iter 2 but updated paths.

### Cross-topic refactor (iter 3 — ownership check + per-commit ratification)

- One topic is the **primary**; binding is created there.
- Commit message includes `Instar-Related-Topics: <id>,<id>` trailer.
- Server validates EACH related topic ID: (a) ID exists, (b) committing session's principal has had material activity (≥1 user message OR ≥1 prior commit OR ≥1 binding-history entry) in that topic. Otherwise reject.
- `--cross-topic-confirm` requires per-commit attention-queue ratification (not session-level). Each cross-topic commit → one ratification item. Auto-revoke flag privilege after 3 unratified uses.
- Notification fan-out: commits with `Instar-Related-Topics` trailer post a brief notice to each related topic.

### Branch lifecycle policy

Same as iter 2.

### Compaction-recovery integration

Same as iter 2 (sanitized fenced JSON, no `topicTitle`).

### Cross-platform matrix (iter 4 — `cp -al` removed for all platforms)

**Critical iter-4 change**: `cp -al` (file-level hardlinks) was specified for ext4 / btrfs/xfs fallback. **Removed for both.** Hardlinks share inodes; in-place file edits (`sed -i`, `fs.writeFileSync`, agent rewrites) modify *all* hardlinked siblings simultaneously, destroying isolation. Git breaks hardlinks on `checkout` but not on agent file-edits.

| Platform | FS | Mechanism | Fallback |
|----------|----|-----------|----------|
| macOS APFS | APFS | `cp -c` (clonefile, copy-on-write, sub-second) | `cp -R` full copy + warning |
| macOS HFS+ | HFS+ | `cp -R` full copy | none — same |
| Linux btrfs/xfs | btrfs/xfs | `cp -R --reflink=auto` (CoW; safe on mutation) | `cp -R` full copy + warning |
| Linux ext4 | ext4 | `cp -R` full copy | none — same |
| Linux on tmpfs/network mount | various | `cp -R` full copy | none |
| Windows native | NTFS | `robocopy /COPY:DAT /MIR /NP` (full copy; do NOT use NTFS hardlinks for source files for the same isolation reason) | none |
| Windows WSL2 (DrvFs) | DrvFs | feature-detect; usually `cp -R` | none |

**Path-length budget (iter 4 — Windows NTFS):** `MAX_PATH = 260` (legacy mode). Worktree path = `<repo-root>/.instar/worktrees/topic-<id>-<slug>/` + deepest relative path. Reserve 100 chars for `<repo-root>`, 60 chars for worktree dir name, leaving 100 chars for project files. If repo paths exceed budget on Windows, server alerts at install time; user must enable LongPathsEnabled or relocate repo.

**`node_modules` is the disk-budget culprit, not source files.** For `node_modules` specifically, use `npm install --offline` from a server-managed cache (`.instar/local-state/npm-cache/`) per worktree. Slower than hardlinks but isolation-safe. Pre-warmed template (`.instar/worktrees/.template/`) ships an installed `node_modules`; subsequent worktrees `cp -R` the template.

`bootId`: macOS `sysctl -n kern.boottime`; Linux `/proc/sys/kernel/random/boot_id`; Windows `wmic os get lastbootuptime`.

`machineId`: see "Key management" section — server-generated UUID in keychain, NOT OS-derived.

The pre-warmed template (`.instar/worktrees/.template/`) is refreshed on every successful main-tree `npm install`; template includes a `.template-package-lock-sha` file; mismatch triggers blocking install on first bind.

### Migration (iter 4 — Day -2 trust-boundary acknowledgment + GH ruleset auto-config)

**Day -2 (prerequisite PR — TRUST-ON-FIRST-USE acknowledged):** `scripts/migrate-incident-2026-04-17.mjs` + `.github/workflows/worktree-trailer-sig-check.yml` + ruleset config script ships in its own PR.

**TOFU acknowledgment**: this PR cannot be verified by the system it installs (chicken-and-egg). Migration script:
1. Generates Ed25519 keypair on the maintainer's machine (interactive — requires keychain access).
2. Outputs the public key to STDOUT for inspection.
3. Maintainer reviews + manually pastes public key into the workflow YAML in the PR.
4. PR review by a second human (4-eyes rule) is REQUIRED before merge for the Day -2 PR specifically (separate ruleset entry: `pull_request_reviews: { required_approving_review_count: 2 }` on PRs touching `.github/workflows/worktree-trailer-sig-check.yml`).
5. After Day -2 PR merges, the GH ruleset is configured via `gh api` calls embedded in the migration script (creates the ruleset, sets required check, sets bypass actors, etc.).
6. Day -2 sentinel `.instar/local-state/migration-2026-04-17.completed` is signed using the *new* Ed25519 key — anchoring future trust to this acknowledged-TOFU root.

Side-effects artifact at `upgrades/side-effects/migrate-incident-2026-04-17.md` documents the TOFU explicitly. Verifies `stash@{0}` by **SHA captured at spec-approval time** (not by label substring); refuses if SHA changed.

**Day 0 (ship + dark-launch):** WorktreeManager + commit-msg hook + matrix-based reaper + mandatory destructive-command shim + Ed25519 trailer signing (verified by Day -2's installed workflow). `INSTAR_PARALLEL_ISOLATION=warn` — local hooks warn but don't block; GH ruleset is set to `enforcement: evaluate` (logs would-block but doesn't block). Backfill bindings from worktree-list ∪ readdir ∪ build-state ∪ branch-list. In-flight sessions grandfathered for 24h via session-context cliff (only sessions with ≥1 user message before cutover-decision timestamp; new sessions post-decision NOT grandfathered).

**Day 7 cutover (gated, not date-fixed):** flip GH ruleset from `evaluate` → `active` (enforcing) only if zero-violations digest ≥48h. Local hooks flip to `block`. Skill version-shim alerts on local SHA mismatch; auto-overwrites only if local SHA matches *any* prior shipped SHA.

**Day 14 (quarantine maturation):** quarantine→delete after 14d.

### Disk strategy

- Worktrees: cross-platform matrix above. APFS clonefile is sub-second; ext4 hardlinks ~10s; full-copy with warning elsewhere.
- Mirror (if user opts in): `git clone --reference <main>` to share object storage — avoids doubling history.
- Template refresh: per main `npm install` success.
- Per-worktree disk budget: reaper enforces LRU eviction beyond `disk_budget_gb` (default 12, configurable; replaces the iter-2 8GB).
- Backup scope: `.instar/worktrees/`, `.instar/git-mirror.git/`, `.instar/local-state/` all in `BLOCKED_PATH_PREFIXES`. **`bindings-archive-YYYY-MM.json` files are explicitly local-only and ephemeral; not restorable across machines.** Documented.
- Snapshot disk: `.snapshots/` is reaper-managed; same 14d quarantine + delete window.

### Server load + SLOs (iter 3 — explicit)

| Op | p99 target | Behavior on breach |
|----|-----------|--------------------|
| `spawnSession` end-to-end | ≤ 5s wall | spawn returns; install async; alert if breached >10% over 1h |
| `preflight` | ≤ 50ms | fail-open-to-warn; ambiguous-outcome record |
| `commit-msg` trailer signing | ≤ 100ms | fail-closed (commit aborted with retry message) |
| `heartbeat` | ≤ 20ms | adaptive cadence drops to 60s |
| GH check trailer verification | ≤ 2s p99 (Tunnel round-trip) | check fails-closed; force-verify-cache fallback |
| Reaper full pass | ≤ 30s | parallelize; concurrency=4 |
| Force-take (snapshot + stash) | ≤ 10s | hard timeout; partial snapshot OK with alert |

Heartbeat adaptive cadence: 15s when active, 60s when idle. In-memory aggregation; write-coalesce to disk every 5 heartbeats.

### Bindings file performance & restore

- `topic-worktree-bindings.json` parse cached by `mtime`; re-read only on change.
- Active map kept ≤ 30 entries; LRU eviction of `merged`/`abandoned` first; reject-with-prompt when 30 are all `active`.
- Bindings history (server-managed): SQLite at `.instar/local-state/binding-history.db` (gitignored). Used by GH check for binding-validity-at-receive-time queries.
- Monthly archive (`bindings-archive-YYYY-MM.json`): local-only, ephemeral. Documented as not restorable across machines.

### Cross-tenant isolation

`topic-worktree-bindings.json` machine-local. `.instar/state/topic-branch-map.json` syncs (signed). HMAC keys never leave keychain.

### Observability (iter 3 — tamper-resistant)

Metrics live in server-process memory + append-only WAL at `.instar/local-state/metrics.wal` (signed rotation). Dashboard `Parallel Dev` tile reads via authenticated API. Counters from iter 2 plus:

- `commit_msg.signing_latency_ms` (histogram)
- `gh_check.verifications` (counter, with valid/invalid label)
- `gh_check.force_verify_cache_hits` (counter — should be near 0)
- `destructive_cmd.snapshots` (counter, by command)
- `snapshot.disk_bytes` (gauge)
- `server.preflight_timeouts` (counter)
- `server.availability_mode` (gauge: 1=normal, 0=read-only-fallback)

Scrape: Prometheus-pull at /metrics; retention 30d.

### `instar where` (iter 3 — auth-required)

`instar where` requires the same auth token as the HTTP API. Prints only the active worktree path for the current cwd's topic context (does not enumerate other topics). Without auth: returns "auth required; run `instar config show-token`".

### IDE integration (iter 3 — non-conflicting)

- Server writes `.instar/instar.code-workspace` (NOT `.code-workspace` at repo root). User opens it explicitly when they want the multi-folder view.
- If user has their own `.code-workspace` at repo root, instar's file is independent and doesn't conflict.
- Per-worktree shell prompt indicator: `.instar/worktrees/<wt>/.shell-prompt-suffix` for opt-in `PROMPT_COMMAND` users.
- `.code-workspace` write-time validation: server `fstat`s each binding's worktree dir; refuses to include any whose `.git` is a symlink or whose `.vscode/tasks.json` was not authored by SessionManager.

### Multi-machine binding-history sync (iter 4 — new section)

The GH check needs nonce-uniqueness verification across all machines that may push to the same topic. Per-machine `binding-history.db` would not see nonces issued by sibling machines.

**Solution: signed append-only sync log.**

- File: `.instar/state/binding-history-log.jsonl` (git-synced).
- Each line: `{ts, machineId, topicId, sessionId, nonce, treeHash, parents[], commitSha (set after push), signature (Ed25519)}`.
- Append-only; no edit/delete. On commit-trailer signing, server appends. On daily git-sync, file is committed by the existing auto-commit infrastructure.
- On `git pull`, server detects new entries via mtime + diff; ingests into local in-memory + SQLite for fast nonce lookup.
- **Conflict handling**: append-only file is ordered by `ts` post-pull; merge conflicts on this file are auto-resolved by union-merge driver registered at install time.
- **Storage growth**: 200 bytes/entry × 1000 commits/year/topic × 50 topics = ~10MB/year. Compaction at 90 days (entries past `maxPushDelay + 30d` are aggregated into a monthly digest entry and the originals dropped).
- **Server-side verification flow** (when GH check calls `/gh-check/verify-nonce`): consults the merged in-memory binding history (local + synced); returns based on the union view.
- **Race**: machine A and machine B sign trailers with same nonce concurrently (probability negligible given 16-byte nonce, but spec'd for completeness): on push, whichever push arrives at GH first wins; second is rejected with `nonce-collision-cross-machine`. Recovery: re-commit (new nonce).

### Server-down / availability mode (iter 4 — read-only fallback + GH-side cache)

When the agent server is unavailable:

- New `spawnSession` calls fail with "server-down; only existing sessions can continue, with read-only mode."
- Existing sessions whose `session-context.json` is still valid continue operating in **read-only fallback**: pre-commit blocks all commits except doc-fix-mode commits to existing doc-fix worktrees with cached pre-issued trailers.
- Heartbeat queues locally; flushes on server-up.
- **GH check fallback**: GH workflow falls back to `INSTAR_VERIFY_CACHE` Repo Variable (server-pushed every 5 min). Cache contains signed `(nonce, commitSha, binding, expiresAt)` pairs valid for 1h. Once cache age > 1h, GH check fails closed.
- Recovery: server start runs reconciliation matrix; replays heartbeat queue; emits attention-queue digest of what happened during outage.

**"Read-only" clarification (iter 4):** Read-only fallback means "the commit/push path is blocked." It does NOT prevent OS-level filesystem writes. Subprocesses spawned by the agent can still write files; they just cannot produce verified commits. OS-level immutability requires sandbox/jail/MAC and is out of scope.

## Acceptance criteria

(Iter-2 ACs renumbered; iter-3 additions appended.)

1. **AC-1 (default isolation, including read-only).** New session for any topic spawns into a topic worktree (dev / read-only / doc-fix / platform); `pwd` never returns the main checkout.
2. **AC-2 (atomic create).** First-ever dev session for a new topic creates binding + branch + worktree + lock atomically; rolls back on any step failure.
3. **AC-3 (exclusive lock).** Two sessions for topic 2317: A acquires; B's spawn returns 409 with holder metadata; user-prompt times out at 10s default = refuse.
4. **AC-4 (sequential attach).** When A releases, B attaches to same worktree; uncommitted progress visible to B.
5. **AC-5 (commit-msg trailer injection).** `git commit` invoking `commit-msg` hook produces a signed trailer with all 8 fields; trailer present in committed message.
6. **AC-6 (GH check authoritative — `--no-verify` rejected).** Commit produced via `git commit --no-verify` (skipping local hooks) is rejected by `worktree-trailer-sig-check` on push.
7. **AC-7 (GH check authoritative — direct-clone push rejected).** Commit produced from a fresh `/tmp/` clone (no local hooks at all) is rejected by GH check.
8. **AC-8 (GH check authoritative — forged trailer rejected).** Hand-written valid-looking trailer with forged signature is rejected.
9. **AC-9 (replay rejected).** Trailer captured from a pushed commit, pasted into a new commit with same tree, is rejected (nonce already seen).
10. **AC-10 (lock heartbeat + boot-ID).** Heartbeat every 15s active / 60s idle; stale (>60s + boot-ID mismatch) is reclaimable; PID reuse after reboot correctly handled.
11. **AC-11 (force-take preserves staged + untracked + ignored).** Force-take auto-snapshots worktree (FS tarball preserves ignored files like `.env`), then `git stash --include-untracked` (NOT `--include-ignored` — would bloat `.git/objects` with `node_modules`); alert with stashRef + snapshotPath; old token rejected.
12. **AC-12 (orphan reaper recognizes non-git dir).** Existing `.instar/worktrees/integrated-being-v1/` (no .git) is quarantined within one reaper cycle.
13. **AC-13 (read-only commit blocked, doc-fix allowed).** Read-only session blocks source commits; doc-fix worktree allows ≤200-line allowlisted commits.
14. **AC-14 (doc-fix content checks).** Staged symlink in doc-fix mode rejected; staged blob with mode != 100644 rejected; rename-to-source detected and re-evaluated.
15. **AC-15 (compaction recovery).** Sanitized fenced JSON; control-char injection in `topicTitle` (if returned) is stripped.
16. **AC-16 (legacy /build compat).** Existing `/build` continues to work; `build/*` branches auto-rename to `topic/<id>-build-<task>` at migration.
17. **AC-17 (incident replay part one).** Two-session sweep regression test asserts B's commit blocked at preflight.
18. **AC-18 (incident replay part two).** Untracked-WIP destruction regression: session A has untracked file; session B force-takes; file recoverable from snapshot.
19. **AC-19 (state reconciliation matrix).** Each row of the matrix has a unit test asserting documented action.
20. **AC-20 (path-injection rejection).** `bindTopic("../etc/passwd", ...)` returns 400 at API; never touches disk.
21. **AC-21 (quarantine path traversal).** Reaper handed dirname with `..` re-slugifies via basename + alnum filter; alerts instead of moving on failure.
22. **AC-22 (multi-machine binding hygiene).** Two machines binding same topic produce independent worktrees; bindings never sync; topic-branch-map syncs and is consistent.
23. **AC-23 (push gate uptime).** GH check fails-closed on server unavailability; force-verify-cache fallback works for emergency window.
24. **AC-24 (disk budget).** With 10 active topics + reaper enabled, total `.instar/worktrees/` stays under configured `disk_budget_gb` (default 12).
25. **AC-25 (heartbeat × git-sync no commit storm).** 30-min soak: no `.session.lock` or heartbeat field in any auto-commit.
26. **AC-26 (cold-start latency).** First spawn for a brand-new topic returns within 5s wall (template clone + lock + spawn); install runs async.
27. **AC-27 (kill-switch is flag file).** `INSTAR_PARALLEL_ISOLATION=off` env ignored; only `.instar/local-state/isolation-disabled.flag` (CLI-written, attention-queue-logged, auto-expires 1h) disables.
28. **AC-28 (skill update notifier).** Mismatch between local `/build` skill SHA and shipped emits attention-queue alert; auto-overwrites only if local SHA matches *any* prior shipped SHA.
29. **AC-29 (HMAC key rotation).** `instar worktree rotate-keys` re-signs all artifacts; old key valid for 24h grace; restore-on-new-machine generates fresh key + refuses unknown-key artifacts.
30. **AC-30 (server-down read-only fallback).** Server stopped during active session: existing session blocks commits except doc-fix; new spawns fail with structured error.
31. **AC-31 (destructive-command snapshot).** `git clean -fd` in a worktree with >5 untracked files snapshots before proceeding; snapshot recoverable.
32. **AC-32 (cross-platform spawn).** Spawn meets latency targets on macOS APFS, Linux ext4, Linux btrfs; documents Windows behavior.
33. **AC-33 (related-topics ownership check).** Commit with `Instar-Related-Topics: <id>` where principal has no activity → trailer rejected at GH check.
34. **AC-34 (cross-topic-confirm per-commit ratification).** Cross-topic commit creates one attention-queue ratification item; 3 unratified → flag privilege auto-revoked.
35. **AC-35 (commit-msg trailer p99).** Trailer signing p99 ≤ 100ms under load (10 concurrent sessions × 1h soak).
36. **AC-36 (preflight p99).** Preflight p99 ≤ 50ms; on timeout, fail-open-to-warn with attention-queue ambiguous-outcome record.
37. **AC-37 (`instar where` auth).** Without auth: returns "auth required". With auth: returns only current cwd's topic worktree path.
38. **AC-38 (external worktree adoption).** External worktree (e.g., `instar-imessage-review`) generates one-time alert and is left in place; never quarantined.
39. **AC-39 (test infra harness).** Two-session ACs (AC-3, AC-4, AC-11, AC-17, AC-18) implemented via `tests/fixtures/two-session-harness.ts`; spawn two stub SessionManagers against shared server in-process.
40. **AC-40 (GH ruleset enforces direct-push deny).** `git push origin topic/2317-test` from a fresh clone with no trailer is rejected by GitHub (NOT just by missing-check) — confirms ruleset `restrict_updates` is enforcing.
41. **AC-41 (GH ruleset deny admin bypass).** Repo admin attempting direct push to `main` without trailer is rejected (no admin bypass).
42. **AC-42 (GH ruleset deny force-push).** `git push --force` to `topic/*` rejected by ruleset.
43. **AC-43 (Ed25519 offline verify).** GH workflow with no server connectivity verifies a valid trailer using only the baked-in public key (no `/gh-check/verify-nonce` call needed for signature-only step).
44. **AC-44 (GH-side cache fallback).** With agent server stopped, `INSTAR_VERIFY_CACHE` Repo Variable contains valid pair → push accepted within cache window.
45. **AC-45 (GH-side cache expiry).** With agent server stopped >1h, cache stale → push rejected with documented error.
46. **AC-46 (GH merge commit exempt).** PR merged via squash/merge button creates a merge commit on `main` authored by `noreply@github.com` with no trailer; ruleset bypass-actor allowlist accepts it.
47. **AC-47 (cross-repo replay rejected).** Trailer from repo A pasted into commit pushed to repo B → rejected (`repoOriginUrl` mismatch).
48. **AC-48 (nonce idempotency).** Same `(commitSha, nonce)` retried 5 times via GH Action retry → all 5 succeed; same nonce on different commitSha → rejected.
49. **AC-49 (offline commit + late push).** Commit signed at T=0 with `maxPushDelay=7d`; pushed at T=6d → accepted. Pushed at T=8d → rejected.
50. **AC-50 (GIT_INDEX_FILE honored).** `git commit -a` and `git commit <file>` produce trailers that sign the actual partial-commit tree (not the default index tree).
51. **AC-51 (merge-commit signs all parents).** `git merge` of two topic branches produces a trailer signing both parent SHAs in order.
52. **AC-52 (mandatory shim — fresh shell).** Fresh terminal spawned by SessionManager has shim PATH; `which git` returns the wrapper; `git clean -fd` with 6 files snapshots first.
53. **AC-53 (mandatory shim — IDE bypass detected).** External IDE invokes `/usr/bin/git clean -fd` directly; fsnotify detects file-count drop > 5 within 100ms; emergency snapshot taken.
54. **AC-54 (snapshot encryption + perms).** `.snapshots/<wt>-<ts>.tar.zst` is `chmod 0600`; cannot be decrypted without keychain access.
55. **AC-55 (binding-history sync).** Machine A signs trailer with nonce X; binding-history-log.jsonl auto-commits and syncs; Machine B's server ingests the entry; GH check on Machine B's later push correctly sees nonce X as already-used.
56. **AC-56 (named tunnel URL auto-update).** Tunnel URL rotates; server updates `INSTAR_VERIFY_TUNNEL_URL` GH repo variable within 10 min.
57. **AC-57 (`/quick-doc-fix` ratification required).** Invoking `/quick-doc-fix` from a read-only session blocks until ratification on `ratification` channel succeeds.
58. **AC-58 (rotate-keys requires keychain + ratification).** `instar worktree rotate-keys` blocks on keychain prompt AND attention-queue ratification on `key-ops` channel.
59. **AC-59 (rollback separation).** Local `isolation-disabled.flag` set: local hooks disabled; pushing rejected commits still blocked at GitHub. `gh-rulesets emergency-downgrade` requires separate GH PAT auth and ratification.
60. **AC-60 (machineId from server keychain).** Two physical machines that were imaged from the same disk snapshot present DIFFERENT `machineId` values after first server-start; fencing tokens never collide.
61. **AC-61 (headless keychain fallback).** Server started with `keychain unreachable` env (e.g., Docker container) writes encrypted flat-file fallback at `.instar/local-state/keys.enc`, mode 0600; logs warning.
62. **AC-62 (TOFU acknowledgment in Day -2 PR).** Day -2 PR includes side-effects artifact explicitly stating the TOFU; PR requires 2 approving reviews via ruleset entry on `.github/workflows/worktree-trailer-sig-check.yml` paths.
63. **AC-63 (oracle protection).** `/gh-check/verify-nonce` called with random commit SHAs returns uniform error response; rate-limit triggers at 60/min/repo with HTTP 429.

## Side effects

(Iter-2 table extended.)

| Area | Effect | Mitigation |
|------|--------|------------|
| `SessionManager.spawnSession` | Always returns isolated cwd; main never used | Default `null` topicId now spawns to `platform`/`read-only` per mode |
| `commit-msg` hook | New required hook for trailer injection | Installed by `instar worktree shim install`; runs locally |
| GitHub Actions | New required check `worktree-trailer-sig-check` | Branch protection update documented |
| Cloudflare Tunnel | Trailer-verify endpoint now critical-path for pushes | SLOs documented; force-verify-cache fallback |
| OS Keychain dependency | HMAC key in keychain (macOS/Linux/Windows) | Documented; `instar worktree show-keychain-status` for diagnostics |
| Push behavior | Push goes to GH; optional local mirror provides fast feedback | Backward-compat with existing user push flow; mirror opt-in |
| Disk usage | +N GB worktrees + .snapshots/ + optional mirror | Reaper + budget + 14d snapshot retention + `--reference` mirror |
| Backup scope | Worktrees, mirror, local-state, snapshots all excluded | `BLOCKED_PATH_PREFIXES` |
| `/build` | Refactored; legacy branch namespace renamed | Auto-rename at migration |
| External IDE | Auto-managed `.instar/instar.code-workspace` | Never overwrites user's `.code-workspace` |
| Telegram routing | Cross-topic commits fan out per related topic | One-line side-effect; uses existing topic-routing infra |
| Compaction-recovery hook | Sanitized fenced JSON; `set +e` around lookup | Never crashes |
| Destructive workspace commands | MANDATORY PATH+function+fsnotify shim auto-installed per session | Auto-installed at session spawn; IDE-direct invocations caught by fsnotify |
| GitHub Repository Ruleset | New ruleset with required check, no admin bypass, force-push deny | Auto-configured by Day -2 migration script via `gh api`; downgrade requires audited CLI |
| Ed25519 keypair on each agent machine | New per-machine keypair; public key in workflow YAML | Auto-generated at server first-start; `rotate-keys` opens PR to update public key |
| `INSTAR_VERIFY_CACHE` GH Repo Variable | Server pushes signed cache every 5 min | Auto-managed; size limit 48KB |
| `INSTAR_VERIFY_TUNNEL_URL` GH Repo Variable | Server updates on URL change | Auto-managed via `gh api` |
| `binding-history-log.jsonl` git-synced | Append-only signed log, ~10MB/year | Compaction at 90d via monthly digest |
| GH PAT requirement | `actions:write` PAT for variable updates | Per-repo, gitignored config |

## Rollback (iter 4 — local vs origin separated)

**Local-side rollback** (does NOT affect origin enforcement):

- `.instar/local-state/isolation-disabled.flag` (CLI-written, 1h auto-expire, attention-queue-logged) disables ONLY local preflight + commit-msg hook + destructive-command shim. Does NOT affect GH ruleset / required check. Pushes still gate at origin.
- `WorktreeManager.releaseAllLocks()` clears stuck locks (server CLI auth required).
- Mirror, if installed, can be removed via `instar worktree mirror uninstall`.
- Reaper disabled via `.instar/jobs.json`.

**Origin-side rollback** (audited, separate authority):

- `instar worktree gh-rulesets emergency-downgrade --reason "<why>" --duration <minutes>` flips ruleset from `enforcement: active` → `evaluate` (logs would-block, doesn't enforce). Requires (a) GitHub Personal Access Token with `repo` scope (separate from local server auth), (b) attention-queue ratification on `key-ops` channel, (c) auto-reverts after `--duration` (max 4 hours). Audit log appended to `.instar/state/gh-ruleset-audit-log.jsonl` (signed, git-synced).
- `instar worktree gh-rulesets restore` immediately re-enables enforcement.
- The local `isolation-disabled.flag` CANNOT trigger this — it requires a deliberate, separate, audited GitHub API call.

**Critical separation**: a local kill-switch cannot disable origin-side enforcement. Even if every dev machine is compromised, `main` and `topic/*` are still protected by the GitHub ruleset until a maintainer explicitly downgrades it via authenticated GH API call.

## Open questions remaining for human review

(Iter-2 Q1-Q5 resolved in iter 2; Q1-Q3 remaining iter-2 items resolved in iter 3:)

- R1 (resolved): mirror is opt-in fast-feedback only; not authoritative. GH check is authoritative.
- R2 (resolved): `/promote-to-dev` ratification required when principal is another agent; auto-allowed when principal is the user (Sybil-protection verified).
- R3 (resolved): merged `topic/*` branches kept on remote, deleted locally; remote retention out of scope here.

(Iter-3 questions resolved in iter 4:)

- R4 (resolved): GH workflow uses Ed25519 *offline* signature verification with public key baked in; only nonce-uniqueness needs server contact, hardened with OIDC + rate limit + GH-side cache fallback.
- R5 (resolved): destructive-command shim is now MANDATORY (auto-installed at session spawn) per GPT iter-3 critical 5.
- R6 (resolved): GH-side cache TTL = 1h; trailer `maxPushDelay` = 7d (separate concerns).
- R7 (resolved): `--include-ignored` permanently dropped from stash (Gemini iter-3 critical 1); ignored WIP preserved via FS snapshot tarball, not git.

(Iter-4 questions for human review:)

- **R8** Should `INSTAR_VERIFY_CACHE` live in a dedicated `instar-cache` branch instead of GH Repo Variables? Trade-off: branch is git-history (auditable) but inflates clone size; Repo Variable has 48KB limit per variable. Lean: Repo Variable until cache > 48KB, then auto-shard or migrate to branch.
- **R9** Should the GH ruleset enforce on PRs only, or on every direct push too? Trade-off: enforcing on every push is the strongest guarantee but may break legitimate `topic/*` work-in-progress pushes that haven't run hooks yet. Lean: enforce on every push (commit-msg hook is fast — should never legitimately commit without trailer in a managed session).
- **R10** Headless-server fallback uses `/etc/machine-id` as part of the file-encryption key derivation; this re-introduces some of the disk-imaging-collision concern (the file would decrypt on a clone). Should the fallback file additionally require a user-provided passphrase at server start? Lean: yes for production deployments, no for dev (configurable via `keychain.fallback.requirePassphrase`).
- **R11** Should `binding-history-log.jsonl` 90-day compaction be tunable per repo? Some repos have legal-hold requirements. Lean: configurable, default 90d; warn at install if repo has `LEGAL_HOLD` GH env variable set.
- **R12** Should rotation of the Ed25519 key auto-open a PR to update the workflow YAML public key, or require maintainer to run a separate command? Lean: auto-open PR; less ergonomic friction than manual.
- **R13** When the agent server's tunnel URL changes, the auto-update of `INSTAR_VERIFY_TUNNEL_URL` requires a GH PAT with `actions:write` scope. Where does that PAT live? Lean: per-repo `.instar/config.local.json` (gitignored), seeded by `instar worktree gh-rulesets install`. Acknowledged risk: PAT leak = ability to disrupt verification.

## Iter-4 known issues (surfaced by iter-4 reviewers; pending pre-Day-0 hardening)

These were identified by the iter-4 review pass and are tracked as **pre-Day-0 hardening tasks**, not blockers for spec approval. Each is localized hardening rather than architectural change.

**Critical (must address before Day 0):**

- **K1 (adversarial V1):** Headless flat-file fallback (`.instar/local-state/keys.enc`) with a `.boot-salt` colocated next to it makes Ed25519 private-key extraction trivial if an attacker gets disk access. R10 deferred passphrase requirement to "production deployments only." Fix: require user passphrase in headless mode unconditionally (split R10 into two flags: `headless.allowed` (default false) and `headless.passphrase.required` (default true if headless.allowed)).
- **K2 (adversarial V4):** `INSTAR_VERIFY_TUNNEL_URL` Repo Variable creates an SSRF / OIDC-token-exfiltration vector — anyone with `actions:write` PAT (or a leaked one) can redirect the workflow to an attacker URL and capture the workflow's GitHub OIDC token (replayable against AWS/Vault/npm provenance). Fix: pin Tunnel URL hash in workflow YAML at install time; URL changes require a workflow-edit PR (which itself requires the 2-approval rule).
- **K3 (adversarial V5):** `binding-history-log.jsonl` is "append-only by convention" — `git rebase -i` can drop nonce entries, enabling replay. Fix: Merkle-chain entries with `prevEntrySha`; periodically anchor chain head to a GH Repo Variable so any tampering is detectable.

**High (address during Day 0):**

- **K4 (adversarial V2):** Workflow public-key version rollback — the 2-approval rule on the YAML path is an enforcement choice that can be downgraded later. Fix: make the 2-approval rule permanent via CODEOWNERS + ruleset entry that itself requires 2 approvals to modify.
- **K5 (adversarial V3):** Signed `INSTAR_VERIFY_CACHE` bundles can be replayed from older snapshots if an attacker has `actions:write`. Fix: add monotonic `cacheSequence` integer; server rejects on regression.
- **K6 (adversarial V7):** Auto-PR for Ed25519 rotation has no out-of-band proof the new public key matches a key the legitimate server holds. Fix: rotation CLI emits a challenge-signature in the PR body; CI verifies via signature on a known canary string.
- **K7 (security N1):** `binding-history-log.jsonl` git-synced to repo leaks per-topic, per-session, per-commit metadata to anyone with repo read access — partial undermining of "bindings stay machine-local" guarantee. Fix: sync to a separate `instar-binding-history` private repo (or branch with restricted read), not the main repo.
- **K8 (security N2):** GH PAT for variable updates is `actions:write` which carries broad workflow-modify rights. Fix: use a fine-grained PAT scoped to the two specific Repo Variables, or a GH App with `actions: write` only for those variables.
- **K9 (integration F1):** SessionManager spawns via `tmux new-session -d` with `-e KEY=VAL` env flags. Mandatory shim must be passed via `tmux -e PATH=<shim>:$PATH` or shim never reaches Claude's child shells. Spec must specify tmux env flag explicitly in the implementation note.
- **K10 (integration F2):** `binding-history-log.jsonl` written through existing `GitSync.queue()` (debounceMs=30_000) would create ~100 commits/day → AC-25 commit-storm violation. Fix: write to `.instar/local-state/`, separate 24h-timer commit job that batches sync.

**Medium (address during Day 0 or Day 7):**

- **K11 (adversarial V6):** `BASH_ENV` shim escapable via `env -i` / `--noprofile`; small targeted deletions slip under fsnotify's `>5` threshold. Fix: drop threshold to `>0` for tracked files and `>=5` for untracked-only; add explicit detection of `env -i` invocations via execve audit (Linux audit subsystem; macOS Endpoint Security framework).
- **K12 (adversarial V8 latent):** Future change to `pull_request_target` would let fork PRs run with base repo's OIDC scope. Fix: add lint check forbidding `pull_request_target` in the workflow as part of the 2-approval ruleset.
- **K13 (scalability):** Full `cp -R` on ext4/HFS+ may breach the 5s AC-26 spawn target as projects grow. Fix: AC-26 wording should be FS-typed (≤5s on APFS clonefile / btrfs+xfs reflink; ≤10s on ext4/HFS+/NTFS full-copy).
- **K14 (scalability):** Linux `inotify.max_user_watches` (default 8192) can be exhausted with ≥10 active worktrees on large monorepos. Fix: server-start preflight checks current limit; warns + suggests `sysctl fs.inotify.max_user_watches=524288` on Linux.
- **K15 (scalability):** GH Actions minutes consumption (~2,250 min/mo/project) eats most of Free tier. Fix: cache Ed25519 verify result per `(commitSha, workflow_run_attempt)` so retries don't re-verify; document expected minutes consumption in side-effects.
- **K16 (integration F3):** `/gh-check/verify-nonce` route mount order in AgentServer must precede bearer-token middleware so OIDC-only auth applies. Spec should mandate mount order explicitly.
- **K17 (security N6):** Day -2 ruleset must start at `evaluate` mode, not `active`, or migration script bricks itself mid-flight (the migration's first commit would be rejected by its own ruleset). Spec already says this for Day 0, but Day -2 wording is ambiguous.
- **K18 (security N3):** `union-merge` git driver registration is install-time; sparse/partial clones don't get `.gitattributes`. Fix: server-start preflight verifies `.gitattributes` registration and warns if missing.

**Low / acknowledged:**

- **K19:** `INSTAR_VERIFY_CACHE` signed bundle key type unspecified (Ed25519 or HMAC?); rotation interaction undefined. Lean: same Ed25519 key as trailer signing; rotation re-issues cache.
- **K20:** IDE-burst-delete fsnotify race (>100 files in <50ms) admitted as residual risk; mitigation is doc-only ("for high-stakes worktrees, prefer terminal git over IDE git"). Acceptable per iter-4 review.

These items collectively shift the Day -2 → Day 0 timeline from "1 PR" to "1 PR + 6 follow-up commits before flipping to active enforcement." Migration plan accommodates this via the `evaluate → active` cutover gate.
