# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- Fixed CI test failure in `config-loadconfig.test.ts`: the "loadConfig preserves safety config" test was missing explicit `sessions.tmuxPath` and `sessions.claudePath` in its test config, causing `detectClaudePath()` to throw on CI environments where Claude CLI is not installed.

## What to Tell Your User

- **CI fix**: "A test was failing in CI because it wasn't properly isolated from the environment — now fixed."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| No new capabilities | Bug fix only |
