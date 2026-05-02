/**
 * Agent Server — HTTP server wrapping Express.
 *
 * Provides health checks, session management, job triggering,
 * and event querying over a simple REST API.
 *
 * Also serves the dashboard UI at /dashboard and handles
 * WebSocket connections for real-time terminal streaming.
 */

import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { MessageRouter } from '../messaging/MessageRouter.js';
import type { InstarConfig } from '../core/types.js';
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
import type { SessionWatchdog } from '../monitoring/SessionWatchdog.js';
import type { StallTriageNurse } from '../monitoring/StallTriageNurse.js';
import type { MultiMachineCoordinator } from '../core/MultiMachineCoordinator.js';
import type { TopicMemory } from '../memory/TopicMemory.js';
import type { FeedbackAnomalyDetector } from '../monitoring/FeedbackAnomalyDetector.js';
import { createRoutes } from './routes.js';
import { createFileRoutes } from './fileRoutes.js';
import { mountWhatsAppWebhooks } from '../messaging/backends/WhatsAppWebhookRoutes.js';
import { createMachineRoutes } from './machineRoutes.js';
import { createWorktreeRoutes, createOidcWorktreeRoutes } from './worktreeRoutes.js';
import type { WorktreeManager } from '../core/WorktreeManager.js';
import { corsMiddleware, authMiddleware, requestTimeout, errorHandler, dashboardSecurityHeaders } from './middleware.js';
import { WebSocketManager } from './WebSocketManager.js';
import { assertSqliteAvailable, PendingRelayStore } from '../messaging/pending-relay-store.js';
import { getOrCreateBootId } from './boot-id.js';
import { DeliveryFailureSentinel } from '../monitoring/delivery-failure-sentinel.js';
import os from 'node:os';
import { TokenLedger } from '../monitoring/TokenLedger.js';
import { TokenLedgerPoller } from '../monitoring/TokenLedgerPoller.js';

export class AgentServer {
  private app: Express;
  private server: Server | null = null;
  private wsManager: WebSocketManager | null = null;
  private config: InstarConfig;
  private startTime: Date;
  private sessionManager: SessionManager;
  private state: StateManager;
  private hookEventReceiver?: import('../monitoring/HookEventReceiver.js').HookEventReceiver;
  private routeContext: { wsManager: import('./WebSocketManager.js').WebSocketManager | null } | null = null;
  private deliverySentinel: DeliveryFailureSentinel | null = null;
  private deliveryStore: PendingRelayStore | null = null;
  private toneGate: import('../core/MessagingToneGate.js').MessagingToneGate | null = null;
  private tokenLedger: TokenLedger | null = null;
  private tokenLedgerPoller: TokenLedgerPoller | null = null;

