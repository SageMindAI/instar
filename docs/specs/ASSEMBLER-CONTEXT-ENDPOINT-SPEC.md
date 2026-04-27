---
title: "Wire WorkingMemoryAssembler into session context API"
slug: "assembler-context-endpoint"
author: "gfrankgva"
status: "converged"
review-convergence: "2026-04-27T18:00:00Z"
review-iterations: 3
review-completed-at: "2026-04-27T18:00:00Z"
approved: true
approved-by: "JKHeadley"
approved-date: "2026-04-13"
approval-note: "Approved in PR #43 review — JKHeadley chose option 1 (include wiring in this PR). Subsequent Echo reviews refined the implementation."
---

# Wire WorkingMemoryAssembler into session context API

## Problem

`WorkingMemoryAssembler` was implemented with a clean token-budgeted assembly system (tiered rendering: top 3 full detail, next 7 compact, remainder name-only) but was not exposed through any HTTP endpoint. The session-start flow called `GET /topic/context/:topicId` which returns raw `TopicContext` (summary + recent messages) without any token budgeting or cross-memory-layer assembly.

## Solution

1. **`GET /topic/context/:topicId?assembled=true`** — opt-in assembled mode on existing endpoint, backwards compatible
2. **`GET /session/context/:topicId`** — dedicated assembled endpoint for session-start hooks
3. **Assembler construction in server.ts** — wired with both `semanticMemory` and `episodicMemory` (from activitySentinel), positioned after sentinel init for correct dependency order
4. **Shared `assembleAndRespond` helper** — DRY extraction used by both routes

## Decision Points

- **Auth**: Both routes behind global `authMiddleware` in AgentServer.ts — no per-route middleware needed
- **Episodic wiring**: Moved assembler init after activitySentinel so `getEpisodicMemory()` is available. Degrades gracefully when sentinel is not active.
- **Token budgets**: knowledge=800, episodes=400, relationships=300, total=2000 — exposed in response `budgets` field

## Files Changed

- `src/commands/server.ts` — Move assembler init after activitySentinel, wire episodicMemory
- `src/server/routes.ts` — Extract `assembleAndRespond` helper, add auth confirmation in JSDoc
