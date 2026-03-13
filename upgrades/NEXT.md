# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Dashboard File Viewer — Phase 3: Conversational UX + Polish

The file viewer is now a seamless part of the agent-user conversation:

1. **Conversational config updates** — `PATCH /api/files/config` lets agents update `allowedPaths` and `editablePaths` without restarting the server. When a user says "I want to browse my src/ directory," the agent can add it immediately with server-side validation (project root boundary, never-editable enforcement).

2. **Link generation API** — `GET /api/files/link?path=.claude/CLAUDE.md` returns a structured response with the relative dashboard URL and editability status. Agents can use this to generate deep links to files mid-conversation.

3. **Dashboard broadcast with quick links** — The Telegram Dashboard topic message now includes quick links to Sessions and Files tabs, not just the main dashboard URL.

4. **CLAUDE.md template updated** — New agents get full file viewer documentation in their CLAUDE.md, including when to link vs inline, how to update config conversationally, and tunnel URL awareness.

5. **Context snapshot awareness** — The `file-viewer` feature is now included in the agent's capability snapshot for dispatch evaluation.

## What to Tell Your User

- **"You can now ask me to add directories to your file browser."** If you want to browse or edit files in a new folder, just tell me — I'll update the config instantly without needing a restart.

- **"When I share a file, I'll link you right to it."** Long files get a dashboard link instead of a wall of text in chat. One tap opens the file, ready to view or edit.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Update file viewer paths | `PATCH /api/files/config` with `allowedPaths` or `editablePaths` |
| Generate file deep link | `GET /api/files/link?path=<relative-path>` |
| Quick links in dashboard broadcast | Automatic — included in Telegram Dashboard topic |
| File viewer in context snapshot | Automatic — appears in capabilities when enabled |
