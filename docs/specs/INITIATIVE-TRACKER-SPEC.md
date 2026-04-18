---
title: "Initiative Tracker — Don't Let Multi-Week Efforts Fall Off the Radar"
slug: "initiative-tracker"
author: "echo"
review-convergence: true
convergence-iterations: 1
convergence-date: "2026-04-18"
convergence-note: "Retrospective single-iteration convergence: implementation was already written and stashed before this spec was authored. Review consisted of one careful re-read (risk surfaces, rollback cost, non-goals, API shape) plus the user-facing ELI10 check in Telegram topic 2317. Lower-risk than the usual 5-iteration target is acceptable here because rollback cost is one JSON blob + a dashboard tab + one route prefix."
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-04-18"
approval-note: "Approved via Telegram topic 2317 — 'i agree with option 1, so please go'. Ships the stashed InitiativeTracker implementation as Phase 1 (core + API + dashboard). Digest job deferred to a follow-up."
---

# Initiative Tracker

> Multi-week efforts (PR hardening, threadline v2, context-death hardening, …) span many sessions, Telegram topics, and compactions. Today there is no single surface where the state of any one of them is visible. They drop. This spec adds a small structured record per initiative and a dashboard view so both the agent and the user can see what is in flight, what is stuck, and what needs a decision.

## ELI10 version

Think of it as a whiteboard.

- Every multi-week thing gets one card.
- Each card has: name, phases (off → shadow → on, or whatever the effort's phases are), current phase, last-touched date, next-check date, blockers, and "what does the user need to decide."
- The dashboard shows the board. The agent can query it. Future work will have a daily digest that pings the user when a card goes stale (>7 days), needs a decision, or is ready to advance.

The agent writes to the board through a JSON API. The user reads the board through the dashboard. That is all.

## Problem statement

Long-running, multi-session efforts keep falling into gaps between sessions. Evidence:

- **PR-hardening Phase B/C/D** — Phase A shipped 2026-04-17; the handoff note exists but there is no systemic surface saying "you owe this a decision."
- **Threadline growth work** — various strands touched across days, no single view.
- **This very feature** — was built, stashed, and sat unreferenced for a day until a parallel session spotted the stash and flagged it.

Everything needed to track these efforts already lives in git history + MEMORY.md + handoff notes, but the user has no aggregated view. They have to ask "is there anything left to do here?" every session. That is an infrastructure gap, not a memory gap.

## Proposed design

### Phase 1 — scope of this commit

1. **`InitiativeTracker` core class.** Persists a JSON ledger at `.instar/initiatives.json`. Schema per record:
   - `id` — slug
   - `title` — short human-readable name
   - `phases[]` — ordered list of named phases the initiative progresses through
   - `currentPhase` — one of `phases`
   - `status` — one of `active | blocked | paused | done | abandoned`
   - `lastTouchedAt` — ISO timestamp
   - `nextCheckAt` — optional ISO timestamp
   - `blockers[]` — short strings
   - `awaitingUser` — optional short string ("decide Phase B flip", "approve spec X")
   - `notes` — freeform
   - `createdAt`, `updatedAt`

2. **HTTP endpoints** under `/initiatives`:
   - `GET /initiatives` — list
   - `GET /initiatives/:id` — fetch one
   - `POST /initiatives` — create
   - `PATCH /initiatives/:id` — partial update (touches `updatedAt` + `lastTouchedAt` on any status/phase/blocker change)
   - `POST /initiatives/:id/transition` — named phase transition (records prior phase in notes)
   - `DELETE /initiatives/:id` — remove
   - `GET /initiatives/digest` — derive signals from current ledger: stale (>7d no touch), awaiting-user, next-check-due, ready-to-advance

3. **Dashboard tab** "Initiatives" — read-only list with filter chips (active / blocked / awaiting-user / stale). Clicking a card shows the detail view. XSS-safe via `textContent` on all user-authored strings.

4. **Auth** — all endpoints (except none; there is no public surface) require the agent auth token, same mechanism as `/jobs`, `/relationships`, etc.

### Out of scope for Phase 1 (follow-ups)

- **Daily digest job** that POSTs awaiting-user cards to Telegram. Code was drafted locally but is not in the stash being shipped here; will land as its own commit with its own trace + artifact.
- **Auto-seeding** from git log / handoff notes. Initially the agent seeds records manually through `POST /initiatives`. Seeded records for the PR-hardening initiative and this one will be added after the server restarts.
- **Edit-in-dashboard**. Phase 1 is read-only. Mutations go through the API.

## Non-goals

- This is not a replacement for TaskCreate/TaskList (which are per-session). Initiatives span sessions.
- This is not a replacement for `.instar/MEMORY.md` (which is freeform learnings). Initiatives are structured, timebound records.
- This is not a ticket system. No assignees other than the agent. No priority fields. No sprint planning.

## Rollback cost

Very low. The ledger file is one JSON blob at `.instar/initiatives.json`. The dashboard tab is isolated (new HTML section). The routes are all under `/initiatives`. Rip-out is deleting the new files + reverting the three additions to `src/server/AgentServer.ts`, `src/server/routes.ts`, `src/commands/server.ts`, and `dashboard/index.html`.

## Success criteria

1. Agent can POST a record, the record persists across server restarts.
2. Agent can PATCH a record; the digest endpoint reflects the change within the same request/response cycle.
3. Dashboard tab renders the current ledger state and updates on reload.
4. All CRUD operations require the auth token; unauth requests get 401.
5. `GET /initiatives/digest` correctly classifies: stale (>7d no touch), awaiting-user (awaitingUser is set), next-check-due (nextCheckAt <= now), ready-to-advance (manually flagged via a status value or awaitingUser clear).
6. 60+ tests green, tsc clean.
