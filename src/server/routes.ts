/**
 * HTTP API routes — health, status, sessions, jobs, events.
 *
 * Extracted/simplified from Dawn's 2267-line routes.ts.
 * All the observability you need, none of the complexity you don't.
 */

import { Router } from 'express';
import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
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
import { ReflectionMetrics } from '../monitoring/ReflectionMetrics.js';
import { HomeostasisMonitor } from '../monitoring/HomeostasisMonitor.js';
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
import type { ScopeVerifier } from '../core/ScopeVerifier.js';
import type { HighRiskAction } from '../core/ScopeVerifier.js';
import type { ContextHierarchy } from '../core/ContextHierarchy.js';
import type { CanonicalState } from '../core/CanonicalState.js';
import type { ExternalOperationGate } from '../core/ExternalOperationGate.js';
import type { OperationMutability, OperationReversibility } from '../core/ExternalOperationGate.js';
import type { MessageSentinel } from '../core/MessageSentinel.js';
import type { AdaptiveTrust } from '../core/AdaptiveTrust.js';
import type { AutonomyProfileManager } from '../core/AutonomyProfileManager.js';
import type { TrustElevationTracker } from '../core/TrustElevationTracker.js';
import type { AutonomousEvolution } from '../core/AutonomousEvolution.js';
import type { AutonomyProfileLevel } from '../core/types.js';
import type { MemoryPressureMonitor } from '../monitoring/MemoryPressureMonitor.js';
import type { CoherenceMonitor } from '../monitoring/CoherenceMonitor.js';
import type { SystemReviewer } from '../monitoring/SystemReviewer.js';
import type { CommitmentTracker } from '../monitoring/CommitmentTracker.js';
import type { SemanticMemory } from '../memory/SemanticMemory.js';
import type { SessionActivitySentinel } from '../monitoring/SessionActivitySentinel.js';
import { ProcessIntegrity } from '../core/ProcessIntegrity.js';
import type { MessageRouter } from '../messaging/MessageRouter.js';
import type { SessionSummarySentinel } from '../messaging/SessionSummarySentinel.js';
import type { SpawnRequestManager } from '../messaging/SpawnRequestManager.js';
import { getOutboundQueueStatus, cleanupDeliveredOutbound, buildAgentList } from '../messaging/GitSyncTransport.js';
import type { CapabilityMapper } from '../core/CapabilityMapper.js';
import type { SelfKnowledgeTree } from '../knowledge/SelfKnowledgeTree.js';
import type { CoverageAuditor } from '../knowledge/CoverageAuditor.js';
import type { TopicResumeMap } from '../core/TopicResumeMap.js';
import type { MessageType, MessagePriority, MessageFilter } from '../messaging/types.js';
import { verifyAgentToken, getAgentToken } from '../messaging/AgentTokenManager.js';
import type { WorkingMemoryAssembler } from '../memory/WorkingMemoryAssembler.js';
import type { QuotaManager } from '../monitoring/QuotaManager.js';
import type { ThreadlineRouter } from '../threadline/ThreadlineRouter.js';
import type { HandshakeManager } from '../threadline/HandshakeManager.js';
import { createThreadlineRoutes } from '../threadline/ThreadlineEndpoints.js';
import type { UnifiedTrustSystem } from '../threadline/UnifiedTrustWiring.js';
import { ScopeCoherenceTracker } from '../core/ScopeCoherenceTracker.js';
import type { ScopeCoherenceState } from '../core/ScopeCoherenceTracker.js';
import type { HookEventReceiver } from '../monitoring/HookEventReceiver.js';
import type { WorktreeMonitor } from '../monitoring/WorktreeMonitor.js';
import type { SubagentTracker } from '../monitoring/SubagentTracker.js';
import type { InstructionsVerifier } from '../monitoring/InstructionsVerifier.js';
import type { CoherenceGate } from '../core/CoherenceGate.js';
import type { PasteManager } from '../paste/PasteManager.js';
import type { WebSocketManager } from './WebSocketManager.js';
import { TruncationDetector } from '../paste/TruncationDetector.js';
import { SecretDrop } from './SecretDrop.js';

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
  coherenceGate: ScopeVerifier | null;
  contextHierarchy: ContextHierarchy | null;
  canonicalState: CanonicalState | null;
  operationGate: ExternalOperationGate | null;
  sentinel: MessageSentinel | null;
  adaptiveTrust: AdaptiveTrust | null;
  memoryMonitor: MemoryPressureMonitor | null;
  orphanReaper: OrphanProcessReaper | null;
  coherenceMonitor: CoherenceMonitor | null;
  commitmentTracker: CommitmentTracker | null;
  semanticMemory: SemanticMemory | null;
  activitySentinel: SessionActivitySentinel | null;
  messageRouter: MessageRouter | null;
  summarySentinel: SessionSummarySentinel | null;
  spawnManager: SpawnRequestManager | null;
  workingMemory: WorkingMemoryAssembler | null;
  quotaManager: QuotaManager | null;
  systemReviewer: SystemReviewer | null;
  capabilityMapper: CapabilityMapper | null;
  selfKnowledgeTree: SelfKnowledgeTree | null;
  coverageAuditor: CoverageAuditor | null;
  topicResumeMap: TopicResumeMap | null;
  autonomyManager: AutonomyProfileManager | null;
  trustElevationTracker: TrustElevationTracker | null;
  autonomousEvolution: AutonomousEvolution | null;
  whatsapp: import('../messaging/WhatsAppAdapter.js').WhatsAppAdapter | null;
  slack: import('../messaging/slack/SlackAdapter.js').SlackAdapter | null;
  imessage: import('../messaging/imessage/IMessageAdapter.js').IMessageAdapter | null;
  messageBridge: import('../messaging/shared/MessageBridge.js').MessageBridge | null;
  hookEventReceiver: HookEventReceiver | null;
  worktreeMonitor: WorktreeMonitor | null;
  subagentTracker: SubagentTracker | null;
  instructionsVerifier: InstructionsVerifier | null;
  threadlineRouter: ThreadlineRouter | null;
  handshakeManager: HandshakeManager | null;
  threadlineRelayClient: import('../threadline/client/ThreadlineClient.js').ThreadlineClient | null;
  listenerManager: import('../threadline/ListenerSessionManager.js').ListenerSessionManager | null;
  responseReviewGate: CoherenceGate | null;
  telemetryHeartbeat: import('../monitoring/TelemetryHeartbeat.js').TelemetryHeartbeat | null;
  pasteManager: PasteManager | null;
  wsManager: WebSocketManager | null;
  soulManager: import('../core/SoulManager.js').SoulManager | null;
  featureRegistry: import('../core/FeatureRegistry.js').FeatureRegistry | null;
  discoveryEvaluator: import('../core/DiscoveryEvaluator.js').DiscoveryEvaluator | null;
  unifiedTrust: UnifiedTrustSystem | null;
  /** Pending reply waiters for threadline relay-send waitForReply support.
   *  Key: sender fingerprint, Value: resolve callback with reply text */
  threadlineReplyWaiters: Map<string, { resolve: (reply: string) => void; threadId: string; timer: ReturnType<typeof setTimeout> }>;
  startTime: Date;
}

// Validation patterns for route parameters
const SESSION_NAME_RE = /^[a-zA-Z0-9_-]{1,200}$/;
const JOB_SLUG_RE = /^[a-zA-Z0-9_-]{1,100}$/;
const VALID_SORTS = ['significance', 'recent', 'name'] as const;

