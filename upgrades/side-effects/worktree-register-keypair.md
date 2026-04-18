# Side-effects review — `instar worktree register-keypair` + keychain format fix

**Scope**: Close gap #1 of the parallel-dev Day-0 rollout. Add the helper
CLI the migration script references, and fix the macOS keychain round-trip
bug where multi-line PEM comes back as hex.

**Files touched**:
- `src/core/WorktreeKeyVault.ts` — add `b64:` encode/decode helpers, wrap
  all keychain writes in base64, add `importKeyMaterial(material)` public
  method + private `writeKeychain` / `writeFlatFile` helpers.
- `src/commands/worktree.ts` — new file. `registerKeypair()` reads a PEM,
  derives the public key, generates hmac + machineId, calls
  `vault.importKeyMaterial(...)`, scrubs the input file.
- `src/cli.ts` — register the `instar worktree` command group and its
  `register-keypair` subcommand.
- `tests/unit/WorktreeKeyVault.test.ts` — four new tests covering
  `importKeyMaterial` roundtrip, base64 wrap of multi-line PEM, legacy
  hex fallback decode, and short-single-line passthrough.
- `docs/specs/WORKTREE-REGISTER-KEYPAIR-SPEC.md` — converged + approved.

**Under-block**: None. The base64 wrap is applied uniformly, so no
format-ambiguous state exists for new installs. The decoder is tolerant of
legacy hex-returned values (for any hypothetical pre-fix manual writes).

**Over-block**: Minimal. The `importKeyMaterial` method replaces existing
entries silently. An operator running `register-keypair` against a vault
that already has keys loses the old ones. This is intentional — the
command is the operator's way of anointing new keys — but the CLI should
probably add a `--force` safety check in a follow-up. For now, running the
command with a fresh keypair is the intended Day-2 path.

**Level-of-abstraction fit**: The vault stays the single authority for
key storage format. The CLI command doesn't reach into keychain APIs
directly; it hands a `KeyMaterial` object to the vault, which picks the
backend. The base64 envelope is an implementation detail of the keychain
backend, not exposed to callers.

**Signal vs authority**: No authority change. The vault remains the
single authority for key persistence; the CLI is a thin caller.

**Interactions**:
- `loadOrInit()` behavior is unchanged for in-situ generation. The new
  decode path only activates when reading back a stored value — new
  generations go through the same path they always did.
- The `.NEW` file scrubbing is opportunistic (writes zero-length, then
  unlinks). Filesystem-level recovery of a scrubbed PEM is unlikely on
  modern journaled filesystems but not impossible — accepted for a first
  shipped version. A stronger scrub (multi-pass overwrite) is a followup.
- `WorktreeKeyVault` exports `encodeForKeychain` and `decodeFromKeychain`
  so unit tests can exercise the envelope directly. Not part of the public
  surface; tests treat the symbols as internal.

**External surfaces**:
- New CLI: `instar worktree register-keypair --private <path>
  [--keep-input] [--backend keychain|flatfile]`.
- New exported function: `registerKeypair(opts)` from
  `src/commands/worktree.ts`.
- No new API endpoint, no config field change.

**Rollback cost**: Trivial. Revert the three source files + the test.
Operators who registered a keypair keep their keychain entries (format is
forward-compatible with future reverts — the decoder handles the legacy
hex fallback).

**Tests**:
- 9/9 tests pass in `WorktreeKeyVault.test.ts` (4 new + 5 pre-existing).
- `npx tsc --noEmit` clean.
- Live-end-to-end verification deferred until a planned Day-0 flip; the
  keychain-writing path is exercised by the flat-file `importKeyMaterial`
  roundtrip test (same code path minus the `security` shell-out).

**Decision-point inventory**:
1. `b64:` prefix (vs. always-base64-no-prefix) — the prefix makes the
   format self-describing so a future read-path can assert "this is our
   format" before decoding. Small cost; meaningful debuggability.
2. Generate hmac + machineId fresh at register time (vs. derive from
   migration inputs) — the migration only generates the signing keypair;
   hmac + machineId are per-install and don't need to be anchored to the
   Day-2 trust root. Generating fresh at register time keeps the scope
   tight.
3. Scrub + unlink the `.NEW` file by default (vs. always keep) — the
   least-copies-of-key principle pushes toward delete-after-use.
   `--keep-input` is available for operators doing multi-machine rollout
   who want to copy the file before registering on each.
4. `registerKeypair()` signature takes a resolved path (vs. reading from
   stdin) — keeps the command composable with shell pipelines in CI
   without relying on process control. Follows the existing pattern of
   other instar CLI commands.
