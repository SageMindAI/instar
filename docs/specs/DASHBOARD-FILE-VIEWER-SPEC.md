# Dashboard File Viewer — Spec

> Integrated file browsing and editing as a first-class dashboard tab, accessible from any device.

**Status**: Implemented (all 3 phases complete)
**Author**: Dawn (with Justin's direction)
**Date**: 2026-03-12
**Related specs**: DASHBOARD_ACCESS_SPEC.md
**Review history**: 8-reviewer specreview (20260312-140339), 3-model crossreview (20260312-142248). v2 addressed specreview blockers. v3 addresses crossreview findings (PIN hashing, CSRF, optimistic locking).

---

## Problem

Users running Instar agents need to view and edit project files remotely — from their phone, a different machine, or while away from their workstation. Currently:

1. **No remote file access** — The only way to see file contents is to ask the agent to read them into chat, which is clunky and loses formatting
2. **No remote editing** — Editing a config file, CLAUDE.md, or skill definition requires SSH or physical access to the machine
3. **The dashboard is underutilized** — It currently only shows terminal sessions, despite being the primary remote interface that users already have bookmarked and PIN-authenticated
4. **Dawn Server has a file viewer, but it's standalone** — It's not integrated into the Instar experience and relies on Cloudflare Access rather than Instar's existing PIN auth

## Design Principles

1. **Seamless integration.** The file viewer should feel like a natural part of the dashboard, not a bolt-on feature. Same visual language, same auth, same mobile patterns.
2. **Mobile-first.** Most remote file access happens from a phone. Every interaction must work well on a 375px-wide screen with touch targets.
3. **Agent-aware.** The agent should be able to generate direct links to specific files and suggest the file viewer when relevant — "I updated your CLAUDE.md, you can review it here: [link]."
4. **Safe by default.** Read-only browsing out of the box. Editing is opt-in per directory. Destructive actions (delete, create) are out of scope for v1.
5. **Conversational access.** Users should be able to say "show me that file" in chat and get a clickable link to the dashboard viewer — not a wall of text pasted into the conversation.
6. **Zero configuration.** Works immediately with sensible defaults. Power users can customize allowed paths.

---

## User Experience

### Discovery: How Users Find the File Viewer

#### Via Dashboard Navigation

The dashboard header gains a tab bar. When the user opens their dashboard (from the pinned Telegram link or bookmarked URL), they see:

```
[Instar Logo] Instar Dashboard           [Connected]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Sessions (3)    Files    [WhatsApp]
```

Tapping "Files" switches to the file browser view. Tapping "Sessions" returns to the current terminal view.

#### Via Agent Link

The user asks their agent something like:

> "What's in my CLAUDE.md?"

The agent responds:

> Here's a summary of your CLAUDE.md: [summary]. You can view or edit the full file here:
> https://your-tunnel.dev/dashboard?tab=files&path=.claude/CLAUDE.md

One tap opens the dashboard directly to that file, already rendered and ready to edit.

#### Via Telegram Dashboard Topic

When the dashboard URL is broadcast to the Telegram Dashboard topic (per DASHBOARD_ACCESS_SPEC), it can optionally include:

```
Your agent dashboard is live:
https://tunnel.trycloudflare.com/dashboard

Quick links:
  Sessions: .../dashboard?tab=sessions
  Files: .../dashboard?tab=files
  CLAUDE.md: .../dashboard?tab=files&path=.claude/CLAUDE.md

PIN: 7291
```

### File Browser View

#### Desktop Layout (>768px)

```
┌──────────────────────────────────────────────────────┐
│  [Sessions (3)]  [Files]                  [Connected]│
├────────────────┬─────────────────────────────────────┤
│  SIDEBAR       │  FILE CONTENT                       │
│                │                                     │
│  📁 .claude/   │  .claude / CLAUDE.md                │
│    📁 agents/  │  ─────────────────────  [Edit]      │
│    📁 hooks/   │                                     │
│    📁 skills/  │  # CLAUDE.md                        │
│    📄 CLAUDE.md│                                     │
│  📁 docs/      │  This file provides essential       │
│  📁 config/    │  navigation for working with...     │
│                │                                     │
│                │                                     │
│                │                                     │
└────────────────┴─────────────────────────────────────┘
```

- **Left panel**: Directory tree with expandable folders. Shows only allowed directories.
- **Right panel**: File content with breadcrumb navigation. Markdown rendered, code syntax-highlighted.
- **Edit button**: Top-right of content panel. Switches to editor mode.

#### Mobile Layout (<=768px)

Same pattern as the terminal view — sidebar and content toggle visibility:

**State 1: Directory browser (full screen)**
```
┌──────────────────────┐
│ [Sessions] [Files]   │
├──────────────────────┤
│ 📁 .claude/          │
│   📄 CLAUDE.md       │
│   📁 agents/         │
│   📁 hooks/          │
│   📁 skills/         │
│ 📁 docs/             │
│ 📁 config/           │
│                      │
└──────────────────────┘
```

**State 2: File content (full screen, after tap)**
```
┌──────────────────────┐
│ ← .claude/CLAUDE.md  │
│                [Edit] │
├──────────────────────┤
│                      │
│ # CLAUDE.md          │
│                      │
│ This file provides   │
│ essential navigation │
│ for working with...  │
│                      │
│                      │
└──────────────────────┘
```

Back arrow returns to the directory browser. Same pattern as Sessions → Terminal navigation on mobile.

**State 3: Editing (full screen)**
```
┌──────────────────────┐
│ ← .claude/CLAUDE.md  │
│          [Save] [Cancel]│
├──────────────────────┤
│                      │
│ ┌──────────────────┐ │
│ │# CLAUDE.md       │ │
│ │                  │ │
│ │This file provides│ │
│ │essential navigat…│ │
│ │                  │ │
│ └──────────────────┘ │
│                      │
└──────────────────────┘
```

- Textarea fills the viewport. Font size 16px to prevent iOS zoom-on-focus.
- Save button is always visible (not hidden behind scroll).
- Cmd/Ctrl+S keyboard shortcut works on tablet/desktop.

### Editing Flow

1. User taps **Edit** on a file they're viewing
2. Content loads into a full-height textarea (raw content, not rendered markdown)
3. User makes changes
4. User taps **Save** — the file is written to disk immediately
5. A brief success toast appears: "Saved" (green, auto-dismisses after 2s)
6. View switches back to rendered mode with the updated content
7. If save fails, error toast appears: "Save failed: [reason]" (red, stays until dismissed)

### PIN Management UX

The dashboard PIN is the single gate to the file viewer (and all dashboard features). The current default is an auto-generated random PIN — functional but not memorable. For the file viewer to work seamlessly in conversation, PIN management needs to be a first-class part of the experience.

#### The Problem

When an agent sends a file link mid-conversation:

> "I've updated your CLAUDE.md. Review it here: https://tunnel.dev/dashboard?tab=files&path=.claude/CLAUDE.md"

The user taps the link. If they're not already authenticated, they hit the PIN screen. Now they need to:
1. Leave the browser
2. Open Telegram
3. Find the Dashboard topic
4. Copy the PIN
5. Go back to the browser
6. Paste the PIN

That's a 6-step friction path that breaks flow completely. On mobile, app-switching is especially painful.

#### The Solution: User-Chosen Memorable PIN

During initial setup (or on first dashboard access), the agent should prompt the user to choose a memorable PIN:

> **Agent** (during setup): "Your dashboard is ready! It's protected by a PIN. I've generated a random one (7291), but I'd recommend picking something you'll remember — you'll use it whenever you access your dashboard from a new device. Want to set your own PIN?"

> **User**: "Use 847291"

> **Agent**: "Done — your dashboard PIN is now 847291. You can change it anytime by asking me."

#### PIN Security Requirements

PINs are the single authentication gate for an internet-exposed service with file write access. They must be treated as passwords, not convenience codes.

| Requirement | Detail |
|-------------|--------|
| **Minimum length** | 6 digits. 4-digit PINs are exhaustible in under 3 minutes. |
| **Trivial pattern rejection** | Reject: all-same (000000), sequential (123456, 654321), common PINs (123123). Agent warns and asks for a different choice. |
| **Rate limiting** | Server-side: max 5 failed attempts per IP per 15-minute window. Return 429 with `retryAfter` header. After 20 cumulative failures, lock the PIN endpoint for 1 hour. |
| **Lockout notification** | On 5th failure, agent sends Telegram notification: "Someone failed the dashboard PIN 5 times from [IP]. Dashboard locked for 15 minutes." |
| **PIN rotation** | PIN does NOT rotate on server restart (this would break memorable PINs). Only rotates when user explicitly requests it. |
| **Broadcast policy** | PIN is broadcast to Dashboard topic ONCE on first setup. Never repeated in subsequent restart messages. Users who forget check the topic history or ask their agent. |

#### PIN Lifecycle

| Event | Behavior |
|-------|----------|
| **First install** | Agent generates random 6-digit PIN, immediately suggests user pick a memorable one |
| **User sets custom PIN** | Agent validates (min 6 digits, no trivial patterns), updates config, confirms change. Old sessions remain valid until they expire. |
| **User forgets PIN** | Agent can reset it: "I've reset your dashboard PIN to 847291. Want to pick a new one?" |
| **User asks for PIN** | Agent tells them directly: "Your dashboard PIN is 847291." This is safe — the chat is private between user and agent. |
| **PIN in file links** | Agent does NOT include the PIN in links. The memorable PIN stays in the user's head. |
| **First browser session** | User enters PIN once. Session persists via `httpOnly` cookie (not localStorage — see Security section). |
| **New device** | User enters their memorable PIN. No Telegram lookup needed. |

#### Why Not Include the PIN in Links?

Including the PIN in every link (e.g., `?pin=1234`) would eliminate the auth step entirely but:
- Links get shared accidentally (clipboard, screenshots, chat logs)
- Browser history stores URLs with query params
- The PIN becomes a password-in-URL anti-pattern

The right tradeoff: memorable PIN (entered once per device) + `httpOnly` cookie persistence. The user types their PIN once on their phone, then never again until the cookie expires.

#### Configuration

```typescript
interface DashboardPinConfig {
  /** Bcrypt hash of the dashboard PIN. NEVER store plaintext.
   *  Generated via: bcrypt.hash(pin, 12) on set/change.
   *  Verified via: bcrypt.compare(input, hash) on unlock. */
  pinHash: string;

  /** Whether the user has been prompted to set a custom PIN. */
  customPinOffered: boolean;
}
```

**PIN storage**: The PIN is NEVER stored in plaintext in `config.json`. On first setup or PIN change, the server hashes the PIN with bcrypt (cost factor 12) and stores only the hash. The `/dashboard/unlock` endpoint uses `bcrypt.compare()` for timing-safe verification. This replaces the earlier SHA256 approach — bcrypt is purpose-built for password hashing with built-in salting and configurable work factor.

The `customPinOffered` flag prevents the agent from repeatedly suggesting a custom PIN after the user has already declined or set one.

#### Agent Conversational Patterns

**Setup prompt** (first time, or after reset):
> "Your dashboard PIN is [PIN]. Want to pick something more memorable? You'll use it to access your dashboard from your phone."

**When user asks to see a file** (already has PIN set):
> "Here's the file: [link]"
> (No PIN mention — they know it or their browser remembers)

**When user is locked out**:
> "Your dashboard PIN is [PIN]. If you want to change it, just let me know."

**When user wants to change PIN**:
> "Done — PIN updated to [new PIN]. Your current browser sessions will stay logged in."

### What Users Cannot Do (v1)

- Create new files
- Delete files
- Rename or move files
- Edit binary files (images, etc.)
- Access files outside allowed directories

These constraints are intentional — the file viewer is for reviewing and tweaking, not full file management.

---

## Architecture

### Tab System

The dashboard gains a lightweight tab system in the header. No router needed — tabs toggle visibility of content containers using the same `display: none/flex` pattern already used for the terminal view.

```html
<!-- Tab bar (in header) -->
<nav class="tab-bar">
  <button class="tab active" data-tab="sessions">Sessions <span class="tab-count">3</span></button>
  <button class="tab" data-tab="files">Files</button>
</nav>

<!-- Tab containers (in main area) -->
<div class="tab-content" id="sessionsTab"> <!-- existing sidebar + terminal --> </div>
<div class="tab-content" id="filesTab" style="display:none"> <!-- new file viewer --> </div>
```

Tab state persists in URL query parameters for deep linking: `?tab=files&path=.claude/CLAUDE.md`. On load, parse `location.search` to determine initial tab and file. Query parameters are used instead of URL hash fragments because `?tab=files&path=...` requires manual fragment parsing (`location.search` returns empty for hash-embedded params), which is a common source of bugs. Standard query params work with `URLSearchParams` out of the box.

### File Browser Component

The file browser is a self-contained module within the dashboard HTML. It communicates with the server via REST endpoints (not WebSocket — file operations are request/response, not streaming).

#### Directory Tree (Left/Mobile-Full)

- Lazy-loaded: only fetches directory contents when expanded
- Root level shows configured allowed directories
- Folders are expandable/collapsible with chevron icons
- Files show appropriate icons based on extension (📄 generic, 📝 .md, ⚙️ .json, 📜 .ts/.js)
- Current file highlighted with active state

#### Content Panel (Right/Mobile-Full)

- **Markdown files**: Rendered via marked.js + **DOMPurify** (all HTML output sanitized before DOM insertion — see Security section). CDN with SRI hash.
- **Code files** (.ts, .js, .json, .yaml, .sh, etc.): Displayed in `<pre><code>` with syntax highlighting via highlight.js **common subset** (`highlight.min.js`, ~35KB — NOT the full 1.2MB bundle). **Size guard**: files >200KB or >2,000 lines render as plain monospace without highlighting (highlight.js hangs browsers on 3,000+ line files).
- **Other text files**: Raw display in monospace
- **Binary files**: "Preview not available" message with file size info

All CDN-loaded scripts MUST include Subresource Integrity (SRI) hashes:
```html
<script src="https://cdn.../marked.min.js"
  integrity="sha384-..." crossorigin="anonymous"></script>
<script src="https://cdn.../highlight.min.js"
  integrity="sha384-..." crossorigin="anonymous"></script>
<script src="https://cdn.../purify.min.js"
  integrity="sha384-..." crossorigin="anonymous"></script>
```

### API Endpoints

All endpoints require Bearer token authentication (existing middleware).

#### `GET /api/files/list?path=<dir>`

List directory contents. Returns entries with type, name, and size.

```json
{
  "path": ".claude/",
  "entries": [
    { "name": "agents", "type": "directory" },
    { "name": "CLAUDE.md", "type": "file", "size": 4523, "modified": "2026-03-12T20:00:00Z" }
  ]
}
```

- Only returns entries within allowed directories
- Rejects paths with `..` or absolute paths
- Directories list only immediate children (not recursive)

#### `GET /api/files/read?path=<file>`

Read file contents. Returns raw text content with metadata.

```json
{
  "path": ".claude/CLAUDE.md",
  "content": "# CLAUDE.md\n\nThis file...",
  "size": 4523,
  "modified": "2026-03-12T20:00:00Z",
  "editable": true
}
```

- `editable` flag indicates whether the file's directory is in the editable list
- Binary files return `{ "binary": true, "size": 45230 }` instead of content
- Large files (>1MB) return truncated content with a warning

#### `POST /api/files/save?path=<file>`

Save file contents. Requires file to already exist (no creation).

```json
// Request — must include expectedModified from the read response
{ "content": "# Updated CLAUDE.md\n\n...", "expectedModified": "2026-03-12T20:00:00Z" }

// Success response
{ "success": true, "path": ".claude/CLAUDE.md", "size": 4891, "modified": "2026-03-12T20:15:00Z" }

// Conflict response (409) — file was modified since the user loaded it
{ "error": "conflict", "message": "File was modified since you opened it", "serverModified": "2026-03-12T20:10:00Z", "yourExpected": "2026-03-12T20:00:00Z" }
```

- Only works for files in editable directories
- Returns 403 for read-only directories, blocked filenames, or never-editable paths
- Returns 404 for nonexistent files
- Returns 409 Conflict if `expectedModified` doesn't match the file's current `mtime` — the agent (or another device) modified the file since the user loaded it. Client shows: "This file was changed while you were editing. [Overwrite] [Reload] [View Diff]"
- Returns 413 for content exceeding `maxEditableFileSize` (default 200KB)
- Requires `X-Instar-Request: 1` header (CSRF protection)
- Response includes `modified` timestamp for the next edit cycle

**Optimistic concurrency**: The `expectedModified` field prevents silent overwrites when the agent and user edit the same file. The read endpoint returns `modified`, the client stores it, and the save endpoint compares it against the file's current `mtime`. This is especially important because agents frequently write to CLAUDE.md — the most likely file to be edited through the dashboard.

### Configuration

```typescript
interface FileViewerConfig {
  /** Enable the file viewer tab in the dashboard. Default: true */
  enabled: boolean;

  /** Directories available for browsing (relative to project root).
   *  Default: ['.claude/', 'docs/'] */
  allowedPaths: string[];

  /** Directories where editing is permitted (subset of allowedPaths).
   *  Default: [] — nothing editable without explicit opt-in.
   *  Users are prompted to enable editing during setup. */
  editablePaths: string[];

  /** Maximum file size to serve for reading (bytes). Default: 1048576 (1MB) */
  maxFileSize: number;

  /** Maximum file size for editing (bytes). Default: 204800 (200KB).
   *  Separate from maxFileSize because mobile textarea performance
   *  degrades above 100KB and becomes unusable above 500KB. */
  maxEditableFileSize: number;

  /** File patterns that are NEVER served, even within allowed directories.
   *  Default: ['.env', '.env.*', '*.key', '*.pem', '*.p12', 'secrets.*',
   *           'credentials.*', '*.secret', 'id_rsa', 'id_ed25519'] */
  blockedFilenames: string[];

  /** Paths that can NEVER be made editable regardless of config.
   *  Hardcoded, not user-configurable:
   *  ['.claude/hooks/', '.claude/scripts/', 'node_modules/'] */
  // readonlyPaths: string[];  // Enforced server-side, not in config
}
```

**Configuration in `config.json`:**

```json
{
  "dashboard": {
    "fileViewer": {
      "enabled": true,
      "allowedPaths": [".claude/", "docs/"],
      "editablePaths": []
    }
  }
}
```

**Default editable paths are empty.** During setup, the agent prompts:

> "Your file viewer is ready. Right now everything is read-only. Want me to enable editing for your CLAUDE.md and other config files?"

If the user says yes, the agent sets `editablePaths: ['.claude/CLAUDE.md', '.claude/config/']` — never the whole `.claude/` directory. Hooks and scripts are hardcoded as never-editable (see Security section).

Agents can update this configuration conversationally:

> **User**: "I want to be able to browse my src/ directory too"
> **Agent**: "Done — I've added `src/` to your dashboard file viewer. You can browse it now but editing is disabled for source files. Want me to enable editing too?"

The server enforces a hard boundary: `allowedPaths` and `editablePaths` can never escape the project root directory, regardless of what values are set in config. `path.resolve()` + `startsWith(projectRoot)` is the authoritative check.

### Security

#### Threat Model

**Attacker profile**: An external party who discovers the Cloudflare tunnel URL (which is public) and attempts to gain access to the dashboard. They have no prior knowledge of the PIN.

**Assets at risk**: Project files within allowed directories. The highest-value targets are agent configuration files (CLAUDE.md, skill definitions) which influence agent behavior.

**Accepted risks**: A user who voluntarily shares their PIN. A compromised machine (if the machine is compromised, the dashboard is the least of the problems). The spec does NOT protect against a compromised Cloudflare account.

**Security invariant**: A PIN compromise must never result in arbitrary code execution. This means executable paths (hooks, scripts) are never editable through the dashboard.

#### Path Traversal Protection

Defense-in-depth with 6 layers, applied to every file operation:

1. `path.normalize()` to resolve `.` and redundant separators
2. Reject paths starting with `/` (absolute)
3. Reject paths containing `..`
4. Verify against `allowedPaths` prefix list
5. **Symlink resolution** (mandatory order):
   a. `fs.lstat()` to detect whether the path is a symlink
   b. `fs.realpath()` to fully dereference all symlinks in the chain
   c. Post-dereference `startsWith(projectRoot)` check as the **authoritative gate**
   d. Post-dereference re-check against `allowedPaths` (a symlink within `.claude/` pointing to `/etc/` must be rejected)
6. Check against `blockedFilenames` patterns

**Required test case**: A symlink within an allowed directory pointing outside the project root MUST return 403. This test must exist before Phase 1 ships.

**Precedent**: CVE-2025-53109 (Anthropic Filesystem MCP server) exploited exactly this gap — symlinks were followed before the path check. The fix is the `fs.realpath()` → post-dereference validation order specified above.

#### Read-Only by Default

`editablePaths` defaults to `[]` — nothing is editable without explicit opt-in. When the user opts in, the agent adds specific safe paths (CLAUDE.md, config files), never entire directories containing executable code.

**Never-editable paths** (hardcoded server-side, not configurable):
- `.claude/hooks/` — Hook scripts execute on every tool call
- `.claude/scripts/` — Utility scripts invoked by agent
- `node_modules/` — Dependency code
- Any file with execute permission (`mode & 0o111`)

Writing to these paths via the save endpoint always returns 403, regardless of `editablePaths` config.

#### Blocked Filenames

Files matching these patterns are never served (read or write), even within allowed directories:

```
.env, .env.*, *.key, *.pem, *.p12, secrets.*, credentials.*,
*.secret, id_rsa, id_ed25519, *.pfx, *.jks, token.json
```

This prevents accidental exposure of credentials that may exist adjacent to config files within allowed directories.

#### HTML Sanitization (XSS Prevention)

All rendered content is sanitized before DOM insertion:

1. **Markdown**: `marked.js` output is passed through **DOMPurify** before `innerHTML` assignment. Never insert raw marked output directly.
2. **Code**: `highlight.js` output is passed through DOMPurify.
3. **CSP header**: The dashboard sets `Content-Security-Policy: script-src 'self' cdn.jsdelivr.net cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net`. No `unsafe-eval`, no inline scripts except the dashboard's own `<script>` block (via nonce).

**Why this matters**: CLAUDE.md and other config files are user-editable. A malicious markdown file containing `<script>` tags would execute in the viewer context without sanitization, enabling auth token theft.

#### Authentication & Session Management

1. **PIN → token exchange**: User enters PIN at `/dashboard/unlock`. Server validates via `bcrypt.compare(input, storedHash)` (timing-safe by design) and returns a session token.
2. **Token storage**: The token is set as an **`httpOnly` cookie** with `Secure`, `SameSite=Strict`, and a 24-hour expiry. NOT stored in `localStorage` (which is accessible to JavaScript and vulnerable to XSS exfiltration).
3. **Token validation**: All `/api/files/*` endpoints check the cookie. WebSocket connections continue using the query parameter token (existing pattern).
4. **Session expiry**: 24 hours. User re-enters PIN on expiry. **Session expiry during active edit**: If the cookie expires while a user is editing a file, the save will fail with 401. The client MUST detect this, stash the unsaved content to `sessionStorage`, show the PIN prompt, and restore the editor content after re-authentication. This prevents data loss on long editing sessions.

Using `httpOnly` cookies means that even if an XSS vulnerability exists (despite DOMPurify), the attacker cannot steal the session token via JavaScript.

#### CSRF Protection

With `httpOnly` cookies, the browser auto-attaches credentials to every request — including cross-origin requests initiated by malicious pages. The `SameSite=Strict` cookie attribute is the primary CSRF mitigation: it prevents the browser from sending the cookie on any cross-site request (including top-level navigations from external links).

As defense-in-depth, all state-mutating endpoints (`POST /api/files/save`) also require a custom header:

```
X-Instar-Request: 1
```

The server rejects POST/PUT/DELETE requests without this header. Simple HTML forms and `<img>` tags cannot set custom headers, so this blocks all non-JavaScript CSRF vectors. The dashboard's own `fetch()` calls include this header automatically.

**Why both**: `SameSite=Strict` handles 99% of cases. The custom header catches edge cases where browser `SameSite` enforcement is buggy or the cookie is somehow leaked. Belt and suspenders for an internet-exposed service with file write access.

#### Cache Control

All file viewer API responses include `Cache-Control: no-store` to prevent mobile Safari and other aggressive caching from serving stale file content. This is especially important for the edit flow — after saving, the user must see the updated content, not a cached version.

#### Rate Limiting

See PIN Security Requirements in the PIN Management UX section above. Summary: 5 attempts/IP/15min, lockout at 20 failures, Telegram notification on lockout.

#### Audit Log (Phase 2)

All file write operations are logged to an append-only JSONL file:

```json
{"timestamp":"2026-03-12T20:15:00Z","operation":"write","path":".claude/CLAUDE.md","sourceIp":"192.168.1.5","size":4891,"success":true}
```

Log file: `{projectRoot}/.instar/file-viewer-audit.jsonl`. Read operations are NOT logged (too noisy). The audit log enables forensic investigation after a security incident.

#### Binary File Safety

Binary files are detected by extension and by null-byte scan of the first 512 bytes. Binary files cannot be read or edited through the API.

#### Size Limits

- **Read**: Files larger than `maxFileSize` (default 1MB) are not served. Prevents loading large log files or database dumps.
- **Edit**: Files larger than `maxEditableFileSize` (default 200KB) cannot be edited. Mobile textarea performance degrades above 100KB and becomes unusable above 500KB.
- **Syntax highlighting**: Files larger than 200KB or 2,000 lines are displayed as plain monospace. highlight.js hangs browsers on 3,000+ line files.

### Agent Integration

#### Link Generation

The agent can generate deep links to specific files:

```typescript
// In agent context, when referencing a file
const fileUrl = `${dashboardUrl}?tab=files&path=${encodeURIComponent(relativePath)}`;
```

**Note on tunnel URL instability**: When using quick tunnels (non-named), the URL changes on every server restart. Agent-generated file links are session-scoped — they work while the current tunnel is active but become stale after a restart. The agent should never promise persistent URLs unless a named tunnel is configured.

This should be available as a utility in the agent's toolkit, so skills and prompts can reference it:

```
I've updated your CLAUDE.md with the new context.
Review it here: https://tunnel.dev/dashboard?tab=files&path=.claude/CLAUDE.md
```

#### Chat-to-Viewer Bridge

When a user asks to see a file, the agent should prefer linking to the viewer over dumping content into chat:

- **Short files** (<50 lines): Show inline AND provide viewer link
- **Long files** (>50 lines): Show summary + viewer link
- **Editing needed**: Always link to viewer — "You can edit it here: [link]"

This behavior is a prompt-level preference, not a hard gate. The agent can still paste file contents when it makes sense (e.g., showing a specific function, diffing two files).

#### File Change Notifications (Future)

When a file is saved through the dashboard, the agent could be notified via WebSocket:

```json
{ "type": "file_changed", "path": ".claude/CLAUDE.md", "source": "dashboard" }
```

This lets the agent react: "I see you updated CLAUDE.md — want me to reload my context?" Out of scope for v1, but the architecture supports it naturally.

---

## Implementation Plan

### Phase 1: Tab System + Read-Only File Browser + Security Foundation

**Scope**: Add tab navigation to dashboard. Implement file browsing and viewing. No editing. All security foundations in place.

1. **Tab bar in header** — "Sessions" and "Files" tabs with query param routing (`?tab=files`)
2. **File list API** — `GET /api/files/list` with auth, path validation, symlink resolution, and blocked filename filtering
3. **File read API** — `GET /api/files/read` with auth and full path validation chain
4. **Directory tree component** — Lazy-loaded, expandable, with file icons
5. **Content viewer** — Markdown rendering (marked.js + DOMPurify), code display (highlight.js common subset with 200KB/2000-line guard), breadcrumbs
6. **Mobile layout** — Tree/content toggle with back button, touch-friendly tap targets (min 44px)
7. **Deep linking** — `?tab=files&path=...` query param routing for direct file access
8. **Configuration** — `dashboard.fileViewer` in InstarConfig with defaults (`editablePaths: []`)
9. **Security** — DOMPurify on all rendered output, CSP headers, SRI hashes on CDN scripts, symlink resolution chain with unit test, blocked filenames, PIN rate limiting (5 attempts/IP/15min), `Cache-Control: no-store` on all responses
10. **Auth hardening** — `httpOnly` cookie (`Secure`, `SameSite=Strict`) for session token, bcrypt PIN hashing (never plaintext), 6-digit minimum, trivial pattern rejection, `X-Instar-Request` custom header for CSRF defense-in-depth
11. **Editable/read-only indicators** — Visual distinction shown in Phase 1 even though editing ships in Phase 2 (prevents confusing silent 403s when user taps Edit)
12. **Link generation utility** — Helper for constructing dashboard file URLs (moved from Phase 3 — this is the core UX differentiator and enables agent integration from day one)

**Deliverable**: Users can browse and read project files from any device via the dashboard. Agent can generate deep links to specific files.

### Phase 2: Inline Editing

**Scope**: Add editing capability to the file viewer. Separate security review recommended before implementation.

1. **File save API** — `POST /api/files/save` with editable-path enforcement, never-editable path check, `maxEditableFileSize` (200KB), optimistic concurrency (`expectedModified` → 409 Conflict), CSRF header requirement (`X-Instar-Request: 1`)
2. **Editor mode** — Toggle between rendered view and textarea editor
3. **Save/cancel UX** — Success/error toasts, keyboard shortcuts (Cmd/Ctrl+S)
4. **Unsaved-changes guard** — Intercept ALL exit paths: Cancel button, breadcrumb back arrow, mobile back gesture (`popstate`), AND `beforeunload` browser event. All must warn before discarding edits. On session expiry (401 from save), stash content to `sessionStorage`, show PIN re-auth, restore editor content after re-authentication.
5. **Mobile editing** — Full-screen textarea, iOS zoom prevention (16px font), `visualViewport` API for keyboard-aware layout (NOT `calc(100vh)` — broken on iOS Safari)
6. **Audit log** — Append-only JSONL log of all file write operations (timestamp, path, IP, size, success)
7. **Never-editable enforcement** — Server rejects writes to `.claude/hooks/`, `.claude/scripts/`, `node_modules/`, and files with execute permission

**Deliverable**: Users can edit agent configuration files from their phone with full security guardrails.

### Phase 3: Conversational UX + Polish

**Scope**: Make the agent aware of the file viewer and use it seamlessly in conversation.

1. **Chat-to-viewer preference** — Prompt-level guidance for when to link vs inline
2. **Dashboard URL broadcast update** — Include file viewer quick links in Telegram Dashboard topic (PIN broadcast only on first setup, not on restarts)
3. **Conversational config** — Agent can update `fileViewer` config when user requests path changes. Server enforces project root boundary regardless of config values.
4. **Conversational editing setup** — Agent prompts user to enable editing for specific safe paths during setup
5. **Tunnel URL awareness** — Agent frames links as session-scoped when using quick tunnels

**Deliverable**: The file viewer is a seamless part of the agent-user interaction, not a separate tool.

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| **File viewer disabled in config** | "Files" tab doesn't appear in dashboard |
| **No allowed paths configured** | Empty state: "No directories configured for viewing. Ask your agent to set up the file viewer." |
| **File deleted while user is viewing** | Save returns 404. Toast: "This file no longer exists." Return to directory listing. |
| **File modified externally while editing** | Optimistic concurrency: save includes `expectedModified` timestamp. If the file changed since load, server returns 409 Conflict. Client shows: "[Overwrite] [Reload] [View Diff]". |
| **Very large directory** | Lazy loading handles this naturally. Directories with >500 entries show first 500 + "N more..." |
| **Symlinks** | Resolved via `fs.lstat()` → `fs.realpath()` → post-dereference `startsWith()` check. Symlinks that escape allowed directories return 403. Required unit test: symlink within `.claude/` pointing to `/etc/passwd` must be rejected. |
| **Empty file** | Shown with "(empty file)" message. Editable if in editable path. |
| **Non-UTF8 files** | Detected and shown as binary (not editable). |
| **Concurrent edits from multiple devices** | Optimistic locking via `expectedModified`. Second saver gets 409 Conflict with option to overwrite, reload, or view diff. |
| **Dashboard accessed without tunnel** | File viewer works on `localhost` too — same as terminal sessions. |
| **Agent project has no .claude/ directory** | Default allowed paths that don't exist are silently skipped. Whatever exists is shown. |

---

## Mobile-Specific Considerations

| Concern | Solution |
|---------|----------|
| **iOS zoom on input focus** | Font-size: 16px on all inputs and textareas (existing dashboard pattern) |
| **Touch targets** | Min 44px height for all tappable elements (directory items, buttons) |
| **Viewport management** | Editor textarea uses `window.visualViewport` API — NOT `calc(100vh - header)` which is broken on iOS Safari when the keyboard opens (the Save button gets hidden behind the keyboard). Listen to `visualViewport.resize` and `visualViewport.scroll` events, update container height dynamically. This is the only reliable cross-browser pattern for mobile editing. |
| **Copy file content** | Long-press to select works in rendered view. In code view, "Copy" button in header for one-tap copy |
| **Offline viewing** | Out of scope. Requires network connection (same as terminal view). |
| **Swipe navigation** | Consider swipe-right to go back to directory list (same gesture as iOS back). Stretch goal for v2. |
| **Orientation changes** | ResizeObserver reflows content. Tested in both portrait and landscape. |

---

## Visual Design

The file viewer follows the existing dashboard visual language exactly:

- **Colors**: Same CSS variables (`--bg`, `--bg-panel`, `--border`, `--accent`, etc.)
- **Typography**: Same system font stack, same size scale
- **Spacing**: Same padding patterns (16px panel padding, 8px element gaps)
- **Borders**: Same 1px `var(--border)` dividers
- **Active states**: Green accent for selected items (same as active session)
- **Dark theme**: Consistent with terminal-focused aesthetic

No new visual concepts. The file viewer should look like it was always part of the dashboard.

---

## Success Criteria

1. A user can browse and read files from their phone within 2 taps from the dashboard
2. A user can edit a CLAUDE.md file from their phone and see the change reflected immediately
3. The agent can generate a direct link to any viewable file (Phase 1)
4. Loading the file viewer on mobile takes <1 second (highlight.js common subset ~35KB, marked.js ~50KB, DOMPurify ~20KB)
5. The tab system works for future dashboard extensions (settings, logs, etc.)
6. Zero configuration required — works out of the box with sensible defaults (read-only)
7. A symlink within `.claude/` pointing to `/etc/passwd` returns 403 (unit test required)
8. A 1MB TypeScript file displays as plain monospace without hanging the browser
9. PIN brute-force from a single IP is blocked after 5 attempts within 15 minutes
10. No JavaScript can access the session token (httpOnly cookie)
