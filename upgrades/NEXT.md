# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Two fixes for volatile state that didn't survive restarts in the Threadline REST adapter and relay offline queue:

1. **REST thread history now persists to disk.** `ThreadlineRESTServer` previously held thread history in memory only, so restarts lost all conversation history even when the client-side MessageStore had messages on disk. The server now hydrates from `~/.threadline/thread-history.json` on startup and persists debounced (1s) on incoming messages and thread deletions. Writes are atomic (temp file + rename) and size-bounded by the existing `maxMessageHistoryPerThread` cap. New config: `historyPath` (default `~/.threadline/thread-history.json`) and `persistHistory` (default `true`, set `false` for tests/ephemeral servers).

2. **Offline queue default TTL extended from 1h to 24h.** `InMemoryOfflineQueue`'s 1-hour default was shorter than typical offline/restart windows for agents, so messages to offline recipients expired before reconnection. Configurable via `OfflineQueueConfig.defaultTtlMs` if you need different behavior.

No API breakage. Existing servers/queues using defaults just get more durable behavior.

## What to Tell Your User

- **Conversation history survives restarts**: "Your thread history will stick around now even if I get restarted — no more losing context from earlier in our conversation."
- **Messages wait longer for offline agents**: "If you message another agent who's offline, the message will wait up to a day for them to come back online instead of expiring after an hour."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Persistent REST thread history | Automatic (opt-out via `persistHistory: false`) |
| 24h offline message retention | Automatic (override via `defaultTtlMs`) |

## Evidence

Reproduction before fix:
1. Start `npx @anthropic-ai/threadline serve --port 18800`
2. Receive messages on a thread → `GET /threads/{id}` returns them
3. Restart the server
4. `GET /threads/{id}` returns 404 — history lost

After fix:
1. Same steps 1–2
2. Within 1s, `~/.threadline/thread-history.json` contains the thread
3. Restart the server
4. `GET /threads/{id}` returns the same messages — hydrated from disk

Unit tests (40/40 passing in `OfflineQueue.test.ts` and `RESTServerE2E.test.ts`) cover the default config values and existing REST flows; persistence is best-effort (wrapped in try/catch) so disk failures don't crash the server.