  constructor(options: {
    config: InstarConfig;
    sessionManager: SessionManager;
    state: StateManager;
    scheduler?: JobScheduler;
    telegram?: TelegramAdapter;
    relationships?: RelationshipManager;
    feedback?: FeedbackManager;
    dispatches?: DispatchManager;
    updateChecker?: UpdateChecker;
    autoUpdater?: AutoUpdater;
    autoDispatcher?: AutoDispatcher;
    quotaTracker?: QuotaTracker;
    publisher?: TelegraphService;
    viewer?: PrivateViewer;
    tunnel?: TunnelManager;
    evolution?: EvolutionManager;
    watchdog?: SessionWatchdog;
    triageNurse?: StallTriageNurse;
    topicMemory?: TopicMemory;
    feedbackAnomalyDetector?: FeedbackAnomalyDetector;
    projectMapper?: import('../core/ProjectMapper.js').ProjectMapper;
    coherenceGate?: import('../core/ScopeVerifier.js').ScopeVerifier;
    contextHierarchy?: import('../core/ContextHierarchy.js').ContextHierarchy;
    canonicalState?: import('../core/CanonicalState.js').CanonicalState;
    operationGate?: import('../core/ExternalOperationGate.js').ExternalOperationGate;
    sentinel?: import('../core/MessageSentinel.js').MessageSentinel;
    adaptiveTrust?: import('../core/AdaptiveTrust.js').AdaptiveTrust;
    memoryMonitor?: import('../monitoring/MemoryPressureMonitor.js').MemoryPressureMonitor;
    orphanReaper?: import('../monitoring/OrphanProcessReaper.js').OrphanProcessReaper;
    coherenceMonitor?: import('../monitoring/CoherenceMonitor.js').CoherenceMonitor;
    commitmentTracker?: import('../monitoring/CommitmentTracker.js').CommitmentTracker;
    semanticMemory?: import('../memory/SemanticMemory.js').SemanticMemory;
    activitySentinel?: import('../monitoring/SessionActivitySentinel.js').SessionActivitySentinel;
    workingMemory?: import('../memory/WorkingMemoryAssembler.js').WorkingMemoryAssembler;
    quotaManager?: import('../monitoring/QuotaManager.js').QuotaManager;
    messageRouter?: MessageRouter;
    summarySentinel?: import('../messaging/SessionSummarySentinel.js').SessionSummarySentinel;
    spawnManager?: import('../messaging/SpawnRequestManager.js').SpawnRequestManager;
    systemReviewer?: import('../monitoring/SystemReviewer.js').SystemReviewer;
    capabilityMapper?: import('../core/CapabilityMapper.js').CapabilityMapper;
    selfKnowledgeTree?: import('../knowledge/SelfKnowledgeTree.js').SelfKnowledgeTree;
    coverageAuditor?: import('../knowledge/CoverageAuditor.js').CoverageAuditor;
    topicResumeMap?: import('../core/TopicResumeMap.js').TopicResumeMap;
    autonomyManager?: import('../core/AutonomyProfileManager.js').AutonomyProfileManager;
    trustElevationTracker?: import('../core/TrustElevationTracker.js').TrustElevationTracker;
    autonomousEvolution?: import('../core/AutonomousEvolution.js').AutonomousEvolution;
    coordinator?: MultiMachineCoordinator;
    localSigningKeyPem?: string;
    whatsapp?: import('../messaging/WhatsAppAdapter.js').WhatsAppAdapter;
    slack?: import('../messaging/slack/SlackAdapter.js').SlackAdapter;
    imessage?: import('../messaging/imessage/IMessageAdapter.js').IMessageAdapter;
    whatsappBusinessBackend?: import('../messaging/backends/BusinessApiBackend.js').BusinessApiBackend;
    messageBridge?: import('../messaging/shared/MessageBridge.js').MessageBridge;
    hookEventReceiver?: import('../monitoring/HookEventReceiver.js').HookEventReceiver;
    worktreeMonitor?: import('../monitoring/WorktreeMonitor.js').WorktreeMonitor;
    subagentTracker?: import('../monitoring/SubagentTracker.js').SubagentTracker;
    instructionsVerifier?: import('../monitoring/InstructionsVerifier.js').InstructionsVerifier;
    threadlineRouter?: import('../threadline/ThreadlineRouter.js').ThreadlineRouter;
    handshakeManager?: import('../threadline/HandshakeManager.js').HandshakeManager;
    threadlineRelayClient?: import('../threadline/client/ThreadlineClient.js').ThreadlineClient;
    threadlineReplyWaiters?: Map<string, { resolve: (reply: string) => void; threadId: string; senderAgent: string; timer: ReturnType<typeof setTimeout> }>;
    listenerManager?: import('../threadline/ListenerSessionManager.js').ListenerSessionManager;
    responseReviewGate?: import('../core/CoherenceGate.js').CoherenceGate;
    messagingToneGate?: import('../core/MessagingToneGate.js').MessagingToneGate;
    outboundDedupGate?: import('../core/OutboundDedupGate.js').OutboundDedupGate;
    telemetryHeartbeat?: import('../monitoring/TelemetryHeartbeat.js').TelemetryHeartbeat;
    pasteManager?: import('../paste/PasteManager.js').PasteManager;
    soulManager?: import('../core/SoulManager.js').SoulManager;
    featureRegistry?: import('../core/FeatureRegistry.js').FeatureRegistry;
    discoveryEvaluator?: import('../core/DiscoveryEvaluator.js').DiscoveryEvaluator;
    unifiedTrust?: import('../threadline/UnifiedTrustWiring.js').UnifiedTrustSystem;
    liveConfig?: { set(path: string, value: unknown): void };
    /** Shared proxy coordinator (PresenceProxy ↔ PromiseBeacon ↔ /build heartbeat). */
    proxyCoordinator?: import('../monitoring/ProxyCoordinator.js').ProxyCoordinator;
    /** Integrated-Being shared-state ledger (v1). Null/undefined when disabled. */
    sharedStateLedger?: import('../core/SharedStateLedger.js').SharedStateLedger;
    /** Integrated-Being LedgerSessionRegistry (v2). Null/undefined when v2Enabled=false. */
    ledgerSessionRegistry?: import('../core/LedgerSessionRegistry.js').LedgerSessionRegistry;
    /** Worktree manager — parallel-dev isolation (PARALLEL-DEV-ISOLATION-SPEC.md). */
    worktreeManager?: WorktreeManager;
    /** OIDC verification function for the GH-check endpoint (injected for testability). */
    oidcVerify?: (token: string) => Promise<{ repository: string; workflow_ref: string; ref: string }>;
    /** Enrolled GitHub repos allowed to call the GH-check endpoint. */
    oidcEnrolledRepos?: Array<{ owner: string; repo: string }>;
    /** UnjustifiedStopGate authority (PR3 — context-death spec). */
    unjustifiedStopGate?: import('../core/UnjustifiedStopGate.js').UnjustifiedStopGate;
    /** Stop-gate SQLite persistence (PR3). */
    stopGateDb?: import('../core/StopGateDb.js').StopGateDb;
    /** Initiative tracker — persisted record of multi-phase long-running work. */
    initiativeTracker?: import('../core/InitiativeTracker.js').InitiativeTracker;
    /** Threadline → Telegram bridge config — toggles + allow/deny list. */
    telegramBridgeConfig?: import('../threadline/TelegramBridgeConfig.js').TelegramBridgeConfig;
    /** Threadline → Telegram bridge — relay-only mirror of threadline messages. */
    telegramBridge?: import('../threadline/TelegramBridge.js').TelegramBridge;
  }) {
    this.config = options.config;
    this.startTime = new Date();
    this.sessionManager = options.sessionManager;
    this.state = options.state;
    this.hookEventReceiver = options.hookEventReceiver ?? undefined;
    this.toneGate = options.messagingToneGate ?? null;
    this.app = express();

    // Middleware
    this.app.use(express.json({ limit: '12mb' }));
    this.app.use(corsMiddleware);

    // Dashboard security headers — set before static serving so they apply to all dashboard responses
    this.app.use(dashboardSecurityHeaders);

    // Dashboard static files — served BEFORE auth middleware so the page loads
    // without a token. Auth happens via WebSocket/API calls from the page itself.
    const dashboardDir = this.resolveDashboardDir();
    this.app.get('/dashboard', (_req, res) => {
      res.sendFile(path.join(dashboardDir, 'index.html'));
    });
    this.app.use('/dashboard', express.static(dashboardDir));

    // PIN-based dashboard unlock — exchanges a short PIN for the auth token.
    // Placed before auth middleware so the dashboard can call it without a token.
    // Route is registered unconditionally so it works even when dashboardPin is
    // generated after AgentServer construction (first-boot timing issue).
    // Config values are checked at request time via this.config which may be
    // updated by LiveConfig/PostUpdateMigrator after construction.
    const pinAttempts = new Map<string, { count: number; resetAt: number }>();
    const MAX_ATTEMPTS = 5;
    const WINDOW_MS = 5 * 60 * 1000; // 5-minute window
    const configRef = this.config;

    this.app.post('/dashboard/unlock', (req: Request, res: Response) => {
      if (!configRef.dashboardPin || !configRef.authToken) {
        res.status(503).json({ error: 'PIN authentication not yet available. Try again shortly.' });
        return;
      }

      const ip = req.ip || req.socket.remoteAddress || 'unknown';

      // Rate limit by IP
      const now = Date.now();
      let entry = pinAttempts.get(ip);
      if (entry && now > entry.resetAt) {
        pinAttempts.delete(ip);
        entry = undefined;
      }
      if (entry && entry.count >= MAX_ATTEMPTS) {
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return;
      }

      const { pin } = req.body;
      if (!pin || typeof pin !== 'string') {
        res.status(400).json({ error: 'Missing PIN' });
        return;
      }

      const ha = createHash('sha256').update(pin).digest();
      const hb = createHash('sha256').update(configRef.dashboardPin).digest();
      if (!timingSafeEqual(ha, hb)) {
        // Track failed attempt
        if (!entry) {
          entry = { count: 0, resetAt: now + WINDOW_MS };
          pinAttempts.set(ip, entry);
        }
        entry.count++;
        const remaining = MAX_ATTEMPTS - entry.count;
        res.status(403).json({
          error: 'Incorrect PIN',
          attemptsRemaining: remaining,
        });
        return;
      }

      // PIN correct — return the auth token
      res.json({ token: configRef.authToken });
    });

    // Machine-to-machine routes — mounted BEFORE auth middleware because they use
    // their own machineAuth scheme (Ed25519 signatures, not bearer tokens).
    if (options.coordinator?.enabled) {
      const coord = options.coordinator;
      const machineRoutes = createMachineRoutes({
        identityManager: coord.managers.identityManager,
        heartbeatManager: coord.managers.heartbeatManager,
        securityLog: coord.managers.securityLog,
        authDeps: {
          identityManager: coord.managers.identityManager,
          nonceStore: coord.managers.nonceStore,
          securityLog: coord.managers.securityLog,
          localMachineId: coord.identity!.machineId,
        },
        localMachineId: coord.identity!.machineId,
        localSigningKeyPem: options.localSigningKeyPem ?? '',
        onDemote: () => coord.demoteToStandby('Remote heartbeat: another machine took over'),
        onPromote: () => coord.promoteToAwake('Remote handoff: awake machine handed off to us'),
        onHandoffRequest: async () => ({
          ready: true,
          state: { jobs: [], sessions: [] },
        }),
        messageRouter: options.messageRouter ?? null,
      });
      this.app.use(machineRoutes);
    }

    // Worktree GH-check endpoint — mounted BEFORE auth middleware because it uses
    // GitHub OIDC tokens, not bearer tokens. Authority for the parallel-dev isolation
    // push gate (PARALLEL-DEV-ISOLATION-SPEC.md, "Authoritative push gate" section).
    if (options.worktreeManager && options.oidcVerify) {
      const oidcRoutes = createOidcWorktreeRoutes({
        worktreeManager: options.worktreeManager,
        oidc: {
          enrolledRepos: options.oidcEnrolledRepos ?? [],
          verifyOidcToken: options.oidcVerify,
        },
      });
      this.app.use(oidcRoutes);
    }

    // WhatsApp Business API webhook routes — mounted BEFORE auth middleware because
    // Meta's webhook verification sends GET requests without Bearer tokens.
    if (options.whatsappBusinessBackend) {
      // Import is at top of file — mountWhatsAppWebhooks is synchronous
      mountWhatsAppWebhooks({
        app: this.app,
        backend: options.whatsappBusinessBackend,
      });
    }

    // Agent-id binding (spec telegram-delivery-robustness § Layer 1b):
    // pass projectName as the agent identity so the auth middleware can
    // structurally reject tokens sent to the wrong agent's server BEFORE
    // any token comparison runs. This closes the cross-tenant misroute
    // class proven by the Inspec/cheryl 2026-04-27 incident.
    this.app.use(authMiddleware(options.config.authToken, options.config.projectName));
    // Outbound messaging routes are intentionally LLM-backed (tone gate review)
    // and involve third-party API calls (Telegram/Slack/WhatsApp Bot APIs) whose
    // latency we don't control. The default 30s budget is routinely exceeded
    // under normal load; a 408 fired while the handler's send is in flight
    // causes the agent's client to treat a successful delivery as failure,
    // regenerate, and retry — shipping a duplicate message. Extended budget
    // of 120s accommodates the realistic p99 of this path.
    const OUTBOUND_MESSAGING_TIMEOUT_MS = 120_000;
    this.app.use(requestTimeout(options.config.requestTimeoutMs, {
      '/telegram/reply': OUTBOUND_MESSAGING_TIMEOUT_MS,
      '/telegram/post-update': OUTBOUND_MESSAGING_TIMEOUT_MS,
      '/slack/reply': OUTBOUND_MESSAGING_TIMEOUT_MS,
      '/whatsapp/send': OUTBOUND_MESSAGING_TIMEOUT_MS,
      '/imessage/reply': OUTBOUND_MESSAGING_TIMEOUT_MS,
      '/imessage/validate-send': OUTBOUND_MESSAGING_TIMEOUT_MS,
    }));

    // ── Token Ledger ──────────────────────────────────────────────────
    // Read-only token-usage observability. Reads Claude Code's per-session
    // JSONL transcripts and rolls up into SQLite. Never mutates source files.
    try {
      if (options.config.stateDir) {
        const serverDataDir = path.join(options.config.stateDir, 'server-data');
        fs.mkdirSync(serverDataDir, { recursive: true });
        const dbPath = path.join(serverDataDir, 'token-ledger.db');
        const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
        this.tokenLedger = new TokenLedger({ dbPath, claudeProjectsDir });
      }
    } catch (err) {
      console.warn('[instar] token-ledger init failed (non-fatal):', err);
      this.tokenLedger = null;
    }

    // Routes
    const routeCtx = {
      config: options.config,
      sessionManager: options.sessionManager,
      state: options.state,
      scheduler: options.scheduler ?? null,
      telegram: options.telegram ?? null,
      relationships: options.relationships ?? null,
      feedback: options.feedback ?? null,
      dispatches: options.dispatches ?? null,
      updateChecker: options.updateChecker ?? null,
      autoUpdater: options.autoUpdater ?? null,
      autoDispatcher: options.autoDispatcher ?? null,
      quotaTracker: options.quotaTracker ?? null,
      publisher: options.publisher ?? null,
      viewer: options.viewer ?? null,
      tunnel: options.tunnel ?? null,
      evolution: options.evolution ?? null,
      watchdog: options.watchdog ?? null,
      triageNurse: options.triageNurse ?? null,
      topicMemory: options.topicMemory ?? null,
      feedbackAnomalyDetector: options.feedbackAnomalyDetector ?? null,
      projectMapper: options.projectMapper ?? null,
      coherenceGate: options.coherenceGate ?? null,
      contextHierarchy: options.contextHierarchy ?? null,
      canonicalState: options.canonicalState ?? null,
      operationGate: options.operationGate ?? null,
      sentinel: options.sentinel ?? null,
      adaptiveTrust: options.adaptiveTrust ?? null,
      memoryMonitor: options.memoryMonitor ?? null,
      orphanReaper: options.orphanReaper ?? null,
      coherenceMonitor: options.coherenceMonitor ?? null,
      commitmentTracker: options.commitmentTracker ?? null,
      semanticMemory: options.semanticMemory ?? null,
      activitySentinel: options.activitySentinel ?? null,
      workingMemory: options.workingMemory ?? null,
      quotaManager: options.quotaManager ?? null,
      messageRouter: options.messageRouter ?? null,
      summarySentinel: options.summarySentinel ?? null,
      spawnManager: options.spawnManager ?? null,
      systemReviewer: options.systemReviewer ?? null,
      capabilityMapper: options.capabilityMapper ?? null,
      selfKnowledgeTree: options.selfKnowledgeTree ?? null,
      coverageAuditor: options.coverageAuditor ?? null,
      topicResumeMap: options.topicResumeMap ?? null,
      autonomyManager: options.autonomyManager ?? null,
      trustElevationTracker: options.trustElevationTracker ?? null,
      autonomousEvolution: options.autonomousEvolution ?? null,
      whatsapp: options.whatsapp ?? null,
      slack: options.slack ?? null,
      imessage: options.imessage ?? null,
      messageBridge: options.messageBridge ?? null,
      hookEventReceiver: options.hookEventReceiver ?? null,
      worktreeMonitor: options.worktreeMonitor ?? null,
      subagentTracker: options.subagentTracker ?? null,
      instructionsVerifier: options.instructionsVerifier ?? null,
      threadlineRouter: options.threadlineRouter ?? null,
      handshakeManager: options.handshakeManager ?? null,
      threadlineRelayClient: options.threadlineRelayClient ?? null,
      listenerManager: options.listenerManager ?? null,
      responseReviewGate: options.responseReviewGate ?? null,
      messagingToneGate: options.messagingToneGate ?? null,
      outboundDedupGate: options.outboundDedupGate ?? null,
      telemetryHeartbeat: options.telemetryHeartbeat ?? null,
      pasteManager: options.pasteManager ?? null,
      wsManager: null, // Set after WebSocket manager is initialized
      soulManager: options.soulManager ?? null,
      featureRegistry: options.featureRegistry ?? null,
      discoveryEvaluator: options.discoveryEvaluator ?? null,
      unifiedTrust: options.unifiedTrust ?? null,
      threadlineReplyWaiters: options.threadlineReplyWaiters ?? new Map(),
      proxyCoordinator: options.proxyCoordinator ?? null,
      sharedStateLedger: options.sharedStateLedger ?? null,
      ledgerSessionRegistry: options.ledgerSessionRegistry ?? null,
      unjustifiedStopGate: options.unjustifiedStopGate ?? null,
      stopGateDb: options.stopGateDb ?? null,
      initiativeTracker: options.initiativeTracker ?? null,
      tokenLedger: this.tokenLedger,
      telegramBridgeConfig: options.telegramBridgeConfig ?? null,
      telegramBridge: options.telegramBridge ?? null,
      startTime: this.startTime,
    };
    this.routeContext = routeCtx;
    const routes = createRoutes(routeCtx);
    this.app.use(routes);

    // File viewer routes (after auth middleware)
    const fileRoutes = createFileRoutes({ config: options.config, liveConfig: options.liveConfig });
    this.app.use(fileRoutes);

    // Worktree manager (auth-required) routes — bindings, locks, preflight, sign-trailer.
    if (options.worktreeManager) {
      const worktreeRoutes = createWorktreeRoutes({
        worktreeManager: options.worktreeManager,
        projectDir: options.config.projectDir,
      });
      this.app.use(worktreeRoutes);
    }

    // Error handler (must be last)
    this.app.use(errorHandler);
  }

