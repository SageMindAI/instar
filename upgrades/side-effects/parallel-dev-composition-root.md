# Side-effects review — parallel-dev composition-root wiring

**Scope**: Wire the already-shipped WorktreeManager + WorktreeKeyVault into the
server startup so that, when `config.parallelDev.phase !== 'off'`, each topic
session spawns in its own git worktree. Default stays `'off'` — this PR does
not flip behavior on for any existing deployment.

**Files touched**:
- `src/core/types.ts` — add `ParallelDevConfig` and `InstarConfig.parallelDev?`
- `src/core/ParallelDevWiring.ts` — new helper `wireParallelDev()` that builds
  and initializes the WorktreeManager from config
- `src/commands/server.ts` — conditional call to `wireParallelDev`, pass
  `worktreeManager` + `oidcEnrolledRepos` to `new AgentServer({...})`, call
  `sessionManager.setWorktreeManager(manager, shimRoot)`
- `tests/unit/ParallelDevWiring.test.ts` — 7 regression tests

**Under-block**: none. The helper degrades to `null` when `phase === 'off'`, so
the existing one-tree-per-server behavior is preserved bit-for-bit. The
pre-existing AgentServer contract (`worktreeManager?` optional) already handled
the absent-manager case by mounting neither the OIDC route nor the auth-required
`/worktrees/*` routes — we rely on that.

**Over-block**: none. The wiring does not alter any existing session-spawn path
until `phase` is promoted. `setWorktreeManager` is additive — it stores the
reference; `SessionManager.spawnSession` only consults it when `topicId` is
present *and* the manager is set.

**Level-of-abstraction fit**: the wiring is extracted into a single
~50-line helper so (a) composition root stays readable and (b) the logic is
unit-testable without having to stand up a full server. `buildX + initialize`
is a standard composition-root idiom.

**Signal vs authority**: no authority change. The WorktreeManager itself is
authoritative for bindings/locks/trailers; the wiring just hands it to
SessionManager + AgentServer. No gate is added or removed.

**Interactions**:
- **K1 (flat-file passphrase)**: wiring honors `headlessAllowed` and reads
  `INSTAR_WORKTREE_PASSPHRASE` when it's set. A unit test asserts the
  passphrase-missing path throws rather than silently generating weak keys.
- **OIDC verifier**: intentionally *not* wired yet. `oidcVerify` remains
  `undefined` in this PR, so the GH-check route (`/gh-check/verify-nonce`) is
  not mounted. That keeps `phase='shadow'` safe to flip on before the OIDC
  JWK fetcher exists. `phase='enforce'` will require a follow-up PR that
  plugs in a real verifier.
- **SessionManager.setWorktreeManager**: pre-existing API from the Phase-A
  merge. This is the intended consumer.
- **oidcEnrolledRepos passthrough**: still useful at `shadow` so operators
  can pre-configure the list without flipping enforce; the AgentServer guard
  (`worktreeManager && oidcVerify`) keeps the route unmounted until both are
  present.

**External surfaces**:
- New config key `parallelDev` on `.instar/config.json`. Absent key = `off` =
  no change. Loaders merge-under-default; no migration is needed.
- No new CLI, no new endpoint, no new external dep.

**Rollback cost**: trivial — revert the two edits to `server.ts` + `types.ts`
and the two new files. No data migration, no on-disk state is created unless
`phase !== 'off'` is actively set. Worktree state that *is* created is
confined to `<stateDir>/worktrees/` and `<stateDir>/local-state/`, both
gitignored, and can be removed via `WorktreeReaper` or `rm -rf`.

**Tests**:
- `tests/unit/ParallelDevWiring.test.ts` — 7 tests, all passing:
  - off-phase returns null (legacy behavior preserved)
  - shadow-phase returns manager + shimRoot
  - enforce-phase returns manager
  - initialize() creates worktrees root + snapshots + quarantine + local-state
  - K1: headless + no passphrase throws
  - maxPushDelaySeconds propagates
  - default repo-origin resolver tolerates missing origin
- 20/20 pre-existing parallel-dev tests still pass
- `npx tsc --noEmit` clean
- 8 pre-existing test failures (agent-registry, feature-delivery,
  listener-session, no-silent-fallbacks, security execSync) are unchanged by
  this PR — verified by running the same tests on origin/main before applying
  the edits.

**Decision-point inventory**:
1. Extract to `ParallelDevWiring.ts` helper (vs inline in server.ts) — chosen
   for testability; a 50-line helper with 7 unit tests beats a 50-line inline
   block that can only be tested via full server spin-up.
2. Dynamic `import()` in server.ts — keeps worktree code out of the server
   module's import graph when `phase === 'off'`.
3. Feature-flag default `'off'` (vs `'shadow'`) — flipping on requires
   operator intent; matches the `prGate` rollout pattern.
4. Do not wire `oidcVerify` in this PR — the real GitHub OIDC JWK fetcher is a
   separate concern and will gate `phase='enforce'`. Landing the wiring first
   keeps the PR small and reversible.
