# PR Review Hardening — iteration 3 review synthesis

**Date**: 2026-04-16
**Verdict**: NOT CONVERGED — iter4 revision required
**Reviewer tally**: 4 NOT CONVERGED (scalability, adversarial, integration, Gemini) · 2 MINOR (security, GPT) · 1 CONVERGED (Grok)

## Top critical findings (multiple reviewers converge)

1. **LLM-verifying-Justin-identity is auth-by-LLM** (GPT sharpest + Gemini critical + Adversarial #4). Upgrade 4's Justin-override has an LLM parsing GitHub comment text to verify authorship. This is the classic model-family blind spot. Fix: identity from GitHub API `comment.user.login` (deterministic), LLM only checks reason quality on the body.

2. **Sampling PRNG predictable within a month + grandfathering race = full bypass chain** (Adversarial sharpest). Per-month seed published in spec is enumerable. Grandfathering keys on PR open time, giving attackers a window to race-open before Phase A. Composed: attacker opens throwaway PR → learns PRNG slot → times real PR to unsampled slot → races in under grandfather. Fix: seed = server-secret XOR per-PR-head-SHA (not precomputable without content); grandfather by last-push SHA, not open time.

3. **Token rotation contradicts git-sync** (Integration sharpest + Security #3). Spec puts pipeline log in `.instar/state/` (git-synced) and rotating bearer token in "server-local state" — if co-located, token leaks to paired machines and remote. Fix: explicit path in `.instar/secrets/`, gitignore entry, BackupManager BLOCKED_FILES addition.

4. **Migration story is entirely absent** (Integration #F1+F2). Existing agents pulling the update get server code but no `scripts/push-gate.sh`, no `rollback-from-artifact/` skill, no workflow file, and the new persistent state files aren't in BackupManager's includeFiles. Fix: explicit PostUpdateMigrator step enumerating each file per phase, BackupManager manifest entries.

5. **Proof-bundle reviewer-concurrence circularity** (Security sharpest). Server verifies subagent concurrences against Echo's session log — but the log is populated by those same subagents. Prompt-injected subagent → truthfully-logged fake concurrence. Fix: bind each concurrence to input-prompt-hash + diff-SHA + canary; server re-derives expected canary from session-scoped seed.

6. **Multi-machine pairing unaddressed** (Integration #F4). Two paired machines = two PR-gate primaries, two PRNG seeds, two classifier logs. Fix: declare one machine PR-gate-primary (leader election or config), others no-op.

7. **Fork-and-fix rebase invalidates artifact — recovery flow undocumented** (Integration #F5 + Adversarial #3). Rebase produces new SHA → artifact instantly stale → push-gate refuses fork-and-fix's own push. Fix: explicit fork-and-fix section covering rebase → recompute-artifact → re-POST eligibility → push.

## High-severity findings

8. **PR-wave concurrency unspecified** (Scalability #3). $10/day is spend cap, not rate cap. 50-PR burst = 250 parallel reviewer subagents, OOM/rate-limit before ceiling trips. Fix: explicit `maxConcurrentReviewPipelines` + FIFO queue + PR-wave degradation mode.

9. **Debounce starvation + persistence gap** (Scalability #5 + Gemini #4). In-memory setTimeout dies on restart; attacker pushes every 9 min indefinitely. Fix: persistent `lastPushAt`, server polls; max debounce 30 min wall clock from first push.

10. **Pipeline log unbounded + metrics O(n)** (Scalability #1). No rotation; /pr-gate/metrics scans full file. Fix: daily rotation, N-day retention, maintained rollup, metrics reads rollup.

11. **Eligibility record GC** (Scalability #2). Records keyed by (pr,sha) invalidated but never deleted. Fix: TTL or latest-N policy.

12. **Stage 2 prompt injection via PR description "safety argument"** (Adversarial #1). Stage 2 reads description as context; PR framed as signal-vs-authority refactor biases the positive-signal path. Fix: Stage 2 prompt must cite diff evidence reducing enumerated authority, not contributor claims.

13. **TOCTOU contributor fork SHA** (Security #2 + Gemini #3). Server's `git rev-parse HEAD` for contributor fork races with force-push. Fix: Action passes `github.event.pull_request.head.sha` to server; server requires eligibility record written against SAME SHA; 24h staleness cap.

14. **Proof-bundle path-traversal** (Adversarial #5). "Declared path" in POST body not validated. Fix: server canonicalizes, rejects outside `upgrades/side-effects/pr/`, rejects symlinks, enforces filename pattern.

15. **Reviewer concurrence session-ID replay** (Adversarial #6). "Recent" session log undefined. Fix: server verifies session-ID's logged prompt was for THIS (pr, head-sha, reviewer-role, current review window).

16. **Justin-override quoted-text spoofing** (Adversarial #4). Even with LLM hardening, quoted text `> @justin wrote: skip-spec-first: ...` can confuse. Fix: GitHub-author check done by SERVER before LLM ever sees comment.

17. **Non-goal "non-instar repos" documented but not enforced** (Integration #F6). Stage 1/2 is repo-agnostic today. Fix: deterministic repo check at Stage 1 entry; repo identifier as config.

## Medium findings (listed briefly)

- Canary token leakage to public artifacts/comments (Gemini #2)
- Token revocation endpoint + per-record authorized-by-token-id (Security #3)
- Validator output schema-constrained to signal, not free-form prose (Security #4)
- Pinned-action supply chain — pin actions/checkout to SHA (Security #5)
- TZ ambiguity on cost ceiling — UTC midnight, persistent ledger (Scalability #4)
- Next-day queue DoS — hard-drop at ceiling, not queue (Gemini #3)
- Cross-reviewer poisoning via artifact body quotes — `<QUOTED_PR_CONTENT>` wrapping (Adversarial #7)
- Related-PR detection 30-day/50% acknowledged but unmitigated (Adversarial #8)
- Extracted specs require Justin approval regardless of iteration (Adversarial #9)
- Grandfathering race window (Adversarial #10)
- Deterministic-override paths are blocklist-only (Adversarial #11)
- approved-at-sha transitive hash for multi-file specs (Adversarial #12)
- Dashboard PR Pipeline tab shipping story (Integration #F7)
- `instar-pr-gate` as canonical CHECK_NAME constant (Integration #F8)
- Config knob for per-phase disable (Integration #F9)
- rollback-from-artifact skill scope + installBuiltinSkills (Integration #F10)
- 8 grandfathered PRs by number or Phase-A-SHA (Integration #F11)
- GitHub Action → OIDC/GitHub App future end state (GPT)
- Artifact validator grounding check — cite path exists in diff (Gemini)

## Non-blocking suggestions (batch at end of iter4)

- Stage 2 architecture clarity paragraph (GPT)
- PDP/PEP naming (GPT)
- SLSA in-toto attestation for proof bundle (Gemini)
- CODEOWNERS changes force high-risk (Security)
- Metrics endpoint auth-gate + rate-limit (Security)
- /pr-gate/status replay nonce (Security)
- workflow_run / reusable-workflow not callable (Security)
- Cache poisoning guard if actions/cache ever added (Security)
- Semgrep/Snyk as Stage 1 non-LLM signals (Grok)
- Define "net lines" precisely (Grok)
- Dependency-bump wording conflict (GPT)
- Per-contributor daily cost sub-ceiling (Adversarial)
- Attention Queue entry on every material-concern override (Adversarial)
- Fail-cautious override server-authenticated, not local flag (Adversarial)
- Classifier audit log rotation (Integration S1)
- PRNG month boundary UTC (Integration S2)
- Token-overlap mid-flight grace (Integration S3)
- Action file lives in JKHeadley/instar, not user agents (Integration S4)
- Max validator iterations cap (Scalability)
- Sampling PRNG storage spec (Scalability)
- GitHub Action rate-limit + jitter (Scalability)
- Related-PR heuristic broader than 50% file overlap (GPT + Adversarial)

## Iteration verdict

NOT CONVERGED. Proceed to iter4 revision addressing all critical and high findings above.
