# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

**Fix Slack session resume** — The resume heartbeat (60s interval) was saving Slack channel resume UUIDs to the wrong file. It wrote to `topic-resume-map.json` using synthetic numeric IDs, but the Slack message handler reads from `slack-channel-resume-map.json` using real channel IDs. The heartbeat now writes to both files, ensuring that when a Slack session dies, the next message in that channel correctly resumes the previous session.

**Fix cross-topic UUID contamination in proactive saves** — When multiple sessions ran concurrently, the proactive UUID save (fired 8s after session spawn) could pick up the wrong session's UUID via an mtime-based fallback. This caused sessions to resume another topic's conversation entirely. All 4 proactive save locations (telegram-forward, secret-drop, spawnSessionForTopic, Slack heartbeat) now exclusively use the authoritative `claudeSessionId` from hook events. The heartbeat (60s) handles any sessions where hooks haven't fired yet, with a proper multi-session guard.

Also fixed a stale unit test for `findUuidForSession()` and added a public `jsonlExistsPublic()` method to `TopicResumeMap` for external UUID validation.

## What to Tell Your User

- **Session resume reliability**: "Sessions now reliably resume the correct conversation across all messaging integrations (Telegram, Slack). A bug was causing sessions to occasionally resume a completely different topic's conversation when multiple topics were active at the same time."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Reliable session resume (all integrations) | Automatic — sessions resume correctly even with concurrent topics |
