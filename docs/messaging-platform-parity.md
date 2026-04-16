# Instar Messaging Platform Feature Parity Matrix

> **Purpose**: This document catalogs every messaging feature in Instar's Telegram integration
> and tracks parity status across all messaging platforms. It is the foundation for ensuring
> consistent user experience regardless of which platform an agent communicates through.
>
> **Maintained by**: Echo (instar developer agent)
> **Last updated**: 2026-04-04

---

## 1. Message Types

### 1.1 Inbound Message Handling

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 1.1.1 | Text messages | Plain text from user | Yes | Yes (v0.26.8: link unfurl content extracted — attachment title/text from message.attachments[] inlined into message text, covering rich previews and integration content like Fathom transcripts, GitHub PRs, etc.) | - |
| 1.1.2 | Photo/image messages | User sends photo, downloaded to disk, passed as `[image:path]` | Yes | Yes | - |
| 1.1.3 | Document/file messages | User sends file, downloaded with original filename, passed as `[document:path]` | Yes | Yes (v0.26.1: standalone file_shared events + message-embedded files; fetches metadata via files.info API; v0.26.4: text-based files/snippets inlined as code blocks instead of document references; v0.26.5: three-tier snippet content resolution; v0.26.8: prefers url_private_download over url_private; auth header preserved across CDN redirects via manual redirect handling; v0.26.11: extraction order corrected — files.info tried first for full Post/snippet content, event preview used as fallback only; HTML tags stripped from Post content) | - |
| 1.1.4 | Voice messages | User sends voice memo, transcribed via Whisper (Groq/OpenAI), passed as `[voice] transcript` | Yes | Yes (v0.25.0: transcribeVoice callback; Groq/OpenAI) | - |
| 1.1.5 | Sticker messages | Silently ignored | N/A | N/A | - |
| 1.1.6 | Callback queries | Inline keyboard button presses (Prompt Gate responses) | Yes | Yes (Block Kit actions) | - |
| 1.1.7 | Forwarded messages | Silently rejected (prevents forwarding attacks on Prompt Gate) | Blocked | Not implemented | - |

### 1.2 Outbound Message Handling

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 1.2.1 | Plain text reply | Send text response to user | Yes | Yes | - |
| 1.2.2 | Markdown formatting | Parse mode with automatic fallback to plain text on error | Yes (Markdown) | Yes (mrkdwn) | - |
| 1.2.3 | Message chunking | Split long messages (>4096 chars Telegram, >4000 chars Slack) | Yes | Yes | - |
| 1.2.4 | Silent messages | Send without notification sound | Yes (`disable_notification`) | No | - |
| 1.2.5 | Edit-in-place | Update existing message instead of posting new one (dashboard URL) | Yes (`editMessageText`) | Yes (`chat.update`) | - |
| 1.2.6 | Pin messages | Pin important messages in topic/channel | Yes | Yes | - |
| 1.2.7 | Ephemeral messages | Message visible only to one user | No (not supported by Telegram) | Yes (`chat.postEphemeral`) | - |
| 1.2.8 | Thread replies | Reply in thread | Yes (reply_to_message) | Yes (thread_ts) | - |

---

## 2. Channel/Topic Management

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 2.1 | Create channel/topic | Create new forum topic or Slack channel for sessions | Yes (`createForumTopic`) | Yes (`conversations.create` via ChannelManager) | - |
| 2.2 | Find or create (dedup) | Prevent duplicate topics by name normalization | Yes (`findOrCreateForumTopic`) | Partial (ChannelManager has prefix-based naming) | - |
| 2.3 | Rename channel/topic | Edit topic/channel name | Yes (`editForumTopic`) | Yes (`conversations.rename`) | - |
| 2.4 | Close/archive | Close topic or archive channel | Yes (`closeForumTopic`) | Yes (`conversations.archive`) | - |
| 2.5 | Auto-join channels | Bot automatically joins new channels | N/A (bot is always in forum) | Yes (dedicated mode, requires `channels:join` scope) | - |
| 2.6 | Invite users to channel | Invite authorized users to new channels | N/A | Yes (`conversations.invite`) | - |
| 2.7 | Topic emoji selection | Auto-select emoji based on topic name keywords (26 keyword sets) | Yes | No | - |
| 2.8 | Topic color/icon | Set topic icon color by purpose (system/job/session/info/alert) | Yes (TOPIC_STYLE constants) | No | - |
| 2.9 | Non-forum detection | Detect and warn if chat doesn't support topics | Yes | N/A (Slack always has channels) | - |
| 2.10 | Self-healing topics | Recreate deleted system topics (Lifeline, Dashboard) on restart | Yes | No | - |

---

## 3. Session Integration

