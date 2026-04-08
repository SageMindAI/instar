# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

Added `PATCH /config` endpoint that all FeatureDefinition enable/disable actions reference. Previously, toggling features from the dashboard (evolution, threadline, publishing, tunnel, etc.) returned 404 because the endpoint didn't exist. The new endpoint deep-merges the request body into config.json with an allowlist of safe config keys, and updates runtime config.

Also includes CI test fixes from previous commits (trust wiring, quota tracking, config validation, job scheduler edge cases).

## What to Tell Your User

- **Dashboard feature toggles now work**: "You can now enable/disable features from the dashboard — the toggle buttons actually persist your choice."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Config patch API | `PATCH /config` with JSON body — dashboard uses this automatically |
| Feature toggle persistence | Toggle features on/off from dashboard, changes persist to config.json |