export function createRoutes(ctx: RouteContext): Router {
  const router = Router();

  // Reflection metrics — usage-based reflection trigger (ported from Dawn)
  const reflectionMetrics = new ReflectionMetrics(ctx.config.stateDir);

  // Homeostasis monitor — work-velocity awareness (ported from Dawn)
  const homeostasisMonitor = new HomeostasisMonitor(ctx.config.stateDir);

  // Truncation detector for Telegram messages (Drop Zone integration)
  const truncationDetector = new TruncationDetector();

  // ── Discovery ───────────────────────────────────────────────────
  //
  // Bootstrap endpoint for agents to discover available APIs.

  router.get('/.well-known/instar.json', (_req, res) => {
    res.json({
      name: ctx.config.projectName,
      version: ctx.config.version || '0.0.0',
      endpoints: {
        health: '/health',
        capabilities: '/capabilities',
        capabilityMap: '/capability-map',
        capabilityMapCompact: '/capability-map?format=compact',
        capabilityMapDrift: '/capability-map/drift',
        capabilityMapRefresh: '/capability-map/refresh',
        projectMap: '/project-map',
        sessions: '/sessions',
        jobs: '/jobs',
        jobHistory: '/jobs/history',
        jobHistoryBySlug: '/jobs/:slug/history',
        evolution: '/evolution',
        context: '/context',
        autonomy: '/autonomy',
      },
    });
  });

  // ── Health ──────────────────────────────────────────────────────

  router.get('/ping', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/health', (req, res) => {
    const uptimeMs = Date.now() - ctx.startTime.getTime();
    // Use cached session count to avoid blocking the event loop with synchronous
    // tmux has-session calls. The cache is updated every 5s by the monitor tick.
    // This prevents the death spiral where stale sessions overwhelm the health
    // endpoint, causing the lifeline to restart the server in a tight loop.
    const cached = ctx.sessionManager.getCachedRunningSessions();
    const sessionCount = cached.count;
    const maxSessions = ctx.config.sessions?.maxSessions ?? 10;
    const sessionExhausted = sessionCount >= maxSessions;

    let totalFailures = 0;
    if (ctx.scheduler) {
      const jobs = ctx.scheduler.getJobs();
      for (const j of jobs) {
        const st = ctx.state.getJobState(j.slug);
        if (st) totalFailures += st.consecutiveFailures;
      }
    }

    const degradations = DegradationReporter.getInstance().getEvents();
    let isDegraded = sessionExhausted || totalFailures >= 5 || degradations.length > 0;

    const base: Record<string, unknown> = {
      status: isDegraded ? 'degraded' : 'ok',
      uptime: uptimeMs,
      uptimeHuman: formatUptime(uptimeMs),
      degradations: degradations.length,
      ...(degradations.length > 0 && {
        degradationSummary: degradations.map(e => DegradationReporter.narrativeFor(e)),
      }),
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
      // Use ProcessIntegrity for truthful version reporting
      const integrity = ProcessIntegrity.getInstance();
      if (integrity) {
        base.version = integrity.runningVersion;
        if (integrity.versionMismatch) {
          base.versionMismatch = true;
          base.diskVersion = integrity.diskVersion;
          base.bootedAt = integrity.bootedAt;
        }
      } else {
        base.version = ctx.config.version || '0.0.0';
      }
      base.sessions = { current: sessionCount, max: maxSessions };
      base.schedulerRunning = ctx.scheduler !== null;
      base.consecutiveJobFailures = totalFailures;
      base.project = ctx.config.projectName;
      base.node = process.version;
      base.memory = {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      };

      // System-wide memory state (prefer MemoryPressureMonitor's vm_stat-based
      // calculation on macOS — os.freemem() only counts "Pages free" and ignores
      // reclaimable inactive/purgeable pages, reporting wildly pessimistic numbers)
      if (ctx.memoryMonitor) {
        const memState = ctx.memoryMonitor.getState();
        base.systemMemory = {
          totalGB: Math.round(memState.totalGB * 10) / 10,
          freeGB: Math.round(memState.freeGB * 10) / 10,
          usedPercent: Math.round(memState.pressurePercent * 10) / 10,
        };
      } else {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        base.systemMemory = {
          totalGB: Math.round(totalMem / (1024 ** 3) * 10) / 10,
          freeGB: Math.round(freeMem / (1024 ** 3) * 10) / 10,
          usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10,
        };
      }

      // Memory pressure state from MemoryPressureMonitor (macOS-accurate via vm_stat).
      // On macOS, os.freemem() is misleading — wired+compressed+app memory leaves little
      // "free" even under no real pressure. MemoryPressureMonitor uses platform-native
      // APIs to classify actual pressure as normal/warning/elevated/critical.
      if (ctx.memoryMonitor) {
        const ps = ctx.memoryMonitor.getState();
        base.memoryPressure = {
          state: ps.state,
          pressurePercent: ps.pressurePercent,
        };
      }

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

      // System Reviewer health
      if (ctx.systemReviewer) {
        const latest = ctx.systemReviewer.getLatest();
        const health = ctx.systemReviewer.getHealthStatus();
        base.systemReview = {
          status: health,
          lastReview: latest ? {
            status: latest.status,
            timestamp: latest.timestamp,
            passed: latest.stats.passed,
            failed: latest.stats.failed,
            skipped: latest.stats.skipped,
          } : null,
          probesRegistered: ctx.systemReviewer.getProbeCount(),
        };
        // Contribute to overall degradation if critical
        if (latest?.status === 'critical') {
          isDegraded = true;
        }
      }

      // WhatsApp adapter status
      if (ctx.whatsapp) {
        const waStatus = ctx.whatsapp.getStatus();
        base.whatsapp = {
          state: waStatus.state,
          phoneNumber: waStatus.phoneNumber,
          registeredSessions: waStatus.registeredSessions,
          pendingMessages: waStatus.pendingMessages,
          stalledChannels: waStatus.stalledChannels,
          totalMessagesLogged: waStatus.totalMessagesLogged,
        };
        if (waStatus.state === 'disconnected') {
          isDegraded = true;
        }
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
      events: events.map(e => ({
        ...e,
        narrative: DegradationReporter.narrativeFor(e),
      })),
    });
  });

  /**
   * Coherence health — runtime self-awareness report.
   * Checks config drift, state durability, output sanity, and feature readiness.
   * Where possible, issues are self-corrected.
   */
  router.get('/health/coherence', (_req, res) => {
    if (!ctx.coherenceMonitor) {
      res.json({ status: 'unavailable', message: 'CoherenceMonitor not initialized' });
      return;
    }
    const report = ctx.coherenceMonitor.getLastReport();
    if (!report) {
      res.json({ status: 'pending', message: 'First check has not run yet' });
      return;
    }
    res.json({
      ...report,
      corrections: ctx.coherenceMonitor.getCorrectionLog(),
    });
  });

  /**
   * Trigger an on-demand coherence check.
   */
  router.post('/health/coherence/check', (_req, res) => {
    if (!ctx.coherenceMonitor) {
      res.status(503).json({ error: 'CoherenceMonitor not initialized' });
      return;
    }
    const report = ctx.coherenceMonitor.runCheck();
    res.json(report);
  });

  // ── Hook Events ────────────────────────────────────────────────
  //
  // Receives HTTP hook event payloads from Claude Code.
  // The central ingest point for PostToolUse, SubagentStart/Stop, Stop,
  // SessionEnd, WorktreeCreate/Remove, TaskCompleted events.

  router.post('/hooks/events', (req, res) => {
    if (!ctx.hookEventReceiver) {
      res.status(503).json({ error: 'HookEventReceiver not initialized' });
      return;
    }

    const payload = req.body;
    if (!payload || !payload.event) {
      res.status(400).json({ error: 'Missing event field in payload' });
      return;
    }

    const stored = ctx.hookEventReceiver.receive(payload);
    if (!stored) {
      res.status(500).json({ error: 'Failed to store event' });
      return;
    }

    // Track tool calls for reflection metrics
    if (payload.event === 'PostToolUse') {
      reflectionMetrics.recordToolCall();

      // Track commits for homeostasis (work-velocity awareness).
      // Detect git commit in Bash tool output — Structure > Willpower.
      const toolName = payload.tool_name || payload.toolName || '';
      const toolInput = payload.tool_input || payload.toolInput || '';
      if (toolName === 'Bash' && typeof toolInput === 'string' && /git\s+commit\b/.test(toolInput)) {
        homeostasisMonitor.recordCommit();
      }
    }

    // Bridge instar session ID ↔ Claude Code session ID.
    // Hook URLs include ?instar_sid=<INSTAR_SESSION_ID> set via tmux env var.
    // On the first hook event from a session, this populates claudeSessionId on
    // the instar Session record, enabling SubagentTracker lookups.
    const instarSid = typeof req.query.instar_sid === 'string' ? req.query.instar_sid : '';
    if (instarSid && payload.session_id && ctx.sessionManager) {
      const session = ctx.sessionManager.getSessionById(instarSid);
      if (session && !session.claudeSessionId) {
        ctx.sessionManager.setClaudeSessionId(instarSid, payload.session_id);
      }
    }

    // Dispatch to specialized trackers
    if (ctx.subagentTracker && payload.session_id) {
      if (payload.event === 'SubagentStart' && payload.agent_id && payload.agent_type) {
        ctx.subagentTracker.onStart(payload.agent_id, payload.agent_type, payload.session_id);
      } else if (payload.event === 'SubagentStop' && payload.agent_id) {
        ctx.subagentTracker.onStop(
          payload.agent_id,
          payload.session_id,
          payload.last_assistant_message,
          payload.agent_transcript_path,
        );
      }
    }

    res.json({ ok: true, event: payload.event });
  });

  router.get('/hooks/events/:sessionId', (req, res) => {
    if (!ctx.hookEventReceiver) {
      res.status(503).json({ error: 'HookEventReceiver not initialized' });
      return;
    }

    const { sessionId } = req.params;
    const events = ctx.hookEventReceiver.getSessionEvents(sessionId);
    res.json({ sessionId, events, count: events.length });
  });

  router.get('/hooks/events/:sessionId/summary', (req, res) => {
    if (!ctx.hookEventReceiver) {
      res.status(503).json({ error: 'HookEventReceiver not initialized' });
      return;
    }

    const { sessionId } = req.params;
    const summary = ctx.hookEventReceiver.getSessionSummary(sessionId);
    if (!summary) {
      res.status(404).json({ error: 'No events found for session' });
      return;
    }
    res.json(summary);
  });

  router.get('/hooks/sessions', (_req, res) => {
    if (!ctx.hookEventReceiver) {
      res.status(503).json({ error: 'HookEventReceiver not initialized' });
      return;
    }

    const sessions = ctx.hookEventReceiver.listSessions();
    const index = ctx.hookEventReceiver.getIndex();
    const sessionList = sessions.map(id => ({
      sessionId: id,
      eventCount: index.get(id) ?? 0,
    }));
    res.json({ sessions: sessionList });
  });

  // ── Subagent Tracking ─────────────────────────────────────────

  router.get('/hooks/subagents/:sessionId', (req, res) => {
    if (!ctx.subagentTracker) {
      res.status(503).json({ error: 'SubagentTracker not initialized' });
      return;
    }

    const { sessionId } = req.params;
    const records = ctx.subagentTracker.getSessionRecords(sessionId);
    const summary = ctx.subagentTracker.getSessionSummary(sessionId);
    res.json({ sessionId, records, summary });
  });

  // ── Reflection Metrics (Usage-Based Trigger) ─────────────────

  router.get('/reflection/metrics', (_req, res) => {
    const check = reflectionMetrics.check();
    res.json(check);
  });

  router.post('/reflection/record', (req, res) => {
    const { type } = req.body;
    if (!type || typeof type !== 'string') {
      res.status(400).json({ error: 'Missing "type" field (e.g., "quick", "deep", "grounding")' });
      return;
    }
    reflectionMetrics.recordReflection(type);
    res.json({ ok: true, message: `Reflection recorded (type: ${type}). Counters reset.` });
  });

  router.post('/reflection/session-start', (_req, res) => {
    reflectionMetrics.recordSessionStart();
    res.json({ ok: true });
  });

  router.put('/reflection/thresholds', (req, res) => {
    const { toolCalls, sessions, minutes } = req.body;
    reflectionMetrics.updateThresholds({
      toolCalls: typeof toolCalls === 'number' ? toolCalls : undefined,
      sessions: typeof sessions === 'number' ? sessions : undefined,
      minutes: typeof minutes === 'number' ? minutes : undefined,
    });
    res.json({ ok: true, thresholds: reflectionMetrics.getData().thresholds });
  });

  // ── Homeostasis Monitor (Work-Velocity Awareness) ─────────────
  //
  // Tracks commits and elapsed time since last pause. Suggests brief
  // awareness checks when the agent has been grinding without reflection.
  // Ported from Dawn's homeostasis-check.sh — the heartbeat that prevents
  // tunnel vision during extended autonomous sessions.

  router.get('/homeostasis/check', (_req, res) => {
    const check = homeostasisMonitor.check();
    res.json(check);
  });

  router.post('/homeostasis/commit', (_req, res) => {
    homeostasisMonitor.recordCommit();
    const check = homeostasisMonitor.check();
    res.json({ ok: true, ...check });
  });

  router.post('/homeostasis/pause', (req, res) => {
    const { context } = req.body || {};
    homeostasisMonitor.recordPause(context);
    res.json({ ok: true, message: 'Pause recorded. Counters reset.' });
  });

  router.post('/homeostasis/reset', (_req, res) => {
    homeostasisMonitor.resetSession();
    res.json({ ok: true, message: 'Homeostasis reset for new session.' });
  });

  router.put('/homeostasis/thresholds', (req, res) => {
    const { commits, minutes } = req.body;
    homeostasisMonitor.updateThresholds({
      commits: typeof commits === 'number' ? commits : undefined,
      minutes: typeof minutes === 'number' ? minutes : undefined,
    });
    res.json({ ok: true, thresholds: homeostasisMonitor.getData().thresholds });
  });

  // ── Worktree Monitoring ───────────────────────────────────────

  router.get('/hooks/worktrees', (_req, res) => {
    if (!ctx.worktreeMonitor) {
      res.status(503).json({ error: 'WorktreeMonitor not initialized' });
      return;
    }

    const report = ctx.worktreeMonitor.scanWorktrees();
    res.json(report);
  });

  router.get('/hooks/worktrees/last-report', (_req, res) => {
    if (!ctx.worktreeMonitor) {
      res.status(503).json({ error: 'WorktreeMonitor not initialized' });
      return;
    }

    const report = ctx.worktreeMonitor.getLastReport();
    if (!report) {
      res.status(404).json({ error: 'No worktree scan has been performed yet' });
      return;
    }
    res.json(report);
  });

  // ── Instructions Verification ─────────────────────────────────

  router.get('/hooks/instructions/:sessionId', (req, res) => {
    if (!ctx.instructionsVerifier) {
      res.status(503).json({ error: 'InstructionsVerifier not initialized' });
      return;
    }

    const { sessionId } = req.params;
    const result = ctx.instructionsVerifier.verify(sessionId);
    res.json(result);
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

  /**
   * Cross-agent restart — restart another agent on this machine.
   *
   * Uses the agent registry to find the agent's path, then starts the server
   * via the shadow install CLI. This lets any agent recover any other agent
   * on the same machine, solving the dead man's switch problem where an agent
   * can't restart itself and the user has no other way in.
   */
  router.post('/agents/:name/restart', async (req, res) => {
    const { name } = req.params;
    try {
      const { listAgents } = await import('../core/AgentRegistry.js');
      const agents = listAgents();
      const agent = agents.find((a: { name: string }) =>
        a.name === name || a.name === `${name}-lifeline`
      );

      if (!agent) {
        res.status(404).json({ error: `Agent "${name}" not found in registry` });
        return;
      }

      // Don't restart self — that's a different code path
      if (agent.name === ctx.config.projectName) {
        res.status(400).json({ error: 'Cannot restart self via cross-agent restart. Use /lifeline restart.' });
        return;
      }

      const agentPath = agent.path.replace(/-lifeline$/, ''); // Normalize to main agent path
      const shadowCli = `${agentPath}/.instar/shadow-install/node_modules/instar/dist/cli.js`;
      const { existsSync } = await import('node:fs');
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      if (!existsSync(shadowCli)) {
        res.status(500).json({ error: `Shadow install not found for "${name}" at ${shadowCli}` });
        return;
      }

      // Start the server via the shadow install CLI
      // This will handle tmux session creation, port binding, etc.
      try {
        await execFileAsync('node', [shadowCli, 'server', 'start', '--dir', agentPath], {
          cwd: agentPath,
          timeout: 30_000,
        });
        res.json({ success: true, message: `Agent "${name}" restart initiated`, agentPath });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // "Server started in tmux" in stdout is actually success — execFile may still "fail"
        // because the CLI exits after spawning tmux
        if (errMsg.includes('Server started') || errMsg.includes('already running')) {
          res.json({ success: true, message: `Agent "${name}" restart initiated`, agentPath });
        } else {
          res.status(500).json({ error: `Failed to restart "${name}": ${errMsg}` });
        }
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Cross-agent restart failed' });
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

  // ── Memory Search (DEPRECATED — use /semantic/* routes instead) ─

  router.get('/memory/search', async (req, res) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', '2026-06-01');
    res.setHeader('Link', '</semantic/search>; rel="successor-version"');
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
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', '2026-06-01');
    res.setHeader('Link', '</semantic/stats>; rel="successor-version"');
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
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', '2026-06-01');
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
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', '2026-06-01');
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



  // ── Semantic Memory ─────────────────────────────────────────────

  const VALID_ENTITY_TYPES = new Set(['fact', 'person', 'project', 'tool', 'pattern', 'decision', 'lesson']);
  const VALID_RELATION_TYPES = new Set([
    'related_to', 'built_by', 'learned_from', 'depends_on', 'supersedes',
    'contradicts', 'part_of', 'used_in', 'knows_about', 'caused', 'verified_by',
  ]);

  router.post('/semantic/remember', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    const { type, name, content, confidence, source, sourceSession, tags, domain, expiresAt } = req.body;
    if (!type || !name || !content || confidence === undefined || !source) {
      res.status(400).json({ error: 'Missing required fields: type, name, content, confidence, source' }); return;
    }
    if (!VALID_ENTITY_TYPES.has(type)) {
      res.status(400).json({ error: `Invalid entity type: ${type}` }); return;
    }
    try {
      const id = ctx.semanticMemory.remember({
        type, name, content, confidence,
        lastVerified: new Date().toISOString(),
        source, sourceSession, tags: tags || [], domain, expiresAt,
      });
      res.json({ id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to remember' });
    }
  });

  router.get('/semantic/recall/:id', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const result = ctx.semanticMemory.recall(req.params.id);
      if (!result) { res.status(404).json({ error: 'Entity not found' }); return; }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to recall' });
    }
  });

  router.delete('/semantic/forget/:id', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      ctx.semanticMemory.forget(req.params.id, req.body?.reason);
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to forget' });
    }
  });

  router.post('/semantic/connect', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    const { fromId, toId, relation, context, weight } = req.body;
    if (!fromId || !toId || !relation) {
      res.status(400).json({ error: 'Missing required fields: fromId, toId, relation' }); return;
    }
    if (!VALID_RELATION_TYPES.has(relation)) {
      res.status(400).json({ error: `Invalid relation type: ${relation}` }); return;
    }
    try {
      const edgeId = ctx.semanticMemory.connect(fromId, toId, relation, context, weight);
      res.json({ edgeId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to connect' });
    }
  });

  router.get('/semantic/search', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const query = String(req.query.q || '');
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const types = req.query.types ? String(req.query.types).split(',').filter(t => VALID_ENTITY_TYPES.has(t)) : undefined;
      const domain = req.query.domain as string | undefined;
      const minConfidence = req.query.minConfidence ? parseFloat(req.query.minConfidence as string) : undefined;

      const results = ctx.semanticMemory.search(query, { types: types as any, domain, minConfidence, limit });
      res.json({ query, results, totalResults: results.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Search failed' });
    }
  });

  // Hybrid search — uses FTS5 + vector KNN when embeddings are available
  router.get('/semantic/search/hybrid', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const query = String(req.query.q || '');
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const types = req.query.types ? String(req.query.types).split(',').filter(t => VALID_ENTITY_TYPES.has(t)) : undefined;
      const domain = req.query.domain as string | undefined;
      const minConfidence = req.query.minConfidence ? parseFloat(req.query.minConfidence as string) : undefined;

      const results = await ctx.semanticMemory.searchHybrid(query, { types: types as any, domain, minConfidence, limit });
      res.json({ query, results, totalResults: results.length, vectorSearchActive: ctx.semanticMemory.vectorSearchAvailable });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Hybrid search failed' });
    }
  });

  // Batch embed all entities that are missing embeddings
  router.post('/semantic/embeddings/migrate', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const count = await ctx.semanticMemory.embedAllEntities();
      res.json({ embedded: count, vectorSearchAvailable: ctx.semanticMemory.vectorSearchAvailable });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Embedding migration failed' });
    }
  });

  router.get('/semantic/explore/:id', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const maxDepth = parseInt(req.query.maxDepth as string, 10) || 2;
      const relations = req.query.relations ? String(req.query.relations).split(',') : undefined;
      const results = ctx.semanticMemory.explore(req.params.id, { maxDepth, relations: relations as any });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Explore failed' });
    }
  });

  router.post('/semantic/verify/:id', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      ctx.semanticMemory.verify(req.params.id, req.body?.confidence);
      res.json({ verified: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Verify failed' });
    }
  });

  router.post('/semantic/supersede', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    const { oldId, newId, reason } = req.body;
    if (!oldId || !newId) {
      res.status(400).json({ error: 'Missing required fields: oldId, newId' }); return;
    }
    try {
      ctx.semanticMemory.supersede(oldId, newId, reason);
      res.json({ superseded: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Supersede failed' });
    }
  });

  router.post('/semantic/decay', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const report = ctx.semanticMemory.decayAll();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Decay failed' });
    }
  });

  router.get('/semantic/stale', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const maxConfidence = req.query.maxConfidence ? parseFloat(req.query.maxConfidence as string) : undefined;
      const olderThan = req.query.olderThan as string | undefined;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const results = ctx.semanticMemory.findStale({ maxConfidence, olderThan, limit });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Stale query failed' });
    }
  });

  router.get('/semantic/export', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      res.json(ctx.semanticMemory.export());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Export failed' });
    }
  });

  router.post('/semantic/import', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const report = ctx.semanticMemory.import(req.body);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Import failed' });
    }
  });

  router.get('/semantic/stats', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      res.json(ctx.semanticMemory.stats());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Stats failed' });
    }
  });

  router.get('/semantic/context', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const query = String(req.query.q || '');
      const maxTokens = parseInt(req.query.maxTokens as string, 10) || 2000;
      const context = ctx.semanticMemory.getRelevantContext(query, { maxTokens });
      res.json({ context });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Context generation failed' });
    }
  });

  // ── MEMORY.md Export (Phase 6) ─────────────────────────────────

  router.post('/semantic/export-memory', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryExporter } = await import('../memory/MemoryExporter.js');
      const exporter = new MemoryExporter({
        semanticMemory: ctx.semanticMemory,
        minConfidence: req.body?.minConfidence,
        maxEntities: req.body?.maxEntities,
        agentName: req.body?.agentName,
        includeFooter: req.body?.includeFooter,
      });

      // If filePath provided, write to disk; otherwise return markdown
      const filePath = req.body?.filePath;
      if (filePath) {
        const result = exporter.write(filePath);
        // Also write a JSON snapshot alongside the MEMORY.md export
        try { ctx.semanticMemory.writeSnapshot(); } catch { /* non-critical */ }
        res.json(result);
      } else {
        const result = exporter.generate();
        res.json(result);
      }
    } catch (err) {
      // Fallback: if DB is broken but a MEMORY.md file exists, serve the last-known-good version
      const filePath = req.body?.filePath;
      if (filePath) {
        try {
          const fs = await import('node:fs');
          if (fs.existsSync(filePath)) {
            const lastGood = fs.readFileSync(filePath, 'utf-8');
            res.json({
              markdown: lastGood,
              entityCount: 0,
              excludedCount: 0,
              domainCount: 0,
              estimatedTokens: Math.ceil(lastGood.length / 4),
              fallback: true,
              fallbackReason: err instanceof Error ? err.message : 'Export failed',
            });
            return;
          }
        } catch { /* fallback also failed */ }
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Export failed' });
    }
  });

  // ── Semantic Memory Rebuild (Disaster Recovery) ──────────────────

  router.post('/semantic/rebuild', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const jsonlPath = req.body?.jsonlPath;
      const full = req.body?.full !== false; // Default to full rebuild
      const result = full
        ? ctx.semanticMemory.rebuild(jsonlPath)
        : ctx.semanticMemory.importFromJsonl(jsonlPath);
      res.json({ ...result, mode: full ? 'full-rebuild' : 'incremental-import' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Rebuild failed' });
    }
  });

  router.post('/semantic/snapshot', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const result = ctx.semanticMemory.writeSnapshot(req.body?.path);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Snapshot failed' });
    }
  });

  // ── Semantic Memory Migration ────────────────────────────────────

  router.post('/semantic/migrate', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryMigrator } = await import('../memory/MemoryMigrator.js');
      const migrator = new MemoryMigrator({
        stateDir: ctx.config.stateDir,
        semanticMemory: ctx.semanticMemory,
      });

      const memoryMdPath = req.body?.memoryMdPath;
      const report = await migrator.migrateAll({ memoryMdPath });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Migration failed' });
    }
  });

  router.post('/semantic/migrate/memory-md', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryMigrator } = await import('../memory/MemoryMigrator.js');
      const migrator = new MemoryMigrator({
        stateDir: ctx.config.stateDir,
        semanticMemory: ctx.semanticMemory,
      });

      const filePath = req.body?.filePath;
      if (!filePath) { res.status(400).json({ error: 'filePath required' }); return; }
      const report = await migrator.migrateMemoryMd(filePath);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Migration failed' });
    }
  });

  router.post('/semantic/migrate/relationships', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryMigrator } = await import('../memory/MemoryMigrator.js');
      const migrator = new MemoryMigrator({
        stateDir: ctx.config.stateDir,
        semanticMemory: ctx.semanticMemory,
      });

      const report = await migrator.migrateRelationships();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Migration failed' });
    }
  });

  router.post('/semantic/migrate/canonical-state', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryMigrator } = await import('../memory/MemoryMigrator.js');
      const migrator = new MemoryMigrator({
        stateDir: ctx.config.stateDir,
        semanticMemory: ctx.semanticMemory,
      });

      const report = await migrator.migrateCanonicalState();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Migration failed' });
    }
  });

  router.post('/semantic/migrate/decisions', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryMigrator } = await import('../memory/MemoryMigrator.js');
      const migrator = new MemoryMigrator({
        stateDir: ctx.config.stateDir,
        semanticMemory: ctx.semanticMemory,
      });

      const report = await migrator.migrateDecisionJournal();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Migration failed' });
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

    // iMessage
    const hasIMessageConfig = ctx.config.messaging?.some(m => m.type === 'imessage' && m.enabled) ?? false;
    const imessage = {
      configured: hasIMessageConfig,
      adapter: !!ctx.imessage,
      connected: ctx.imessage?.getConnectionInfo().state === 'connected',
      endpoints: ctx.imessage ? [
        'GET /imessage/status',
        'POST /imessage/validate-send/:recipient — validate + get send token (Layer 3)',
        'POST /imessage/reply/:recipient — confirm delivery with token (called by imessage-reply.sh)',
        'GET /imessage/chats',
        'GET /imessage/chats/:chatId/history',
        'GET /imessage/search?q=...',
        'GET /imessage/log-stats',
      ] : [],
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

    const setupIntegrity = ProcessIntegrity.getInstance();
    res.json({
      project: ctx.config.projectName,
      version: setupIntegrity?.runningVersion || ctx.config.version || '0.0.0',
      port: ctx.config.port,
      identity: identityFiles,
      scripts,
      hooks,
      telegram,
      imessage,
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
      autonomy: ctx.autonomyManager ? {
        enabled: true,
        profile: ctx.autonomyManager.getProfile(),
        endpoints: [
          'GET /autonomy — full dashboard with profile, resolved state, summary, elevations',
          'GET /autonomy/summary — natural language summary',
          'POST /autonomy/profile { profile, reason } — set profile level',
          'PATCH /autonomy/notifications — update notification preferences',
          'GET /autonomy/history — profile change history',
        ],
      } : { enabled: false },
      git: (() => {
        const projectDir = ctx.config.projectDir;
        const hasGitRepo = fs.existsSync(path.join(projectDir, '.git'));
        let hasRemote = false;
        let gitSyncJobEnabled = false;
        if (hasGitRepo) {
          try {
            const remote = execFileSync('git', ['remote'], { cwd: projectDir, stdio: 'pipe' }).toString().trim();
            hasRemote = remote.length > 0;
          } catch { /* no remote */ }
        }
        if (ctx.scheduler) {
          const gitJob = ctx.scheduler.getJobs().find((j: any) => j.slug === 'git-sync');
          gitSyncJobEnabled = !!(gitJob as any)?.enabled;
        }
        return {
          inRepo: hasGitRepo,
          hasRemote,
          gitSyncJob: gitSyncJobEnabled,
          autoSyncing: hasGitRepo && hasRemote && gitSyncJobEnabled,
          agentType: ctx.config.agentType || 'standalone',
          hint: hasGitRepo && hasRemote && gitSyncJobEnabled
            ? 'Git sync is active — your state is automatically committed and pushed hourly.'
            : hasGitRepo && hasRemote
              ? 'Git repo with remote exists but git-sync job is not enabled. Enable it in jobs.json.'
              : hasGitRepo
                ? 'Git repo exists but no remote configured. Add one with `git remote add origin <url>`.'
                : 'No git repo. For standalone agents, run `instar git init`. For project-bound, initialize the parent repo.',
        };
      })(),
      dispatches: {
        enabled: !!ctx.config.dispatches?.enabled,
        autoDispatch: !!ctx.autoDispatcher,
      },
      updates: {
        autoUpdate: !!ctx.autoUpdater,
      },
      playbook: (() => {
        const playbookDir = path.join(stateDir, 'playbook');
        const initialized = fs.existsSync(playbookDir);
        let itemCount = 0;
        let hasManifest = false;
        if (initialized) {
          const manifestPath = path.join(playbookDir, 'context-manifest.json');
          hasManifest = fs.existsSync(manifestPath);
          if (hasManifest) {
            try {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
              itemCount = Array.isArray(manifest.items) ? manifest.items.length : 0;
            } catch { /* corrupt manifest */ }
          }
        }
        return {
          initialized,
          itemCount,
          hasManifest,
          commands: [
            'instar playbook init — initialize the playbook system',
            'instar playbook doctor — health check',
            'instar playbook status — manifest overview',
            'instar playbook list — all context items',
            'instar playbook add — add a context item',
            'instar playbook assemble — preview trigger-based assembly',
            'instar playbook evaluate — run lifecycle (score, decay, dedup)',
            'instar playbook mount — import context from another agent',
            'instar playbook search — find items by tag',
          ],
          hint: initialized
            ? `Playbook active with ${itemCount} context items. Run 'instar playbook doctor' to verify health.`
            : "Playbook not initialized. Run 'instar playbook init' to set up adaptive context engineering.",
        };
      })(),
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
      workingMemory: {
        enabled: !!ctx.workingMemory,
        endpoints: ctx.workingMemory ? [
          'GET /context/working-memory?prompt=...&jobSlug=...&sessionId=... — token-budgeted context assembly from all memory layers',
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
      responseReview: {
        enabled: !!ctx.responseReviewGate,
        endpoints: ctx.responseReviewGate ? [
          'POST /review/evaluate — evaluate agent response before delivery',
          'POST /review/test — dry-run test of review pipeline',
          'GET /review/history — review audit log (filterable, 30-day retention)',
          'DELETE /review/history?sessionId=X — delete history for session (DSAR)',
          'GET /review/stats — reviewer effectiveness metrics (per-period, per-recipient)',
          'GET /coherence/proposals — patch proposal queue',
          'POST /coherence/proposals — submit a new proposal',
          'POST /coherence/proposals/:id/approve — approve a proposal',
          'POST /coherence/proposals/:id/reject — reject a proposal',
          'GET /coherence/health — coherence evolution dashboard',
          'GET /review/health — reviewer health and anomaly detection',
          'POST /review/canary — run canary tests with known-bad messages',
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
          { context: 'User asks about autonomy, trust level, approval settings, or how much freedom the agent has', action: 'Show autonomy summary (GET /autonomy/summary). Present in natural language — never show CLI commands.' },
          { context: 'User says "go autonomous", "handle everything yourself", "I trust you", or wants less friction', action: 'Set autonomy profile (POST /autonomy/profile { profile: "autonomous", reason: "..." }). Confirm the implications conversationally first.' },
          { context: 'User says "supervise everything", "ask me first", "I want to approve", or wants more control', action: 'Set autonomy profile (POST /autonomy/profile { profile: "cautious" or "supervised", reason: "..." }).' },
          { context: 'User wants to undo an evolution change or revert agent self-modification', action: 'Check evolution proposals (GET /evolution/proposals?status=implemented), then PATCH the proposal status back. Explain what happened and what was reverted.' },
          { context: 'User asks to adjust memory warning thresholds or stop memory alerts', action: 'Update thresholds (PATCH /monitoring/memory/thresholds with {warning, elevated, critical}). Check current state (GET /monitoring/memory).' },
          { context: 'User asks about Instar features, architecture, multi-user, or multi-machine setup', action: 'STOP — do NOT answer from memory. Run GET /capabilities first, then check `instar --help` for CLI commands, then GET /context/dispatch for the full context map. Answer ONLY from what these return.' },
          { context: 'User says to update, install latest version, or apply updates', action: 'Run POST /updates/apply immediately. Do NOT explain how to update — just do it. If you want to enable auto-updates, set updates.autoApply to true in .instar/config.json.' },
          { context: 'Agent learns a lesson, discovers a pattern, or user teaches something worth remembering', action: 'Add it to the Playbook manifest (instar playbook add). Context items persist across sessions and get assembled based on triggers. This is more structured than MEMORY.md — items have triggers, scores, and lifecycle management.' },
          { context: 'Session context feels stale or irrelevant', action: 'Run instar playbook evaluate to score items, decay stale ones, and deduplicate. Then check instar playbook status.' },
          { context: 'Another agent wants to share context', action: 'Use instar playbook mount to import their manifest with integrity verification. Only global-scoped items are accepted.' },
          { context: 'User mentions other AI agents, wants to collaborate with other agents, or asks about multi-agent communication', action: 'Check if Threadline relay is enabled (GET /threadline/status). If not enabled, explain: you have the ability to connect to a secure agent network where you can discover and message other AI agents in real time. Offer to enable it conversationally. If enabled, use threadline_discover and threadline_send.' },
          { context: 'User asks what you can do, your features, or capabilities you have not used yet', action: 'Include Threadline relay in your capability overview if not yet enabled. Explain it lets you join a network of agents for real-time secure communication — available but waiting for their go-ahead.' },
        ],
      },
      discovery: ctx.featureRegistry ? {
        enabled: true,
        featureCount: ctx.featureRegistry.getAllDefinitions().length,
        summaries: ctx.featureRegistry.getSummaries(),
        evaluator: ctx.discoveryEvaluator ? {
          active: true,
          ...ctx.discoveryEvaluator.getStatus(),
        } : { active: false },
        endpoints: [
          'GET /features — full feature registry (definitions + per-user state)',
          'GET /features/:id — single feature details with valid transitions',
          'GET /features?state=undiscovered,aware — filter by discovery state',
          'GET /features/summary — lightweight summaries only',
          'POST /features/evaluate-context — evaluate context for feature surfacing',
          'GET /features/evaluator-status — evaluator rate-limit and cache status',
        ],
      } : { enabled: false },
    });
  });

  // ── Capability Map ──────────────────────────────────────────────────
  //
  // Hierarchical self-knowledge map with provenance tracking and drift detection.
  // Agents use this to understand their own features, skills, and integrations.

  router.get('/capability-map', async (req, res) => {
    if (!ctx.capabilityMapper) {
      res.status(501).json({ error: 'CapabilityMapper not initialized' });
      return;
    }

    try {
      const map = await ctx.capabilityMapper.getMap();
      const format = req.query.format;

      if (format === 'md' || format === 'markdown') {
        res.type('text/markdown').send(ctx.capabilityMapper.renderMarkdown(map, 2));
      } else if (format === 'compact') {
        res.type('text/markdown').send(ctx.capabilityMapper.renderMarkdown(map, 1));
      } else {
        res.json(map);
      }
    } catch (err) {
      res.status(500).json({
        error: 'SCAN_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/capability-map/drift', async (_req, res) => {
    if (!ctx.capabilityMapper) {
      res.status(501).json({ error: 'CapabilityMapper not initialized' });
      return;
    }

    try {
      const drift = await ctx.capabilityMapper.detectDrift();
      res.json(drift);
    } catch (err) {
      res.status(500).json({
        error: 'DRIFT_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/capability-map/:domain', async (req, res) => {
    if (!ctx.capabilityMapper) {
      res.status(501).json({ error: 'CapabilityMapper not initialized' });
      return;
    }

    try {
      const map = await ctx.capabilityMapper.getMap();
      const domain = map.domains.find(d => d.id === req.params.domain);

      if (!domain) {
        res.status(404).json({
          error: 'DOMAIN_NOT_FOUND',
          message: `Domain '${req.params.domain}' not found`,
          suggestion: `Available domains: ${map.domains.map(d => d.id).join(', ')}`,
        });
        return;
      }

      res.json(domain);
    } catch (err) {
      res.status(500).json({
        error: 'SCAN_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post('/capability-map/refresh', async (_req, res) => {
    if (!ctx.capabilityMapper) {
      res.status(501).json({ error: 'CapabilityMapper not initialized' });
      return;
    }

    try {
      const map = await ctx.capabilityMapper.refresh();
      res.status(202).json({
        status: 'completed',
        summary: map.summary,
        generatedAt: map.generatedAt,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'REFRESH_IN_PROGRESS') {
        res.status(409).json({
          error: 'REFRESH_IN_PROGRESS',
          message: 'A scan is already running',
          retryAfter: 10,
        });
        return;
      }
      res.status(500).json({
        error: 'REFRESH_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Self-Knowledge Tree ────────────────────────────────────────────
  //
  // Tree-based agent self-knowledge with LLM triage, tiered caching,
  // and cross-layer synthesis. Agents use this to answer "who am I?"

  router.get('/self-knowledge/search', async (req, res) => {
    if (!ctx.selfKnowledgeTree) {
      res.status(501).json({ error: 'SelfKnowledgeTree not initialized' });
      return;
    }

    const query = req.query.q as string;
    if (!query) {
      res.status(400).json({ error: 'Missing required query parameter: q' });
      return;
    }

    try {
      const dryRun = req.query.dry_run === 'true';
      const maxBudget = req.query.maxTokens ? parseInt(req.query.maxTokens as string, 10) : undefined;
      if (dryRun) {
        const plan = await ctx.selfKnowledgeTree.dryRun(query);
        res.json(plan);
      } else {
        const result = await ctx.selfKnowledgeTree.search(query, { maxBudget });
        res.json(result);
      }
    } catch (err) {
      res.status(500).json({
        error: 'SEARCH_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/self-knowledge/validate', (_req, res) => {
    if (!ctx.selfKnowledgeTree) {
      res.status(501).json({ error: 'SelfKnowledgeTree not initialized' });
      return;
    }

    try {
      const validation = ctx.selfKnowledgeTree.validate();
      const cacheStats = ctx.selfKnowledgeTree.cacheStats();
      res.json({ ...validation, cacheStats });
    } catch (err) {
      res.status(500).json({
        error: 'VALIDATION_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/self-knowledge/health', (_req, res) => {
    if (!ctx.selfKnowledgeTree || !ctx.coverageAuditor) {
      res.status(501).json({ error: 'SelfKnowledgeTree not initialized' });
      return;
    }

    try {
      const config = ctx.selfKnowledgeTree.getConfig();
      if (!config) {
        res.json({ status: 'no_tree', message: 'Tree not generated yet' });
        return;
      }

      const validation = ctx.selfKnowledgeTree.validate();
      const health = ctx.coverageAuditor.healthSummary();
      const totalNodes = config.layers.reduce((s: number, l: { children: unknown[] }) => s + l.children.length, 0);
      const detectedPlatforms = ctx.coverageAuditor.detectPlatforms();
      const audit = ctx.coverageAuditor.audit(config, validation, detectedPlatforms);

      res.json({
        status: 'ok',
        totalNodes,
        coverageScore: validation.coverageScore,
        cacheHitRate: health.cacheHitRate,
        avgLatencyMs: health.avgLatencyMs,
        errorRate: health.errorRate,
        searchCount: health.searchCount,
        degradedSearches: health.degradedSearches,
        gaps: audit.gaps,
        warnings: validation.warnings.length,
        errors: validation.errors.length,
      });
    } catch (err) {
      res.status(500).json({
        error: 'HEALTH_CHECK_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/self-knowledge/tree', (_req, res) => {
    if (!ctx.selfKnowledgeTree) {
      res.status(501).json({ error: 'SelfKnowledgeTree not initialized' });
      return;
    }

    const config = ctx.selfKnowledgeTree.getConfig();
    if (!config) {
      res.status(404).json({ error: 'Tree not generated yet' });
      return;
    }

    res.json(config);
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
      res.status(501).json({ error: 'ScopeVerifier not initialized' });
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
      res.status(501).json({ error: 'ScopeVerifier not initialized' });
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
      res.status(501).json({ error: 'ScopeVerifier not initialized' });
      return;
    }

    const bindings = ctx.coherenceGate.loadTopicBindings();
    res.json(bindings);
  });

  router.post('/topic-bindings', (req, res) => {
    if (!ctx.coherenceGate) {
      res.status(501).json({ error: 'ScopeVerifier not initialized' });
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

  // ── Working Memory Assembly ────────────────────────────────────────
  //
  // Token-budgeted context assembly from all memory layers.
  // NOTE: Must come BEFORE /context/:segmentId to avoid param capture.

  router.get('/context/working-memory', (req, res) => {
    if (!ctx.workingMemory) {
      res.status(503).json({ error: 'Working memory assembler not enabled' });
      return;
    }
    try {
      const { prompt, jobSlug, topicId, sessionId } = req.query;
      const result = ctx.workingMemory.assemble({
        prompt: typeof prompt === 'string' ? prompt : undefined,
        jobSlug: typeof jobSlug === 'string' ? jobSlug : undefined,
        topicId: topicId ? Number(topicId) : undefined,
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Assembly failed' });
    }
  });

  // ── Active Job Context ──────────────────────────────────────────────
  //
  // Returns the currently active job (if any) for scope coherence checkpoints.

  router.get('/context/active-job', (_req, res) => {
    const activeJob = ctx.state.get<{
      slug: string;
      name: string;
      description: string;
      priority: string;
      sessionName: string;
      triggeredBy: string;
      startedAt: string;
      grounding: unknown;
    }>('active-job');

    if (!activeJob) {
      res.json({ active: false });
      return;
    }

    res.json({ active: true, job: activeJob });
  });

  // ── Scope Coherence ──────────────────────────────────────────────────
  //
  // Tracks implementation depth for the scope coherence checkpoint system.
  // The 232nd Lesson: Implementation depth narrows scope.

  router.get('/scope-coherence', (_req, res) => {
    const tracker = new ScopeCoherenceTracker(ctx.state);
    res.json(tracker.getState());
  });

  router.post('/scope-coherence/record', (req, res) => {
    const { toolName, toolInput } = req.body || {};
    if (!toolName || typeof toolName !== 'string') {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }
    const tracker = new ScopeCoherenceTracker(ctx.state);
    tracker.recordAction(toolName, toolInput || {});
    res.json(tracker.getState());
  });

  router.get('/scope-coherence/check', (_req, res) => {
    const tracker = new ScopeCoherenceTracker(ctx.state);
    const result = tracker.shouldTriggerCheckpoint();

    // Enrich with active job context if triggering
    let jobContext = null;
    if (result.trigger) {
      const activeJob = ctx.state.get<{
        slug: string;
        name: string;
        description: string;
      }>('active-job');
      if (activeJob) {
        jobContext = {
          slug: activeJob.slug,
          name: activeJob.name,
          description: activeJob.description,
        };
      }
      tracker.recordCheckpointShown();
    }

    res.json({ ...result, jobContext });
  });

  router.post('/scope-coherence/reset', (_req, res) => {
    const tracker = new ScopeCoherenceTracker(ctx.state);
    tracker.reset();
    res.json({ reset: true });
  });

  // NOTE: Must come AFTER all specific /context/* routes to avoid param capture.
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

    // Enrich sessions with hook event telemetry and platform info
    const enriched = sessions.map(s => {
      const result: Record<string, unknown> = { ...s };

      // Add hook event telemetry
      if (req.query.enrich !== 'false' && ctx.hookEventReceiver) {
        const summary = ctx.hookEventReceiver.getSessionSummary(s.tmuxSession);
        if (summary) {
          result.telemetry = {
            eventCount: summary.eventCount,
            toolsUsed: summary.toolsUsed,
            subagentsSpawned: summary.subagentsSpawned,
            lastActivity: summary.lastEvent,
            taskCompleted: ctx.hookEventReceiver!.hasTaskCompleted(s.tmuxSession),
            exitReason: ctx.hookEventReceiver!.getExitReason(s.tmuxSession),
          };
        }
      }

      // Add platform indicator and display name
      if (ctx.telegram) {
        const topicId = ctx.telegram.getTopicForSession?.(s.tmuxSession);
        if (topicId) {
          result.platform = 'telegram';
          result.platformId = topicId;
          const topicName = ctx.telegram.getTopicName?.(topicId);
          if (topicName && !/^topic-\d+$/.test(topicName)) result.platformName = topicName;
        }
      }
      if (!result.platform && ctx.slack) {
        const channelId = ctx.slack.getChannelForSession(s.tmuxSession);
        if (channelId) {
          result.platform = 'slack';
          result.platformId = channelId;
          const registry = ctx.slack.getChannelRegistry();
          if (registry[channelId]?.channelName) result.platformName = registry[channelId].channelName;
        }
      }
      if (!result.platform) {
        result.platform = 'headless';
      }

      return result;
    });

    res.json(enriched);
  });

  router.post('/sessions/cleanup-stale', (_req, res) => {
    const cleaned = ctx.sessionManager.cleanupStaleSessions();

    // Also purge failed-messages files older than 24 hours
    const failDir = path.join(ctx.config.stateDir, 'state', 'failed-messages');
    let purgedFiles = 0;
    if (fs.existsSync(failDir)) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const fname of fs.readdirSync(failDir)) {
        const fpath = path.join(failDir, fname);
        try {
          if (fs.statSync(fpath).mtimeMs < cutoff) {
            fs.unlinkSync(fpath);
            purgedFiles++;
          }
        } catch { /* ignore individual file errors */ }
      }
    }

    res.json({ cleaned: cleaned.length, sessionIds: cleaned, purgedFailedMessages: purgedFiles });
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
      // Try direct UUID lookup first, then fall back to tmux session name lookup.
      // The dashboard sends tmux session names, not UUIDs.
      let killed = ctx.sessionManager.killSession(req.params.id);
      if (!killed) {
        // Look up by tmux session name
        const allSessions = ctx.state.listSessions({ status: 'running' });
        const match = allSessions.find(s => s.tmuxSession === req.params.id);
        if (match) {
          killed = ctx.sessionManager.killSession(match.id);
        }
      }
      if (!killed) {
        res.status(404).json({ error: `Session "${req.params.id}" not found` });
        return;
      }
      res.json({ ok: true, killed: req.params.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Create an interactive session from the dashboard.
  // Set platform to 'telegram', 'slack', or 'headless'.
  // Legacy: headless=true is equivalent to platform='headless'.
  router.post('/sessions/create', spawnLimiter, async (req, res) => {
    const { name, headless, platform } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      res.status(400).json({ error: '"name" is required (non-empty string)' });
      return;
    }
    if (name.length > 128) {
      res.status(400).json({ error: '"name" must be 128 characters or fewer' });
      return;
    }

    const topicName = name.trim();
    let topicId: number | undefined;
    let slackChannelId: string | undefined;
    const resolvedPlatform = platform || (headless ? 'headless' : (ctx.telegram ? 'telegram' : (ctx.slack ? 'slack' : 'headless')));

    // Create Telegram topic
    if (resolvedPlatform === 'telegram' && ctx.telegram) {
      try {
        const topic = await ctx.telegram.findOrCreateForumTopic(topicName);
        topicId = topic.topicId;
      } catch (err) {
        console.error(`[sessions/create] Telegram topic creation failed, proceeding headless: ${err}`);
      }
    }

    // Create Slack channel
    if (resolvedPlatform === 'slack' && ctx.slack) {
      try {
        const rawAgentName = (ctx.slack as unknown as { config: { workspaceName?: string } }).config?.workspaceName?.replace(/-agent$/i, '') || 'agent';
        const agentName = rawAgentName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        const channelName = `${agentName}-sess-${topicName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40)}`;
        slackChannelId = await ctx.slack.createChannel(channelName);
      } catch (err) {
        console.error(`[sessions/create] Slack channel creation failed, proceeding headless: ${err}`);
      }
    }

    try {
      const tmuxSession = await ctx.sessionManager.spawnInteractiveSession(
        undefined, // no initial message
        topicName,
        topicId ? { telegramTopicId: topicId } : undefined,
      );

      // Update topic-session registry if we created a Telegram topic
      if (topicId) {
        const registryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
        try {
          const reg = fs.existsSync(registryPath)
            ? JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
            : { topicToSession: {}, topicToName: {} };
          reg.topicToSession[String(topicId)] = tmuxSession;
          reg.topicToName[String(topicId)] = topicName;
          fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2));
        } catch {
          // Non-fatal — registry is best-effort
        }
      }

      // Update Slack channel-session registry and invite authorized users
      if (slackChannelId && ctx.slack) {
        ctx.slack.registerChannelSession(slackChannelId, tmuxSession, topicName);
        // Invite authorized users to the new channel
        try {
          const slackConfig = ctx.config.messaging?.find(m => m.type === 'slack')?.config as Record<string, unknown> | undefined;
          const authorizedUserIds = (slackConfig?.authorizedUserIds as string[]) ?? [];
          for (const userId of authorizedUserIds) {
            await ctx.slack.api.call('conversations.invite', { channel: slackChannelId, users: userId }).catch(() => {});
          }
        } catch { /* non-fatal */ }
      }

      res.status(201).json({
        ok: true,
        session: tmuxSession,
        name: topicName,
        topicId: topicId || null,
        slackChannelId: slackChannelId || null,
        platform: resolvedPlatform,
        headless: resolvedPlatform === 'headless',
      });
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

    const nextRunTimes = ctx.scheduler.getNextRunTimes();
    const jobs = ctx.scheduler.getJobs().map(job => {
      const jobState = ctx.state.getJobState(job.slug);
      // Merge live scheduler nextRun into state — fixes display bug where
      // never-run jobs show as "unscheduled" despite having active cron tasks
      const liveNext = nextRunTimes[job.slug];
      const mergedState = jobState
        ? { ...jobState, nextScheduled: jobState.nextScheduled ?? liveNext }
        : liveNext ? { slug: job.slug, lastRun: null, lastResult: null, nextScheduled: liveNext, consecutiveFailures: 0 } : null;
      return { ...job, state: mergedState, runsOnThisMachine: ctx.scheduler!.isJobLocal(job.slug) };
    });

    res.json({ jobs, queue: ctx.scheduler.getQueue() });
  });

  // ── Category Overseer Reports ────────────────────────────────────
  // These MUST be registered before /jobs/:slug routes to avoid Express
  // matching "categories" and "category-report" as :slug params.

  /**
   * GET /jobs/categories
   * List all unique category tags and their job counts.
   */
  router.get('/jobs/categories', (_req, res) => {
    if (!ctx.scheduler) {
      res.json({ categories: {} });
      return;
    }

    const allJobs = ctx.scheduler.getJobs();
    const categories: Record<string, string[]> = {};

    for (const job of allJobs) {
      for (const tag of job.tags ?? []) {
        if (tag.startsWith('cat:')) {
          const cat = tag.slice(4);
          if (!categories[cat]) categories[cat] = [];
          categories[cat].push(job.slug);
        }
      }
    }

    res.json({ categories });
  });

  /**
   * GET /jobs/category-report/:category
   * Aggregates run history, skip data, handoff notes, and health for all jobs
   * matching the given category tag. Used by overseer jobs to review their domain.
   */
  router.get('/jobs/category-report/:category', (req, res) => {
    const category = req.params.category;
    if (!category || !/^[a-z][a-z0-9-]{0,31}$/.test(category)) {
      res.status(400).json({ error: 'Invalid category name' });
      return;
    }
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    const sinceHours = parseInt(req.query.sinceHours as string) || 24;
    const allJobs = ctx.scheduler.getJobs();
    const history = ctx.scheduler.getRunHistory();
    const skipLedger = ctx.scheduler.getSkipLedger();

    // Find jobs matching this category (tag starts with "cat:" or exact match)
    const categoryTag = `cat:${category}`;
    const matchingJobs = allJobs.filter(j =>
      j.tags?.includes(categoryTag) || j.tags?.includes(category)
    );

    if (matchingJobs.length === 0) {
      res.json({ category, jobs: [], summary: { totalJobs: 0, healthy: 0, failing: 0, skipping: 0 } });
      return;
    }

    const jobReports = matchingJobs.map(job => {
      const jobState = ctx.state.getJobState(job.slug);
      const stats = history.stats(job.slug, sinceHours);
      const lastHandoff = history.getLastHandoff(job.slug);
      const skipSummary = skipLedger.getSkipSummary(sinceHours);
      const jobSkips = skipSummary[job.slug] || { total: 0, byReason: {} };
      const workloadTrend = skipLedger.getWorkloadTrend(job.slug);

      // Recent runs (last 5)
      const recentRuns = history.query({ slug: job.slug, limit: 5 }).runs.map(r => ({
        runId: r.runId,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        result: r.result,
        durationSeconds: r.durationSeconds,
        model: r.model,
        error: r.error,
      }));

      return {
        slug: job.slug,
        name: job.name,
        enabled: job.enabled,
        priority: job.priority,
        model: job.model,
        schedule: job.schedule,
        tags: job.tags,
        state: {
          lastRun: jobState?.lastRun,
          lastResult: jobState?.lastResult,
          consecutiveFailures: jobState?.consecutiveFailures ?? 0,
        },
        stats: stats ? {
          totalRuns: stats.totalRuns,
          successes: stats.successes,
          failures: stats.failures,
          successRate: stats.successRate,
          avgDurationSeconds: stats.avgDurationSeconds,
          runsPerDay: stats.runsPerDay,
        } : null,
        skips: {
          total: jobSkips.total,
          byReason: jobSkips.byReason,
        },
        workloadTrend: workloadTrend ? {
          avgSaturation: workloadTrend.avgSaturation,
          skipFastRate: workloadTrend.skipFastRate,
          avgDuration: workloadTrend.avgDuration,
          runCount: workloadTrend.runCount,
        } : null,
        lastHandoff: lastHandoff ? {
          notes: lastHandoff.handoffNotes,
          from: lastHandoff.completedAt,
        } : null,
        recentRuns,
      };
    });

    // Compute summary
    const healthy = jobReports.filter(j => j.state.consecutiveFailures === 0 && j.enabled).length;
    const failing = jobReports.filter(j => j.state.consecutiveFailures > 0).length;
    const skipping = jobReports.filter(j => j.skips.total > 0).length;
    const disabled = jobReports.filter(j => !j.enabled).length;
    const totalRuns = jobReports.reduce((sum, j) => sum + (j.stats?.totalRuns ?? 0), 0);
    const totalFailures = jobReports.reduce((sum, j) => sum + (j.stats?.failures ?? 0), 0);
    const avgSuccessRate = jobReports.length > 0
      ? jobReports.reduce((sum, j) => sum + (j.stats?.successRate ?? 100), 0) / jobReports.length
      : 100;

    res.json({
      category,
      sinceHours,
      generatedAt: new Date().toISOString(),
      summary: {
        totalJobs: matchingJobs.length,
        healthy,
        failing,
        skipping,
        disabled,
        totalRuns,
        totalFailures,
        avgSuccessRate: Math.round(avgSuccessRate * 10) / 10,
      },
      jobs: jobReports,
    });
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

  // ── Manual Job Trigger (Dashboard) ─────────────────────────────
  //
  // Rate-limited manual job trigger with security logging.
  // Used by the dashboard — stricter than /jobs/:slug/trigger.

  const manualTriggerLastRun = new Map<string, number>();
  let manualTriggerConcurrent = 0;
  const MANUAL_TRIGGER_MAX_CONCURRENT = 5;

  router.post('/jobs/:slug/run', (req, res) => {
    const { slug } = req.params;

    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    const job = ctx.scheduler.getJobs().find(j => j.slug === slug);
    if (!job) {
      res.status(404).json({ error: `Job not found: ${slug}` });
      return;
    }

    const jobState = ctx.state.getJobState(slug);
    if (jobState?.lastResult === 'pending') {
      res.status(409).json({ error: 'Job is already running' });
      return;
    }

    // Rate limit: minimum interval based on job's expected duration (in ms)
    const minIntervalMs = (job.expectedDurationMinutes ?? 5) * 60 * 1000;
    const lastTrigger = manualTriggerLastRun.get(slug);
    if (lastTrigger && Date.now() - lastTrigger < minIntervalMs) {
      const retryAfterSec = Math.ceil((minIntervalMs - (Date.now() - lastTrigger)) / 1000);
      res.status(429).json({
        error: 'Too soon — job was manually triggered recently',
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }

    // Global concurrency cap
    if (manualTriggerConcurrent >= MANUAL_TRIGGER_MAX_CONCURRENT) {
      res.status(429).json({ error: 'Too many concurrent manual triggers' });
      return;
    }

    try {
      manualTriggerConcurrent++;
      manualTriggerLastRun.set(slug, Date.now());

      const result = ctx.scheduler.triggerJob(slug, 'dashboard-manual');
      const runId = `manual-${slug}-${Date.now().toString(36)}`;

      // Decrement concurrent counter after a reasonable time
      // (the job itself is tracked by the scheduler, this just gates manual triggers)
      setTimeout(() => { manualTriggerConcurrent = Math.max(0, manualTriggerConcurrent - 1); }, 5000);

      // Security log
      try {
        const securityEntry = JSON.stringify({
          timestamp: new Date().toISOString(),
          action: 'job-run',
          slug,
          source: 'dashboard',
          ip: req.ip,
          result,
        });
        fs.appendFileSync(path.join(ctx.config.stateDir, 'security.jsonl'), securityEntry + '\n');
      } catch {
        // Security logging failure is non-fatal
      }

      res.status(202).json({ status: 'accepted', runId, result, message: 'Job queued for execution' });
    } catch (err) {
      manualTriggerConcurrent = Math.max(0, manualTriggerConcurrent - 1);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Job Enable/Disable (Dashboard) ────────────────────────────

  router.patch('/jobs/:slug', (req, res) => {
    const { slug } = req.params;

    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    // Allow-list: only { enabled: boolean } is accepted
    const body = req.body;
    const allowedKeys = ['enabled'];
    const bodyKeys = Object.keys(body || {});
    if (bodyKeys.length === 0 || bodyKeys.some(k => !allowedKeys.includes(k))) {
      res.status(400).json({ error: 'Only { enabled: boolean } is accepted' });
      return;
    }
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: '"enabled" must be a boolean' });
      return;
    }

    const job = ctx.scheduler.getJobs().find(j => j.slug === slug);
    if (!job) {
      res.status(404).json({ error: `Job not found: ${slug}` });
      return;
    }

    // Update the job's enabled state in the jobs.json config file
    try {
      const jobsFile = ctx.config.scheduler.jobsFile ?? path.join(ctx.config.stateDir, '..', 'jobs.json');
      if (fs.existsSync(jobsFile)) {
        const jobsData = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
        const jobEntry = (jobsData.jobs || jobsData).find((j: { slug: string }) => j.slug === slug);
        if (jobEntry) {
          jobEntry.enabled = body.enabled;
          fs.writeFileSync(jobsFile, JSON.stringify(jobsData, null, 2) + '\n');
        }
      }
    } catch (err) {
      res.status(500).json({ error: `Failed to update job config: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    // Security log
    try {
      const securityEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'job-toggle',
        slug,
        enabled: body.enabled,
        source: 'dashboard',
        ip: req.ip,
      });
      fs.appendFileSync(path.join(ctx.config.stateDir, 'security.jsonl'), securityEntry + '\n');
    } catch {
      // Security logging failure is non-fatal
    }

    res.json({ slug, enabled: body.enabled, message: `Job ${body.enabled ? 'enabled' : 'disabled'}` });
  });

  // ── Job Events (SSE) ──────────────────────────────────────────
  //
  // Server-Sent Events stream for real-time job state changes.
  // Auth checked inline since SSE connections don't go through normal middleware cleanly.

  router.get('/jobs/events', (req, res) => {
    // Inline auth check for SSE — supports both Authorization header and ?token= query param
    // (EventSource API cannot send custom headers, so token in query is required for browser SSE)
    if (ctx.config.authToken) {
      let tokenValue: string | undefined;
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        tokenValue = header.slice(7);
      } else if (typeof req.query.token === 'string') {
        tokenValue = req.query.token;
      }
      if (!tokenValue) {
        res.status(401).json({ error: 'Missing Authorization header or token query param' });
        return;
      }
      const ha = createHash('sha256').update(tokenValue).digest();
      const hb = createHash('sha256').update(ctx.config.authToken).digest();
      if (!timingSafeEqual(ha, hb)) {
        res.status(403).json({ error: 'Invalid token' });
        return;
      }
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let eventId = 0;

    // Send retry directive on first message
    res.write(`retry: 1000\n\n`);

    // Heartbeat every 15 seconds
    const heartbeat = setInterval(() => {
      eventId++;
      res.write(`id: ${eventId}\nevent: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, 15_000);

    // Send initial state snapshot
    if (ctx.scheduler) {
      eventId++;
      const jobs = ctx.scheduler.getJobs().map(job => {
        const jobState = ctx.state.getJobState(job.slug);
        return { slug: job.slug, name: job.name, enabled: job.enabled, state: jobState };
      });
      res.write(`id: ${eventId}\nevent: snapshot\ndata: ${JSON.stringify({ jobs, ts: Date.now() })}\n\n`);
    }

    // Poll for job state changes every 5 seconds and emit deltas
    let lastStates = new Map<string, string>();
    if (ctx.scheduler) {
      for (const job of ctx.scheduler.getJobs()) {
        const st = ctx.state.getJobState(job.slug);
        if (st) lastStates.set(job.slug, JSON.stringify(st));
      }
    }

    const poller = setInterval(() => {
      if (!ctx.scheduler) return;
      for (const job of ctx.scheduler.getJobs()) {
        const st = ctx.state.getJobState(job.slug);
        const stStr = st ? JSON.stringify(st) : '';
        const prev = lastStates.get(job.slug) ?? '';
        if (stStr !== prev) {
          lastStates.set(job.slug, stStr);
          eventId++;
          res.write(`id: ${eventId}\nevent: job-state\ndata: ${JSON.stringify({ slug: job.slug, state: st, ts: Date.now() })}\n\n`);
        }
      }
    }, 5_000);

    // Cleanup on close
    req.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(poller);
    });
  });

  // ── Job Run History ─────────────────────────────────────────────

  router.get('/jobs/history', (_req, res) => {
    if (!ctx.scheduler) {
      res.json({ runs: [], total: 0, stats: [] });
      return;
    }

    const history = ctx.scheduler.getRunHistory();
    const sinceHours = parseInt(_req.query.sinceHours as string) || undefined;
    const result = _req.query.result as string | undefined;
    const slug = _req.query.slug as string | undefined;
    const limit = Math.min(parseInt(_req.query.limit as string) || 50, 500);
    const offset = parseInt(_req.query.offset as string) || 0;

    if (slug && !JOB_SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }

    const validResults = ['pending', 'success', 'failure', 'timeout', 'spawn-error'];
    const resultFilter = result && validResults.includes(result) ? result as 'success' | 'failure' | 'timeout' | 'spawn-error' | 'pending' : undefined;

    const data = history.query({ slug, sinceHours, result: resultFilter, limit, offset });
    const stats = slug ? history.stats(slug, sinceHours) : history.allStats(sinceHours);

    res.json({ ...data, stats });
  });

  router.get('/jobs/:slug/history', (req, res) => {
    if (!JOB_SLUG_RE.test(req.params.slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }
    if (!ctx.scheduler) {
      res.json({ runs: [], total: 0, stats: null });
      return;
    }

    const history = ctx.scheduler.getRunHistory();
    const slug = req.params.slug;
    const sinceHours = parseInt(req.query.sinceHours as string) || undefined;
    const result = req.query.result as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const offset = parseInt(req.query.offset as string) || 0;

    const validResults = ['pending', 'success', 'failure', 'timeout', 'spawn-error'];
    const resultFilter = result && validResults.includes(result) ? result as 'success' | 'failure' | 'timeout' | 'spawn-error' | 'pending' : undefined;

    const data = history.query({ slug, sinceHours, result: resultFilter, limit, offset });
    const stats = history.stats(slug, sinceHours);

    res.json({ ...data, stats });
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

    const { name, color, firstMessage } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      res.status(400).json({ error: '"name" is required (non-empty string)' });
      return;
    }
    if (name.length > 128) {
      res.status(400).json({ error: '"name" must be 128 characters or fewer' });
      return;
    }
    if (firstMessage !== undefined && (typeof firstMessage !== 'string' || firstMessage.length > 4096)) {
      res.status(400).json({ error: '"firstMessage" must be a string of 4096 characters or fewer' });
      return;
    }

    // Color is optional — defaults to green (9367192)
    const iconColor = typeof color === 'number' ? color : 9367192;

    try {
      const topic = await ctx.telegram.findOrCreateForumTopic(name.trim(), iconColor);

      // Send initial message if provided — goes through sendToTopic so it's
      // properly logged to JSONL + TopicMemory. This ensures new sessions
      // spawned in this topic will see the context in their thread history.
      let messageSent = false;
      if (firstMessage && !topic.reused) {
        await ctx.telegram.sendToTopic(topic.topicId, firstMessage);
        messageSent = true;
      }

      res.status(topic.reused ? 200 : 201).json({
        topicId: topic.topicId,
        name: name.trim(),
        created: !topic.reused,
        reused: topic.reused,
        messageSent,
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
    const { text, metadata } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: '"text" field required' });
      return;
    }
    if (text.length > 4096) {
      res.status(400).json({ error: '"text" must be 4096 characters or fewer' });
      return;
    }

    try {
      const isProxy = metadata?.isProxy === true;
      await ctx.telegram.sendToTopic(topicId, text, { skipStallClear: isProxy });
      // Clear injection tracker — but NOT for proxy messages (PresenceProxy)
      // Proxy messages should not reset stall detection timers
      if (!isProxy) {
        ctx.sessionManager.clearInjectionTracker(topicId);
      }
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

  // ── Slack ──────────────────────────────────────────────────────

  router.post('/slack/reply/:channelId', async (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    const { channelId } = req.params;
    const { text, thread_ts } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: '"text" field required' });
      return;
    }

    try {
      const ts = await ctx.slack.sendToChannel(channelId, text, { thread_ts });

      // Notify onMessageLogged that the agent responded (so PresenceProxy cancels standby)
      if (ctx.slack.onMessageLogged) {
        ctx.slack.onMessageLogged({
          messageId: ts,
          channelId,
          text,
          fromUser: false,
          timestamp: new Date().toISOString(),
          sessionName: null,
          platform: 'slack',
        });
      }

      // Track for promise detection (detect "give me a minute" patterns)
      if (ctx.slack.trackPromise) {
        const sessionName = ctx.slack.getSessionForChannel(channelId);
        if (sessionName) {
          ctx.slack.trackPromise(channelId, sessionName, text);
        }
      }

      res.json({ ok: true, topicId: channelId, ts });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/internal/slack-forward', async (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    const { channelId, text } = req.body;
    if (!channelId || !text) {
      res.status(400).json({ error: '"channelId" and "text" fields required' });
      return;
    }

    try {
      await ctx.slack.sendToChannel(channelId, text);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/slack/channels', async (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    try {
      const channels = await ctx.slack.api.call('conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: req.query.include_archived !== 'true',
        limit: 200,
      });
      res.json({ ok: true, channels: channels.channels ?? [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/slack/channels', async (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    const { name, is_private } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: '"name" field required' });
      return;
    }

    try {
      const channelId = await ctx.slack.createChannel(name, is_private);
      res.json({ ok: true, channelId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/slack/channels/:channelId/messages', (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    const { channelId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 30, 100);

    const messages = ctx.slack.getChannelMessages(channelId, limit);
    res.json({ ok: true, messages, count: messages.length });
  });

  router.get('/slack/search', (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    const query = req.query.q as string | undefined;
    const channelId = req.query.channelId as string | undefined;
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const rawLimit = parseInt(req.query.limit as string, 10) || 50;
    const limit = Math.min(Math.max(rawLimit, 1), 500);

    const results = ctx.slack.searchLog({ query, channelId, since, limit });
    res.json({ results, count: results.length });
  });

  router.get('/slack/log-stats', (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    res.json(ctx.slack.getLogStats());
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

  router.delete('/attention/:id', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const item = ctx.telegram.getAttentionItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Attention item not found' });
      return;
    }

    // Soft-delete: mark as DONE
    await ctx.telegram.updateAttentionStatus(req.params.id, 'DONE');

    // Security log
    try {
      const securityEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'attention-dismiss',
        itemId: req.params.id,
        source: 'dashboard',
        ip: req.ip,
      });
      fs.appendFileSync(path.join(ctx.config.stateDir, 'security.jsonl'), securityEntry + '\n');
    } catch {
      // Security logging failure is non-fatal
    }

    res.json({ id: req.params.id, deleted: true });
  });

  // ── WhatsApp ────────────────────────────────────────────────────

  router.get('/whatsapp/status', (_req, res) => {
    if (!ctx.whatsapp) {
      res.status(503).json({ error: 'WhatsApp not configured' });
      return;
    }
    res.json(ctx.whatsapp.getStatus());
  });

  router.get('/whatsapp/qr', (_req, res) => {
    if (!ctx.whatsapp) {
      res.status(503).json({ error: 'WhatsApp not configured' });
      return;
    }
    const status = ctx.whatsapp.getStatus();
    res.json({
      qr: ctx.whatsapp.getQrCode(),
      state: status.state,
      phoneNumber: status.phoneNumber,
      error: status.lastError,
    });
  });

  // Send a WhatsApp message to a JID (used by whatsapp-reply.sh from Claude sessions)
  router.post('/whatsapp/send/:jid', async (req, res) => {
    if (!ctx.whatsapp) {
      res.status(503).json({ error: 'WhatsApp not configured' });
      return;
    }

    const { jid } = req.params;
    if (!jid) {
      res.status(400).json({ error: 'jid parameter required' });
      return;
    }
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: '"text" field required' });
      return;
    }
    if (text.length > 40000) {
      res.status(400).json({ error: '"text" must be 40000 characters or fewer' });
      return;
    }

    try {
      await ctx.whatsapp.send({
        content: text,
        userId: jid,
        channel: { type: 'whatsapp', identifier: jid },
      });
      res.json({ ok: true, jid });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/messaging/bridge', (_req, res) => {
    if (!ctx.messageBridge) {
      res.status(503).json({ error: 'Message bridge not configured' });
      return;
    }
    res.json({
      ...ctx.messageBridge.getStatus(),
      links: ctx.messageBridge.getLinks(),
    });
  });

  // ── iMessage ─────────────────────────────────────────────────────

  router.get('/imessage/status', (_req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }
    res.json(ctx.imessage.getConnectionInfo());
  });

  // ── Outbound Safety: validate-before-send endpoint ──
  // Called by imessage-reply.sh BEFORE sending. Issues a single-use token
  // that binds validation to the actual send (TOCTOU mitigation).
  router.post('/imessage/validate-send/:recipient', (req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    const { recipient } = req.params;
    if (!recipient) {
      res.status(400).json({ error: 'recipient parameter required' });
      return;
    }

    const result = ctx.imessage.validateSend(decodeURIComponent(recipient));

    if (!result.allowed) {
      res.status(403).json({
        allowed: false,
        reason: result.reason,
      });
      return;
    }

    res.json({
      allowed: true,
      token: result.token,
      sendMode: result.sendMode,
    });
  });

  // Reply confirmation endpoint — called by imessage-reply.sh AFTER sending via imsg CLI.
  // Requires a valid send token from validate-send (TOCTOU mitigation).
  // Logs the outbound message and clears stall tracking.
  router.post('/imessage/reply/:recipient', (req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    const { recipient } = req.params;
    if (!recipient) {
      res.status(400).json({ error: 'recipient parameter required' });
      return;
    }

    const decodedRecipient = decodeURIComponent(recipient);

    // Validate recipient is authorized
    if (!ctx.imessage.isAuthorized(decodedRecipient)) {
      res.status(403).json({ error: 'recipient not in authorizedContacts' });
      return;
    }

    const { text, sendToken } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: '"text" field required' });
      return;
    }

    // Validate send token if provided (TOCTOU binding)
    if (sendToken) {
      const tokenResult = ctx.imessage.confirmSend(sendToken, decodedRecipient, text);
      if (!tokenResult.ok) {
        res.status(403).json({ error: tokenResult.reason });
        return;
      }
    }

    // Log outbound message
    ctx.imessage.logOutboundMessage(decodedRecipient, text);

    // Clear stall tracking for this sender
    ctx.imessage.clearStallForSender(decodedRecipient);

    // Also clear in SessionManager if available
    if (ctx.sessionManager && 'clearIMessageInjectionTracker' in ctx.sessionManager) {
      (ctx.sessionManager as any).clearIMessageInjectionTracker(decodedRecipient);
    }

    res.json({ ok: true, recipient: decodedRecipient, logged: true });
  });

  router.get('/imessage/chats', async (req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    const limit = parseInt(req.query.limit as string) || 20;
    try {
      const chats = await ctx.imessage.listChats(limit);
      res.json(chats);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/imessage/chats/:chatId/history', async (req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    const { chatId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    try {
      const history = await ctx.imessage.getChatHistory(chatId, limit);
      res.json(history);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/imessage/log-stats', (_req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    try {
      const stats = ctx.imessage.messageLogger.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/imessage/search', (_req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    const query = (_req.query.q as string || '').trim();
    if (!query) {
      res.status(400).json({ error: 'q parameter required' });
      return;
    }

    const limit = parseInt(_req.query.limit as string) || 50;
    try {
      const results = ctx.imessage.messageLogger.search({ query, limit });
      res.json({ results, count: results.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
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
        instarVersion: ProcessIntegrity.getInstance()?.runningVersion || ctx.config.version || '0.0.0',
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
      autoApply: ctx.config.updates?.autoApply ?? true,
    });
  });

  router.patch('/updates/config', (req, res) => {
    const { autoApply } = req.body ?? {};
    if (typeof autoApply !== 'boolean') {
      res.status(400).json({ error: 'autoApply must be a boolean' });
      return;
    }

    // Update the runtime config
    if (!ctx.config.updates) {
      (ctx.config as any).updates = { autoApply };
    } else {
      ctx.config.updates.autoApply = autoApply;
    }

    // Persist to config.json
    const configPath = path.join(ctx.config.stateDir, 'config.json');
    try {
      const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};
      if (!raw.updates) raw.updates = {};
      raw.updates.autoApply = autoApply;
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
    } catch (err) {
      res.status(500).json({ error: `Failed to persist config: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    // Update the AutoUpdater's live config
    if (ctx.autoUpdater) {
      (ctx.autoUpdater as any).config.autoApply = autoApply;
    }

    res.json({ autoApply, persisted: true });
  });

  router.post('/updates/apply', async (_req, res) => {
    // Prefer AutoUpdater path (coalescing + session-aware gating)
    if (ctx.autoUpdater) {
      try {
        await ctx.autoUpdater.applyPendingUpdate({ bypassWindow: true });
        res.json(ctx.autoUpdater.getStatus());
      } catch (err) {
        // @silent-fallback-ok — returns HTTP 500 with error details to caller; not a silent degradation
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Fallback: direct apply (no coalescing/gating)
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

  // GET /updates/status — comprehensive update status for monitoring/UI
  router.get('/updates/status', async (_req, res) => {
    const status: Record<string, unknown> = {
      currentVersion: ctx.updateChecker?.getInstalledVersion() ?? 'unknown',
      autoApply: ctx.config.updates?.autoApply ?? true,
    };

    if (ctx.autoUpdater) {
      const auto = ctx.autoUpdater.getStatus();
      Object.assign(status, {
        pendingUpdate: auto.pendingUpdate,
        pendingUpdateDetectedAt: auto.pendingUpdateDetectedAt,
        coalescingUntil: auto.coalescingUntil,
        deferralReason: auto.deferralReason,
        deferralElapsedMinutes: auto.deferralElapsedMinutes,
        maxDeferralHours: auto.maxDeferralHours,
        lastCheck: auto.lastCheck,
        lastApply: auto.lastApply,
        lastAppliedVersion: auto.lastAppliedVersion,
        lastError: auto.lastError,
      });
    }

    res.json(status);
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
          instarVersion: ProcessIntegrity.getInstance()?.runningVersion || ctx.config.version || '0.0.0',
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

  // GET /quota/migration — Session migration state, history, and config
  router.get('/quota/migration', (_req, res) => {
    if (!ctx.quotaManager) {
      res.json({ status: 'not_configured' });
      return;
    }
    res.json(ctx.quotaManager.getMigrationStatus());
  });

  // POST /quota/migration/trigger — Manually trigger a migration
  router.post('/quota/migration/trigger', async (req, res) => {
    if (!ctx.quotaManager) {
      res.status(503).json({ error: 'QuotaManager not configured' });
      return;
    }
    try {
      const { targetAccount, bypassCooldown } = req.body ?? {};
      const result = await ctx.quotaManager.triggerMigration({ targetAccount, bypassCooldown });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /quota/polling — Adaptive polling state
  router.get('/quota/polling', (_req, res) => {
    if (!ctx.quotaManager) {
      res.json({ status: 'not_configured' });
      return;
    }
    res.json(ctx.quotaManager.getPollingStatus());
  });

  // ── Publishing (Telegraph) ──────────────────────────────────────

  router.post('/publish', async (req, res) => {
    if (!ctx.publisher) {
      res.status(503).json({ error: 'Publishing not configured' });
      return;
    }

    const { title, markdown, confirmed } = req.body;
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

    // Confirmation gate: Telegraph pages are PUBLIC. Require explicit confirmation.
    if (!confirmed) {
      res.status(400).json({
        error: 'Publishing requires confirmation',
        requiresConfirmation: true,
        warning: 'This will create a PUBLIC Telegraph page. Anyone with the URL can view it. ' +
          'Set "confirmed": true to proceed.',
        preview: { title, contentLength: markdown.length },
      });
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

  // ── Secret Drop (secure secret submission) ─────────────────────

  const secretDrop = new SecretDrop(ctx.config.projectName || 'Agent');

  /** Build a browser-clickable tunnel URL for a secret drop */
  function secretDropUrl(token: string): { localUrl: string; tunnelUrl: string | null } {
    const localUrl = `/secrets/drop/${token}`;
    const tunnelUrl = ctx.tunnel?.getExternalUrl(localUrl) ?? null;
    return { localUrl, tunnelUrl };
  }

  // Create a new secret request (agent-facing, requires auth)
  router.post('/secrets/request', (req, res) => {
    const { label, description, fields, topicId, ttlMs } = req.body;

    if (!label || typeof label !== 'string' || label.length > 256) {
      res.status(400).json({ error: '"label" must be a non-empty string under 256 characters' });
      return;
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 1024)) {
      res.status(400).json({ error: '"description" must be a string under 1024 characters' });
      return;
    }
    if (fields !== undefined) {
      if (!Array.isArray(fields) || fields.length === 0 || fields.length > 10) {
        res.status(400).json({ error: '"fields" must be an array of 1-10 items' });
        return;
      }
      for (const f of fields) {
        if (!f.name || typeof f.name !== 'string' || !f.label || typeof f.label !== 'string') {
          res.status(400).json({ error: 'Each field must have a "name" and "label"' });
          return;
        }
      }
    }
    if (topicId !== undefined && (typeof topicId !== 'number' || !Number.isInteger(topicId))) {
      res.status(400).json({ error: '"topicId" must be an integer' });
      return;
    }
    if (ttlMs !== undefined && (typeof ttlMs !== 'number' || ttlMs < 60_000 || ttlMs > 3600_000)) {
      res.status(400).json({ error: '"ttlMs" must be between 60000 (1 min) and 3600000 (1 hour)' });
      return;
    }

    try {
      const { token } = secretDrop.create({ label, description, fields, topicId, ttlMs });
      const urls = secretDropUrl(token);
      res.status(201).json({
        token,
        ...urls,
        expiresIn: ttlMs || 15 * 60 * 1000,
      });
    } catch (err) {
      res.status(429).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Serve the secret submission form (user-facing, NO auth — token is the auth)
  router.get('/secrets/drop/:token', (req, res) => {
    const request = secretDrop.getPending(req.params.token);
    if (!request) {
      const html = secretDrop.renderExpiredPage();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(410).send(html);
      return;
    }

    const html = secretDrop.renderForm(request);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Security headers — prevent framing, sniffing, caching
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.send(html);
  });

  // Receive a secret submission (user-facing, NO auth — token + CSRF is the auth)
  router.post('/secrets/drop/:token', async (req, res) => {
    const { _csrf, ...values } = req.body;

    if (!_csrf || typeof _csrf !== 'string') {
      res.status(400).json({ error: 'Missing CSRF token' });
      return;
    }

    // Validate all values are strings
    for (const [key, val] of Object.entries(values)) {
      if (typeof val !== 'string') {
        res.status(400).json({ error: `Field "${key}" must be a string` });
        return;
      }
      if ((val as string).length > 10_000) {
        res.status(400).json({ error: `Field "${key}" exceeds maximum length (10KB)` });
        return;
      }
    }

    const submission = secretDrop.submit(req.params.token, _csrf, values as Record<string, string>);
    if (!submission) {
      res.status(410).json({ error: 'This link has expired or already been used' });
      return;
    }

    // Send Telegram confirmation if topic is configured
    if (submission.topicId && ctx.telegram) {
      const fieldCount = Object.keys(submission.values).length;
      const confirmMsg = `\u2705 Secret received for "${submission.label}" (${fieldCount} field${fieldCount !== 1 ? 's' : ''}).`;
      ctx.telegram.sendToTopic(submission.topicId, confirmMsg).catch(() => {
        // @silent-fallback-ok — Non-fatal — the submission itself succeeded
      });
    }

    // Route a system message to the agent session so it can respond conversationally.
    // Uses the same inject-or-spawn pattern as Telegram forwarding.
    if (submission.topicId && ctx.sessionManager) {
      const topicId = submission.topicId;
      const fieldCount = Object.keys(submission.values).length;
      const fieldNames = Object.keys(submission.values).join(', ');
      const systemMsg = `[secret-drop-received] Secret "${submission.label}" was just submitted (${fieldCount} field${fieldCount !== 1 ? 's' : ''}: ${fieldNames}). ` +
        `Retrieve it with: curl -s -X POST -H "Authorization: Bearer $AUTH" http://localhost:${ctx.config.port}/secrets/retrieve/${req.params.token} | Then acknowledge receipt to the user conversationally via Telegram topic ${topicId}.`;

      const sdRegistryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
      let targetSession: string | null = null;
      try {
        if (fs.existsSync(sdRegistryPath)) {
          const registry = JSON.parse(fs.readFileSync(sdRegistryPath, 'utf-8'));
          targetSession = registry.topicToSession?.[String(topicId)] ?? null;
        }
      } catch { /* registry read failed — fall through to spawn */ }

      if (targetSession && ctx.sessionManager.isSessionAlive(targetSession)) {
        // Inject into existing session as a system reminder
        ctx.sessionManager.injectPasteNotification(targetSession,
          `<system-reminder>${systemMsg}</system-reminder>`);
      } else {
        // No live session — spawn one to handle the secret receipt
        let topicName = `topic-${topicId}`;
        // Try live adapter first, then disk registry, then active probe
        if (ctx.telegram) {
          const liveName = ctx.telegram.getTopicName(topicId);
          if (liveName && !/^topic-\d+$/.test(liveName)) {
            topicName = liveName;
          }
        }
        if (/^topic-\d+$/.test(topicName)) {
          try {
            if (fs.existsSync(sdRegistryPath)) {
              const reg = JSON.parse(fs.readFileSync(sdRegistryPath, 'utf-8'));
              const stored = reg.topicToName?.[String(topicId)];
              if (stored && !/^topic-\d+$/.test(stored)) topicName = stored;
            }
          } catch { /* fall through */ }
        }
        if (/^topic-\d+$/.test(topicName) && ctx.telegram) {
          try {
            const resolved = await ctx.telegram.resolveTopicName(topicId);
            if (resolved) topicName = resolved;
          } catch { /* fall through to default */ }
        }

        // Build context with thread history
        const historyLines: string[] = [];
        if (ctx.telegram) {
          try {
            const history = ctx.telegram.getTopicHistory(topicId, 50);
            if (history.length > 0) {
              historyLines.push(`--- Thread History (last ${history.length} messages) ---`);
              historyLines.push(`IMPORTANT: Read this history carefully before taking any action.`);
              historyLines.push(`Your task is to continue THIS conversation, not start something new.`);
              historyLines.push(`Topic: ${topicName}`);
              historyLines.push(``);
              for (const m of history) {
                const sender = m.fromUser ? (m.senderName || 'User') : 'Agent';
                const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
                const histText = (m.text || '').slice(0, 2000);
                historyLines.push(`[${ts}] ${sender}: ${histText}`);
              }
              historyLines.push(``);
              historyLines.push(`--- End Thread History ---`);
            }
          } catch {
            // Non-fatal — spawn without history
          }
        }

        const contextLines = [
          ...historyLines,
          ``,
          `This session was auto-created because a Secret Drop was submitted.`,
          ``,
          systemMsg,
          ``,
          `CRITICAL: You MUST relay your response back to Telegram after responding.`,
          `Use the relay script:`,
          ``,
          `cat <<'EOF' | .claude/scripts/telegram-reply.sh ${topicId}`,
          `Your response text here`,
          `EOF`,
        ];
        const tmpDir = '/tmp/instar-telegram';
        fs.mkdirSync(tmpDir, { recursive: true });
        const ctxPath = path.join(tmpDir, `ctx-${topicId}-${Date.now()}.txt`);
        fs.writeFileSync(ctxPath, contextLines.join('\n'));

        const bootstrapMessage = `[telegram:${topicId}] ${systemMsg} (IMPORTANT: Read ${ctxPath} for thread history and Telegram relay instructions — you MUST relay your response back.)`;

        const resumeSessionId = ctx.topicResumeMap?.get(topicId) ?? undefined;
        ctx.sessionManager.spawnInteractiveSession(bootstrapMessage, topicName, { telegramTopicId: topicId, resumeSessionId }).then((newSessionName) => {
          if (resumeSessionId) ctx.topicResumeMap?.remove(topicId);
          // Register in-memory topic↔session mapping for beforeSessionKill
          ctx.telegram?.registerTopicSession(topicId, newSessionName, topicName);
          try {
            const reg = fs.existsSync(sdRegistryPath) ? JSON.parse(fs.readFileSync(sdRegistryPath, 'utf-8')) : { topicToSession: {}, topicToName: {} };
            reg.topicToSession[String(topicId)] = newSessionName;
            fs.writeFileSync(sdRegistryPath, JSON.stringify(reg, null, 2));
          } catch { /* @silent-fallback-ok — registry write non-critical */ }
          // Proactive UUID save — always run, even after --resume (new session = new UUID)
          // ONLY uses authoritative claudeSessionId — never mtime fallback, which can
          // pick up a UUID from a different topic's concurrent session.
          if (ctx.topicResumeMap) {
            setTimeout(() => {
              try {
                const sessions = ctx.sessionManager?.listRunningSessions() ?? [];
                const session = sessions.find(s => s.tmuxSession === newSessionName);
                if (session?.claudeSessionId) {
                  ctx.topicResumeMap!.save(topicId, session.claudeSessionId, newSessionName);
                  console.log(`[secret-drop] Proactive UUID save: ${session.claudeSessionId} for topic ${topicId} (source: hook)`);
                }
              } catch (err) {
                console.error(`[secret-drop] Proactive UUID save failed:`, err);
              }
            }, 8000);
          }
          console.log(`[secret-drop] Spawned "${newSessionName}" for secret receipt on topic ${topicId}`);
        }).catch((err) => {
          console.error(`[secret-drop] Session spawn failed:`, err);
        });
      }
    }

    res.json({ ok: true, receivedAt: submission.receivedAt });
  });

  // List pending secret requests (agent-facing, requires auth)
  router.get('/secrets/pending', (_req, res) => {
    const pending = secretDrop.listPending();
    res.json({
      pending: pending.map(p => ({
        ...p,
        ...secretDropUrl(p.token),
      })),
    });
  });

  // Cancel a pending secret request (agent-facing, requires auth)
  router.delete('/secrets/pending/:token', (req, res) => {
    const cancelled = secretDrop.cancel(req.params.token);
    if (!cancelled) {
      res.status(404).json({ error: 'Request not found or already expired' });
      return;
    }
    res.json({ ok: true });
  });

  // Retrieve a received secret (agent-facing, requires auth)
  // This is for polling-based retrieval — the secret is returned once and deleted.
  router.post('/secrets/retrieve/:token', (req, res) => {
    const submission = secretDrop.getReceived(req.params.token);
    if (!submission) {
      res.status(404).json({ error: 'No submission found for this token' });
      return;
    }
    res.json(submission);
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

  // ── Dashboard Refresh ────────────────────────────────────────────
  // Re-broadcasts the dashboard URL to Telegram (edit-in-place).
  // Designed to be called by a lightweight cron job so the pinned
  // dashboard link never goes stale.

  router.post('/telegram/dashboard-refresh', async (_req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }
    if (!ctx.tunnel) {
      res.status(503).json({ error: 'Tunnel not running', action: 'skipped' });
      return;
    }

    const tunnelUrl = ctx.tunnel.url;
    if (!tunnelUrl) {
      res.status(503).json({ error: 'Tunnel has no URL yet', action: 'skipped' });
      return;
    }

    const tunnelType = (ctx.config.tunnel?.type === 'named' ? 'named' : 'quick') as 'quick' | 'named';

    // Named tunnels have permanent URLs — skip periodic refresh calls since
    // the URL never changes. The initial broadcast on server startup is sufficient.
    if (tunnelType === 'named') {
      res.json({ action: 'skipped', reason: 'named tunnel — URL is permanent', url: tunnelUrl, tunnelType });
      return;
    }

    try {
      await ctx.telegram.broadcastDashboardUrl(tunnelUrl, tunnelType);
      res.json({ action: 'refreshed', url: tunnelUrl, tunnelType });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
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

  router.post('/internal/telegram-forward', async (req, res) => {
    const { topicId, text, fromUserId, fromUsername, fromFirstName, messageId } = req.body;

    if (!topicId || !text) {
      res.status(400).json({ error: 'topicId and text required' });
      return;
    }

    // Log the message so it appears in JSONL + TopicMemory even when
    // the normal polling handler didn't receive it (Lifeline forwarding).
    // Only log if we have a real Telegram messageId — re-deliveries from
    // injectionDropped don't have one and the original was already logged.
    if (ctx.telegram && messageId) {
      ctx.telegram.logInboundMessage({
        messageId,
        topicId,
        text,
        timestamp: req.body.timestamp || new Date().toISOString(),
        senderName: fromFirstName,
        senderUsername: fromUsername,
        telegramUserId: fromUserId,
      });
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
        // Include topic name so session knows which conversation it's in, even after compaction
        let injectedTopicName: string | undefined;
        try {
          if (fs.existsSync(registryPath)) {
            const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
            injectedTopicName = reg.topicToName?.[String(topicId)] ?? undefined;
          }
        } catch { /* fall through without name */ }
        console.log(`[telegram-forward] Injecting into ${targetSession}: "${text.slice(0, 80)}"`);
        const injected = ctx.sessionManager.injectTelegramMessage(targetSession, topicId, text, injectedTopicName, fromFirstName, fromUserId);

        if (injected === false) {
          // Injection failed — save message under stateDir (not /tmp) to avoid world-readable exposure
          const failDir = path.join(ctx.config.stateDir, 'state', 'failed-messages');
          fs.mkdirSync(failDir, { recursive: true });
          const failFile = path.join(failDir, `failed-${topicId}-${Date.now()}.txt`);
          fs.writeFileSync(failFile, text);
          console.error(`[telegram→session] Injection FAILED for topic ${topicId} into ${targetSession}. Message saved to ${failFile}`);
          res.json({ ok: false, error: 'injection-failed', failFile, session: targetSession });
        } else {
          // Truncation detection — check if this message looks truncated and inject a hint
          const truncation = truncationDetector.detect(topicId, String(fromUserId || 'unknown'), text);
          if (truncation.truncationSuspected) {
            // Build Drop Zone URL (tunnel if available, otherwise localhost)
            let dzUrl = `http://localhost:${ctx.config.port}/dashboard?tab=dropzone`;
            if (ctx.tunnel) {
              try {
                const tunnelUrl = ctx.tunnel.url;
                if (tunnelUrl) {
                  dzUrl = `${tunnelUrl}/dashboard?tab=dropzone`;
                }
              } catch {}
            }
            // Inject a system hint after a short delay so it arrives after the message
            setTimeout(() => {
              const hint = `<system-reminder>The user's previous message may be truncated (${truncation.reason}). ` +
                `If their content appears incomplete, suggest they use the Drop Zone for longer content: ${dzUrl}</system-reminder>`;
              ctx.sessionManager.injectPasteNotification(targetSession, hint);
            }, 1000);
          }

          res.json({ ok: true, forwarded: true, method: 'registry-inject', session: targetSession });
        }
      } else {
        // No session or session dead — auto-spawn a new one
        // Use topic name from registry, NOT the tmux session name.
        // tmux names include the project prefix (e.g., "ai-guy-lifeline"), and
        // spawnInteractiveSession prepends it again → cascading names.
        let topicName = `topic-${topicId}`;
        // Try live adapter first, then disk registry, then active probe
        if (ctx.telegram) {
          const liveName = ctx.telegram.getTopicName(topicId);
          if (liveName && !/^topic-\d+$/.test(liveName)) {
            topicName = liveName;
          }
        }
        if (/^topic-\d+$/.test(topicName)) {
          try {
            if (fs.existsSync(registryPath)) {
              const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
              const stored = reg.topicToName?.[String(topicId)];
              if (stored && !/^topic-\d+$/.test(stored)) topicName = stored;
            }
          } catch { /* fall through */ }
        }
        if (/^topic-\d+$/.test(topicName) && ctx.telegram) {
          try {
            const resolved = await ctx.telegram.resolveTopicName(topicId);
            if (resolved) topicName = resolved;
          } catch { /* fall through to default */ }
        }
        console.log(`[telegram-forward] No live session for topic ${topicId}, spawning "${topicName}"...`);

        // Fetch thread history so auto-spawned sessions have full conversational context
        const historyLines: string[] = [];
        if (ctx.telegram) {
          try {
            const history = ctx.telegram.getTopicHistory(topicId, 50);
            if (history.length > 0) {
              historyLines.push(`--- Thread History (last ${history.length} messages) ---`);
              historyLines.push(`IMPORTANT: Read this history carefully before taking any action.`);
              historyLines.push(`Your task is to continue THIS conversation, not start something new.`);
              historyLines.push(`Topic: ${topicName}`);
              historyLines.push(``);
              for (const m of history) {
                const sender = m.fromUser
                  ? (m.senderName || 'User')
                  : 'Agent';
                const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
                const histText = (m.text || '').slice(0, 2000);
                historyLines.push(`[${ts}] ${sender}: ${histText}`);
              }
              historyLines.push(``);
              historyLines.push(`--- End Thread History ---`);
            }
          } catch (err) {
            console.error(`[telegram-forward] Failed to fetch thread history for topic ${topicId}:`, err);
          }
        }

        const contextLines = [
          ...historyLines,
          ``,
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

        const bootstrapMessage = `[telegram:${topicId}] ${text} (IMPORTANT: Read ${ctxPath} for thread history and Telegram relay instructions — you MUST relay your response back.)`;

        // Check for a resume UUID from a previously-killed session.
        // TopicResumeMap is authoritative — skip LLM validation for this source.
        let resumeSessionId = ctx.topicResumeMap?.get(topicId) ?? undefined;
        if (resumeSessionId) {
          console.log(`[telegram-forward] Found resume UUID for topic ${topicId}: ${resumeSessionId} (source: TopicResumeMap — trusted)`);
        }

        ctx.sessionManager.spawnInteractiveSession(bootstrapMessage, topicName, { telegramTopicId: topicId, resumeSessionId }).then((newSessionName) => {
          // Clear resume entry after successful spawn
          if (resumeSessionId) {
            ctx.topicResumeMap?.remove(topicId);
          }
          // Register in-memory topic↔session mapping so beforeSessionKill
          // can look up the topic ID and save the resume UUID on kill.
          ctx.telegram?.registerTopicSession(topicId, newSessionName, topicName);
          // Update registry on disk
          try {
            const reg = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf-8')) : { topicToSession: {}, topicToName: {} };
            reg.topicToSession[String(topicId)] = newSessionName;
            fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2));
          } catch { /* @silent-fallback-ok — registry write non-critical */ }
          // Proactive UUID save — always run, even after --resume (new session = new UUID)
          // ONLY uses authoritative claudeSessionId — never mtime fallback, which can
          // pick up a UUID from a different topic's concurrent session.
          if (ctx.topicResumeMap) {
            setTimeout(() => {
              try {
                const sessions = ctx.sessionManager?.listRunningSessions() ?? [];
                const session = sessions.find(s => s.tmuxSession === newSessionName);
                if (session?.claudeSessionId) {
                  ctx.topicResumeMap!.save(topicId, session.claudeSessionId, newSessionName);
                  console.log(`[telegram-forward] Proactive UUID save: ${session.claudeSessionId} for topic ${topicId} (source: hook)`);
                }
              } catch (err) {
                console.error(`[telegram-forward] Proactive UUID save failed:`, err);
              }
            }, 8000);
          }
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

  // ── Plan Prompt Relay (from hook) ─────────────────────────────
  // Receives plan mode entry events from the PreToolUse hook on EnterPlanMode.
  // Relays the plan to Telegram for user approval via inline keyboard.
  // The hook polls /hooks/plan-prompt/status until the user responds.

  // Track pending plan prompts so the hook can poll for resolution.
  // Key: promptId, Value: { resolved, key, sessionName, createdAt }
  const pendingPlanPrompts = new Map<string, {
    resolved: boolean;
    key?: string;
    sessionName: string;
    createdAt: number;
  }>();

  // Evict stale entries every 5 minutes (prompts older than 10 min)
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, entry] of pendingPlanPrompts) {
      if (entry.createdAt < cutoff) pendingPlanPrompts.delete(id);
    }
  }, 5 * 60 * 1000);

  // Wire resolution: when a prompt callback fires, mark the plan prompt as resolved.
  // This is called from the onPromptResponse path in TelegramAdapter.
  const resolvePlanPrompt = (sessionName: string, key: string) => {
    for (const [id, entry] of pendingPlanPrompts) {
      if (entry.sessionName === sessionName && !entry.resolved) {
        entry.resolved = true;
        entry.key = key;
        console.log(`[PlanRelay] Prompt ${id} resolved: session="${sessionName}" key="${key}"`);
        break;
      }
    }
  };
  // Internal endpoint — called by onPromptResponse to mark plan prompts resolved
  router.post('/hooks/plan-prompt/resolve', (req, res) => {
    const { sessionName, key } = req.body;
    if (sessionName && key) {
      resolvePlanPrompt(sessionName, key);
    }
    res.json({ ok: true });
  });

  router.post('/hooks/plan-prompt', async (req, res) => {
    const { event, session_id, tool_input, instar_sid } = req.body;

    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    console.log(`[PlanRelay] Received plan-prompt event: sid=${instar_sid} claude_sid=${session_id}`);

    // Find the session and its topic binding
    let topicId: number | undefined;
    let tmuxSession: string | undefined;

    // Strategy 1: look up by instar session ID or Claude session ID
    const sessions = ctx.sessionManager.listRunningSessions();
    const session = sessions.find(s =>
      s.id === instar_sid || s.claudeSessionId === session_id
    );
    if (session) {
      tmuxSession = session.tmuxSession;
      topicId = ctx.telegram.getTopicForSession(session.tmuxSession) ?? undefined;
    }

    // Strategy 2: check all topic-session mappings for a match
    if (!topicId && instar_sid) {
      const allTopics = ctx.telegram.getAllTopicMappings?.() ?? [];
      for (const mapping of allTopics) {
        if (mapping.sessionName && (mapping.sessionName === instar_sid || instar_sid.includes(mapping.sessionName))) {
          topicId = mapping.topicId;
          tmuxSession = mapping.sessionName;
          break;
        }
      }
    }

    // Strategy 3: use the INSTAR_TELEGRAM_TOPIC env if the hook passed it
    if (!topicId && req.body.telegram_topic) {
      topicId = parseInt(req.body.telegram_topic, 10);
    }

    if (!topicId) {
      console.log(`[PlanRelay] No topic binding found for sid=${instar_sid}`);
      res.json({ ok: false, reason: 'no topic binding' });
      return;
    }

    // Build a DetectedPrompt and relay it
    try {
      const promptId = crypto.randomUUID().slice(0, 8);
      const sessionName = tmuxSession || session?.tmuxSession || 'unknown';

      const prompt = {
        type: 'plan' as const,
        raw: '',
        summary: 'Plan approval requested — the agent has a plan and is waiting for your decision.',
        options: [
          { key: '1', label: 'Yes, and bypass permissions' },
          { key: '2', label: 'Yes, manually approve edits' },
          { key: '3', label: 'Tell Claude what to change' },
        ],
        sessionName,
        detectedAt: Date.now(),
        id: promptId,
      };

      // Track the pending prompt so the hook can poll for resolution
      pendingPlanPrompts.set(promptId, {
        resolved: false,
        sessionName,
        createdAt: Date.now(),
      });

      await ctx.telegram.relayPrompt(topicId, prompt);
      console.log(`[PlanRelay] Relayed plan prompt ${promptId} to topic ${topicId} for session ${sessionName}`);
      res.json({ ok: true, topicId, promptId });
    } catch (err) {
      console.error(`[PlanRelay] Failed:`, err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Status endpoint — the hook polls this to know when the user has responded
  router.get('/hooks/plan-prompt/status', (req, res) => {
    const promptId = req.query.id as string;
    if (!promptId) {
      res.status(400).json({ error: 'missing id parameter' });
      return;
    }
    const entry = pendingPlanPrompts.get(promptId);
    if (!entry) {
      // Unknown prompt — tell hook to stop polling
      res.json({ resolved: true, key: '1', reason: 'unknown prompt' });
      return;
    }
    res.json({ resolved: entry.resolved, key: entry.key });
  });

  // ── Telegram Callback Query Forwarding (from Lifeline) ────────
  // Receives inline keyboard callback queries that the Lifeline forwarded.
  // Processes them through TelegramAdapter.processCallbackQuery().

  router.post('/internal/telegram-callback', async (req, res) => {
    const { callbackQueryId, data, fromUserId, messageId, chatId } = req.body;

    if (!callbackQueryId || !data) {
      res.status(400).json({ error: 'callbackQueryId and data required' });
      return;
    }

    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    try {
      // Reconstruct a callback query object and process it through TelegramAdapter
      const query = {
        id: callbackQueryId,
        data,
        from: { id: fromUserId, is_bot: false, first_name: 'user' },
        message: messageId ? { message_id: messageId, chat: { id: chatId } } : undefined,
      };

      // Use the adapter's public method for processing forwarded callbacks
      await ctx.telegram.handleForwardedCallback(query);
      res.json({ ok: true });
    } catch (err) {
      console.error(`[telegram-callback] Processing failed:`, err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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

    // Learning→Soul pipeline nudge: if soul.md is enabled, hint whether this
    // learning might be identity-relevant (the agent decides whether to act on it).
    let soulNudge: string | undefined;
    if (ctx.soulManager?.isEnabled()) {
      // Simple heuristic: check if the learning touches identity-related keywords.
      // The full LLM classifier runs in the identity-review job; this is a fast hint.
      const identityKeywords = /value|principle|belief|conviction|identity|who i am|growth|voice|authenticity|self-|philosophy|meaning|purpose/i;
      if (identityKeywords.test(title) || identityKeywords.test(description)) {
        soulNudge = 'This learning may be identity-relevant. Consider updating soul.md or running /reflect.';
      }
    }

    res.status(201).json({ ...learning, soulNudge });
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

  // ── Implicit Evolution Detection ─────────────────────────────
  // Scans open gaps/proposals for items already resolved by existing infrastructure.
  // Born from Dawn's REC-52-2 pattern: detect when capability needs are already met.
  router.get('/evolution/implicit', (_req, res) => {
    if (!ctx.evolution) {
      res.json({ implicit: [], count: 0 });
      return;
    }
    const implicit = ctx.evolution.detectImplicitEvolution();
    res.json({ implicit, count: implicit.length });
  });

  // ── Implementation Trace Verification ────────────────────────
  // Checks whether "implemented" proposals left actual file traces.
  // Inspired by Dawn's lesson-behavior-gap analyzer: detects phantom
  // implementations where proposals were marked done without real changes.
  router.get('/evolution/traces', (_req, res) => {
    if (!ctx.evolution) {
      res.json({ traces: [], count: 0, unverified: 0 });
      return;
    }
    const traces = ctx.evolution.verifyImplementationTraces();
    const unverified = traces.filter(t => t.verdict === 'unverified').length;
    const weak = traces.filter(t => t.verdict === 'weak').length;
    res.json({ traces, count: traces.length, unverified, weak });
  });

  // ── Serendipity Protocol ─────────────────────────────────────
  router.get('/serendipity/stats', (_req, res) => {
    const serendipityDir = path.join(ctx.config.stateDir, 'state', 'serendipity');
    const processedDir = path.join(serendipityDir, 'processed');
    const invalidDir = path.join(serendipityDir, 'invalid');

    const countJsonFiles = (dir: string): number => {
      try {
        return fs.readdirSync(dir).filter((f: string) => f.endsWith('.json') && !f.endsWith('.tmp')).length;
      } catch {
        return 0;
      }
    };

    const pending = countJsonFiles(serendipityDir);
    const processed = countJsonFiles(processedDir);
    const invalid = countJsonFiles(invalidDir);

    // Get details of pending findings
    const pendingFindings: Array<{ id: string; title: string; category: string; readiness: string; createdAt: string }> = [];
    try {
      const files = fs.readdirSync(serendipityDir).filter((f: string) => f.endsWith('.json') && !f.endsWith('.tmp'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(serendipityDir, file), 'utf-8'));
          pendingFindings.push({
            id: data.id || file.replace('.json', ''),
            title: data.discovery?.title || '(untitled)',
            category: data.discovery?.category || 'unknown',
            readiness: data.readiness || 'unknown',
            createdAt: data.createdAt || '',
          });
        } catch {
          // Skip unparseable files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    res.json({
      pending,
      processed,
      invalid,
      total: pending + processed + invalid,
      pendingFindings,
    });
  });

  router.get('/serendipity/findings', (_req, res) => {
    const serendipityDir = path.join(ctx.config.stateDir, 'state', 'serendipity');
    const findings: unknown[] = [];
    try {
      const files = fs.readdirSync(serendipityDir).filter((f: string) => f.endsWith('.json') && !f.endsWith('.tmp'));
      for (const file of files) {
        try {
          findings.push(JSON.parse(fs.readFileSync(path.join(serendipityDir, file), 'utf-8')));
        } catch {
          // Skip unparseable
        }
      }
    } catch {
      // Directory doesn't exist
    }
    res.json({ findings });
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

    const { topicId, summary, purpose, messageCount, lastMessageId } = req.body || {};
    if (typeof topicId !== 'number' || typeof summary !== 'string') {
      res.status(400).json({ error: 'topicId (number) and summary (string) required' });
      return;
    }

    ctx.topicMemory.saveTopicSummary(topicId, summary, messageCount ?? 0, lastMessageId ?? 0, purpose ?? null);
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

  // ── Systems Dashboard (rich telemetry) ──────────────────────────
  // Shared helper: safely extract data from a subsystem
  function safeGet<T>(fn: () => T): T | null {
    try { return fn(); } catch { return null; }
  }

  // Build capability telemetry for one capability
  function buildCapabilityTelemetry(id: string): {
    metric: string;
    stats: Record<string, number | string | boolean | null>;
    lastActivity: string | null;
  } {
    const stats: Record<string, number | string | boolean | null> = {};
    let lastActivity: string | null = null;
    let metric = 'Active';

    try {
      switch (id) {
        case 'session-recovery': {
          const ws = safeGet(() => ctx.watchdog?.getStats?.());
          const ts = safeGet(() => ctx.triageNurse?.getStatus?.());
          if (ws) {
            stats.interventions = ws.interventionsTotal ?? 0;
            stats.recoveries = ws.recoveries ?? 0;
            stats.sessionDeaths = ws.sessionDeaths ?? 0;
            stats.llmOverrides = ws.llmGateOverrides ?? 0;
            metric = ws.interventionsTotal > 0
              ? `${ws.recoveries} recovered · ${ws.interventionsTotal} interventions`
              : 'No interventions needed';
          }
          if (ts) {
            stats.activeCases = ts.activeCases ?? 0;
            stats.totalTriages = ts.historyCount ?? 0;
            stats.cooldowns = ts.cooldowns ?? 0;
            if (ts.activeCases) metric += ` · ${ts.activeCases} active`;
          }
          if (!ws && !ts) metric = 'Standing by';
          break;
        }
        case 'session-intelligence': {
          stats.monitoring = true;
          metric = 'Monitoring active sessions';
          break;
        }
        case 'health-monitoring': {
          const cr = safeGet(() => ctx.coherenceMonitor?.getLastReport?.()) as { passed?: number; failed?: number; corrected?: number; timestamp?: string } | null;
          const sr = safeGet(() => ctx.systemReviewer?.getHealthStatus?.()) as { status?: string; message?: string; lastCheck?: string } | null;
          const mp = safeGet(() => ctx.memoryMonitor?.getState?.()) as { pressurePercent?: number; state?: string; freeGB?: number; totalGB?: number; trend?: string; lastChecked?: string } | null;
          const op = safeGet(() => ctx.orphanReaper?.getLastReport?.()) as { tracked?: unknown[]; orphans?: unknown[]; totalMemoryMB?: number; timestamp?: string } | null;
          const parts: string[] = [];
          if (cr) {
            stats.coherenceChecks = (cr.passed ?? 0) + (cr.failed ?? 0);
            stats.coherencePassed = cr.passed ?? 0;
            stats.coherenceFailed = cr.failed ?? 0;
            stats.coherenceCorrected = cr.corrected ?? 0;
            if (cr.timestamp) lastActivity = cr.timestamp;
            parts.push(cr.failed ? `${cr.failed} failing` : `${cr.passed ?? 0} checks passed`);
          }
          if (sr) {
            stats.reviewStatus = sr.status ?? 'unknown';
            if (sr.lastCheck) lastActivity = sr.lastCheck;
            if (sr.message) parts.push(sr.message);
          }
          if (mp) {
            stats.memoryPercent = Math.round(mp.pressurePercent ?? 0);
            stats.memoryState = mp.state ?? 'unknown';
            stats.memoryFreeGB = Math.round((mp.freeGB ?? 0) * 10) / 10;
            stats.memoryTotalGB = Math.round((mp.totalGB ?? 0) * 10) / 10;
            stats.memoryTrend = mp.trend ?? 'stable';
            if (mp.lastChecked) lastActivity = mp.lastChecked;
            parts.push(`Memory ${Math.round(mp.pressurePercent ?? 0)}%`);
          }
          if (op) {
            stats.trackedProcesses = Array.isArray(op.tracked) ? op.tracked.length : 0;
            stats.orphanProcesses = Array.isArray(op.orphans) ? op.orphans.length : 0;
            stats.totalMemoryMB = Math.round(op.totalMemoryMB ?? 0);
          }
          metric = parts.join(' · ') || 'All checks passing';
          break;
        }
        case 'safety-trust': { stats.gatesActive = true; metric = 'All gates active'; break; }
        case 'coherence': {
          const cr = safeGet(() => ctx.coherenceMonitor?.getHealth?.()) as { status?: string; lastCheck?: string } | null;
          if (cr?.lastCheck) lastActivity = cr.lastCheck;
          metric = 'Monitoring project integrity';
          break;
        }
        case 'scheduled-jobs': {
          const js = safeGet(() => ctx.scheduler?.getStatus?.());
          if (js) {
            stats.totalJobs = js.jobCount ?? 0;
            stats.enabledJobs = js.enabledJobs ?? 0;
            stats.queueLength = js.queueLength ?? 0;
            stats.activeJobSessions = js.activeJobSessions ?? 0;
            const parts = [`${js.enabledJobs} jobs enabled`];
            if (js.activeJobSessions > 0) parts.push(`${js.activeJobSessions} running`);
            if (js.queueLength > 0) parts.push(`${js.queueLength} queued`);
            metric = parts.join(' · ');
          }
          break;
        }
        case 'quota': {
          const qs = safeGet(() => ctx.quotaTracker?.getState?.());
          if (qs) {
            stats.weeklyUsage = Math.round(qs.usagePercent ?? 0);
            stats.fiveHourRate = qs.fiveHourPercent != null ? Math.round(qs.fiveHourPercent) : null;
            stats.recommendation = qs.recommendation ?? 'normal';
            if (qs.lastUpdated) lastActivity = qs.lastUpdated;
            const parts = [`Weekly usage ${Math.round(qs.usagePercent)}%`];
            if (qs.fiveHourPercent != null) parts.push(`5h rate ${Math.round(qs.fiveHourPercent)}%`);
            metric = parts.join(' · ');
          }
          break;
        }
        case 'telegram': {
          const ts = safeGet(() => ctx.telegram?.getStatus?.());
          const ls = safeGet(() => ctx.telegram?.getLogStats?.());
          if (ts) {
            stats.connected = ts.started ?? false;
            stats.uptimeMs = ts.uptime ?? 0;
            stats.topicMappings = ts.topicMappings ?? 0;
            stats.pendingStalls = ts.pendingStalls ?? 0;
            const parts: string[] = [];
            if (ts.uptime) {
              const hrs = Math.floor(ts.uptime / 3600000);
              const mins = Math.floor((ts.uptime % 3600000) / 60000);
              parts.push(`Connected ${hrs > 0 ? hrs + 'h ' : ''}${mins}m`);
            }
            if (ts.topicMappings > 0) parts.push(`${ts.topicMappings} topics`);
            metric = parts.join(' · ') || 'Connected';
          }
          if (ls) { stats.totalMessages = ls.totalMessages ?? 0; }
          break;
        }
        case 'whatsapp': { metric = 'Connected'; break; }
        case 'slack': { metric = 'Connected'; break; }
        case 'message-routing': { metric = 'Routing active'; break; }
        case 'memory': { metric = 'Context assembly active'; break; }
        case 'evolution': {
          const ed = safeGet(() => ctx.evolution?.getDashboard?.()) as {
            evolution?: { totalProposals?: number }; learnings?: { totalLearnings?: number; applied?: number };
            gaps?: { totalGaps?: number }; actions?: { totalActions?: number; overdue?: number };
          } | null;
          if (ed) {
            stats.proposals = ed.evolution?.totalProposals ?? 0;
            stats.learnings = ed.learnings?.totalLearnings ?? 0;
            stats.learningsApplied = ed.learnings?.applied ?? 0;
            stats.gaps = ed.gaps?.totalGaps ?? 0;
            stats.actions = ed.actions?.totalActions ?? 0;
            stats.overdueActions = ed.actions?.overdue ?? 0;
            const parts: string[] = [];
            if (ed.evolution?.totalProposals) parts.push(`${ed.evolution.totalProposals} proposals`);
            if (ed.gaps?.totalGaps) parts.push(`${ed.gaps.totalGaps} gaps`);
            if (ed.learnings?.applied) parts.push(`${ed.learnings.applied} applied`);
            metric = parts.join(' · ') || 'Monitoring capabilities';
          }
          break;
        }
        case 'infrastructure': {
          const tunnelUrl = safeGet(() => ctx.tunnel?.getExternalUrl?.('/'));
          stats.tunnelActive = !!tunnelUrl;
          metric = tunnelUrl ? 'Tunnel active' : 'Running';
          break;
        }
      }
    } catch { /* fallback */ }

    return { metric, stats, lastActivity };
  }

  router.get('/systems/status', (_req, res) => {
    const uptimeMs = Date.now() - ctx.startTime.getTime();

    // ── Capability metadata: maps internal subsystems to user-friendly labels ──
    interface CapabilityDef {
      id: string;
      label: string;
      description: string;
      processes: { name: string; subsystem: unknown; statusFn?: () => unknown }[];
    }

    const capabilityDefs: CapabilityDef[] = [
      {
        id: 'session-recovery',
        label: 'Session Recovery',
        description: 'Detects stuck or crashed sessions and automatically recovers them. Uses a 4-layer stack: watchdog catches stuck commands, mechanical recovery fixes JSONL issues, heuristics handle 90% of remaining cases, and LLM diagnosis covers the rest.',
        processes: [
          { name: 'SessionWatchdog', subsystem: ctx.watchdog, statusFn: () => ctx.watchdog?.getStatus() },
          { name: 'StallTriageNurse', subsystem: ctx.triageNurse, statusFn: () => ctx.triageNurse?.getStatus() },
          { name: 'SpawnRequestManager', subsystem: ctx.spawnManager },
        ],
      },
      {
        id: 'session-intelligence',
        label: 'Session Intelligence',
        description: 'Monitors session activity and generates summaries for smart message routing. Captures terminal output every 60 seconds to enable intelligent routing of incoming messages to the most relevant session.',
        processes: [
          { name: 'SessionActivitySentinel', subsystem: ctx.activitySentinel },
          { name: 'SessionSummarySentinel', subsystem: ctx.summarySentinel },
        ],
      },
      {
        id: 'health-monitoring',
        label: 'Health Monitoring',
        description: 'Continuous self-checks across config drift, resource pressure, system integrity, and functional probes. Runs coherence checks every 5 minutes and deep system reviews every 6 hours.',
        processes: [
          { name: 'CoherenceMonitor', subsystem: ctx.coherenceMonitor, statusFn: () => ctx.coherenceMonitor?.getLastReport() },
          { name: 'SystemReviewer', subsystem: ctx.systemReviewer, statusFn: () => ctx.systemReviewer?.getHealthStatus() },
          { name: 'MemoryPressureMonitor', subsystem: ctx.memoryMonitor, statusFn: () => ctx.memoryMonitor?.getState() },
          { name: 'OrphanProcessReaper', subsystem: ctx.orphanReaper, statusFn: () => ctx.orphanReaper?.getLastReport() },
        ],
      },
      {
        id: 'safety-trust',
        label: 'Safety & Trust',
        description: 'Gates external operations by risk level, validates inbound messages against injection patterns, and manages adaptive trust levels per service.',
        processes: [
          { name: 'ExternalOperationGate', subsystem: ctx.operationGate },
          { name: 'MessageSentinel', subsystem: ctx.sentinel },
          { name: 'AdaptiveTrust', subsystem: ctx.adaptiveTrust },
          { name: 'AutonomyManager', subsystem: ctx.autonomyManager },
        ],
      },
      {
        id: 'coherence',
        label: 'Coherence & Integrity',
        description: 'Ensures project state, scope boundaries, and response quality remain consistent. Prevents cross-project contamination and validates agent instructions are properly loaded.',
        processes: [
          { name: 'CoherenceGate', subsystem: ctx.coherenceGate },
          { name: 'ResponseReviewGate', subsystem: ctx.responseReviewGate },
          { name: 'CanonicalState', subsystem: ctx.canonicalState },
          { name: 'InstructionsVerifier', subsystem: ctx.instructionsVerifier },
        ],
      },
      {
        id: 'scheduled-jobs',
        label: 'Scheduled Jobs',
        description: 'Runs tasks on cron schedules with priority-based queuing. Also tracks behavioral commitments the agent made to the user.',
        processes: [
          { name: 'JobScheduler', subsystem: ctx.scheduler },
          { name: 'CommitmentTracker', subsystem: ctx.commitmentTracker, statusFn: () => ({ active: ctx.commitmentTracker?.getActive().length ?? 0 }) },
        ],
      },
      {
        id: 'quota',
        label: 'Quota Management',
        description: 'Tracks Claude API token usage in real-time. Sends warnings when approaching limits, enforces quotas, and auto-switches between accounts if configured.',
        processes: [
          { name: 'QuotaTracker', subsystem: ctx.quotaTracker, statusFn: () => ctx.quotaTracker?.getState() },
          { name: 'QuotaManager', subsystem: ctx.quotaManager },
        ],
      },
      {
        id: 'telegram',
        label: 'Telegram',
        description: 'Full Telegram messaging integration with long-polling, topic-based session routing, notification batching, and delivery retry.',
        processes: [
          { name: 'TelegramAdapter', subsystem: ctx.telegram },
        ],
      },
      {
        id: 'whatsapp',
        label: 'WhatsApp',
        description: 'Sends and receives messages through WhatsApp',
        processes: [
          { name: 'WhatsAppAdapter', subsystem: ctx.whatsapp },
        ],
      },
      {
        id: 'slack',
        label: 'Slack',
        description: 'Sends and receives messages through Slack',
        processes: [
          { name: 'SlackAdapter', subsystem: ctx.slack },
        ],
      },
      {
        id: 'message-routing',
        label: 'Message Routing',
        description: 'Routes messages between platforms and sessions intelligently. Handles cross-platform bridging and inter-agent delivery with retry and dead-letter archiving.',
        processes: [
          { name: 'MessageBridge', subsystem: ctx.messageBridge },
          { name: 'MessageRouter', subsystem: ctx.messageRouter },
        ],
      },
      {
        id: 'memory',
        label: 'Memory & Context',
        description: 'Topic memory stores conversation history per topic. Semantic memory enables natural language search. Working memory assembles relevant context for each session.',
        processes: [
          { name: 'TopicMemory', subsystem: ctx.topicMemory },
          { name: 'SemanticMemory', subsystem: ctx.semanticMemory },
          { name: 'WorkingMemoryAssembler', subsystem: ctx.workingMemory },
          { name: 'SelfKnowledgeTree', subsystem: ctx.selfKnowledgeTree },
        ],
      },
      {
        id: 'evolution',
        label: 'Self-Improvement',
        description: 'Detects capability gaps, generates improvement proposals, tracks learnings, and implements approved changes. The self-improvement loop.',
        processes: [
          { name: 'EvolutionManager', subsystem: ctx.evolution },
          { name: 'AutonomousEvolution', subsystem: ctx.autonomousEvolution },
          { name: 'CapabilityMapper', subsystem: ctx.capabilityMapper },
          { name: 'CoverageAuditor', subsystem: ctx.coverageAuditor },
        ],
      },
      {
        id: 'infrastructure',
        label: 'Infrastructure',
        description: 'Cloudflare tunnel for remote access, git worktree management for isolated agent work, and the Threadline agent network.',
        processes: [
          { name: 'TunnelManager', subsystem: ctx.tunnel },
          { name: 'WorktreeMonitor', subsystem: ctx.worktreeMonitor },
          { name: 'ThreadlineRouter', subsystem: ctx.threadlineRouter },
        ],
      },
    ];

    // Build active capabilities with full telemetry
    interface ActiveCapability {
      id: string;
      label: string;
      description: string;
      status: 'active' | 'error';
      metric: string;
      stats: Record<string, number | string | boolean | null>;
      lastActivity: string | null;
      processes: { name: string; status: 'running' | 'error'; details?: unknown }[];
    }

    interface Issue {
      severity: 'error' | 'warning';
      label: string;
      description: string;
      capability: string;
      process: string;
    }

    const activeCapabilities: ActiveCapability[] = [];
    const issues: Issue[] = [];

    for (const def of capabilityDefs) {
      const configuredProcesses = def.processes.filter(p => p.subsystem != null);
      if (configuredProcesses.length === 0) continue;

      const processResults: { name: string; status: 'running' | 'error'; details?: unknown }[] = [];
      let hasError = false;

      for (const p of configuredProcesses) {
        try {
          const details = p.statusFn ? p.statusFn() : undefined;
          processResults.push({ name: p.name, status: 'running', details });
        } catch {
          processResults.push({ name: p.name, status: 'error' });
          hasError = true;
          issues.push({
            severity: 'error',
            label: `${def.label} issue`,
            description: `${p.name} encountered an error`,
            capability: def.id,
            process: p.name,
          });
        }
      }

      const telemetry = buildCapabilityTelemetry(def.id);

      activeCapabilities.push({
        id: def.id,
        label: def.label,
        description: def.description,
        status: hasError ? 'error' : 'active',
        metric: telemetry.metric,
        stats: telemetry.stats,
        lastActivity: telemetry.lastActivity,
        processes: processResults,
      });
    }

    // Determine overall health
    const errorCount = issues.filter(i => i.severity === 'error').length;
    const health = errorCount > 0 ? 'error' as const : 'healthy' as const;
    const healthSummary = health === 'healthy'
      ? 'All systems operational'
      : `${errorCount} issue${errorCount > 1 ? 's' : ''} need${errorCount === 1 ? 's' : ''} attention`;

    // Recent degradation events
    const allEvents = DegradationReporter.getInstance().getEvents();
    const recentEvents = allEvents.slice(-20).reverse().map(e => ({
      ...e,
      narrative: DegradationReporter.narrativeFor(e),
    }));

    res.json({
      uptime: uptimeMs,
      health,
      healthSummary,
      activeCapabilities,
      issues,
      recentEvents,
    });
  });

  // Detail endpoint for a single capability
  router.get('/systems/capability/:id', (req, res) => {
    const capId = req.params.id;
    const telemetry = buildCapabilityTelemetry(capId);
    const uptimeMs = Date.now() - ctx.startTime.getTime();
    res.json({ id: capId, uptime: uptimeMs, ...telemetry });
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

  // ── Adaptive Autonomy ────────────────────────────────────────────

  // GET /autonomy — full autonomy dashboard
  router.get('/autonomy', (_req, res) => {
    if (!ctx.autonomyManager) {
      return res.status(404).json({ error: 'Autonomy system not configured' });
    }
    res.json(ctx.autonomyManager.getDashboard());
  });

  // GET /autonomy/summary — natural language summary for conversational use
  router.get('/autonomy/summary', (_req, res) => {
    if (!ctx.autonomyManager) {
      return res.status(404).json({ error: 'Autonomy system not configured' });
    }
    res.json({ summary: ctx.autonomyManager.getNaturalLanguageSummary() });
  });

  // POST /autonomy/profile — set the autonomy profile
  // Body: { profile: "cautious" | "supervised" | "collaborative" | "autonomous", reason: string }
  router.post('/autonomy/profile', (req, res) => {
    if (!ctx.autonomyManager) {
      return res.status(404).json({ error: 'Autonomy system not configured' });
    }
    const { profile, reason } = req.body;
    const validProfiles: AutonomyProfileLevel[] = ['cautious', 'supervised', 'collaborative', 'autonomous'];
    if (!profile || !validProfiles.includes(profile)) {
      return res.status(400).json({
        error: `Invalid profile. Must be one of: ${validProfiles.join(', ')}`,
      });
    }
    const resolved = ctx.autonomyManager.setProfile(profile, reason || 'User request');
    res.json({
      profile,
      resolved,
      summary: ctx.autonomyManager.getNaturalLanguageSummary(),
    });
  });

  // PATCH /autonomy/notifications — update notification preferences
  router.patch('/autonomy/notifications', (req, res) => {
    if (!ctx.autonomyManager) {
      return res.status(404).json({ error: 'Autonomy system not configured' });
    }
    ctx.autonomyManager.setNotificationPreferences(req.body);
    res.json({ notifications: ctx.autonomyManager.getNotificationPreferences() });
  });

  // GET /autonomy/history — profile change history
  router.get('/autonomy/history', (_req, res) => {
    if (!ctx.autonomyManager) {
      return res.status(404).json({ error: 'Autonomy system not configured' });
    }
    res.json({ history: ctx.autonomyManager.getHistory() });
  });

  // ── Trust Elevation Tracking ─────────────────────────────────────

  // GET /autonomy/elevation — full trust elevation dashboard
  router.get('/autonomy/elevation', (_req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    res.json(ctx.trustElevationTracker.getDashboard());
  });

  // GET /autonomy/elevation/opportunities — active elevation opportunities
  router.get('/autonomy/elevation/opportunities', (_req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    res.json({ opportunities: ctx.trustElevationTracker.getActiveOpportunities() });
  });

  // POST /autonomy/elevation/record — record a proposal decision for tracking
  // Body: { proposalId, proposedAt, decision, modified? }
  router.post('/autonomy/elevation/record', (req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    const { proposalId, proposedAt, decision, modified } = req.body;
    if (!proposalId || !proposedAt || !decision) {
      return res.status(400).json({ error: 'Required: proposalId, proposedAt, decision' });
    }
    const validDecisions = ['approved', 'rejected', 'deferred'];
    if (!validDecisions.includes(decision)) {
      return res.status(400).json({ error: `Invalid decision. Must be one of: ${validDecisions.join(', ')}` });
    }

    const now = new Date();
    const latencyMs = now.getTime() - new Date(proposedAt).getTime();

    ctx.trustElevationTracker.recordApprovalEvent({
      proposalId,
      proposedAt,
      decidedAt: now.toISOString(),
      decision,
      modified: modified ?? false,
      latencyMs,
    });

    res.json({
      recorded: true,
      acceptanceStats: ctx.trustElevationTracker.getAcceptanceStats(),
      rubberStamp: ctx.trustElevationTracker.getRubberStampSignal(),
    });
  });

  // POST /autonomy/elevation/dismiss — dismiss an elevation opportunity
  // Body: { type, days? }
  router.post('/autonomy/elevation/dismiss', (req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    const { type, days } = req.body;
    if (!type) {
      return res.status(400).json({ error: 'Required: type' });
    }
    const success = ctx.trustElevationTracker.dismissOpportunity(type, days ?? 30);
    res.json({ dismissed: success });
  });

  // POST /autonomy/elevation/dismiss-rubber-stamp — dismiss rubber-stamp alert
  // Body: { days? }
  router.post('/autonomy/elevation/dismiss-rubber-stamp', (req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    ctx.trustElevationTracker.dismissRubberStamp(req.body.days ?? 60);
    res.json({ dismissed: true, rubberStamp: ctx.trustElevationTracker.getRubberStampSignal() });
  });

  // GET /autonomy/elevation/acceptance — evolution acceptance stats
  router.get('/autonomy/elevation/acceptance', (_req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    res.json(ctx.trustElevationTracker.getAcceptanceStats());
  });

  // ── Autonomous Evolution ────────────────────────────────────────────

  // GET /autonomy/evolution — autonomous evolution dashboard
  router.get('/autonomy/evolution', (_req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    res.json(ctx.autonomousEvolution.getDashboard());
  });

  // POST /autonomy/evolution/evaluate — evaluate a proposal for auto-implementation
  // Body: { proposalId, title, source, review: { decision, reason, affectedFields, confidence } }
  router.post('/autonomy/evolution/evaluate', (req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    const { review } = req.body;
    if (!review || !review.decision || !review.affectedFields) {
      return res.status(400).json({ error: 'Required: review.decision, review.affectedFields' });
    }

    const autonomousMode = ctx.autonomyManager?.getResolvedState().evolutionApprovalMode === 'autonomous';
    const result = ctx.autonomousEvolution.evaluateForAutoImplementation(review, autonomousMode);
    res.json({
      ...result,
      scope: ctx.autonomousEvolution.classifyScope(review.affectedFields),
      autonomousMode,
    });
  });

  // POST /autonomy/evolution/sidecar — create a sidecar file for proposed job changes
  // Body: { jobSlug, proposalId, changes }
  router.post('/autonomy/evolution/sidecar', (req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    const { jobSlug, proposalId, changes } = req.body;
    if (!jobSlug || !proposalId || !changes) {
      return res.status(400).json({ error: 'Required: jobSlug, proposalId, changes' });
    }
    const sidecar = ctx.autonomousEvolution.createSidecar(jobSlug, proposalId, changes);
    res.json({ created: true, sidecar });
  });

  // POST /autonomy/evolution/sidecar/apply — apply a pending sidecar
  // Body: { proposalId }
  router.post('/autonomy/evolution/sidecar/apply', (req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    const { proposalId } = req.body;
    if (!proposalId) {
      return res.status(400).json({ error: 'Required: proposalId' });
    }
    const success = ctx.autonomousEvolution.applySidecar(proposalId);
    res.json({ applied: success });
  });

  // POST /autonomy/evolution/revert — revert an applied sidecar
  // Body: { proposalId }
  router.post('/autonomy/evolution/revert', (req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    const { proposalId } = req.body;
    if (!proposalId) {
      return res.status(400).json({ error: 'Required: proposalId' });
    }
    const success = ctx.autonomousEvolution.revertSidecar(proposalId);
    res.json({ reverted: success });
  });

  // GET /autonomy/evolution/notifications — peek at notification queue
  router.get('/autonomy/evolution/notifications', (_req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    res.json({
      pending: ctx.autonomousEvolution.peekNotifications(),
      recentHistory: ctx.autonomousEvolution.getNotificationHistory(20),
    });
  });

  // POST /autonomy/evolution/notifications/drain — drain the notification queue
  router.post('/autonomy/evolution/notifications/drain', (_req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    const drained = ctx.autonomousEvolution.drainNotifications();
    res.json({ drained: drained.length, notifications: drained });
  });

  // ── Identity / Soul.md ───────────────────────────────────────────────

  // GET /identity — combined identity overview (public sections only)
  router.get('/identity', (_req, res) => {
    const agentMdPath = path.join(ctx.config.stateDir, 'AGENT.md');
    const agentMd = fs.existsSync(agentMdPath)
      ? fs.readFileSync(agentMdPath, 'utf-8')
      : null;

    const soulPublic = ctx.soulManager?.readPublicSections() ?? null;

    res.json({
      agentName: ctx.config.projectName,
      agentMd: agentMd ? agentMd.substring(0, 2000) : null,
      soul: soulPublic,
      soulEnabled: ctx.soulManager?.isEnabled() ?? false,
    });
  });

  // GET /identity/soul — full soul.md content (requires auth)
  router.get('/identity/soul', (_req, res) => {
    if (!ctx.soulManager || !ctx.soulManager.isEnabled()) {
      return res.status(404).json({ error: 'soul.md is not enabled for this agent' });
    }
    const content = ctx.soulManager.readSoul();
    res.json({ content, enabled: true });
  });

  // PATCH /identity/soul — structured soul.md update with trust enforcement
  router.patch('/identity/soul', (req, res) => {
    if (!ctx.soulManager || !ctx.soulManager.isEnabled()) {
      return res.status(404).json({ error: 'soul.md is not enabled for this agent' });
    }

    const { section, operation, content, source } = req.body;

    // Validate request
    const validSections = ['core-values', 'growth-edge', 'convictions', 'open-questions', 'integrations', 'evolution-history'];
    const validOps = ['replace', 'append', 'remove'];
    const validSources = ['reflect-skill', 'evolution-job', 'inline', 'threadline'];

    if (!section || !validSections.includes(section)) {
      return res.status(400).json({ error: `Invalid section. Must be one of: ${validSections.join(', ')}` });
    }
    if (!operation || !validOps.includes(operation)) {
      return res.status(400).json({ error: `Invalid operation. Must be one of: ${validOps.join(', ')}` });
    }
    if (typeof content !== 'string' || content.length === 0) {
      return res.status(400).json({ error: 'Content must be a non-empty string' });
    }
    if (content.length > 10000) {
      return res.status(400).json({ error: 'Content exceeds maximum length (10000 chars)' });
    }
    if (!source || !validSources.includes(source)) {
      return res.status(400).json({ error: `Invalid source. Must be one of: ${validSources.join(', ')}` });
    }

    // Get current trust level
    const trustLevel = ctx.autonomyManager?.getProfile() ?? 'supervised';

    try {
      const result = ctx.soulManager.patch(
        { section, operation, content, source },
        trustLevel,
      );
      const statusCode = result.status === 'pending' ? 202 : 200;
      res.status(statusCode).json(result);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const soulErr = err as { code: string; message: string; details?: Record<string, unknown> };
        if (soulErr.code === 'trust_violation') {
          return res.status(403).json({
            error: 'trust_violation',
            message: soulErr.message,
            ...soulErr.details,
          });
        }
        if (soulErr.code === 'conflict') {
          return res.status(409).json({ error: 'conflict', message: soulErr.message });
        }
      }
      return res.status(500).json({ error: 'Failed to update soul.md' });
    }
  });

  // GET /identity/soul/pending — list pending soul.md changes
  router.get('/identity/soul/pending', (_req, res) => {
    if (!ctx.soulManager) {
      return res.status(404).json({ error: 'soul.md is not enabled' });
    }
    const pending = ctx.soulManager.getPending('pending');
    res.json({ pending, count: pending.length });
  });

  // POST /identity/soul/pending/:id/approve — approve a pending change
  router.post('/identity/soul/pending/:id/approve', (req, res) => {
    if (!ctx.soulManager) {
      return res.status(404).json({ error: 'soul.md is not enabled' });
    }
    try {
      const result = ctx.soulManager.approvePending(req.params.id);
      res.json(result);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const soulErr = err as { code: string; message: string };
        if (soulErr.code === 'not_found') {
          return res.status(404).json({ error: soulErr.message });
        }
        if (soulErr.code === 'invalid_state') {
          return res.status(400).json({ error: soulErr.message });
        }
      }
      return res.status(500).json({ error: 'Failed to approve pending change' });
    }
  });

  // POST /identity/soul/pending/:id/reject — reject a pending change
  router.post('/identity/soul/pending/:id/reject', (req, res) => {
    if (!ctx.soulManager) {
      return res.status(404).json({ error: 'soul.md is not enabled' });
    }
    try {
      ctx.soulManager.rejectPending(req.params.id, req.body?.reason);
      res.json({ ok: true, id: req.params.id, status: 'rejected' });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const soulErr = err as { code: string; message: string };
        if (soulErr.code === 'not_found') {
          return res.status(404).json({ error: soulErr.message });
        }
      }
      return res.status(500).json({ error: 'Failed to reject pending change' });
    }
  });

  // GET /identity/soul/drift — drift analysis
  router.get('/identity/soul/drift', (_req, res) => {
    if (!ctx.soulManager) {
      return res.status(404).json({ error: 'soul.md is not enabled' });
    }
    res.json(ctx.soulManager.analyzeDrift());
  });

  // GET /identity/soul/integrity — integrity check
  router.get('/identity/soul/integrity', (_req, res) => {
    if (!ctx.soulManager) {
      return res.status(404).json({ error: 'soul.md is not enabled' });
    }
    res.json(ctx.soulManager.verifyIntegrity());
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

  // ── Telemetry ──────────────────────────────────────────────────────

  // GET /monitoring/telemetry — telemetry heartbeat status and counters
  router.get('/monitoring/telemetry', (_req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.json({ enabled: false, message: 'Telemetry not configured. Enable via POST /config/telemetry {"enabled": true}' });
    }
    res.json(ctx.telemetryHeartbeat.getStatus());
  });

  // PATCH /config — generic config patcher used by FeatureDefinitions enableAction/disableAction.
  // Deep-merges the request body into config.json and updates runtime ctx.config.
  router.patch('/config', (req, res) => {
    const patch = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }

    // Allowlist of top-level config keys that can be patched via API.
    // Prevents callers from overwriting auth tokens, project paths, etc.
    const allowedKeys = new Set([
      'evolution', 'threadline', 'publishing', 'tunnel', 'gitBackup',
      'externalOperations', 'responseReview', 'inputGuard', 'monitoring',
      'updates', 'sessions', 'jobs',
    ]);

    const disallowed = Object.keys(patch).filter(k => !allowedKeys.has(k));
    if (disallowed.length > 0) {
      res.status(400).json({
        error: `Cannot patch these config keys via API: ${disallowed.join(', ')}`,
        allowed: [...allowedKeys],
      });
      return;
    }

    try {
      const configPath = path.join(ctx.config.projectDir, '.instar', 'config.json');
      let fileConfig: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }

      // Deep merge (one level deep — sufficient for feature toggles)
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
            typeof fileConfig[key] === 'object' && fileConfig[key] !== null) {
          fileConfig[key] = { ...fileConfig[key], ...value };
        } else {
          fileConfig[key] = value;
        }
        // Also update runtime config
        if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
            typeof (ctx.config as any)[key] === 'object' && (ctx.config as any)[key] !== null) {
          (ctx.config as any)[key] = { ...(ctx.config as any)[key], ...value };
        } else {
          (ctx.config as any)[key] = value;
        }
      }

      fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

      res.json({
        success: true,
        patched: Object.keys(patch),
        note: 'Some changes may require a server restart to take full effect.',
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to patch config: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // POST /config/telemetry — enable/disable telemetry (used by agent after asking user)
  // Also dismisses the session-start nudge by writing a marker file.
  router.post('/config/telemetry', (req, res) => {
    const { enabled, level } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (level !== undefined && level !== 'basic' && level !== 'usage') {
      return res.status(400).json({ error: 'level must be "basic" or "usage"' });
    }

    try {
      // Update config.json
      const configPath = path.join(ctx.config.projectDir, '.instar', 'config.json');
      let fileConfig: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
      if (!fileConfig.monitoring) fileConfig.monitoring = {};
      fileConfig.monitoring.telemetry = {
        enabled,
        level: level || 'basic',
      };
      fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

      // Write the nudge-shown marker so the session-start hook stops showing it
      const nudgeFile = path.join(ctx.config.stateDir, '.telemetry-nudge-shown');
      fs.writeFileSync(nudgeFile, JSON.stringify({
        decided: enabled ? 'opted-in' : 'declined',
        level: level || 'basic',
        at: new Date().toISOString(),
      }) + '\n');

      res.json({
        success: true,
        telemetry: { enabled, level: level || 'basic' },
        message: enabled
          ? 'Telemetry enabled. Anonymous heartbeats will start on next server restart.'
          : 'Telemetry declined. No data will be sent. Thank you for considering it.',
        note: 'Restart the server for changes to take effect.',
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to update config: ${err instanceof Error ? err.message : err}` });
    }
  });

  // ── Baseline Telemetry ─────────────────────────────────────────────

  // GET /telemetry/status — Baseline telemetry status
  router.get('/telemetry/status', (_req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.json({ enabled: false, baseline: { provisioned: false } });
    }
    const status = ctx.telemetryHeartbeat.getStatus();
    res.json({
      enabled: status.enabled,
      baseline: status.baseline,
    });
  });

  // GET /telemetry/submissions — List Baseline submission transparency log
  router.get('/telemetry/submissions', (req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.json({ submissions: [] });
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const submissions = ctx.telemetryHeartbeat.getBaselineSubmissions(limit, offset);
    res.json({ submissions, count: submissions.length });
  });

  // GET /telemetry/submissions/latest — Most recent Baseline submission payload
  router.get('/telemetry/submissions/latest', (_req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.json({ submission: null });
    }
    const latest = ctx.telemetryHeartbeat.getLatestBaselineSubmission();
    res.json({ submission: latest });
  });

  // POST /telemetry/enable — Enable Baseline telemetry (called by CLI/dashboard)
  // Human-gated: CLI shows consent disclosure, dashboard shows modal — this endpoint
  // is the programmatic backend, NOT an agent-accessible API.
  router.post('/telemetry/enable', (_req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.status(503).json({ error: 'Telemetry subsystem not initialized' });
    }

    try {
      const auth = ctx.telemetryHeartbeat.getAuth();
      const { installationId, created } = auth.provision();

      // Update config.json
      const configPath = path.join(ctx.config.projectDir, '.instar', 'config.json');
      let fileConfig: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
      if (!fileConfig.monitoring) fileConfig.monitoring = {};
      if (!fileConfig.monitoring.telemetry) fileConfig.monitoring.telemetry = {};
      fileConfig.monitoring.telemetry.enabled = true;
      fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

      res.json({
        success: true,
        installationId: installationId.slice(0, 8) + '...',
        created,
        message: 'Baseline telemetry enabled. Submissions will start within the next 6 hours.',
        note: 'Restart the server for the submission cycle to begin.',
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to enable telemetry: ${err instanceof Error ? err.message : err}` });
    }
  });

  // POST /telemetry/disable — Disable Baseline telemetry and delete identity
  router.post('/telemetry/disable', async (_req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.status(503).json({ error: 'Telemetry subsystem not initialized' });
    }

    try {
      const auth = ctx.telemetryHeartbeat.getAuth();
      const installationId = auth.getInstallationId();

      // Attempt remote deletion if provisioned
      let remoteDeletion = 'not_attempted';
      if (installationId) {
        try {
          const timestamp = Math.floor(Date.now() / 1000).toString();
          const deletePayload = Buffer.from(JSON.stringify({ installationId }));
          const signature = auth.sign(installationId, timestamp, deletePayload);

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);

          const deleteHeaders: Record<string, string> = {
            'X-Instar-Signature': `hmac-sha256=${signature}`,
            'X-Instar-Timestamp': timestamp,
          };
          const fingerprint = auth.getKeyFingerprint();
          if (fingerprint) {
            deleteHeaders['X-Instar-Key-Fingerprint'] = fingerprint;
          }

          const resp = await fetch(`https://instar-telemetry.sagemind-ai.workers.dev/v1/telemetry/${installationId}`, {
            method: 'DELETE',
            headers: deleteHeaders,
            signal: controller.signal,
          });

          clearTimeout(timeout);
          remoteDeletion = resp.ok ? 'success' : `failed_${resp.status}`;
        } catch {
          remoteDeletion = 'network_error';
          // Write pending-deletion for retry on next startup
          try {
            const pendingPath = path.join(ctx.config.stateDir, 'telemetry', 'pending-deletion.json');
            fs.writeFileSync(pendingPath, JSON.stringify({
              installationId,
              timestamp: new Date().toISOString(),
              retryCount: 0,
            }) + '\n');
          } catch { /* best-effort */ }
        }
      }

      // Delete local identity files
      auth.deprovision();

      // Clear submissions log
      const submissionsLog = path.join(ctx.config.stateDir, 'telemetry', 'submissions.jsonl');
      try { fs.unlinkSync(submissionsLog); } catch { /* may not exist */ }

      // Update config.json
      const configPath = path.join(ctx.config.projectDir, '.instar', 'config.json');
      let fileConfig: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
      if (!fileConfig.monitoring) fileConfig.monitoring = {};
      if (!fileConfig.monitoring.telemetry) fileConfig.monitoring.telemetry = {};
      fileConfig.monitoring.telemetry.enabled = false;
      fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

      res.json({
        success: true,
        remoteDeletion,
        message: 'Baseline telemetry disabled. Local identity deleted. Re-enabling will create a new identity.',
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to disable telemetry: ${err instanceof Error ? err.message : err}` });
    }
  });

  // ── Commitment Tracking ──────────────────────────────────────────
  // Note: Specific routes (context, verify) MUST come before :id param routes.

  /**
   * Get all commitments with optional status filter.
   */
  router.get('/commitments', (req, res) => {
    if (!ctx.commitmentTracker) {
      res.json({ enabled: false, commitments: [] });
      return;
    }
    const status = req.query.status as string | undefined;
    if (status === 'active') {
      res.json({ enabled: true, commitments: ctx.commitmentTracker.getActive() });
    } else {
      res.json({ enabled: true, commitments: ctx.commitmentTracker.getAll() });
    }
  });

  /**
   * Get behavioral context for session injection.
   */
  router.get('/commitments/context', (_req, res) => {
    if (!ctx.commitmentTracker) {
      res.json({ enabled: false, context: '' });
      return;
    }
    res.json({
      enabled: true,
      context: ctx.commitmentTracker.getBehavioralContext(),
      health: ctx.commitmentTracker.getHealth(),
    });
  });

  /**
   * Get a single commitment by ID.
   */
  router.get('/commitments/:id', (req, res) => {
    if (!ctx.commitmentTracker) {
      res.status(404).json({ error: 'CommitmentTracker not configured' });
      return;
    }
    const commitment = ctx.commitmentTracker.get(req.params.id);
    if (!commitment) {
      res.status(404).json({ error: `Commitment ${req.params.id} not found` });
      return;
    }
    res.json(commitment);
  });

  /**
   * Record a new commitment.
   */
  router.post('/commitments', (req, res) => {
    if (!ctx.commitmentTracker) {
      res.status(404).json({ error: 'CommitmentTracker not configured' });
      return;
    }
    const { type, userRequest, agentResponse, topicId, source,
            configPath, configExpectedValue, behavioralRule,
            expiresAt, verificationMethod, verificationPath } = req.body;

    if (!type || !userRequest || !agentResponse) {
      res.status(400).json({ error: 'type, userRequest, and agentResponse are required' });
      return;
    }
    if (!['config-change', 'behavioral', 'one-time-action'].includes(type)) {
      res.status(400).json({ error: 'type must be config-change, behavioral, or one-time-action' });
      return;
    }

    try {
      const commitment = ctx.commitmentTracker.record({
        type, userRequest, agentResponse, topicId, source,
        configPath, configExpectedValue, behavioralRule,
        expiresAt, verificationMethod, verificationPath,
      });
      res.status(201).json(commitment);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to record' });
    }
  });

  /**
   * Trigger verification of all active commitments.
   */
  router.post('/commitments/verify', (_req, res) => {
    if (!ctx.commitmentTracker) {
      res.status(404).json({ error: 'CommitmentTracker not configured' });
      return;
    }
    const report = ctx.commitmentTracker.verify();
    res.json(report);
  });

  /**
   * Withdraw a commitment.
   */
  router.post('/commitments/:id/withdraw', (req, res) => {
    if (!ctx.commitmentTracker) {
      res.status(404).json({ error: 'CommitmentTracker not configured' });
      return;
    }
    const { reason } = req.body;
    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }
    const success = ctx.commitmentTracker.withdraw(req.params.id, reason);
    if (!success) {
      res.status(404).json({ error: `Commitment ${req.params.id} not found or already resolved` });
      return;
    }
    res.json({ withdrawn: true, id: req.params.id });
  });

  // ── Episodic Memory (Activity Sentinel) ──────────────────────────

  router.get('/episodes/stats', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    res.json(memory.stats());
  });

  router.get('/episodes/sessions', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    res.json(memory.listSyntheses(limit));
  });

  router.get('/episodes/sessions/:sessionId', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    const synthesis = memory.getSynthesis(req.params.sessionId);
    if (!synthesis) { res.status(404).json({ error: 'Session synthesis not found' }); return; }
    res.json(synthesis);
  });

  router.get('/episodes/sessions/:sessionId/activities', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    res.json(memory.getSessionActivities(req.params.sessionId));
  });

  router.get('/episodes/recent', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    const hours = req.query.hours ? parseInt(String(req.query.hours), 10) : 24;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
    res.json(memory.getRecentActivity(hours, limit));
  });

  router.get('/episodes/themes/:theme', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    res.json(memory.getByTheme(req.params.theme));
  });

  router.post('/episodes/scan', async (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    try {
      const report = await ctx.activitySentinel.scan();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Scan failed' });
    }
  });

  // ── Inter-Agent Messaging ──────────────────────────────────────

  const MSG_ID_RE = /^[a-f0-9-]{36}$/;

  router.post('/messages/send', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const { from, to, type, priority, subject, body, options } = req.body;
      if (!from || !to || !type || !priority || !subject || !body) {
        res.status(400).json({ error: 'Missing required fields: from, to, type, priority, subject, body' });
        return;
      }
      const result = await ctx.messageRouter.send(
        from,
        to,
        type as MessageType,
        priority as MessagePriority,
        subject,
        body,
        options,
      );
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Send failed' });
    }
  });

  router.post('/messages/ack', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const { messageId, sessionId } = req.body;
      if (!messageId || !sessionId) {
        res.status(400).json({ error: 'Missing required fields: messageId, sessionId' });
        return;
      }
      await ctx.messageRouter.acknowledge(messageId, sessionId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Ack failed' });
    }
  });

  router.post('/messages/relay-agent', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      // Verify bearer token — the sender must present our agent's token
      const authHeader = req.headers.authorization;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!bearerToken || !verifyAgentToken(ctx.config.projectName, bearerToken)) {
        res.status(401).json({ error: 'Invalid or missing agent token' });
        return;
      }

      const envelope = req.body;
      if (!envelope?.message?.id) {
        res.status(400).json({ error: 'Invalid envelope' });
        return;
      }
      const accepted = await ctx.messageRouter.relay(envelope, 'agent');
      if (accepted) {
        const senderAgent = envelope.message?.from?.agent;
        console.log(`[relay-agent] Accepted message from ${senderAgent ?? 'unknown'} (thread: ${envelope.message?.threadId ?? 'none'}, id: ${envelope.message?.id ?? 'none'})`);

        // Check if this message resolves a pending waitForReply request.
        // Local delivery bypasses the relay client's gate-passed event, so we
        // must check reply waiters here directly.
        if (senderAgent && ctx.threadlineReplyWaiters.size > 0) {
          let textContent: string | undefined;
          const body = envelope.message?.body;
          if (typeof body === 'string') textContent = body;
          else if (typeof body === 'object' && body !== null) {
            textContent = String((body as Record<string, unknown>).content ?? (body as Record<string, unknown>).text ?? JSON.stringify(body));
          }
          if (textContent) {
            const isAutoAck = textContent.startsWith('Message received.') || textContent.startsWith('Message received,');
            const waiter = ctx.threadlineReplyWaiters.get(senderAgent);
            if (waiter && !isAutoAck) {
              console.log(`[relay-agent] Resolved reply waiter for ${senderAgent}`);
              waiter.resolve(textContent);
            }
          }
        }

        // If the message has a threadId and we have a ThreadlineRouter,
        // route it through the threadline pipeline for session resume/spawn.
        if (ctx.threadlineRouter && envelope.message?.threadId) {
          // Fire-and-forget — the relay is already accepted, threadline handling
          // is best-effort for session management.
          ctx.threadlineRouter.handleInboundMessage(envelope).catch(err => {
            console.error('[routes] ThreadlineRouter handling error:', err);
          });
        }
        res.json({ ok: true });
      } else {
        res.status(409).json({ error: 'Relay rejected (loop or duplicate)' });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Relay failed' });
    }
  });

  // relay-machine endpoint is now in machineRoutes.ts (protected by Machine-HMAC auth)

  router.get('/messages/inbox', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const filter: MessageFilter = {};
      if (req.query.type) filter.type = req.query.type as MessageType;
      if (req.query.priority) filter.priority = req.query.priority as MessagePriority;
      if (req.query.unread === 'true') filter.unread = true;
      if (req.query.fromAgent) filter.fromAgent = req.query.fromAgent as string;
      if (req.query.threadId) filter.threadId = req.query.threadId as string;
      if (req.query.limit) filter.limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      if (req.query.offset) filter.offset = parseInt(req.query.offset as string, 10) || 0;
      const messages = await ctx.messageRouter.getInbox(ctx.config.projectName, filter);
      res.json({ messages, count: messages.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Inbox query failed' });
    }
  });

  router.get('/messages/outbox', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const filter: MessageFilter = {};
      if (req.query.type) filter.type = req.query.type as MessageType;
      if (req.query.priority) filter.priority = req.query.priority as MessagePriority;
      if (req.query.limit) filter.limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      if (req.query.offset) filter.offset = parseInt(req.query.offset as string, 10) || 0;
      const messages = await ctx.messageRouter.getOutbox(ctx.config.projectName, filter);
      res.json({ messages, count: messages.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Outbox query failed' });
    }
  });

  router.get('/messages/dead-letter', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const filter: MessageFilter = {};
      if (req.query.type) filter.type = req.query.type as MessageType;
      if (req.query.priority) filter.priority = req.query.priority as MessagePriority;
      if (req.query.limit) filter.limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      if (req.query.offset) filter.offset = parseInt(req.query.offset as string, 10) || 0;
      const messages = await ctx.messageRouter.getDeadLetters(filter);
      res.json({ messages, count: messages.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Dead-letter query failed' });
    }
  });

  router.get('/messages/threads', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const status = req.query.status as string | undefined;
      const validStatuses = ['active', 'resolved', 'stale'];
      if (status && !validStatuses.includes(status)) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        return;
      }
      const threads = await ctx.messageRouter.listThreads(status as any);
      res.json({ threads, count: threads.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Thread list failed' });
    }
  });

  router.get('/messages/thread/:threadId', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const { threadId } = req.params;
      if (!MSG_ID_RE.test(threadId)) {
        res.status(400).json({ error: 'Invalid thread ID format' });
        return;
      }
      const result = await ctx.messageRouter.getThread(threadId);
      if (!result) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Thread query failed' });
    }
  });

  router.post('/messages/thread/:threadId/resolve', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const { threadId } = req.params;
      if (!MSG_ID_RE.test(threadId)) {
        res.status(400).json({ error: 'Invalid thread ID format' });
        return;
      }
      await ctx.messageRouter.resolveThread(threadId);
      res.json({ ok: true });
    } catch (err) {
      res.status(err instanceof Error && err.message.includes('not found') ? 404 : 500)
        .json({ error: err instanceof Error ? err.message : 'Thread resolve failed' });
    }
  });

  router.get('/messages/stats', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const stats = await ctx.messageRouter.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Stats failed' });
    }
  });

  router.post('/messages/spawn-request', async (req, res) => {
    if (!ctx.spawnManager) {
      res.status(503).json({ error: 'Spawn requests not available' });
      return;
    }
    try {
      const { requester, target, reason, context, priority, suggestedModel, suggestedMaxDuration, pendingMessages } = req.body;
      if (!requester || !target || !reason || !priority) {
        res.status(400).json({ error: 'Missing required fields: requester, target, reason, priority' });
        return;
      }
      const result = await ctx.spawnManager.evaluate({
        requester, target, reason, context, priority,
        suggestedModel, suggestedMaxDuration, pendingMessages,
      });
      if (!result.approved) {
        ctx.spawnManager.handleDenial(
          { requester, target, reason, context, priority, suggestedModel, suggestedMaxDuration, pendingMessages },
          result,
        );
      }
      res.status(result.approved ? 201 : 429).json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Spawn request failed' });
    }
  });

  router.get('/messages/summaries', async (req, res) => {
    if (!ctx.summarySentinel) {
      res.status(503).json({ error: 'Session summaries not available' });
      return;
    }
    try {
      const summaries = ctx.summarySentinel.getAllSummaries();
      const status = ctx.summarySentinel.getStatus();
      res.json({ summaries, status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Summaries failed' });
    }
  });

  router.get('/messages/route-score', async (req, res) => {
    if (!ctx.summarySentinel) {
      res.status(503).json({ error: 'Session summaries not available' });
      return;
    }
    try {
      const { subject, body } = req.query;
      if (!subject || !body) {
        res.status(400).json({ error: 'Missing required query params: subject, body' });
        return;
      }
      const scores = ctx.summarySentinel.findBestSession(
        subject as string,
        body as string,
        ctx.config.projectName,
      );
      res.json({ scores, inFallback: ctx.summarySentinel.isInFallbackMode() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Route scoring failed' });
    }
  });

  // ── Outbound Queue Status (Phase 4: Cross-Machine) ──────────

  router.get('/messages/outbound', async (_req, res) => {
    try {
      const status = getOutboundQueueStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Outbound status failed' });
    }
  });

  router.delete('/messages/outbound/:machineId/:messageId', async (req, res) => {
    try {
      const { machineId, messageId } = req.params;
      if (!machineId || !messageId) {
        res.status(400).json({ error: 'Missing machineId or messageId' });
        return;
      }
      const cleaned = cleanupDeliveredOutbound(machineId, messageId);
      res.json({ cleaned });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Outbound cleanup failed' });
    }
  });

  // ── Agent Discovery (Phase 4: Cross-Machine) ──────────────

  router.get('/messages/agents', async (_req, res) => {
    try {
      const agents = buildAgentList();
      res.json({ agents, machine: ctx.config.projectName });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Agent list failed' });
    }
  });

  // IMPORTANT: /:id must be LAST among /messages/* routes to avoid
  // catching named paths like /messages/stats, /messages/inbox, etc.
  router.get('/messages/:id', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const messageId = req.params.id;
      if (!MSG_ID_RE.test(messageId)) {
        res.status(400).json({ error: 'Invalid message ID format' });
        return;
      }
      const envelope = await ctx.messageRouter.getMessage(messageId);
      if (!envelope) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      res.json(envelope);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Message query failed' });
    }
  });

  // ── System Reviews ────────────────────────────────────────────────

  router.post('/system-reviews', async (req, res) => {
    if (!ctx.systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    try {
      const { tier, tiers, probeId, probeIds, dryRun } = req.body || {};
      const report = await ctx.systemReviewer.review({
        tiers: tiers ?? (tier != null ? [Number(tier)] : undefined),
        probeIds: probeIds ?? (probeId ? [probeId] : undefined),
        dryRun: dryRun === true,
      });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Review failed' });
    }
  });

  router.get('/system-reviews/latest', (_req, res) => {
    if (!ctx.systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    const latest = ctx.systemReviewer.getLatest();
    res.json(latest ?? { message: 'No reviews yet' });
  });

  router.get('/system-reviews/history', (req, res) => {
    if (!ctx.systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const history = ctx.systemReviewer.getHistory(limit);
    res.json({ count: history.length, reports: history });
  });

  router.get('/system-reviews/trend', (_req, res) => {
    if (!ctx.systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    const trend = ctx.systemReviewer.getTrend();
    res.json(trend);
  });

  // ── Threadline Protocol ──────────────────────────────────────────

  if (ctx.handshakeManager) {
    const threadlineRoutes = createThreadlineRoutes(
      ctx.handshakeManager,
      ctx.threadlineRouter,
      {
        localAgent: ctx.config.projectName,
        version: '1.0',
      },
    );
    router.use(threadlineRoutes);
  }

  // ── Listener Daemon Health/Metrics ────────────────────────────────

  router.get('/listener/health', (req, res) => {
    // Auth required (tunnel exposes these endpoints)
    if (ctx.config.authToken) {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ') || header.slice(7) !== ctx.config.authToken) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const healthPath = path.join(ctx.config.stateDir, 'listener-health.json');
    if (!fs.existsSync(healthPath)) {
      return res.json({
        status: 'not-running',
        message: 'No listener daemon health file found. Start with: instar listener start',
      });
    }

    try {
      const health = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
      // Add snapshotAge
      const healthMtime = fs.statSync(healthPath).mtimeMs;
      health.snapshotAge = Math.floor((Date.now() - healthMtime) / 1000);
      return res.json(health);
    } catch {
      return res.status(500).json({ error: 'Failed to read health file' });
    }
  });

  router.get('/listener/metrics', (req, res) => {
    if (ctx.config.authToken) {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ') || header.slice(7) !== ctx.config.authToken) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const healthPath = path.join(ctx.config.stateDir, 'listener-health.json');
    let daemon: Record<string, unknown> = { state: 'not-running' };
    if (fs.existsSync(healthPath)) {
      try {
        daemon = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
        const healthMtime = fs.statSync(healthPath).mtimeMs;
        daemon.snapshotAge = Math.floor((Date.now() - healthMtime) / 1000);
      } catch {
        // Use default
      }
    }

    // Check if daemon socket is connected
    const socketPath = path.join(ctx.config.stateDir, 'listener.sock');
    const socketConnected = fs.existsSync(socketPath);

    // Inbox stats
    const inboxPath = path.join(ctx.config.stateDir, 'threadline', 'inbox.jsonl.active');
    let inboxSizeBytes = 0;
    if (fs.existsSync(inboxPath)) {
      try {
        inboxSizeBytes = fs.statSync(inboxPath).size;
      } catch {
        // Ignore
      }
    }

    return res.json({
      daemon,
      socket: { connected: socketConnected, path: socketPath },
      inbox: { sizeBytes: inboxSizeBytes, path: inboxPath },
    });
  });

  router.post('/listener/restart', (req, res) => {
    if (ctx.config.authToken) {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ') || header.slice(7) !== ctx.config.authToken) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    // Signal daemon via PID file
    const pidPath = path.join(ctx.config.stateDir, 'listener-daemon.pid');
    if (!fs.existsSync(pidPath)) {
      return res.status(404).json({ error: 'No listener daemon PID file found' });
    }

    try {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGTERM');
      return res.json({ status: 'restart-signal-sent', pid });
    } catch (err) {
      return res.status(500).json({ error: `Failed to signal daemon: ${err}` });
    }
  });

  // ── MoltBridge Integration ──────────────────────────────────────────

  if (ctx.unifiedTrust?.moltbridge) {
    Promise.all([
      import('../moltbridge/routes.js'),
      import('../moltbridge/ProfileCompiler.js'),
    ]).then(([{ createMoltBridgeRoutes }, { ProfileCompiler }]) => {
      const profileCompiler = new ProfileCompiler({
        stateDir: ctx.config.stateDir,
        projectRoot: path.resolve(ctx.config.stateDir, '..'),
        capabilities: (ctx.config as any).moltbridge?.capabilities ?? [],
        jobNames: Object.keys((ctx.config as any).jobs ?? {}),
      });
      router.use(createMoltBridgeRoutes({
        client: ctx.unifiedTrust!.moltbridge!,
        identity: ctx.unifiedTrust!.identity,
        profileCompiler,
      }));
    }).catch(err => {
      console.error(`MoltBridge routes failed to mount: ${err instanceof Error ? err.message : err}`);
    });
  }

  // ── Threadline Status (auth-gated) ──────────────────────────────────
  router.get('/threadline/status', (_req, res) => {
    const relayClient = ctx.threadlineRelayClient;
    const connected = relayClient?.connectionState === 'connected';
    const listenerState = ctx.listenerManager?.getState() ?? { active: false, state: 'not-configured', messagesHandled: 0, queueDepth: 0, rotationId: '', rotationStartedAt: '' };

    res.json({
      ready: connected,
      relay: {
        connected,
        fingerprint: relayClient?.fingerprint ?? null,
        url: ctx.config.threadline?.relayUrl ?? 'wss://threadline-relay.fly.dev/v1/connect',
        visibility: ctx.config.threadline?.visibility ?? 'unlisted',
      },
      listener: listenerState,
      config: {
        relayEnabled: ctx.config.threadline?.relayEnabled ?? false,
        autoAck: ctx.config.threadline?.autoAck ?? true,
        firstContactPolicy: ctx.config.threadline?.firstContactPolicy ?? 'auto',
      },
    });
  });

  // ── Threadline Reply Waiter ─────────────────────────────────────────
  // Waits for an incoming reply from a specific agent on a specific thread.
  // Used by the relay-send endpoint when waitForReply is true.

  function waitForThreadlineReply(
    routeCtx: RouteContext,
    senderAgent: string,
    _threadId: string,
    timeoutSec?: number,
  ): Promise<string | null> {
    const timeout = Math.min(Math.max(timeoutSec ?? 120, 5), 300) * 1000; // 5s–300s, default 120s

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        routeCtx.threadlineReplyWaiters.delete(senderAgent);
        resolve(null);
      }, timeout);

      routeCtx.threadlineReplyWaiters.set(senderAgent, {
        resolve: (reply: string) => {
          clearTimeout(timer);
          routeCtx.threadlineReplyWaiters.delete(senderAgent);
          resolve(reply);
        },
        threadId: _threadId,
        timer,
      });
    });
  }

  // ── Threadline Relay Send ────────────────────────────────────────────
  // Used by the MCP server's threadline_send tool to route messages through
  // the relay WebSocket. Tries local delivery first for co-located agents,
  // then falls back to the relay. The MCP server runs as a stdio child
  // process and can't access the relay client directly, so it calls this
  // HTTP endpoint.

  router.post('/threadline/relay-send', async (req, res) => {
    const relayClient = ctx.threadlineRelayClient;
    const { targetAgent, message, threadId, waitForReply, timeoutSeconds } = req.body;

    if (!targetAgent || !message) {
      res.status(400).json({ success: false, error: 'Missing required fields: targetAgent, message' });
      return;
    }

    // Validate message size (64KB limit matching inbound)
    if (Buffer.byteLength(message, 'utf-8') > 64 * 1024) {
      res.status(413).json({ success: false, error: 'Message too large (64KB limit)' });
      return;
    }

    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const effectiveThreadId = threadId ?? msgId;

    // ── Try local delivery first (same-machine agents) ──────────────
    // Read known-agents.json for local agent info. If the target is local,
    // deliver directly via their /messages/relay-agent endpoint, bypassing
    // the relay entirely. This avoids stale relay WebSocket issues.
    try {
      const knownAgentsPath = path.join(ctx.config.stateDir, 'threadline', 'known-agents.json');
      if (fs.existsSync(knownAgentsPath)) {
        const knownData = JSON.parse(fs.readFileSync(knownAgentsPath, 'utf-8'));
        const agents: Array<{ name: string; port: number; path?: string; fingerprint?: string; publicKey?: string }> = knownData.agents ?? [];

        // Support "name:fingerprintPrefix" disambiguation syntax
        let targetName = targetAgent;
        let targetFpPrefix: string | undefined;
        const colonIdx = targetAgent.lastIndexOf(':');
        if (colonIdx > 0 && colonIdx < targetAgent.length - 1) {
          const suffix = targetAgent.substring(colonIdx + 1);
          if (/^[0-9a-f]{4,32}$/i.test(suffix)) {
            targetName = targetAgent.substring(0, colonIdx);
            targetFpPrefix = suffix.toLowerCase();
          }
        }

        const nameMatches = agents.filter(a =>
          a.name === targetName || a.name?.toLowerCase() === targetName?.toLowerCase()
        );

        // If multiple same-named agents, disambiguate by fingerprint prefix
        let localTarget = nameMatches.length === 1 ? nameMatches[0] : undefined;
        if (nameMatches.length > 1 && targetFpPrefix) {
          localTarget = nameMatches.find(a => {
            const fp = a.fingerprint || a.publicKey?.substring(0, 32);
            return fp?.toLowerCase().startsWith(targetFpPrefix!);
          });
        } else if (nameMatches.length > 1 && !targetFpPrefix) {
          // Ambiguous — skip local delivery, let relay handle it
          localTarget = undefined;
        }

        if (localTarget?.port && localTarget.name !== ctx.config.projectName) {
          // Check if the local agent is actually running
          try {
            const healthResp = await fetch(`http://localhost:${localTarget.port}/threadline/health`, {
              signal: AbortSignal.timeout(3000),
            });

            if (healthResp.ok) {
              // Agent is alive — deliver locally via relay-agent endpoint
              const targetToken = getAgentToken(localTarget.name);
              if (targetToken) {
                const senderFingerprint = (() => {
                  try {
                    const idPath = path.join(ctx.config.stateDir, 'threadline', 'identity.json');
                    const idData = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
                    return idData.fingerprint ?? ctx.config.projectName;
                  } catch { return ctx.config.projectName; }
                })();

                const now = new Date().toISOString();
                const envelope = {
                  schemaVersion: 1,
                  message: {
                    id: msgId,
                    from: { agent: ctx.config.projectName, session: 'threadline', machine: 'local' },
                    to: { agent: localTarget.name, session: 'best', machine: 'local' },
                    type: 'request' as const,
                    priority: 'medium' as const,
                    subject: 'Relay message',
                    body: message,
                    threadId: effectiveThreadId,
                    createdAt: now,
                  },
                  transport: {
                    relayChain: ['local'],
                    originServer: `http://localhost:${ctx.config.port ?? 4042}`,
                    nonce: `${randomUUID()}:${now}`,
                    timestamp: now,
                  },
                  delivery: {
                    phase: 'received' as const,
                    transitions: [
                      { from: 'created' as const, to: 'received' as const, at: now, reason: 'local delivery' },
                    ],
                    attempts: 1,
                  },
                };

                const localResp = await fetch(`http://localhost:${localTarget.port}/messages/relay-agent`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${targetToken}`,
                  },
                  body: JSON.stringify(envelope),
                  signal: AbortSignal.timeout(10000),
                });

                if (localResp.ok) {
                  console.log(`[relay-send] Local delivery to ${localTarget.name}:${localTarget.port} (thread: ${effectiveThreadId})`);

                  if (waitForReply) {
                    const reply = await waitForThreadlineReply(ctx, localTarget.name, effectiveThreadId, timeoutSeconds);
                    res.json({
                      success: true,
                      messageId: msgId,
                      threadId: effectiveThreadId,
                      resolvedAgent: localTarget.name,
                      deliveryPath: 'local',
                      reply,
                    });
                  } else {
                    res.json({
                      success: true,
                      messageId: msgId,
                      threadId: effectiveThreadId,
                      resolvedAgent: localTarget.name,
                      deliveryPath: 'local',
                    });
                  }
                  return;
                }
                // Local delivery failed — fall through to relay
                console.warn(`[relay-send] Local delivery to ${localTarget.name} failed (${localResp.status}), falling back to relay`);
              }
            }
          } catch {
            // Local agent not reachable — fall through to relay
          }
        }
      }
    } catch {
      // Known-agents read failed — fall through to relay
    }

    // ── Fall back to relay delivery ─────────────────────────────────
    if (!relayClient || relayClient.connectionState !== 'connected') {
      res.status(503).json({ success: false, error: 'Relay not connected and local delivery unavailable' });
      return;
    }

    try {
      // Resolve name → fingerprint if targetAgent isn't already a fingerprint
      const resolvedId = await relayClient.resolveAgent(targetAgent);
      if (!resolvedId) {
        res.status(404).json({
          success: false,
          error: `Agent not found: "${targetAgent}". Try discovering agents first.`,
        });
        return;
      }

      const relayMsgId = relayClient.sendAuto(resolvedId, message, threadId);
      const effectiveRelayThreadId = threadId ?? relayMsgId;

      if (waitForReply) {
        const reply = await waitForThreadlineReply(ctx, resolvedId, effectiveRelayThreadId, timeoutSeconds);
        res.json({
          success: true,
          messageId: relayMsgId,
          threadId: effectiveRelayThreadId,
          resolvedAgent: resolvedId,
          deliveryPath: 'relay',
          reply,
        });
      } else {
        res.json({
          success: true,
          messageId: relayMsgId,
          threadId: effectiveRelayThreadId,
          resolvedAgent: resolvedId,
          deliveryPath: 'relay',
        });
      }
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Send failed',
      });
    }
  });

  // ── Response Review Pipeline (Coherence Gate) ────────────────────────
  //
  // Evaluates agent responses before delivery. Implements PEL + Gate + Specialist
  // reviewer fan-out with the normative decision matrix.

  // Rate limiter for review endpoints (per session)
  const reviewRateLimits = new Map<string, { count: number; resetAt: number }>();
  const REVIEW_RATE_LIMIT = 10; // max requests per minute
  const REVIEW_RATE_WINDOW_MS = 60_000;

  function checkReviewRateLimit(sessionId: string, maxPerMinute: number): boolean {
    const now = Date.now();
    let entry = reviewRateLimits.get(sessionId);
    if (entry && now > entry.resetAt) {
      reviewRateLimits.delete(sessionId);
      entry = undefined;
    }
    if (!entry) {
      entry = { count: 0, resetAt: now + REVIEW_RATE_WINDOW_MS };
      reviewRateLimits.set(sessionId, entry);
    }
    entry.count++;
    return entry.count <= maxPerMinute;
  }

  router.post('/review/evaluate', async (req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const { message, sessionId, stopHookActive, context: evalContext } = req.body;

    // Validate required fields
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "message" field' });
      return;
    }
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "sessionId" field' });
      return;
    }

    // Per-session rate limit
    if (!checkReviewRateLimit(sessionId, REVIEW_RATE_LIMIT)) {
      res.status(429).json({ error: 'Rate limit exceeded (max 10/min per session)' });
      return;
    }

    try {
      const result = await ctx.responseReviewGate.evaluate({
        message,
        sessionId,
        stopHookActive: stopHookActive ?? false,
        context: {
          channel: evalContext?.channel ?? 'direct',
          topicId: evalContext?.topicId,
          recipientType: evalContext?.recipientType,
          recipientId: evalContext?.recipientId,
          isExternalFacing: evalContext?.isExternalFacing,
          transcriptPath: evalContext?.transcriptPath,
        },
      });

      // Strip internal audit fields from response (agent sees generic feedback only)
      res.json({
        pass: result.pass,
        feedback: result.feedback,
        issueCategories: result.issueCategories,
        warnings: result.warnings,
        retryCount: result.retryCount,
      });
    } catch (err) {
      // Fail-open: if the pipeline crashes, let the message through
      console.error('[review/evaluate] Pipeline error:', err);
      res.json({ pass: true, warnings: ['[review-error] Pipeline encountered an error'] });
    }
  });

  router.post('/review/test', async (req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    // Check if test endpoint is disabled
    if (ctx.config.responseReview?.testEndpointDisabled) {
      res.status(403).json({ error: 'Test endpoint is disabled' });
      return;
    }

    const { message, reviewer: reviewerName, context: testContext } = req.body;

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "message" field' });
      return;
    }

    // Per-session rate limit (use 'test' as session for test endpoint)
    if (!checkReviewRateLimit('__test__', 20)) {
      res.status(429).json({ error: 'Rate limit exceeded (max 20/min for test endpoint)' });
      return;
    }

    try {
      // Use a test session ID to avoid interfering with real sessions
      const testSessionId = `test-${Date.now()}`;
      const result = await ctx.responseReviewGate.evaluate({
        message,
        sessionId: testSessionId,
        stopHookActive: false,
        context: {
          channel: testContext?.channel ?? 'direct',
          topicId: testContext?.topicId,
          recipientType: testContext?.recipientType,
          recipientId: testContext?.recipientId,
          isExternalFacing: testContext?.isExternalFacing,
          transcriptPath: testContext?.transcriptPath,
        },
      });

      // Test endpoint returns FULL details (including reviewer names and specific issues)
      res.json({
        results: result._auditViolations ?? [],
        aggregateVerdict: result.pass ? 'pass' : 'block',
        gateResult: result._gateResult,
        pelBlock: result._pelBlock ?? false,
        outcome: result._outcome,
        warnings: result.warnings,
        feedback: result.feedback,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Test failed' });
    }
  });

  router.get('/review/history', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const history = ctx.responseReviewGate.getReviewHistory({
      sessionId: _req.query.sessionId as string | undefined,
      reviewer: _req.query.reviewer as string | undefined,
      verdict: _req.query.verdict as string | undefined,
      since: _req.query.since as string | undefined,
      recipientId: _req.query.recipientId as string | undefined,
      limit: _req.query.limit ? parseInt(_req.query.limit as string, 10) : undefined,
    });

    res.json({ history, count: history.length });
  });

  router.delete('/review/history', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const sessionId = _req.query.sessionId as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId query parameter required' });
      return;
    }

    const deleted = ctx.responseReviewGate.deleteHistory(sessionId);
    res.json({ deleted, sessionId });
  });

  router.get('/review/stats', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    res.json(ctx.responseReviewGate.getReviewerStats({
      period: (_req.query.period as 'daily' | 'weekly' | 'all') || undefined,
      since: _req.query.since as string | undefined,
    }));
  });

  // ── Coherence Proposals ─────────────────────────────────────────

  router.get('/coherence/proposals', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const status = _req.query.status as 'pending' | 'approved' | 'rejected' | undefined;
    const proposals = ctx.responseReviewGate.getProposals(status);
    res.json({ proposals, count: proposals.length });
  });

  router.post('/coherence/proposals', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const { type, title, description, source, data } = _req.body;
    if (!type || !title || !description) {
      res.status(400).json({ error: 'type, title, and description required' });
      return;
    }

    const proposal = ctx.responseReviewGate.addProposal({ type, title, description, source: source || 'user', data });
    res.status(201).json(proposal);
  });

  router.post('/coherence/proposals/:id/approve', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const result = ctx.responseReviewGate.resolveProposal(_req.params.id, 'approve', _req.body.resolution);
    if (!result) {
      res.status(404).json({ error: 'Proposal not found or already resolved' });
      return;
    }
    res.json(result);
  });

  router.post('/coherence/proposals/:id/reject', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const result = ctx.responseReviewGate.resolveProposal(_req.params.id, 'reject', _req.body.resolution);
    if (!result) {
      res.status(404).json({ error: 'Proposal not found or already resolved' });
      return;
    }
    res.json(result);
  });

  // ── Coherence Health Dashboard ──────────────────────────────────

  router.get('/coherence/health', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    res.json(ctx.responseReviewGate.getHealthDashboard());
  });

  // ── Reviewer Health & Canary ────────────────────────────────────

  router.get('/review/health', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    res.json(ctx.responseReviewGate.getReviewerHealth());
  });

  router.post('/review/canary', async (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    try {
      const results = await ctx.responseReviewGate.runCanaryTests();
      ctx.responseReviewGate.setCanaryResults(results);

      const passed = results.filter(r => r.pass).length;
      const total = results.length;
      const missed = results.filter(r => !r.pass);

      res.json({
        passed,
        total,
        allPassed: passed === total,
        results,
        missed: missed.length > 0 ? missed : undefined,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Canary test failed' });
    }
  });

  // ── Paste / Drop Zone ─────────────────────────────────────────────

  const pasteLimiter = rateLimiter(60_000, 10);

  router.post('/pastes', pasteLimiter, (req, res) => {
    if (!ctx.pasteManager) {
      res.status(503).json({ error: 'Paste system not available' });
      return;
    }

    const { content, label, targetSession } = req.body;
    if (!content || typeof content !== 'string') {
      res.status(400).json({ ok: false, error: 'validation_error', message: '"content" must be a non-empty string' });
      return;
    }
    if (label !== undefined && (typeof label !== 'string' || label.length > 256)) {
      res.status(400).json({ ok: false, error: 'validation_error', message: '"label" must be a string under 256 characters' });
      return;
    }
    if (targetSession !== undefined && typeof targetSession !== 'string') {
      res.status(400).json({ ok: false, error: 'validation_error', message: '"targetSession" must be a string' });
      return;
    }

    try {
      const result = ctx.pasteManager.create(content, {
        label,
        from: 'dashboard',
        targetSession,
      });

      // Try to deliver to an active session
      const paste = ctx.pasteManager.getMeta(result.pasteId);
      if (!paste) {
        res.status(500).json({ ok: false, error: 'internal', message: 'Paste created but metadata not readable' });
        return;
      }

      // Find target session — use specified, or most recent interactive
      let deliveredToSession: string | undefined;
      const sessions = ctx.sessionManager.listRunningSessions();
      const interactiveSessions = sessions.filter(s => !s.jobSlug);

      if (targetSession) {
        const match = interactiveSessions.find(s => s.name === targetSession);
        if (match) deliveredToSession = match.name;
      } else if (interactiveSessions.length > 0) {
        // Default: most recently active interactive session
        deliveredToSession = interactiveSessions[0].name;
      }

      if (deliveredToSession) {
        // Inject notification
        const notification = ctx.pasteManager.buildNotification(paste);
        ctx.sessionManager.injectPasteNotification(deliveredToSession, notification);
        ctx.pasteManager.updateStatus(result.pasteId, 'notified');
        result.status = 'notified';
        result.sessionName = deliveredToSession;

        // Broadcast WebSocket event
        if (ctx.wsManager) {
          ctx.wsManager.broadcastEvent({
            type: 'paste_delivered',
            pasteId: result.pasteId,
            session: deliveredToSession,
            contentLength: result.contentLength,
            label,
          });
        }
      } else {
        // Queue for later delivery
        ctx.pasteManager.addPending(paste);
      }

      res.status(201).json(result);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const pasteErr = err as { statusCode: number; code: string; message: string };
        res.status(pasteErr.statusCode).json({
          ok: false,
          error: pasteErr.code,
          message: pasteErr.message,
        });
        return;
      }
      res.status(500).json({ ok: false, error: 'internal', message: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/pastes', (_req, res) => {
    if (!ctx.pasteManager) {
      res.status(503).json({ error: 'Paste system not available' });
      return;
    }

    const pastes = ctx.pasteManager.list().map(p => ({
      pasteId: p.pasteId,
      label: p.label,
      from: p.from,
      timestamp: p.timestamp,
      status: p.status,
      targetSession: p.targetSession,
      contentLength: p.contentLength,
      expiresAt: p.expiresAt,
    }));

    res.json({ ok: true, pastes, stats: ctx.pasteManager.getStats() });
  });

  router.get('/pastes/:id', (req, res) => {
    if (!ctx.pasteManager) {
      res.status(503).json({ error: 'Paste system not available' });
      return;
    }

    const result = ctx.pasteManager.getContent(req.params.id);
    if (!result) {
      res.status(404).json({ ok: false, error: 'not_found', message: 'Paste not found' });
      return;
    }

    res.json({
      ok: true,
      pasteId: result.meta.pasteId,
      label: result.meta.label,
      from: result.meta.from,
      timestamp: result.meta.timestamp,
      status: result.meta.status,
      targetSession: result.meta.targetSession,
      contentLength: result.meta.contentLength,
      expiresAt: result.meta.expiresAt,
      content: result.content,
    });
  });

  router.delete('/pastes/:id', (req, res) => {
    if (!ctx.pasteManager) {
      res.status(503).json({ error: 'Paste system not available' });
      return;
    }

    const deleted = ctx.pasteManager.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ ok: false, error: 'not_found', message: 'Paste not found' });
      return;
    }

    res.json({ ok: true, deleted: true });
  });

  // ── Prompt Gate API ─────────────────────────────────────────────

  /**
   * GET /prompt-gate/log — Audit log of prompt gate actions.
   * Returns recent auto-approve and relay events.
   */
  router.get('/prompt-gate/log', (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 500);
    const logPath = path.join(ctx.config.stateDir, 'prompt-gate-audit.jsonl');
    try {
      if (!fs.existsSync(logPath)) {
        res.json({ entries: [], total: 0 });
        return;
      }
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
      const entries = lines.slice(-limit).reverse().map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      res.json({ entries, total: lines.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read audit log' });
    }
  });

  /**
   * GET /prompt-gate/topic/:topicId/override — Get per-topic prompt gate overrides.
   */
  router.get('/prompt-gate/topic/:topicId/override', (req, res) => {
    const topicId = parseInt(req.params.topicId, 10);
    if (isNaN(topicId)) {
      res.status(400).json({ error: 'topicId must be a number' });
      return;
    }
    const registryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
    try {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      const overrides = data.topicOverrides?.[String(topicId)] ?? { autoApproveAll: false, relayAll: false };
      res.json({ topicId, overrides });
    } catch {
      res.json({ topicId, overrides: { autoApproveAll: false, relayAll: false } });
    }
  });

  /**
   * PUT /prompt-gate/topic/:topicId/override — Set per-topic prompt gate overrides.
   * Body: { autoApproveAll?: boolean, relayAll?: boolean }
   */
  router.put('/prompt-gate/topic/:topicId/override', (req, res) => {
    const topicId = parseInt(req.params.topicId, 10);
    if (isNaN(topicId)) {
      res.status(400).json({ error: 'topicId must be a number' });
      return;
    }
    const { autoApproveAll, relayAll } = req.body ?? {};
    if (autoApproveAll !== undefined && typeof autoApproveAll !== 'boolean') {
      res.status(400).json({ error: 'autoApproveAll must be a boolean' });
      return;
    }
    if (relayAll !== undefined && typeof relayAll !== 'boolean') {
      res.status(400).json({ error: 'relayAll must be a boolean' });
      return;
    }

    const registryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
    try {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(fs.readFileSync(registryPath, 'utf-8')); } catch { /* new file */ }

      if (!data.topicOverrides) data.topicOverrides = {};
      const overrides = (data.topicOverrides as Record<string, unknown>);
      const existing = (overrides[String(topicId)] ?? {}) as Record<string, boolean>;

      if (autoApproveAll !== undefined) existing.autoApproveAll = autoApproveAll;
      if (relayAll !== undefined) existing.relayAll = relayAll;
      overrides[String(topicId)] = existing;

      fs.writeFileSync(registryPath, JSON.stringify(data, null, 2));
      res.json({ ok: true, topicId, overrides: existing });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save override' });
    }
  });

  /**
   * GET /prompt-gate/status — Current prompt gate status for all sessions.
   * Returns which sessions have pending prompts, their type, and duration.
   */
  router.get('/prompt-gate/status', (_req, res) => {
    if (!ctx.telegram) {
      res.json({ enabled: false, sessions: [] });
      return;
    }
    // The detailed status comes from the TelegramAdapter's pendingPromptReply map
    // For now, return basic status
    const promptGateConfig = ctx.config.monitoring?.promptGate;
    res.json({
      enabled: !!promptGateConfig?.enabled,
      autoApproveEnabled: !!promptGateConfig?.autoApprove?.enabled,
      dryRun: !!promptGateConfig?.dryRun,
      ownerId: promptGateConfig?.ownerId ?? null,
    });
  });

  // ── Feature Registry (Consent & Discovery Framework) ────────────────
  //
  // Phase 1: Feature Registry — definitions, state, and summaries.

  router.get('/features', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    const stateFilter = req.query.state as string | undefined;

    if (stateFilter) {
      const states = stateFilter.split(',').map(s => s.trim()) as import('../core/FeatureRegistry.js').DiscoveryState[];
      res.json({ features: ctx.featureRegistry.getFeaturesByState(states, userId) });
    } else {
      res.json({ features: ctx.featureRegistry.getAllFeatures(userId) });
    }
  });

  router.get('/features/summary', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    res.json({ features: ctx.featureRegistry.getSummaries(userId) });
  });

  router.get('/features/events', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = req.query.userId as string | undefined;
    const featureId = req.query.featureId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const events = ctx.featureRegistry.getDiscoveryEvents({ userId, featureId, limit });
    res.json({ events });
  });

  // Phase 5: Analytics & Observability — must be before /features/:id to avoid param capture

  router.get('/features/analytics', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    res.json(ctx.featureRegistry.getAnalytics(userId));
  });

  router.get('/features/cooldowns', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    res.json({ cooldowns: ctx.featureRegistry.getCooldownStatuses(userId) });
  });

  router.get('/features/funnel', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    res.json({ funnel: ctx.featureRegistry.getFunnelMetrics(userId) });
  });

  router.get('/features/digest', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    const thresholdDays = req.query.thresholdDays ? parseInt(req.query.thresholdDays as string, 10) : 15;
    res.json({
      changedDisabled: ctx.featureRegistry.getChangedDisabledFeatures(userId),
      unusedEnabled: ctx.featureRegistry.getUnusedEnabledFeatures(userId, thresholdDays),
    });
  });

  // Phase 3: Evaluator status — must be before /features/:id to avoid param capture
  router.get('/features/evaluator-status', (_req, res) => {
    if (!ctx.discoveryEvaluator) {
      res.status(501).json({ error: 'DiscoveryEvaluator not initialized' });
      return;
    }
    res.json(ctx.discoveryEvaluator.getStatus());
  });

  router.get('/features/:id', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    const info = ctx.featureRegistry.getFeatureInfo(req.params.id, userId);
    if (!info) {
      res.status(404).json({
        error: { code: 'FEATURE_NOT_FOUND', message: `Feature '${req.params.id}' not found in registry.` },
      });
      return;
    }
    res.json({
      ...info,
      validTransitions: ctx.featureRegistry.getValidTransitions(req.params.id, userId),
    });
  });

  // ── Phase 2: State Machine, Consent, Events ─────────────────────

  router.post('/features/:id/surface', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.body?.userId as string) || 'default';
    const result = ctx.featureRegistry.recordSurface(req.params.id, userId, {
      surfacedAs: req.body?.surfacedAs,
      trigger: req.body?.trigger,
      context: req.body?.context,
    });
    if (!result.success) {
      const status = result.error?.code === 'FEATURE_NOT_FOUND' ? 404 : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  router.post('/features/:id/transition', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const { to, userId: bodyUserId, trigger, consentRecord, context, activationChallenge } = req.body || {};
    if (!to) {
      res.status(400).json({ error: { code: 'MISSING_TARGET', message: 'Request body must include "to" (target state)' } });
      return;
    }
    const userId = (bodyUserId as string) || 'default';
    const result = ctx.featureRegistry.transition(req.params.id, userId, to, {
      trigger,
      consentRecord,
      context,
      activationChallenge,
    });
    if (!result.success) {
      const status = result.error?.code === 'FEATURE_NOT_FOUND' ? 404
        : result.error?.code === 'INVALID_TRANSITION' ? 422
        : result.error?.code === 'CONSENT_REQUIRED' ? 422
        : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  router.delete('/features/discovery-data', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.body?.userId as string) || (req.query.userId as string) || 'default';
    const forceDeleteConsent = req.body?.forceDeleteConsent === true;
    const result = ctx.featureRegistry.eraseDiscoveryData(userId, { forceDeleteConsent });
    res.json({
      erased: true,
      userId,
      stateRowsDeleted: result.deleted,
      consentRecordsPreserved: result.consentRecordsPreserved,
    });
  });

  router.get('/features/:id/consent-records', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    const records = ctx.featureRegistry.getConsentRecordsForFeature(req.params.id, userId);
    res.json({ records });
  });

  // ── Phase 3: Context Evaluator ──────────────────────────────────

  router.post('/features/evaluate-context', async (req, res) => {
    if (!ctx.discoveryEvaluator) {
      res.status(501).json({ error: 'DiscoveryEvaluator not initialized (requires IntelligenceProvider)' });
      return;
    }

    const {
      topicCategory,
      conversationIntent,
      problemCategories,
      autonomyProfile,
      enabledFeatures,
      userId,
    } = req.body || {};

    if (!topicCategory || typeof topicCategory !== 'string') {
      res.status(400).json({ error: { code: 'MISSING_TOPIC', message: 'Request body must include "topicCategory" (string)' } });
      return;
    }

    const validIntents = ['debugging', 'configuring', 'exploring', 'building', 'asking', 'monitoring', 'unknown'];
    const intent = validIntents.includes(conversationIntent) ? conversationIntent : 'unknown';

    try {
      const result = await ctx.discoveryEvaluator.evaluate({
        topicCategory,
        conversationIntent: intent,
        problemCategories: Array.isArray(problemCategories) ? problemCategories : [],
        autonomyProfile: autonomyProfile || 'collaborative',
        enabledFeatures: Array.isArray(enabledFeatures) ? enabledFeatures : [],
        userId: userId || 'default',
      });
      res.json(result);
    } catch (err) {
      // Fail-open: return no recommendation on unexpected errors
      res.json({
        recommendation: null,
        cached: false,
        rateLimited: false,
        eligibleCount: 0,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
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
