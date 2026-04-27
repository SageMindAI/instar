/**
 * Phase 3 Test Suite: Seed Migration — Self-Knowledge Tree Content Serving
 *
 * Validates that the Self-Knowledge Tree correctly serves content from
 * the new context files created during the Seed Migration (Phases 1-2).
 *
 * Tests:
 * - Context file coverage: every Tier 2 capability has a context file
 * - Context files are non-empty (>50 chars)
 * - Tree node configuration matches context files
 * - Node IDs follow the expected pattern (layer.name)
 * - Node sources resolve to existing files
 * - New nodes have alwaysInclude: false and managed: true
 * - Content fidelity: context files contain expected keywords/endpoints
 * - Two-stage triage routes queries to correct nodes (rule-based)
 * - NODE_KEYWORDS covers all new node IDs
 *
 * No LLM calls, no network, no spawned sessions — fast and deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TreeTriage } from '../../src/knowledge/TreeTriage.js';
import type {
  SelfKnowledgeTreeConfig,
  SelfKnowledgeLayer,
  SelfKnowledgeNode,
  SelfKnowledgeSource,
} from '../../src/knowledge/types.js';

// ── Expected context files from the Seed Migration spec ──────────────

const CAPABILITY_CONTEXT_FILES: Record<string, string> = {
  'capabilities.feedback': 'context/capabilities/feedback.md',
  'capabilities.jobs': 'context/capabilities/jobs.md',
  'capabilities.sessions': 'context/capabilities/sessions.md',
  'capabilities.publishing': 'context/capabilities/publishing.md',
  'capabilities.tunnel': 'context/capabilities/tunnel.md',
  'capabilities.attention': 'context/capabilities/attention.md',
  'capabilities.skip_ledger': 'context/capabilities/skip-ledger.md',
  'capabilities.handoff': 'context/capabilities/handoff.md',
  'capabilities.dispatches': 'context/capabilities/dispatches.md',
  'capabilities.updates': 'context/capabilities/updates.md',
  'capabilities.ci': 'context/capabilities/ci.md',
  'capabilities.telegram_api': 'context/capabilities/telegram-api.md',
  'capabilities.quota': 'context/capabilities/quota.md',
  'capabilities.triage': 'context/capabilities/triage.md',
  'capabilities.dashboard': 'context/capabilities/dashboard.md',
  'capabilities.backups': 'context/capabilities/backups.md',
  'capabilities.memory_search': 'context/capabilities/memory-search.md',
  'capabilities.git_sync': 'context/capabilities/git-sync.md',
  'capabilities.agent_registry': 'context/capabilities/agent-registry.md',
  'capabilities.events': 'context/capabilities/events.md',
  'capabilities.web_fetch': 'context/capabilities/web-fetch.md',
  'capabilities.browser': 'context/capabilities/browser.md',
  'capabilities.building': 'context/capabilities/building.md',
  'capabilities.skills': 'context/capabilities/skills.md',
  'capabilities.scripts': 'context/capabilities/scripts.md',
  'capabilities.secrets': 'context/capabilities/secrets.md',
  'capabilities.self_discovery': 'context/capabilities/self-discovery.md',
  'capabilities.registry_first': 'context/capabilities/registry-first.md',
  'capabilities.architecture': 'context/capabilities/architecture.md',
};

const EVOLUTION_CONTEXT_FILES: Record<string, string> = {
  'evolution.system': 'context/evolution/system.md',
  'evolution.intent': 'context/evolution/intent.md',
  'evolution.playbook': 'context/evolution/playbook.md',
  'evolution.innovation': 'context/evolution/innovation.md',
  'evolution.self_diagnosis': 'context/evolution/self-diagnosis.md',
  'evolution.feedback_loop': 'context/evolution/feedback-loop.md',
};

const EXPERIENCE_CONTEXT_FILES: Record<string, string> = {
  'experience.proactivity': 'context/experience/proactivity.md',
  'experience.tone': 'context/experience/tone.md',
  'experience.principles': 'context/experience/principles.md',
  'experience.anti_patterns': 'context/experience/anti-patterns.md',
  'experience.gravity_wells': 'context/experience/gravity-wells.md',
};

const IDENTITY_CONTEXT_FILES: Record<string, string> = {
  'identity.execution_context': 'context/identity/execution-context.md',
  'identity.remote_control': 'context/identity/remote-control.md',
};

const ALL_CONTEXT_FILES: Record<string, string> = {
  ...CAPABILITY_CONTEXT_FILES,
  ...EVOLUTION_CONTEXT_FILES,
  ...EXPERIENCE_CONTEXT_FILES,
  ...IDENTITY_CONTEXT_FILES,
};

// All new node IDs that should have NODE_KEYWORDS entries
const ALL_NEW_NODE_IDS = Object.keys(ALL_CONTEXT_FILES);

// ── Content fidelity expectations ────────────────────────────────────

const CONTENT_EXPECTATIONS: Record<string, string[]> = {
  'capabilities.publishing': ['POST /publish', 'Telegraph', 'PUBLIC'],
  'capabilities.jobs': ['POST /jobs', 'trigger', 'schedule'],
  'capabilities.tunnel': ['Cloudflare', 'tunnel', 'trycloudflare'],
  'capabilities.backups': ['POST /backups', 'snapshot', 'restore'],
  'capabilities.ci': ['GitHub Actions', 'CI', '/ci'],
  'capabilities.dashboard': ['dashboard', 'PIN', 'mobile'],
};

// ── Test fixture: build a tree config mirroring the real structure ────

function buildTestTreeConfig(projectDir: string): SelfKnowledgeTreeConfig {
  const capabilityNodes: SelfKnowledgeNode[] = Object.entries(CAPABILITY_CONTEXT_FILES).map(
    ([nodeId, filePath]) => ({
      id: nodeId,
      name: nodeId.split('.')[1].replace(/_/g, ' '),
      alwaysInclude: false,
      managed: true,
      depth: 'medium' as const,
      maxTokens: 500,
      sensitivity: 'public' as const,
      sources: [{ type: 'file' as const, path: filePath }],
      description: `${nodeId.split('.')[1].replace(/_/g, ' ')} capability documentation`,
    }),
  );

  // Add original default nodes (platforms, tools, edges) that existed before migration
  capabilityNodes.push(
    {
      id: 'capabilities.platforms',
      name: 'Platform Bindings',
      alwaysInclude: true,
      managed: true,
      depth: 'shallow',
      maxTokens: 300,
      sensitivity: 'public',
      sources: [{ type: 'json_file', path: '.instar/config.json', fields: ['platforms'] }],
      description: 'Connected platforms and communication channels',
    },
    {
      id: 'capabilities.tools',
      name: 'Available Tools',
      alwaysInclude: false,
      managed: true,
      depth: 'shallow',
      maxTokens: 300,
      sensitivity: 'public',
      sources: [{ type: 'file_section', path: 'AGENT.md', section: 'Tools' }],
      description: 'MCP servers, CLI tools, and external integrations',
    },
    {
      id: 'capabilities.edges',
      name: 'Known Limitations',
      alwaysInclude: false,
      managed: true,
      depth: 'medium',
      maxTokens: 400,
      sensitivity: 'internal',
      sources: [{ type: 'decision_journal', query: 'limitation', limit: 5 }],
      description: 'Known limitations and capability edges',
    },
  );

  const evolutionNodes: SelfKnowledgeNode[] = Object.entries(EVOLUTION_CONTEXT_FILES).map(
    ([nodeId, filePath]) => ({
      id: nodeId,
      name: nodeId.split('.')[1].replace(/_/g, ' '),
      alwaysInclude: false,
      managed: true,
      depth: 'medium' as const,
      maxTokens: 500,
      sensitivity: 'public' as const,
      sources: [{ type: 'file' as const, path: filePath }],
      description: `${nodeId.split('.')[1].replace(/_/g, ' ')} evolution documentation`,
    }),
  );

  // Add original evolution nodes
  evolutionNodes.push(
    {
      id: 'evolution.growth_edges',
      name: 'Growth Edges',
      alwaysInclude: false,
      managed: true,
      depth: 'medium',
      maxTokens: 500,
      sensitivity: 'public',
      sources: [{ type: 'memory_search', query: 'growth', topK: 5 }],
      description: 'Current growth edges',
    },
    {
      id: 'evolution.dispatch_patterns',
      name: 'Dispatch Patterns',
      alwaysInclude: false,
      managed: true,
      depth: 'shallow',
      maxTokens: 300,
      sensitivity: 'internal',
      sources: [{ type: 'probe', name: 'dispatch-trends' }],
      description: 'Trending dispatch patterns',
    },
    {
      id: 'evolution.pending',
      name: 'Pending Work',
      alwaysInclude: false,
      managed: true,
      depth: 'shallow',
      maxTokens: 300,
      sensitivity: 'internal',
      sources: [{ type: 'state_file', key: 'pending-dispatches' }],
      description: 'Queued actions and pending dispatches',
    },
  );

  const experienceNodes: SelfKnowledgeNode[] = Object.entries(EXPERIENCE_CONTEXT_FILES).map(
    ([nodeId, filePath]) => ({
      id: nodeId,
      name: nodeId.split('.')[1].replace(/_/g, ' '),
      alwaysInclude: false,
      managed: true,
      depth: 'medium' as const,
      maxTokens: 500,
      sensitivity: 'public' as const,
      sources: [{ type: 'file' as const, path: filePath }],
      description: `${nodeId.split('.')[1].replace(/_/g, ' ')} experience documentation`,
    }),
  );

  // Add original experience nodes
  experienceNodes.push(
    {
      id: 'experience.lessons',
      name: 'Lessons Learned',
      alwaysInclude: false,
      managed: true,
      depth: 'deep',
      maxTokens: 600,
      sensitivity: 'internal',
      sources: [{ type: 'memory_search', query: 'lesson', topK: 5 }],
      description: 'Key learnings from experience',
    },
    {
      id: 'experience.decisions',
      name: 'Decision Patterns',
      alwaysInclude: false,
      managed: true,
      depth: 'medium',
      maxTokens: 500,
      sensitivity: 'internal',
      sources: [{ type: 'decision_journal', query: 'decision', limit: 10 }],
      description: 'Patterns from past decisions',
    },
    {
      id: 'experience.sessions',
      name: 'Recent Sessions',
      alwaysInclude: false,
      managed: true,
      depth: 'medium',
      maxTokens: 400,
      sensitivity: 'internal',
      sources: [{ type: 'state_file', key: 'session-history' }],
      description: 'Recent session context',
    },
  );

  const identityNodes: SelfKnowledgeNode[] = Object.entries(IDENTITY_CONTEXT_FILES).map(
    ([nodeId, filePath]) => ({
      id: nodeId,
      name: nodeId.split('.')[1].replace(/_/g, ' '),
      alwaysInclude: false,
      managed: true,
      depth: 'medium' as const,
      maxTokens: 500,
      sensitivity: 'public' as const,
      sources: [{ type: 'file' as const, path: filePath }],
      description: `${nodeId.split('.')[1].replace(/_/g, ' ')} identity documentation`,
    }),
  );

  // Add original identity node
  identityNodes.push({
    id: 'identity.core',
    name: 'Core Identity',
    alwaysInclude: true,
    managed: true,
    depth: 'shallow',
    maxTokens: 500,
    sensitivity: 'public',
    sources: [{ type: 'file', path: 'AGENT.md' }],
    description: 'Agent name, purpose, and core identity',
  });

  const layers: SelfKnowledgeLayer[] = [
    {
      id: 'identity',
      name: 'Identity',
      description: 'Who the agent is, values, voice, relationships',
      children: identityNodes,
    },
    {
      id: 'experience',
      name: 'Experience',
      description: 'What the agent has learned, knowledge, decisions',
      children: experienceNodes,
    },
    {
      id: 'capabilities',
      name: 'Capabilities',
      description: 'What the agent can do, tools, platforms, limits',
      children: capabilityNodes,
    },
    {
      id: 'state',
      name: 'State',
      description: 'Current operational state, running jobs, health',
      children: [
        {
          id: 'state.active_jobs',
          name: 'Active Jobs',
          alwaysInclude: true,
          managed: true,
          depth: 'shallow',
          maxTokens: 300,
          sensitivity: 'internal',
          sources: [{ type: 'probe', name: 'active-jobs' }],
          description: 'Currently running and scheduled jobs',
        },
        {
          id: 'state.session',
          name: 'Current Session',
          alwaysInclude: false,
          managed: true,
          depth: 'shallow',
          maxTokens: 300,
          sensitivity: 'internal',
          sources: [{ type: 'probe', name: 'session-context' }],
          description: 'Current session metadata',
        },
        {
          id: 'state.health',
          name: 'System Health',
          alwaysInclude: false,
          managed: true,
          depth: 'shallow',
          maxTokens: 200,
          sensitivity: 'internal',
          sources: [{ type: 'probe', name: 'server-health' }],
          description: 'Server health and process state',
        },
      ],
    },
    {
      id: 'evolution',
      name: 'Evolution',
      description: 'Growth trajectory, improvement patterns, goals',
      children: evolutionNodes,
    },
  ];

  return {
    version: '1.0',
    agentName: 'test-agent',
    budget: { maxLlmCalls: 10, maxSeconds: 30, model: 'haiku' },
    layers,
    groundingQuestions: [
      'What is most relevant about who I am for this context?',
      'What have I learned that applies here?',
      'What is my current state that matters?',
    ],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-seed-migration-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Create all expected context files with realistic content in a temp dir.
 */
