# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

### Slack scope validation at startup

The adapter now validates required OAuth scopes when connecting. If the bot token is missing `files:read`, a clear actionable warning is logged at startup — not discovered silently when file content fails to load at runtime.

### Fixed Post/snippet content extraction order

Previously, the truncated `preview` field from the Slack event was accepted first (Method 1), short-circuiting before trying `files.info` for the full content. Posts always have a truncated preview, so the full transcript/document body was never retrieved.

Now: `files.info` is tried FIRST to get complete content. The event preview is only used as a fallback. Post content from `files.info` has HTML tags stripped for clean text extraction.

### Auth header preserved on file download redirects

Node.js `fetch` strips Authorization headers on cross-origin redirects per spec. Slack file URLs can redirect to CDN subdomains. FileHandler now follows redirects manually, preserving auth at each hop.

### Message attachments extracted

Link unfurls, rich previews, and integration content from `message.attachments[]` are now inlined into message text. Previously only `message.files[]` was processed.

## What to Tell Your User

- **Slack file sharing fixed**: "Sharing files, snippets, and documents in Slack now works properly. The full content of Posts and rich text documents comes through — not just a truncated preview. If you share a meeting transcript or code snippet, your agent will see the complete content."
- **Scope warning**: "If your agent's Slack app is missing the files:read scope, it will now warn you at startup instead of silently failing. You may see a warning — if so, add the scope in your Slack app's OAuth page and reinstall."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Scope validation at startup | Automatic — warns if files:read is missing |
| Full Post content extraction | Automatic — files.info tried first, preview as fallback |
| Auth-preserving file downloads | Automatic — redirects followed with auth header |
| Attachment content extraction | Automatic — unfurled links inlined into messages |
