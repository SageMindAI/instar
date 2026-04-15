# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Four structural fixes targeting the session-respawn duplication failure mode (and its neighbors), plus a rework of the outbound tone gate.

**1. OutboundDedupGate (new)** — deterministic near-duplicate detector for agent-to-user messages. Runs on `/telegram/reply/:topicId` after the tone gate. Computes Jaccard similarity over word 3-grams between the candidate text and recent outbound messages in the same topic (5-minute window). If any pair exceeds 0.7, the route returns 422 `outbound-dedup-blocked`. Bypass via `metadata.allowDuplicate = true` for intentional re-sends. Sub-millisecond, no LLM call. Universal safety net — catches respawn races, retry-without-idempotency-key, and any other cause of duplication regardless of which path produced it.

**2. Junk-payload guard (new)** — refuses trivially-short debug/sanity-check strings from reaching the user (`test`, `asdf`, `hi`, `ping`, `hello`, `foo`, single-char/punctuation-only payloads, etc.). Runs first in the outbound route (no I/O, so obvious junk doesn't pay tone/dedup cost). Bypass via `metadata.allowDebugText = true`.

**3. Pre-respawn drain in SessionRecovery** — when context exhaustion is detected, the dying session may have an in-flight reply that lands in topic history a few seconds later. The previous code killed the session, slept 3s flat, then snapshotted — leaving a race window. New code polls topic history for up to 7s after kill, watching for a new agent message with timestamp after detection. If found, it's embedded in the fresh session's recovery prompt as `<previous_reply>` with explicit "do NOT repeat any part of it" instruction. Depends on a new optional `getRecentTopicMessages` dep (wired from server startup).

**4. Tone gate rework** — the old prompt was a "communication quality reviewer" that blocked messages for abstract reasons (too technical, exposing internals). This produced false positives on legitimate technical replies to developers. New prompt is a narrow literal-pattern matcher: block ONLY if the message contains one of seven enumerated literal patterns (CLI command for user to run, literal file path, literal config key/field, copy-paste code snippet, literal API endpoint with port/path, literal shell env var, literal cron expression). Narrative prose explaining agent behavior is always allowed. Takes a new `recentMessages` context parameter so the LLM can judge appropriateness against the recent conversation (e.g., a technical deep-dive is fine when the user asked a technical question).

Also: post-mistake principle added to `.instar/AGENT.md` scaffold template — "default response to a caught mistake is root-cause + concrete fix, never an apology alone."

## What to Tell Your User

- **No more "test" slipping through**: debug/sanity-check strings get stopped before they reach you.
- **No more double-replies after a restart**: if my session gets restarted mid-reply, a dedup check catches any duplicate response and a drain pass captures any in-flight answer so I don't repeat myself.
- **Tone checker is smarter**: I can give you technical depth when you ask for it without the gate rejecting six rewrites. It only blocks specific leak patterns now, not "too detailed."
- **Honest default response to mistakes**: baked into the agent template — when I'm caught in an error, I owe you root cause and fix, not a hollow apology.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Outbound dedup gate | Automatic on every outbound message route |
| Junk-payload guard | Automatic on every outbound message route |
| Pre-respawn drain | Automatic in context-exhaustion recovery |
| Context-aware tone gate | Automatic on every outbound message route |

## Evidence

### 1. OutboundDedupGate — verified live against real topic history

Exercised the compiled module against 15 real outbound messages from topic 5290 (timestamps normalized to within the 5-minute window for algorithm verification; windowing is covered by unit tests).

```
Case 1a — verbatim resend: "🔭 Echo is recovering from context compaction by reviewing session history and u..."
  Result: duplicate=true similarity=1.000  →  PASS ✓

Case 1a2 — tiny edit (periods→exclamation marks): same text
  Result: duplicate=true similarity=1.000  →  PASS ✓

Case 1a3 — paraphrase: "Got it — checking the logs to give you a real root-cause answer, not a guess."
  Result: duplicate=false similarity=0.611
  (Paraphrases <0.7 pass — accepted trade-off to avoid false positives)

Case 1b — unrelated fresh message: "Finished the build, tests are green, and the gates are wired into the outbound route."
  Result: duplicate=false similarity=0.000  →  PASS ✓
```

The verbatim-resend case reproduces the actual respawn-race failure mode (fresh session generating the same answer the dying session already sent). Algorithm blocks it cleanly.

### 2. Junk-payload guard — verified live against real inputs

11/11 cases correct:

```
"test"       → junk=true (known debug token)  ✓
"asdf"       → junk=true (known debug token)  ✓
"ping"       → junk=true (known debug token)  ✓
"hi"         → junk=true (known debug token)  ✓
"hello"      → junk=true (known debug token)  ✓
"foo"        → junk=true (known debug token)  ✓
"TEST"       → junk=true (case-insensitive)   ✓
"  test  "   → junk=true (whitespace-tolerant) ✓
"Back after the respawn, here is what I found." → junk=false  ✓
"Got it — on it."    → junk=false  ✓
"ok"                 → junk=false  ✓  (functional ack, not debug)
```

Reproduces the April 15 04:44:28 failure mode (fresh session's sanity-check "test" payload reaching the user). Guard blocks it.

### 3. Pre-respawn drain in SessionRecovery — not reproducible in dev without disruption

Full end-to-end verification requires triggering a real context-exhaustion event where the dying session has an in-flight reply landing in the grace window. Forcing this deterministically would require either disrupting an active user session or spawning a throwaway session and burning quota to drive it to the context limit. Neither was acceptable during this work.

27 unit tests exercise the helper and the recovery flow including: drain window timing, empty-window fallback, in-flight reply capture, recovery-prompt assembly with the captured reply, respawn-fresh vs legacy respawn paths.

This gap is flagged for closure on next natural occurrence — the sentinel logs the drain outcome on every recovery event, so the first real compaction in the wild will produce live evidence.

### 4. Tone gate rework — verified live through the messaging route

Server running the reworked gate, exercised via `POST /telegram/reply/:topicId` against topic 5290.

**Block case** (literal paths + config key + CLI instruction):

```
Input: "To verify this please edit /Users/justin/.instar/config.json and set
        authToken field to the new value, then run npm install in your terminal."

Response: 422 tone-gate-blocked
Issue: "Message exposes file paths (/Users/justin/.instar/config.json), config
        keys (authToken), and instructs user to run CLI commands (npm install).
        Users should never be asked to edit configs or run terminal commands."
Latency: 7043ms (real LLM call)
```

LLM reviewer identified all three leak categories and produced a concrete rephrase suggestion. Exactly the signal the old gate was supposed to produce but often didn't (or over-produced).

**Pass case** (technical prose about internal subsystem behavior):

Sent a multi-paragraph status update describing the dedup gate's similarity algorithm, junk-payload token matching, the respawn-drain gap, and next steps. Old gate rejected six rewrites of similar-shaped content earlier this session. New gate: 200 OK, delivered to user. Recipient confirmed.

The "always allowed" carve-out for narrative prose explaining agent behavior, combined with the `recentMessages` context (so the LLM can see a technical question received a technical answer), resolved the false-positive problem.
