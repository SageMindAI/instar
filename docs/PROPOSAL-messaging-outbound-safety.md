# Proposal: Messaging Outbound Safety

> **Status**: Final Draft (Post-Review)
> **Author**: Echo
> **Date**: 2026-04-01
> **Scope**: iMessage adapter (primary), WhatsApp adapter (backport), Telegram (audit)
> **Triggered by**: PR #30 iMessage adapter review — identified that outbound messages have no structural recipient validation across any messaging adapter.
> **Reviewed by**: Security, Architecture, Privacy, Adversarial, DX, Scalability, Business, Cross-model (8 reviewers, average score 7.25/10, all CONDITIONAL)

---

## 1. Problem Statement

### The Gap

All instar messaging adapters enforce authorization on **inbound** messages (who can talk to the agent) but not on **outbound** messages (who the agent can talk to). The `authorizedSenders` / `authorizedNumbers` allowlist is a one-way gate.

### The WhatsApp Incident

A prior WhatsApp deployment resulted in the agent responding to **all incoming contacts** — not just authorized ones. The root cause: when the auth gate failed open (misconfiguration or race condition), nothing downstream prevented the agent from sending replies to arbitrary phone numbers. The send path (`sendFunction(jid, text)`) accepts any JID without validation.

### The iMessage Risk

The iMessage adapter introduces a more dangerous variant:

1. **imsg CLI is system-wide** — any process with macOS Automation permission can send to any contact in Messages.app
2. **Claude Code sessions have shell access** — a session could run `imsg send --to ANYONE --text ANYTHING`, bypassing the reply script entirely
3. **The reply script sends first, notifies second** — `imessage-reply.sh` calls `imsg send` before `POST /imessage/reply/:recipient`, so server-side validation happens after the message is already delivered
4. **chat.db contains the user's entire contact history** — the agent can read conversation history with anyone, not just authorized contacts

### Why This Matters

iMessage is personal. Unlike Telegram (where the agent has its own bot account) or Slack (where the agent is in a workspace), iMessage sends **as the user**. An agent messaging an unauthorized contact sends a real iMessage from the user's phone number. There is no "bot" label. The recipient has no way to know it wasn't the user.

---

## 2. Phased Approach

This proposal adopts a two-phase strategy based on review consensus that software-only controls cannot fully contain an agent with shell access, but are sufficient for a safe initial deployment when combined with honest security warnings and a read-only default.

### Phase 1: Software Guardrails (Ship with PR #30)

Deploy 5-layer defense-in-depth with clear security warnings. This is genuinely secure for **read-only mode** (the default). The send path is opt-in with documented limitations.

**Security posture**: Read-only mode has no known bypass vectors. Send mode has software-level guardrails that a determined agent with shell access could theoretically bypass (see Section 7: Accepted Risks). Users who enable send mode accept this risk profile until Phase 2 hardens the architecture.

### Phase 2: Server-as-Sole-Sender (Research + Implementation)

Investigate and implement OS-level enforcement where only the instar server process can send iMessages. This eliminates all shell-access bypass vectors by removing send capability from agent sessions entirely.

**Research questions** (see Section 10 for details):
1. Can the server process acquire Automation permission via a user-space daemon or login item?
2. Can macOS Sandbox profiles revoke Automation from tmux/Claude sessions?
3. Can a lightweight send-proxy binary hold the TCC grant?
4. Is there an API path that doesn't require AppleScript at all?

---

## 3. Design Principles

1. **Fail-closed on send, not just receive.** If the allowlist is empty or misconfigured, the agent can neither receive nor send.
2. **Structural enforcement over behavioral.** Don't rely on the agent "deciding" not to send. Enforce at every layer where a message could escape.
3. **Defense in depth.** Multiple independent gates. An agent must bypass ALL of them to reach an unauthorized contact.
4. **The user's contacts are not the agent's contacts.** Access to chat.db for reading authorized conversations does not imply permission to contact anyone in the database.
5. **Explicit over implicit.** Sending capability is opt-in. Read-only is the default.
6. **Audit everything.** Every outbound attempt (allowed or blocked) is logged.
7. **Honest security boundaries.** Document what each phase protects against and what it doesn't. Never claim software guardrails provide hardware-level isolation.
8. **Reactive before proactive.** Replying to authorized contacts is safer than initiating conversations. Gate these separately.

