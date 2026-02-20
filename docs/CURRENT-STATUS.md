# Instar — Current Status

> Quick reference for parallel work sessions. Updated: 2026-02-20

## What Is Instar

Persistent autonomy infrastructure for AI agents. Gives Claude Code a persistent body — server, scheduler, messaging, identity, self-modification. Named after arthropod developmental stages between molts.

## Secured Assets

- **npm**: `instar` (latest: 0.1.10) — https://www.npmjs.com/package/instar
- **GitHub**: https://github.com/SageMindAI/instar (under SageMindAI org)
- **Domain**: `instar.sh` (purchased; Astro landing page built in `site/`, awaiting deployment)
- **Source**: `/tmp/instar-src/` on workstation (cloned from GitHub)

## Current Version: 0.1.10

### What's Shipped
- Full CLI: `instar`, `instar init`, `instar setup`, `instar server start/stop`, `instar status`, `instar user/job add/list`, `instar add`, `instar feedback`
- Conversational setup wizard (launches Claude Code with setup-wizard skill)
- Classic setup wizard (inquirer-based fallback)
- Identity bootstrap with thesis explanation and initiative levels (guided/proactive/autonomous)
- Auto-install prerequisites (tmux, Claude Code) during setup
- npx-first flow with global install prompt after setup
- Auth-respecting sessions (removed forced OAuth — supports both API keys and subscription)
- Session management via tmux (spawn, monitor, kill, reap, timeout enforcement)
- Job scheduler with cron, priority levels, model tiering, quota awareness config
- Telegram integration (two-way messaging, topic-per-session, auto-detect chat ID, JSONL history, thread history for respawn, long message file indirection)
- Relationship tracking (per-person JSON files, cross-platform identity resolution, merge/delete)
- Health monitoring with periodic checks
- Feedback loop (FeedbackManager with webhook forwarding, retry, CLI command)
- Update checker (checks npm registry on startup)
- Auth middleware (Bearer token enforcement on all non-health endpoints)
- Sleep/wake detection (timer drift-based, for laptop reliability)
- Security hardened: all tmux/shell calls use execFileSync with argument arrays (command injection prevention), path traversal prevention via key validation, timing-safe auth token comparison
- Rate limiting on session spawn endpoint (sliding window, no external deps)
- Async session monitoring (non-blocking event loop, overlap guard)
- Request timeout middleware (configurable, prevents hanging requests)
- Quota tracking (file-based state reading, threshold-based load shedding for job scheduler)
- Input validation on all API endpoints (name/prompt/text length limits, model enum validation)
- Full project scaffolding (AGENT.md, USER.md, MEMORY.md, CLAUDE.md, hooks, scripts)
- 584+ tests passing (unit + integration + e2e across 56+ test files)
- `.npmignore` configured to exclude tests, docs, source, dev files

### Architecture
```
.instar/                # Created in user's project
  config.json           # Server, scheduler, messaging config
  jobs.json             # Scheduled job definitions
  users.json            # User profiles
  AGENT.md              # Agent identity (who am I?)
  USER.md               # User context (who am I working with?)
  MEMORY.md             # Persistent learnings
  state/                # Runtime state (sessions, jobs)
  relationships/        # Per-person relationship files
  logs/                 # Server logs

src/
  core/                 # Config, SessionManager, StateManager, Prerequisites,
                        # FeedbackManager, UpdateChecker, RelationshipManager,
                        # SleepWakeDetector, types
  scheduler/            # JobLoader, JobScheduler
  server/               # AgentServer, routes, middleware
  messaging/            # TelegramAdapter
  monitoring/           # HealthChecker, QuotaTracker
  scaffold/             # bootstrap (identity), templates (file generation)
  templates/            # Default job definitions, hook scripts, helper scripts
  commands/             # CLI: init, setup, server, status, user, job, add, feedback
  users/                # UserManager
```

