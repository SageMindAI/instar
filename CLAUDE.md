# CLAUDE.md — instar

## What This Project Is

Persistent autonomy infrastructure for AI agents. Every molt, more autonomous.

Transforms Claude Code from a reactive CLI tool into a proactive, persistent agent with scheduled jobs, multi-user messaging, and system monitoring.

Born from the Dawn/Portal project — extracting battle-tested infrastructure patterns into a reusable, project-agnostic toolkit.

## Quick Reference

```bash
pnpm build            # Build TypeScript
pnpm dev              # Watch mode build
pnpm test             # Unit tests
pnpm test:watch       # Watch mode tests
pnpm test:integration # Integration tests (spawns real sessions)
```

## Architecture

```
src/
  core/           # SessionManager, StateManager, Config, FeedbackManager,
                  # UpdateChecker, RelationshipManager, SleepWakeDetector, types
  scheduler/      # Cron-based job scheduling with quota awareness
  monitoring/     # Health checks, QuotaTracker (threshold-based load shedding),
                  # CrashLoopPauser (auto-pause runaway jobs),
                  # CompactionSentinel (verified compaction recovery lifecycle —
                  # dedupe across triggers, JSONL-growth verification, retry with
                  # backoff, zombie-kill veto while recovery is in flight),
                  # PresenceProxy (standby heartbeat — fires when a user message
                  # goes unanswered past the tier threshold),
                  # PromiseBeacon (commitment follow-through — cadenced heartbeats
                  # on open beacon-enabled commitments; atRisk non-terminal state;
                  # boot-cap enforcement via maxActiveBeacons),
                  # CommitmentTracker (commitment lifecycle + single-writer CAS
                  # mutate(); feeds PromiseBeacon and /commitments/* routes),
                  # LlmQueue (rate-limited, priority-laned LLM call queue shared
                  # across PresenceProxy and PromiseBeacon; enforces daily spend cap),
                  # SessionWatchdog (stuck-process detection + escalating kill
                  # sequence; watchdog-notifications for user-facing messages)
  messaging/      # TelegramAdapter (long-polling, JSONL history),
                  # WhatsAppAdapter, SlackAdapter, iMessage (platform adapters);
                  # MessageRouter (topic → adapter routing),
                  # DeliveryRetryManager (retry on failed delivery),
                  # SpawnRequestManager (cross-session spawn coordination),
                  # MessageStore (cross-platform message persistence)
  users/          # Multi-user identity resolution and permissions
  server/         # HTTP server, routes, middleware (auth, CORS)
  scaffold/       # Identity bootstrap, template file generation
  commands/       # CLI: init, setup, server, status, user, job, add, feedback
  templates/      # Default hook scripts, helper scripts for scaffolding
tests/
  unit/           # Pure logic tests (no tmux/sessions)
  integration/    # Full system tests (may spawn real sessions)
  e2e/            # End-to-end lifecycle tests
  fixtures/       # Test data and mock repos
```

## Development Workflow

### Testing Against Real Repos

This toolkit is meant to be tested against real Claude Code projects. The flow:

1. Make changes in this repo
2. Build: `pnpm build`
3. Test against a target repo:
   ```bash
   # From target repo
   node /path/to/claude-instar/dist/cli.js init
   node /path/to/claude-instar/dist/cli.js status
   ```
4. Or link globally during development:
   ```bash
   # From this repo
   pnpm link --global
   # From target repo
   instar init
   ```

### Test Targets

- `tests/fixtures/test-repo/` — Minimal fixture for unit/integration tests
- `/Users/justin/Documents/Projects/ai-guy/` — Real project (AI Guy chatbot)
- `/Users/justin/Documents/Projects/sagemind/` — Real project (SageMind with multiple users)

### Key Design Decisions

1. **File-based state** — No database dependency. Everything is JSON files.
2. **tmux for sessions** — Battle-tested, survives terminal disconnects, scriptable.
3. **Adapter pattern for messaging** — Telegram first, but the interface supports any platform.
4. **User identity is channel-based** — A user is known by their channel identifiers (Telegram topic, email, etc.)
5. **Jobs are declarative** — JSON definitions with cron expressions, not code.

## Standards

