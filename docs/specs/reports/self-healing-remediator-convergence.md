# Convergence Report — Self-Healing Remediator

**Spec**: `docs/specs/SELF-HEALING-REMEDIATOR-SPEC.md`
**Iterations**: 5 (4 Claude-internal rounds + 1 cross-model round)
**Converged at**: 2026-04-23T04:04:36Z
**Authored by**: echo

---

## ELI16 Overview

Right now, when a subsystem in the agent breaks and falls back to a worse version of itself (for example, a SQLite-backed memory store failing to load and dropping to a plain-text fallback), the agent's only reaction is to shout about it in a Slack channel. It keeps shouting — every 20 minutes or so — until a human notices and fixes it. That's a smoke alarm. What this spec adds is the sprinkler: a small, careful module called the **Remediator** that watches those "something broke" events, looks up whether it knows a documented fix (a "runbook"), runs the fix itself, checks that the subsystem actually recovered, and only bothers the user if the auto-fix didn't work. Runbooks are added one at a time — the first one is the exact problem we just hit (Homebrew silently bumping the agent's pinned Node version, breaking its native SQLite module).

The hard part isn't "make it fix things." It's "make it fix things without making things worse." An agent that can auto-repair can also auto-damage: remediation loops, destructive rebuilds, silently-masked real problems, fake errors that trick the repair into running. So the whole point of this spec — and the five rounds of review it went through — was to put structural guardrails around the authority. The remediator only acts on events with structured, normalized fields (not substring matches on free-form error strings, which an attacker or a noisy log could forge). It serializes to one repair at a time. It tracks failed attempts in a 24-hour rolling window and stops trying after a cap. It requires post-repair verification (health comes back green) before counting a repair as successful. It has a dry-run mode that ships ON by default for a week so every environment gets traced before anything actually executes. It has five layers of kill-switch, from a dashboard toggle to a full uninstall. And it never — structurally, enforced by both code and CI lint — tries to write its own runbooks from LLM output. Runbooks are code, reviewed like any other code change.

If this ships and works, the user stops seeing repeat alerts for problems the agent knows how to fix. The agent recovers from environment drift (node version bumps, homebrew updates, machine wake-from-sleep) without conversation overhead. And the conceptual claim — "Instar is self-healing" — actually starts being true, one runbook at a time, each one earned by hitting the same problem twice and deciding it's worth automating away.

## Original vs Converged

The first draft had the right shape but under-specified most of the safety-critical details:

- **Originally**, matchers were described as "pure functions over `DegradationEvent`" — a reassuring claim, but the `reason` field was a free-form error string that matchers were implicitly allowed to substring-match. An attacker who can influence error text (through a crafted filename, an LLM tool result, a log message relayed as a reason) could have induced a matcher to fire. After review, matchers now operate on a **structured, normalized event** produced by a dedicated redactor and `ErrorCodeExtractor`, with registry-load-time lints forbidding `reason`-substring matches as a primary key, a version-stamped extractor enum, a drift-test corpus, and a live-observation gate (the ABI-mismatch matcher confirms `process.versions.modules !== expectedAbi` inside the match path, so an event string alone cannot trigger it).

- **Originally**, the "verify succeeded" signal was an HMAC-signed record whose key was "derived from `.instar/agent.state`." After review, the key lives at `~/.instar/agent.key` (machine-scoped, 0600, NOT git-synced), the threat model is explicitly documented (containment boundary, not capability guarantee), and `keyEpoch` distinguishes legitimate restore-scenarios (`pending-verify.stale`, observability-only) from true tampering (`pending-verify.tampered`, escalated).

- **Originally**, the remediator was going to trigger restarts via a new file `restart-intent.json` it invented. After review, it reuses Instar's existing supervisor protocol (`.instar/state/restart-requested.json`) — but extended with HMAC, a supervisor version handshake (so a partially-upgraded agent can't deadlock), and a zero-backoff path for remediator-planned restarts. The TOCTOU between HMAC verify and file-honor is closed by an explicit "read once into buffer, verify on buffer, act on buffer, path is not re-consulted" rule — an iter-3 finding that Claude-internal review caught.

- **Originally**, the remediator "filtered out" its own events from trust elevation. After review, this was inverted to an **allowlist** — only `origin: "user"` or `origin: "dashboard"` events with verified session binding can elevate trust. A prebuild lint (`validate-telemetry-origin.ts`) structurally prevents regressions by failing CI on any remediator telemetry missing an `origin` tag.

