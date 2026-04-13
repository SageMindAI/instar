# Track 1: Session Lifecycle & Process Model

## Executive Summary
Instar spawns Claude Code as separate OS processes via tmux, with `--dangerously-skip-permissions` hardcoded for all interactive sessions. A multi-layer context injection pipeline assembles agent identity, user context, topic history, and working memory before each session. Crash detection uses JSONL tail-scanning, and concurrency is controlled via a priority queue with configurable `maxParallelJobs`.

---

## 1. Session Spawning — Claude CLI Invocation

**[VERIFIED]** `src/core/SessionManager.ts:432`
```typescript
const claudeArgs = ['--dangerously-skip-permissions'];
```
- **Hardcoded** for all interactive sessions — NOT configurable
- Passed to `execFileSync()` via `tmux new-session` (line 439-454)
- Alternate: Triage sessions (line 1040-1120) use `--allowedTools` + `--permission-mode dontAsk` instead

**Tmux command structure:**
```
tmux new-session -d -s {SESSION} -c {PROJECT_DIR} \
  -e CLAUDECODE= \
  -e INSTAR_SESSION_ID=... \
  -e ANTHROPIC_API_KEY= \
  -e DATABASE_URL= \
  {claudePath} --dangerously-skip-permissions -p "{prompt}"
```

**Environment isolation (lines 443-454):**
- `CLAUDECODE=` — prevents nested Claude Code detection
- `INSTAR_SESSION_ID` — exposes session ID to hooks
- `ANTHROPIC_API_KEY=` — cleared (agents use Claude subscription)
- `DATABASE_URL=`, `DIRECT_DATABASE_URL=`, etc. — cleared (Portal incident 2026-02-22)

---

## 2. Telegram Message Flow

**[VERIFIED]** Complete chain traced through `src/server/routes.ts` and `src/commands/server.ts`:

1. **HTTP POST** `/internal/telegram-forward` receives message (routes.ts:4390-4416)
2. **Dispatch** `telegram.onTopicMessage(msg)` (server.ts:877)
3. **Decision tree** (server.ts:877-1053):
   - `/new` command → creates forum topic, NO session spawn
   - Session alive → `injectTelegramMessage()` (line 970-972)
   - Session dead → `respawnSessionForTopic()` with history (line 1008)
   - No session → `spawnSessionForTopic()` with topic history (line 1038)
4. **Context assembly** (server.ts:334-497):
   - TopicMemory-based history (SQLite with summaries)
   - JSONL fallback (raw message list)
   - Agent self-knowledge (ContextSnapshotBuilder)
   - User context (UserContextBuilder)
   - Inline context + user message assembly
5. **Response capture** via `captureOutput()` (SessionManager.ts:679)

**Bootstrap message structure:**
```
CONTINUATION — You are resuming an EXISTING conversation...
--- Agent Identity ---
{agent context}
--- End Agent Identity ---
[USER CONTEXT]
{permissions, preferences, bio, interests}
[/USER CONTEXT]
--- Thread History (last N messages) ---
[history]
--- End Thread History ---
The user's latest message:
[telegram:{topicId}] {user_message}
```

---

## 3. Scheduled Job Flow

**[VERIFIED]** `src/scheduler/JobScheduler.ts`

1. **Cron trigger** (lines 231-234): `new Cron(job.schedule, () => this.triggerJob(job.slug, 'scheduled'))`
2. **Pre-flight checks** (lines 296-364):
   - Paused check (302-304)
   - Machine scope filter (308-316)
   - Multi-machine claim check via JobClaimManager (319-330)
   - Resource gate via `canRunJob()` (333-348) — returns `boolean | CanRunJobResult`; records actual gating reason (`quota`, `memory-pressure`, etc.) via `normalizeCanRunResult()`
   - Gate command pre-screening (350-356)
   - Session capacity check → enqueue if at limit (358-364)
3. **Session spawn** (lines 463-562):
   - Build prompt via `buildPrompt(job)` (line 464)
   - Write `active-job.json` BEFORE spawn (472-483)
   - Call `sessionManager.spawnSession()` (496-508)