### 3.1 Session-Channel Binding

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 3.1.1 | Channel-session registry | Bidirectional mapping persisted to disk | Yes (topicToSession/sessionToTopic) | Yes (channelToSession) | - |
| 3.1.2 | Session spawn on message | Auto-spawn Claude session when user sends message | Yes | Yes | - |
| 3.1.3 | Session resume | Resume previous session using stored UUID | Yes (TopicResumeMap) | Yes (channelResumeMap, 24h expiry) | - |
| 3.1.4 | Session resume UUID proactive save | Save UUID before session ends for next resume | Yes | Yes (v0.25.0: beforeSessionKill hook) | - |
| 3.1.5 | Message injection into live session | Inject subsequent messages via tmux send-keys | Yes (`injectTelegramMessage`) | Yes (tmux send-keys in server.ts) | - |
| 3.1.6 | Stuck session recovery | Kill stuck sessions and respawn on new message | No (injects anyway) | Yes (v0.24.29: kills and respawns) | - |
| 3.1.7 | Wait for Claude ready | Wait for Claude prompt before injecting | Yes (`waitForClaudeReady`) | Yes (15s timeout) | - |

### 3.2 Message Injection

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 3.2.1 | Image tag transformation | `[image:path]` → explicit read instruction for Claude | Yes | Yes | - |
| 3.2.2 | Document tag transformation | `[document:path]` → explicit read instruction | Yes | Yes | - |
| 3.2.3 | Voice tag transformation | `[voice] transcript` handling | Yes | N/A (voice not supported yet) | - |
| 3.2.4 | Long message temp files | Messages >500 chars written to temp file, reference injected | Yes (`/tmp/instar-telegram/`) | Yes (v0.25.0: >500 chars → `/tmp/instar-slack/`) | - |
| 3.2.5 | Injection tag format | `[telegram:N "topic" from User (uid:123)]` | Yes | `[slack:CHANNEL_ID]` (no sender info) | - |
| 3.2.6 | Sender name sanitization | Strip control chars, collapse whitespace, neuter instruction-framing | Yes | Yes (v0.25.0) | - |
| 3.2.7 | Topic name sanitization | Lowercase ALL-CAPS patterns, strip injection attempts | Yes | No | - |
| 3.2.8 | Bracketed paste mode | Multi-line injection via terminal escape sequences | Yes | No (uses cat + tmux) | - |
| 3.2.9 | Idle prompt timer reset | Clear zombie-kill timer on message injection | Yes | Yes (v0.25.0: sessionManager.injectMessage) | - |

### 3.3 Session Context

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 3.3.1 | Thread history in context | Include recent messages when spawning/injecting | Yes (TopicMemory → JSONL fallback, last 50) | Partial (ring buffer last 30; vNEXT: falls back to `conversations.history` API when ring buffer is empty — prevents amnesia on spawn after restart) | - |
| 3.3.2 | Unanswered message count | Track messages awaiting response | Yes | Yes | - |
| 3.3.3 | Context file for session | Write context file to temp path for session to read | Yes (JSON format, `/tmp/instar-telegram/ctx-*.txt`) | Yes (human-readable thread history format matching Telegram, `/tmp/instar-slack/ctx-*.txt`) | - |
| 3.3.4 | Relay instructions in context | Include relay script usage in context file | Yes | Yes | - |
| 3.3.5 | Topic context hook | UserPromptSubmit hook that fetches history on `[telegram:N]` | Yes (`telegram-topic-context.sh`) | No (no equivalent hook) | - |

---

## 4. Acknowledgment & Delivery

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 4.1 | Immediate acknowledgment | Mandatory brief ack when receiving a message | Yes (CLAUDE.md instruction) | Yes (CLAUDE.md instruction) | - |
| 4.2 | Delivery confirmation | `✓ Delivered` message after injection | Yes (when adapter owns polling) | Yes (v0.25.0: ✅ reaction after injection) | - |
| 4.3 | Reaction on receipt | Add reaction emoji when message received | No | Yes (👀 eyes, then ✅ on complete) | - |
| 4.4 | Reaction on completion | Replace receipt reaction with completion | No | Yes (remove 👀, add ✅) | - |

---

## 5. Standby / Presence Proxy

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 5.1 | Tier 1 standby (20s) | Haiku summarizes what agent is doing | Yes | Yes (via synthetic ID bridge) | - |
| 5.2 | Tier 2 standby (2min) | Progress comparison since Tier 1 | Yes | Yes | - |
| 5.3 | Tier 3 standby (5min) | Sonnet assesses if agent is stuck | Yes | Yes | - |
| 5.4 | Standby cancellation on response | Cancel timer when agent responds | Yes (via onMessageLogged fromUser:false) | Yes (v0.24.26: /slack/reply fires synthetic event) | - |
| 5.5 | Platform isolation | Standby only fires for platform where user sent message | Yes | Yes (v0.24.25: removed Telegram→Slack mirroring) | - |
| 5.6 | Standby commands | `unstick`, `restart`, `quiet`, `resume` | Yes | Yes (v0.25.0: onStandbyCommand → PresenceProxy) | - |
| 5.7 | Silence duration | Suppress standby for 30min after `quiet` | Yes | Yes (v0.25.0) | - |
| 5.8 | Conversation history in standby | Multi-turn context in tiered messages | Yes | No (state not carried across tiers) | - |
| 5.9 | State persistence/recovery | Recover standby state after server restart | Yes (disk-persisted) | Yes (v0.25.0: channel map pre-populated on startup) | - |

---