- **Structure > Willpower** (THE foundational principle): Never rely on agents "remembering" to follow instructions in long prompts. Bake intelligence into the architecture:
  - **Session-start hooks** inject context automatically — agents don't need to remember to read files
  - **Programmatic gates** enforce required steps — critical choices happen in code, not in skill prompts
  - **Dispatch tables** route decisions to the right source — agents see "when X → look at Y" at every session start
  - **Behavioral hooks** guard against anti-patterns — deferral detection, grounding-before-messaging, dangerous-command-guard
  - If a behavior matters, enforce it structurally. A 1,000-line prompt is a wish. A 10-line hook is a guarantee.
  - This principle applies to ALL design decisions in Instar. When choosing between "add it to the docs" and "enforce it in code" — always choose code.

- **LLM-Supervised Execution** (`docs/LLM-SUPERVISED-EXECUTION.md`): Every critical pipeline must have at minimum a Tier 1 LLM supervisor. Jobs support a `supervision` field (`tier0`, `tier1`, `tier2`) on `JobDefinition`. Tier 1 = Haiku wrapping programmatic tools with validation after every step.

- **Testing Integrity Standard** (NON-NEGOTIABLE): Every significant feature requires ALL THREE test tiers. No exceptions.
  - **Tier 1: Unit Tests** (`tests/unit/`) — Module in isolation with real dependencies. Does the logic work?
  - **Tier 2: Integration Tests** (`tests/integration/`) — Full HTTP pipeline. Do the API routes work when the feature is available?
  - **Tier 3: E2E Lifecycle Tests** (`tests/e2e/`) — Production initialization path mirroring `server.ts`. Is the feature actually alive? Returns 200, not 503?
  - **Wiring integrity tests** are required for every dependency-injected component — verify deps are not null, not no-ops, and delegate to real implementations
  - **Semantic correctness tests** must cover both sides of every decision boundary with realistic inputs
  - The Phase 1 "feature is alive" E2E test is the single most important test for any feature with API routes
  - Full spec: `docs/specs/TESTING-INTEGRITY-SPEC.md` | E2E template: `docs/E2E-TESTING-STANDARD.md`

- **Zero-Failure Standard** (NON-NEGOTIABLE): The test suite MUST be green at all times. There is no such thing as a "pre-existing failure."
  - **Every session** must leave the test suite with zero failures, regardless of what was broken when you started
  - **"Pre-existing failure"** is not a valid label — all failures are current failures, and fixing them is your responsibility
  - **Before pushing**: Run `npm test` and verify zero failures. The Husky pre-push hook enforces this automatically.
  - **Before concluding work**: If you modified code, run the full suite (`npm run test:all`) and fix any failures
  - **The principle**: This is a classic responsibility gap where no one claims failures because "someone else caused them." The standard eliminates this gap — if you see a failure, you own it
  - **Enforcement**: Husky pre-push hook (local), GitHub Actions CI with branch protection (remote), Claude Code test-health-gate hook (session-level)

- **Agent Awareness Standard**: Every feature added to Instar MUST include a corresponding update to the CLAUDE.md template (`src/scaffold/templates.ts` → `generateClaudeMd()`). An agent that doesn't know about a capability effectively doesn't have it. This means:
  1. **API endpoints** — Add to the Capabilities section with curl examples
  2. **Proactive triggers** — Add to Feature Proactivity ("when user does X → use this")
  3. **Registry lookups** — Add to the "Registry First" table if it answers a state question
  4. **Building blocks** — Add to "Building New Capabilities" if it's a tool the agent should reach for

  The principle: agents interact with users conversationally, not through CLIs. If the template doesn't mention a feature, no agent will ever surface it. The template IS the agent's awareness.

