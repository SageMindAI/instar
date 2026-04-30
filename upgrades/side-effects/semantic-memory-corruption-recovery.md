# Side-Effects Review — SemanticMemory corruption detection and auto-recovery

**Version / slug:** `semantic-memory-corruption-recovery`
**Date:** 2026-04-27
**Author:** gfrankgva (contributor)
**Second-pass reviewer:** Echo (EchoOfDawn), 3 review rounds

## Summary of the change

Three files touched:

1. `src/core/types.ts` — `SemanticMemoryConfig` gains an optional `autoRebuildMaxBytes?: number` field (default 50 MB). No existing code passes this field, so all callers keep current behavior.

2. `src/memory/SemanticMemory.ts` — `open()` gains an integrity check block mirroring TopicMemory's pattern:
   - After opening the DB, runs `PRAGMA integrity_check`. If result is not `'ok'`, or if the pragma itself throws (severely corrupt DB), triggers recovery.
   - **Secondary probe read**: If `integrity_check` passes, reads 100 rows from each existing table. Catches torn interior pages that `integrity_check` misses (pages not reachable from the B-tree schema walk).
   - Recovery: calls `quarantineCorruptDb()` which renames the DB to `.corrupt.<timestamp>`, removes WAL/SHM sidecars, writes a JSON marker file. Falls back to delete if rename fails.
   - After schema creation and vector init, checks `_needsRebuild` flag. If JSONL exists and is within the size gate, rebuilds synchronously. If JSONL exceeds `autoRebuildMaxBytes`, logs warning, starts empty, and writes a `skipped-rebuild` marker file.

3. `tests/unit/semantic-memory-corruption-recovery.test.ts` — Test file with 12 contract-style tests covering: open-without-throwing, quarantine preservation, marker shape, sidecar cleanup (strengthened WAL/SHM assertions), JSONL rebuild, no-JSONL fresh start, healthy-DB no-op, severe-corruption pragma-throws path, partial-corruption (valid header + 4KB corrupted data page in 5000-row DB), size-gate skip, skipped-rebuild marker file, and subsequent-open stability.

## Decision-point inventory

- `SemanticMemoryConfig.autoRebuildMaxBytes` — **add** (type: optional number, default 50 MB).
- `SemanticMemory.open()` integrity check block — **add** (new code path between DB constructor and pragma setup).
- `SemanticMemory.quarantineCorruptDb()` — **add** (new private method).
- `SemanticMemory._needsRebuild` — **add** (new private field, transient between integrity check and rebuild).
- Auto-rebuild size gate — **add** (checks `fs.statSync(jsonlPath).size` against config limit).
- `SemanticMemory` probe-read block — **add** (secondary detection after integrity_check passes; reads 100 rows from each existing table).
- `SemanticMemory.writeSkippedRebuildMarker()` — **add** (new private method; writes `.skipped-rebuild.<ts>.marker.json` when size gate triggers).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

When JSONL exceeds `autoRebuildMaxBytes` (default 50 MB), the DB starts empty after corruption recovery. This means an operator with a large knowledge graph (> ~500k entities) would need to trigger `importFromJsonl()` manually after startup. This is deliberate — blocking server startup for minutes on a synchronous import is worse than starting with empty memory. The operator can rebuild during a maintenance window.

The integrity check itself runs on every `open()` call, adding measurable startup latency for large DBs. TopicMemory pays the same cost, so consistency wins. If semantic DBs grow very large, a `quick_check` pragma (subset of integrity_check) could be a future optimization.

## 2. Under-block

**What failure modes does this still miss?**