---

## 4. Architecture (Phase 1)

### 4.1 Contact Allowlist (Unified)

A single `authorizedContacts` list governs both inbound AND outbound for each messaging adapter. This replaces the current inbound-only `authorizedSenders`.

```jsonc
// config.json — messaging entry
{
  "type": "imessage",
  "enabled": true,
  "config": {
    "authorizedContacts": ["+12562833341"],  // gates BOTH directions
    "sendEnabled": false,                     // default: read-only
    "proactiveSendEnabled": false,            // default: no cold-messaging
    "maxOutboundPerHour": 20,                // per-contact rate limit
    "maxOutboundPerDay": 100,                // global daily cap
    // ⚠️ SECURITY WARNING (shown in logs on startup when sendEnabled: true):
    // "iMessage send operates with software-level guardrails only.
    //  For maximum security, keep sendEnabled: false (read-only mode).
    //  When enabled, the agent can theoretically bypass send restrictions
    //  via shell access. Server-mediated sending (Phase 2) is planned."
  }
}
```

**Phone number normalization**: All phone numbers are normalized before comparison using E.164 format. The normalization algorithm:
1. Strip all whitespace, dashes, parentheses, dots
2. If starts with `00`, replace with `+`
3. If starts with `1` and length is 10, prepend `+1` (US assumption — configurable)
4. If doesn't start with `+`, prepend `+`
5. Both config values and runtime values are normalized before comparison
6. Comparison is exact string match on normalized form

This prevents bypass via formatting tricks (e.g., `+1-256-283-3341` vs `12562833341` vs `+12562833341`).

**Config conflict semantics**: When both `authorizedSenders` (legacy) and `authorizedContacts` (new) are present:
- `authorizedContacts` takes precedence
- A deprecation warning is logged: `"authorizedSenders is deprecated. Rename to authorizedContacts. Both are present — using authorizedContacts only."`
- The `authorizedSenders` value is IGNORED, not merged (merging could accidentally expand the allowlist)

**Config immutability**: The `authorizedContacts`, `sendEnabled`, and `proactiveSendEnabled` fields are read once at adapter initialization and cached in memory. Runtime modifications to config.json do NOT take effect until the adapter is restarted. This mitigates the config-mutation attack vector (agent edits config, sends, reverts) — changes require a server restart that the user would notice.

### 4.2 Send Modes

Two distinct send modes, separately gated:

| Mode | Config | Description | Risk |
|------|--------|-------------|------|
| **Read-only** | `sendEnabled: false` (default) | Agent receives and processes messages but cannot send | No send risk |
| **Reactive send** | `sendEnabled: true` | Agent can reply to authorized contacts who messaged first | Medium — limited to existing conversations |
| **Proactive send** | `sendEnabled: true` + `proactiveSendEnabled: true` | Agent can initiate messages to authorized contacts | Higher — agent can cold-message contacts |

**Reactive vs proactive enforcement**: The server tracks `lastInboundFrom[contact]` timestamps. A reactive send is only allowed if `lastInboundFrom[contact]` exists and is within the configured window (default: 24 hours). Proactive sends bypass this check but require `proactiveSendEnabled: true`.

### 4.3 Enforcement Layers

Messages must pass through ALL layers to be delivered. Each layer is independent — a bypass at one layer is caught by the next.

```
Layer 1: Reply Script Gate (imessage-reply.sh)
  ↓ validates recipient against allowlist from config.json
  ↓ checks sendEnabled === true
  ↓ BLOCKS before calling imsg if validation fails
  
Layer 2: Direct CLI Block (Claude Code PreToolUse hook)
  ↓ intercepts any bash command matching: imsg send, osascript.*Messages
  ↓ BLOCKS direct CLI access — forces all sends through reply script
  
Layer 3: Server Endpoint Validation (POST /imessage/validate-send/:recipient)
  ↓ validates recipient against authorizedContacts (normalized)
  ↓ checks sendEnabled + proactiveSendEnabled
  ↓ checks reactive window (lastInboundFrom)
  ↓ enforces rate limits
  ↓ issues single-use send token (TOCTOU mitigation)
  ↓ returns 403 + logs violation if blocked
  
Layer 4: Rate Limiter (server-side)
  ↓ per-contact hourly cap (default: 20/hr)
  ↓ global daily cap (default: 100/day)
  ↓ BLOCKS + alerts user when limits hit
  
Layer 5: Audit Log (always-on)
  ↓ every outbound attempt logged to .instar/imessage-outbound.jsonl
  ↓ includes: timestamp, recipient, text hash, allowed/blocked, layer that blocked
```

