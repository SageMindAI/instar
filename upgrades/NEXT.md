# Upgrade guide — parallel-dev isolation + per-agent messaging style

This release lands three connected changes: the composition-root wiring that
turns on per-topic worktree isolation when configured, script fixes discovered
during the live Day-2 rollout, and a generic per-agent messaging-style rule
in the outbound tone gate.

## Parallel-dev isolation — composition-root wiring

`WorktreeManager` + `WorktreeKeyVault` are now instantiated by the server
startup when `InstarConfig.parallelDev.phase !== 'off'`. The wiring is
extracted into a small `wireParallelDev()` helper for unit-testability.
`sessionManager.setWorktreeManager(...)` is called when the helper returns a
manager, so spawning a session for a topic now resolves an isolated
per-topic worktree instead of the shared main checkout.

- **Default**: `parallelDev` is absent → behavior unchanged.
- **Turn on "shadow"**: set `parallelDev: { phase: "shadow" }` in
  `.instar/config.json`. Sessions begin spawning in per-topic worktrees
  under `<stateDir>/worktrees/<topic-slug>/`. Commits get signed trailers.
  The GitHub push-gate stays advisory until the operator flips
  `PUBLIC_KEY_PEM` to active.
- **Turn on "enforce"**: flip after sessions have been signing commits
  reliably for a bit and the operator has installed a working OIDC verifier.

## Parallel-dev scripts — live-rollout fixes

Two scripts had blockers that only surfaced when running the real Day-2
migration + ruleset install:

- `scripts/migrate-incident-2026-04-17.mjs` — now scans the stash list by
  label instead of requiring the incident-snapshot at `@{0}`. Other sessions
  legitimately push newer stashes; position drift is not a tamper signal.
- `scripts/gh-ruleset-install.mjs` — now pipes nested ruleset bodies as
  real JSON via `gh api --input -` (the previous `--field` form
  stringified nested objects and GitHub rejected every call). Adds
  `--mode disabled` and `--skip-trust-root` flags for non-Enterprise plans
  where `evaluate` mode and `file_path_restriction` rules aren't available.

## Messaging tone gate — per-agent style rule

A new `InstarConfig.messagingStyle` free-text field describes how outbound
agent-to-user messages should be written for this agent's user. The
`MessagingToneGate` now carries a `B11_STYLE_MISMATCH` rule that blocks
messages significantly mismatching the configured style. Every agent sets
its own style string without code changes:

- `"ELI10 — short sentences, plain words, no acronyms"`
- `"Technical and terse"`
- `"Formal business-memo tone"`

When `messagingStyle` is unset (the default), the rule does not apply —
behavior is identical to before this change.

## Migration notes

No migration required. All new behavior is opt-in via config. Existing
deployments keep working unchanged until an operator sets `parallelDev`
or `messagingStyle`.