## 6. Stall Detection & Recovery

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 6.1 | Stall tracking | Track injected messages, alert if no response within timeout | Yes (5min default) | Yes (v0.25.0: trackMessageInjection, 5min default) | - |
| 6.2 | LLM-gated stall alerts | Confirm stall with Haiku before alerting user (prevents false positives) | Yes | Yes (v0.25.4: intelligence provider wired in server.ts, fail-open) | - |
| 6.3 | Promise tracking | Detect "give me a minute" patterns, alert if not followed through | Yes (10min default) | Yes (v0.25.4: pendingPromises map, 10min default, routes.ts trackPromise) | - |
| 6.4 | Stall triage (StallTriageNurse) | LLM-powered diagnosis and recovery | Yes | Yes (v0.25.3: platform-agnostic callbacks) | - |
| 6.5 | Triage orchestrator | Advanced multi-step triage with diagnostic sessions | Yes | Yes (v0.25.3: synthetic channel ID mapping) | - |
| 6.6 | `/interrupt` command | Send Escape to unstick session | Yes | Yes (v0.25.0: !interrupt) | - |
| 6.7 | `/restart` command | Kill and respawn session | Yes | Yes (v0.25.0: !restart) | - |
| 6.8 | `/triage` command | Show triage status | Yes | Yes (v0.25.4: !triage via onGetTriageStatus callback) | - |
| 6.9 | Session death classification | Classify exit cause (quota, timeout, error) | Yes | Yes (v0.25.4: onClassifySessionDeath callback) | - |
| 6.10 | Context exhaustion fresh respawn | When session hits context window limit, kill and restart FRESH (no --resume), thread history bootstrapped as context | Yes | Yes (v0.27.1: fresh session spawned with ring buffer history + relay instructions; resume UUID cleared to prevent death loop; vNEXT: CONTINUATION header prepended + API fallback when ring buffer empty; compaction-recovery.sh re-injects last 20 Slack messages after compaction) | - |

---

## 7. Commands

| # | Command | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 7.1 | `/sessions` or `!sessions` | List running sessions with claim status | Yes | Yes | - |
| 7.2 | `/new` | Create new forum topic/channel | Yes | Yes (`!new`) | - |
| 7.3 | `/help` | Show available commands | Yes | Yes (`!help`) | - |
| 7.4 | `/claim` or `/link` | Bind session to topic/channel | Yes | Yes (v0.25.0: !claim) | - |
| 7.5 | `/unlink` | Unbind session from topic/channel | Yes | Yes (v0.25.0: !unlink) | - |
| 7.6 | `/interrupt` | Send Escape to session | Yes | Yes (v0.25.0: !interrupt) | - |
| 7.7 | `/restart` | Kill and respawn session | Yes | Yes (v0.25.0: !restart) | - |
| 7.8 | `/status` | Show adapter status | Yes | Yes (v0.25.0: !status via getStatus()) | - |
| 7.9 | `/flush` | Flush batched notifications | Yes | No | - |
| 7.10 | `/triage` | Show triage status | Yes | Yes (v0.25.4: !triage) | - |
| 7.11 | `/switch-account` or `/sa` | Switch active Claude account | Yes | No | - |
| 7.12 | `/quota` or `/q` | Show quota summary | Yes | No | - |
| 7.13 | `/login` | Seamless OAuth login | Yes | No | - |
| 7.14 | `/ack`, `/done`, `/wontdo`, `/reopen` | Attention item status commands | Yes | No | - |

---

## 8. Notification System

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 8.1 | Tiered notifications | IMMEDIATE, SUMMARY (30min), DIGEST (2h) | Yes | Yes (v0.25.0: all tiers route to attention channel) | - |
| 8.2 | Notification batcher | Aggregate non-urgent notifications | Yes | Partial (v0.25.0: all tiers delivered; no batching/deduplication logic) | - |
| 8.3 | Quiet hours | Suppress notifications during configured hours | Yes | No | - |
| 8.4 | Attention channel/topic | Dedicated channel for critical alerts | Yes (Agent Attention topic) | Yes (echo-agent-sys-attention) | - |
| 8.5 | Updates channel/topic | Dedicated channel for version updates | Yes (Agent Updates topic) | Yes (v0.25.0: echo-sys-updates auto-created) | - |
| 8.6 | Cross-platform alerts | Bridge alerts between platforms | Yes (Telegram ↔ WhatsApp) | No | - |

---

## 9. Prompt Gate / Relay

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 9.1 | Prompt detection | Detect permission/plan/question prompts in session output | Yes | Yes (shared PromptGate) | - |
| 9.2 | Inline keyboard relay | Send prompt with clickable buttons | Yes (Telegram inline keyboard) | Yes (Slack Block Kit buttons) | - |
| 9.3 | Text input relay | Accept free-text response for question prompts | Yes | No | - |
| 9.4 | Owner verification | Only session owner can respond to prompts | Yes (telegramUserId check) | Yes (Slack authorized users) | - |
| 9.5 | Relay timeout | Expire prompts after timeout (default 300s) | Yes (2x timeout with reminder) | No | - |
| 9.6 | Relay lease extension | Extend session idle timeout while prompt is active | Yes | No | - |
| 9.7 | First-use disclosure | Show privacy notice on first prompt relay | Yes | No | - |
| 9.8 | Callback registry | Token-validated button press handling (500 max, pruned) | Yes | Yes (via pendingPrompts map) | - |