- **Originally**, `coalesce` was keyed on `runbookId`. After review, the key is the tuple `(runbookId, subsystem, errorCode, nativeError.moduleName)`. Different root causes hitting the same runbook via errorCode collision produce a `coalesce-suspect` escalation rather than being silently absorbed — a distinct-root-cause attack that iter-2 adversarial review surfaced.

- **Originally**, `npm rebuild better-sqlite3` was stated as a one-line step. After review, it runs with `--ignore-scripts`, an integrity pin on `better-sqlite3/package.json`, an execution sandbox (narrow PATH, no env inheritance, captured & redacted stdio, hard timeout + kill escalation), AND a precondition that verifies the native build toolchain (`make`, `python3`, `gcc`/`clang`) is present — because the same Homebrew update that shifted Node could have also broken the toolchain, and a silent rebuild failure would be worse than a noisy precondition failure.

- **Originally**, short-duration TTLs (heartbeat cadence, verify polls, execute step timeouts) were measured in wall-clock time. After cross-model review, those all use **monotonic time** — a MacBook sleeping for two hours mid-attempt would have been indistinguishable from a stalled holder, triggering spurious lock reclaims and timeouts. Long-horizon comparisons (24h failure window, 90-day audit retention) remain on wall-clock because they're meant to span process lifetimes.

- **Originally**, there was no explicit attempt state machine — outcomes were scattered across prose in the Lifecycle and Guardrails sections. The cross-model GPT review flagged this as a product-behavior ambiguity (alert policy contradictions between sections). The converged spec pins an explicit state machine AND an authoritative alert-policy matrix, with the matrix explicitly superseding alert-policy wording elsewhere.

- **Originally**, the spec claimed to "preserve the existing alert path untouched" while also saying "successful remediation writes to the audit log, not the user's channel." These two promises were in tension. The alert-policy matrix resolves this: in Phase 1 (dry-run default), alerts continue exactly as before; in Phase 2 (after dry-run traces accumulate), matched-and-executed-and-verified successes go silent. Phase 1 is the zero-user-visible-change window; Phase 2 is the payoff.

- **Originally**, `blastRadius: "external"` was in the union. After cross-model review (Gemini) flagged the contradiction with the "no outbound network during execute()" non-goal, `external` was removed from day-one scope. A future spec-convergence round is needed before any runbook can reach out over the network.

- **Originally**, no runbook lifecycle was defined — once loaded, runbooks ran forever. After cross-model review (Grok + GPT), an **Active → Quarantined → Deprecated → Removed** lifecycle was added with auto-quarantine on repeated `churn-detected` or `verification-failed`, explicit deprecation fields in the runbook source, and handling for pending-verify records pointing to removed runbooks.

- **Originally**, the audit log was a single file `attempts.jsonl`. After review, it's `attempts-<machineId>.jsonl` with per-machine suffix (to avoid git-sync merge conflicts), rotation at 10MB/10k lines, 90-day retention, and a 5-file cap on the dashboard union (historical machines surface as a "load older" badge rather than unbounded file-handle usage).

- **Originally**, the degradation queue `degradations-queue.jsonl` had no cap — a stuck restart during a storm could fill the disk. After review, it's capped at 1000 entries OR 5MB with overflow handling; pending-verify is compacted on boot to only still-open entries.

- **Originally**, `FeedbackManager` bug-resolution and `PostUpdateMigrator` atomic-step primitives were described as if they were existing APIs. The cross-model + iter-3 integration review caught that neither exists. They're now explicit new primitives owned by this spec (`resolveDegradation` / `updateDegradation` / `announceOnce` / `runAtomicStep`), with signatures, semantics, and contract tests listed.

- **Originally**, duplicate-priority runbooks disabled the newer-mtime one. After review (adversarial: an attacker can `utimes` a legitimate runbook to look newer), duplicate-priority now disables BOTH and escalates — the only outcome that cannot be manipulated by mtime.

- **Originally**, dead-letter freeze was "until the user manually clears it." After review (adversarial: an attacker who can repeatedly crash the remediator permanently disables it), auto-clear after 3 successful unrelated attempts OR 24 hours bounds the DoS window, and a step-based distinction ("pre-mutation crashes are safely retried once; mid-mutation crashes freeze") prevents the simplest crash-at-snapshot-step retry loop.

## Iteration Summary