  /**
   * Resolve the dashboard directory.
   * In dev: ../../../dashboard (relative to src/server/)
   * In dist (published): ../../dashboard (relative to dist/server/)
   */
  private resolveDashboardDir(): string {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    // Try dist layout first (package root/dashboard)
    const fromDist = path.resolve(thisDir, '..', '..', 'dashboard');
    // Try dev layout (src/server -> project root/dashboard)
    const fromSrc = path.resolve(thisDir, '..', '..', '..', 'dashboard');
    if (fs.existsSync(fromDist)) return fromDist;
    if (fs.existsSync(fromSrc)) return fromSrc;
    return fromDist;
  }

  /**
   * Start the HTTP server.
   */
  async start(): Promise<void> {
    // Layer 2 boot self-check (spec § 2a "Runtime dependency"). Probes the
    // sqlite3 CLI + better-sqlite3 in-process driver and emits degradation
    // events on missing/broken substrate. Never throws — Layer 2 is best-
    // effort signal infrastructure, not a critical-path dependency.
    try {
      assertSqliteAvailable();
    } catch (err) {
      // Defensive: assertSqliteAvailable is documented as non-throwing,
      // but a malformed DegradationReporter could still raise. Log and
      // continue.
      console.warn('[instar] sqlite boot self-check raised:', err);
    }

    // Layer 3 spec §3b: create boot.id SYNCHRONOUSLY before binding the
    // listener. The sentinel reads this at start() to disambiguate stale
    // leases from prior boots (PID reuse). Any I/O failure here is
    // non-fatal — boot id is best-effort infrastructure for the sentinel,
    // which is itself feature-flagged default-off.
    try {
      if (this.config.stateDir) {
        getOrCreateBootId(this.config.stateDir, this.config.version);
      }
    } catch (err) {
      console.warn('[instar] boot.id creation raised (sentinel will fail to start):', err);
    }

    return new Promise((resolve, reject) => {
      const host = this.config.host || '127.0.0.1';
      this.server = this.app.listen(this.config.port, host, () => {
        console.log(`[instar] Server listening on ${host}:${this.config.port}`);
        console.log(`[instar] Dashboard: http://${host}:${this.config.port}/dashboard`);

        // Initialize WebSocket manager after server is listening
        this.wsManager = new WebSocketManager({
          server: this.server!,
          sessionManager: this.sessionManager,
          state: this.state,
          authToken: this.config.authToken,
          instarDir: this.config.stateDir,
          hookEventReceiver: this.hookEventReceiver,
        });

        // Update route context with WebSocket manager (deferred — created after routes)
        if (this.routeContext) {
          this.routeContext.wsManager = this.wsManager;
        }

        // ── Token Ledger Poller ─────────────────────────────────────────
        // 60s tick scans `~/.claude/projects/*/*.jsonl` and rolls up into
        // the token_events table. Strictly read-only against source files.
        if (this.tokenLedger) {
          try {
            this.tokenLedgerPoller = new TokenLedgerPoller({ ledger: this.tokenLedger });
            this.tokenLedgerPoller.start();
          } catch (err) {
            console.warn('[instar] token-ledger poller start failed:', err);
          }
        }

        // ── Layer 3 DeliveryFailureSentinel — default-OFF feature flag ──
        // Spec § 3j: `monitoring.deliveryFailureSentinel.enabled` defaults
        // false. The sentinel only spins up when an operator explicitly
        // opts in. Layer 1 + Layer 2 ship unconditionally; Layer 3 is the
        // opt-in upgrade for general delivery resilience.
        const monitoringCfg = (this.config as { monitoring?: { deliveryFailureSentinel?: { enabled?: boolean } } }).monitoring;
        const sentinelEnabled = monitoringCfg?.deliveryFailureSentinel?.enabled === true;
        if (sentinelEnabled && this.config.stateDir) {
          try {
            this.startDeliverySentinel().catch((err) => {
              console.warn('[instar] delivery-failure-sentinel start failed:', err);
            });
          } catch (err) {
            console.warn('[instar] delivery-failure-sentinel start raised:', err);
          }
        }

        resolve();
      });
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.config.port} is already in use. Is another instar server running?`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Spin up the Layer 3 DeliveryFailureSentinel. Opens the per-agent
   * pending-relay SQLite store (creating it lazily if needed), wires
   * the sentinel into the WebSocket event stream so `delivery_failed`
   * events drive recovery in <1s, and arms the watchdog tick.
   *
   * Failures here are isolated — the sentinel is opt-in default-OFF
   * infrastructure, not a critical-path dependency. Any error here is
   * logged and the rest of the server continues running.
   */
  private async startDeliverySentinel(): Promise<void> {
    const stateDir = this.config.stateDir;
    const agentId = this.config.projectName;
    if (!stateDir || !agentId) return;

    let store: PendingRelayStore;
    try {
      store = PendingRelayStore.open(agentId, stateDir);
    } catch (err) {
      console.warn('[delivery-sentinel] pending-relay-store open failed; sentinel disabled:', err);
      return;
    }
    this.deliveryStore = store;

    const bootId = (await import('./boot-id.js')).getCurrentBootId();
    if (!bootId) {
      console.warn('[delivery-sentinel] bootId not initialized; sentinel cannot start');
      return;
    }

    const configPath = path.join(stateDir, 'config.json');
    const sentinel = new DeliveryFailureSentinel(
      {
        store,
        configPath,
        readConfig: () => ({
          port: this.config.port,
          authToken: this.config.authToken ?? '',
          agentId,
        }),
        bootId,
        toneGate: this.toneGate,
        subscribeFailureEvents: this.wsManager
          ? (listener) => {
              const handler = (event: Record<string, unknown>) => {
                if (event.type === 'delivery_failed' && event.agentId === agentId) {
                  listener(event as unknown as { delivery_id: string; topic_id: number; agentId: string });
                }
              };
              return this.wsManager!.subscribeEvents(handler);
            }
          : undefined,
      },
    );
    this.deliverySentinel = sentinel;
    await sentinel.start();
    console.log('[instar] delivery-failure-sentinel started (Layer 3 recovery active)');
  }

  /**
   * Stop the HTTP server gracefully.
   * Closes keep-alive connections after a timeout to prevent hanging.
   */
  async stop(): Promise<void> {
    // Stop the Layer 3 sentinel BEFORE the WebSocket manager — the
    // sentinel's SSE subscription needs an alive wsManager to clean up
    // its listener. Order: sentinel → wsManager → server.
    if (this.deliverySentinel) {
      try {
        await this.deliverySentinel.stop();
      } catch (err) {
        console.warn('[instar] delivery-failure-sentinel stop raised:', err);
      }
      this.deliverySentinel = null;
    }
    if (this.deliveryStore) {
      try {
        this.deliveryStore.close();
      } catch {
        // best-effort
      }
      this.deliveryStore = null;
    }

    // Stop the token-ledger poller and close its DB.
    if (this.tokenLedgerPoller) {
      try {
        this.tokenLedgerPoller.stop();
      } catch {
        // best-effort
      }
      this.tokenLedgerPoller = null;
    }
    if (this.tokenLedger) {
      try {
        this.tokenLedger.close();
      } catch {
        // best-effort
      }
      this.tokenLedger = null;
    }

    // Shutdown WebSocket manager first
    if (this.wsManager) {
      this.wsManager.shutdown();
      this.wsManager = null;
    }

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(forceTimer);
        this.server = null;
        resolve();
      };

      // Force-close after 5 seconds if graceful close hangs (keep-alive connections)
      const forceTimer = setTimeout(() => {
        console.log('[instar] Force-closing server (keep-alive timeout)');
        this.server?.closeAllConnections?.();
        done();
      }, 5000);
      forceTimer.unref(); // Don't prevent process exit during shutdown

      this.server.close(() => done());
    });
  }

  /**
   * Expose the Express app for testing with supertest.
   */
  getApp(): Express {
    return this.app;
  }
}
