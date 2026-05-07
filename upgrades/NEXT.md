# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Threadline conversations now have human-readable agent names everywhere
on the dashboard. Before this release, every counterparty showed up as
an 8-character hex fingerprint (e.g. "8c7928aa") in both the conversation
list and individual message rows, which made the Threadline tab feel
like a debug log rather than a chat app.

Three layers, each of which can be the source of truth:

1. **User-set nicknames.** A pencil icon on every conversation header
   opens an inline modal where you can name (or rename) the agent
   yourself. Names are persisted to
   `.instar/threadline/nicknames.json`, keyed by fingerprint, and
   ALWAYS win over the other two layers.

2. **Registry / inline names.** When the agent has a declared name in
   `.instar/threadline/known-agents.json` or the message itself carries
   a `senderName`/`recipientName`, that name is used.

3. **Haiku-suggested nicknames.** A new `ThreadlineNicknameSuggester`
   reads the most recent thread for any agent that resolves only to a
   fingerprint, sends the last 10 messages to a "fast"
   IntelligenceProvider (Haiku), and asks for a 1–2 word nickname.
   Bounded to 5 agents per run, idempotent, skipped on agents that
   already have any name. Triggered both by the new ✨ button in the
   Threadline header and by a 15-minute periodic sweep.

## Endpoints

| Method | Path                                          | Purpose                          |
|--------|-----------------------------------------------|----------------------------------|
| GET    | `/threadline/nicknames`                       | List all nicknames               |
| PUT    | `/threadline/nicknames/:fingerprint`          | Set/clear (always source: user)  |
| DELETE | `/threadline/nicknames/:fingerprint`          | Clear                            |
| POST   | `/threadline/nicknames/suggest`               | Run Haiku sweep on demand        |

`POST /threadline/nicknames/suggest` accepts `?dryRun=1` for preview and
`?max=N` to cap how many agents are named. The response surfaces both
applied nicknames and skipped fingerprints with reasons, so a dashboard
or operator can see why a candidate was passed over.

## Privacy / cost note

The Haiku suggester sends excerpts of inbox/outbox messages to whichever
IntelligenceProvider you have wired (Anthropic API or Claude CLI). The
content sent is at most the last 10 messages of the most recent thread,
each truncated to 240 chars, with direction labels but no fingerprints,
trust levels, or message ids.

If you don't want this — for example, if your threadline carries
sensitive material — leave `intelligenceProvider` unset (the default).
The suggester becomes a no-op: the existing UI continues to work, the
✨ button returns a 503 ("no intelligence provider configured"), and
nicknames remain user-only.

## Migration

No migration. The nicknames file is created on first write. Existing
threadline state, registry, and bindings are unchanged.