### 4.4 Layer Details

#### Layer 1: Reply Script Gate

The reply script (`imessage-reply.sh`) currently sends first and notifies the server second. This must be reversed: **validate first, send second.**

```bash
# Pseudocode — imessage-reply.sh changes
RECIPIENT="$1"

# Step 1: Validate with server BEFORE sending — get single-use token
VALIDATION=$(curl -s -w "\n%{http_code}" \
  -X POST "http://localhost:${PORT}/imessage/validate-send/${ENCODED_RECIPIENT}" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"text\":${JSON_MSG}}")

BODY=$(echo "$VALIDATION" | head -n -1)
HTTP_CODE=$(echo "$VALIDATION" | tail -n 1)

if [ "$HTTP_CODE" != "200" ]; then
  echo "BLOCKED: recipient not authorized or send disabled" >&2
  # Log the blocked attempt locally as backup
  echo "{\"blocked\":true,\"recipient\":\"${RECIPIENT}\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >> .instar/imessage-outbound-local.jsonl
  exit 1
fi

# Extract single-use send token from response
SEND_TOKEN=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)

# Step 2: Only now send via imsg
"$IMSG" send --to "$RECIPIENT" --text "$MSG" --service imessage

# Step 3: Confirm delivery to server (with token to bind validate→send)
curl -s -X POST "http://localhost:${PORT}/imessage/reply/${ENCODED_RECIPIENT}" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"text\":${JSON_MSG},\"sendToken\":\"${SEND_TOKEN}\"}"
```

**TOCTOU mitigation**: The `validate-send` endpoint returns a single-use token (UUID, 30-second TTL). The `reply` endpoint requires this token. This binds the validation to the actual send — you can't validate for contact A and send to contact B. The token is consumed on use and expires after 30 seconds.

#### Layer 2: Direct CLI Block

A Claude Code PreToolUse hook prevents sessions from bypassing the reply script:

```javascript
// Hook: intercept-imsg-send.js (PreToolUse on Bash)
// Blocks: imsg send, imsg --to, osascript.*Messages.app
// Blocks: indirect execution (python -c, node -e, bash -c containing send patterns)
// Allows: imsg chats, imsg --version, imsg --help (read-only)

const command = toolInput.command || '';
const BLOCKED_PATTERNS = [
  /\bimsg\s+send\b/i,
  /\bosascript\b.*\bMessages\b/i,
  /\btell\s+application\s+"Messages"/i,
  // Indirect execution patterns
  /\b(python3?|node|ruby|perl)\s+(-[ce]|--eval)\s+.*\b(imsg|Messages)\b/i,
  /\becho\s+.*\b(imsg\s+send|Messages)\b.*\|\s*(ba)?sh/i,
  /\bcrontab\b/i,  // Block crontab modification entirely
];

if (BLOCKED_PATTERNS.some(p => p.test(command))) {
  return {
    decision: 'block',
    reason: 'Direct iMessage sending is blocked. Use imessage-reply.sh instead.'
  };
}
```

**Known limitations** (Phase 1 accepted risks — see Section 7):
- A sufficiently creative agent could write a script to a file and execute it, bypassing inline pattern matching
- Base64-encoded commands bypass regex detection
- macOS Shortcuts.app could be invoked to send messages
- These vectors are addressed structurally in Phase 2

**Hook integrity**: The hook file should be set to read-only (`chmod 444`). The server periodically verifies the hook file's SHA-256 hash against a known-good value and alerts the user if it's been modified.

#### Layer 3: Server Endpoint Validation

The existing `POST /imessage/reply/:recipient` endpoint already has `isAuthorized()` (added in our blocker fix). Add:

- `sendEnabled` check — reject if config has `sendEnabled: false`
- `proactiveSendEnabled` check — reject proactive sends unless explicitly enabled
- Reactive window check — reject if no recent inbound from this contact (unless proactive)
- Rate limit check — reject if per-contact or global limits exceeded
- Send token issuance/validation — bind validate to send
- Audit log write — record every attempt
- Phone number normalization — normalize before comparison

