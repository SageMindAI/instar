# Upgrade Guide — Pre-push smoke tier (fast local test gate)

## What Changed

The local pre-push test gate now runs only the tests affected by files
you changed, instead of the full suite. On a typical small push this
drops from ~10 minutes to tens of seconds. The full suite still runs in
CI on the PR across 8 sharded runners, and CI is the authority for
merge.

### Before

Every `git push` ran `npm run test:push` — the full suite minus the
known-flaky exclude list — serially (no in-process parallelism because
tests collide on ports, SQLite, npm). Wall-clock ~9–10 min on every
push, including pushes that only touched docs or config.

### After

Every `git push` now runs `npm run test:smoke` — the same test set,
gated by vitest's `--changed origin/main` mode, so only tests whose
files (or their transitive imports) appear in your diff execute. The
exclude list and `fileParallelism: false` are preserved; the change is
which files are included, not how they run.

Escape hatches, for the cases where you want the old behavior:

| Variable | Effect |
|----------|--------|
| `INSTAR_PRE_PUSH_FULL=1 git push` | Run the full push suite locally (old behavior, ~10 min) |
| `INSTAR_PRE_PUSH_SKIP=1 git push` | Skip pre-push tests entirely; CI is the only gate |

The NEXT.md / version / side-effects pre-push gate still runs first on
every push — that's independent of the test tier and stays as-is.

## What to Tell Your User

Pushing local changes now takes seconds instead of minutes in the
common case. The exhaustive test run still happens on GitHub before
anything merges, so you won't ship a broken change — you just won't
wait for the full suite on your laptop.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Fast local pre-push gate | Nothing to do — `git push` now runs only tests touched by your diff |
| Force full local suite | `INSTAR_PRE_PUSH_FULL=1 git push` |
| Skip local tests entirely | `INSTAR_PRE_PUSH_SKIP=1 git push` (CI still runs the full suite) |

## Evidence

- Local run of `npm run test:smoke` on this change (which only touches
  `.husky/pre-push` and `package.json` scripts) runs 0 tests — the
  diff doesn't cover any source files, so `--changed` has no targets.
  That's the intended fast-path.
- Local run of `npm run test:push` unchanged — ~10 min as before, now
  opt-in via `INSTAR_PRE_PUSH_FULL=1`.
- CI's 8-shard matrix on `ci.yml` is unchanged and continues to run
  the full push suite on every PR — that's the authority; pre-push is
  a signal.

Side-effects review:
`upgrades/side-effects/pre-push-smoke-tier.md` — covers over/under-block,
level-of-abstraction fit (signal-vs-authority: pre-push is a signal, CI
is the authority), interactions with the NEXT.md gate and the retry
loop, external surfaces, rollback cost.

## Deployment Notes

No operator action required on update. The change is to the
contributor-side git hook, which is installed by `npm install` via
husky. Contributors pick it up automatically on their next `npm ci`.

## Rollback

Revert this commit. `.husky/pre-push` returns to running
`npm run test:push` (full suite) on every push, `test:smoke` script
stays harmless in package.json until removed. No schema changes, no
state-file changes, no API changes.