### Key Files
- `src/core/SessionManager.ts` — Spawns/monitors Claude Code sessions in tmux
- `src/core/FeedbackManager.ts` — Feedback webhook forwarding with retry
- `src/core/UpdateChecker.ts` — npm registry version checking
- `src/core/SleepWakeDetector.ts` — Timer drift-based sleep/wake detection
- `src/commands/setup.ts` — Interactive setup wizard (classic mode)
- `src/commands/init.ts` — Non-interactive init (fresh project or existing)
- `src/scaffold/bootstrap.ts` — Identity bootstrap (initiative levels)
- `.claude/skills/setup-wizard/skill.md` — Conversational wizard prompt (dev only, not in npm)
- `src/scheduler/JobScheduler.ts` — Cron-based job scheduling with priority
- `src/server/middleware.ts` — CORS, auth (timing-safe), error handling

## Strategic Context

### Why Now — The OpenClaw Moment
- Anthropic banned using Claude Code OAuth tokens in third-party agent harnesses (Feb 17-19, 2026)
- OpenClaw, NanoClaw, etc. are all broken — their users need alternatives
- **Instar is architecturally clean**: we spawn the actual Claude Code CLI, never extract OAuth tokens
- We support both API keys (recommended for production) and subscription auth
- This is a massive market opportunity — thousands of displaced power users

### Positioning vs OpenClaw
- OpenClaw = multi-channel AI assistant you deploy and talk to (20+ platforms, companion apps, skill marketplace)
- Instar = persistent body for any Claude Code project (server, scheduler, identity, self-modification)
- OpenClaw IS the product; Instar AUGMENTS your existing project
- Full positioning doc: `docs/positioning-vs-openclaw.md`

### ToS Compliance
- Anthropic's policy: OAuth tokens are for Claude Code and claude.ai only
- Instar spawns the official Claude Code CLI — we ARE Claude Code usage
- We never extract, proxy, or spoof OAuth tokens
- API keys recommended for production/commercial use

## Design Principles (Earned Through Building)

1. **Agent-first language** — The setup wizard never tells users to memorize CLI commands. After `instar server start`, you talk to your agent. "Ask your agent to create a job" not "run `instar job add`".
2. **Identity is infrastructure, not a file** — SOUL.md is a file. Instar's identity system is hooks that re-inject identity on session start, after compaction, and before messaging. Structure over willpower.
3. **Different category from OpenClaw** — They're messaging middleware ("AI assistant everywhere"). We're autonomy infrastructure ("give your agent a body"). Don't try to match their 20+ channels. Win on depth: runtime, multi-session, identity, self-evolution, relationships.

## What Needs Doing

### Critical (Ship-Blocking)
- [ ] Point instar.sh domain to landing page (Astro site built in `site/`, needs Vercel deploy)
- [x] License decision — MIT (shipped in LICENSE file + package.json)
- [ ] Make GitHub repo public (currently private)
- [x] README polish — OpenClaw comparison section added (0.1.5)

### Important (Quality)
- [x] Agent-first language in setup wizard (0.1.6)
- [x] Integration tests use real tmux (skip if unavailable)
- [x] E2E test for full lifecycle (implemented in tests/e2e/lifecycle.test.ts)
- [ ] Error handling for edge cases (tmux server death, Claude Code not logged in)
- [x] `.npmignore` to reduce package size (tests, docs, source excluded)
- [x] Implement `instar add telegram` subcommand (reads/updates config.json)
- [x] Implement `instar add quota` subcommand (enables quota tracking in config)
- [x] Implement `instar add sentry` subcommand (writes DSN to monitoring config)
- [x] Implement `instar add email` subcommand (Gmail credentials config)
- [x] Quota tracking data source (QuotaTracker reads state file, threshold-based load shedding)

### Nice to Have
- [ ] Slack adapter (TelegramAdapter pattern is extensible)
- [ ] Discord adapter
- [ ] Email adapter
- [ ] Web dashboard for monitoring
- [ ] `instar upgrade` command for self-updating
- [ ] Voice message transcription (Telegram voice messages currently dropped)
- [ ] Cross-machine topic routing
- [ ] Kill audit logging

### Learned from OpenClaw (worth considering)
- [ ] DM pairing flow for new contacts (temporary codes with expiry)
- [ ] Security audit CLI (`instar security audit`)
- [ ] Auth profile rotation with failover
- [ ] Streaming chunker (code-fence-aware, break preference hierarchy)