---

## 10. Authentication & Multi-User

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 10.1 | Authorized user whitelist | Only process messages from authorized users | Yes (authorizedUserIds) | Yes (authorizedUserIds) | - |
| 10.2 | Fail-closed auth | Empty whitelist = reject all | Yes | Yes | - |
| 10.3 | Unknown user handling | Registration policy (admin-only/invite-only/open) | Yes | Partial (v0.25.0: ephemeral "not authorized" message; no registration flow) | - |
| 10.4 | Admin join request notification | Notify admin when unknown user tries to message | Yes | No | - |
| 10.5 | Invite code validation | Validate invite codes for open registration | Yes | No | - |
| 10.6 | Mini onboarding flow | Guided onboarding for new users | Yes | No | - |
| 10.7 | Unknown user rate limiting | 1 response per 60s per unknown user | Yes | N/A (silently drops) | - |

---

## 11. Workspace Modes (Slack-Specific)

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 11.1 | Dedicated mode | Auto-join channels, respond to all messages | N/A | Yes | - |
| 11.2 | Shared mode | No auto-join, respond only when @mentioned | N/A | Yes | - |
| 11.3 | @mention detection | Detect bot @mentions in messages | N/A | Yes | - |
| 11.4 | @mention stripping | Remove @mention from message before processing | N/A | Yes | - |
| 11.5 | Respond mode config | "all" or "mention-only" | N/A | Yes | - |

---

## 12. Message Logging & History

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 12.1 | JSONL message log | Append-only log of all messages | Yes (telegram-messages.jsonl) | Yes (slack-messages.jsonl) | - |
| 12.2 | Log rotation | Keep last 75K lines when exceeding 100K | Yes | Yes | - |
| 12.3 | Full-text search | Search log by query, topic, date range | Yes (via routes) | No (no search route) | - |
| 12.4 | Log stats | Total messages, file size | Yes (via routes) | Yes (via routes) | - |
| 12.5 | Ring buffer | In-memory recent messages per channel | Yes (via TopicMemory/JSONL) | Yes (50-message ring buffer; includes both user and bot messages; backfilled from `conversations.history` API on startup) | - |
| 12.6 | TopicMemory (SQLite) | Structured message storage with summaries | Yes (dual-write from onMessageLogged) | Yes (v0.25.0: dual-write via synthetic channel ID) | - |
| 12.7 | Topic auto-summarization | LLM-generated summaries on session end | Yes | No | - |

---

## 13. Lifeline (Persistent Guardian Process)

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 13.1 | Separate persistent process | Survives server crashes, maintains connection | Yes (TelegramLifeline) | No (SlackLifeline exists but limited) | - |
| 13.2 | Offline message queue | Queue messages to disk when server is down, replay on recovery | Yes | No | - |
| 13.3 | Queue replay | Drain and replay queued messages with retry logic (max 3 failures) | Yes | No | - |
| 13.4 | Server supervision | Monitor health, restart on crash, circuit breaker | Yes (ServerSupervisor) | No | - |
| 13.5 | `/lifeline status` | Show server health, queue size, restart attempts | Yes | No | - |
| 13.6 | `/lifeline restart` | Restart server immediately | Yes | No | - |
| 13.7 | `/lifeline reset` | Reset circuit breaker and restart | Yes | No | - |
| 13.8 | `/lifeline queue` | Show queued messages | Yes | No | - |
| 13.9 | `/lifeline doctor` | Spawn diagnostic Claude session for crash recovery | Yes | No | - |
| 13.10 | Dead man's switch | `/restart` routes to lifeline when server is down | Yes | No | - |
| 13.11 | Stale connection flush | Invalidate stale long-poll on startup (409 handling) | Yes | N/A (WebSocket) | - |
| 13.12 | Lock file management | Exclusive lock with zombie detection | Yes | No | - |
| 13.13 | Autostart self-healing | Validate/regenerate LaunchAgent/systemd on startup | Yes | No | - |

---

## 14. Dashboard Integration

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 14.1 | Dashboard URL broadcast | Auto-broadcast tunnel URL to dedicated topic/channel | Yes (Dashboard topic, edit-in-place) | Yes (broadcastDashboardUrl, update-in-place) | - |
| 14.2 | Dashboard PIN in broadcast | Include access PIN in broadcast message | Yes | Yes | - |
| 14.3 | Dashboard quick links | Format with clickable links to tabs | Yes | Yes | - |
| 14.4 | Skip unchanged URL | Don't re-send if URL hasn't changed | Yes | Yes | - |
| 14.5 | Platform badges on sessions | Show platform icon on dashboard session cards | N/A (dashboard feature) | Yes (Telegram/Slack/WhatsApp/Headless badges) | - |
| 14.6 | Platform dropdown for new sessions | Select platform when creating sessions from dashboard | N/A (dashboard feature) | Yes | - |

---

