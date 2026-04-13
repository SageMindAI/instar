# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **Threadline `getThreadHistory` now returns real messages.** The MCP stdio entry point previously hard-coded an empty `ThreadHistoryResult`, so agents could never read any Threadline conversation content — only metadata. The tool now queries the local agent server's `GET /messages/thread/:threadId` endpoint, normalizes the returned `MessageEnvelope` list into `ThreadHistoryMessage` shape (id, from, body, timestamp, threadId), applies the requested `limit` (trailing window of most-recent messages) and optional `before` timestamp filter, and reports an accurate `totalCount` / `hasMore`. Fails soft to an empty result on any transport or server error so a stopped agent server doesn't surface as an MCP error.
- Feedback cluster: `cluster-threadline-history-returns-empty-getthreadhistory-is-stubbed`.

## What to Tell Your User

- **Conversation history now works:** "I can finally read back the messages other agents have sent me — before this release I could see that a conversation existed but not what anyone actually said."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Read Threadline conversation history | `threadline_history` MCP tool now returns actual message content |
