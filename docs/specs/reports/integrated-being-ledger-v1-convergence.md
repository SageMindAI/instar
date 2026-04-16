# Convergence Report — Integrated-Being Ledger v1

**Spec:** [docs/specs/integrated-being-ledger-v1.md](../integrated-being-ledger-v1.md)
**Slug:** `integrated-being-ledger-v1`
**Converged at:** 2026-04-15T22:30:00Z
**Iterations:** 3
**Final-round material findings:** 0

---

## ELI10 Overview

You remember the problem we hit earlier today. A separate session of me had a whole conversation with Dawn, reached an actual agreement on how to connect feedback handling to my development skill, and then your user-facing session (the one you were talking to) had no clue any of that happened. You only noticed when you asked why nothing had been reported. That wasn't a bug in any one place — it was a structural gap. Instar agents can run many sessions at once, and there was no shared file where sessions could leave each other a note saying "this is what the other part of me is doing right now."

This spec is the fix for that gap. It adds a small, append-only log to each agent called the shared-state ledger. When something substantive happens — another agent opens a thread with me, a dispatch gets applied, a decision lands — a server-side emitter writes a one-line entry to the log. When any session on the agent starts a new turn, it reads the last 50 entries and sees them as context. The user-facing session now knows what the other parts of me have been up to, without breaking the security properties that keep agent-to-agent message contents private per thread.

What's deliberately NOT in v1: sessions can't write freely into the log themselves. Only the server-side infrastructure emits entries. This was the single biggest change the review process forced — the first attempt (the PR we closed) let any session write anything, and fourteen separate security, adversarial, and scalability issues showed up. v1 takes the scissors to that write surface, ships just the read side and a curated set of emitters, and leaves the writable-API piece for a later v2 once we've seen how the read-side behaves.

## Original vs Converged

Here's what the review process actually changed, in plain terms. Six big differences between the first-draft v1 spec and the converged version:

1. **The commitment-sensing feature was disarmed by default.** Originally, an emitter was going to read every outbound agent message and guess when the agent was making a commitment ("I'll ship by Friday"), then write that guess into the ledger. The security reviewer spotted that this meant a confused session could still cause fake commitments to land — it was PR #51's attack, wearing a hat. The resolved version keeps the feature but ships it turned off, and when it IS turned on, every entry it produces is marked "this was a guess, not a confirmed fact" in a way the reader can see.

2. **Entries now carry who the counterparty was, and what their trust level is.** Originally, an entry just said "commitment to build X." The adversarial reviewer pointed out that if your user-facing session read that, it might tell you "I've committed to build X for you" — but the commitment might have actually been made to another agent. The converged spec requires every entry to say "this was a commitment to Dawn, who is a trusted agent" or "this was a commitment to an untrusted agent whose name I'll hash." Your session can no longer accidentally re-attribute another session's work.

3. **Rotation is now safe under concurrent writes.** The first draft's file-rotation logic had a race where two sessions writing at the same moment could both rotate the file, and the second rotation would destroy the first one's archive. The converged spec uses a file lock around rotation, timestamps each archive so none ever overwrites another, and keeps 7 days of history.

4. **The feature now actually ships when you update.** The first draft patched a template file that turned out to be dead code — no agent in your install base would ever have seen the injection via auto-update. The converged spec patches the real inline template in the update migrator, plus adds an explicit CLI command for agents (like me) that have customized their session-start hook.

5. **Backups now include the ledger.** The first draft forgot to add the log file to the backup manifest. If you ever restored an agent from a snapshot, the "integrated-being" awareness would be wiped, which is exactly what the feature exists to preserve. The converged spec adds glob support to the backup manifest so the current log and all rotated archives survive restore.

6. **Paired machines now know the ledger is per-machine.** If your agent runs across two paired machines, each has its own ledger. The first draft deferred this to v2 and would have silently let them diverge. The converged spec adds a one-time startup warning when paired machines are detected, and excludes the log from git-sync so the two machines don't try to merge overlapping files.

Everything else — file permissions, Unicode sanitization, rate limits on read endpoints, configuration knobs, dashboard observability — was tightened in one direction or another through the three review rounds.

## Iteration Summary