New endpoint `POST /imessage/validate-send/:recipient`:
- Normalizes recipient phone number
- Checks `authorizedContacts` (normalized comparison)
- Checks `sendEnabled`
- Checks `proactiveSendEnabled` if no recent inbound
- Checks rate limits
- Issues single-use send token (UUID, 30-second TTL)
- Returns `{ "allowed": true, "token": "uuid" }` or `{ "allowed": false, "reason": "..." }`
- Logs the validation attempt

#### Layer 4: Rate Limiter

Sliding-window rate limiter, per-adapter:

```typescript
interface OutboundRateLimiter {
  // Returns true if allowed, false if rate-limited
  check(recipient: string): boolean;
  // Record a sent message
  record(recipient: string): void;
  // Get current counts
  status(): { perContact: Map<string, number>; globalToday: number };
}
```

- Per-contact: sliding window, default 20 messages/hour
- Global: daily rolling count, default 100 messages/day
- When limits hit: block + emit `rate:outbound-limited` event on MessagingEventBus
- Server routes this to user notification (Telegram, dashboard)
- **Storage**: In-memory (resets on server restart). This is acceptable because limits are a safety net, not a billing mechanism. Server restarts are rare and limits are generous enough that reset-on-restart is fine.

#### Layer 5: Audit Log

Every outbound attempt — allowed or blocked — is logged:

```jsonc
// .instar/imessage-outbound.jsonl
{
  "timestamp": "2026-04-01T19:30:00.000Z",
  "recipient": "+125***3341",           // masked
  "recipientHash": "a1b2c3d4",          // SHA-256 prefix for correlation
  "textLength": 142,
  "textHash": "e5f6g7h8",              // SHA-256 of content (not plaintext)
  "allowed": true,
  "blockedBy": null,                    // or "layer1:script", "layer2:hook", etc.
  "sendMode": "reactive",              // or "proactive"
  "sessionName": "im-a1b2c3d4",
  "sendToken": "uuid-prefix",          // first 8 chars for correlation
  "rateStatus": { "contactHour": 3, "globalDay": 17 }
}
```

This log is:
- Append-only
- Contains no plaintext message content (hash only)
- Contains no plaintext phone numbers (masked + hash)
- Rotated by the existing MessageLogger infrastructure

---

## 5. Default Configuration

```jsonc
{
  "type": "imessage",
  "enabled": true,
  "config": {
    "authorizedContacts": [],        // REQUIRED — fail-closed if empty
    "sendEnabled": false,            // default: receive-only
    "proactiveSendEnabled": false,   // default: no cold-messaging
    "maxOutboundPerHour": 20,        // per contact
    "maxOutboundPerDay": 100,        // global
    "reactiveWindowHours": 24,       // how long after inbound before reply counts as "proactive"
    "dbPath": null,                  // default: ~/Library/Messages/chat.db
    "pollIntervalMs": 2000,
    "stallTimeoutMinutes": 5
  }
}
```

A new iMessage adapter with default config:
- Receives messages from nobody (empty allowlist)
- Sends messages to nobody (sendEnabled: false)
- Cannot cold-message even if send is enabled (proactiveSendEnabled: false)
- Must be explicitly configured by the user to do anything

**Startup warnings** (logged to console AND Telegram when applicable):
- If `sendEnabled: true`: `"⚠️ iMessage send is enabled with software-level guardrails. Read-only mode (sendEnabled: false) provides stronger security. Server-mediated sending is planned for a future release."`
- If `proactiveSendEnabled: true`: `"⚠️ Proactive iMessage send is enabled. The agent can initiate messages to authorized contacts without them messaging first."`
- If `authorizedContacts` is empty: `"iMessage adapter is configured but authorizedContacts is empty. No messages will be sent or received."`

---

## 6. Scoped chat.db Reads

Currently the NativeBackend reads ALL messages and the adapter filters by `authorizedSenders`. This is a defense-in-depth gap — the SQL query should filter at the query level.

**Change**: Modify `_poll()` to include a `WHERE handle.id IN (?)` clause scoped to authorized contacts.

