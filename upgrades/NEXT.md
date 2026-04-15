# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fixed a silent failure in post-update migration: when Node.js is upgraded in place (e.g., via `brew upgrade node`) while an Instar server is still running, `process.execPath` can point at a binary path that no longer exists on disk. The subsequent spawn fails with ENOENT and post-update migration skips silently, leaving agent configuration stale after auto-updates.

`UpdateChecker.postUpdateMigration` now guards `process.execPath` with an `existsSync` check and falls back to `node` on PATH when the resolved exec path has been deleted.

## What to Tell Your User

- **More reliable self-updates**: "If your system's Node was upgraded while I was running, my next auto-update will still apply its migrations correctly instead of silently skipping them."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Resilient post-update migration across in-place Node upgrades | automatic |

## Evidence

Reproduction: Homebrew users who ran `brew upgrade node` between Instar server starts reported repeated `UpdateChecker.postUpdateMigration` degradation events with reason `spawn /opt/homebrew/Cellar/node@22/22.22.2/bin/node ENOENT`. Root cause traced to `src/core/UpdateChecker.ts:282` where `cmd = process.execPath` was spawned unconditionally.

Verified fix: Before — `execFile(process.execPath, [shadowCliJs, 'migrate'])` rejects with ENOENT when the Cellar path is gone; degradation reporter fires; migration skipped. After — `fs.existsSync(process.execPath)` returns false, `cmd` falls back to `'node'`, spawn resolves via PATH, migration runs. Unit tests for UpdateChecker (13) continue to pass.
