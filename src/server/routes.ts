/**
 * HTTP API routes — health, status, sessions, jobs, events.
 *
 * Extracted/simplified from Dawn's 2267-line routes.ts.
 * All the observability you need, none of the complexity you don't.
 */

import { Router } from 'express';
import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { InstarConfig } from '../core/types.js';
import { rateLimiter, signViewPath } from './middleware.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { RelationshipManager } from '../core/RelationshipManager.js';
import type { FeedbackManager } from '../core/FeedbackManager.js';
import type { DispatchManager } from '../core/DispatchManager.js';
import type { UpdateChecker } from '../core/UpdateChecker.js';
import type { AutoUpdater } from '../core/AutoUpdater.js';
import type { QuotaTracker } from '../monitoring/QuotaTracker.js';
import type { TelegraphService } from '../publishing/TelegraphService.js';
import type { PrivateViewer } from '../publishing/PrivateViewer.js';
import type { TunnelManager } from '../tunnel/TunnelManager.js';
import type { EvolutionManager } from '../core/EvolutionManager.js';
import type { EvolutionStatus, EvolutionType, GapCategory } from '../core/types.js';

export interface RouteContext {
  config: InstarConfig;
  sessionManager: SessionManager;
  state: StateManager;
  scheduler: JobScheduler | null;
  telegram: TelegramAdapter | null;
  relationships: RelationshipManager | null;
  feedback: FeedbackManager | null;
  dispatches: DispatchManager | null;
  updateChecker: UpdateChecker | null;
  autoUpdater: AutoUpdater | null;
  quotaTracker: QuotaTracker | null;
  publisher: TelegraphService | null;
  viewer: PrivateViewer | null;
  tunnel: TunnelManager | null;
  evolution: EvolutionManager | null;
  startTime: Date;
}

// Validation patterns for route parameters
const SESSION_NAME_RE = /^[a-zA-Z0-9_-]{1,200}$/;
const JOB_SLUG_RE = /^[a-zA-Z0-9_-]{1,100}$/;
const VALID_SORTS = ['significance', 'recent', 'name'] as const;