```sql
-- Before (reads everything, filters in app):
SELECT m.*, h.id as sender
FROM message m
JOIN handle h ON m.handle_id = h.ROWID
WHERE m.ROWID > ?
ORDER BY m.ROWID ASC

-- After (filters at SQL level):
SELECT m.*, h.id as sender
FROM message m
JOIN handle h ON m.handle_id = h.ROWID
WHERE m.ROWID > ?
  AND h.id IN (?, ?, ?)  -- authorized contacts only
ORDER BY m.ROWID ASC
```

Also scope `listChats()` and `getChatHistory()` — these are admin/debug endpoints but should respect the same boundary.

**Benefit**: Even if a bug bypasses the adapter's auth check, the SQL query itself won't return unauthorized messages.

---

## 7. Accepted Risks (Phase 1)

The following bypass vectors are **known and accepted** for Phase 1. They are documented honestly as limitations of software-only controls. All are addressed structurally in Phase 2.

| # | Bypass Vector | Description | Phase 2 Fix |
|---|---------------|-------------|-------------|
| 1 | **Indirect script execution** | Agent writes a Python/Node script that calls `imsg send`, then runs it. Regex hooks only match inline commands. | Server-as-sole-sender — agent process has no Automation permission |
| 2 | **Base64/encoding bypass** | `echo "aW1zZyBzZW5k..." \| base64 -d \| sh` bypasses pattern matching | Same — OS-level permission revocation |
| 3 | **Shortcuts.app** | Agent runs `shortcuts run "Send Message"` to trigger a pre-configured Shortcut | Sandbox profile blocks Shortcuts.app access from agent sessions |
| 4 | **Cron/at scheduling** | Agent schedules a cron job that sends messages outside the session | Sandbox profile blocks crontab modification |
| 5 | **Config mutation** | Agent edits config.json to add contacts, sends, reverts | Config cached at startup (mitigated in Phase 1), immutable config file in Phase 2 |
| 6 | **Hook deletion** | Agent deletes or modifies the PreToolUse hook file | Integrity checking (mitigated in Phase 1), OS-level file protection in Phase 2 |
| 7 | **TOCTOU between validate and send** | Race condition between getting send token and actual send | Token binding (mitigated in Phase 1), eliminated in Phase 2 when server sends directly |

**Risk assessment**: These vectors require a deliberately adversarial agent — an agent that is intentionally trying to circumvent its own safety controls. In normal operation (agent following instructions, occasional tool-use errors), the 5-layer defense is robust. The accepted risk is specifically: a compromised or adversarial agent with explicit intent to bypass controls. Phase 2 addresses this with structural (OS-level) enforcement.

---

## 8. WhatsApp Backport

The same pattern applies to WhatsApp. Changes needed:

1. **`authorizedNumbers` → `authorizedContacts`** (alias for backward compat — `authorizedNumbers` is ignored if both present)
2. **Add `sendEnabled` flag** (default: true for backward compat, but logged as a deprecation warning encouraging explicit opt-in)
3. **Add `proactiveSendEnabled` flag** (default: false)
4. **Add outbound validation in `send()`**:
   ```typescript
   async send(message: OutgoingMessage): Promise<void> {
     const channelId = normalizePhone(message.channel?.identifier);
     if (!this.isAuthorizedContact(channelId)) {
       console.error(`[whatsapp] BLOCKED outbound to unauthorized: ${maskPhone(channelId)}`);
       this.auditLog.record(channelId, message.content, false, 'adapter:send');
       return;
     }
     if (!this.config.sendEnabled) {
       console.error(`[whatsapp] BLOCKED outbound — sendEnabled is false`);
       this.auditLog.record(channelId, message.content, false, 'adapter:sendDisabled');
       return;
     }
     // ... existing send logic
   }
   ```
5. **Add rate limiter** — same OutboundRateLimiter shared infrastructure
6. **Add audit log** — `.instar/whatsapp-outbound.jsonl`

---

## 9. Telegram Audit