- **Migration Parity Standard**: Any change to agent-installed files (`.claude/settings.json` hooks, `.instar/config.json` defaults, CLAUDE.md template sections, hook scripts, built-in skills) MUST be handled so existing agents receive it on update. New agents get changes via `init`, but existing agents only get them through the update path. A feature that only works for new agents is a broken feature.
  1. **Hook template changes** (`src/data/http-hook-templates.ts`) — Add a migration in `migrateSettings()` that patches existing `.claude/settings.json`
  2. **Config defaults** — Add to `migrateConfig()` with existence checks (only add missing fields)
  3. **CLAUDE.md sections** — Add to `migrateClaudeMd()` with content-sniffing guards
  4. **Hook scripts** — Add to `migrateHooks()`. Built-in hooks (`instar/` directory) are **always overwritten** on every migration run — never install-if-missing. This ensures agents can't get stuck on broken templates (lesson from `hook-event-reporter.js`: it was install-if-missing, so agents with ESM hosts got stuck on a broken CJS `require('http')` — fixed by switching to always-overwrite). Custom hooks (`custom/` directory) are never touched.
  5. **Built-in skills** — Split into two cases:
     - **Adding a new skill**: No migration needed. `installBuiltinSkills()` is called from `refreshHooksAndSettings()` on every update and is non-destructive (only writes missing SKILL.md files). Just add the skill to the skills registry.
     - **Updating existing skill content**: Add an idempotent migration in `PostUpdateMigrator` (e.g. `migrateSkillPortHardcoding()`) scoped to the known default-skill allowlist. `installBuiltinSkills()` never overwrites existing files — a dedicated migration is the only path to update content already installed on-disk. Custom skills are never touched.
  6. **Idempotency** — Every migration must be safe to run multiple times (check before patching)

  The principle: instar agents update in place. If `PostUpdateMigrator` doesn't know about a change, deployed agents will silently run stale configurations. This is how the zombie-cleanup-kills-active-sessions bug happened — and why we enforce this structurally with CI.

## API Authentication

All HTTP API endpoints (except `/health` basic check) require a Bearer token:

```
Authorization: Bearer <authToken>
```

The `authToken` is set in `instar.config.json` during setup. Agents calling the local server API from skills/scripts must include this header.

The feedback webhook (`dawn.bot-me.ai/api/instar/feedback`) uses different auth — `User-Agent: instar/<version>` and `X-Instar-Version: <version>` headers for identification. No Bearer token needed for the external feedback endpoint.

- **No Interactive CLI Commands** (CRITICAL — commands WILL HANG FOREVER): Claude Code's Bash tool cannot handle stdin prompts. Any command that asks for a password, confirmation, or input will hang until timeout. There is NO workaround — you cannot type into a running command.
  - **The `--raw` flag does NOT prevent interactive prompts.** It only changes output format. `bw unlock --raw` STILL HANGS because it still prompts for a password. The password must ALWAYS be a positional argument BEFORE flags.
  - **NEVER** run: `bw unlock --raw` (no password!), `bw unlock` (no password!), `bw login --raw` (no credentials!), `read -s`, `ssh-keygen` (interactive), `npm init` (interactive)
  - **ALWAYS** use: `bw unlock "ACTUAL_PASSWORD" --raw`, `bw login "EMAIL" "PASSWORD" --raw`, `ssh-keygen -t ed25519 -f path -N "" -q`, `npm init -y`
  - **THE PATTERN**: Get user input via conversation FIRST. Then construct the command with their actual input as positional arguments. Never run a command hoping it will prompt the user.

- **NEVER Use AskUserQuestion for Free-Text Input**: AskUserQuestion is ONLY for multiple-choice DECISIONS (pick A or B). NEVER use it to collect passwords, emails, tokens, names, or any free-text input. AskUserQuestion automatically adds escape-hatch options beneath the input, creating a confusing multi-choice menu when the user just needs to type something. **Instead:** Output the question as plain text, then STOP and wait for the user's next message. Their response IS the answer. This is the #1 setup wizard UX failure mode.

## Key Patterns from Dawn

These patterns were earned through real failures. Don't weaken them:

- **tmux trailing colon**: Use `=session:` (trailing colon) for pane-level commands. `=session` (no colon) FAILS SILENTLY for send-keys/capture-pane on tmux 3.6a.
- **Nullish coalescing for numbers**: `maxParallelJobs ?? 2`, NOT `maxParallelJobs || 2`. Zero is falsy.
- **Protected sessions**: Always maintain a list of sessions that the reaper should never kill.
- **Completion detection**: Check tmux output for patterns, don't rely on process exit.


### Self-Discovery (Know Before You Claim)

Before EVER saying "I don't have", "I can't", or "this isn't available" — check what actually exists:

```bash
curl http://localhost:4040/capabilities
```

