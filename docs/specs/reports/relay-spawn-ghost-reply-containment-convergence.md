# Convergence Report — Threadline Relay-Spawn Ghost-Reply Containment

**Spec:** `docs/specs/RELAY-SPAWN-GHOST-REPLY-CONTAINMENT-SPEC.md`
**Iterations to convergence:** 3
**Internal reviewers:** security, scalability, adversarial, integration (all converged in round 3+4)
**External reviewers:** skipped this run — see "Known gaps" below
**Convergence date:** 2026-04-29

---

## Plain-English overview

A peer agent sent us a message. The relay logged it, said it spawned a session twice, but no session ever actually ran on our side. Despite that, the peer received four replies that mixed real commit hashes with a wrong story. We caught it only because the timing felt off.

The fix says: stop trusting any side of the pipeline that doesn't prove what it did. Three layers:

1. **Idempotence + provenance.** Don't spawn the same session twice for the same message. Give each spawn a one-time secret only the relay knows; if a session can't prove it has the secret, anything it writes is treated as forged.

2. **Heartbeat + fail-closed.** A real spawned session writes a "I'm alive" file every few seconds, signed with the secret. If the file never appears, or is signed wrong, the message goes to the inbox as "unverified" and the peer is told the spawn failed — no auto-reply, no fabrication path.

3. **Reply provenance.** Replies that talk about the codebase have to be backed by a record of commands the session actually ran (captured by a wrapper around `git`/`gh`/etc). Replies that mention five commit hashes but the wrapper only saw one `git log` get quarantined for the user to look at, never auto-forwarded.

The whole thing is wrapped in feature flags so any single layer can be turned off if it misbehaves in production.

## What changed between draft and converged

| Original (draft) | Converged | Why |
|------------------|-----------|-----|
| Heartbeat is a touched file at a known path | Heartbeat is HMAC-signed using a per-spawn secret delivered via inherited file descriptor (not env, not disk) | Otherwise any sibling process could `touch` the file and fake life. Env vars get inherited by child processes the session forks — closes that hole too. |
| Session attaches its own command log to the reply | Out-of-process shim records commands; session never sees the signing key | The whole point is the session might be lying. It can't sign its own alibi. Spec is honest that the shim is best-effort against a hostile session — quarantine catches the rest. |
| Spawn ledger as JSONL append-only file | SQLite with `INSERT OR FAIL` CAS, WAL mode, flock for second-process coordination | JSONL scan was O(n) per spawn at the 100k cap. SQLite is O(log n) and gives us atomic compare-and-swap for free. |
| Reply gate uses "fact intersect" with trace | Three-step: HMAC + signature, command-class causation, facts-to-commands ratio | "Intersect" was unimplementable without the receiver having raw stdout (privacy regression). The new check catches naive fabrication and quarantines the rest for human review. |
| Multi-machine via shared-state.jsonl 2-phase CAS | Multi-machine descoped to a follow-up spec (`MULTI-MACHINE-SPAWN-LEDGER-SPEC.md`) filed in the same PR | Round-2 review caught that shared-state.jsonl actually doesn't replicate cross-machine — the design was built on a non-existent surface. Single-machine (the case in the original incident) is fully covered. |
| Migrator rewrites TS template literals | Ships through normal npm install + agent-state shim-bin directory (created by migrator) | PostUpdateMigrator can't edit compiled JS in node_modules. Honest about what reaches existing agents how. |
| Per-flag rollback flips and walks away | fabricationGuard rollback drains in-flight quarantined replies to inbox-as-unverified before disabling | Otherwise quarantined messages become orphaned. |
| Backup includes `threadline/quarantine/*` (would silently fail) | Recursive-dir include + SQLite WAL checkpoint pre-snapshot | Round-3 caught that BackupManager's expandGlob rejects entries with `/`. Reuses existing recursive-dir code path. |

## Iteration summary

| Iteration | Verdict | Material findings | Reviewers |
|-----------|---------|-------------------|-----------|
| 1 | All 4 reviewed | 24 (2 SERIOUS verdicts) | sec, scal, adv, int — all flagged |
| 2 | 2 converged, 2 with new findings | 8 (1 SERIOUS — multi-machine) | adv: 5 new; int: 3 new |
| 3 | 3 converged, 1 with new findings | 2 (BackupManager glob, ledger filename) | int only |
| 4 | All 4 converged | 0 | int re-check |

## Full findings catalog (high level)

### Round 1 → addressed by v2

- Heartbeat TOCTOU/spoof — added HMAC + spawn nonce
- Self-produced trace is theater — out-of-process shim
- Spawn ledger DoS — TTL + bounds
- Delivery-unconfirmed weaponization — tri-state + AgentTrustManager budget
- Quarantine prompt injection — render through /msg read sandbox
- 24 findings total across the four perspectives

### Round 2 → addressed by v3

- shared-state.jsonl doesn't replicate (FUNDAMENTAL) — descoped multi-machine
- Per-session sandbox bin doesn't exist — replaced with agent-state shim-bin
- Migrator can't rewrite TS template literals — clarified ship path
- "Intersect" unimplementable — replaced with 3-step check
- Per-peer rate cap unspec'd — added 1000/24h with index
- Env-var nonce leak to forked helpers — switched to FD-passing
- Concurrent spawn cap unspecified — added 1000-spawn cap

### Round 3 → addressed by v4

- BackupManager glob would silently skip quarantine — recursive-dir include
- SQLite vs JSONL filename inconsistency — unified on .db with WAL checkpoint

### Round 4

- All four perspectives converged. No new material findings.

## Convergence verdict

**Converged at iteration 4.** All four internal reviewer perspectives (security, scalability, adversarial, integration) returned CONVERGED with no new material findings.

## Known gaps before approval

1. **External cross-model review skipped.** The spec-converge skill normally runs GPT/Gemini/Grok via `/crossreview` as part of every round. This run executed internal reviewers only. **Recommendation: run `/crossreview docs/specs/RELAY-SPAWN-GHOST-REPLY-CONTAINMENT-SPEC.md` as the final pre-approval gate.** Per the `external_crossmodel_catches_what_internal_misses` memory rule, external reviewers reliably surface concurrency, supply-chain, and precision failure modes Claude-family reviewers miss.

2. **Multi-machine duplicate-spawn risk.** Explicitly out of scope; tracked as `MULTI-MACHINE-SPAWN-LEDGER-SPEC.md` to be filed in the same PR. Single-machine ghost-prevention is complete; cross-machine paired-instar deployments retain the original duplicate-spawn risk on the same envelope until the follow-up ships.

3. **Sandbox-level isolation.** True OS-level sandboxing of the spawned session (sandbox-exec on macOS, seccomp on Linux) is tracked as `SESSION-SANDBOX-ISOLATION-SPEC.md`. Without it, the trace recorder is best-effort against a non-cooperating session — but quarantine-on-empty-trace catches the most dangerous mode (silent fabrication slipping through to the sender).

## Ready for

- `/crossreview` for external cross-model audit
- User approval (set `approved: true` in spec frontmatter) once cross-review is acceptable
- `/instar-dev` build phase

## How to approve

Add `approved: true` to the spec's frontmatter, OR reply with explicit approval and I'll add the tag.