export function createRoutes(ctx: RouteContext): Router {
  const router = Router();

  // ── Health ──────────────────────────────────────────────────────

  router.get('/health', (req, res) => {
    const uptimeMs = Date.now() - ctx.startTime.getTime();
    const base: Record<string, unknown> = {
      status: 'ok',
      uptime: uptimeMs,
      uptimeHuman: formatUptime(uptimeMs),
    };

    // Include detailed info only for authenticated callers.
    // Must actually validate the token here since authMiddleware skips /health.
    let isAuthed = !ctx.config.authToken;
    if (!isAuthed && ctx.config.authToken) {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        const token = header.slice(7);
        const ha = createHash('sha256').update(token).digest();
        const hb = createHash('sha256').update(ctx.config.authToken).digest();
        isAuthed = timingSafeEqual(ha, hb);
      }
    }
    if (isAuthed) {
      const mem = process.memoryUsage();
      base.version = ctx.config.version || '0.0.0';
      base.project = ctx.config.projectName;
      base.node = process.version;
      base.memory = {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      };

      // Job health summary
      if (ctx.scheduler) {
        const jobs = ctx.scheduler.getJobs();
        const failingJobs = jobs
          .map(j => ({ slug: j.slug, state: ctx.state.getJobState(j.slug) }))
          .filter(j => j.state && j.state.consecutiveFailures > 0);
        base.jobs = {
          total: jobs.length,
          enabled: jobs.filter(j => j.enabled).length,
          failing: failingJobs.map(j => ({
            slug: j.slug,
            failures: j.state!.consecutiveFailures,
            lastError: j.state!.lastError,
          })),
        };
      }
    }
    res.json(base);
  });

  // ── Status ──────────────────────────────────────────────────────

  router.get('/status', (_req, res) => {
    const sessions = ctx.sessionManager.listRunningSessions();
    const schedulerStatus = ctx.scheduler?.getStatus() ?? null;

    res.json({
      sessions: {
        running: sessions.length,
        max: ctx.config.sessions.maxSessions,
        list: sessions.map(s => ({ id: s.id, name: s.name, jobSlug: s.jobSlug })),
      },
      scheduler: schedulerStatus,
    });
  });

  // ── Capabilities (Self-Discovery) ──────────────────────────────
  //
  // Returns a structured self-portrait of what this agent has available.
  // Agents should query this at session start rather than guessing
  // about what infrastructure exists.

  router.get('/capabilities', (_req, res) => {
    const projectDir = ctx.config.projectDir;
    const stateDir = ctx.config.stateDir;

    // Identity files
    const identityFiles: Record<string, boolean> = {
      'AGENT.md': fs.existsSync(path.join(stateDir, 'AGENT.md')),
      'USER.md': fs.existsSync(path.join(stateDir, 'USER.md')),
      'MEMORY.md': fs.existsSync(path.join(stateDir, 'MEMORY.md')),
    };

    // Scripts
    const scriptsDir = path.join(projectDir, '.claude', 'scripts');
    let scripts: string[] = [];
    if (fs.existsSync(scriptsDir)) {
      try {
        scripts = fs.readdirSync(scriptsDir).filter(f => !f.startsWith('.'));
      } catch { /* permission error, etc. */ }
    }

    // Hooks
    const hooksDir = path.join(stateDir, 'hooks');
    let hooks: string[] = [];
    if (fs.existsSync(hooksDir)) {
      try {
        hooks = fs.readdirSync(hooksDir).filter(f => !f.startsWith('.'));
      } catch { /* permission error, etc. */ }
    }

    // Telegram
    const hasTelegramConfig = ctx.config.messaging.some(m => m.type === 'telegram' && m.enabled);
    const hasTelegramReplyScript = scripts.includes('telegram-reply.sh');
    const telegram = {
      configured: hasTelegramConfig,
      replyScript: hasTelegramReplyScript,
      adapter: !!ctx.telegram,
      bidirectional: hasTelegramConfig && hasTelegramReplyScript && !!ctx.telegram,
    };

    // Jobs
    let jobCount = 0;
    let jobSlugs: string[] = [];
    if (ctx.scheduler) {
      const jobs = ctx.scheduler.getJobs();
      jobCount = jobs.length;
      jobSlugs = jobs.map(j => j.slug);
    }

    // Relationships
    const relationshipsDir = ctx.config.relationships?.relationshipsDir;
    let relationshipCount = 0;
    if (relationshipsDir && fs.existsSync(relationshipsDir)) {
      try {
        relationshipCount = fs.readdirSync(relationshipsDir)
          .filter(f => f.endsWith('.json')).length;
      } catch { /* ignore */ }
    }

    // Users
    let userCount = 0;
    const usersFile = path.join(stateDir, 'users.json');
    if (fs.existsSync(usersFile)) {
      try {
        const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
        if (Array.isArray(users)) userCount = users.length;
      } catch { /* ignore */ }
    }

    res.json({
      project: ctx.config.projectName,
      version: ctx.config.version || '0.0.0',
      port: ctx.config.port,
      identity: identityFiles,
      scripts,
      hooks,
      telegram,
      scheduler: {
        enabled: ctx.config.scheduler.enabled,
        jobCount,
        jobSlugs,
      },
      relationships: {
        enabled: !!ctx.config.relationships,
        count: relationshipCount,
      },
      feedback: {
        enabled: !!ctx.config.feedback?.enabled,
      },
      publishing: {
        enabled: !!ctx.publisher,
        pageCount: ctx.publisher?.listPages().length ?? 0,
        warning: 'Telegraph pages are PUBLIC — anyone with the URL can view them.',
      },
      privateViewer: {
        enabled: !!ctx.viewer,
        viewCount: ctx.viewer?.list().length ?? 0,
      },
      tunnel: {
        enabled: !!ctx.tunnel,
        running: ctx.tunnel?.isRunning ?? false,
        url: ctx.tunnel?.url ?? null,
        type: ctx.config.tunnel?.type ?? null,
      },
      users: {
        count: userCount,
      },
      monitoring: ctx.config.monitoring,
    });
  });

  // ── CI Health ─────────────────────────────────────────────────────
  //
  // On-demand CI status check. Detects GitHub repo from git remote and
  // queries GitHub Actions for recent failures. Agents can use this to
  // check CI health without waiting for the next self-diagnosis cycle.

  router.get('/ci', (_req, res) => {
    const projectDir = ctx.config.projectDir;

    // Detect GitHub repo from git remote
    let repo: string | null = null;
    try {
      const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: projectDir,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      // Extract owner/repo from SSH or HTTPS URL
      const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
      if (match) repo = match[1];
    } catch {
      // Not a git repo or no remote
    }

    if (!repo) {
      res.json({ status: 'unknown', message: 'No GitHub repo detected', runs: [] });
      return;
    }

    // Query recent CI runs
    try {
      const result = execFileSync('gh', [
        'run', 'list', '--repo', repo, '--limit', '5',
        '--json', 'databaseId,conclusion,status,headBranch,name,createdAt',
      ], {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const runs = JSON.parse(result);
      const failures = runs.filter((r: any) => r.conclusion === 'failure');
      const inProgress = runs.filter((r: any) => r.status === 'in_progress');

      res.json({
        repo,
        status: failures.length > 0 ? 'failing' : inProgress.length > 0 ? 'in_progress' : 'passing',
        failureCount: failures.length,
        inProgressCount: inProgress.length,
        runs,
      });
    } catch (err) {
      res.json({
        repo,
        status: 'error',
        message: err instanceof Error ? err.message : 'gh CLI failed',
        runs: [],
      });
    }
  });

  // ── Sessions ────────────────────────────────────────────────────

  // Literal routes BEFORE parameterized routes to avoid capture
  router.get('/sessions/tmux', (_req, res) => {
    try {
      const tmuxPath = ctx.config.sessions.tmuxPath;
      const output = execFileSync(tmuxPath, ['list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const sessions = output
        ? output.split('\n').filter(Boolean).map((name: string) => ({ name }))
        : [];

      res.json({ sessions });
    } catch {
      res.json({ sessions: [] });
    }
  });

  router.get('/sessions', (req, res) => {
    const status = req.query.status as string | undefined;
    const validStatuses = ['starting', 'running', 'completed', 'failed', 'killed'];
    const sessions = status && validStatuses.includes(status)
      ? ctx.state.listSessions({ status: status as 'starting' | 'running' | 'completed' | 'failed' | 'killed' })
      : ctx.state.listSessions();

    res.json(sessions);
  });

  router.get('/sessions/:name/output', (req, res) => {
    if (!SESSION_NAME_RE.test(req.params.name)) {
      res.status(400).json({ error: 'Invalid session name' });
      return;
    }
    const rawLines = parseInt(req.query.lines as string, 10) || 100;
    const lines = Math.min(Math.max(rawLines, 1), 10_000);
    const output = ctx.sessionManager.captureOutput(req.params.name, lines);

    if (output === null) {
      res.status(404).json({ error: `Session "${req.params.name}" not found or not running` });
      return;
    }

    res.json({ session: req.params.name, output });
  });

  router.post('/sessions/:name/input', (req, res) => {
    if (!SESSION_NAME_RE.test(req.params.name)) {
      res.status(400).json({ error: 'Invalid session name' });
      return;
    }
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Request body must include "text" field' });
      return;
    }
    if (text.length > 100_000) {
      res.status(400).json({ error: 'Input text exceeds maximum length (100KB)' });
      return;
    }

    const success = ctx.sessionManager.sendInput(req.params.name, text);
    if (!success) {
      res.status(404).json({ error: `Session "${req.params.name}" not found or not running` });
      return;
    }

    res.json({ ok: true });
  });

  // Rate limit session spawning — each session is a real Claude Code process.
  // Default: 10 spawns per 60 seconds, which is generous for normal use.
  const spawnLimiter = rateLimiter(60_000, 10);
  router.post('/sessions/spawn', spawnLimiter, async (req, res) => {
    const { name, prompt, model, jobSlug } = req.body;

    if (!name || !prompt) {
      res.status(400).json({ error: '"name" and "prompt" are required' });
      return;
    }
    if (typeof name !== 'string' || !SESSION_NAME_RE.test(name)) {
      res.status(400).json({ error: '"name" must contain only letters, numbers, hyphens, underscores (max 200)' });
      return;
    }
    if (typeof prompt !== 'string' || prompt.length > 500_000) {
      res.status(400).json({ error: '"prompt" must be a string under 500KB' });
      return;
    }
    if (model && !['opus', 'sonnet', 'haiku'].includes(model)) {
      res.status(400).json({ error: '"model" must be one of: opus, sonnet, haiku' });
      return;
    }
    if (jobSlug !== undefined && (typeof jobSlug !== 'string' || !JOB_SLUG_RE.test(jobSlug))) {
      res.status(400).json({ error: '"jobSlug" must contain only letters, numbers, hyphens, underscores' });
      return;
    }

    try {
      const session = await ctx.sessionManager.spawnSession({ name, prompt, model, jobSlug });
      res.status(201).json(session);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/sessions/:id', (req, res) => {
    if (!SESSION_NAME_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid session ID format' });
      return;
    }
    try {
      const killed = ctx.sessionManager.killSession(req.params.id);
      if (!killed) {
        res.status(404).json({ error: `Session "${req.params.id}" not found` });
        return;
      }
      res.json({ ok: true, killed: req.params.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Jobs ────────────────────────────────────────────────────────

  router.get('/jobs', (_req, res) => {
    if (!ctx.scheduler) {
      res.json({ jobs: [], scheduler: null });
      return;
    }

    const jobs = ctx.scheduler.getJobs().map(job => {
      const jobState = ctx.state.getJobState(job.slug);
      return { ...job, state: jobState };
    });

    res.json({ jobs, queue: ctx.scheduler.getQueue() });
  });

  router.post('/jobs/:slug/trigger', (req, res) => {
    if (!JOB_SLUG_RE.test(req.params.slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    const rawReason = (req.body?.reason as string) || 'manual';
    const reason = typeof rawReason === 'string' ? rawReason.slice(0, 500) : 'manual';

    try {
      const result = ctx.scheduler.triggerJob(req.params.slug, reason);
      res.json({ slug: req.params.slug, result });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Skip Ledger ──────────────────────────────────────────────────

  router.get('/skip-ledger', (_req, res) => {
    if (!ctx.scheduler) {
      res.json({ sinceHours: 24, summary: {}, totalSkips: 0 });
      return;
    }

    const ledger = ctx.scheduler.getSkipLedger();
    const sinceHours = parseInt(_req.query.sinceHours as string) || 24;
    const slug = _req.query.slug as string | undefined;

    if (slug && !JOB_SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }

    const summary = ledger.getSkipSummary(sinceHours);
    const events = ledger.getSkips({ slug, sinceHours });

    res.json({
      sinceHours,
      summary,
      events: slug ? events : undefined,
      totalSkips: events.length,
    });
  });

  router.get('/skip-ledger/workloads', (_req, res) => {
    if (!ctx.scheduler) {
      res.json({ trends: {} });
      return;
    }

    const ledger = ctx.scheduler.getSkipLedger();
    const slug = _req.query.slug as string | undefined;

    if (slug && !JOB_SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }

    if (slug) {
      const trend = ledger.getWorkloadTrend(slug);
      const signals = ledger.getWorkloads({ slug, limit: 20 });
      res.json({ slug, trend, recentSignals: signals });
    } else {
      const jobs = ctx.scheduler.getJobs();
      const trends: Record<string, ReturnType<typeof ledger.getWorkloadTrend>> = {};
      for (const job of jobs) {
        trends[job.slug] = ledger.getWorkloadTrend(job.slug);
      }
      res.json({ trends });
    }
  });

  router.post('/skip-ledger/workload', (req, res) => {
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    const { slug, duration, skipFast, itemsFound, itemsProcessed, saturation, notes } = req.body;

    if (!slug || typeof slug !== 'string' || !JOB_SLUG_RE.test(slug)) {
      res.status(400).json({ error: '"slug" must be a valid job slug' });
      return;
    }
    if (typeof duration !== 'number' || duration < 0) {
      res.status(400).json({ error: '"duration" must be a non-negative number (seconds)' });
      return;
    }
    if (typeof itemsFound !== 'number' || typeof itemsProcessed !== 'number') {
      res.status(400).json({ error: '"itemsFound" and "itemsProcessed" must be numbers' });
      return;
    }

    const ledger = ctx.scheduler.getSkipLedger();
    ledger.recordWorkload({
      slug,
      timestamp: new Date().toISOString(),
      duration,
      skipFast: !!skipFast,
      itemsFound,
      itemsProcessed,
      saturation: typeof saturation === 'number' ? saturation : (itemsFound > 0 ? itemsProcessed / itemsFound : 0),
      notes: typeof notes === 'string' ? notes.slice(0, 500) : undefined,
    });

    res.status(201).json({ recorded: true, slug });
  });

  // ── Telegram ────────────────────────────────────────────────────

  router.get('/telegram/topics', (_req, res) => {
    if (!ctx.telegram) {
      res.json({ topics: [] });
      return;
    }
    res.json({ topics: ctx.telegram.getAllTopicMappings() });
  });

  router.post('/telegram/topics', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const { name, color } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      res.status(400).json({ error: '"name" is required (non-empty string)' });
      return;
    }
    if (name.length > 128) {
      res.status(400).json({ error: '"name" must be 128 characters or fewer' });
      return;
    }

    // Color is optional — defaults to green (9367192)
    const iconColor = typeof color === 'number' ? color : 9367192;

    try {
      const topic = await ctx.telegram.createForumTopic(name.trim(), iconColor);
      res.status(201).json({
        topicId: topic.topicId,
        name: name.trim(),
        created: true,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/telegram/reply/:topicId', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const topicId = parseInt(req.params.topicId, 10);
    if (isNaN(topicId)) {
      res.status(400).json({ error: 'topicId must be a number' });
      return;
    }
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: '"text" field required' });
      return;
    }
    if (text.length > 4096) {
      res.status(400).json({ error: '"text" must be 4096 characters or fewer' });
      return;
    }

    try {
      await ctx.telegram.sendToTopic(topicId, text);
      res.json({ ok: true, topicId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/telegram/topics/:topicId/messages', (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const topicId = parseInt(req.params.topicId, 10);
    if (isNaN(topicId)) {
      res.status(400).json({ error: 'topicId must be a number' });
      return;
    }

    const limit = parseInt(req.query.limit as string, 10) || 20;
    const messages = ctx.telegram.getTopicHistory(topicId, Math.min(limit, 100));
    res.json({ topicId, messages });
  });

  // ── Message Log Search ──────────────────────────────────────────

  router.get('/telegram/search', (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const query = req.query.q as string | undefined;
    const topicId = req.query.topicId ? parseInt(req.query.topicId as string, 10) : undefined;
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const rawLimit = parseInt(req.query.limit as string, 10) || 50;
    const limit = Math.min(Math.max(rawLimit, 1), 500);

    if (topicId !== undefined && isNaN(topicId)) {
      res.status(400).json({ error: 'topicId must be a number' });
      return;
    }
    if (since !== undefined && isNaN(since.getTime())) {
      res.status(400).json({ error: 'since must be a valid ISO date' });
      return;
    }

    const results = ctx.telegram.searchLog({ query, topicId, since, limit });
    res.json({ results, count: results.length });
  });

  router.get('/telegram/log-stats', (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    res.json(ctx.telegram.getLogStats());
  });

  // ── Attention Queue ─────────────────────────────────────────────

  router.post('/attention', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const { id, title, summary, category, priority, description, sourceContext } = req.body;
    if (!id || typeof id !== 'string' || id.length > 200) {
      res.status(400).json({ error: '"id" must be a string under 200 characters' });
      return;
    }
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!summary || typeof summary !== 'string' || summary.length > 2000) {
      res.status(400).json({ error: '"summary" must be a string under 2000 characters' });
      return;
    }
    if (priority !== undefined && !['URGENT', 'HIGH', 'NORMAL', 'LOW'].includes(priority)) {
      res.status(400).json({ error: '"priority" must be one of: URGENT, HIGH, NORMAL, LOW' });
      return;
    }

    try {
      const item = await ctx.telegram.createAttentionItem({
        id,
        title,
        summary,
        category: category || 'general',
        priority: priority || 'NORMAL',
        description: description || undefined,
        sourceContext: sourceContext || undefined,
      });
      res.status(201).json(item);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/attention', (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const status = req.query.status as string | undefined;
    const items = ctx.telegram.getAttentionItems(status);
    res.json({ items, count: items.length });
  });

  router.get('/attention/:id', (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const item = ctx.telegram.getAttentionItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Attention item not found' });
      return;
    }
    res.json(item);
  });

  router.patch('/attention/:id', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const { status } = req.body;
    const validStatuses = ['OPEN', 'ACKNOWLEDGED', 'DONE', 'WONT_DO'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: `"status" must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const success = await ctx.telegram.updateAttentionStatus(req.params.id, status);
    if (!success) {
      res.status(404).json({ error: 'Attention item not found' });
      return;
    }

    const item = ctx.telegram.getAttentionItem(req.params.id);
    res.json(item);
  });

  // ── Relationships ─────────────────────────────────────────────────

  router.get('/relationships', (req, res) => {
    if (!ctx.relationships) {
      res.json({ relationships: [] });
      return;
    }
    const rawSort = req.query.sort as string;
    const sortBy = VALID_SORTS.includes(rawSort as typeof VALID_SORTS[number])
      ? (rawSort as typeof VALID_SORTS[number])
      : 'significance';
    res.json({ relationships: ctx.relationships.getAll(sortBy) });
  });

  // Stale must be before :id to avoid "stale" matching as a param
  router.get('/relationships/stale', (req, res) => {
    if (!ctx.relationships) {
      res.json({ stale: [] });
      return;
    }
    const days = parseInt(req.query.days as string, 10) || 14;
    res.json({ stale: ctx.relationships.getStaleRelationships(days) });
  });

  router.get('/relationships/:id', (req, res) => {
    if (!ctx.relationships) {
      res.status(503).json({ error: 'Relationships not configured' });
      return;
    }
    const record = ctx.relationships.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Relationship not found' });
      return;
    }
    res.json(record);
  });

  router.delete('/relationships/:id', (req, res) => {
    if (!ctx.relationships) {
      res.status(503).json({ error: 'Relationships not configured' });
      return;
    }
    const deleted = ctx.relationships.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Relationship not found' });
      return;
    }
    res.json({ ok: true, deleted: req.params.id });
  });

  router.get('/relationships/:id/context', (req, res) => {
    if (!ctx.relationships) {
      res.status(503).json({ error: 'Relationships not configured' });
      return;
    }
    const context = ctx.relationships.getContextForPerson(req.params.id);
    if (!context) {
      res.status(404).json({ error: 'Relationship not found' });
      return;
    }
    res.json({ context });
  });

  // Import relationships from Portal people-registry export (PROP-166)
  router.post('/relationships/import', (req, res) => {
    if (!ctx.relationships) {
      res.status(503).json({ error: 'Relationships not configured' });
      return;
    }

    const records = req.body;
    if (!Array.isArray(records)) {
      res.status(400).json({ error: 'Expected a JSON array of relationship records' });
      return;
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const rec of records) {
      const name = rec?.name as string;
      const channels = (rec?.channels || []) as Array<{ type: string; identifier: string }>;
      if (!name || !channels.length) {
        skipped++;
        continue;
      }

      // Try to resolve by any channel
      let existing = null;
      for (const channel of channels) {
        existing = ctx.relationships!.resolveByChannel(channel);
        if (existing) break;
      }

      if (existing) {
        for (const channel of channels) {
          ctx.relationships!.linkChannel(existing.id, channel);
        }
        const importNotes = rec.notes as string | undefined;
        if (importNotes && importNotes.length > (existing.notes || '').length) {
          ctx.relationships!.updateNotes(existing.id, importNotes);
        }
        updated++;
      } else {
        const record = ctx.relationships!.findOrCreate(name, channels[0]);
        for (let i = 1; i < channels.length; i++) {
          ctx.relationships!.linkChannel(record.id, channels[i]);
        }
        if (rec.notes) {
          ctx.relationships!.updateNotes(record.id, rec.notes as string);
        }
        const themes = (rec.themes || []) as string[];
        if (themes.length > 0) {
          ctx.relationships!.recordInteraction(record.id, {
            timestamp: new Date().toISOString(),
            channel: channels[0].type,
            summary: `Imported from Portal people-registry with ${themes.length} themes`,
            topics: themes,
          });
        }
        created++;
      }
    }

    res.json({ ok: true, created, updated, skipped, total: created + updated });
  });

  // ── Feedback ────────────────────────────────────────────────────

  router.post('/feedback', async (req, res) => {
    if (!ctx.feedback) {
      res.status(503).json({ error: 'Feedback not configured' });
      return;
    }

    const { type, title, description, context } = req.body;
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!description || typeof description !== 'string' || description.length > 10_000) {
      res.status(400).json({ error: '"description" must be a string under 10KB' });
      return;
    }
    if (context !== undefined && (typeof context !== 'string' || context.length > 5_000)) {
      res.status(400).json({ error: '"context" must be a string under 5KB if provided' });
      return;
    }

    const validTypes = ['bug', 'feature', 'improvement', 'question', 'other'];
    const feedbackType = validTypes.includes(type) ? type : 'other';

    try {
      const item = await ctx.feedback.submit({
        type: feedbackType,
        title,
        description,
        context: context || undefined,
        agentName: ctx.config.projectName,
        instarVersion: ctx.config.version || '0.0.0',
        nodeVersion: process.version,
        os: `${process.platform} ${process.arch}`,
      });

      res.status(201).json({
        ok: true,
        id: item.id,
        forwarded: item.forwarded,
        message: item.forwarded
          ? 'Feedback submitted and forwarded upstream.'
          : 'Feedback stored locally. Will retry forwarding later.',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/feedback', (_req, res) => {
    if (!ctx.feedback) {
      res.json({ feedback: [] });
      return;
    }
    res.json({ feedback: ctx.feedback.list() });
  });

  router.post('/feedback/retry', async (_req, res) => {
    if (!ctx.feedback) {
      res.status(503).json({ error: 'Feedback not configured' });
      return;
    }

    try {
      const result = await ctx.feedback.retryUnforwarded();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Updates ────────────────────────────────────────────────────

  router.get('/updates', async (_req, res) => {
    if (!ctx.updateChecker) {
      res.status(503).json({ error: 'Update checker not configured' });
      return;
    }

    try {
      const info = await ctx.updateChecker.check();
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/updates/last', (_req, res) => {
    if (!ctx.updateChecker) {
      res.status(503).json({ error: 'Update checker not configured' });
      return;
    }

    const lastCheck = ctx.updateChecker.getLastCheck();
    if (!lastCheck) {
      res.json({ message: 'No update check has been performed yet' });
      return;
    }
    res.json(lastCheck);
  });

  router.get('/updates/config', (_req, res) => {
    res.json({
      autoApply: ctx.config.updates?.autoApply ?? false,
    });
  });

  router.post('/updates/apply', async (_req, res) => {
    if (!ctx.updateChecker) {
      res.status(503).json({ error: 'Update checker not configured' });
      return;
    }

    try {
      const result = await ctx.updateChecker.applyUpdate();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/updates/rollback', async (_req, res) => {
    if (!ctx.updateChecker) {
      res.status(503).json({ error: 'Update checker not configured' });
      return;
    }

    if (!ctx.updateChecker.canRollback()) {
      res.status(409).json({
        error: 'No rollback available. A successful update must have occurred first.',
      });
      return;
    }

    try {
      const result = await ctx.updateChecker.rollback();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Auto-Updater ────────────────────────────────────────────────

  router.get('/updates/auto', (_req, res) => {
    if (!ctx.autoUpdater) {
      res.status(503).json({ error: 'Auto-updater not configured' });
      return;
    }
    res.json(ctx.autoUpdater.getStatus());
  });

  // ── Dispatches ───────────────────────────────────────────────────

  router.get('/dispatches', async (_req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    try {
      // Use checkAndAutoApply when autoApply is configured
      const result = ctx.config.dispatches?.autoApply
        ? await ctx.dispatches.checkAndAutoApply()
        : await ctx.dispatches.check();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/dispatches/pending', (_req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    res.json({ dispatches: ctx.dispatches.pending() });
  });

  router.get('/dispatches/context', (_req, res) => {
    if (!ctx.dispatches) {
      res.json({ context: '' });
      return;
    }

    res.json({ context: ctx.dispatches.generateContext() });
  });

  router.post('/dispatches/:id/apply', (req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    const success = ctx.dispatches.applyToContext(req.params.id);
    if (success) {
      res.json({ applied: true, contextFile: ctx.dispatches.getContextFilePath() });
    } else {
      res.status(404).json({ error: 'Dispatch not found' });
    }
  });

  router.post('/dispatches/:id/evaluate', (req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    const { decision, reason } = req.body as { decision?: string; reason?: string };
    const validDecisions = ['accepted', 'rejected', 'deferred'];

    if (!decision || !validDecisions.includes(decision)) {
      res.status(400).json({ error: `"decision" must be one of: ${validDecisions.join(', ')}` });
      return;
    }
    if (!reason || typeof reason !== 'string' || reason.length < 1) {
      res.status(400).json({ error: '"reason" must be a non-empty string' });
      return;
    }
    if (reason.length > 2000) {
      res.status(400).json({ error: '"reason" must be under 2000 characters' });
      return;
    }

    const success = ctx.dispatches.evaluate(
      req.params.id,
      decision as 'accepted' | 'rejected' | 'deferred',
      reason,
    );

    if (!success) {
      res.status(404).json({ error: 'Dispatch not found' });
      return;
    }

    // If accepted, also apply to context file
    if (decision === 'accepted') {
      ctx.dispatches.applyToContext(req.params.id);
    }

    res.json({ evaluated: true, decision });
  });

  router.get('/dispatches/applied', (_req, res) => {
    if (!ctx.dispatches) {
      res.json({ context: '', contextFile: '' });
      return;
    }

    res.json({
      context: ctx.dispatches.readContextFile(),
      contextFile: ctx.dispatches.getContextFilePath(),
    });
  });

  router.post('/dispatches/:id/feedback', async (req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    const { helpful, comment } = req.body as { helpful?: boolean; comment?: string };

    if (typeof helpful !== 'boolean') {
      res.status(400).json({ error: '"helpful" must be a boolean' });
      return;
    }
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > 2000)) {
      res.status(400).json({ error: '"comment" must be a string under 2000 characters' });
      return;
    }

    const success = ctx.dispatches.recordFeedback(req.params.id, helpful, comment);
    if (!success) {
      res.status(404).json({ error: 'Dispatch not found' });
      return;
    }

    // Also forward to FeedbackManager for upstream delivery to Dawn
    if (ctx.feedback) {
      const dispatch = ctx.dispatches.get(req.params.id);
      try {
        await ctx.feedback.submit({
          type: 'improvement',
          title: `Dispatch feedback: ${dispatch?.title ?? req.params.id}`,
          description: `Dispatch ${req.params.id} was ${helpful ? 'helpful' : 'not helpful'}.${comment ? ` Comment: ${comment}` : ''}`,
          agentName: ctx.config.projectName,
          instarVersion: ctx.config.version ?? '0.0.0',
          nodeVersion: process.version,
          os: process.platform,
          context: JSON.stringify({
            dispatchId: req.params.id,
            dispatchType: dispatch?.type,
            helpful,
            comment,
          }),
        });
      } catch {
        // Don't fail the response if feedback forwarding fails
      }
    }

    res.json({ recorded: true, helpful });
  });

  router.get('/dispatches/stats', (_req, res) => {
    if (!ctx.dispatches) {
      res.json({
        total: 0, applied: 0, pending: 0, rejected: 0,
        helpfulCount: 0, unhelpfulCount: 0, byType: {},
      });
      return;
    }

    res.json(ctx.dispatches.stats());
  });

  // ── Quota ──────────────────────────────────────────────────────

  router.get('/quota', (_req, res) => {
    if (!ctx.quotaTracker) {
      res.json({ status: 'not_configured', usagePercent: null });
      return;
    }
    const state = ctx.quotaTracker.getState();
    res.json({
      status: state ? 'ok' : 'no_data',
      ...(state ?? {}),
      recommendation: ctx.quotaTracker.getRecommendation(),
    });
  });

  // ── Publishing (Telegraph) ──────────────────────────────────────

  router.post('/publish', async (req, res) => {
    if (!ctx.publisher) {
      res.status(503).json({ error: 'Publishing not configured' });
      return;
    }

    const { title, markdown } = req.body;
    if (!title || typeof title !== 'string' || title.length > 256) {
      res.status(400).json({ error: '"title" must be a string under 256 characters' });
      return;
    }
    if (!markdown || typeof markdown !== 'string') {
      res.status(400).json({ error: '"markdown" must be a non-empty string' });
      return;
    }
    if (markdown.length > 100_000) {
      res.status(400).json({ error: '"markdown" must be under 100KB' });
      return;
    }

    try {
      const page = await ctx.publisher.publishPage(title, markdown);
      res.status(201).json({
        ...page,
        warning: 'This page is PUBLIC. Anyone with the URL can view it.',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/published', (_req, res) => {
    if (!ctx.publisher) {
      res.json({ pages: [] });
      return;
    }

    res.json({ pages: ctx.publisher.listPages() });
  });

  router.put('/publish/:path', async (req, res) => {
    if (!ctx.publisher) {
      res.status(503).json({ error: 'Publishing not configured' });
      return;
    }

    const pagePath = req.params.path;
    if (!pagePath || pagePath.length > 256) {
      res.status(400).json({ error: 'Invalid page path' });
      return;
    }

    const { title, markdown } = req.body;
    if (!title || typeof title !== 'string' || title.length > 256) {
      res.status(400).json({ error: '"title" must be a string under 256 characters' });
      return;
    }
    if (!markdown || typeof markdown !== 'string') {
      res.status(400).json({ error: '"markdown" must be a non-empty string' });
      return;
    }
    if (markdown.length > 100_000) {
      res.status(400).json({ error: '"markdown" must be under 100KB' });
      return;
    }

    try {
      const page = await ctx.publisher.editPage(pagePath, title, markdown);
      res.json(page);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Private Views (auth-gated rendered markdown) ────────────────

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  /** Build a browser-clickable tunnel URL with HMAC signature for auth */
  function viewTunnelUrl(viewId: string): string | null {
    const base = ctx.tunnel?.getExternalUrl(`/view/${viewId}`);
    if (!base) return null;
    if (ctx.config.authToken) {
      const viewPath = `/view/${viewId}`;
      const sig = signViewPath(viewPath, ctx.config.authToken);
      return `${base}?sig=${sig}`;
    }
    return base;
  }

  router.post('/view', (req, res) => {
    if (!ctx.viewer) {
      res.status(503).json({ error: 'Private viewer not configured' });
      return;
    }

    const { title, markdown, pin } = req.body;
    if (!title || typeof title !== 'string' || title.length > 256) {
      res.status(400).json({ error: '"title" must be a string under 256 characters' });
      return;
    }
    if (!markdown || typeof markdown !== 'string') {
      res.status(400).json({ error: '"markdown" must be a non-empty string' });
      return;
    }
    if (markdown.length > 500_000) {
      res.status(400).json({ error: '"markdown" must be under 500KB' });
      return;
    }
    if (pin !== undefined && (typeof pin !== 'string' || pin.length < 4 || pin.length > 32)) {
      res.status(400).json({ error: '"pin" must be a string between 4 and 32 characters' });
      return;
    }

    const view = ctx.viewer.create(title, markdown, pin);

    res.status(201).json({
      id: view.id,
      title: view.title,
      pinProtected: !!view.pinHash,
      localUrl: `/view/${view.id}`,
      tunnelUrl: viewTunnelUrl(view.id),
      createdAt: view.createdAt,
    });
  });

  router.get('/view/:id', (req, res) => {
    if (!ctx.viewer) {
      res.status(503).json({ error: 'Private viewer not configured' });
      return;
    }

    if (!UUID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid view ID' });
      return;
    }

    const view = ctx.viewer.get(req.params.id);
    if (!view) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    // PIN-protected views show PIN entry page
    if (view.pinHash) {
      const html = ctx.viewer.renderPinPage(view);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
      return;
    }

    // Serve rendered HTML
    const html = ctx.viewer.renderHtml(view);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  router.post('/view/:id/unlock', (req, res) => {
    if (!ctx.viewer) {
      res.status(503).json({ error: 'Private viewer not configured' });
      return;
    }

    if (!UUID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid view ID' });
      return;
    }

    const view = ctx.viewer.get(req.params.id);
    if (!view) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    if (!view.pinHash) {
      // No PIN needed — return content directly
      const html = ctx.viewer.renderHtml(view);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
      return;
    }

    const { pin } = req.body;
    if (!pin || typeof pin !== 'string') {
      res.status(400).json({ error: '"pin" is required' });
      return;
    }

    if (!ctx.viewer.verifyPin(req.params.id, pin)) {
      res.status(403).json({ error: 'Incorrect PIN' });
      return;
    }

    const html = ctx.viewer.renderHtml(view);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  router.get('/views', (_req, res) => {
    if (!ctx.viewer) {
      res.json({ views: [] });
      return;
    }

    const views = ctx.viewer.list().map(v => ({
      id: v.id,
      title: v.title,
      localUrl: `/view/${v.id}`,
      tunnelUrl: viewTunnelUrl(v.id),
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    }));
    res.json({ views });
  });

  router.put('/view/:id', (req, res) => {
    if (!ctx.viewer) {
      res.status(503).json({ error: 'Private viewer not configured' });
      return;
    }

    if (!UUID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid view ID' });
      return;
    }

    const { title, markdown } = req.body;
    if (!title || typeof title !== 'string' || title.length > 256) {
      res.status(400).json({ error: '"title" must be a string under 256 characters' });
      return;
    }
    if (!markdown || typeof markdown !== 'string') {
      res.status(400).json({ error: '"markdown" must be a non-empty string' });
      return;
    }

    const updated = ctx.viewer.update(req.params.id, title, markdown);
    if (!updated) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    res.json({
      id: updated.id,
      title: updated.title,
      localUrl: `/view/${updated.id}`,
      tunnelUrl: viewTunnelUrl(updated.id),
      updatedAt: updated.updatedAt,
    });
  });

  router.delete('/view/:id', (req, res) => {
    if (!ctx.viewer) {
      res.status(503).json({ error: 'Private viewer not configured' });
      return;
    }

    if (!UUID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid view ID' });
      return;
    }

    const deleted = ctx.viewer.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    res.json({ ok: true, deleted: req.params.id });
  });

  // ── Tunnel Status ──────────────────────────────────────────────

  router.get('/tunnel', (_req, res) => {
    if (!ctx.tunnel) {
      res.json({ enabled: false, url: null });
      return;
    }

    res.json({
      enabled: true,
      running: ctx.tunnel.isRunning,
      ...ctx.tunnel.state,
    });
  });

  // ── Events ──────────────────────────────────────────────────────

  router.get('/events', (req, res) => {
    const rawLimit = parseInt(req.query.limit as string, 10) || 50;
    const limit = Math.min(Math.max(rawLimit, 1), 1000);
    const rawType = req.query.type as string | undefined;
    const type = rawType && rawType.length <= 64 ? rawType : undefined;
    const rawSinceHours = parseInt(req.query.since as string, 10) || 24;
    const sinceHours = Math.min(Math.max(rawSinceHours, 1), 720); // 1h to 30 days

    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    const events = ctx.state.queryEvents({ since, type, limit });

    res.json(events);
  });

  // ── Internal: Lifeline Telegram Forward ─────────────────────────
  // Receives messages from the Telegram Lifeline process and injects
  // them into the appropriate session, just like TelegramAdapter would.

  router.post('/internal/telegram-forward', (req, res) => {
    const { topicId, text, fromUserId, fromUsername, fromFirstName, messageId } = req.body;

    if (!topicId || !text) {
      res.status(400).json({ error: 'topicId and text required' });
      return;
    }

    // Build a Message object and fire the onTopicMessage callback
    if (ctx.telegram?.onTopicMessage) {
      const message = {
        id: `tg-${messageId || Date.now()}`,
        userId: String(fromUserId || 'unknown'),
        content: text,
        channel: { type: 'telegram', identifier: String(topicId) },
        receivedAt: new Date().toISOString(),
        metadata: {
          telegramUserId: fromUserId,
          username: fromUsername,
          firstName: fromFirstName,
          messageThreadId: topicId,
          viaLifeline: true,
        },
      };

      try {
        ctx.telegram.onTopicMessage(message);
        res.json({ ok: true, forwarded: true });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } else if (ctx.sessionManager) {
      // No telegram adapter with routing — inject directly into any mapped session
      ctx.sessionManager.injectTelegramMessage(
        `${ctx.config.projectName}-interface`,
        topicId,
        text,
      );
      res.json({ ok: true, forwarded: true, method: 'direct-inject' });
    } else {
      res.status(503).json({ error: 'No message routing available' });
    }
  });

  // ── Evolution System ───────────────────────────────────────────

  // Dashboard — overview of all evolution subsystems
  router.get('/evolution', (_req, res) => {
    if (!ctx.evolution) {
      res.json({ enabled: false });
      return;
    }
    res.json({ enabled: true, ...ctx.evolution.getDashboard() });
  });

  // Evolution proposals
  router.get('/evolution/proposals', (req, res) => {
    if (!ctx.evolution) { res.json({ proposals: [] }); return; }
    const status = req.query.status as EvolutionStatus | undefined;
    const type = req.query.type as EvolutionType | undefined;
    res.json({ proposals: ctx.evolution.listProposals({ status, type }) });
  });

  router.post('/evolution/proposals', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { title, source, description, type, impact, effort, proposedBy, tags } = req.body;
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!description || typeof description !== 'string' || description.length > 10_000) {
      res.status(400).json({ error: '"description" must be a string under 10KB' });
      return;
    }
    const validTypes = ['capability', 'infrastructure', 'voice', 'workflow', 'philosophy', 'integration', 'performance'];
    if (type && !validTypes.includes(type)) {
      res.status(400).json({ error: `"type" must be one of: ${validTypes.join(', ')}` });
      return;
    }
    const proposal = ctx.evolution.addProposal({
      title, source: source || 'api', description,
      type: type || 'capability', impact, effort, proposedBy, tags,
    });
    res.status(201).json(proposal);
  });

  router.patch('/evolution/proposals/:id', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { status, resolution } = req.body;
    const validStatuses = ['proposed', 'approved', 'in_progress', 'implemented', 'rejected', 'deferred'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: `"status" must be one of: ${validStatuses.join(', ')}` });
      return;
    }
    const success = ctx.evolution.updateProposalStatus(req.params.id, status, resolution);
    if (!success) {
      res.status(404).json({ error: 'Proposal not found' });
      return;
    }
    res.json({ ok: true, id: req.params.id, status });
  });

  // Learning registry
  router.get('/evolution/learnings', (req, res) => {
    if (!ctx.evolution) { res.json({ learnings: [] }); return; }
    const category = req.query.category as string | undefined;
    const applied = req.query.applied !== undefined ? req.query.applied === 'true' : undefined;
    res.json({ learnings: ctx.evolution.listLearnings({ category, applied }) });
  });

  router.post('/evolution/learnings', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { title, category, description, source, tags, evolutionRelevance } = req.body;
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!description || typeof description !== 'string') {
      res.status(400).json({ error: '"description" is required' });
      return;
    }
    const learning = ctx.evolution.addLearning({
      title, category: category || 'general', description,
      source: source || { discoveredAt: new Date().toISOString() },
      tags, evolutionRelevance,
    });
    res.status(201).json(learning);
  });

  router.patch('/evolution/learnings/:id/apply', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { appliedTo } = req.body;
    if (!appliedTo || typeof appliedTo !== 'string') {
      res.status(400).json({ error: '"appliedTo" is required' });
      return;
    }
    const success = ctx.evolution.markLearningApplied(req.params.id, appliedTo);
    if (!success) {
      res.status(404).json({ error: 'Learning not found' });
      return;
    }
    res.json({ ok: true, id: req.params.id, appliedTo });
  });

  // Capability gaps
  router.get('/evolution/gaps', (req, res) => {
    if (!ctx.evolution) { res.json({ gaps: [] }); return; }
    const severity = req.query.severity as string | undefined;
    const category = req.query.category as GapCategory | undefined;
    const status = req.query.status as string | undefined;
    res.json({ gaps: ctx.evolution.listGaps({ severity, category, status }) });
  });

  router.post('/evolution/gaps', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { title, category, severity, description, context, platform, session, currentState, proposedSolution } = req.body;
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!description || typeof description !== 'string') {
      res.status(400).json({ error: '"description" is required' });
      return;
    }
    const validSeverities = ['critical', 'high', 'medium', 'low'];
    if (severity && !validSeverities.includes(severity)) {
      res.status(400).json({ error: `"severity" must be one of: ${validSeverities.join(', ')}` });
      return;
    }
    const gap = ctx.evolution.addGap({
      title, category: category || 'custom', severity: severity || 'medium',
      description, context: context || '', platform, session,
      currentState, proposedSolution,
    });
    res.status(201).json(gap);
  });

  router.patch('/evolution/gaps/:id/address', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { resolution } = req.body;
    if (!resolution || typeof resolution !== 'string') {
      res.status(400).json({ error: '"resolution" is required' });
      return;
    }
    const success = ctx.evolution.addressGap(req.params.id, resolution);
    if (!success) {
      res.status(404).json({ error: 'Gap not found' });
      return;
    }
    res.json({ ok: true, id: req.params.id, status: 'addressed' });
  });

  // Action queue
  router.get('/evolution/actions', (req, res) => {
    if (!ctx.evolution) { res.json({ actions: [] }); return; }
    const status = req.query.status as 'pending' | 'in_progress' | 'completed' | 'cancelled' | undefined;
    const priority = req.query.priority as string | undefined;
    res.json({ actions: ctx.evolution.listActions({ status, priority }) });
  });

  router.get('/evolution/actions/overdue', (_req, res) => {
    if (!ctx.evolution) { res.json({ overdue: [] }); return; }
    res.json({ overdue: ctx.evolution.getOverdueActions() });
  });

  router.post('/evolution/actions', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { title, description, priority, commitTo, dueBy, source, tags } = req.body;
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!description || typeof description !== 'string') {
      res.status(400).json({ error: '"description" is required' });
      return;
    }
    const action = ctx.evolution.addAction({
      title, description, priority, commitTo, dueBy, source, tags,
    });
    res.status(201).json(action);
  });

  router.patch('/evolution/actions/:id', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { status, resolution } = req.body;
    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
    if (status && !validStatuses.includes(status)) {
      res.status(400).json({ error: `"status" must be one of: ${validStatuses.join(', ')}` });
      return;
    }
    const success = ctx.evolution.updateAction(req.params.id, { status, resolution });
    if (!success) {
      res.status(404).json({ error: 'Action not found' });
      return;
    }
    res.json({ ok: true, id: req.params.id, status });
  });

  return router;
}

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