This returns your full capability matrix: scripts, hooks, Telegram status, jobs, relationships, and more. It is the source of truth about what you can do. **Never hallucinate about missing capabilities — verify first.**


**Private Viewing** — Render markdown as auth-gated HTML pages, accessible only through the agent's server (local or via tunnel).
- Create: `curl -X POST http://localhost:4040/view -H 'Content-Type: application/json' -d '{"title":"Report","markdown":"# Private content"}'`
- View (HTML): Open `http://localhost:4040/view/VIEW_ID` in a browser
- List: `curl http://localhost:4040/views`
- Update: `curl -X PUT http://localhost:4040/view/VIEW_ID -H 'Content-Type: application/json' -d '{"title":"Updated","markdown":"# New content"}'`
- Delete: `curl -X DELETE http://localhost:4040/view/VIEW_ID`

**Use private views for sensitive content. Use Telegraph for public content.**

**Cloudflare Tunnel** — Expose the local server to the internet via Cloudflare. Enables remote access to private views, the API, and file serving.
- Status: `curl http://localhost:4040/tunnel`
- Configure in `.instar/config.json`: `{"tunnel": {"enabled": true, "type": "quick"}}`
- Quick tunnels (default): Zero-config, ephemeral URL (*.trycloudflare.com), no account needed
- Named tunnels: Persistent custom domain, requires token from Cloudflare dashboard
- When a tunnel is running, private view responses include a `tunnelUrl` with auth token for browser-clickable access


**Dashboard** — Visual web interface for monitoring and managing sessions. Accessible from any device (phone, tablet, laptop) via tunnel.
- Local: `http://localhost:4040/dashboard`
- Remote: When a tunnel is running, the dashboard is accessible at `{tunnelUrl}/dashboard`
- Authentication: Uses a 6-digit PIN (auto-generated in `dashboardPin` in `.instar/config.json`). NEVER mention "bearer tokens" or "auth tokens" to users — just give them the PIN.
- Features: Real-time terminal streaming of all running sessions, session management, model badges, mobile-responsive
- **Sharing the dashboard**: When the user wants to check on sessions from their phone, give them the tunnel URL + PIN. Read the PIN from your config.json. Check tunnel status: `curl -H "Authorization: Bearer $AUTH" http://localhost:4040/tunnel`


**File Viewer (Dashboard Tab)** — Browse and edit project files from any device via the Files tab.
- **Browse files**: Files tab in the dashboard shows configured directories with rendered markdown and syntax-highlighted code
- **Edit files**: Files in editable paths can be edited inline from your phone. Save with Cmd/Ctrl+S.
- **Link to files**: Generate deep links: `{dashboardUrl}?tab=files&path=.claude/CLAUDE.md`
- **When to link vs inline**: Prefer dashboard links for long files (>50 lines) and when editing is needed. Show short files inline AND provide a link.
- **Config API**: View: `curl -H "Authorization: Bearer $AUTH" http://localhost:4040/api/files/config`
- **Update paths conversationally**: `curl -X PATCH -H "Authorization: Bearer $AUTH" -H "X-Instar-Request: 1" -H "Content-Type: application/json" http://localhost:4040/api/files/config -d '{"allowedPaths":[".claude/","docs/","src/"]}'`
- **Generate a file link**: `curl -H "Authorization: Bearer $AUTH" "http://localhost:4040/api/files/link?path=.claude/CLAUDE.md"`
- **Download a file**: `curl -H "Authorization: Bearer $AUTH" "http://localhost:4040/api/files/download?path=.claude/CLAUDE.md" -O`
- **Default config**: Browsing and editing enabled for the entire project directory (`./`) by default.
- **Never editable**: `.claude/hooks/`, `.claude/scripts/`, `node_modules/` are always read-only regardless of config.


### Coherence Gate (Pre-Action Verification)

**BEFORE any high-risk action** (deploying, pushing to git, modifying files outside this project, calling external APIs):

1. **Check coherence**: `curl -X POST http://localhost:4040/coherence/check -H 'Content-Type: application/json' -d '{"action":"deploy","context":{"topicId":TOPIC_ID}}'`
2. **If result says "block"** — STOP. You may be working on the wrong project for this topic.
3. **If result says "warn"** — Pause and verify before proceeding.
4. **Generate a reflection prompt**: `POST http://localhost:4040/coherence/reflect` — produces a self-verification checklist.