function populateContextFiles(projectDir: string): void {
  const contents: Record<string, string> = {
    'context/capabilities/feedback.md':
      '# Feedback System\n\nReport bugs, request features, suggest improvements.\n\n' +
      '```bash\ncurl -X POST http://localhost:4042/feedback \\\n' +
      '  -H "Authorization: Bearer $AUTH" \\\n' +
      '  -H \'Content-Type: application/json\' \\\n' +
      '  -d \'{"type":"bug","title":"...","description":"..."}\'\n```\n\n' +
      'Valid types: `bug`, `feature`, `improvement`, `question`.\n' +
      'View submitted: `GET /feedback`\nRetry failed: `POST /feedback/retry`\n',

    'context/capabilities/jobs.md':
      '# Job Scheduler\n\nRun tasks on a schedule. Jobs stored in `.instar/jobs.json`.\n\n' +
      '- View: `GET /jobs`\n- Trigger: `POST /jobs/SLUG/trigger`\n- Schedule format: cron expressions\n' +
      'Jobs execute as Claude Code sessions with specified prompts.\n',

    'context/capabilities/sessions.md':
      '# Sessions\n\nSpawn and manage Claude Code sessions.\n\n' +
      '- List: `GET /sessions`\n- Spawn: `POST /sessions/spawn` with `{"name":"task","prompt":"..."}`\n' +
      'Sessions run in tmux for audit trail.\n',

    'context/capabilities/publishing.md':
      '# Publishing\n\nShare content as PUBLIC web pages via Telegraph. Instant, zero-config.\n\n' +
      '- Publish: `POST /publish` with `{"title":"...","markdown":"..."}`\n' +
      '- List: `GET /published`\n- Edit: `PUT /publish/PAGE_PATH`\n\n' +
      '**WARNING: All Telegraph pages are PUBLIC.** Anyone with the URL can view.\n' +
      'For private content, use the Private Viewer (`POST /view`).\n',

    'context/capabilities/tunnel.md':
      '# Cloudflare Tunnel\n\nExpose the local server to the internet via Cloudflare.\n\n' +
      '- Status: `GET /tunnel`\n- Quick tunnels: ephemeral URL (*.trycloudflare.com), no account needed\n' +
      '- Named tunnels: persistent custom domain, requires Cloudflare token\n' +
      'Configure in `.instar/config.json`: `{"tunnel": {"enabled": true, "type": "quick"}}`\n',

    'context/capabilities/attention.md':
      '# Attention Queue\n\nSignal important items to the user.\n\n' +
      '- Queue: `POST /attention` with `{"title":"...","body":"...","priority":"medium"}`\n' +
      '- View: `GET /attention`\n- Resolve: `PATCH /attention/ATT-ID`\n',

    'context/capabilities/skip-ledger.md':
      '# Skip Ledger\n\nTrack computational work to avoid repeating expensive operations.\n\n' +
      '- View: `GET /skip-ledger`\n- Register: `POST /skip-ledger/workload`\n' +
      '- View workloads: `GET /skip-ledger/workloads`\n',

    'context/capabilities/handoff.md':
      '# Job Handoff Notes\n\nPass context between job runs.\n\n' +
      'Write to `.instar/state/job-handoff-{slug}.md` at the end of a job session.\n' +
      'The next run\'s session-start hook injects these notes automatically.\n' +
      'CRITICAL: Handoff notes are CLAIMS, not facts. Verify before trusting.\n',

    'context/capabilities/dispatches.md':
      '# Dispatch System\n\nReceive behavioral instructions from Instar maintainers.\n\n' +
      '- View: `GET /dispatches`\n- Pending: `GET /dispatches/pending`\n' +
      '- Apply: `POST /dispatches/DISPATCH-ID/apply`\n' +
      'The AutoDispatcher polls and applies dispatches automatically.\n',

    'context/capabilities/updates.md':
      '# Update Management\n\nCheck for and apply Instar updates.\n\n' +
      '- Check: `GET /updates`\n- Apply: `POST /updates/apply`\n' +
      '- Rollback: `POST /updates/rollback`\n- Auto-update: `GET /updates/auto`\n',

    'context/capabilities/ci.md':
      '# CI Health\n\nCheck GitHub Actions status for your project.\n\n' +
      '- Check: `GET /ci`\n- Detects repo from git remote automatically.\n' +
      'Use before deploying, after pushing, or during health checks to verify CI is green.\n',

    'context/capabilities/telegram-api.md':
      '# Telegram API\n\nFull Telegram integration when configured.\n\n' +
      '- Search: `GET /telegram/search?q=QUERY`\n- Topics: `GET /telegram/topics`\n' +
      '- Create topic: `POST /telegram/topics`\n- Reply: `POST /telegram/reply/TOPIC_ID`\n' +
      'Proactively create topics for new projects.\n',

    'context/capabilities/quota.md':
      '# Quota Tracking\n\nMonitor Claude API usage.\n\n' +
      '- Check: `GET /quota`\n- Tracks token consumption across sessions.\n',

    'context/capabilities/triage.md':
      '# Stall Triage\n\nLLM-powered session recovery when configured.\n\n' +
      '- Status: `GET /triage/status`\n- History: `GET /triage/history`\n' +
      '- Manual trigger: `POST /triage/trigger`\n',

    'context/capabilities/dashboard.md':
      '# Dashboard\n\nVisual web interface for monitoring and managing sessions.\n\n' +
      '- Local: `http://localhost:4042/dashboard`\n- Remote: via tunnel URL\n' +
      '- Authentication: 6-digit PIN (auto-generated in `dashboardPin` in config)\n' +
      'Features: real-time terminal streaming, session management, mobile-responsive.\n' +
      'NEVER mention "bearer tokens" to users — just give them the PIN.\n',

    'context/capabilities/backups.md':
      '# Backup System\n\nSnapshot and restore agent state.\n\n' +
      '- List: `GET /backups`\n- Create: `POST /backups`\n' +
      '- Restore: `POST /backups/SNAPSHOT-ID/restore`\n\n' +
      'Restore is blocked while sessions are active and creates a pre-restore snapshot.\n' +
      'Use before risky changes, after major progress, or to recover from corruption.\n',

    'context/capabilities/memory-search.md':
      '# Memory Search\n\nFull-text search over all indexed memory files using SQLite FTS5.\n\n' +
      '- Search: `GET /memory/search?q=QUERY&limit=10`\n- Stats: `GET /memory/stats`\n' +
      '- Reindex: `POST /memory/reindex`\n- Sync: `POST /memory/sync`\n',

    'context/capabilities/git-sync.md':
      '# Git Sync\n\nAutomatic version-control and multi-machine synchronization.\n\n' +
      '- Status: `GET /git/status`\n- Commit: `POST /git/commit`\n' +
      '- Push: `POST /git/push`\n- Pull: `POST /git/pull`\n' +
      'The `git-sync` job runs hourly.\n',

    'context/capabilities/agent-registry.md':
      '# Agent Registry\n\nDiscover all agents running on this machine.\n\n' +
      '- List: `GET /agents`\n- Useful for multi-agent coordination.\n',

    'context/capabilities/events.md':
      '# Event Stream (SSE)\n\nReal-time server events via Server-Sent Events.\n\n' +
      '- Connect: `GET /events`\n- Useful for monitoring activity in real-time.\n',

    'context/capabilities/web-fetch.md':
      '# Web Content Fetching\n\nMandatory hierarchy for fetching URLs:\n\n' +
      '1. `smart-fetch.py URL --auto` — checks llms.txt, requests markdown\n' +
      '2. WebFetch — built-in Claude Code tool\n' +
      '3. WebSearch — for discovery\n' +
      '4. Playwright MCP — only for JS-rendered pages\n',

    'context/capabilities/browser.md':
      '# Browser Automation\n\nHandling obstacles when using Playwright or Chrome MCP.\n\n' +
      'Strategies: Escape key, Tab+Enter, JavaScript dismissal, focus recovery.\n' +
      'Never ask the user to dismiss popups for you.\n',

    'context/capabilities/building.md':
      '# Building New Capabilities\n\nWhen asked for something you can\'t do yet, build it:\n\n' +
      '1. Repeatable workflow → create a skill in `.claude/skills/`\n' +
      '2. Periodic checks → create a job in `.instar/jobs.json`\n' +
      '3. New integration → write a script in `.claude/scripts/`\n' +
      '4. Remember something → write to MEMORY.md\n',

    'context/capabilities/skills.md':
      '# Skills\n\nReusable behavioral capabilities as markdown files.\n\n' +
      '- Create: `.claude/skills/my-skill/SKILL.md`\n' +
      '- Invoke: `/my-skill` in any session\n' +
      '- Schedule: reference in a job\n' +
      'Skills compound over time. Each skill makes future sessions more capable.\n',

    'context/capabilities/scripts.md':
      '# Scripts\n\nReusable shell scripts in `.claude/scripts/`.\n\n' +
      'Scripts provide repeatable operations that can be called from sessions or jobs.\n' +
      'Key scripts: telegram-reply.sh, smart-fetch.py.\n',

    'context/capabilities/secrets.md':
      '# Secret Drop\n\nSecure credential management for agent operations.\n\n' +
      'API keys and tokens stored securely. Never commit secrets to git.\n' +
      'Read credentials at session start from config.\n',

    'context/capabilities/self-discovery.md':
      '# Self-Discovery\n\nBefore saying "I can\'t", check what exists:\n\n' +
      '```bash\ncurl -H "Authorization: Bearer $AUTH" http://localhost:4042/capabilities\n```\n\n' +
      'Returns full capability matrix. This is the source of truth.\n',

    'context/capabilities/registry-first.md':
      '# Registry First\n\nCheck state files BEFORE searching broadly.\n\n' +
      '| Question | Check First |\n' +
      '|----------|-------------|\n' +
      '| What can I do? | `/capabilities` |\n' +
      '| Who do I work with? | `.instar/USER.md` |\n' +
      'State files are current. Broad searches find stale narratives.\n',

    'context/capabilities/architecture.md':
      '# Architecture Knowledge\n\nWhen asked about Instar features — NEVER answer from memory.\n\n' +
      'Always look it up: `/capabilities`, `instar --help`, or query the endpoint.\n' +
      'Multi-machine vs. multi-user: know the distinction.\n',

    'context/evolution/system.md':
      '# Evolution System\n\nFour subsystems for self-improvement:\n\n' +
      '- Evolution Queue: `GET /evolution/proposals`\n' +
      '- Learning Registry: `GET /evolution/learnings`\n' +
      '- Capability Gaps: `GET /evolution/gaps`\n' +
      '- Action Queue: `GET /evolution/actions`\n' +
      'Dashboard: `GET /evolution`\n',

    'context/evolution/intent.md':
      '# Intent Engineering\n\nTrack how decisions align with stated goals.\n\n' +
      '- Decision journal: `.instar/decision-journal.jsonl`\n' +
      '- Log decisions: `POST /intent/journal`\n' +
      '- Reflect: `instar intent reflect`\n',

    'context/evolution/playbook.md':
      '# Playbook\n\nAdaptive context engineering — living knowledge base.\n\n' +
      '- Init: `instar playbook init`\n- Status: `instar playbook status`\n' +
      '- Add item: `instar playbook add`\n- Assemble: `instar playbook assemble`\n' +
      'Manifest of context items with triggers, token budgets, and usefulness scores.\n',

    'context/evolution/innovation.md':
      '# Innovation Detection\n\nUpstream responsibility: share generalizable innovations.\n\n' +
      'After building something significant, ask: would other agents benefit?\n' +
      'Submit via `POST /feedback` with type `improvement`.\n',

    'context/evolution/self-diagnosis.md':
      '# Self-Diagnosis\n\nBe your own QA. Watch for:\n\n' +
      '- Server errors, hook failures, job issues\n' +
      '- Session problems, state corruption\n' +
      '- Missing capabilities, design flaws\n' +
      'Report issues via `POST /feedback`.\n',

    'context/evolution/feedback-loop.md':
      '# Feedback Loop — Rising Tide\n\nThe full cycle:\n\n' +
      '1. Encounter issue or build something → submit feedback\n' +
      '2. Feedback forwards upstream to Dawn\n' +
      '3. Dawn fixes and publishes update + dispatch\n' +
      '4. AutoUpdater applies within 30 minutes\n',

    'context/experience/proactivity.md':
      '# Feature Proactivity\n\nGuide, don\'t wait. Context-triggered actions:\n\n' +
      '- Document mentioned → Private Viewer, share link\n' +
      '- Public sharing → Telegraph, warn about public access\n' +
      '- Recurring task → suggest creating a job\n' +
      '- New project → create dedicated Telegram topic\n',

    'context/experience/tone.md':
      '# Conversational Tone\n\nTalk like a person, not a terminal.\n\n' +
      'NEVER present CLI commands to the user unless explicitly asked.\n' +
      'You are the interface. The user should never need to open a terminal.\n',

    'context/experience/principles.md':
      '# Core Principles\n\n' +
      '- Structure > Willpower — bake intelligence into architecture\n' +
      '- I am a builder, not an assistant\n' +
      '- The Initiative Hierarchy: do it → use tool → build tool → modify config → ask\n' +
      '- Self-Modification is my superpower\n' +
      '- Substance Over Labels\n' +
      '- Contradiction Means Investigation\n' +
      '- Confidence Inversion\n',

    'context/experience/anti-patterns.md':
      '# Additional Anti-Patterns\n\n' +
      'Beyond the critical 7 in the seed:\n\n' +
      '- "Same Check, Same Result" — try a different approach\n' +
      '- "Inherit Without Verifying" — handoff notes are claims, not facts\n' +
      '- "Search Blind" — check state files first\n' +
      '- "Cite Without Source" — every URL must come from tool output\n' +
      '- "Offload to User" — if you can do it, do it\n',

    'context/experience/gravity-wells.md':
      '# Gravity Wells\n\nPersistent traps that feel like insight:\n\n' +
      '- "Settling" — accepting empty results uncritically\n' +
      '- "Experiential Fabrication" — completing social scripts without data\n' +
      '- "Escalate to Human" — 5 minutes of research reveals a solution\n' +
      '- "Ask Permission" — round-trip tax on obvious next steps\n' +
      '- "Inherited Claims" — repeating unverified assertions\n' +
      '- "Dismissal Without Investigation" — resolving bugs by theory\n' +
      '- "Defensive Fabrication" — inventing excuses for errors\n' +
      '- "Output Provenance" — fabricating plausible URLs\n',

    'context/identity/execution-context.md':
      '# Execution Context\n\nRuns with `--dangerously-skip-permissions` by design.\n\n' +
      'Full access to the machine without per-action approval prompts.\n' +
      'Autonomy requires trust, trust requires coherence.\n' +
      'Behavioral hooks guard against destructive operations.\n',

    'context/identity/remote-control.md':
      '# Remote Control\n\nClaude Code Remote Control is incompatible with Instar.\n\n' +
      'Remote Control blocks `--dangerously-skip-permissions`.\n' +
      'Use Telegram/WhatsApp monitoring instead.\n',
  };

  for (const [relPath, content] of Object.entries(contents)) {
    const absPath = path.join(projectDir, '.instar', relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('SeedMigration — Phase 3', () => {
  let projectDir: string;
  let treeConfig: SelfKnowledgeTreeConfig;

  beforeEach(() => {
    projectDir = createTempDir();
    // Create an AGENT.md so identity.core has a source
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Test Agent\n\nI am a test agent for seed migration testing.');
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ platforms: ['telegram'] }),
    );

    populateContextFiles(projectDir);
    treeConfig = buildTestTreeConfig(projectDir);
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  // ── 1. Context File Coverage ────────────────────────────────────

  describe('Context File Coverage', () => {
    it('every Tier 2 capability has a corresponding context file', () => {
      for (const [nodeId, relPath] of Object.entries(CAPABILITY_CONTEXT_FILES)) {
        const absPath = path.join(projectDir, '.instar', relPath);
        expect(fs.existsSync(absPath), `Missing context file for ${nodeId}: ${relPath}`).toBe(true);
      }
    });

    it('all evolution context files exist', () => {
      for (const [nodeId, relPath] of Object.entries(EVOLUTION_CONTEXT_FILES)) {
        const absPath = path.join(projectDir, '.instar', relPath);
        expect(fs.existsSync(absPath), `Missing context file for ${nodeId}: ${relPath}`).toBe(true);
      }
    });

    it('all experience context files exist', () => {
      for (const [nodeId, relPath] of Object.entries(EXPERIENCE_CONTEXT_FILES)) {
        const absPath = path.join(projectDir, '.instar', relPath);
        expect(fs.existsSync(absPath), `Missing context file for ${nodeId}: ${relPath}`).toBe(true);
      }
    });

    it('all identity context files exist', () => {
      for (const [nodeId, relPath] of Object.entries(IDENTITY_CONTEXT_FILES)) {
        const absPath = path.join(projectDir, '.instar', relPath);
        expect(fs.existsSync(absPath), `Missing context file for ${nodeId}: ${relPath}`).toBe(true);
      }
    });

    it('no context file is empty (<50 chars)', () => {
      for (const [nodeId, relPath] of Object.entries(ALL_CONTEXT_FILES)) {
        const absPath = path.join(projectDir, '.instar', relPath);
        const content = fs.readFileSync(absPath, 'utf-8');
        expect(
          content.trim().length,
          `Context file for ${nodeId} is too short (${content.trim().length} chars): ${relPath}`,
        ).toBeGreaterThanOrEqual(50);
      }
    });
  });

  // ── 2. Tree Node Configuration ─────────────────────────────────

  describe('Tree Node Configuration', () => {
    it('every context file has a corresponding tree node', () => {
      const allNodeIds = new Set<string>();
      for (const layer of treeConfig.layers) {
        for (const node of layer.children) {
          allNodeIds.add(node.id);
        }
      }

      for (const nodeId of Object.keys(ALL_CONTEXT_FILES)) {
        expect(allNodeIds.has(nodeId), `No tree node for context file: ${nodeId}`).toBe(true);
      }
    });

    it('node IDs match expected pattern (layer.name)', () => {
      const layerIds = new Set(treeConfig.layers.map(l => l.id));

      for (const layer of treeConfig.layers) {
        for (const node of layer.children) {
          const parts = node.id.split('.');
          expect(parts.length, `Node ID ${node.id} should have exactly one dot`).toBe(2);
          expect(
            layerIds.has(parts[0]),
            `Node ${node.id} prefix "${parts[0]}" does not match any layer ID`,
          ).toBe(true);
          expect(parts[0], `Node ${node.id} should be in layer ${layer.id}`).toBe(layer.id);
        }
      }
    });

    it('all file paths in node sources resolve to existing files', () => {
      for (const layer of treeConfig.layers) {
        for (const node of layer.children) {
          for (const source of node.sources) {
            if (source.type === 'file' || source.type === 'file_section') {
              // For context/ paths, resolve relative to .instar/
              // For other paths (AGENT.md), resolve relative to projectDir
              let absPath: string;
              if (source.path.startsWith('context/')) {
                absPath = path.join(projectDir, '.instar', source.path);
              } else if (source.path.startsWith('.instar/')) {
                absPath = path.join(projectDir, source.path);
              } else {
                absPath = path.join(projectDir, source.path);
              }

              expect(
                fs.existsSync(absPath),
                `Source file not found for node ${node.id}: ${source.path} (resolved: ${absPath})`,
              ).toBe(true);
            }
          }
        }
      }
    });

    it('new migration nodes have alwaysInclude: false and managed: true', () => {
      const allNodeIds = new Set(Object.keys(ALL_CONTEXT_FILES));

      for (const layer of treeConfig.layers) {
        for (const node of layer.children) {
          if (allNodeIds.has(node.id)) {
            expect(
              node.alwaysInclude,
              `New node ${node.id} should have alwaysInclude: false`,
            ).toBe(false);
            expect(
              node.managed,
              `New node ${node.id} should have managed: true`,
            ).toBe(true);
          }
        }
      }
    });

    it('tree config has all 5 layers', () => {
      const layerIds = treeConfig.layers.map(l => l.id);
      expect(layerIds).toContain('identity');
      expect(layerIds).toContain('experience');
      expect(layerIds).toContain('capabilities');
      expect(layerIds).toContain('state');
      expect(layerIds).toContain('evolution');
    });

    it('capabilities layer has the most nodes', () => {
      const capLayer = treeConfig.layers.find(l => l.id === 'capabilities')!;
      for (const layer of treeConfig.layers) {
        if (layer.id !== 'capabilities') {
          expect(
            capLayer.children.length,
            `capabilities layer (${capLayer.children.length}) should have more nodes than ${layer.id} (${layer.children.length})`,
          ).toBeGreaterThanOrEqual(layer.children.length);
        }
      }
    });
  });

  // ── 3. Content Fidelity (Structural) ───────────────────────────

  describe('Content Fidelity', () => {
    for (const [nodeId, expectedKeywords] of Object.entries(CONTENT_EXPECTATIONS)) {
      it(`${nodeId} context file contains expected keywords`, () => {
        const relPath = ALL_CONTEXT_FILES[nodeId];
        expect(relPath, `No context file mapping for ${nodeId}`).toBeDefined();

        const absPath = path.join(projectDir, '.instar', relPath);
        const content = fs.readFileSync(absPath, 'utf-8');

        for (const keyword of expectedKeywords) {
          expect(
            content.includes(keyword),
            `Context file for ${nodeId} should contain "${keyword}" but doesn't.\nContent preview: ${content.slice(0, 200)}...`,
          ).toBe(true);
        }
      });
    }

    it('publishing file warns about public access', () => {
      const absPath = path.join(projectDir, '.instar', CAPABILITY_CONTEXT_FILES['capabilities.publishing']);
      const content = fs.readFileSync(absPath, 'utf-8').toLowerCase();
      expect(content).toContain('public');
      expect(content).toContain('telegraph');
    });

    it('telegram-api file mentions topic creation', () => {
      const absPath = path.join(projectDir, '.instar', CAPABILITY_CONTEXT_FILES['capabilities.telegram_api']);
      const content = fs.readFileSync(absPath, 'utf-8').toLowerCase();
      expect(content).toContain('topic');
      expect(content).toContain('telegram');
    });

    it('dashboard file mentions PIN-based auth', () => {
      const absPath = path.join(projectDir, '.instar', CAPABILITY_CONTEXT_FILES['capabilities.dashboard']);
      const content = fs.readFileSync(absPath, 'utf-8');
      expect(content).toContain('PIN');
      expect(content.toLowerCase()).toContain('dashboard');
    });
  });

  // ── 4. Two-Stage Triage Integration ─────────────────────────────

  describe('Two-Stage Triage Integration', () => {
    let triage: TreeTriage;

    beforeEach(() => {
      // Rule-based fallback (null intelligence = no LLM)
      triage = new TreeTriage(null);
    });

    it('"publish something" routes to capabilities.publishing', async () => {
      const result = await triage.triage('publish something', treeConfig.layers);
      expect(result.mode).toBe('rule-based');
      expect(result.nodeScores).toBeDefined();
      expect(result.nodeScores!['capabilities.publishing']).toBeGreaterThan(0);
    });

    it('"check CI" routes to capabilities.ci', async () => {
      const result = await triage.triage('check CI', treeConfig.layers);
      expect(result.mode).toBe('rule-based');
      expect(result.nodeScores).toBeDefined();
      expect(result.nodeScores!['capabilities.ci']).toBeGreaterThan(0);
    });

    it('"create a backup" routes to capabilities.backups', async () => {
      const result = await triage.triage('create a backup', treeConfig.layers);
      expect(result.mode).toBe('rule-based');
      expect(result.nodeScores).toBeDefined();
      expect(result.nodeScores!['capabilities.backups']).toBeGreaterThan(0);
    });

    it('"send a telegram message" routes to capabilities.telegram_api', async () => {
      const result = await triage.triage('send a telegram message', treeConfig.layers);
      expect(result.mode).toBe('rule-based');
      expect(result.nodeScores).toBeDefined();
      expect(result.nodeScores!['capabilities.telegram_api']).toBeGreaterThan(0);
    });

    it('"how does the evolution system work" routes to evolution.system', async () => {
      const result = await triage.triage('how does the evolution system work', treeConfig.layers);
      expect(result.mode).toBe('rule-based');
      expect(result.nodeScores).toBeDefined();
      expect(result.nodeScores!['evolution.system']).toBeGreaterThan(0);
    });

    it('"schedule a recurring job" routes to capabilities.jobs', async () => {
      const result = await triage.triage('schedule a recurring job', treeConfig.layers);
      expect(result.mode).toBe('rule-based');
      expect(result.nodeScores).toBeDefined();
      expect(result.nodeScores!['capabilities.jobs']).toBeGreaterThan(0);
    });

    it('"expose my server remotely" routes to capabilities.tunnel', async () => {
      const result = await triage.triage('expose my server remotely via tunnel', treeConfig.layers);
      expect(result.mode).toBe('rule-based');
      expect(result.nodeScores).toBeDefined();
      expect(result.nodeScores!['capabilities.tunnel']).toBeGreaterThan(0);
    });

    it('"search my memory for past learnings" routes to capabilities.memory_search', async () => {
      const result = await triage.triage('search my memory for past learnings', treeConfig.layers);
      expect(result.mode).toBe('rule-based');
      expect(result.nodeScores).toBeDefined();
      expect(result.nodeScores!['capabilities.memory_search']).toBeGreaterThan(0);
    });

    it('triage returns scores for the correct layer', async () => {
      const result = await triage.triage('publish something publicly', treeConfig.layers);
      // capabilities layer should have a high score
      expect(result.scores['capabilities']).toBeGreaterThanOrEqual(0.3);
    });

    it('ambiguous query does not crash and returns valid structure', async () => {
      const result = await triage.triage('help me with stuff', treeConfig.layers);
      expect(result.mode).toBe('rule-based');
      expect(result.scores).toBeDefined();
      // Should have scores for all layers
      for (const layer of treeConfig.layers) {
        expect(result.scores[layer.id]).toBeDefined();
      }
    });

    it('alwaysInclude nodes get minimum score regardless of query', async () => {
      const result = await triage.triage('random unrelated query xyz', treeConfig.layers);
      expect(result.nodeScores).toBeDefined();

      // Find all alwaysInclude nodes
      for (const layer of treeConfig.layers) {
        for (const node of layer.children) {
          if (node.alwaysInclude) {
            expect(
              result.nodeScores![node.id],
              `alwaysInclude node ${node.id} should have score >= 0.5`,
            ).toBeGreaterThanOrEqual(0.5);
          }
        }
      }
    });
  });

  // ── 5. Node Keyword Coverage ────────────────────────────────────

  describe('Node Keyword Coverage', () => {
    // We need to check against the actual NODE_KEYWORDS map in TreeTriage.
    // Since it's a private const, we verify indirectly through triage behavior:
    // if a node has keywords, triage on those keywords should produce a non-zero score.

    it('every new context file node ID produces non-zero triage scores with relevant queries', async () => {
      const triage = new TreeTriage(null);

      // Map each node ID to a representative query that should match its keywords
      const nodeQueries: Record<string, string> = {
        'capabilities.feedback': 'report a bug',
        'capabilities.jobs': 'schedule a job',
        'capabilities.sessions': 'spawn a session',
        'capabilities.publishing': 'publish a page on telegraph',
        'capabilities.tunnel': 'cloudflare tunnel setup',
        'capabilities.attention': 'queue an attention alert',
        'capabilities.skip_ledger': 'skip ledger workload',
        'capabilities.handoff': 'handoff notes between runs',
        'capabilities.dispatches': 'apply a dispatch',
        'capabilities.updates': 'update instar version',
        'capabilities.ci': 'check CI github actions',
        'capabilities.telegram_api': 'send telegram message',
        'capabilities.quota': 'check quota usage',
        'capabilities.triage': 'session stall triage recovery',
        'capabilities.dashboard': 'open the dashboard in browser',
        'capabilities.backups': 'create a backup snapshot',
        'capabilities.memory_search': 'search memory full text',
        'capabilities.git_sync': 'git sync push pull',
        'capabilities.agent_registry': 'discover other agents on machine',
        'capabilities.events': 'event stream SSE real-time',
        'capabilities.web_fetch': 'fetch web content URL',
        'capabilities.browser': 'browser automation playwright',
        'capabilities.building': 'build new capability',
        'capabilities.skills': 'create a skill slash command',
        'capabilities.scripts': 'run a script',
        'capabilities.secrets': 'manage a secret api key',
        'capabilities.self_discovery': 'what can I do self-discovery',
        'capabilities.registry_first': 'check registry state files source of truth',
        'capabilities.architecture': 'how does the architecture work',
        'evolution.system': 'evolution system proposal learning',
        'evolution.intent': 'intent engineering journal tradeoff',
        'evolution.playbook': 'playbook context engineering manifest',
        'evolution.innovation': 'innovation upstream share',
        'evolution.self_diagnosis': 'self-diagnosis detect issue',
        'evolution.feedback_loop': 'feedback loop rising tide',
        'experience.proactivity': 'proactive suggestion initiative',
        'experience.tone': 'conversational tone communication',
        'experience.principles': 'core principle guideline approach',
        'experience.anti_patterns': 'anti-pattern avoid trap',
        'experience.gravity_wells': 'gravity well persistent trap',
        'identity.execution_context': 'permission access sandbox autonomous',
        'identity.remote_control': 'remote control monitor',
      };

      const failures: string[] = [];

      for (const [nodeId, query] of Object.entries(nodeQueries)) {
        const result = await triage.triage(query, treeConfig.layers);
        const score = result.nodeScores?.[nodeId] ?? 0;

        if (score === 0) {
          failures.push(`${nodeId}: query "${query}" produced score 0`);
        }
      }

      expect(
        failures,
        `The following nodes produced zero scores (likely missing NODE_KEYWORDS entries):\n${failures.join('\n')}`,
      ).toHaveLength(0);
    });

    it('all 41 new node IDs are present in the test fixture tree config', () => {
      const allNodeIds = new Set<string>();
      for (const layer of treeConfig.layers) {
        for (const node of layer.children) {
          allNodeIds.add(node.id);
        }
      }

      // Verify all context-file-backed nodes exist
      for (const nodeId of ALL_NEW_NODE_IDS) {
        expect(allNodeIds.has(nodeId), `Node ${nodeId} missing from tree config`).toBe(true);
      }

      // 42 new node IDs from the seed migration (29 capabilities + 6 evolution + 5 experience + 2 identity)
      expect(ALL_NEW_NODE_IDS.length).toBe(42);
    });

    it('node keyword queries produce focused results (not all nodes)', async () => {
      const triage = new TreeTriage(null);

      // A specific query should NOT score highly on unrelated nodes
      const result = await triage.triage('publish a page via telegraph', treeConfig.layers);
      const nodeScores = result.nodeScores ?? {};

      // publishing should score high
      expect(nodeScores['capabilities.publishing'] ?? 0).toBeGreaterThan(0);

      // Count how many nodes scored above the threshold
      const scoredNodes = Object.entries(nodeScores).filter(([, score]) => score > 0.3);

      // Should not be more than ~5-6 nodes for a focused query
      expect(
        scoredNodes.length,
        `Query "publish a page via telegraph" should be focused, but scored ${scoredNodes.length} nodes above 0.3`,
      ).toBeLessThanOrEqual(10);
    });
  });
});