## 15. Connection Management

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 15.1 | Connection method | How the bot connects to the platform | Long-polling (HTTP) | Socket Mode (WebSocket) | - |
| 15.2 | Heartbeat/keepalive | Detect dead connections | Polling interval (2s default) | 30s liveness probe: checks WebSocket readyState every 30s; after 5min silence calls send() as liveness probe — throws → force reconnect, succeeds → reset silence timer and continue (vNEXT); (was: ping/pong with 10s pong timeout in v0.28.9; was 1-hour dead-silence check in v0.24.23) | - |
| 15.3 | Reconnection | Auto-reconnect on disconnect | Yes (exponential backoff) | Yes (exponential backoff, max 60s) | - |
| 15.4 | 409 conflict handling | Handle multiple polling instances | Yes (stale connection flush) | N/A | - |
| 15.5 | 429 rate limit handling | Respect platform rate limits | Yes (retry_after) | Yes (rate limit tiers per method) | - |
| 15.6 | Poll offset persistence | Persist position across restarts | Yes (lifeline-poll-offset.json) | N/A (WebSocket, no offset) | - |
| 15.7 | Too many connections handling | Handle platform connection limits | N/A | Yes (30s delay on too_many_websockets) | - |
| 15.8 | 401 error handling | Detect and recover from auth failures | First 401 → wait 30s, retry once (distinguishes transient auth blip from token revocation). Second 401 → fatal stop with `fatalReason: '401'` marker. `getStatus()` exposes `lastError`, `consecutivePollErrors`, `fatalReason`, `stoppedAt` for probe diagnostics (v0.28.36) | N/A | - |

---

## 16. Relay Scripts & Templates

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 16.1 | Reply script | Shell script for sessions to send responses | Yes (`telegram-reply.sh`) | Yes (`slack-reply.sh`) | - |
| 16.2 | CLAUDE.md relay section | Instructions for Claude on how to relay responses | Yes | Yes | - |
| 16.3 | Topic context hook | UserPromptSubmit hook for fetching thread history | Yes (`telegram-topic-context.sh`) | N/A | - |
| 16.4 | Channel context hook | Equivalent of topic context for Slack | No | Yes (`slack-channel-context.sh` — already existed) | - |

---

## 17. Content Validation & Safety

| # | Feature | Description | Telegram | Slack | WhatsApp |
|---|---------|-------------|----------|-------|----------|
| 17.1 | Outbound content validation | Validate messages against topic/channel purpose | Yes (validateOutboundContent) | No | - |
| 17.2 | Content classification | Classify message content by category | Yes (classifyContent) | No | - |
| 17.3 | Sentinel intercept | Real-time message filtering before routing (emergency stop, pause, redirect) | Yes | Yes (v0.25.0: emergency-stop, pause) | - |
| 17.4 | Input guard provenance | Check injection provenance and cross-topic blocking | Yes (injectTelegramMessage) | No | - |
| 17.5 | Outbound tone gate | Haiku-powered check before each reply — catches CLI commands, file paths, config syntax, and API endpoints leaking to users; 422 blocks delivery; fail-open on LLM error | Yes | Yes | Yes (iMessage too) |

---

## 18. API Routes

| # | Route | Method | Telegram | Slack | Notes |
|---|-------|--------|----------|-------|-------|
| 18.1 | `/telegram/reply/:topicId` | POST | Yes | - | Send response |
| 18.2 | `/telegram/topics` | GET | Yes | - | List topic mappings |
| 18.3 | `/telegram/topics` | POST | Yes | - | Create topic |
| 18.4 | `/telegram/topics/:topicId/messages` | GET | Yes | - | Fetch messages |
| 18.5 | `/telegram/search` | GET | Yes | - | Search log |
| 18.6 | `/telegram/log-stats` | GET | Yes | - | Log statistics |
| 18.7 | `/telegram/dashboard-refresh` | POST | Yes | - | Broadcast dashboard |
| 18.8 | `/internal/telegram-forward` | POST | Yes | - | Lifeline forward |
| 18.9 | `/internal/telegram-callback` | POST | Yes | - | Lifeline callback |
| 18.10 | `/slack/reply/:channelId` | POST | - | Yes | Send response |
| 18.11 | `/slack/channels` | GET | - | Yes | List channels |
| 18.12 | `/slack/channels` | POST | - | Yes | Create channel |
| 18.13 | `/slack/channels/:channelId/messages` | GET | - | Yes | Fetch messages |
| 18.14 | `/slack/search` | GET | - | Yes (already existed) | Search log |
| 18.15 | `/slack/log-stats` | GET | - | Yes | Log statistics |
| 18.16 | `/internal/slack-forward` | POST | - | Yes | Internal forward |
| 18.17 | `/attention` | CRUD | Yes | Yes (shared) | Escalation queue |

---

## Gap Summary

### Critical Gaps (Core UX Impact)

1. ~~**Voice message support** (1.1.4)~~ — **CLOSED v0.25.0**: Whisper transcription via Groq/OpenAI
2. ~~**Stall detection** (6.1-6.9)~~ — **CLOSED v0.25.0**: Full pipeline (track, detect, alert)
3. ~~**Slash commands** (7.4-7.14)~~ — **CLOSED v0.25.0**: !claim, !unlink, !interrupt, !restart, !status
4. **Lifeline** (13.1-13.13) — No persistent guardian process for Slack; connection lost on server crash
5. ~~**Long message temp files** (3.2.4)~~ — **CLOSED v0.25.0**: >500 chars → temp file
6. ~~**Sender/topic sanitization** (3.2.6-3.2.7)~~ — **CLOSED v0.25.0**: Sanitization at injection boundary