4. **Prompt building** (lines 586-654):
   - Base prompt (skill/prompt/script)
   - Topic awareness injection if bound to Telegram topic
   - Handoff notes from previous execution
   - Notification protocol for on-alert jobs

**Handoff format (lines 626-638):**
```
[CONTINUITY FROM PREVIOUS EXECUTION]
Previous session: {sessionId} (completed: {date})
Handoff notes: {handoff_notes}
State snapshot: {json_state}
[END CONTINUITY]
```

---

## 4. Session Isolation

**[VERIFIED]** True process separation via tmux:
- Each session = separate tmux pane + Claude process (OS-level process)
- No threads — `SessionManager` extends `EventEmitter` for in-process coordination only
- Process verification via `isSessionAlive()` (lines 492-535): checks `#{pane_current_command}` for 'claude' or 'node'
- Protected sessions via `config.protectedSessions` exempt from zombie cleanup

---

## 5. Context Injection Assembly

**[VERIFIED]** Five-phase injection:

| Phase | Source | File | Token Budget |
|-------|--------|------|-------------|
| 1. User Context | UserContextBuilder | `src/users/UserContextBuilder.ts:79-143` | 500 tokens |
| 2. Agent Self-Knowledge | ContextSnapshotBuilder | `src/commands/server.ts:399-410` | — |
| 3. Topic History | TopicMemory or JSONL | `src/commands/server.ts:338-378` | 4000 chars inline |
| 4. Session-Start Hook | Working memory, Soul.md, blockers | `src/templates/hooks/session-start.sh` | — |
| 5. Working Memory | SemanticMemory + EpisodicMemory | `src/memory/WorkingMemoryAssembler.ts:115-171` | 2000 tokens total |

Working Memory token budgets: knowledge=800, episodes=400, relationships=300, total=2000.

---

## 6. Crash Handling

**[VERIFIED]** `src/monitoring/crash-detector.ts`

- **Detection** (lines 55-119): JSONL tail-scan checks `stop_reason`:
  - `'end_turn'` → clean exit
  - `'tool_use'` → crash (incomplete tool execution)
  - Last entry `is_error: true` → crash
- **Error loop detection** (lines 132-170): 3+ identical errors in last 50 entries
- **Lifeline recovery** (`src/lifeline/TelegramLifeline.ts`):
  - Lock file management prevents multiple instances
  - Force-kills zombie lifelines (5+ min old)
  - `MessageQueue.ts` persists messages to disk when server unavailable, replays on recovery
- **Respawn deduplication** (server.ts:1002): `spawningTopics` set prevents concurrent spawns

---

## 7. Context Window / Compaction

**[VERIFIED]** `src/monitoring/jsonl-truncator.ts:45-160`

- Strategies: `'last_exchange'`, `'last_successful_tool'`, `'n_exchanges_back'`
- Tail-scan approach: reads last 256KB to find truncation point
- Byte-offset precision truncation
- Always creates `.bak.{timestamp}` backup
- MAX_INLINE_CHARS = 4000 for session bootstrap; overflow goes to `/tmp/instar-telegram/history-*.txt`

---

## 8. Concurrency Control

**[VERIFIED]** `src/scheduler/JobScheduler.ts`

- Config field: `maxParallelJobs: number` (types.ts:197)
- Enforcement (lines 315-320): counts running job sessions, enqueues if at limit
- Queue (lines 443-461): max 50 items, sorted by priority (critical > high > medium > low)
- Dequeue (lines 355-375): FIFO within priority tier, checks capacity before drain

---

## 9. Hooks vs. --dangerously-skip-permissions

**[VERIFIED]** Hooks are a SEPARATE layer from Claude Code's permission system:

- `--dangerously-skip-permissions` skips API permission prompts
- Behavioral hooks (PreToolUse, PostToolUse, Stop) run REGARDLESS
- `dangerous-command-guard.sh` (PreToolUse on Bash): always-blocks `rm -rf /`, `dd if=`, fork bombs; gates risky commands like `git reset --hard`, `git push --force`
  - Safety Level 1: Block + tell agent to ask user (exit code 2)
  - Safety Level 2: Inject self-verification prompt (exit code 0)
- Hooks are Claude Code infrastructure, not bypassed by the permissions flag
