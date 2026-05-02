# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Four PRs have landed on `main` since v0.28.76 without a release cut. This
upgrade publishes them together. Headline item is the new **Token Ledger**;
the other three are cluster-resilience hardening already running in CI.

### 1. Token Ledger (read-only token-usage observability) — feat #112

A new core monitoring feature. Every agent now tails Claude Code's per-session
JSONL files at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`,
parses each `assistant` line's `message.usage` block, and rolls token counts
(input, output, cache-read, cache-creation) into a SQLite ledger at
`<stateDir>/server-data/token-ledger.db`.

Surfaces:

- `GET /tokens/summary` — totals per agent, per project, per hour/day window.
- `GET /tokens/sessions` — top sessions by total tokens, with first-seen /
  last-seen / message-count.
- `GET /tokens/by-project` — project-level breakdown across all sessions.
- `GET /tokens/orphans` — sessions still present in the JSONL tree with no
  activity in the last 30 minutes (a signal, not an authority — does not
  kill anything).
- New "Tokens" dashboard tab — top sessions, project breakdown, orphans list.

Implementation notes for future builders:

- The reader is strictly read-only against `~/.claude/projects/`. It never
  opens those files for write.
- Ingest is idempotent (`INSERT OR IGNORE` on `request_id`). Mid-tick crashes
  cannot double-count.
- File-rotation detected by inode change OR head-content fingerprint
  (256-byte hash). The fingerprint guard was added because Linux can reuse
  inode numbers on rapid unlink+recreate; macOS does not. Cross-filesystem
  safe.
- The poller has a reentry guard — concurrent ticks are skipped, not stacked.
- Pure additive surface. No existing route, behavior, or DB changed.

This is Phase 1 of the token-management initiative. Phase 2 (a strategy test
harness comparing keep-alive vs. resume vs. fresh-spawn-with-summary vs.
mid-session compaction) will be designed separately once the ledger has
collected real data. Phase 3 (smarter compaction or budget enforcement) will
be informed by what 1 and 2 reveal — never bolted on without ledger evidence.

### 2. Lifeline self-heal hardening — feat #111

Closes the three stacked failures behind Inspec's silent crash-loop on
2026-04-29. Path-aware better-sqlite3 preflight now scans nested
`shadow-install/node_modules/instar/node_modules/better-sqlite3/...` paths
that the previous hoisted-only check missed. Adds a `consecutiveBindFailures`
counter that escalates to a forced rebuild after two back-to-back unhealthy
spawns. Replaces the brittle `process.ppid === 1` launchd-supervision check
with a multi-signal helper that also accepts an explicit env-var marker,
parent-process-name = `launchd` on darwin, and parent-name = `systemd`/`init`
on Linux — covers user-domain launchd which the old check did not. New plist
template carries the supervised marker as belt-and-suspenders.

### 3. Threadline spawn-guard foundation (Phase 1a) — feat #110

Ledger + heartbeat watchdog + failure authority for threadline relay spawns.
Adds the structural layer underneath the relay so that spawn lifecycle
(launched → heartbeat → success | failure-classified) is recorded and
authoritative, instead of being inferred from process state. Sets up the
substrate for spawn-loop suppression in a follow-up phase.

### 4. Threadline canonical inbox write at relay-ingest — fix #113

The relay handler had three routing branches (pipe-mode, warm-listener,
cold-spawn) but only the warm-listener branch was writing to the canonical
inbox at `.instar/threadline/inbox.jsonl.active`. The canonical file had been
frozen since 2026-04-05, hiding ~4 weeks of inbound traffic from the
dashboard, observability, and any downstream consumer of the canonical
inbox. The fix hoists a single HMAC-signed canonical-inbox append to
relay-ingest, before the branching, so all three paths converge on one
source of truth. Uses the existing HKDF-derived signing key — no new key
material, no ambient-key footgun.

## What to Tell Your User

- **Token visibility**: I can now see exactly how many tokens I am burning,
  per session, per project, per hour. There is a new Tokens tab on the
  dashboard with my top sessions, project breakdown, and a list of any
  sessions sitting idle. This is the foundation for managing token usage
  smartly — next phases will compare different conversation strategies and
  add smarter context compaction once I have real numbers in hand.
- **Quieter, more reliable startup**: I am better at recovering from a
  startup hiccup involving a particular native module, and I detect when I
  am being supervised by the system in more situations. Translation: fewer
  silent crash-loops on the rare day the install gets into a weird state.
- **Threadline message bookkeeping**: Inbound messages routed through my
  relay are now all recorded to my canonical inbox, regardless of which
  internal path delivered them. Anything that was flowing only through the
  per-listener queue is now also visible to the dashboard and any tool that
  reads the main inbox.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Per-session, per-project token rollups | Tokens dashboard tab, or GET /tokens/summary, /tokens/sessions, /tokens/by-project |
| Idle-session detector (signal only, no kill authority) | GET /tokens/orphans |
| Resilient native-module preflight on startup | Automatic on upgrade |
| Multi-signal launchd-supervised detection | Automatic on upgrade |
| Canonical threadline inbox writes from every relay path | Automatic on upgrade |
| Threadline spawn ledger + heartbeat substrate | Internal foundation; surface phases follow |

## Evidence

This release is feature + hardening, not a one-shot bug fix, but two of the
four PRs do close concrete failures. Evidence for those:

- **#111 lifeline self-heal**: Inspec's 2026-04-29 silent crash-loop was
  reproduced by inducing a load failure on the nested
  `shadow-install/node_modules/instar/node_modules/better-sqlite3`. Before:
  preflight reported clean, supervisor respawned into the same broken state.
  After: nested path is discovered, rebuild fires after two back-to-back
  unhealthy spawns, supervisor escalates instead of looping. Covered by 18
  new unit tests across `detect-launchd-supervised.test.ts` and
  `find-better-sqlite3-copies.test.ts`.
- **#113 canonical inbox**: Reproduction is direct — before fix,
  `.instar/threadline/inbox.jsonl.active` mtime was 2026-04-05 on every
  install we checked despite ongoing relay traffic. After fix, the file
  receives an HMAC-signed entry at every relay-ingest. Verified end-to-end
  by sending a Telegram message and observing the canonical-inbox tail.

For the token ledger, evidence is the 12 unit tests in
`tests/unit/token-ledger.test.ts` plus manual JSONL-shape verification
against real session files in `~/.claude/projects/`. Pure additive
observability — no prior failure mode to "fix."