| Iter | Reviewers who flagged | Material findings | Spec changes |
| ---- | --------------------- | ----------------- | ------------ |
| 1    | Security (9), Scalability (11), Adversarial (10), Integration (14) | 44 | Full rewrite of matchers, locks, audit log, lifecycle, guardrails, upgrade path, CI, FeedbackManager interaction |
| 2    | Security (3), Scalability (5), Adversarial (10), Integration (10) | 28 | HMAC key lifecycle, config-flip whitelist, supervisor reuse, durable queue, monotonic-candidate timers, rollback artifacts, per-machine audit |
| 3    | Security (3), Scalability (converged), Adversarial (5), Integration (5) | 13 | HMAC TOCTOU explicit, origin allowlist inversion, known-node-targets digest pin, restart-requested HMAC universal, `runAtomicStep` primitive owned |
| 4    | Security (converged), Adversarial (converged), Integration (converged) | 0 | — (internal convergence) |
| 5    | Cross-model: GPT, Gemini, Grok | 11 | Alert policy matrix, state machine explicit, monotonic time, toolchain precondition, `blastRadius: external` removed, runbook lifecycle, errorCode extractor governance, execute sandbox, machine-lock reclaim predicate rewrite |

**Total material findings addressed across iterations: 96.**

## Full Findings Catalog (abbreviated)

Complete per-iteration review outputs are preserved in conversation artifacts (internal) and `.claude/skills/crossreview/output/20260422-204718/` (external). Summary of the most-load-bearing findings and their resolutions:

### Critical resolutions that changed the design shape

- **Structured matchers** (iter 1 security): normalized event contract, errorCode extractor, live-observation gate, registry-load lint forbidding reason-substring primary matches.
- **Supervisor reuse + handshake** (iter 2 + iter 3 integration): supersedes invented `restart-intent.json` with extensions to existing `restart-requested.json`, HMAC on ALL planned restarts regardless of `source`, version handshake against old supervisors.
- **Alert policy matrix** (iter 5 GPT): authoritative table; Phase 1 preserves alerts, Phase 2 lets success go silent.
- **Explicit state machine** (iter 5 GPT): every attempt walks a pinned state graph; audit + alert + feedback-manager consult state, not prose.
- **Monotonic-time for short TTLs** (iter 5 Gemini + GPT): heartbeat, polls, matcher budgets — all use `process.hrtime.bigint()`; wall-clock reserved for cross-process windows.
- **Origin allowlist** (iter 3 security): only `origin: "user"` / `origin: "dashboard"` with session binding elevate trust; prebuild lint enforces tagging.
- **Rollback integrity pin** (iter 3 security): `KNOWN_TARGETS_DIGEST` constant in source, allowlist file in `src/data/`, post-build-smoke tarball check.
- **Dead-letter auto-clear** (iter 3 adversarial): 3 successful unrelated attempts OR 24h; pre-mutation retry-once distinction.
- **Duplicate-priority disables both** (iter 3 adversarial): mtime-manipulation-resistant.
- **`blastRadius: "external"` removed from day one** (iter 5 Gemini): union contradiction with outbound-network non-goal.
- **Runbook lifecycle** (iter 5 Grok + GPT): Active → Quarantined → Deprecated → Removed with automated transitions on churn.
- **Toolchain precondition** (iter 5 Gemini): `make`/`python3`/`gcc`|`clang` check before `npm rebuild` — the same Homebrew event might have broken both.

### Minor/cosmetic findings batched

- Multiple phrasing quibbles, minor re-orderings, rename suggestions (e.g., clarity of "coalesce-suspect" vs "distinct-root-cause") addressed inline.
- Observability / telemetry event naming normalized across iterations (e.g., `remediation.attempt.succeeded` not `remediation.success`).

## Convergence verdict

**Converged at iteration 5.** Four internal reviewer axes (security, scalability, adversarial, integration) all returned "CONVERGED: no material new findings" by iteration 4. The cross-model round (GPT-5.4, Gemini 3.1 Pro, Grok 4.1 Fast) surfaced 11 additional material findings that Claude-family reviewers consistently missed — the alert-policy-matrix inconsistency, the wall-vs-monotonic-time gap, the `blastRadius: external` contradiction, and the machine-lock reclaim over-strictness being the most load-bearing. These are addressed in the iter-5 edits. Per the memory note "external cross-model review catches what Claude-internal misses — run /crossreview as the FINAL /spec-converge round," the crossreview output is treated as the converged-round output, not as a trigger for additional internal rounds.

The spec is ready for user review and approval. The next step is Justin reads this report, reads the spec itself if desired, and either adds `approved: true` to the frontmatter (or runs `instar spec approve docs/specs/SELF-HEALING-REMEDIATOR-SPEC.md`) — at which point `/instar-dev` is unblocked and Phase 1 (scaffold + dry-run) can begin.
