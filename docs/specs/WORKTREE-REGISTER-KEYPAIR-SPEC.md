---
title: `instar worktree register-keypair` CLI + keychain format fix
review-iterations: 1
review-convergence: "converged"
approved: true
approved-by: justin
approved-date: 2026-04-18
approval-context: "Telegram topic 7000 parallel-dev-infra — user directed 'continue filling in gap #1 and 2' after I flagged that the Day-2 migration script references a helper command that was never built, and that the macOS keychain corrupts multi-line PEM values when stored via `security -w`. This PR closes gap #1."
---

# `instar worktree register-keypair` CLI + keychain format fix

## Problem

Two connected defects in the parallel-dev Day-0 rollout path:

1. **Missing helper**. `scripts/migrate-incident-2026-04-17.mjs` outputs
   `Next: run `instar worktree register-keypair --private <path>` to move
   into keychain`. That command does not exist. Operators running the
   migration are stranded with a `.NEW` private-key file and no way to
   hand it to the vault.
2. **Keychain format bug**. When the vault stores a multi-line PEM via
   `security add-generic-password -w "<pem>"`, macOS returns the value
   as hex on read-back because `\n` is non-printable to `security`. The
   vault then passes hex to `crypto.sign()`, which fails silently. This
   was caught by Echo during a live Day-2 rollout attempt.

## Solution

### Gap #1a — `instar worktree register-keypair`

A new CLI subcommand under `instar worktree`. Reads a PEM private key
from `--private <path>`, derives the public key via Node's `crypto`,
generates fresh hmac + machineId locally, and hands the full
`KeyMaterial` to `WorktreeKeyVault.importKeyMaterial(...)`. Scrubs and
deletes the input file after successful registration (unless
`--keep-input` is passed).

### Gap #1b — keychain format fix

Wrap every keychain write in a `b64:` prefix + base64 envelope:

- `encodeForKeychain(value)` → `b64:` + base64(value)
- `decodeFromKeychain(stored)` → unwraps `b64:` prefix if present,
  falls back to hex-decode if `stored` looks like all-hex (legacy safety
  for anything installed pre-fix), otherwise returns as-is.

Always wrap — even for single-line items (`machineId`, `keyVersion`) —
so the format is uniform and self-describing. `security -w` returns the
wrapped value as plain ASCII (no newlines → no hex fallback). The vault
decodes before returning.

### Vault API — `importKeyMaterial(material: KeyMaterial)`

New public method on `WorktreeKeyVault`. Writes externally-provided key
material to the configured backend (keychain or flat-file), replacing
any existing entries. Complements `loadOrInit()` which only auto-
generates when nothing is stored.

## Non-goals

- Rotating keys. `importKeyMaterial` replaces, but there's no rotation
  ledger / history. A later change will add that.
- Multi-machine propagation. This PR handles one machine. Binding-
  history-log sync across machines is a separate spec section.

## Rollout

- Land immediately. The command is opt-in — operators who don't run
  the migration don't touch it.
- The format fix is backwards-compatible: the decoder handles both
  base64-prefixed and legacy hex-returned values.

## Rollback

Revert the edits to `WorktreeKeyVault.ts`, `src/commands/worktree.ts`,
and `src/cli.ts`. The `--private` input-file scrubbing is the only
side-effect outside the keychain; operators can regenerate via the
migration script if needed.
