/**
 * HTTP API routes — health, status, sessions, jobs, events.
 *
 * Extracted/simplified from Dawn's 2267-line routes.ts.
 * All the observability you need, none of the complexity you don't.
 */

import { Router } from 'express';
import { execFileSync } from 'node:child_process';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { AgentKitConfig } from '../core/types.js';
import { rateLimiter } from './middleware.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { RelationshipManager } from '../core/RelationshipManager.js';
import type { FeedbackManager } from '../core/FeedbackManager.js';
import type { UpdateChecker } from '../core/UpdateChecker.js';
import type { QuotaTracker } from '../monitoring/QuotaTracker.js';

interface RouteContext {
  config: AgentKitConfig;
  sessionManager: SessionManager;
  state: StateManager;
  scheduler: JobScheduler | null;
  telegram: TelegramAdapter | null;
  relationships: RelationshipManager | null;
  feedback: FeedbackManager | null;
  updateChecker: UpdateChecker | null;
  quotaTracker: QuotaTracker | null;
  startTime: Date;
}

export function createRoutes(ctx: RouteContext): Router {
  const router = Router();

  // ── Health ──────────────────────────────────────────────────────

  router.get('/health', (_req, res) => {
    const uptimeMs = Date.now() - ctx.startTime.getTime();
    const mem = process.memoryUsage();
    res.json({
      status: 'ok',
      uptime: uptimeMs,
      uptimeHuman: formatUptime(uptimeMs),
      version: ctx.config.version || '0.0.0',
      project: ctx.config.projectName,
      node: process.version,
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
    });
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
    const lines = parseInt(req.query.lines as string, 10) || 100;
    const output = ctx.sessionManager.captureOutput(req.params.name, lines);

    if (output === null) {
      res.status(404).json({ error: `Session "${req.params.name}" not found or not running` });
      return;
    }

    res.json({ session: req.params.name, output });
  });

  router.post('/sessions/:name/input', (req, res) => {
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
    if (typeof name !== 'string' || name.length > 200) {
      res.status(400).json({ error: '"name" must be a string under 200 characters' });
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

    try {
      const session = await ctx.sessionManager.spawnSession({ name, prompt, model, jobSlug });
      res.status(201).json(session);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/sessions/:id', (req, res) => {
    try {
      const killed = ctx.sessionManager.killSession(req.params.id);
      if (!killed) {
        res.status(404).json({ error: `Session "${req.params.id}" not found` });
        return;
      }
      res.json({ ok: true, killed: req.params.id });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
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
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    const reason = (req.body?.reason as string) || 'manual';

    try {
      const result = ctx.scheduler.triggerJob(req.params.slug, reason);
      res.json({ slug: req.params.slug, result });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Telegram ────────────────────────────────────────────────────

  router.get('/telegram/topics', (_req, res) => {
    if (!ctx.telegram) {
      res.json({ topics: [] });
      return;
    }
    res.json({ topics: ctx.telegram.getAllTopicMappings() });
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

  // ── Relationships ─────────────────────────────────────────────────

  router.get('/relationships', (_req, res) => {
    if (!ctx.relationships) {
      res.json({ relationships: [] });
      return;
    }
    const sortBy = (_req.query.sort as 'significance' | 'recent' | 'name') || 'significance';
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

  // ── Feedback ────────────────────────────────────────────────────

  router.post('/feedback', async (req, res) => {
    if (!ctx.feedback) {
      res.status(503).json({ error: 'Feedback not configured' });
      return;
    }

    const { type, title, description, context } = req.body;
    if (!title || !description) {
      res.status(400).json({ error: '"title" and "description" are required' });
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

  // ── Events ──────────────────────────────────────────────────────

  router.get('/events', (req, res) => {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const type = req.query.type as string | undefined;
    const sinceHours = parseInt(req.query.since as string, 10) || 24;

    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    const events = ctx.state.queryEvents({ since, type, limit });

    res.json(events);
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