### Important Gaps (Reliability & Polish)

7. ~~**Delivery confirmation** (4.2)~~ — **CLOSED v0.25.0**: ✓ Delivered after injection
8. ~~**Standby commands** (5.6-5.8)~~ — **CLOSED v0.25.0**: unstick, quiet, resume, restart → PresenceProxy
9. ~~**Standby state persistence** (5.9)~~ — **CLOSED v0.25.0**: Channel map pre-populated on startup
10. ~~**Topic context hook** (16.3)~~ — **CLOSED**: Already existed (slack-channel-context.sh)
11. ~~**Session resume UUID proactive save** (3.1.4)~~ — **CLOSED v0.25.0**: beforeSessionKill hook
12. ~~**TopicMemory dual-write** (12.6)~~ — **CLOSED v0.25.0**: Slack → SQLite via synthetic ID
13. ~~**Content validation** (17.1-17.4)~~ — **CLOSED v0.25.0**: Sentinel intercept (emergency-stop, pause)

### Nice-to-Have Gaps

14. ~~**Notification batcher** (8.2)~~ — **CLOSED v0.25.0**: All tiers route to Slack attention channel
15. **Quiet hours** (8.3) — Not implemented for Slack (inherits from Telegram's batcher)
16. ~~**Unknown user handling** (10.3-10.7)~~ — **CLOSED v0.25.0**: Ephemeral "not authorized" message
17. **Topic emoji/color** (2.7-2.8) — N/A for Slack (channels don't have emoji/color)
18. ~~**Idle prompt timer reset** (3.2.9)~~ — **CLOSED v0.25.0**: Uses SessionManager.injectMessage
19. ~~**Search route** (18.14)~~ — **CLOSED**: Already existed (/slack/search)
20. ~~**Updates channel** (8.5)~~ — **CLOSED v0.25.0**: echo-sys-updates auto-created

### Remaining Open Gaps

- **Lifeline** (13.1-13.13) — Persistent guardian process for Slack. Significant architectural work.
- **Quiet hours** (8.3) — Low priority, can inherit from Telegram's global batcher config
- **Topic emoji/color** (2.7-2.8) — Platform limitation, not applicable

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-29 | Initial comprehensive audit |
| 2.0 | 2026-03-30 | v0.25.0: Closed 17/20 gaps. Voice, stall detection, commands, standby, TopicMemory, Sentinel, notifications, unknown user handling |
| 2.1 | 2026-03-30 | v0.25.2: Prompt Gate relay for Slack (Block Kit buttons); resume heartbeat covers Slack sessions; graceful shutdown saves Slack resume UUIDs; watchdog alerts route to Slack |
| 2.2 | 2026-03-30 | v0.25.3: StallTriageNurse (6.4), TriageOrchestrator (6.5), SessionRecovery, SessionMonitor all platform-agnostic — now cover Slack sessions |
| 2.3 | 2026-03-30 | v0.25.4: Closed 4 stall detection gaps — LLM-gated stall alerts (6.2), promise tracking (6.3), !triage command (6.8, 7.10), session death classification (6.9) |
| 1.1 | 2026-03-29 | v0.24.29: stuck session recovery (kill & respawn); Slack context file format changed from JSON to human-readable thread history; ring buffer now stores bot messages and backfills from Slack API on startup |
| 2.4 | 2026-04-01 | v0.25.10: reliability hardening (no parity row changes) — stuck rebase auto-recovery in GitSync + ServerSupervisor, AgentRegistry sync lock retries, wider slow-retry window (10s→60s), shell detection fix |
| 2.5 | 2026-04-01 | v0.26.0: Unified ConfigDefaults system (backend, no parity impact) |
| 2.6 | 2026-04-01 | v0.26.1: standalone file_shared events now fully handled (1.1.3) — downloads file, validates type, routes as image/voice/document. Requires files:read scope (already in standard setup). |
| 2.7 | 2026-04-01 | v0.26.2: SessionMonitor no longer sends unsolicited health messages when agent is idle waiting for user input (no parity row changes — behavior fix only) |
| 2.8 | 2026-04-02 | v0.26.3: reliability fixes — FeatureRegistry graceful degradation on sqlite3 failure, preflight native module auto-rebuild, smarter post-rebase pull strategy (no parity row changes) |
| 2.9 | 2026-04-02 | v0.26.4: (1) iMessage adapter shipped to main (native macOS iMessage via chat.db polling + imsg CLI, outbound safety layer); (2) Slack text snippet inlining — text-based files now inlined as code blocks (1.1.3 updated) |
| 2.10 | 2026-04-02 | v0.26.5: (1) Slack snippet HTML fallback fix — three-tier content resolution prevents agents from hallucinating on HTML error pages (1.1.3 updated); (2) Slack resume UUID heartbeat bug fix — UUIDs now correctly written to slack-channel-resume-map.json (internal fix, no parity row changes) |
| 2.11 | 2026-04-02 | v0.26.6: Telegram message injection reliability improvements — rawInject retry path with sleep design to prevent race conditions (no parity row changes — implementation reliability only) |
| 2.12 | 2026-04-03 | v0.26.7: session resume reliability hardening — (1) cross-topic UUID contamination fixed (proactive saves now use only authoritative claudeSessionId, never mtime fallback); (2) context exhaustion detection moved before health classification in SessionMonitor so exhausted sessions don't appear healthy (no parity row changes) |
| 2.13 | 2026-04-03 | v0.26.8: Slack inbound message enrichment — (1) link unfurls and rich previews now extracted from message.attachments[] and inlined into message text (1.1.1 updated); (2) file download reliability: prefers url_private_download, preserves auth header across CDN redirects via manual redirect following (1.1.3 updated); (3) files.info failures now logged instead of silently swallowed |
| 2.14 | 2026-04-03 | v0.26.11: (1) Slack scope validation at startup — adapter checks for files:read scope on connect, logs actionable warning if missing instead of silently failing at runtime; (2) Post/snippet extraction order corrected — files.info tried first (full content), event preview demoted to fallback (Post previews are truncated by Slack); (3) HTML stripping for Post content via files.info content field (1.1.3 updated) |
| 2.15 | 2026-04-04 | v0.27.0: Slack reliability hardening — no parity row changes. (1) `_validateScopes()` upgraded to `_selfVerify()`: now checks 8 required OAuth scopes (not just files:read) and performs live API capability tests (files.info call + download auth) at startup to catch misconfigured tokens early; (2) `reconnect()` public method added to SlackAdapter + SocketModeClient for force-reconnect; server wires this to sleep-wake events (2s post-wake delay) so WebSocket connections survive machine sleep; (3) SocketModeClient churn death spiral fix: `_backoffReconnect()` failure now schedules one final retry after MAX_BACKOFF instead of permanently dropping the connection. |
| 2.16 | 2026-04-04 | v0.27.1: (1) Slack context exhaustion recovery fixed — `respawnSessionFresh` now handles Slack channels (was silently a no-op); fresh session bootstrapped with ring buffer thread history + `slack-reply.sh` instructions; resume UUID cleared to prevent death loop (row 6.10 added); (2) system channel exclusion — `isSystemChannel()` gates dashboard/lifeline channels from session monitoring, message routing, and session registry; (3) PresenceProxy standby cancellation fix — `hasAgentRespondedSince` now checks `slack-messages.jsonl` for Slack topics (was only checking Telegram log); (4) SessionMonitor notification spam fix — persistent `notificationCooldowns` Map survives snapshot cleanup (dead sessions between polls were triggering repeated notifications) |
| 2.17 | 2026-04-06 | vNEXT: Slack session continuity hardening — (1) `getChannelMessagesWithFallback()` added: falls back to `conversations.history` API when ring buffer is empty (prevents spawn-time amnesia on restart before backfill completes) (3.3.1 updated); (2) CONTINUATION header prepended to Slack bootstrap messages (matches Telegram pattern); (3) `compaction-recovery.sh` now re-injects last 20 Slack channel messages after compaction (via `INSTAR_SLACK_CHANNEL` env var — set automatically on Slack session spawn) (6.10 updated); (4) supervisor CPU-load protection: `processAliveThreshold` raised to 6 failures (~60s) before restarting when process is alive but unresponsive (was 2 = ~20s); health check timeout 5s→8s — prevents false restart cascade under high CPU load; (5) `sessions.claudePath` and `sessions.tmuxPath` now user-configurable in `config.json` (previously always auto-detected) |
| 2.18 | 2026-04-08 | v0.28.9: Slack reliability hardening batch — (1) SocketModeClient fast heartbeat: 30s liveness probe replaces 1-hour dead-silence check; sends ping after 5min quiet, forces reconnect if no pong within 10s; also checks `readyState` directly each tick (row 15.2 updated); (2) missed message recovery: on WebSocket reconnect and server restart, SlackAdapter fetches `conversations.history` for channels with active sessions and replays messages that arrived during the outage; (3) system channel @mention passthrough: messages that @mention the bot in dashboard/lifeline channels are no longer silently dropped — authorized users can now get responses from system channels (was full exclusion, v0.27.1); (4) polling-based compaction-idle detection in SessionWatchdog: `checkCompactionIdle()` polls every watchdog cycle (30s), detects sessions that compacted and are at prompt with no active child processes, emits `compaction-idle` event to trigger triage orchestrator — fallback for PreCompact events which Claude Code doesn't reliably emit |
| 2.19 | 2026-04-08 | vNEXT: (1) SocketModeClient heartbeat simplified — removed ping/pong tracking (`pendingPing`, `lastPongAt`, `PING_TIMEOUT_MS`); liveness probe now uses `send()` throw detection: send() throws after 5min silence → force reconnect, send() succeeds → reset silence timer (avoids phantom ping timeouts; Slack Socket Mode ignores application-level pings) (row 15.2 updated); (2) `_forceReconnect` race condition fixed — sets `started=false` before closing WebSocket to prevent close handler from triggering a duplicate reconnect; (3) JobScheduler retry for transiently-skipped jobs: quota/gate skips now schedule exponential-backoff retries (1m, 5m, 15m, 30m, 1h, 2h) within the current cron window instead of waiting for the next cron window; (4) Private views accept optional `metadata` field for linking views to originating jobs/features: `{ "metadata": { "source": { "type": "job", "id": "slug" } } }` on `POST /view`; `GET /views?source=job:slug` filter added |
| 2.21 | 2026-04-14 | vNEXT: (1) Outbound tone gate — `MessagingToneGate` (Haiku-powered) now gates all four outbound reply routes (Telegram, Slack, WhatsApp, iMessage); blocks with HTTP 422 on detected CLI/path/config leakage; fail-open on LLM error; reply scripts surface issue + suggestion on 422 (row 17.5 added); (2) SessionWatchdog pipeline-aware stuck detection — `STDIN_CONSUMER_PATTERNS` gives pipe consumers (tail, grep, sort, jq, etc.) a 10-minute grace period; `hasActivePipelineSibling()` skips escalation when a consumer is waiting on an active upstream producer, preventing false-positive stall alerts during long builds |
| 2.20 | 2026-04-14 | v0.28.34: SessionWatchdog pane-root detection fix (no parity row changes) — `getClaudePid` previously assumed claude runs as a child of the tmux pane's shell; when instar spawns claude directly as the pane's root process, `pgrep -P pane_pid -f claude` returned null and `checkSession` early-exited, silently disabling both stuck-command detection AND compaction-idle detection for those sessions. Fix: (1) `getClaudePid` now checks the pane's own command via `ps -p panePid -o comm=` first and returns `pane_pid` directly when the pane IS claude; (2) `checkSession` now calls `checkCompactionIdle` even when `getClaudePid` returns null (defense-in-depth: compaction-idle path is tmux-output-based and its own process guard is null-safe). Net effect: compaction auto-resume from 2.18 now actually fires for instar-spawned sessions instead of being silently gated off. |
| 2.22 | 2026-04-14 | v0.28.36: (1) Intelligence provider priority reversed — Claude CLI subscription is now the DEFAULT (zero extra cost); Anthropic API is explicit opt-in via `intelligenceProvider: "anthropic-api"` in config.json; last-resort API fallback fires only when CLI unavailable and no explicit opt-in (server.ts); (2) Telegram 401 resilience — first 401 triggers a 30s pause and one retry (distinguishes transient auth blip from genuine token revocation); second 401 → fatal stop with `fatalReason: '401'` diagnostic marker (row 15.8 added); (3) CoherenceReviewer + CoherenceGate now accept optional `intelligence` parameter — reviewers route LLM calls through IntelligenceProvider when available (subscription-compatible), falling back to direct Anthropic API |
| 2.23 | 2026-04-15 | v0.28.43: signal/authority rework + respawn-race dedup (no parity row changes — architectural hardening only). (1) `checkMessagingTone()` replaced by `checkOutboundMessage()` — single authority aggregates structured signals from upstream detectors before calling `MessagingToneGate`; (2) `isJunkPayload()` and `OutboundDedupGate.check()` are now pure signals (`signals.junk`, `signals.duplicate`) fed into the tone gate — neither holds independent 422-block authority; (3) `ToneReviewResult.rule` constrained to B1..B9 enumerated IDs; LLM citations outside the set fail-open with `invalidRule: true` (fixes the rule-invention over-block observed 2026-04-15); (4) `SessionRecovery` in-flight reply capture — after a context-exhausted session is killed, polls topic history for any agent reply that lands before respawn; if found, embeds it in the recovery prompt so the fresh session knows not to duplicate it (replaces static 3s sleep with an active drain window); (5) `UpdateChecker` guard: falls back to `node` on PATH when `process.execPath` points to a deleted binary (Homebrew Node upgrade while server is running). |
| 2.24 | 2026-04-16 | v0.28.46: outbound-route duplicate-send fix — no parity row changes (behavior hardening only). (1) Per-route timeout overrides: `requestTimeout()` middleware gains an optional `perPathOverrides` map; outbound reply routes (`/telegram/reply`, `/telegram/post-update`, `/slack/reply`, `/whatsapp/send`, `/imessage/reply`, `/imessage/validate-send`) now use a 120s budget instead of the 30s default — the old budget was routinely exceeded by the LLM tone-gate + third-party API roundtrip, causing 408s while sends were still in flight; (2) HTTP 408 ambiguous-outcome handling in reply scripts: `telegram-reply.sh`, `slack-reply.sh`, and `whatsapp-reply.sh` now exit 0 on a 408 response and emit `AMBIGUOUS (HTTP 408): outcome unknown — verify in conversation before retrying` instead of exit 1, preventing agents from treating a probable-success as a failure and regenerating a duplicate; (3) `PostUpdateMigrator` auto-migrates existing shipped relay scripts to the 408-handling version on next `instar update` — detects the shipped header comment and absence of the `408` branch; custom user-modified scripts are preserved; (4) `loadRelayTemplate()` extracted in `init.ts` — relay scripts now loaded from canonical `src/templates/scripts/` templates at install and migration time, eliminating init-vs-migrator content drift. |
