# Convergence Report — Lifeline Self-Restart on Version Skew or Stuck Loop (Stage B)

**Spec:** `docs/specs/LIFELINE-SELF-RESTART-STAGE-B-SPEC.md`
**Converged:** 2026-04-20T14:55:00Z (4 iterations)
**Reviewers:** 4 internal lenses + 3 external models

## ELI10 Overview

Two agents on this platform hit the same kind of problem recently: their little "helper" program — the one that listens for Telegram messages — got stuck in a weird state and stopped passing messages to the main program. Nobody noticed until the user pinged and realized their messages were going into a black hole. A human had to log in and restart the helper by hand.

The previous fix (Stage A, shipped yesterday) made sure the user would at least *hear about* a message being lost. This fix (Stage B) aims to make the helper notice when it's stuck and quietly restart itself, so no human is needed. It also adds a version check: if the helper and the main program end up running different versions of the code, the main program tells the helper "you're too old, please restart" and the helper does.

The tradeoff: a small amount of extra code runs every 30 seconds to check the helper's health, and there are new rules about when to restart so we don't get a restart storm. The upside is a whole class of silent outages fixes itself.

## Original vs Converged

The first draft of the spec was about 200 lines and had the right basic shape — two fixes (version handshake + stuck-loop detection), one restart sequence, a rate limit. Review found serious problems under the surface:

1. **The original stuck-loop trigger would have crashed quiet agents.** The rule was "restart if no successful message-handoff has happened in 10 minutes AND there's a message waiting." For a user who texts the agent infrequently — say, once a day — the "no successful handoff in 10 minutes" part would be true 99% of the time. The moment a message arrived, the agent would restart instead of handling it. The fix: check the age of the *oldest waiting message*, not the age of the last success.

2. **The original restart sequence would have corrupted files.** Two different pieces of code could both decide to restart at the same moment (the health-check ticker and the version-mismatch handler). If they did, both would try to write the state files simultaneously. Files would be garbled. Fix: one named "orchestrator" that owns the restart sequence, with a formal state machine.

3. **The original restart sequence would have lost the message still being fetched.** Telegram's long-poll was still active during the save-and-exit window, so a message could be fetched and acknowledged to Telegram but never written to disk. Fix: explicit "quiesce" step that stops all incoming-message work before anything is saved.

4. **The original "time jumped into the future" handling would have permanently broken self-healing.** The rule said "if the state file has a future timestamp, block the restart until the file is overwritten" — but the restart is the ONLY thing that overwrites the file. So the block would be forever. Fix: allow the restart in that case and overwrite the file.

5. **The original migration plan didn't work.** "After you upgrade, the helper automatically picks up the new code" — except the helper is already running and launchd only restarts it when it exits, so it won't. Added an `instar lifeline restart` CLI command that the upgrade step calls automatically.

6. **The original CLI couldn't tell if the restart actually happened.** Polling the "last self-restart" file to detect liveness — except `launchctl kickstart` doesn't touch that file (it's an external restart, not a self-restart). Fix: a separate `lifeline-started-at.json` marker that every startup writes, regardless of cause.

7. **The original version-mismatch trigger could be forged.** Any local process that answered on the right port and sent a 426 response could force-restart the lifeline. Added a requirement that the server's version in the 426 body actually differ from the lifeline's version, plus a separate, tighter rate-limit bucket (3 per 24 h) for version-skew restarts.

8. **A dozen other smaller issues** were caught and addressed: input validation on the version string, dev-mode safety, test-mode safety, config-knob validation, shadow-install coordination on the updater path, starvation signals for blocked event loops, heterogeneous rollout tolerance, 400-bad-request graceful degradation, signal latching during rate-limit windows.

Net: the original spec would have shipped and caused a different silent failure mode. After 4 iterations and 7 reviewers, the spec is structurally careful about concurrency, deployment ordering, and the edges where self-healing can deadlock itself.

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1 | security + scalability + adversarial + integration (internal) | 5 HIGH, 15 MED | Major rewrite: added typed errors, 503 boot window, persist budget, dev-mode detection, signal latching, restart-storm escalation, config knobs, backup exclusions, 17 acceptance criteria |
| 2 | internal verify | 0 material, 3 LOW | Polish: PATCH-boundary wording, config-knob validation, CLI race capture |
| 3 | GPT 5.4 + Gemini 3.1 Pro + Grok 4.1 Fast (external) | 8 HIGH, 1 MED | Added RestartOrchestrator state machine, quiesce/drain barrier, `oldestQueueItemAge` anchor, future-timestamp allow-and-overwrite, 400 graceful degradation, `lifeline-started-at.json` marker, updater CLI lockfile coordination, heterogeneous-rollout tolerance, watchdog starvation signal |
| 4 | internal verify | 0 material, 1 LOW editorial | Editorial: reused existing `timestamp` field instead of adding `enqueuedAt` |

## Full Findings Catalog

See spec sections "Convergence-round-1 changes" and "Convergence-round-3 changes" for the full list, organized by review round and reviewer lens.

## Convergence verdict

Converged at iteration 4. No material findings in the final round. Spec is ready for user review and approval.

Implementation risk, post-convergence:
- Concurrency correctness relies on the `RestartOrchestrator` single-owner invariant — test-suite must cover multi-trigger scenarios.
- Supply-chain tolerance (heterogeneous rollout, 400 degradation) is based on assumed pre-Stage-B server behavior — tests must validate against a representative stub.
- `oldestQueueItemAge` depends on the existing `QueuedMessage.timestamp` field being set at enqueue; the test suite must confirm this is actually true in the current codebase.