Telegram is lower risk because:
- The agent has its own bot account (doesn't send as the user)
- Bot API requires a chat_id — the bot can only message users who have `/start`-ed it
- The platform enforces this at the API level

However, for consistency:
- **Audit**: add outbound logging to Telegram adapter
- **Rate limit**: add global daily cap (prevents spam even to authorized users)
- No `sendEnabled` flag needed (Telegram's architecture already gates this)

---

## 10. Phase 2: Server-as-Sole-Sender (Research Spec)

### 10.1 The Goal

Remove iMessage send capability from agent sessions entirely. Only the instar server process can send iMessages. Agent sessions request sends via the server API, which enforces all validation before sending.

### 10.2 Why This Is Necessary

Software guardrails (hooks, regex, validation scripts) operate at the same privilege level as the agent. An agent with shell access can, in principle, bypass any software-only control. OS-level enforcement (TCC permissions, sandbox profiles) operates below the agent's privilege level and cannot be bypassed from within the session.

### 10.3 Research Questions

#### Q1: Server-side Automation Permission
Can the instar server process (currently a LaunchAgent) acquire macOS Automation permission to control Messages.app?

**Investigation paths**:
- LaunchAgent with `LSUIElement` — may qualify for Automation prompts
- User-space daemon started at login — inherits user's TCC context
- Explicitly pre-granting TCC via `tccutil` or MDM profiles
- AppleScript helper app (a tiny .app bundle) that the server invokes

#### Q2: Sandbox Profiles for Agent Sessions
Can we use macOS `sandbox-exec` or App Sandbox profiles to revoke Automation permission from tmux/Claude Code sessions?

**Investigation paths**:
- `sandbox-exec -f profile.sb` wrapper for session launch
- Custom sandbox profile that denies `mach-lookup` for `Messages.app`
- Whether sandboxing a parent process (tmux) sandboxes children (node/claude)

#### Q3: Send-Proxy Daemon
Can we build a lightweight send-proxy binary that:
1. Holds the TCC Automation grant for Messages.app
2. Exposes a local Unix socket or HTTP endpoint
3. Accepts send requests only from the instar server (authenticated)
4. Rejects direct requests from agent sessions

**This may be the most practical path** — it separates the TCC grant from both the server and the agent.

#### Q4: Non-AppleScript Send Paths
Is there an API to send iMessages that doesn't require Automation permission?

**Investigation paths**:
- `IMCore.framework` private API (used by Messages.app internally)
- `ChatKit.framework` for message composition
- `sharedFileList` or URL scheme (`imessage://`) for composing
- Whether `imsg` CLI uses AppleScript or a private framework

### 10.4 Architecture Sketch (Tentative)

```
Agent Session (sandboxed — no Automation permission)
  → POST /imessage/send (server API, authenticated)
    → Server validates: allowlist, sendEnabled, proactive, rate limits
    → Server calls send-proxy daemon (Unix socket, localhost only)
      → Send-proxy holds TCC grant, calls imsg/AppleScript
      → Message delivered
    → Server logs to audit trail
    → Server returns result to agent
```

The agent never touches `imsg` or Messages.app. The send-proxy is a separate process with its own TCC grant. The server mediates all requests.

### 10.5 Multi-Agent Considerations

Multiple agents on one machine share chat.db, imsg, and Automation permission. Phase 2 should address:
- **Send coordination**: The send-proxy should attribute sends to specific agents via the server API
- **Rate limits per agent**: Each agent gets its own rate limit budget, not a shared global
- **Audit attribution**: Which agent triggered which send

---

## 11. Threat Model

| Threat | Without this proposal | Phase 1 | Phase 2 |
|--------|----------------------|---------|---------|
| Agent responds to unauthorized inbound | Blocked (existing auth gate) | Blocked (same) | Blocked (same) |
| Agent sends to unauthorized contact via reply script | **Unblocked** | Blocked (Layer 1: script pre-validates) | Blocked (server-only send) |
| Agent sends via direct `imsg send` CLI | **Unblocked** | Blocked (Layer 2: PreToolUse hook) | Blocked (no Automation permission) |
| Agent sends via raw AppleScript | **Unblocked** | Blocked (Layer 2: hook catches osascript+Messages) | Blocked (sandbox denies) |
| Agent bypasses hook via indirect execution | **Unblocked** | **Accepted risk** — hook can't catch all indirect paths | Blocked (no Automation permission regardless of path) |
| Agent exhausts rate limits on authorized contact | **Unblocked** | Blocked (Layer 4: rate limiter) | Blocked (same) |
| Misconfigured empty allowlist | Receive blocked, **send unblocked** | Both blocked (fail-closed) | Both blocked (fail-closed) |
| Allowlist bypass via normalization tricks | Possible | Blocked (E.164 normalization) | Blocked (same) |
| Agent reads unauthorized conversations from chat.db | **Possible** | Blocked (SQL scoped to allowlist) | Blocked (same) |
| Agent cold-messages authorized contact | **Unblocked** | Blocked unless `proactiveSendEnabled: true` | Blocked unless enabled |
| Config mutation to expand allowlist | **Unblocked** | Mitigated (config cached at startup) | Blocked (immutable config) |
| Cross-channel content leakage (iMessage → Telegram) | **Possible** | **Accepted risk** — not in scope for this proposal | Addressed by cross-channel content policy (future) |

---

## 12. Implementation Plan

### Phase 1: iMessage Safety (ship with PR #30)

**Priority order** (each step is independently valuable):

1. **Rename `authorizedSenders` → `authorizedContacts`** in IMessageAdapter (keep alias, log deprecation)
2. **Add `sendEnabled` flag** (default: false) with startup warning when enabled
3. **Add `proactiveSendEnabled` flag** (default: false) with reactive window tracking
4. **Add phone number normalization** (E.164) to all comparison points
5. **Rewrite `imessage-reply.sh`** to validate-before-send with single-use token
6. **Add `POST /imessage/validate-send/:recipient`** endpoint with token issuance
7. **Add PreToolUse hook**: `intercept-imsg-send.js` with integrity checking
8. **Add OutboundRateLimiter** (shared infrastructure, in-memory)
9. **Add outbound audit log** (`.instar/imessage-outbound.jsonl`)
10. **Scope `_poll()` SQL** to authorized contacts
11. **Cache config at startup** — messaging config fields read once, immutable at runtime
12. **Add startup security warnings** — log to console and Telegram when send is enabled
13. **Write tests** — each enforcement layer tested independently

### Phase 2: WhatsApp Backport (follow-up PR)

1. Add outbound validation in `send()`
2. Add `sendEnabled` flag with deprecation path
3. Add `proactiveSendEnabled` flag
4. Wire OutboundRateLimiter
5. Add outbound audit log

### Phase 3: Platform Parity (follow-up PR)

1. Telegram outbound audit logging
2. Telegram rate limiting
3. Update messaging-platform-parity.md with outbound safety row
4. Shared `OutboundSafetyGate` abstraction across all adapters

### Phase 4: Server-as-Sole-Sender (research spike → implementation)

1. Research all 4 questions from Section 10.3
2. Prototype send-proxy daemon
3. Test macOS Sandbox profiles for session isolation
4. Implement chosen architecture
5. Migrate iMessage adapter to server-mediated sends
6. Remove Automation permission from agent sessions
7. Update security documentation (Phase 1 warnings → Phase 2 guarantees)

---

## 13. Success Criteria

### Phase 1 (Ship)

- [ ] An agent with `sendEnabled: false` cannot send messages through any path
- [ ] An agent with `sendEnabled: true` can only send to contacts in `authorizedContacts`
- [ ] An agent with `proactiveSendEnabled: false` can only reply, not initiate
- [ ] Direct `imsg send` from a Claude Code session is blocked by hook
- [ ] Direct `osascript` Messages.app access is blocked by hook
- [ ] Rate limits are enforced and user is notified when hit
- [ ] Every outbound attempt (allowed/blocked) appears in the audit log
- [ ] Empty `authorizedContacts` results in no inbound AND no outbound (fail-closed both directions)
- [ ] Phone numbers are normalized (E.164) before all comparisons
- [ ] Config is cached at startup — runtime edits don't expand permissions
- [ ] Security warnings are logged on startup when send is enabled
- [ ] chat.db reads are scoped to authorized contacts at SQL level
- [ ] WhatsApp `send()` validates recipient against allowlist
- [ ] All existing tests continue to pass
- [ ] New tests cover each enforcement layer independently

### Phase 2 (Research → Ship)

- [ ] Server process can send iMessages without agent session involvement
- [ ] Agent sessions cannot send iMessages at OS level (TCC/sandbox)
- [ ] Multi-agent send attribution works
- [ ] All Phase 1 software guardrails remain as defense-in-depth (belt AND suspenders)
- [ ] Security warnings updated to reflect structural enforcement