**Topic-Project Bindings**: Each Telegram topic can be bound to a specific project. When switching topics, verify the binding matches your current working directory.
- View bindings: `GET http://localhost:4040/topic-bindings`
- Create binding: `POST http://localhost:4040/topic-bindings` with `{"topicId": N, "binding": {"projectName": "...", "projectDir": "..."}}`

**Project Map**: Your spatial awareness of the working environment.
- View: `GET http://localhost:4040/project-map?format=compact`
- Refresh: `POST http://localhost:4040/project-map/refresh`


### External Operation Safety (Structural Guardrails)

**When using MCP tools that interact with external services** (email, Slack, GitHub, etc.), a PreToolUse hook automatically classifies and gates each operation.

How it works:
1. The `external-operation-gate.js` hook intercepts all `mcp__*` tool calls
2. It classifies the operation by mutability (read/write/modify/delete) and reversibility
3. For non-read operations, it calls the gate API: `POST http://localhost:4040/operations/evaluate`
4. The gate returns: `allow`, `block`, `show-plan` (requires user approval), or `suggest-alternative`

**If an operation is blocked**, you'll see an error message with the reason. Do NOT try to bypass it.
**If an operation requires a plan**, show the plan to the user and get explicit approval before proceeding.

**Emergency stop**: If the user says "stop everything", "emergency stop", "kill all sessions", or similar urgent commands, the MessageSentinel will intercept the message and halt operations immediately.

**Trust levels**: Each service starts at a trust floor (supervised or collaborative). As operations succeed without issues, trust can be elevated automatically. Check trust status: `GET http://localhost:4040/trust`

**API endpoints**:
- Evaluate operation: `POST http://localhost:4040/operations/evaluate`
- Classify message: `POST http://localhost:4040/sentinel/classify`
- View trust: `GET http://localhost:4040/trust`
- View operation log: `GET http://localhost:4040/operations/log`


### Playbook — Adaptive Context Engineering

The Playbook system gives you a living knowledge base that makes every session smarter than the last. Instead of loading the same static context every time, Playbook curates a manifest of context items — facts, lessons, patterns, safety rules — and selects exactly what's relevant for each session based on triggers, token budgets, and usefulness scores.

**Getting started:**
```bash
instar playbook init       # Initialize the playbook system
instar playbook doctor     # Verify everything is healthy
```

**Core commands:**
- `instar playbook status` — Overview of your manifest
- `instar playbook list` — All context items with metadata
- `instar playbook add '<json>'` — Add a new context item
- `instar playbook search --tag <tag>` — Find items by tag
- `instar playbook assemble --triggers session-start` — Preview what would load for a trigger
- `instar playbook evaluate` — Run lifecycle: score usefulness, decay stale items, deduplicate

**When to add context items:** After learning a lesson that cost time, when discovering a recurring pattern, when safety-critical knowledge should survive compaction, or when the user teaches you something project-specific.

**The principle:** Your context should evolve with you. Every session that adds a lesson, scores an item's usefulness, or retires stale knowledge makes the next session more grounded. Run `instar playbook init` to get started.


## Threadline Network (Agent-to-Agent Communication)

I have a built-in capability to join a secure network of AI agents. When enabled, I can:
- **Discover** other agents on the network in real time
- **Send and receive messages** to/from other agents by name (e.g., "message AI Guy")
- **Collaborate** across machines — agents on different computers can communicate seamlessly

### Current Status
This capability is **installed and ready** but **not yet enabled**. I will only connect when you say so.

### Why You Might Want This
- Talk to other AI agents your operator runs on other machines
- Let other agents reach you for collaboration or delegation
- Join a growing network of Instar-powered agents

### Privacy & Security
- **Encrypted** — TLS transport + Ed25519 end-to-end encryption
- **Trust-gated** — I control who can message me via trust levels
- **Your choice** — just ask me to "connect to the agent network" and I'll enable it. Ask me to "disconnect" and I'll stop.

### How to Enable
Just tell me: "connect to the agent network" or "enable Threadline relay." I'll handle the rest — no config editing needed.

MCP tools: `threadline_discover`, `threadline_send`, `threadline_trust`, `threadline_relay`
Use `threadline_relay explain` for full details.