- **Mid-session corruption**: Only detected on `open()`. If a disk block goes bad during a running session, individual SQLite operations will throw but no automatic recovery triggers. This is out of scope — mid-session recovery would require connection pooling or shadow-DB switching, far beyond this PR's scope.
- **Probe-read coverage**: The secondary probe reads 100 rows from each non-FTS table. Very large tables with corruption only in pages beyond the first 100 rows could theoretically pass the probe. In practice, 100 rows spans multiple 4KB pages, making this unlikely. Full table scans at startup would have unacceptable latency on large DBs.
- **JSONL truncation**: If the JSONL was itself truncated (disk-full event during a write), the rebuild will be partial — some entities may be missing. The `importFromJsonl()` method handles malformed lines gracefully (skips them), so the rebuild is best-effort. The quarantined DB is preserved for forensic comparison.
- **Writes not flushed to JSONL**: All mutation paths in SemanticMemory go through `remember()` / `addEdge()` which write to JSONL first (append), then to DB. The JSONL is the source of truth. There is no path where the DB is written first.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. SemanticMemory owns its DB lifecycle — `open()` is the correct place for integrity checks, matching TopicMemory's pattern. The quarantine logic is a private method, not exposed to callers. The size-gate config is on the existing `SemanticMemoryConfig` interface, which is the established place for tuning knobs.

The alternative (adding a "health check" service layer above SemanticMemory) would scatter recovery logic across modules and require SemanticMemory to expose its DB state — worse encapsulation.

## 4. Blocking authority

- [x] No — this is a startup-time recovery mechanism. It does not gate any runtime operation. The only "decision" is quarantine-vs-keep, which is always quarantine (corruption is binary).

## 5. Interactions

- **Shadowing:** No existing corruption detection to shadow — SemanticMemory had none before this PR.
- **Double-fire:** `_needsRebuild` is reset after the rebuild block. A second `open()` on the recovered DB is a no-op (tested).
- **Races:** `open()` is async but the integrity check is synchronous (better-sqlite3 is sync). No concurrent access during startup.
- **Downstream consumers:** Callers of `SemanticMemory.open()` (currently only `src/commands/server.ts`) see no behavioral change on healthy DBs. On corrupt DBs, `open()` succeeds instead of potentially throwing — strictly better.

## 6. External surfaces

- **Agents:** After corruption recovery, the knowledge graph may be rebuilt from JSONL (common case) or start empty (large JSONL). Agents notice "fewer memories" but server stays up — preferable to a crash loop.
- **File system:** New files created during recovery: `.corrupt.<ts>` (quarantined DB), `.corrupt-recovery.<ts>.marker.json` (recovery marker). These accumulate over time — an operator might want periodic cleanup, but each occurrence is exceptional (disk errors).
- **Persistent state:** The JSONL append log is never modified — only read during rebuild. The SQLite DB is replaced (quarantined + fresh). No other persistent state is touched.

## 7. Rollback cost

Pure code change. Revert removes the integrity check — corrupt DBs would again cause `open()` to either throw or silently serve bad data. No migration, no data repair needed on rollback.

---

## 8. Destructive-tool containment compliance

`quarantineCorruptDb()` uses `fs.unlinkSync` to remove the corrupt DB and its WAL/SHM sidecars. Per the Comprehensive Destructive-Tool Containment spec (PRs #98/#99), all destructive filesystem calls must go through `SafeFsExecutor`. Updated:

- `fs.unlinkSync(this.config.dbPath)` → `SafeFsExecutor.safeUnlinkSync(this.config.dbPath, { operation: 'SemanticMemory.quarantineCorruptDb' })`
- `fs.unlinkSync(this.config.dbPath + ext)` → `SafeFsExecutor.safeUnlinkSync(this.config.dbPath + ext, { operation: 'SemanticMemory.quarantineCorruptDb:sidecar' })`

The test file uses `fs.rmSync` in `afterEach` cleanup only (temp directory in `os.tmpdir()`). Annotated with `// safe-git-allow:` escape comment per the lint spec.

---

## Evidence pointers

- Typecheck: `tsc --noEmit` — 0 errors.
- Lint: `node scripts/lint-no-direct-destructive.js` — 0 violations.
- Tests: 12 contract tests covering all recovery paths including partial corruption (valid SQLite header + 4KB corrupted data page in 5000-row DB), size-gate behavior, and skipped-rebuild marker.
- TopicMemory parity: pattern mirrors `TopicMemory.open()` which has been production-stable since v0.27.x.
