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
import os from 'node:os';
import path from 'node:path';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { InstarConfig } from '../core/types.js';
import { rateLimiter, signViewPath } from './middleware.js';
import type { WriteOperation, WriteToken } from '../core/StateWriteAuthority.js';
import { validateWriteToken, canPerformOperation } from '../core/StateWriteAuthority.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { RelationshipManager } from '../core/RelationshipManager.js';
import type { FeedbackManager } from '../core/FeedbackManager.js';
import type { DispatchManager } from '../core/DispatchManager.js';
import type { UpdateChecker } from '../core/UpdateChecker.js';
import type { AutoUpdater } from '../core/AutoUpdater.js';
import type { AutoDispatcher } from '../core/AutoDispatcher.js';
import type { QuotaTracker } from '../monitoring/QuotaTracker.js';
import type { TelegraphService } from '../publishing/TelegraphService.js';
import type { PrivateViewer } from '../publishing/PrivateViewer.js';
import type { TunnelManager } from '../tunnel/TunnelManager.js';
import type { EvolutionManager } from '../core/EvolutionManager.js';
import type { EvolutionStatus, EvolutionType, GapCategory } from '../core/types.js';
import type { SessionWatchdog } from '../monitoring/SessionWatchdog.js';
import type { StallTriageNurse } from '../monitoring/StallTriageNurse.js';
import type { OrphanProcessReaper } from '../monitoring/OrphanProcessReaper.js';
import type { TopicMemory } from '../memory/TopicMemory.js';
import type { FeedbackAnomalyDetector } from '../monitoring/FeedbackAnomalyDetector.js';
import type { ProjectMapper } from '../core/ProjectMapper.js';
import type { CoherenceGate } from '../core/CoherenceGate.js';
import type { HighRiskAction } from '../core/CoherenceGate.js';
import type { ContextHierarchy } from '../core/ContextHierarchy.js';
import type { CanonicalState } from '../core/CanonicalState.js';
import type { ExternalOperationGate } from '../core/ExternalOperationGate.js';
import type { OperationMutability, OperationReversibility } from '../core/ExternalOperationGate.js';
import type { MessageSentinel } from '../core/MessageSentinel.js';
import type { AdaptiveTrust } from '../core/AdaptiveTrust.js';
import type { MemoryPressureMonitor } from '../monitoring/MemoryPressureMonitor.js';

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
  autoDispatcher: AutoDispatcher | null;
  quotaTracker: QuotaTracker | null;
  publisher: TelegraphService | null;
  viewer: PrivateViewer | null;
  tunnel: TunnelManager | null;
  evolution: EvolutionManager | null;
  watchdog: SessionWatchdog | null;
  triageNurse: StallTriageNurse | null;
  topicMemory: TopicMemory | null;
  feedbackAnomalyDetector: FeedbackAnomalyDetector | null;
  projectMapper: ProjectMapper | null;
  coherenceGate: CoherenceGate | null;
  contextHierarchy: ContextHierarchy | null;
  canonicalState: CanonicalState | null;
  operationGate: ExternalOperationGate | null;
  sentinel: MessageSentinel | null;
  adaptiveTrust: AdaptiveTrust | null;
  memoryMonitor: MemoryPressureMonitor | null;
  orphanReaper: OrphanProcessReaper | null;
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
    // Determine if anything is degraded
    const sessions = ctx.sessionManager.listRunningSessions();
    const maxSessions = ctx.config.sessions?.maxSessions ?? 3;
    const sessionExhausted = sessions.length >= maxSessions;

    let totalFailures = 0;
    if (ctx.scheduler) {
      const jobs = ctx.scheduler.getJobs();
      for (const j of jobs) {
        const st = ctx.state.getJobState(j.slug);
        if (st) totalFailures += st.consecutiveFailures;
      }
    }

    const degradations = DegradationReporter.getInstance().getEvents();
    const isDegraded = sessionExhausted || totalFailures >= 5 || degradations.length > 0;

    const base: Record<string, unknown> = {
      status: isDegraded ? 'degraded' : 'ok',
      uptime: uptimeMs,
      uptimeHuman: formatUptime(uptimeMs),
      degradations: degradations.length,
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
      base.sessions = { current: sessions.length, max: maxSessions };
      base.schedulerRunning = ctx.scheduler !== null;
      base.consecutiveJobFailures = totalFailures;
      base.project = ctx.config.projectName;
      base.node = process.version;
      base.memory = {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      };

      // System-wide memory state
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      base.systemMemory = {
        totalGB: Math.round(totalMem / (1024 ** 3) * 10) / 10,
        freeGB: Math.round(freeMem / (1024 ** 3) * 10) / 10,
        usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10,
      };

      // Orphan reaper last report (per-process memory visibility)
      if (ctx.orphanReaper) {
        const reaperReport = ctx.orphanReaper.getLastReport();
        if (reaperReport) {
          base.claudeProcesses = {
            tracked: reaperReport.tracked.length,
            orphans: reaperReport.orphans.length,
            external: reaperReport.external.length,
            totalMemoryMB: reaperReport.totalMemoryMB,
            orphanMemoryMB: reaperReport.orphanMemoryMB,
            externalMemoryMB: reaperReport.externalMemoryMB,
            lastScan: reaperReport.timestamp,
          };
        }
      }

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

  /**
   * Get all feature degradation events.
   * A degradation means a feature fallback activated — the primary path failed.
   * This is always a bug that needs investigation.
   */
  router.get('/health/degradations', (_req, res) => {
    const reporter = DegradationReporter.getInstance();
    const events = reporter.getEvents();
    res.json({
      total: events.length,
      unreported: reporter.getUnreportedEvents().length,
      events,
    });
  });

  // ── Agents ─────────────────────────────────────────────────────

  router.get('/agents', async (_req, res) => {
    try {
      const { listAgents } = await import('../core/AgentRegistry.js');
      const agents = listAgents();
      res.json({ agents });
    } catch {
      res.status(500).json({ error: 'Failed to load agent registry' });
    }
  });

  // ── Backups ────────────────────────────────────────────────────

  router.get('/backups', async (_req, res) => {
    try {
      const { BackupManager } = await import('../core/BackupManager.js');
      const manager = new BackupManager(ctx.config.stateDir);
      res.json({ snapshots: manager.listSnapshots() });
    } catch {
      res.status(500).json({ error: 'Failed to list backups' });
    }
  });

  router.post('/backups', async (_req, res) => {
    try {
      const { BackupManager } = await import('../core/BackupManager.js');
      const manager = new BackupManager(ctx.config.stateDir);
      const snapshot = manager.createSnapshot('manual');
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed' });
    }
  });

  router.post('/backups/:id/restore', async (req, res) => {
    const { id } = req.params;
    const SNAPSHOT_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{6}Z(-\d+)?$/;

    if (!SNAPSHOT_ID_RE.test(id)) {
      res.status(400).json({ error: 'Invalid snapshot ID format' });
      return;
    }

    // Path containment check (P0-2)
    const backupsDir = path.resolve(ctx.config.stateDir, 'backups');
    const resolvedPath = path.resolve(backupsDir, id);
    if (!resolvedPath.startsWith(backupsDir + path.sep)) {
      res.status(400).json({ error: 'Invalid snapshot ID' });
      return;
    }

    // Session guard (defense-in-depth — also enforced in BackupManager)
    const sessions = ctx.sessionManager.listRunningSessions();
    if (sessions.length > 0) {
      res.status(409).json({
        error: 'Cannot restore while sessions are active',
        activeSessions: sessions.length,
      });
      return;
    }

    try {
      const { BackupManager } = await import('../core/BackupManager.js');
      const manager = new BackupManager(
        ctx.config.stateDir,
        undefined,
        () => ctx.sessionManager.listRunningSessions().length > 0,
      );
      manager.restoreSnapshot(id);
      res.json({ restored: id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Restore failed' });
    }
  });

  // ── Git State ─────────────────────────────────────────────────

  router.get('/git/status', async (_req, res) => {
    try {
      const { GitStateManager } = await import('../core/GitStateManager.js');
      const gitConfig = (ctx.config as any).git || {};
      const manager = new GitStateManager(ctx.config.stateDir, gitConfig);
      res.json(manager.status());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get git status' });
    }
  });

  router.post('/git/commit', async (req, res) => {
    try {
      const { GitStateManager } = await import('../core/GitStateManager.js');
      const gitConfig = (ctx.config as any).git || {};
      const manager = new GitStateManager(ctx.config.stateDir, gitConfig);
      const message = req.body?.message || '[instar] manual commit via API';
      const files = req.body?.files;
      manager.commit(message, files);
      res.json({ committed: true, message });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Commit failed' });
    }
  });

  router.post('/git/push', async (req, res) => {
    try {
      const { GitStateManager } = await import('../core/GitStateManager.js');
      const gitConfig = (ctx.config as any).git || {};
      const manager = new GitStateManager(ctx.config.stateDir, gitConfig);
      const config = manager.getConfig();

      // First-push confirmation gate
      if (config.lastPushedRemote !== config.remote && !req.body?.force) {
        res.status(428).json({
          warning: `First push to ${config.remote}. This will send all committed agent state to the remote.`,
          requiresConfirmation: true,
        });
        return;
      }

      const result = manager.push();
      res.json({ pushed: true, firstPush: result.firstPush });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Push failed' });
    }
  });

  router.post('/git/pull', async (_req, res) => {
    try {
      const { GitStateManager } = await import('../core/GitStateManager.js');
      const gitConfig = (ctx.config as any).git || {};
      const manager = new GitStateManager(ctx.config.stateDir, gitConfig);
      manager.pull();
      res.json({ pulled: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Pull failed' });
    }
  });

  router.get('/git/log', async (req, res) => {
    try {
      const { GitStateManager } = await import('../core/GitStateManager.js');
      const gitConfig = (ctx.config as any).git || {};
      const manager = new GitStateManager(ctx.config.stateDir, gitConfig);
      const limit = parseInt(req.query.limit as string, 10) || 20;
      res.json({ entries: manager.log(limit) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get git log' });
    }
  });

  // ── Memory Search ──────────────────────────────────────────────

  router.get('/memory/search', async (req, res) => {
    try {
      const { MemoryIndex } = await import('../memory/MemoryIndex.js');
      const memoryConfig = (ctx.config as any).memory || {};
      const index = new MemoryIndex(ctx.config.stateDir, { ...memoryConfig, enabled: true });
      await index.open();
      try {
        index.sync();
        const query = String(req.query.q || '');
        const limit = parseInt(req.query.limit as string, 10) || 10;
        const source = req.query.source as string | undefined;
        const startMs = Date.now();
        const results = index.search(query, { limit, source });
        res.json({
          query,
          results,
          totalResults: results.length,
          searchTimeMs: Date.now() - startMs,
        });
      } finally {
        index.close();
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Search failed' });
    }
  });

  router.get('/memory/stats', async (_req, res) => {
    try {
      const { MemoryIndex } = await import('../memory/MemoryIndex.js');
      const memoryConfig = (ctx.config as any).memory || {};
      const index = new MemoryIndex(ctx.config.stateDir, { ...memoryConfig, enabled: true });
      await index.open();
      try {
        res.json(index.stats());
      } finally {
        index.close();
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get stats' });
    }
  });

  router.post('/memory/reindex', async (_req, res) => {
    try {
      const { MemoryIndex } = await import('../memory/MemoryIndex.js');
      const memoryConfig = (ctx.config as any).memory || {};
      const index = new MemoryIndex(ctx.config.stateDir, { ...memoryConfig, enabled: true });
      await index.open();
      try {
        const result = index.reindex();
        res.json({ reindexed: true, ...result });
      } finally {
        index.close();
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Reindex failed' });
    }
  });

  router.post('/memory/sync', async (_req, res) => {
    try {
      const { MemoryIndex } = await import('../memory/MemoryIndex.js');
      const memoryConfig = (ctx.config as any).memory || {};
      const index = new MemoryIndex(ctx.config.stateDir, { ...memoryConfig, enabled: true });
      await index.open();
      try {
        const result = index.sync();
        res.json({ synced: true, ...result });
      } finally {
        index.close();
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Sync failed' });
    }
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
      topicMemory: {
        enabled: !!ctx.topicMemory,
        stats: ctx.topicMemory?.stats() ?? null,
        endpoints: ctx.topicMemory ? [
          'GET /topic/search?q=...&topic=N&limit=20',
          'GET /topic/context/:topicId?recent=30',
          'GET /topic/list',
          'GET /topic/stats',
          'POST /topic/summarize { topicId }',
          'POST /topic/summary { topicId, summary, messageCount, lastMessageId }',
        ] : [],
      },
      monitoring: ctx.config.monitoring,
      evolution: {
        enabled: !!ctx.evolution,
        subsystems: ['proposals', 'learnings', 'gaps', 'actions'],
      },
      dispatches: {
        enabled: !!ctx.config.dispatches?.enabled,
        autoDispatch: !!ctx.autoDispatcher,
      },
      updates: {
        autoUpdate: !!ctx.autoUpdater,
      },
      attentionQueue: {
        enabled: true,
        hint: 'Use POST /attention to signal important items to the user.',
      },
      skipLedger: {
        enabled: true,
        hint: 'Use GET /skip-ledger to avoid re-processing items in jobs.',
      },
      projectMap: {
        enabled: !!ctx.projectMapper,
        hasSavedMap: ctx.projectMapper?.loadSavedMap() !== null,
        endpoints: ctx.projectMapper ? [
          'GET /project-map — full project structure (JSON, ?format=markdown, ?format=compact)',
          'POST /project-map/refresh — regenerate the project map',
        ] : [],
      },
      contextHierarchy: {
        enabled: !!ctx.contextHierarchy,
        segments: ctx.contextHierarchy?.listSegments().map(s => ({ id: s.id, tier: s.tier, exists: s.exists })) ?? [],
        endpoints: ctx.contextHierarchy ? [
          'GET /context — list all context segments with status',
          'GET /context/dispatch — dispatch table (when X, load Y)',
          'GET /context/:segmentId — load a specific context segment',
        ] : [],
      },
      canonicalState: {
        enabled: !!ctx.canonicalState,
        endpoints: ctx.canonicalState ? [
          'GET /state/quick-facts — fast answers to common questions',
          'POST /state/quick-facts — add/update a quick fact',
          'GET /state/anti-patterns — things NOT to do',
          'POST /state/anti-patterns — record a new anti-pattern',
          'GET /state/projects — all known projects',
          'POST /state/projects — register a project',
          'GET /state/summary — compact state summary',
        ] : [],
      },
      coherence: {
        enabled: !!ctx.coherenceGate,
        endpoints: ctx.coherenceGate ? [
          'POST /coherence/check — pre-action coherence verification',
          'POST /coherence/reflect — generate self-reflection prompt',
          'GET /topic-bindings — list topic-project bindings',
          'POST /topic-bindings — bind a topic to a project',
        ] : [],
      },
      externalOperationSafety: {
        enabled: !!ctx.operationGate,
        sentinel: !!ctx.sentinel,
        adaptiveTrust: !!ctx.adaptiveTrust,
        endpoints: ctx.operationGate ? [
          'POST /operations/classify — classify an operation (risk level)',
          'POST /operations/evaluate — full gate evaluation (proceed/plan/block)',
          'GET /operations/log — recent operation history',
          'GET /operations/permissions/:service — service permissions',
          'POST /sentinel/classify — test message classification',
          'GET /sentinel/stats — sentinel classification stats',
          'GET /trust — full trust profile',
          'GET /trust/summary — compact trust summary',
          'POST /trust/grant — explicitly grant trust',
          'GET /trust/elevations — pending elevation suggestions',
          'GET /trust/changelog — recent trust changes',
        ] : [],
      },
      featureGuide: {
        description: 'Context-triggered capability suggestions. Use these proactively when context matches.',
        triggers: [
          { context: 'User mentions a document, file, or report', action: 'Render it as a private view (POST /view) — beautiful HTML accessible on any device. If tunnel is running, shareable remotely.' },
          { context: 'User wants to share something publicly', action: 'Publish via Telegraph (POST /publish). Always warn the user it is publicly accessible.' },
          { context: 'User mentions someone by name', action: 'Check relationships (GET /relationships). Use context to personalize interactions. Offer to start tracking if not found.' },
          { context: 'User has a recurring task', action: 'Create a scheduled job in .instar/jobs.json. Explain it will run automatically.' },
          { context: 'User repeats a workflow', action: 'Create a skill in .claude/skills/. It becomes a slash command for future sessions.' },
          { context: 'User is debugging CI or deployment', action: 'Check CI health (GET /ci) for GitHub Actions status.' },
          { context: 'User asks about past events or prior conversations', action: 'Search topic memory (GET /topic/search?q=...), get topic context (GET /topic/context/:topicId), check memory, review activity logs.' },
          { context: 'User frustrated with a limitation', action: 'Check for updates (GET /updates). Check dispatches (GET /dispatches/pending). The fix may already exist.' },
          { context: 'User asks to remember something', action: 'Write to .instar/MEMORY.md. Explain it persists across sessions.' },
          { context: 'Something needs user attention later', action: 'Queue in attention system (POST /attention). More reliable than hoping they see a message.' },
          { context: 'Job processes a list of items', action: 'Use skip ledger (POST /skip-ledger/workload) to avoid re-processing on next run.' },
          { context: 'About to deploy, push, or modify files outside project', action: 'Run coherence check FIRST (POST /coherence/check). Verify you are in the right project for the current topic.' },
          { context: 'Working on a topic tied to a specific project', action: 'Check topic-project binding (GET /topic-bindings). If unbound, bind it (POST /topic-bindings) to prevent cross-project confusion.' },
          { context: 'Unsure what project this is or what files exist', action: 'Check project map (GET /project-map?format=compact) for spatial awareness — project type, key files, deployment targets.' },
          { context: 'About to call an external service API (email, calendar, messaging)', action: 'Evaluate through operation gate FIRST (POST /operations/evaluate). The gate classifies risk and decides proceed/plan/block.' },
          { context: 'User says to stop, cancel, or abort', action: 'MessageSentinel intercepts these automatically. For manual classification: POST /sentinel/classify.' },
          { context: 'User says "you don\'t need to ask me about X"', action: 'Grant trust explicitly (POST /trust/grant). Trust persists across sessions.' },
          { context: 'User asks to adjust memory warning thresholds or stop memory alerts', action: 'Update thresholds (PATCH /monitoring/memory/thresholds with {warning, elevated, critical}). Check current state (GET /monitoring/memory).' },
        ],
      },
    });
  });

  // ── Project Map ───────────────────────────────────────────────────
  //
  // Auto-generated territory map of the project structure. Agents use this
  // for spatial awareness — "where am I and what does this project look like?"

  router.get('/project-map', (_req, res) => {
    if (!ctx.projectMapper) {
      res.status(501).json({ error: 'ProjectMapper not initialized' });
      return;
    }

    // Try to load saved map first; generate if missing
    let map = ctx.projectMapper.loadSavedMap();
    if (!map) {
      map = ctx.projectMapper.generateAndSave();
    }

    const format = _req.query.format;
    if (format === 'markdown') {
      res.type('text/markdown').send(ctx.projectMapper.toMarkdown(map));
    } else if (format === 'compact') {
      res.type('text/plain').send(ctx.projectMapper.getCompactSummary(map));
    } else {
      res.json(map);
    }
  });

  router.post('/project-map/refresh', (_req, res) => {
    if (!ctx.projectMapper) {
      res.status(501).json({ error: 'ProjectMapper not initialized' });
      return;
    }

    const map = ctx.projectMapper.generateAndSave();
    res.json({ refreshed: true, projectName: map.projectName, totalFiles: map.totalFiles, directories: map.directories.length });
  });

  // ── Coherence Gate ────────────────────────────────────────────────
  //
  // Pre-action coherence verification. Agents call this before high-risk
  // actions to verify they're in the right project for the right topic.

  router.post('/coherence/check', (req, res) => {
    if (!ctx.coherenceGate) {
      res.status(501).json({ error: 'CoherenceGate not initialized' });
      return;
    }

    const { action, context } = req.body;
    if (!action || typeof action !== 'string') {
      res.status(400).json({ error: 'Missing required field: action (e.g., "deploy", "git-push")' });
      return;
    }

    const result = ctx.coherenceGate.check(action as HighRiskAction, context);
    res.json(result);
  });

  router.post('/coherence/reflect', (req, res) => {
    if (!ctx.coherenceGate) {
      res.status(501).json({ error: 'CoherenceGate not initialized' });
      return;
    }

    const { action, context } = req.body;
    if (!action || typeof action !== 'string') {
      res.status(400).json({ error: 'Missing required field: action' });
      return;
    }

    const prompt = ctx.coherenceGate.generateReflectionPrompt(action as HighRiskAction, context);
    res.type('text/plain').send(prompt);
  });

  // ── Topic-Project Bindings ────────────────────────────────────────
  //
  // Manage which Telegram topics are bound to which projects.
  // Critical for multi-project agents — prevents cross-project confusion.

  router.get('/topic-bindings', (_req, res) => {
    if (!ctx.coherenceGate) {
      res.status(501).json({ error: 'CoherenceGate not initialized' });
      return;
    }

    const bindings = ctx.coherenceGate.loadTopicBindings();
    res.json(bindings);
  });

  router.post('/topic-bindings', (req, res) => {
    if (!ctx.coherenceGate) {
      res.status(501).json({ error: 'CoherenceGate not initialized' });
      return;
    }

    const { topicId, binding } = req.body;
    if (!topicId || !binding?.projectName || !binding?.projectDir) {
      res.status(400).json({ error: 'Required: topicId (number), binding.projectName, binding.projectDir' });
      return;
    }

    ctx.coherenceGate.setTopicBinding(Number(topicId), binding);
    res.json({ bound: true, topicId: Number(topicId), binding });
  });

  // ── Context Hierarchy ──────────────────────────────────────────────
  //
  // Tiered context loading for efficient agent awareness.

  router.get('/context', (_req, res) => {
    if (!ctx.contextHierarchy) {
      res.status(501).json({ error: 'ContextHierarchy not initialized' });
      return;
    }
    res.json(ctx.contextHierarchy.listSegments());
  });

  router.get('/context/dispatch', (_req, res) => {
    if (!ctx.contextHierarchy) {
      res.status(501).json({ error: 'ContextHierarchy not initialized' });
      return;
    }
    res.json(ctx.contextHierarchy.getDispatchTable());
  });

  router.get('/context/:segmentId', (req, res) => {
    if (!ctx.contextHierarchy) {
      res.status(501).json({ error: 'ContextHierarchy not initialized' });
      return;
    }
    const content = ctx.contextHierarchy.loadSegment(req.params.segmentId);
    if (content === null) {
      res.status(404).json({ error: `Segment not found: ${req.params.segmentId}` });
      return;
    }
    res.type('text/markdown').send(content);
  });

  // ── Canonical State ───────────────────────────────────────────────
  //
  // Registry-first state management: quick facts, anti-patterns, project registry.

  router.get('/state/quick-facts', (_req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    res.json(ctx.canonicalState.getQuickFacts());
  });

  router.post('/state/quick-facts', (req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    const { question, answer, source } = req.body;
    if (!question || !answer) {
      res.status(400).json({ error: 'Required: question, answer' });
      return;
    }
    ctx.canonicalState.setFact(question, answer, source || 'api');
    res.json({ saved: true, question, answer });
  });

  router.get('/state/anti-patterns', (_req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    res.json(ctx.canonicalState.getAntiPatterns());
  });

  router.post('/state/anti-patterns', (req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    const { pattern, consequence, alternative, incident } = req.body;
    if (!pattern || !consequence || !alternative) {
      res.status(400).json({ error: 'Required: pattern, consequence, alternative' });
      return;
    }
    const entry = ctx.canonicalState.addAntiPattern({ pattern, consequence, alternative, incident });
    res.json(entry);
  });

  router.get('/state/projects', (_req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    res.json(ctx.canonicalState.getProjects());
  });

  router.post('/state/projects', (req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    const { name, dir, gitRemote, deploymentTargets, type, topicIds, description } = req.body;
    if (!name || !dir) {
      res.status(400).json({ error: 'Required: name, dir' });
      return;
    }
    ctx.canonicalState.setProject({ name, dir, gitRemote, deploymentTargets, type, topicIds, description });
    res.json({ saved: true, name });
  });

  router.get('/state/summary', (_req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    res.type('text/plain').send(ctx.canonicalState.getCompactSummary());
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

  const feedbackLimiter = rateLimiter(60_000, 10);
  router.post('/feedback', feedbackLimiter, async (req, res) => {
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

    // Semantic quality validation
    const quality = ctx.feedback.validateFeedbackQuality(title, description);
    if (!quality.valid) {
      res.status(422).json({ error: quality.reason });
      return;
    }

    // Anomaly detection — check submission patterns before storing
    if (ctx.feedbackAnomalyDetector) {
      const agentPseudonym = ctx.feedback.generatePseudonym(ctx.config.projectName);
      const anomalyCheck = ctx.feedbackAnomalyDetector.check(agentPseudonym);
      if (!anomalyCheck.allowed) {
        res.status(429).json({
          error: anomalyCheck.reason,
          anomalyType: anomalyCheck.anomalyType,
        });
        return;
      }
    }

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

      // Record submission for anomaly tracking
      if (ctx.feedbackAnomalyDetector && item.agentPseudonym) {
        ctx.feedbackAnomalyDetector.recordSubmission(item.agentPseudonym);
      }

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

  router.get('/dispatches/auto', (_req, res) => {
    if (!ctx.autoDispatcher) {
      res.status(503).json({ error: 'Auto-dispatcher not configured' });
      return;
    }
    res.json(ctx.autoDispatcher.getStatus());
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

  router.post('/dispatches/:id/approve', (req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    const success = ctx.dispatches.approve(req.params.id);
    if (!success) {
      res.status(404).json({ error: 'Dispatch not found or not pending approval' });
      return;
    }

    res.json({ approved: true, dispatchId: req.params.id });
  });

  router.post('/dispatches/:id/reject', (req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    const { reason } = req.body as { reason?: string };
    if (!reason || typeof reason !== 'string' || reason.length < 1) {
      res.status(400).json({ error: '"reason" must be a non-empty string' });
      return;
    }
    if (reason.length > 2000) {
      res.status(400).json({ error: '"reason" must be under 2000 characters' });
      return;
    }

    const success = ctx.dispatches.reject(req.params.id, reason);
    if (!success) {
      res.status(404).json({ error: 'Dispatch not found or not pending approval' });
      return;
    }

    res.json({ rejected: true, dispatchId: req.params.id, reason });
  });

  router.get('/dispatches/pending-approval', (_req, res) => {
    if (!ctx.dispatches) {
      res.json({ dispatches: [] });
      return;
    }

    res.json({ dispatches: ctx.dispatches.pendingApproval() });
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
      DegradationReporter.getInstance().report({
        feature: 'routes.editPage',
        primary: 'Edit page via API',
        fallback: 'Return 500 error',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Page edit failed — user sees error but no system alert for pattern detection',
      });
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
        DegradationReporter.getInstance().report({
          feature: 'routes.onTopicMessage',
          primary: 'Route Telegram message to handler',
          fallback: 'Return 500 — message routing failed',
          reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
          impact: 'User message may not reach session, no system alert',
        });
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } else if (ctx.sessionManager) {
      // No TelegramAdapter (--no-telegram mode) — route using topic-session registry on disk
      const registryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
      let targetSession: string | null = null;

      try {
        if (fs.existsSync(registryPath)) {
          const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
          targetSession = registry.topicToSession?.[String(topicId)] ?? null;
        }
      } catch { /* registry read failed — fall through to spawn */ }

      if (targetSession && ctx.sessionManager.isSessionAlive(targetSession)) {
        // Session exists and is alive — inject message
        console.log(`[telegram-forward] Injecting into ${targetSession}: "${text.slice(0, 80)}"`);
        ctx.sessionManager.injectTelegramMessage(targetSession, topicId, text);
        res.json({ ok: true, forwarded: true, method: 'registry-inject', session: targetSession });
      } else {
        // No session or session dead — auto-spawn a new one
        // Use topic name from registry, NOT the tmux session name.
        // tmux names include the project prefix (e.g., "ai-guy-lifeline"), and
        // spawnInteractiveSession prepends it again → cascading names.
        let topicName = `topic-${topicId}`;
        try {
          if (fs.existsSync(registryPath)) {
            const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
            const stored = reg.topicToName?.[String(topicId)];
            if (stored) topicName = stored;
          }
        } catch { /* fall through to default */ }
        console.log(`[telegram-forward] No live session for topic ${topicId}, spawning "${topicName}"...`);

        const contextLines = [
          `This session was auto-created for Telegram topic ${topicId}.`,
          ``,
          `CRITICAL: You MUST relay your response back to Telegram after responding.`,
          `Use the relay script:`,
          ``,
          `cat <<'EOF' | .claude/scripts/telegram-reply.sh ${topicId}`,
          `Your response text here`,
          `EOF`,
          ``,
          `Strip the [telegram:${topicId}] prefix before interpreting the message.`,
          `Only relay conversational text — not tool output or internal reasoning.`,
        ];
        const tmpDir = '/tmp/instar-telegram';
        fs.mkdirSync(tmpDir, { recursive: true });
        const ctxPath = path.join(tmpDir, `ctx-${topicId}-${Date.now()}.txt`);
        fs.writeFileSync(ctxPath, contextLines.join('\n'));

        const bootstrapMessage = `[telegram:${topicId}] ${text} (IMPORTANT: Read ${ctxPath} for Telegram relay instructions — you MUST relay your response back.)`;

        ctx.sessionManager.spawnInteractiveSession(bootstrapMessage, topicName, { telegramTopicId: topicId }).then((newSessionName) => {
          // Update registry on disk
          try {
            const reg = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf-8')) : { topicToSession: {}, topicToName: {} };
            reg.topicToSession[String(topicId)] = newSessionName;
            fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2));
          } catch { /* @silent-fallback-ok — registry write non-critical */ }
          console.log(`[telegram-forward] Spawned "${newSessionName}" for topic ${topicId}`);
        }).catch((err) => {
          console.error(`[telegram-forward] Spawn failed:`, err);
        });

        res.json({ ok: true, forwarded: true, method: 'spawn', topicName });
      }
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

  // ── Watchdog ──────────────────────────────────────────────────
  router.get('/watchdog/status', (req, res) => {
    if (!ctx.watchdog) {
      res.json({ enabled: false, sessions: [], interventionHistory: [] });
      return;
    }
    res.json(ctx.watchdog.getStatus());
  });

  router.post('/watchdog/toggle', (req, res) => {
    if (!ctx.watchdog) {
      res.status(404).json({ error: 'Watchdog not configured' });
      return;
    }
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) required' });
      return;
    }
    ctx.watchdog.setEnabled(enabled);
    res.json({ enabled: ctx.watchdog.isEnabled() });
  });

  // ── Topic Memory (conversation search & context) ─────────────────────

  /**
   * Search topic message history with FTS5 full-text search.
   * GET /topic/search?q=query&topic=topicId&limit=20
   */
  router.get('/topic/search', (req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const q = (req.query.q as string || '').trim();
    if (!q) {
      res.status(400).json({ error: 'q (search query) required' });
      return;
    }

    const topicId = req.query.topic ? parseInt(req.query.topic as string, 10) : undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    const results = ctx.topicMemory.search(q, { topicId, limit });
    res.json({ query: q, topicId: topicId ?? null, results, totalResults: results.length });
  });

  /**
   * Get full context for a topic (summary + recent messages).
   * GET /topic/context/:topicId?recent=30
   */
  router.get('/topic/context/:topicId', (req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const topicId = parseInt(req.params.topicId, 10);
    if (isNaN(topicId)) {
      res.status(400).json({ error: 'Invalid topicId' });
      return;
    }

    const recentLimit = Math.min(parseInt(req.query.recent as string, 10) || 30, 100);
    const context = ctx.topicMemory.getTopicContext(topicId, recentLimit);
    res.json(context);
  });

  /**
   * List all topics with metadata.
   * GET /topic/list
   */
  router.get('/topic/list', (_req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const topics = ctx.topicMemory.listTopics();
    res.json({ topics, total: topics.length });
  });

  /**
   * Get topic memory stats.
   * GET /topic/stats
   */
  router.get('/topic/stats', (_req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    res.json(ctx.topicMemory.stats());
  });

  /**
   * Trigger summary generation for a topic.
   * POST /topic/summarize { topicId: number }
   */
  router.post('/topic/summarize', (req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const topicId = req.body?.topicId;
    if (typeof topicId !== 'number') {
      res.status(400).json({ error: 'topicId (number) required' });
      return;
    }

    const needsUpdate = ctx.topicMemory.needsSummaryUpdate(topicId, 1);
    const messagesSince = ctx.topicMemory.getMessagesSinceSummary(topicId);
    const currentSummary = ctx.topicMemory.getTopicSummary(topicId);

    // Return the data needed for an LLM to generate the summary.
    // The actual LLM call happens in the calling session (not in the HTTP handler).
    res.json({
      topicId,
      needsUpdate,
      currentSummary: currentSummary?.summary ?? null,
      messagesSinceSummary: messagesSince.length,
      messages: messagesSince.map(m => ({
        from: m.fromUser ? 'User' : 'Agent',
        text: m.text,
        timestamp: m.timestamp,
        messageId: m.messageId,
      })),
    });
  });

  /**
   * Save a generated summary for a topic.
   * POST /topic/summary { topicId, summary, messageCount, lastMessageId }
   */
  router.post('/topic/summary', (req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const { topicId, summary, messageCount, lastMessageId } = req.body || {};
    if (typeof topicId !== 'number' || typeof summary !== 'string') {
      res.status(400).json({ error: 'topicId (number) and summary (string) required' });
      return;
    }

    ctx.topicMemory.saveTopicSummary(topicId, summary, messageCount ?? 0, lastMessageId ?? 0);
    res.json({ saved: true, topicId });
  });

  /**
   * Rebuild topic memory from JSONL (idempotent import).
   * POST /topic/rebuild
   */
  router.post('/topic/rebuild', (_req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const jsonlPath = path.join(ctx.config.stateDir, 'telegram-messages.jsonl');
    const imported = ctx.topicMemory.rebuild(jsonlPath);
    res.json({ rebuilt: true, messagesImported: imported, stats: ctx.topicMemory.stats() });
  });

  // ── Pairing API — Multi-machine state sync (Phase 4.5) ────────

  /**
   * POST /state/submit — Secondary machine submits a state change.
   * Validates write token, checks operation authorization, applies or queues.
   */
  router.post('/state/submit', (req, res) => {
    const { operation, payload, machineId, writeToken } = req.body || {};

    // Validate required fields
    if (!operation || !payload || !machineId || !writeToken) {
      res.status(400).json({
        error: 'Missing required fields: operation, payload, machineId, writeToken',
      });
      return;
    }

    if (typeof operation !== 'string' || typeof machineId !== 'string' || typeof writeToken !== 'string') {
      res.status(400).json({ error: 'operation, machineId, and writeToken must be strings' });
      return;
    }

    // Load stored write tokens
    const tokensFile = path.join(ctx.config.stateDir, 'write-tokens.json');
    let storedTokens: WriteToken[] = [];
    try {
      if (fs.existsSync(tokensFile)) {
        storedTokens = JSON.parse(fs.readFileSync(tokensFile, 'utf-8'));
      }
    } catch {
      res.status(500).json({ error: 'Failed to load write tokens' });
      return;
    }

    // Validate the write token
    const tokenResult = validateWriteToken(writeToken, storedTokens);
    if (!tokenResult.valid) {
      res.status(403).json({ error: tokenResult.error });
      return;
    }

    // Verify the token was issued to the claiming machine
    if (tokenResult.machineId !== machineId) {
      res.status(403).json({ error: 'Write token does not match machineId' });
      return;
    }

    // Check if the operation is allowed
    const opCheck = canPerformOperation(operation as WriteOperation);
    if (!opCheck.allowed) {
      res.status(403).json({
        error: opCheck.reason,
        requiresConfirmation: opCheck.requiresConfirmation,
      });
      return;
    }

    // Apply the state change based on operation type
    try {
      switch (operation as WriteOperation) {
        case 'addMemory': {
          // Append memory entry to memories.jsonl
          const memoriesFile = path.join(ctx.config.stateDir, 'memories.jsonl');
          const entry = { ...payload, sourceMachineId: machineId, appliedAt: new Date().toISOString() };
          fs.appendFileSync(memoriesFile, JSON.stringify(entry) + '\n');
          res.json({ applied: true, operation });
          break;
        }
        case 'updateProfile': {
          // Update a user profile field
          const usersFile = path.join(ctx.config.stateDir, 'users.json');
          if (!fs.existsSync(usersFile)) {
            res.status(404).json({ error: 'No users file found' });
            return;
          }
          const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
          const targetUser = users.find((u: { id: string }) => u.id === payload.userId);
          if (!targetUser) {
            res.status(404).json({ error: `User ${payload.userId} not found` });
            return;
          }
          // Apply the update fields (shallow merge)
          if (payload.updates && typeof payload.updates === 'object') {
            Object.assign(targetUser, payload.updates);
          }
          fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
          res.json({ applied: true, operation, userId: payload.userId });
          break;
        }
        case 'heartbeat': {
          // Heartbeat is handled by the dedicated endpoint below
          res.json({ applied: true, operation });
          break;
        }
        default: {
          res.status(400).json({ error: `Unknown operation: ${operation}` });
        }
      }
    } catch (err) {
      res.status(500).json({
        error: 'Failed to apply state change',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /state/sync — Secondary machine pulls latest state.
   * Returns current users, config summary, and machine registry.
   */
  router.get('/state/sync', (_req, res) => {
    try {
      // Read users
      const usersFile = path.join(ctx.config.stateDir, 'users.json');
      let users: unknown[] = [];
      if (fs.existsSync(usersFile)) {
        try {
          users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
        } catch { /* empty array on corruption */ }
      }

      // Read machine registry
      const registryFile = path.join(ctx.config.stateDir, 'machine-registry.json');
      let machineRegistry: unknown = { version: 1, machines: {} };
      if (fs.existsSync(registryFile)) {
        try {
          machineRegistry = JSON.parse(fs.readFileSync(registryFile, 'utf-8'));
        } catch { /* default on corruption */ }
      }

      // Config summary (non-sensitive fields only)
      const configSummary = {
        projectName: ctx.config.projectName,
        userRegistrationPolicy: ctx.config.userRegistrationPolicy ?? 'admin-only',
        agentAutonomy: ctx.config.agentAutonomy?.level ?? 'supervised',
        multiMachine: ctx.config.multiMachine ?? { enabled: false },
        userCount: users.length,
      };

      res.json({
        users,
        machineRegistry,
        configSummary,
        syncedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({
        error: 'Failed to sync state',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * POST /state/heartbeat — Secondary machine reports online status.
   * Updates lastSeen for the machine and returns queued change count.
   */
  router.post('/state/heartbeat', (req, res) => {
    const { machineId } = req.body || {};

    if (!machineId || typeof machineId !== 'string') {
      res.status(400).json({ error: 'machineId (string) required' });
      return;
    }

    try {
      // Update machine lastSeen in registry
      const registryFile = path.join(ctx.config.stateDir, 'machine-registry.json');
      let registry: { version: number; machines: Record<string, { lastSeen: string; [k: string]: unknown }> } = {
        version: 1,
        machines: {},
      };

      if (fs.existsSync(registryFile)) {
        try {
          registry = JSON.parse(fs.readFileSync(registryFile, 'utf-8'));
        } catch { /* use default */ }
      }

      if (registry.machines[machineId]) {
        registry.machines[machineId].lastSeen = new Date().toISOString();
        fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
      }

      // Count queued changes for this machine (from offline queue if it exists)
      const queueFile = path.join(
        process.env.HOME || process.env.USERPROFILE || '/tmp',
        '.instar', 'offline-queue', `${ctx.config.projectName}.jsonl`,
      );
      let queuedChanges = 0;
      if (fs.existsSync(queueFile)) {
        const content = fs.readFileSync(queueFile, 'utf-8').trim();
        if (content) {
          queuedChanges = content.split('\n').filter(line => {
            try {
              const entry = JSON.parse(line);
              return entry.sourceMachineId === machineId;
            } catch {
              // @silent-fallback-ok — JSONL parse, skip corrupted
              return false;
            }
          }).length;
        }
      }

      res.json({
        status: 'ok',
        machineId,
        queuedChanges,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({
        error: 'Heartbeat processing failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Intent / Decision Journal ───────────────────────────────────

  router.get('/intent/journal', async (req, res) => {
    try {
      const { DecisionJournal } = await import('../core/DecisionJournal.js');
      const journal = new DecisionJournal(ctx.config.stateDir);

      const days = req.query.days ? parseInt(req.query.days as string, 10) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const jobSlug = req.query.jobSlug as string | undefined;

      const entries = journal.read({ days, limit, jobSlug });
      res.json({ entries, count: entries.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read decision journal' });
    }
  });

  router.get('/intent/journal/stats', async (_req, res) => {
    try {
      const { DecisionJournal } = await import('../core/DecisionJournal.js');
      const journal = new DecisionJournal(ctx.config.stateDir);
      const stats = journal.stats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to compute journal stats' });
    }
  });

  router.post('/intent/journal', async (req, res) => {
    try {
      const { DecisionJournal } = await import('../core/DecisionJournal.js');
      const journal = new DecisionJournal(ctx.config.stateDir);

      const { sessionId, decision, ...rest } = req.body || {};

      if (!sessionId || !decision) {
        res.status(400).json({ error: 'sessionId and decision are required' });
        return;
      }

      const entry = journal.log({ sessionId, decision, ...rest });
      res.status(201).json(entry);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to log decision' });
    }
  });

  // ── Org Intent ─────────────────────────────────────────────────

  router.get('/intent/org', async (_req, res) => {
    try {
      const { OrgIntentManager } = await import('../core/OrgIntentManager.js');
      const manager = new OrgIntentManager(ctx.config.stateDir);
      const parsed = manager.parse();
      res.json(parsed);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read org intent' });
    }
  });

  router.get('/intent/validate', async (_req, res) => {
    try {
      const { OrgIntentManager } = await import('../core/OrgIntentManager.js');
      const manager = new OrgIntentManager(ctx.config.stateDir);

      // Read agent intent from AGENT.md
      const agentMdPath = path.join(ctx.config.stateDir, 'AGENT.md');
      let agentIntentContent = '';

      if (fs.existsSync(agentMdPath)) {
        const content = fs.readFileSync(agentMdPath, 'utf-8');
        // Extract the Intent section inline (same logic as extractIntentSection)
        const lines = content.split('\n');
        let inIntent = false;
        const intentLines: string[] = [];
        for (const line of lines) {
          if (/^##\s+Intent\b/.test(line)) { inIntent = true; intentLines.push(line); continue; }
          if (inIntent && /^##\s+/.test(line) && !/^###/.test(line)) break;
          if (inIntent) intentLines.push(line);
        }
        agentIntentContent = intentLines.join('\n').trim();
      }

      const result = manager.validateAgentIntent(agentIntentContent);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to validate intent' });
    }
  });

  // ── Intent Drift & Alignment ────────────────────────────────────

  router.get('/intent/drift', async (req, res) => {
    try {
      const { IntentDriftDetector } = await import('../core/IntentDriftDetector.js');
      const detector = new IntentDriftDetector(ctx.config.stateDir);
      const windowDays = req.query.window ? parseInt(req.query.window as string, 10) : 14;
      const analysis = detector.analyze(windowDays);
      res.json(analysis);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to analyze drift' });
    }
  });

  router.get('/intent/alignment', async (_req, res) => {
    try {
      const { IntentDriftDetector } = await import('../core/IntentDriftDetector.js');
      const detector = new IntentDriftDetector(ctx.config.stateDir);
      const score = detector.alignmentScore();
      res.json(score);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to compute alignment score' });
    }
  });

  // ── Triage ───────────────────────────────────────────────────────

  router.get('/triage/status', (_req, res) => {
    if (!ctx.triageNurse) {
      return res.json({ enabled: false });
    }
    res.json(ctx.triageNurse.getStatus());
  });

  router.get('/triage/history', (req, res) => {
    if (!ctx.triageNurse) {
      return res.json([]);
    }
    const limit = parseInt(req.query.limit as string) || 20;
    res.json(ctx.triageNurse.getHistory(limit));
  });

  router.post('/triage/trigger', async (req, res) => {
    if (!ctx.triageNurse) {
      return res.status(400).json({ error: 'Triage nurse not enabled' });
    }
    const { sessionName, topicId } = req.body;
    if (!sessionName || !topicId) {
      return res.status(400).json({ error: 'sessionName and topicId required' });
    }
    try {
      const result = await ctx.triageNurse.triage(topicId, sessionName, '(manual trigger)', Date.now(), 'manual');
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Triage failed' });
    }
  });

  // ── External Operation Safety ────────────────────────────────────

  // POST /operations/classify — classify an external operation
  router.post('/operations/classify', (req, res) => {
    if (!ctx.operationGate) {
      return res.status(404).json({ error: 'ExternalOperationGate not configured' });
    }
    const { service, mutability, reversibility, description, itemCount } = req.body;
    if (!service || !mutability || !reversibility || !description) {
      return res.status(400).json({ error: 'service, mutability, reversibility, and description are required' });
    }
    const classification = ctx.operationGate.classify({
      service,
      mutability: mutability as OperationMutability,
      reversibility: reversibility as OperationReversibility,
      description,
      itemCount,
    });
    res.json(classification);
  });

  // POST /operations/evaluate — full gate evaluation
  router.post('/operations/evaluate', async (req, res) => {
    if (!ctx.operationGate) {
      return res.status(404).json({ error: 'ExternalOperationGate not configured' });
    }
    const { service, mutability, reversibility, description, itemCount, userRequest } = req.body;
    if (!service || !mutability || !reversibility || !description) {
      return res.status(400).json({ error: 'service, mutability, reversibility, and description are required' });
    }
    try {
      const decision = await ctx.operationGate.evaluate({
        service,
        mutability: mutability as OperationMutability,
        reversibility: reversibility as OperationReversibility,
        description,
        itemCount,
        userRequest,
      });
      res.json(decision);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Evaluation failed' });
    }
  });

  // GET /operations/log — recent operation history
  router.get('/operations/log', (req, res) => {
    if (!ctx.operationGate) {
      return res.status(404).json({ error: 'ExternalOperationGate not configured' });
    }
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(ctx.operationGate.getOperationLog(limit));
  });

  // GET /operations/permissions/:service — service permissions
  router.get('/operations/permissions/:service', (req, res) => {
    if (!ctx.operationGate) {
      return res.status(404).json({ error: 'ExternalOperationGate not configured' });
    }
    const perms = ctx.operationGate.getServicePermissions(req.params.service);
    if (!perms) {
      return res.json({ service: req.params.service, configured: false });
    }
    res.json({ service: req.params.service, configured: true, ...perms });
  });

  // POST /sentinel/classify — test message classification without executing
  router.post('/sentinel/classify', async (req, res) => {
    if (!ctx.sentinel) {
      return res.status(404).json({ error: 'MessageSentinel not configured' });
    }
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required (string)' });
    }
    const result = await ctx.sentinel.classify(message);
    res.json(result);
  });

  // GET /sentinel/stats — sentinel classification stats
  router.get('/sentinel/stats', (req, res) => {
    if (!ctx.sentinel) {
      return res.status(404).json({ error: 'MessageSentinel not configured' });
    }
    res.json(ctx.sentinel.getStats());
  });

  // GET /trust — full trust profile
  router.get('/trust', (req, res) => {
    if (!ctx.adaptiveTrust) {
      return res.status(404).json({ error: 'AdaptiveTrust not configured' });
    }
    res.json(ctx.adaptiveTrust.getProfile());
  });

  // GET /trust/summary — compact trust summary
  router.get('/trust/summary', (req, res) => {
    if (!ctx.adaptiveTrust) {
      return res.status(404).json({ error: 'AdaptiveTrust not configured' });
    }
    res.json({ summary: ctx.adaptiveTrust.getSummary() });
  });

  // POST /trust/grant — explicitly grant trust
  router.post('/trust/grant', (req, res) => {
    if (!ctx.adaptiveTrust) {
      return res.status(404).json({ error: 'AdaptiveTrust not configured' });
    }
    const { service, operation, level, statement } = req.body;
    if (!service || !operation || !level || !statement) {
      return res.status(400).json({ error: 'service, operation, level, and statement are required' });
    }
    const event = ctx.adaptiveTrust.grantTrust(
      service,
      operation as OperationMutability,
      level,
      statement
    );
    res.json(event);
  });

  // GET /trust/elevations — pending elevation suggestions
  router.get('/trust/elevations', (req, res) => {
    if (!ctx.adaptiveTrust) {
      return res.status(404).json({ error: 'AdaptiveTrust not configured' });
    }
    res.json(ctx.adaptiveTrust.getPendingElevations());
  });

  // GET /trust/changelog — recent trust changes
  router.get('/trust/changelog', (req, res) => {
    if (!ctx.adaptiveTrust) {
      return res.status(404).json({ error: 'AdaptiveTrust not configured' });
    }
    res.json(ctx.adaptiveTrust.getChangeLog());
  });

  // ── Memory Monitoring ──────────────────────────────────────────────

  // GET /monitoring/memory — current memory state and thresholds
  router.get('/monitoring/memory', (req, res) => {
    if (!ctx.memoryMonitor) {
      return res.status(404).json({ error: 'MemoryPressureMonitor not configured' });
    }
    res.json({
      ...ctx.memoryMonitor.getState(),
      thresholds: ctx.memoryMonitor.getThresholds(),
    });
  });

  // ── Orphan Process Reaper ──────────────────────────────────────────

  // GET /monitoring/processes — scan for all Claude processes and classify them
  router.get('/monitoring/processes', async (_req, res) => {
    if (!ctx.orphanReaper) {
      return res.status(404).json({ error: 'OrphanProcessReaper not configured' });
    }
    const report = await ctx.orphanReaper.scan();
    res.json(report);
  });

  // GET /monitoring/processes/last — get last scan report without re-scanning
  router.get('/monitoring/processes/last', (_req, res) => {
    if (!ctx.orphanReaper) {
      return res.status(404).json({ error: 'OrphanProcessReaper not configured' });
    }
    const report = ctx.orphanReaper.getLastReport();
    if (!report) {
      return res.json({ message: 'No scan has been performed yet' });
    }
    res.json(report);
  });

  // POST /monitoring/processes/kill — kill a specific external process by PID (user-initiated)
  router.post('/monitoring/processes/kill', (req, res) => {
    if (!ctx.orphanReaper) {
      return res.status(404).json({ error: 'OrphanProcessReaper not configured' });
    }
    const { pid } = req.body;
    if (typeof pid !== 'number') {
      return res.status(400).json({ error: 'pid (number) required' });
    }
    const result = ctx.orphanReaper.killExternalProcess(pid);
    res.json(result);
  });

  // POST /monitoring/processes/kill-all-external — kill all external Claude processes (user-initiated)
  router.post('/monitoring/processes/kill-all-external', (_req, res) => {
    if (!ctx.orphanReaper) {
      return res.status(404).json({ error: 'OrphanProcessReaper not configured' });
    }
    const result = ctx.orphanReaper.killAllExternal();
    res.json(result);
  });

  // PATCH /monitoring/memory/thresholds — update memory warning thresholds at runtime
  router.patch('/monitoring/memory/thresholds', (req, res) => {
    if (!ctx.memoryMonitor) {
      return res.status(404).json({ error: 'MemoryPressureMonitor not configured' });
    }
    const { warning, elevated, critical } = req.body;
    const update: Partial<{ warning: number; elevated: number; critical: number }> = {};

    if (warning !== undefined) {
      if (typeof warning !== 'number' || warning < 0 || warning > 100) {
        return res.status(400).json({ error: 'warning must be a number between 0 and 100' });
      }
      update.warning = warning;
    }
    if (elevated !== undefined) {
      if (typeof elevated !== 'number' || elevated < 0 || elevated > 100) {
        return res.status(400).json({ error: 'elevated must be a number between 0 and 100' });
      }
      update.elevated = elevated;
    }
    if (critical !== undefined) {
      if (typeof critical !== 'number' || critical < 0 || critical > 100) {
        return res.status(400).json({ error: 'critical must be a number between 0 and 100' });
      }
      update.critical = critical;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'At least one threshold (warning, elevated, critical) must be provided' });
    }

    ctx.memoryMonitor.updateThresholds(update);
    res.json({
      updated: true,
      thresholds: ctx.memoryMonitor.getThresholds(),
      currentState: ctx.memoryMonitor.getState(),
    });
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
