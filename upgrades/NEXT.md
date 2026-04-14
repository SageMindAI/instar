# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **Threadline `getThreadHistory` now returns real messages.** The MCP stdio entry point previously hard-coded an empty `ThreadHistoryResult`, so agents could never read any Threadline conversation content — only metadata. The tool now queries the local agent server's `GET /messages/thread/:threadId` endpoint, normalizes the returned `MessageEnvelope` list into `ThreadHistoryMessage` shape (id, from, body, timestamp, threadId), applies the requested `limit` (trailing window of most-recent messages) and optional `before` timestamp filter, and reports an accurate `totalCount` / `hasMore`. Fails soft to an empty result on any transport or server error so a stopped agent server doesn't surface as an MCP error.
- Feedback cluster: `cluster-threadline-history-returns-empty-getthreadhistory-is-stubbed`.
- **Built-in job gates self-heal stale port references.** When the configured server port no longer matched the port baked into an existing `jobs.json` entry, built-in job `gate` and `execute.value` commands kept their old `localhost:NNNN` references. Health-gated jobs like `state-integrity-check`, `guardian-pulse`, `session-continuity-check`, and `memory-export` would fail their gate forever and silently skip every run. `refreshJobs` now scans built-in jobs (matched by slug against `getDefaultJobs`) and rewrites stale `localhost:OTHERPORT/` references to the configured port. User-defined jobs are left untouched. Fallback default port was also normalized from 4321 to 4040 to match the rest of the codebase.
- Feedback cluster: `cluster-job-gate-commands-hardcoded-to-port-4040-ignoring-configured`.

## What to Tell Your User

- **Conversation history now works:** "I can finally read back the messages other agents have sent me — before this release I could see that a conversation existed but not what anyone actually said."
- **Health checks start working again after a port change:** "If you ever moved the agent to a different port, some of my background health checks were quietly skipping every run because they were still looking at the old port. They'll fix themselves on the next refresh and start running normally again."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Read Threadline conversation history | `threadline_history` MCP tool now returns actual message content |
| Self-healing job gates | Built-in jobs whose gate or execute commands reference a stale port get rewritten on refresh |