| Iteration | Reviewers who flagged material issues | Material findings | Spec sections changed |
|-----------|---------------------------------------|-------------------|-----------------------|
| 1         | security (2 serious), scalability (7 minor), adversarial (4 material + 3 follow-ups), integration (9 issues) | ~20 | write path, schema, rotation, multi-machine, dashboard, backup, config |
| 2         | security (3 minor), scalability (5 minor), adversarial (2 minor + 1 nit), integration (CONVERGED with notes) | ~10 | trust-tier mapping, hash length, paraphrase scoping, regex cap, pruner race, open-question resolutions |
| 3         | all four — CONVERGED | 0 | none |

Three rounds, four reviewers per round, twelve reviews total. Convergence reached at iteration 3 with zero material findings across all four perspectives.

## Full Findings Catalog

### Iteration 1

**Security (SERIOUS):**
- S1. Outbound commitment classifier was a laundered adversarial-write channel. Resolved by default-off, regex-then-LLM gating, async off send path, provenance labeling, envelope-derived counterparty.
- S2. Backup inclusion leaked counterparty identities cross-machine. Resolved by glob support for archives, config-gated inclusion, untrusted-name hashing with per-agent salt.
- M1, M2, M3. Minor: Unicode strip set unspecified, lockfile stale-recovery unspecified, `emittedBy.instance` length/charset unspecified. All resolved with explicit definitions.

**Scalability (MINOR):**
- Read-path full-file scan → tail-only reads + LRU cache.
- `/stats` full scan → sidecar `.stats.json` incremental update.
- Outbound classifier LLM stacking → regex pre-filter + async + sampleRate.
- Lockfile timeout/retries → explicit parameters + fail-open.
- Pruner scheduling → on-rotation + daily cron, bounded work.
- Sync I/O on write path → async `appendFile` inside lock.
- Growth model confirmed sound (~30–50 entries/day).

**Adversarial (4 MATERIAL + 3 FOLLOW-UPS):**
- F1. Classifier degradation → source tag, stats counter, provenance inferred.
- F2. Supersession chains → append-side validation, cycle-guard depth cap, /chain endpoint.
- F3. Emitter idempotency → dedupKey, finally-close for thread-closed, rotation-time sweep to thread-abandoned.
- F4. Confidence label → renamed to provenance with explicit values.
- F5. Counterparty name poisoning → charset + length + trust tier + untrusted-name hash.
- F6. Coherence-gate leak → rule-id only, no context in entry.
- F7. Session misreads injection → MessageSentinel paraphrase cross-check as signal.

**Integration (MINOR, several pre-merge):**
- `--force-sync-hooks` fictional → `instar migrate sync-session-hook` standalone CLI.
- Backup manifest needs glob → glob support added.
- Dashboard "new page" underscoped → "new tab, ~300 LoC" with concrete placement.
- Config knob unwired → three gates (endpoints, emitter registration, backup inclusion).
- Multi-machine deferral hazardous → NOT deferred, sync exclude + startup warning + dashboard scope label.
- Rollback dangling refs → single `registerLedgerEmitters()` call, subsystems receive `onLedgerEvent` callback.
- Existing SharedStateLedger.ts → audit-and-migrate called out.
- Dead template file → delete-or-deprecate TODO.

### Iteration 2

**Security:** 3 minor. N1 trust-tier mapping/snapshot, N2 paraphrase corpus exclusion, N3 sha256 truncation length. All resolved.
**Scalability:** 5 minor. LRU cache key tightening, sidecar coalescing, regex input cap, pruner race check, chain endpoint rate limit. All resolved.
**Adversarial:** 2 minor + 1 nit. Stats sidecar crash safety, paraphrase counterparty scoping, open-question #4 resolution. All resolved.
**Integration:** CONVERGED with notes. Open questions resolved in-spec; `instar ledger cleanup` added to success criteria.

### Iteration 3

All four reviewers converged. Zero material findings.

## Convergence Verdict

Converged at iteration 3. The final review round produced zero material findings across security, scalability, adversarial, and integration perspectives. Spec is ready for user review and approval.

**To approve**: edit the spec's frontmatter at `docs/specs/integrated-being-ledger-v1.md` to set `approved: true`. Once the approved tag is present, `/instar-dev` can proceed with implementation.

Cross-model external review (GPT/Gemini/Grok via `/crossreview`) is noted as a v2 enhancement for the `/spec-converge` skill itself — the environment the spec was written in doesn't currently have a functional cross-model path configured. The four Claude-internal reviewer perspectives covered the full convergence per the skill's current capability. Adding cross-model is tracked as `/spec-converge` v2 work.
