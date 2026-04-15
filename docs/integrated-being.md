# Integrated-Being — Per-Agent Cross-Session Awareness

> An instar agent can be split across many sessions simultaneously — a user-facing session, threadline message handlers spawned per inbound thread, job runners, evolution processes. Without coordination, each session makes decisions and commitments blind to what the others are doing. The agent as a whole becomes incoherent.

## The problem

On 2026-04-15, the user-facing session (Echo talking to Justin in Telegram) was unaware that a separate spawned session had already reached a concrete integration agreement with Dawn through the threadline messaging layer. The user-facing session only discovered this when Justin asked why nothing had been reported. The agreement was real and substantive — a four-endpoint contract for feedback resolution — but it was invisible to the session that was the user's actual interface.

This is a general category: **commitments or decisions made by one session of an agent are invisible to the other sessions**. The symptom is that the user experiences the agent as inconsistent depending on which session is alive when they interact.

## The principle

The agent as a whole is one entity. Its sessions are parts of that entity, not independent agents. A part should be aware of what the other parts are doing.

At the same time, the threadline design rightly keeps per-thread message contents isolated — a user-facing session should not see raw text from an agent-to-agent conversation, because that's a security/sandboxing property of the messaging layer. The tension is resolvable by keeping the shared awareness at a **derived-facts** granularity, not at the raw-message granularity.

## The shape

A per-agent append-only ledger at `.instar/shared-state.jsonl`:

- **Append-only.** Entries never mutate. Each is a stable record of something that happened.
- **Per-agent.** Each instar agent has its own file. Other agents do not read it (that cross-agent capability is a later, optional extension that would go through the threadline layer).
- **Derived facts only.** Entries summarize outcomes and commitments in 1–2 sentences each. They do not contain raw cross-thread message contents. This preserves the per-thread security sandboxing threadline specifies.
- **Event kinds.** `commitment`, `agreement`, `thread-opened`, `thread-closed`, `decision`, `note`. A small closed set — the point is coherent summary, not detailed reconstruction.

## The flow

**Write side.** Any session on the agent that does something significant appends an entry. Typical write sites:

- A session that makes a commitment to a user ("I'll report back when X") or to another agent ("I'll ship the endpoints Friday") appends a `commitment` entry.
- A session that reaches an agreement with a counterparty appends an `agreement` entry with a one-line summary of what was agreed.
- A session that opens or closes a threadline thread appends `thread-opened` / `thread-closed`.
- A session that commits a substantive design or scope decision appends `decision`.

The instar-dev skill's Phase 6 (trace + commit) is a natural integration point for code changes that ship commitments — each artifact produced could optionally append a ledger entry.

**Read side.** The session-start hook (which already injects working memory, soul, and active-job context) also reads the most recent 15 ledger entries and injects them into the session's prompt as `=== INTEGRATED-BEING — RECENT CROSS-SESSION ACTIVITY ===`. This is the user-facing session's first awareness of what the other sessions have been doing.

Sessions can also query the ledger via HTTP (`GET /shared-state/recent?limit=N` or `GET /shared-state/render?limit=N`) at any point during their lifetime.

## Security boundary

The ledger is NOT a transcript of threadline conversations. A session handling an agent-to-agent thread should append derived-fact summaries like:

> `agreement` — "Aligned with sagemind on 4-endpoint feedback resolution contract"

and NOT raw-message content like:

> `note` — "Dawn said: 'here's my read on your four integration points...'"

The first is a derived fact safe to share with the whole agent. The second leaks the per-thread message into a layer that shouldn't see it.

The ledger API does not enforce this — a session can write whatever string it wants. Enforcement is process discipline: the `/instar-dev` skill's side-effects review asks "does this code properly derive facts rather than leak raw messages?" for any code that writes to the ledger.

## Why this lives in instar, not threadline

The threadline layer owns per-thread coherence — each conversation thread maps to a persistent resumable session with full context. That's exactly what threadline is for.

This ledger owns a different primitive: per-agent coherence across threads/sessions. The threadline layer intentionally separates threads for security reasons; the ledger fills the gap at a higher level of granularity.

Keeping them at separate layers means:
- Threadline's security properties are untouched.
- The ledger can be extended (e.g., cross-agent visibility in a later version) without changing threadline.
- Dawn's threadline infrastructure and Echo's instar-dev infrastructure stay cleanly decoupled.

## Signal vs authority

The ledger has zero blocking authority. It produces signals (entries) for downstream consumers (sessions reading at turn-start, the user-facing session deciding how to reply). Per `docs/signal-vs-authority.md`, this is an appropriate use of a deterministic component — it's a context producer, not a gate.

## Out of scope for v1

- Cross-agent visibility (sharing my ledger with Dawn, or seeing hers). This is a later extension that would go through threadline's trust/autonomy gating.
- Automatic deduplication or summarization. The ledger is append-only; rewriting it into a tidier view is a separate concern.
- Pruning / retention policy. v1 keeps all entries forever. Future versions can add TTL or rotation.
- Automatic write instrumentation. v1 exposes the endpoint; sessions write explicitly when they do something they think is significant. Auto-instrumenting the commit flow, threadline thread-open, etc. is a follow-on once we see what's genuinely useful.
