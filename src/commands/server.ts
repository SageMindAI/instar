/**
 * `instar server start|stop` — Manage the persistent agent server.
 *
 * Start launches the server in a tmux session (background) or foreground.
 * Stop kills the server tmux session.
 *
 * When Telegram is configured, wires up message routing:
 *   topic message → find/spawn session → inject message → session replies via [telegram:N]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig, ensureStateDir, detectTmuxPath } from '../core/Config.js';
import { SessionManager } from '../core/SessionManager.js';
import { StateManager } from '../core/StateManager.js';
import { JobScheduler } from '../scheduler/JobScheduler.js';
import { IntegrationGate } from '../scheduler/IntegrationGate.js';
import { JobRunHistory } from '../scheduler/JobRunHistory.js';
import { AgentServer } from '../server/AgentServer.js';
import { TelegramAdapter, TOPIC_STYLE, selectTopicEmoji } from '../messaging/TelegramAdapter.js';
import { RelationshipManager } from '../core/RelationshipManager.js';
import { ClaudeCliIntelligenceProvider } from '../core/ClaudeCliIntelligenceProvider.js';
import { AnthropicIntelligenceProvider } from '../core/AnthropicIntelligenceProvider.js';
import { FeedbackManager } from '../core/FeedbackManager.js';
import { FeedbackAnomalyDetector } from '../monitoring/FeedbackAnomalyDetector.js';
import { DispatchManager } from '../core/DispatchManager.js';
import { UpdateChecker } from '../core/UpdateChecker.js';
import { AutoUpdater } from '../core/AutoUpdater.js';
import { AutoDispatcher } from '../core/AutoDispatcher.js';
import { DispatchExecutor } from '../core/DispatchExecutor.js';
import { registerAgent, unregisterAgent, startHeartbeat } from '../core/AgentRegistry.js';
import { TelegraphService } from '../publishing/TelegraphService.js';
import { PrivateViewer } from '../publishing/PrivateViewer.js';
import { TunnelManager } from '../tunnel/TunnelManager.js';
import { PostUpdateMigrator } from '../core/PostUpdateMigrator.js';
import { UpgradeGuideProcessor } from '../core/UpgradeGuideProcessor.js';
import { EvolutionManager } from '../core/EvolutionManager.js';
import { TopicMemory } from '../memory/TopicMemory.js';
import { SemanticMemory } from '../memory/SemanticMemory.js';
import { QuotaTracker } from '../monitoring/QuotaTracker.js';
import { AccountSwitcher } from '../monitoring/AccountSwitcher.js';
import { QuotaNotifier } from '../monitoring/QuotaNotifier.js';
import { QuotaManager } from '../monitoring/QuotaManager.js';
import { classifySessionDeath } from '../monitoring/QuotaExhaustionDetector.js';
import { SessionWatchdog } from '../monitoring/SessionWatchdog.js';
import { formatWatchdogUserMessage } from '../monitoring/watchdog-notifications.js';
import { StallTriageNurse } from '../monitoring/StallTriageNurse.js';
import { TriageOrchestrator } from '../monitoring/TriageOrchestrator.js';
import { SessionMonitor } from '../monitoring/SessionMonitor.js';
import { SessionRecovery } from '../monitoring/SessionRecovery.js';
import { MultiMachineCoordinator } from '../core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../core/MachineIdentity.js';
import { GitSyncManager } from '../core/GitSync.js';
import { ProjectMapper } from '../core/ProjectMapper.js';
import { CapabilityMapper } from '../core/CapabilityMapper.js';
import { ScopeVerifier } from '../core/ScopeVerifier.js';
import { ContextHierarchy } from '../core/ContextHierarchy.js';
import { CanonicalState } from '../core/CanonicalState.js';
import { ExternalOperationGate, AUTONOMY_PROFILES } from '../core/ExternalOperationGate.js';
import { MessageSentinel } from '../core/MessageSentinel.js';
import { AdaptiveTrust } from '../core/AdaptiveTrust.js';
import { AutonomyProfileManager } from '../core/AutonomyProfileManager.js';
import { TrustElevationTracker } from '../core/TrustElevationTracker.js';
import { AutonomousEvolution } from '../core/AutonomousEvolution.js';
import { DispatchScopeEnforcer } from '../core/DispatchScopeEnforcer.js';
import { TrustRecovery } from '../core/TrustRecovery.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { SelfKnowledgeTree } from '../knowledge/SelfKnowledgeTree.js';
import { CoverageAuditor } from '../knowledge/CoverageAuditor.js';
import { LiveConfig } from '../config/LiveConfig.js';
import { CoherenceMonitor } from '../monitoring/CoherenceMonitor.js';
import { ProcessIntegrity } from '../core/ProcessIntegrity.js';
import { StaleProcessGuard } from '../core/StaleProcessGuard.js';
import { cleanupGlobalInstalls } from '../core/GlobalInstallCleanup.js';
import { ForegroundRestartWatcher } from '../core/ForegroundRestartWatcher.js';
import { NotificationBatcher } from '../messaging/NotificationBatcher.js';
import type { NotificationTier } from '../messaging/NotificationBatcher.js';
import { MessageStore } from '../messaging/MessageStore.js';
import { MessageFormatter } from '../messaging/MessageFormatter.js';
import { MessageDelivery } from '../messaging/MessageDelivery.js';
import type { TmuxOperations } from '../messaging/MessageDelivery.js';
import { MessageRouter } from '../messaging/MessageRouter.js';
import { generateAgentToken } from '../messaging/AgentTokenManager.js';
import { pickupDroppedMessages } from '../messaging/DropPickup.js';
import { pickupGitSyncMessages } from '../messaging/GitSyncTransport.js';
import { DeliveryRetryManager } from '../messaging/DeliveryRetryManager.js';
import { SpawnRequestManager } from '../messaging/SpawnRequestManager.js';
import { ThreadlineRouter } from '../threadline/ThreadlineRouter.js';
import { ThreadResumeMap } from '../threadline/ThreadResumeMap.js';
import { ListenerSessionManager } from '../threadline/ListenerSessionManager.js';
import { SystemReviewer } from '../monitoring/SystemReviewer.js';
import { createSessionProbes } from '../monitoring/probes/SessionProbe.js';
import { createSchedulerProbes } from '../monitoring/probes/SchedulerProbe.js';
import { createMessagingProbes } from '../monitoring/probes/MessagingProbe.js';
import { createLifelineProbes } from '../monitoring/probes/LifelineProbe.js';
import { createPlatformProbes } from '../monitoring/probes/PlatformProbe.js';
import { bootstrapThreadline } from '../threadline/ThreadlineBootstrap.js';
import { createUnifiedTrustSystem, type UnifiedTrustSystem } from '../threadline/UnifiedTrustWiring.js';
import type { PipelineMessage } from '../types/pipeline.js';
import { toPipeline, toInjection, toLogEntry, formatHistoryLine } from '../types/pipeline.js';
import type { Message, IntelligenceProvider, UserProfile, InstarConfig } from '../core/types.js';
import { UserManager } from '../users/UserManager.js';
import { formatUserContextForSession, hasUserContext } from '../users/UserContextBuilder.js';
import type { OrphanProcessReaper } from '../monitoring/OrphanProcessReaper.js';
// setup.ts uses @inquirer/prompts which requires Node 20.12+
// Dynamic import to avoid breaking the server on older Node versions
// import { installAutoStart } from './setup.js';

/**
 * Dependencies for the fix command handler — populated incrementally as
 * subsystems initialize (some start after wireTelegramRouting).
 */
interface FixCommandDeps {
  state: StateManager;
  liveConfig: LiveConfig;
  sessionManager: SessionManager;
  telegram: TelegramAdapter;
  config: InstarConfig;
  orphanReaper?: OrphanProcessReaper;
  coherenceMonitor?: CoherenceMonitor;
}

/**
 * Handle "fix X" and "clean X" commands from Agent Attention notifications.
 * These are mechanical server-side operations — no Claude session needed.
 * Returns true if the command was recognized and handled.
 */
async function handleFixCommand(topicId: number, text: string, deps: FixCommandDeps): Promise<boolean> {
  const cmd = text.trim().toLowerCase();

  // Only handle commands in the Agent Attention topic
  const attentionTopicId = deps.state.get<number>('agent-attention-topic');
  if (!attentionTopicId || topicId !== attentionTopicId) {
    return false;
  }

  const send = (msg: string) => deps.telegram.sendToTopic(topicId, msg);

  if (cmd === 'fix auth') {
    const existing = deps.liveConfig.get<string>('authToken', '');
    if (existing) {
      await send('Your API already has an authentication token configured. No changes needed.');
      return true;
    }
    // Generate a random token
    const token = Array.from({ length: 32 }, () =>
      'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36))
    ).join('');
    deps.liveConfig.set('authToken', token);
    await send(`Done! Generated and saved a new API authentication token. Your API is now protected.\n\nToken: ${token.slice(0, 8)}... (stored in config)`);
    return true;
  }

  if (cmd === 'fix dashboard') {
    const existing = deps.liveConfig.get<string>('dashboardPin', '');
    if (existing) {
      await send(`Your dashboard already has a PIN: ${existing}`);
      return true;
    }
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    deps.liveConfig.set('dashboardPin', pin);
    await send(`Done! Generated dashboard PIN: ${pin}`);
    return true;
  }

  if (cmd === 'fix shadow') {
    const localPkg = path.join(deps.config.projectDir, 'node_modules', 'instar');
    if (!fs.existsSync(localPkg)) {
      await send('No shadow installation found — your agent is using the global Instar installation correctly.');
      return true;
    }
    try {
      // Remove the shadow installation
      const { spawnSync } = await import('node:child_process');
      spawnSync('rm', ['-rf',
        path.join(deps.config.projectDir, 'node_modules'),
        path.join(deps.config.projectDir, 'package.json'),
        path.join(deps.config.projectDir, 'package-lock.json'),
      ], { timeout: 10000 });
      await send('Done! Removed the local shadow installation. Your agent will now use the global Instar binary and receive auto-updates properly.');
    } catch (err) {
      await send(`I ran into a problem removing the local installation. I'll try again next time, or you can ask me to retry now.`);
    }
    return true;
  }

  if (cmd === 'clean processes' || cmd === 'clean') {
    if (!deps.orphanReaper) {
      await send('The process monitor is still starting up. Try again in a minute.');
      return true;
    }
    // Run a fresh scan first
    await deps.orphanReaper.scan();
    const result = deps.orphanReaper.killAllExternal();
    if (result.killed === 0) {
      await send('No external Claude processes found to clean up. Everything looks good.');
    } else {
      await send(`Cleaned up ${result.killed} external Claude process${result.killed === 1 ? '' : 'es'}, freeing ~${result.freedMB}MB of memory.`);
    }
    return true;
  }

  if (cmd === 'restart') {
    // Request a graceful server restart — write to state/ subdirectory where
    // the supervisor and ForegroundRestartWatcher poll for it.
    const restartFile = path.join(deps.config.stateDir, 'state', 'restart-requested.json');
    fs.writeFileSync(restartFile, JSON.stringify({
      requestedAt: new Date().toISOString(),
      reason: 'User requested restart via Agent Attention fix command',
      requestedBy: 'fix-command',
    }));
    await send('Restart requested. Your agent will restart momentarily.');
    return true;
  }

  if (cmd === 'restart sessions') {
    const running = deps.sessionManager.listRunningSessions();
    const stale = running.filter(s => !deps.sessionManager.isSessionAlive(s.tmuxSession));
    if (stale.length === 0) {
      await send(`All ${running.length} session${running.length === 1 ? ' is' : 's are'} running normally. No action needed.`);
    } else {
      for (const s of stale) {
        try {
          deps.sessionManager.killSession(s.tmuxSession);
        } catch { /* best effort */ }
      }
      await send(`Found ${stale.length} stuck session${stale.length === 1 ? '' : 's'} and cleaned ${stale.length === 1 ? 'it' : 'them'} up. New sessions will start fresh when needed.`);
    }
    return true;
  }

  if (cmd === 'fix lifeline') {
    // Lifeline is managed by the separate lifeline process, not the server.
    // Best we can do is suggest the right command.
    await send('The lifeline runs separately from the main server. Head over to the Lifeline topic and say "restart" — it will reset everything and bring the server back up.');
    return true;
  }

  if (cmd === 'fix output') {
    if (!deps.coherenceMonitor) {
      await send('The coherence monitor is still starting up. Try again in a minute.');
      return true;
    }
    const report = deps.coherenceMonitor.runCheck();
    const outputCheck = report.checks.find(c => c.name === 'output-sanity');
    if (!outputCheck || outputCheck.passed) {
      await send('Output check passed — no bad patterns found in recent messages. The earlier issue may have resolved itself.');
    } else {
      await send(`Output check still showing issues — your agent is including internal links in messages that users can't access. Your agent should be using your public domain instead. This will be flagged to your agent in its next session.`);
    }
    return true;
  }

  // Not a recognized fix command
  return false;
}

interface StartOptions {
  foreground?: boolean;
  dir?: string;
  /** When false, skip Telegram polling (used when lifeline owns the Telegram connection).
   *  Commander maps --no-telegram to telegram: false. */
  telegram?: boolean;
}

/**
 * Check if autostart is installed for this project.
 * Extracted from the CLI `autostart status` handler for programmatic use.
 */
function isAutostartInstalled(projectName: string): boolean {
  if (process.platform === 'darwin') {
    const label = `ai.instar.${projectName}`;
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    return fs.existsSync(plistPath);
  } else if (process.platform === 'linux') {
    const serviceName = `instar-${projectName}.service`;
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', serviceName);
    return fs.existsSync(servicePath);
  }
  return false;
}

/**
 * Spawn a session for a topic with full conversational context.
 * Shared by both auto-spawn (new topic) and respawn (dead session) paths.
 *
 * Context loading priority (when TopicMemory is available):
 *   1. Rolling conversation summary (captures full history)
 *   2. Recent messages (last 30 — the immediate context)
 *   3. Search instructions (so agent can query deeper history)
 *
 * Fallback: JSONL-based last 20 messages (when TopicMemory unavailable).
 *
 * Returns the new tmux session name.
 */
// Module-level reference so spawnSessionForTopic can trigger orphan cleanup under memory pressure.
// Set once the reaper is initialized in startServer().
let _orphanReaper: import('../monitoring/OrphanProcessReaper.js').OrphanProcessReaper | null = null;
let _memoryMonitor: import('../monitoring/MemoryPressureMonitor.js').MemoryPressureMonitor | null = null;
let _fixDeps: FixCommandDeps | null = null;

// Module-level reference for session resume mapping.
// Set once in startServer() and used by spawnSessionForTopic/respawnSessionForTopic.
let _topicResumeMap: import('../core/TopicResumeMap.js').TopicResumeMap | null = null;
let _projectDir: string = process.cwd();
let _sharedIntelligence: import('../core/types.js').IntelligenceProvider | null = null;
let _selfKnowledgeTree: SelfKnowledgeTree | null = null;
let _slackAdapter: import('../messaging/slack/SlackAdapter.js').SlackAdapter | null = null;

async function spawnSessionForTopic(
  sessionManager: SessionManager,
  telegram: TelegramAdapter,
  sessionName: string,
  topicId: number,
  latestMessage?: string,
  topicMemory?: TopicMemory,
  userProfile?: UserProfile,
): Promise<string> {
  const msg = latestMessage || 'Session started — send a message to continue.';

  // If memory is elevated/critical and we have the reaper, try to free memory
  // by cleaning orphans before spawning. Interactive sessions are NEVER blocked
  // (the user must always be able to interact), but we clean up first.
  if (_memoryMonitor && _orphanReaper) {
    const memState = _memoryMonitor.getState();
    if (memState.state === 'elevated' || memState.state === 'critical') {
      console.log(`[spawnSessionForTopic] Memory ${memState.state} (${memState.pressurePercent.toFixed(1)}%) — triggering orphan cleanup before spawn`);
      try {
        await _orphanReaper.scan();
      } catch (err) {
        console.error('[spawnSessionForTopic] Orphan cleanup failed:', err);
      }
    }
  }

  let contextContent: string = '';

  // Prefer TopicMemory (SQLite-backed, with summaries) over raw JSONL scan
  let usedFallback = false;
  if (topicMemory?.isReady()) {
    try {
      contextContent = topicMemory.formatContextForSession(topicId, 50);
    } catch (err) {
      // @silent-fallback-ok — TopicMemory format, JSONL fallback
      console.error(`[telegram→session] TopicMemory context failed, falling back to JSONL:`, err);
    }
  }

  // Fallback to JSONL-based history — this means TopicMemory is broken
  if (!contextContent) {
    usedFallback = true;
    try {
      const history = telegram.getTopicHistory(topicId, 50);
      if (history.length > 0) {
        const lines: string[] = [];
        lines.push(`--- Thread History (last ${history.length} messages) ---`);
        lines.push(`IMPORTANT: Read this history carefully before taking any action.`);
        lines.push(`Your task is to continue THIS conversation, not start something new.`);
        const topicName = telegram.getTopicName?.(topicId);
        if (topicName) {
          lines.push(`Topic: ${topicName}`);
        }
        lines.push(``);
        for (const m of history) {
          // Use actual sender name if available (multi-user topics), fall back to generic
          const sender = m.fromUser
            ? (m.senderName || 'User')
            : 'Agent';
          const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
          const text = (m.text || '').slice(0, 2000);
          lines.push(`[${ts}] ${sender}: ${text}`);
        }
        lines.push(``);
        lines.push(`--- End Thread History ---`);
        contextContent = lines.join('\n');
      }
    } catch (err) {
      console.error(`[telegram→session] Failed to fetch thread history:`, err);
    }
  }

  // Report degradation if fallback was used and TopicMemory should have been available
  if (usedFallback && topicMemory !== undefined) {
    DegradationReporter.getInstance().report({
      feature: 'TopicMemory.formatContextForSession',
      primary: 'SQLite-backed context with summaries and search',
      fallback: 'JSONL-based last 20 messages (no summaries, no search)',
      reason: topicMemory.isReady()
        ? `TopicMemory returned empty context for topic ${topicId} (possible data gap)`
        : `TopicMemory database not open (init failure)`,
      impact: `Session for topic ${topicId} started with degraded context — no summaries, limited history.`,
    });
  }

  // ── Agent Self-Knowledge Injection ──────────────────────────────
  // If the self-knowledge tree is loaded, inject a compact agent identity
  // snapshot into the bootstrap. This gives the session awareness of
  // WHO the agent is — name, description, capabilities, autonomy level.
  let agentContextBlock = '';
  if (_selfKnowledgeTree) {
    try {
      const { ContextSnapshotBuilder } = await import('../core/ContextSnapshotBuilder.js');
      const snapshotBuilder = new ContextSnapshotBuilder({
        projectName: _selfKnowledgeTree.getConfig()?.agentName || '',
        projectDir: _projectDir,
        stateDir: path.join(_projectDir, '.instar'),
      }, { detailLevel: 'concise' });
      agentContextBlock = `--- Agent Identity ---\n${snapshotBuilder.renderForPrompt()}\n--- End Agent Identity ---`;
    } catch {
      // @silent-fallback-ok — agent context non-critical
    }
  }

  // ── User Context Injection (Gap 8) ──────────────────────────────
  // If we have a resolved UserProfile with meaningful context, format it
  // for injection into the bootstrap message. This gives the agent awareness
  // of who it's talking to: permissions, preferences, relationship history.
  let userContextBlock = '';
  if (userProfile && hasUserContext(userProfile)) {
    userContextBlock = formatUserContextForSession(userProfile);
  }

  // Build the bootstrap message with inline context.
  // CRITICAL: Context must be BEFORE the user's message and inline (not a file reference).
  // Previous approach used a parenthetical file reference after the user's message:
  //   "[telegram:N] Hello (Thread history at /path — read it)"
  // This failed because Claude's attention goes to the user's greeting, generates a
  // generic response, and never reads the file. The context instruction was structurally
  // too weak — a skippable parenthetical, not a command.
  //
  // Fix: Inline the context directly, put it BEFORE the user's message, with strong
  // continuation framing. Claude processes the context first, then responds to the
  // user's message WITH that context loaded.
  const tmpDir = '/tmp/instar-telegram';
  fs.mkdirSync(tmpDir, { recursive: true });

  let bootstrapMessage: string;

  if (contextContent) {
    // Also write full context to file for deeper lookup if needed
    const filepath = path.join(tmpDir, `history-${topicId}-${Date.now()}-${process.pid}.txt`);
    fs.writeFileSync(filepath, contextContent);

    // Inject the FULL context inline — no truncation.
    // Claude handles context management via compaction. Pre-truncating strips
    // recent messages and makes resumed sessions feel like they lost memory.
    // The session should feel like it never stopped.
    const inlineContext = contextContent;

    const parts = [
      `CONTINUATION — You are resuming an EXISTING conversation. Read the context below before responding.`,
      ``,
    ];

    // Agent identity comes FIRST — the agent needs to know WHO IT IS.
    if (agentContextBlock) {
      parts.push(agentContextBlock);
      parts.push(``);
    }

    // User context comes SECOND — before conversation history.
    // The agent needs to know WHO it's talking to before reading WHAT was said.
    if (userContextBlock) {
      parts.push(userContextBlock);
      parts.push(``);
    }

    parts.push(
      inlineContext,
      ``,
      `IMPORTANT: Your response MUST acknowledge and continue the conversation above. Do NOT introduce yourself or ask "how can I help" — the user has been talking to you. Pick up where the conversation left off.`,
      ``,
      `The user's latest message:`,
      `[telegram:${topicId}] ${msg}`,
    );

    bootstrapMessage = parts.join('\n');
  } else {
    // No conversation history — new session.
    // Still inject agent + user context if available.
    const newSessionParts: string[] = [];
    if (agentContextBlock) {
      newSessionParts.push(agentContextBlock);
      newSessionParts.push(``);
    }
    if (userContextBlock) {
      newSessionParts.push(userContextBlock);
      newSessionParts.push(``);
    }
    newSessionParts.push(`[telegram:${topicId}] ${msg}`);

    if (newSessionParts.length > 1) {
      bootstrapMessage = newSessionParts.join('\n');
    } else {
      bootstrapMessage = `[telegram:${topicId}] ${msg}`;
    }
  }

  // Large bootstrap messages (e.g. CONTINUATION context with full thread history)
  // can exceed tmux send-keys limits. Write to a temp file and inject a reference,
  // same pattern as injectTelegramMessage's FILE_THRESHOLD.
  const BOOTSTRAP_FILE_THRESHOLD = 500;
  if (bootstrapMessage.length > BOOTSTRAP_FILE_THRESHOLD) {
    const bootstrapFilename = `bootstrap-${topicId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`;
    const bootstrapFilepath = path.join(tmpDir, bootstrapFilename);
    fs.writeFileSync(bootstrapFilepath, bootstrapMessage);
    console.log(`[spawnSessionForTopic] Bootstrap message too large (${bootstrapMessage.length} chars), wrote to ${bootstrapFilepath}`);
    bootstrapMessage = `[IMPORTANT: Read ${bootstrapFilepath} — it contains your full session context, conversation history, and the user's latest message. You MUST read this file before responding.]`;
  }

  // Check for a resume UUID from a previously-killed session on this topic.
  // TopicResumeMap is authoritative — it saved the UUID for this specific topic at kill time
  // or via the refresh heartbeat. Skip LLM validation (which was failing due to JSONL sampling
  // issues and is redundant for an authoritative source).
  let resumeSessionId = _topicResumeMap?.get(topicId) ?? undefined;
  if (resumeSessionId) {
    console.log(`[spawnSessionForTopic] Found resume UUID for topic ${topicId}: ${resumeSessionId} (source: TopicResumeMap — trusted)`);
  }

  const newSessionName = await sessionManager.spawnInteractiveSession(bootstrapMessage, sessionName, { telegramTopicId: topicId, resumeSessionId });

  // Clear the resume entry after successful spawn to prevent stale reuse
  if (resumeSessionId) {
    _topicResumeMap?.remove(topicId);
  }

  // Proactive UUID save — schedule discovery after spawn.
  // ONLY uses authoritative claudeSessionId from hook events.
  // Never falls back to mtime-based JSONL scan — that can pick up a UUID from
  // a different topic's session when multiple sessions are running concurrently.
  // The heartbeat (refreshResumeMappings) has a proper single-session guard and
  // will safely fill in the mapping within 60s if hooks haven't fired yet.
  if (_topicResumeMap) {
    setTimeout(() => {
      try {
        const sessions = sessionManager.listRunningSessions();
        const session = sessions.find(s => s.tmuxSession === newSessionName);
        if (session?.claudeSessionId) {
          _topicResumeMap!.save(topicId, session.claudeSessionId, newSessionName);
          console.log(`[spawnSessionForTopic] Proactive UUID save: ${session.claudeSessionId} for topic ${topicId} (source: hook)`);
        }
      } catch (err) {
        console.error(`[spawnSessionForTopic] Proactive UUID save failed:`, err);
      }
    }, 8000);
  }

  return newSessionName;
}

/**
 * Respawn a session for a topic, including thread history in the bootstrap.
 * This prevents "thread drift" where respawned sessions lose context.
 */
async function respawnSessionForTopic(
  sessionManager: SessionManager,
  telegram: TelegramAdapter,
  targetSession: string,
  topicId: number,
  latestMessage?: string,
  topicMemory?: TopicMemory,
  userProfile?: UserProfile,
  recoveryPrompt?: string,
  options?: { silent?: boolean },
): Promise<void> {
  console.log(`[telegram→session] Session "${targetSession}" needs respawn for topic ${topicId}`);

  // Save the old session's Claude UUID before respawning so --resume can reattach context
  if (_topicResumeMap) {
    try {
      const uuid = _topicResumeMap.findUuidForSession(targetSession);
      if (uuid) {
        _topicResumeMap.save(topicId, uuid, targetSession);
        console.log(`[telegram→session] Saved resume UUID ${uuid} for topic ${topicId}`);
      }
    } catch (err) {
      console.error(`[telegram→session] Failed to save resume UUID:`, err);
    }
  }

  let storedName = telegram.getTopicName(topicId);
  // If the name is unknown, try to resolve it from Telegram before falling back
  if (!storedName || /^topic-\d+$/.test(storedName)) {
    const resolved = await telegram.resolveTopicName(topicId);
    if (resolved) storedName = resolved;
  }
  // Use topic name, not tmux session name — tmux names include the project prefix
  // which causes cascading names like ai-guy-ai-guy-ai-guy-topic-1 on each respawn.
  const topicName = storedName || `topic-${topicId}`;

  // If this is a recovery respawn, prepend the recovery context to the message
  // so the session knows what happened and can avoid repeating the failure.
  const effectiveMessage = recoveryPrompt
    ? `${recoveryPrompt}\n\n${latestMessage || 'Session recovered — continue where you left off.'}`
    : latestMessage;

  const newSessionName = await spawnSessionForTopic(sessionManager, telegram, topicName, topicId, effectiveMessage, topicMemory, userProfile);

  telegram.registerTopicSession(topicId, newSessionName, topicName);
  if (!options?.silent) {
    await telegram.sendToTopic(topicId, `Session respawned.`);
  }
  console.log(`[telegram→session] Respawned "${newSessionName}" for topic ${topicId}`);
}

/**
 * Wire up Telegram session management callbacks.
 * These enable /interrupt, /restart, /sessions commands and stall detection.
 */
function wireTelegramCallbacks(
  telegram: TelegramAdapter,
  sessionManager: SessionManager,
  state: StateManager,
  quotaTracker?: QuotaTracker,
  accountSwitcher?: AccountSwitcher,
  claudePath?: string,
  topicMemory?: TopicMemory,
): void {
  // /interrupt — send Escape key to a tmux session
  telegram.onInterruptSession = async (sessionName: string): Promise<boolean> => {
    try {
      execFileSync(detectTmuxPath()!, ['send-keys', '-t', `=${sessionName}:`, 'Escape'], {
        encoding: 'utf-8', timeout: 5000,
      });
      return true;
    } catch {
      // @silent-fallback-ok — interrupt boolean return
      return false;
    }
  };

  // /restart — kill session and respawn
  telegram.onRestartSession = async (sessionName: string, topicId: number): Promise<void> => {
    // Save resume UUID before killing so the new session can --resume
    if (_topicResumeMap) {
      try {
        const uuid = _topicResumeMap.findUuidForSession(sessionName);
        if (uuid) {
          _topicResumeMap.save(topicId, uuid, sessionName);
        }
      } catch { /* best effort */ }
    }

    // Kill existing session
    try {
      execFileSync(detectTmuxPath()!, ['kill-session', '-t', `=${sessionName}`], { stdio: 'ignore' });
    } catch { /* may already be dead */ }

    // Respawn with thread history
    await respawnSessionForTopic(sessionManager, telegram, sessionName, topicId, undefined, topicMemory);
  };

  // /sessions — list running sessions
  telegram.onListSessions = () => {
    const sessions = state.listSessions({ status: 'running' });
    return sessions.map(s => ({
      name: s.name,
      tmuxSession: s.tmuxSession,
      status: s.status,
      alive: sessionManager.isSessionAlive(s.tmuxSession),
    }));
  };

  // Stall detection — check if a session is alive
  telegram.onIsSessionAlive = (sessionName: string): boolean => {
    return sessionManager.isSessionAlive(sessionName);
  };

  // Stall verification — check if session has recent output activity
  telegram.onIsSessionActive = async (sessionName: string): Promise<boolean> => {
    const output = sessionManager.captureOutput(sessionName, 20);
    if (!output) return false;

    const lines = output.trim().split('\n').slice(-15);
    // Look for signs of Claude Code activity in recent output
    const activePatterns = [
      /\bRead\b|\bWrite\b|\bEdit\b|\bBash\b|\bGrep\b|\bGlob\b/,  // Tool names
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,  // Spinner characters
      /\d+\s*tokens?/i,     // Token counts
      /Sent \d+ chars/,     // Telegram reply confirmation
    ];

    for (const line of lines) {
      for (const pattern of activePatterns) {
        if (pattern.test(line)) return true;
      }
    }
    return false;
  };

  // /switch-account — swap active Claude Code account
  if (accountSwitcher) {
    telegram.onSwitchAccountRequest = async (target: string, replyTopicId: number): Promise<void> => {
      try {
        const result = await accountSwitcher.switchAccount(target);
        await telegram.sendToTopic(replyTopicId, result.message);
      } catch (err) {
        console.error(`[telegram] Account switch failed:`, err);
        await telegram.sendToTopic(replyTopicId, 'Account switch didn\'t work. There may be an issue with the target account — try again or check /quota for current status.');
      }
    };
  }

  // /quota — show quota status
  if (quotaTracker) {
    telegram.onQuotaStatusRequest = async (replyTopicId: number): Promise<void> => {
      try {
        const quotaState = quotaTracker.getState();
        if (!quotaState) {
          await telegram.sendToTopic(replyTopicId, 'No quota data available.');
          return;
        }
        const recommendation = quotaTracker.getRecommendation();
        const lines = [
          `Weekly: ${quotaState.usagePercent}%`,
          quotaState.fiveHourPercent != null ? `5-Hour: ${quotaState.fiveHourPercent}%` : null,
          `Recommendation: ${recommendation}`,
          `Last updated: ${quotaState.lastUpdated}`,
        ].filter(Boolean);

        // Add account info if available
        if (accountSwitcher) {
          const statuses = accountSwitcher.getAccountStatuses();
          if (statuses.length > 0) {
            lines.push('', 'Accounts:');
            for (const s of statuses) {
              const marker = s.isActive ? '→ ' : '  ';
              const stale = s.isStale ? ' (stale)' : '';
              const expired = s.tokenExpired ? ' (token expired)' : '';
              lines.push(`${marker}${s.name || s.email}: ${s.weeklyPercent}%${stale}${expired}`);
            }
          }
        }

        await telegram.sendToTopic(replyTopicId, lines.join('\n'));
      } catch (err) {
        console.error(`[telegram] Quota check failed:`, err);
        await telegram.sendToTopic(replyTopicId, 'Couldn\'t check quota right now. The usage tracking service may be temporarily unavailable.');
      }
    };
  }

  // Classify session deaths for quota-aware stall detection
  telegram.onClassifySessionDeath = async (sessionName: string): Promise<{ cause: string; detail: string } | null> => {
    try {
      const output = sessionManager.captureOutput(sessionName, 100);
      if (!output) return null;

      const quotaState = quotaTracker?.getState() ?? null;
      const classification = classifySessionDeath(output, quotaState);
      return { cause: classification.cause, detail: classification.detail };
    } catch {
      // @silent-fallback-ok — classify death returns null
      return null;
    }
  };

  // /login — seamless OAuth login flow
  telegram.onLoginRequest = async (email: string | null, replyTopicId: number): Promise<void> => {
    const tmuxPath = detectTmuxPath();
    if (!tmuxPath) {
      await telegram.sendToTopic(replyTopicId, 'Login isn\'t available right now — a required system component is missing. This needs to be set up on the server side.');
      return;
    }

    const loginSession = 'instar-login-flow';

    try {
      // Kill any existing login session
      try {
        execFileSync(tmuxPath, ['kill-session', '-t', `=${loginSession}`], { stdio: 'ignore' });
      } catch { /* @silent-fallback-ok — kill login session, may be dead */ }

      // Start login command in tmux
      const cliPath = claudePath || 'claude';
      const loginCmd = email
        ? `${cliPath} auth login --email "${email}"`
        : `${cliPath} auth login`;

      execFileSync(tmuxPath, ['new-session', '-d', '-s', loginSession, loginCmd], {
        timeout: 10000,
      });

      await telegram.sendToTopic(replyTopicId, `Login flow started${email ? ` for ${email}` : ''}. Watching for OAuth URL...`);

      // Poll for OAuth URL (up to 15 seconds)
      let oauthUrl: string | null = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const output = sessionManager.captureOutput(loginSession, 50) || '';
          const urlMatch = output.match(/https:\/\/[^\s]+auth[^\s]*/i)
            || output.match(/https:\/\/[^\s]+login[^\s]*/i)
            || output.match(/https:\/\/[^\s]+oauth[^\s]*/i)
            || output.match(/https:\/\/console\.anthropic\.com[^\s]*/i);
          if (urlMatch) {
            oauthUrl = urlMatch[0];
            break;
          }
        } catch { /* retry */ }
      }

      if (!oauthUrl) {
        await telegram.sendToTopic(replyTopicId, 'Could not detect OAuth URL. Check the login session manually.');
        return;
      }

      await telegram.sendToTopic(replyTopicId, `Open this URL to authenticate:\n\n${oauthUrl}\n\nI'll detect when you're done.`);

      // Poll for auth completion (up to 5 minutes)
      let authComplete = false;
      for (let i = 0; i < 300; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const output = sessionManager.captureOutput(loginSession, 30) || '';
          const lower = output.toLowerCase();

          if (lower.includes('successfully') || lower.includes('authenticated') || lower.includes('logged in')) {
            authComplete = true;
            break;
          }

          // Detect "press Enter to continue" prompt
          if (lower.includes('press enter') || lower.includes('press any key')) {
            execFileSync(tmuxPath, ['send-keys', '-t', `=${loginSession}:`, 'Enter'], { timeout: 5000 });
            await new Promise(r => setTimeout(r, 2000));

            // Check if that completed it
            const finalOutput = sessionManager.captureOutput(loginSession, 30) || '';
            if (finalOutput.toLowerCase().includes('successfully') || finalOutput.toLowerCase().includes('authenticated')) {
              authComplete = true;
            }
            break;
          }
        } catch { /* retry */ }
      }

      // Clean up
      try {
        execFileSync(tmuxPath, ['kill-session', '-t', `=${loginSession}`], { stdio: 'ignore' });
      } catch { /* already ended */ }

      if (authComplete) {
        await telegram.sendToTopic(replyTopicId, 'Authentication successful! New sessions will use this account.');
      } else {
        await telegram.sendToTopic(replyTopicId, 'Login flow ended, but I couldn\'t confirm it completed successfully. Try sending a message to test if the new account is working.');
      }
    } catch (err) {
      // Clean up on error
      try {
        execFileSync(tmuxPath, ['kill-session', '-t', `=${loginSession}`], { stdio: 'ignore' });
      } catch { /* ignore */ }
      console.error(`[telegram] Login failed:`, err);
      await telegram.sendToTopic(replyTopicId, 'Login didn\'t complete successfully. Try again, or if this keeps happening, the authentication service may be down.');
    }
  };
}

/**
 * Wire up Telegram message routing: topic messages → Claude sessions.
 * This is the core handler that makes Telegram topics work like sessions.
 */
/**
 * Convert a loosely-typed Message (from core/types.ts) to a typed PipelineMessage.
 * This is the bridge between TelegramAdapter's existing Message format and
 * the new typed pipeline contracts. The types enforce that sender identity,
 * topic context, and message content are all present and accounted for.
 */
function messageToPipeline(msg: Message, topicName?: string): PipelineMessage {
  return {
    id: msg.id,
    sender: {
      telegramUserId: (msg.metadata?.telegramUserId as number) ?? 0,
      firstName: (msg.metadata?.firstName as string) ?? 'Unknown',
      username: (msg.metadata?.username as string) ?? undefined,
    },
    topicId: (msg.metadata?.messageThreadId as number) ?? 1,
    topicName,
    content: msg.content,
    type: msg.content.startsWith('[voice]') ? 'voice'
      : msg.content.startsWith('[image:') ? 'photo'
      : msg.content.startsWith('[document:') ? 'document'
      : 'text',
    timestamp: msg.receivedAt,
  };
}

function wireTelegramRouting(
  telegram: TelegramAdapter,
  sessionManager: SessionManager,
  quotaTracker?: QuotaTracker,
  topicMemory?: TopicMemory,
  userManager?: UserManager,
  fixCommandHandler?: (topicId: number, text: string) => Promise<boolean>,
): void {
  // Guard: tracks which topic IDs have a spawn in progress.
  // Prevents duplicate concurrent spawns for the same topic when messages
  // arrive faster than the async spawn completes.
  const spawningTopics = new Set<number>();

  telegram.onTopicMessage = async (msg: Message) => {
    const topicId = (msg.metadata?.messageThreadId as number) ?? null;
    if (!topicId) return;

    const text = msg.content;

    // Resolve user profile for context injection (Gap 8)
    const telegramUserId = (msg.metadata?.telegramUserId as number) ?? 0;
    const resolvedUser = telegramUserId && userManager
      ? userManager.resolveFromTelegramUserId(telegramUserId)
      : null;

    // Most commands are handled inside TelegramAdapter.handleCommand().
    // /new — create a new topic thread. Does NOT spawn a session immediately.
    // Sessions are spawned on-demand when the user sends their first real message
    // in the new topic (via the auto-spawn path below). This avoids premature
    // session exit: spawning with a meta-message ("new session started") gives
    // Claude nothing real to do, so it responds and exits. The user's actual
    // message then arrives to a dead session.
    const newMatch = text.match(/^\/new(?:\s+(.+))?$/);
    if (newMatch) {
      const sessionName = newMatch[1]?.trim() || null;
      const topicName = sessionName || `session-${new Date().toISOString().slice(5, 16).replace('T', '-').replace(':', '')}`;
      const topicEmoji = sessionName ? selectTopicEmoji(sessionName) : TOPIC_STYLE.SESSION.emoji;
      const topicDisplayName = `${topicEmoji} ${topicName}`;

      (async () => {
        try {
          const topic = await telegram.findOrCreateForumTopic(topicDisplayName, TOPIC_STYLE.SESSION.color);
          // Don't create a session — findOrCreateForumTopic already stored the topic name.
          // The first message in this topic will trigger auto-spawn with real content.
          await telegram.sendToTopic(topic.topicId, `Ready — send your first message to start.`);
          await telegram.sendToTopic(topicId, `Created topic "${topicName}" — head over there.`);
          console.log(`[telegram] Created topic "${topicName}" (${topic.topicId}) — session will spawn on first message`);
        } catch (err) {
          console.error(`[telegram] /new failed:`, err);
          await telegram.sendToTopic(topicId, 'Couldn\'t create the topic. Try again in a moment.').catch(() => {});
        }
      })();
      return;
    }

    // ── Fix commands from notification messages ──────────────────────
    // Handle "fix auth", "clean processes", "restart", etc. directly
    // in the server process — no need to spawn a Claude session for these.
    if (fixCommandHandler) {
      const cmdText = text.trim().toLowerCase();
      const isFixCommand = cmdText.startsWith('fix ') || cmdText.startsWith('clean ') ||
        cmdText.startsWith('restart') || cmdText === 'fix' || cmdText === 'clean';
      if (isFixCommand) {
        (async () => {
          try {
            const handled = await fixCommandHandler(topicId, text);
            if (!handled) {
              // Not a recognized fix command — fall through to session routing
              // Re-trigger the normal routing by calling the topic message handler again
              // Actually, since we can't re-trigger, just send a help message
              await telegram.sendToTopic(topicId,
                `I didn't recognize that command. Available fix commands:\n` +
                `• "fix auth" — Generate an API security token\n` +
                `• "fix lifeline" — Restart the crash-recovery system\n` +
                `• "fix shadow" — Remove shadow installation\n` +
                `• "clean processes" — Kill external Claude processes\n` +
                `• "restart" — Restart the server\n` +
                `• "restart sessions" — Restart stuck sessions`
              );
            }
          } catch (err) {
            console.error(`[telegram] Fix command error:`, err);
            await telegram.sendToTopic(topicId,
              `Something went wrong while trying to fix that: ${err instanceof Error ? err.message : String(err)}`
            ).catch(() => {});
          }
        })();
        return;
      }
    }

    // ── Pipeline-typed routing ──────────────────────────────────────
    // Convert to PipelineMessage — types enforce that sender identity
    // and topic context are present at every stage downstream.
    const storedTopicName = telegram.getTopicName(topicId) || undefined;
    const pipeline = messageToPipeline(msg, storedTopicName);

    // Route message to corresponding session
    const targetSession = telegram.getSessionForTopic(topicId);

    if (targetSession) {
      // Session is mapped — check if it's alive, inject or respawn
      if (sessionManager.isSessionAlive(targetSession)) {
        // Use toInjection() — types guarantee sender identity is included in the tag
        const injection = toInjection(pipeline, targetSession);
        console.log(`[telegram→session] Injecting into ${targetSession}: "${text.slice(0, 80)}"`);
        sessionManager.injectTelegramMessage(
          targetSession, topicId, text, pipeline.topicName, pipeline.sender.firstName, pipeline.sender.telegramUserId,
        );
        // Delivery confirmation — only when WE own polling. When lifeline owns
        // polling (--no-telegram / standby), it already sends its own confirmation.
        if (telegram.isPolling) {
          telegram.sendToTopic(topicId, `✓ Delivered`).catch(() => {});
        }
        // Track for stall detection
        telegram.trackMessageInjection(topicId, targetSession, text);
      } else {
        // Session died — classify death cause before deciding how to respawn
        let isQuotaDeath = false;
        let isContextExhausted = false;
        try {
          const output = sessionManager.captureOutput(targetSession, 100);
          if (output) {
            const quotaState = quotaTracker?.getState() ?? null;
            const classification = classifySessionDeath(output, quotaState);
            if (classification.cause === 'quota_exhaustion' && classification.confidence !== 'low') {
              isQuotaDeath = true;
              telegram.sendToTopic(topicId,
                `🔴 Session died — quota limit reached.\n${classification.detail}\n\n` +
                `Use /switch-account to switch, /login to add an account, or reply again to force restart.`
              ).catch(() => {});
            } else if (classification.cause === 'context_exhausted') {
              isContextExhausted = true;
              telegram.sendToTopic(topicId,
                `🔄 Conversation got too long — starting a fresh session with your recent history.`
              ).catch(() => {});
            }
          }
        } catch { /* classification failed — fall through to respawn */ }

        if (isContextExhausted) {
          // Context exhaustion: respawn FRESH (no --resume) — the old conversation
          // is too large to continue. The respawn path will load telegram thread
          // history as context, giving the new session continuity.
          if (spawningTopics.has(topicId)) {
            console.log(`[telegram→session] Spawn already in progress for topic ${topicId} — skipping duplicate respawn`);
            return;
          }
          spawningTopics.add(topicId);
          // Remove the resume UUID so respawnSessionForTopic doesn't try --resume
          if (_topicResumeMap) {
            _topicResumeMap.remove(topicId);
          }
          respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, text, topicMemory, resolvedUser ?? undefined)
            .catch(err => {
              console.error(`[telegram→session] Context exhaustion respawn failed:`, err);
              telegram.sendToTopic(topicId, `❌ Fresh session restart failed. Try sending your message again.`).catch(() => {});
            })
            .finally(() => {
              spawningTopics.delete(topicId);
            });
        } else if (!isQuotaDeath) {
          // Guard: skip respawn if one is already in progress for this topic.
          // Prevents the infinite respawn loop: dead session + rapid messages → each
          // message triggers a new respawn → multiple concurrent spawns → chaos.
          if (spawningTopics.has(topicId)) {
            console.log(`[telegram→session] Spawn already in progress for topic ${topicId} — skipping duplicate respawn`);
            return;
          }
          spawningTopics.add(topicId);
          telegram.sendToTopic(topicId, `🔄 Session restarting — message queued.`).catch(() => {});
          respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, text, topicMemory, resolvedUser ?? undefined)
            .catch(err => {
              console.error(`[telegram→session] Respawn failed:`, err);
              const errMsg = err instanceof Error ? err.message : String(err);
              const userMsg = errMsg.includes('session limit') || errMsg.includes('limit')
                ? `❌ Session restart failed — session limit reached. Close an existing session or increase maxSessions in your config, then try again.`
                : `❌ Session restart failed. Try sending your message again in a moment.`;
              telegram.sendToTopic(topicId, userMsg).catch(() => {});
            })
            .finally(() => {
              spawningTopics.delete(topicId);
            });
        }
      }
    } else {
      // No session mapped — auto-spawn with topic history (same as respawn path).
      // Without history, the agent has no conversational context and gives blind answers.
      console.log(`[telegram→session] No session for topic ${topicId}, auto-spawning with history...`);

      // Guard: skip spawn if one is already in progress for this topic.
      if (spawningTopics.has(topicId)) {
        telegram.sendToTopic(topicId, `Session is still starting up — please wait a moment.`).catch(() => {});
        console.log(`[telegram→session] Spawn already in progress for topic ${topicId} — skipping duplicate`);
        return;
      }

      spawningTopics.add(topicId);

      // Resolve topic name — try in-memory, then active probe, then fallback
      let spawnName = storedTopicName;
      if (!spawnName || /^topic-\d+$/.test(spawnName)) {
        const resolved = await telegram.resolveTopicName(topicId);
        if (resolved) spawnName = resolved;
      }
      if (!spawnName) spawnName = `topic-${topicId}`;

      // Use the shared spawn helper that includes topic history + user context
      spawnSessionForTopic(sessionManager, telegram, spawnName, topicId, text, topicMemory, resolvedUser ?? undefined).then((newSessionName) => {
        telegram.registerTopicSession(topicId, newSessionName, spawnName);
        telegram.sendToTopic(topicId, `Session starting up — reading your message now. One moment.`).catch(() => {});
        console.log(`[telegram→session] Auto-spawned "${newSessionName}" for topic ${topicId}`);
      }).catch((err) => {
        console.error(`[telegram→session] Auto-spawn failed:`, err);
        const errMsg = err instanceof Error ? err.message : String(err);
        const userMsg = errMsg.includes('session limit') || errMsg.includes('limit')
          ? `❌ Unable to start session — session limit reached. Close an existing session or increase maxSessions in your config, then try again.`
          : 'Having trouble starting a session right now. Try sending your message again in a moment.';
        telegram.sendToTopic(topicId, userMsg).catch(() => {});
      }).finally(() => {
        spawningTopics.delete(topicId);
      });
    }
  };
}

/**
 * Wire WhatsApp message routing: incoming messages → Claude sessions.
 *
 * Similar to wireTelegramRouting but for WhatsApp JIDs instead of Telegram topics.
 * Maps JIDs to sessions, spawns new sessions for new conversations,
 * injects messages into existing sessions, and handles respawning.
 */
function wireWhatsAppRouting(
  whatsapp: import('../messaging/WhatsAppAdapter.js').WhatsAppAdapter,
  sessionManager: SessionManager,
): void {
  whatsapp.onMessage(async (msg) => {
    const jid = msg.channel?.identifier;
    if (!jid) return;

    const text = msg.content;
    const senderName = (msg.metadata?.senderName as string) ?? undefined;

    // Check for existing session
    const targetSession = whatsapp.getSessionForChannel(jid);

    if (targetSession) {
      // Session exists — check if alive
      if (sessionManager.isSessionAlive(targetSession)) {
        console.log(`[whatsapp→session] Injecting into ${targetSession}: "${text.slice(0, 80)}"`);
        sessionManager.injectWhatsAppMessage(targetSession, jid, text, senderName);
      } else {
        // Session died — respawn
        console.log(`[whatsapp→session] Session "${targetSession}" died, respawning...`);
        try {
          const replyInstruction = `(IMPORTANT: Relay all responses back via: cat <<'EOF' | .instar/scripts/whatsapp-reply.sh ${jid}\nYour response\nEOF)`;
          const bootstrap = `[whatsapp:${jid}] ${text} ${replyInstruction}`;
          const sessionName = `wa-${jid.split('@')[0].slice(-6)}`;
          const newSession = await sessionManager.spawnInteractiveSession(bootstrap, sessionName);
          whatsapp.registerSession(jid, newSession);
          console.log(`[whatsapp→session] Respawned "${newSession}" for ${jid}`);
        } catch (err) { // @silent-fallback-ok — matches Telegram respawn pattern
          console.error(`[whatsapp→session] Respawn failed:`, err);
        }
      }
    } else {
      // No session — auto-spawn
      console.log(`[whatsapp→session] No session for ${jid}, auto-spawning...`);
      try {
        const replyInstruction = `(IMPORTANT: Relay all responses back via: cat <<'EOF' | .instar/scripts/whatsapp-reply.sh ${jid}\nYour response\nEOF)`;
        const bootstrap = `[whatsapp:${jid}${senderName ? ` from ${senderName}` : ''}] ${text} ${replyInstruction}`;
        const sessionName = `wa-${jid.split('@')[0].slice(-6)}`;
        const newSession = await sessionManager.spawnInteractiveSession(bootstrap, sessionName);
        whatsapp.registerSession(jid, newSession);
        console.log(`[whatsapp→session] Spawned "${newSession}" for ${jid}`);
      } catch (err) { // @silent-fallback-ok — matches Telegram auto-spawn pattern
        console.error(`[whatsapp→session] Auto-spawn failed:`, err);
      }
    }
  });
}

/**
 * Wire iMessage message routing — mirrors Telegram's session patterns exactly.
 *
 * Routes incoming iMessages to Claude Code sessions using the same flow as Telegram:
 * 1. Existing alive session → injectIMessageMessage (with pendingInjections tracking)
 * 2. Existing dead session → respawn via spawnInteractiveSession(bootstrapMessage)
 * 3. No session → auto-spawn via spawnInteractiveSession(bootstrapMessage)
 *
 * Key design: the bootstrap message (with inline context) is passed as the
 * initialMessage to spawnInteractiveSession, which handles wait-for-ready and
 * injection internally — the same code path that Telegram uses successfully.
 */
function wireIMessageRouting(
  imessage: import('../messaging/imessage/IMessageAdapter.js').IMessageAdapter,
  sessionManager: SessionManager,
): void {
  const spawningSenders = new Set<string>();

  // Wire session alive check for stall detection
  imessage.setIsSessionAlive((sessionName) => sessionManager.isSessionAlive(sessionName));

  const replyScript = '.claude/scripts/imessage-reply.sh';

  /**
   * Build a bootstrap message for spawning an iMessage session.
   * Follows Telegram's spawnSessionForTopic pattern: context is INLINE in the
   * bootstrap message, not a file reference. For long messages, writes to a temp
   * file with a strong read instruction (matching Telegram's BOOTSTRAP_FILE_THRESHOLD).
   */
  function buildBootstrapMessage(sender: string, text: string, senderName?: string): string {
    // Get conversation history from chat.db (includes both user AND agent messages)
    const conversationContext = imessage.getConversationContext(sender, 30);

    const parts: string[] = [];

    if (conversationContext) {
      parts.push(
        `CONTINUATION — You are resuming an EXISTING conversation via iMessage.`,
        `Read the context below before responding.`,
        ``,
        conversationContext,
        ``,
        `IMPORTANT: Your response MUST acknowledge and continue the conversation above. Do NOT introduce yourself or ask "how can I help" — the user has been talking to you. Pick up where the conversation left off.`,
        ``,
      );
    }

    // Sanitize sender name to prevent injection via chat.db display_name
    const safeSenderName = senderName ? senderName.replace(/[\[\]`$\\]/g, '') : undefined;

    // iMessage relay instructions
    parts.push(
      `--- iMessage SESSION (${sender}) ---`,
      `This is a PERSISTENT conversational session via iMessage.`,
      `MANDATORY: After EVERY response, relay your message back to the user:`,
      `  cat <<'EOF' | ${replyScript} "${sender}"`,
      `  Your response text here`,
      `  EOF`,
      ``,
      `CRITICAL: After replying, STAY AT THE PROMPT and wait for follow-up messages.`,
      `Do NOT exit. More messages will be injected as [imessage:${sender}] prefixed text.`,
      `Strip the [imessage:...] prefix before interpreting messages.`,
      `Only relay conversational text — not tool output or internal reasoning.`,
      `--- END iMessage SESSION ---`,
      ``,
      `The user's latest message:`,
      `[imessage:${sender}${safeSenderName ? ` from ${safeSenderName}` : ''}] ${text}`,
    );

    let bootstrapMessage = parts.join('\n');

    // Large bootstrap messages: write to temp file with strong read instruction
    // (matches Telegram's BOOTSTRAP_FILE_THRESHOLD pattern)
    const BOOTSTRAP_FILE_THRESHOLD = 500;
    if (bootstrapMessage.length > BOOTSTRAP_FILE_THRESHOLD) {
      const tmpDir = '/tmp/instar-imessage';
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      // Clean up old temp files (>1 hour) to prevent unbounded accumulation
      try {
        const cutoff = Date.now() - 3_600_000;
        for (const f of fs.readdirSync(tmpDir)) {
          const fp = path.join(tmpDir, f);
          // safe-git-allow: incremental-migration
          try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch { /* ignore */ }
        }
      } catch { /* non-critical */ }
      const senderSlug = sender.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
      const filepath = path.join(tmpDir, `bootstrap-${senderSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      fs.writeFileSync(filepath, bootstrapMessage, { mode: 0o600 });
      console.log(`[imessage→session] Bootstrap too large (${bootstrapMessage.length} chars), wrote to ${filepath}`);
      bootstrapMessage = `[IMPORTANT: Read ${filepath} — it contains your full session context, conversation history, and the user's latest message. You MUST read this file before responding.]`;
    }

    return bootstrapMessage;
  }

  imessage.onMessage(async (msg) => {
    const sender = msg.channel?.identifier;
    if (!sender) return;

    // Build the text with attachment references inlined. iMessage stores the
    // attachment placeholder character (\uFFFC) in the text where the photo sits,
    // but doesn't include the path. We replace placeholders with explicit
    // [image:/path] tags (matching the Telegram pattern) so Claude can read the
    // files via the Read tool. Attachments are auto-hardlinked into
    // .instar/imessage/attachments/ by the user-context sync script, avoiding
    // the need for FDA on node.
    let text = msg.content;
    const attachments = (msg.metadata?.attachments as Array<{
      filename?: string;
      mimeType?: string;
      path?: string;
    }>) ?? [];
    if (attachments.length > 0) {
      // If text has no placeholders but has attachments, append refs at the end.
      // Otherwise replace each \uFFFC with an [image:/path] tag sequentially.
      const tags = attachments.map((a) => {
        if (!a.path) return '[attachment path unavailable]';
        // For images/PDFs/etc., use [image:...] so Claude's existing handling applies.
        // The path will be the hardlinked one if the sync script ran; otherwise
        // the TCC-protected original (which Claude may or may not be able to read).
        const isImage = (a.mimeType || '').startsWith('image/');
        const kind = isImage ? 'image' : 'file';
        return `[${kind}:${a.path}]`;
      });
      if (text.includes('\uFFFC')) {
        // Replace each placeholder with the next tag
        let i = 0;
        text = text.replace(/\uFFFC/g, () => tags[i++] ?? '[image:missing]');
      } else {
        // No inline placeholders — append tags at the end
        text = (text ? text + ' ' : '') + tags.join(' ');
      }
    }

    const senderName = (msg.metadata?.senderName as string) ?? undefined;
    const senderNorm = sender.toLowerCase();

    // Skip empty messages (reactions, read receipts, lookback artifacts)
    if (!text || !text.trim()) return;

    // Check for existing session
    const targetSession = imessage.getSessionForSender(sender);

    // Guard: skip if spawn already in progress for this sender
    if (spawningSenders.has(senderNorm)) {
      console.log(`[imessage→session] Spawn already in progress for ${senderNorm} — skipping`);
      return;
    }

    if (targetSession && sessionManager.isSessionAlive(targetSession)) {
      // Session alive — inject directly (same as Telegram's injectTelegramMessage path)
      console.log(`[imessage→session] Injecting into ${targetSession}: "${text.slice(0, 80)}"`);
      sessionManager.injectIMessageMessage(targetSession, sender, text, senderName);
      imessage.trackMessageInjection(sender, targetSession, text);
    } else {
      // Session dead or missing — spawn with full context (same as Telegram's spawnSessionForTopic)
      spawningSenders.add(senderNorm);

      // Use a hash of the full sender to avoid collisions (slice(-6) collides easily)
      const crypto = await import('node:crypto');
      const senderHash = crypto.createHash('sha1').update(sender.toLowerCase()).digest('hex').slice(0, 8);
      const sessionName = `im-${senderHash}`;
      const bootstrapMessage = buildBootstrapMessage(sender, text, senderName);

      // Pass bootstrap as initialMessage — spawnInteractiveSession handles
      // wait-for-ready and injection internally (same code path as Telegram)
      sessionManager.spawnInteractiveSession(bootstrapMessage, sessionName)
        .then((newSession) => {
          imessage.registerSession(sender, newSession);
          console.log(`[imessage→session] Spawned "${newSession}" for ${(imessage.constructor as any).maskIdentifier?.(sender) || sender}`);
        })
        .catch((err) => {
          console.error(`[imessage→session] Spawn failed:`, err);
        })
        .finally(() => {
          spawningSenders.delete(senderNorm);
        });
    }
  });
}

/**
 * Ensure the Agent Attention topic exists — the agent's direct line to the user.
 * Created once on first server start, persisted in state.
 */
async function ensureAgentAttentionTopic(
  telegram: TelegramAdapter,
  state: StateManager,
): Promise<void> {
  const existingTopicId = state.get<number>('agent-attention-topic');
  if (existingTopicId) {
    console.log(`  Agent Attention topic: ${existingTopicId}`);
    return;
  }

  try {
    const topic = await telegram.createForumTopic(
      `${TOPIC_STYLE.ALERT.emoji} Attention`,
      TOPIC_STYLE.ALERT.color, // Yellow — needs user action
    );
    state.set('agent-attention-topic', topic.topicId);
    await telegram.sendToTopic(topic.topicId,
      `This is your agent's direct line to you — for things that genuinely need your attention.\n\nBlocked tasks, critical errors, memory pressure, quota alerts, and anything where your agent can't proceed without you.`
    );
    console.log(pc.green(`  Created Agent Attention topic: ${topic.topicId}`));
  } catch (err) {
    console.error(`  Failed to create Agent Attention topic: ${err}`);
  }
}

/**
 * Ensure a Slack attention channel exists — for operational alerts routed via Slack.
 */
async function ensureSlackAttentionChannel(
  slack: import('../messaging/slack/SlackAdapter.js').SlackAdapter,
  state: StateManager,
): Promise<void> {
  const existingChannelId = state.get<string>('slack-attention-channel');
  if (existingChannelId) {
    console.log(`  Slack Attention channel: ${existingChannelId}`);
    return;
  }

  try {
    const agentName = (slack as unknown as { config: { workspaceName?: string } }).config?.workspaceName?.replace(/-agent$/, '') || 'agent';
    const channelId = await slack.createChannel(`${agentName}-sys-attention`);
    state.set('slack-attention-channel', channelId);
    await slack.sendToChannel(channelId,
      `Attention channel active. Blocked tasks, critical errors, quota alerts, and anything that needs your attention will appear here.`
    );
    console.log(pc.green(`  Created Slack Attention channel: ${channelId}`));
  } catch (err) {
    console.error(`  Failed to create Slack Attention channel: ${err}`);
  }
}

/**
 * Ensure a Slack updates channel exists — for version updates and feature announcements.
 */
async function ensureSlackUpdatesChannel(
  slack: import('../messaging/slack/SlackAdapter.js').SlackAdapter,
  state: StateManager,
): Promise<void> {
  const existingChannelId = state.get<string>('slack-updates-channel');
  if (existingChannelId) return;

  try {
    const agentName = (slack as unknown as { config: { workspaceName?: string } }).config?.workspaceName?.replace(/-agent$/, '') || 'agent';
    const channelId = await slack.createChannel(`${agentName}-sys-updates`);
    state.set('slack-updates-channel', channelId);
    await slack.sendToChannel(channelId,
      `Updates channel active. Version updates, new features, and system announcements will appear here.`
    );
    console.log(`  Created Slack Updates channel: ${channelId}`);
  } catch (err) {
    console.error(`  Failed to create Slack Updates channel: ${err}`);
  }
}

/**
 * Ensure the Agent Updates topic exists — for version updates, feature announcements, etc.
 * Separates informational updates from critical attention items.
 * Created once on first server start, persisted in state.
 */
async function ensureAgentUpdatesTopic(
  telegram: TelegramAdapter,
  state: StateManager,
): Promise<void> {
  const existingTopicId = state.get<number>('agent-updates-topic');
  if (existingTopicId) {
    console.log(`  Agent Updates topic: ${existingTopicId}`);
    return;
  }

  try {
    const topic = await telegram.createForumTopic(
      `${TOPIC_STYLE.INFO.emoji} Updates`,
      TOPIC_STYLE.INFO.color, // Blue — informational
    );
    state.set('agent-updates-topic', topic.topicId);
    await telegram.sendToTopic(topic.topicId,
      `This is where I'll post updates about new features, version changes, and improvements.\n\nNothing urgent — just keeping you in the loop about what's new.`
    );
    console.log(pc.green(`  Created Agent Updates topic: ${topic.topicId}`));
  } catch (err) {
    console.error(`  Failed to create Agent Updates topic: ${err}`);
  }
}

/**
 * Find npm's CLI entry point (npm-cli.js) so we can run npm via
 * `execFileSync(process.execPath, [npmCli, ...args])` — no shell required.
 * This avoids "/bin/sh ENOENT" failures in minimal/containerized environments.
 */
function findNpmCli(): string {
  // npm ships alongside node — look for it relative to process.execPath
  const nodeDir = path.dirname(process.execPath);

  // Standard layout: node is in bin/, npm-cli.js is in lib/node_modules/npm/bin/npm-cli.js
  const libNpmCli = path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(libNpmCli)) return libNpmCli;

  // Homebrew on macOS: node in /opt/homebrew/bin, npm-cli in /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js
  // (same layout, but verify explicitly for clarity)
  for (const candidate of [
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Last resort: use the npm shell wrapper (requires shell, but at least we tried)
  const npmBin = path.join(nodeDir, 'npm');
  if (fs.existsSync(npmBin)) return npmBin;

  throw new Error('Cannot find npm CLI — native module rebuild unavailable');
}

/**
 * Pre-flight check: ensure better-sqlite3 native bindings are compiled for the current Node.js version.
 *
 * Both TopicMemory and SemanticMemory use better-sqlite3. When Telegram is not configured,
 * TopicMemory never initializes, so the TopicMemory-embedded rebuild logic never runs.
 * SemanticMemory then fails with "Could not locate the bindings file."
 *
 * This runs ONCE at startup, before any SQLite subsystem initializes, making the rebuild
 * unconditionally available to all consumers.
 */
/**
 * Returns true if a rebuild was performed and a process restart is needed.
 *
 * ESM module import failures are cached in Node.js's module registry. Once
 * `import('better-sqlite3')` fails, subsequent imports by SemanticMemory,
 * TopicMemory etc. get the same cached error — even after a successful rebuild.
 * The only way to clear the cache is to restart the process so all subsystems
 * start fresh with the rebuilt bindings.
 */
async function ensureSqliteBindings(): Promise<boolean> {
  try {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    // Import alone doesn't catch all mismatches — some NODE_MODULE_VERSION
    // conflicts cause runtime crashes (C++ mutex errors) rather than import errors.
    // Actually opening an in-memory DB exercises the native bindings fully.
    const testDb = new BetterSqlite3(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.close();
    return false;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const isBindingError =
      reason.includes('Could not locate the bindings file') ||
      reason.includes('better-sqlite3') ||
      reason.includes('was compiled against a different Node.js version') ||
      reason.includes('NODE_MODULE_VERSION') ||
      reason.includes('mutex lock failed');

    if (!isBindingError) return false; // Not a binding issue — let subsystems handle it.

    console.log(pc.yellow('  better-sqlite3: native binding mismatch detected — auto-rebuilding for current Node.js version...'));
    try {
      // Use the bundled fix script which downloads correct prebuilds from GitHub.
      // This is more reliable than `npm rebuild` which fails with pnpm/asdf installs.
      const fixScript = new URL('../../../scripts/fix-better-sqlite3.cjs', import.meta.url).pathname;
      if (fs.existsSync(fixScript)) {
        execFileSync(process.execPath, [fixScript], { encoding: 'utf-8', timeout: 60000, stdio: 'pipe' });
      } else {
        // Fallback: npm rebuild in the directory containing better-sqlite3.
        // Shadow installs have their own node_modules — try that first, then global.
        // IMPORTANT: Use execFileSync (no shell) instead of execSync to avoid
        // "/bin/sh ENOENT" failures in minimal/containerized environments.
        const npmCli = findNpmCli();
        const instarDir = new URL('../../..', import.meta.url).pathname;
        const shadowBs3 = path.join(instarDir, 'node_modules', 'better-sqlite3');
        if (fs.existsSync(shadowBs3)) {
          execFileSync(process.execPath, [npmCli, 'rebuild', 'better-sqlite3'], {
            cwd: instarDir,
            encoding: 'utf-8',
            timeout: 60000,
            stdio: 'pipe',
          });
        } else {
          const globalInstarDir = execFileSync(process.execPath, [npmCli, 'root', '-g'], { encoding: 'utf-8', timeout: 10000 }).toString().trim() + '/instar';
          execFileSync(process.execPath, [npmCli, 'rebuild', 'better-sqlite3'], {
            cwd: globalInstarDir,
            encoding: 'utf-8',
            timeout: 60000,
            stdio: 'pipe',
          });
        }
      }
      console.log(pc.green('  better-sqlite3: rebuilt successfully — restarting to apply (ESM module cache must be cleared).'));
      return true; // Restart needed — ESM cache holds the stale failure
    } catch (rebuildErr) {
      console.log(pc.yellow(`  better-sqlite3: rebuild failed (${rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr)}). SQLite subsystems may degrade.`));
      return false;
    }
  }
}

/**
 * Clean up stale temp files from /tmp/instar-telegram/.
 * Removes files older than 7 days to prevent unbounded accumulation.
 */
function cleanupTelegramTempFiles(): void {
  const tmpDir = '/tmp/instar-telegram';
  try {
    if (!fs.existsSync(tmpDir)) return;
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();
    let cleaned = 0;
    for (const file of fs.readdirSync(tmpDir)) {
      try {
        const filepath = path.join(tmpDir, file);
        const stat = fs.statSync(filepath);
        if (stat.isFile() && now - stat.mtimeMs > maxAge) {
          // safe-git-allow: incremental-migration
          fs.unlinkSync(filepath);
          cleaned++;
        }
      } catch { /* @silent-fallback-ok — temp file cleanup */ }
    }
    if (cleaned > 0) {
      console.log(`[cleanup] Removed ${cleaned} stale temp files from ${tmpDir}`);
    }
  } catch {
    // @silent-fallback-ok — temp dir cleanup
  }
}

/**
 * Tee stdout/stderr to a log file for observability.
 * The self-diagnosis job checks .instar/logs/server.log — this ensures it exists.
 * Log is truncated at 5MB to prevent unbounded growth.
 */
function getInstalledVersion(): string {
  try {
    const pkgPath = resolvePackageJsonPath();
    if (pkgPath) return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || '';
    return '';
  } catch (err) {
    DegradationReporter.getInstance().report({
      feature: 'server.getInstalledVersion',
      primary: 'Read installed package version from package.json',
      fallback: 'Return empty string — version unknown',
      reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
      impact: 'Version display and upgrade guide notifications may use blank version',
    });
    return '';
  }
}

/**
 * Resolve path to instar's package.json.
 * Used by ProcessIntegrity for live disk version reads.
 */
function resolvePackageJsonPath(): string | null {
  try {
    const pkgPath = path.resolve(new URL(import.meta.url).pathname, '../../../package.json');
    if (fs.existsSync(pkgPath)) return pkgPath;
  } catch {
    // @silent-fallback-ok — best-effort path resolution for package.json; null return is the documented default
  }
  return null;
}

function setupServerLog(stateDir: string): void {
  const logDir = path.join(stateDir, '..', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'server.log');

  // Truncate if over 5MB
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 5 * 1024 * 1024) {
      // Keep last 1MB
      const content = fs.readFileSync(logPath, 'utf-8');
      fs.writeFileSync(logPath, content.slice(-1024 * 1024));
    }
  } catch { /* file doesn't exist yet */ }

  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  const timestamp = () => new Date().toISOString();

  console.log = (...args: unknown[]) => {
    origLog(...args);
    logStream.write(`${timestamp()} [LOG] ${args.map(String).join(' ')}\n`);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    logStream.write(`${timestamp()} [WARN] ${args.map(String).join(' ')}\n`);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    logStream.write(`${timestamp()} [ERROR] ${args.map(String).join(' ')}\n`);
  };
}

export async function startServer(options: StartOptions): Promise<void> {
  const config = loadConfig(options.dir);
  ensureStateDir(config.stateDir);

  // LiveConfig: dynamic config re-reading for long-running server process.
  // Solves the "Written But Not Re-Read" class of bugs — sessions modify
  // config.json but the server process never picks up the changes.
  const liveConfig = new LiveConfig(config.stateDir, {
    watchPaths: ['updates.autoApply', 'sessions.maxSessions', 'monitoring'],
  });
  liveConfig.start();

  // NotificationBatcher: consolidate all Telegram notifications into tiered delivery.
  // IMMEDIATE = user needs to act NOW (quota exhausted, critical stall)
  // SUMMARY = batched every 30 min (degradations, coherence, orphan reports)
  // DIGEST = batched every 2 hrs (updates, wake events, routine lifecycle)
  // Principle: Log everything, notify selectively.
  const notificationBatcher = new NotificationBatcher({
    enabled: true,
    summaryIntervalMinutes: 30,
    digestIntervalMinutes: 120,
  });

  // State reference — set once StateManager is created, used by notify()
  let _notifyState: { get<T>(key: string): T | null | undefined } | null = null;

  /**
   * Central notification gateway — ALL non-interactive notifications should go through here.
   * Sends to both Telegram (via batcher) and Slack (directly) when available.
   * Interactive messages (session replies, user-facing responses) still use sendToTopic/sendToChannel directly.
   */
  function notify(tier: NotificationTier, category: string, message: string, topicId?: number): void {
    // Telegram: via notification batcher
    const resolvedTopicId = topicId ?? _notifyState?.get<number>('agent-attention-topic') ?? 0;
    if (resolvedTopicId) {
      notificationBatcher.enqueue({
        tier,
        category,
        message,
        timestamp: new Date(),
        topicId: resolvedTopicId,
      }).catch(() => { /* @silent-fallback-ok */ });
    }

    // Slack: send all notification tiers to attention channel
    if (_slackAdapter) {
      const slackAttentionChannel = _notifyState?.get<string>('slack-attention-channel');
      if (slackAttentionChannel) {
        _slackAdapter.sendToChannel(slackAttentionChannel, message).catch(() => { /* @silent-fallback-ok */ });
      }
    }
  }

  /**
   * Translate coherence check failures into human-readable, actionable messages.
   */
  function formatCoherenceFailure(checkName: string, message: string): string {
    switch (checkName) {
      case 'output-sanity':
        return `I noticed some of my recent messages might contain placeholder text or raw internal references. Reply "fix output" and I'll clean that up.`;
      case 'readiness-auth-token':
        return `My API doesn't have an auth token set, which means anyone with the URL could access it. Reply "fix auth" to lock it down.`;
      case 'readiness-dashboard-pin':
        return `The dashboard doesn't have a PIN yet. Reply "fix dashboard" to set one up.`;
      case 'readiness-telegram-token':
        return `I can't connect to Telegram — the bot token is missing from my config. Check .instar/config.json to set it up.`;
      case 'config-file-valid':
        return `My config file looks damaged, which might cause unexpected behavior. Reply "fix config" and I'll try to repair it.`;
      case 'process-version-mismatch': {
        // Extract versions from message like "Running v0.21.0 but disk has v0.21.1 — restart needed"
        const versionMatch = message.match(/v[\d.]+/g);
        const newVersion = versionMatch && versionMatch.length >= 2 ? versionMatch[1] : 'a newer version';
        return `There's an update ready (${newVersion}). Reply "restart" to apply it.`;
      }
      case 'shadow-installation':
        return `A local copy of instar is overriding the global install, which blocks auto-updates. Reply "fix shadow" to remove it.`;
      case 'state-topic-registry':
        return `My topic routing got corrupted — messages might be landing in the wrong threads. Reply "fix registry" to rebuild it.`;
      default:
        return `${checkName}: ${message}`;
    }
  }

  // Migration disabled — we manage updates via the daily rebase job,
  // not via npm auto-updates. The migration was forcing autoApply: true
  // which overwrites our intentional autoApply: false setting.

  const serverSessionName = `${config.projectName}-server`;

  if (options.foreground) {
    // Run in foreground — useful for development
    console.log(pc.bold(`Starting instar server for ${pc.cyan(config.projectName)}`));
    console.log(`  Port: ${config.port}`);
    console.log(`  State: ${config.stateDir}`);
    console.log();

    // Set up file logging for observability
    setupServerLog(config.stateDir);

    // ── Shadow installation detection (v0.9.72) ────────────────────────
    // The Luna Incident: a local `npm install instar` created node_modules/
    // in the project directory, shadowing the global binary. AutoUpdater
    // updated the global, but the server kept loading the stale local copy.
    // Detect this at startup and warn loudly.
    const localInstarBin = path.join(process.cwd(), 'node_modules', '.bin', 'instar');
    const localInstarPkg = path.join(process.cwd(), 'node_modules', 'instar', 'package.json');
    if (fs.existsSync(localInstarBin) || fs.existsSync(localInstarPkg)) {
      const localVersion = (() => {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'node_modules', 'instar', 'package.json'), 'utf-8'));
          return pkg.version || 'unknown';
        } catch { return 'unknown'; }
      })();
      console.warn(pc.red(pc.bold('  ⚠ SHADOW INSTALLATION DETECTED')));
      console.warn(pc.red(`  Local node_modules/instar (v${localVersion}) shadows the global binary.`));
      console.warn(pc.red('  Auto-updates will NOT take effect. Remove with:'));
      console.warn(pc.red(`  rm -rf ${path.join(process.cwd(), 'node_modules')} ${path.join(process.cwd(), 'package.json')} ${path.join(process.cwd(), 'package-lock.json')}`));
      console.warn();
    }

    // ── Global install cleanup ─────────────────────────────────────────
    // Shadow installs are the sole source of truth. Global installs cause
    // version confusion — agents report stale versions when CLI commands
    // resolve to a global binary instead of the shadow install.
    // Clean up any lingering globals at startup (idempotent, safe to run every time).
    try {
      const cleanup = cleanupGlobalInstalls();
      if (cleanup.removed.length > 0) {
        console.log(pc.green(`  ✓ Cleaned up ${cleanup.removed.length} stale global instar install(s):`));
        for (const r of cleanup.removed) {
          console.log(pc.green(`    - ${r}`));
        }
      }
      if (cleanup.failed.length > 0) {
        for (const f of cleanup.failed) {
          console.warn(pc.yellow(`  ⚠ Failed to remove global install at ${f.path}: ${f.error}`));
        }
      }
    } catch (err) {
      // Non-fatal — log and continue
      console.warn(`[server] Global install cleanup error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── ProcessIntegrity: freeze the running version at startup ────────
    // This MUST happen before any version reporting. The version is captured
    // from the code loaded into memory, NOT from disk (which changes after
    // npm install -g). See ProcessIntegrity.ts for the full rationale.
    const packageJsonPath = resolvePackageJsonPath();
    const startupVersion = config.version ?? '0.0.0';
    const processIntegrity = ProcessIntegrity.initialize(startupVersion, packageJsonPath);

    // StaleProcessGuard: register version as a monitored snapshot
    const staleGuard = new StaleProcessGuard();
    staleGuard.registerSnapshot(
      'instar-version',
      startupVersion,
      () => {
        try {
          if (packageJsonPath && fs.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            return pkg.version || '0.0.0';
          }
        } catch { /* fallback */ }
        return startupVersion;
      },
      { description: 'Instar package version', severity: 'critical' },
    );

    // Initialize DegradationReporter early — before any feature that might fall back.
    // Downstream systems (feedback, telegram) are connected once the server is fully up.
    const degradationReporter = DegradationReporter.getInstance();
    degradationReporter.configure({
      stateDir: config.stateDir,
      agentName: config.projectName,
      instarVersion: startupVersion,
    });

    // Clean up stale Telegram temp files on startup
    cleanupTelegramTempFiles();

    // Pre-flight: ensure better-sqlite3 bindings are compiled for the current Node.js version.
    // Must run before TopicMemory or SemanticMemory initialize. See ensureSqliteBindings() for rationale.
    // If rebuild occurred, we must restart — ESM caches the import failure and won't retry.
    const sqliteRebuildRequired = await ensureSqliteBindings();
    if (sqliteRebuildRequired) {
      console.log(pc.yellow('  Restarting server to apply SQLite rebuild. Server will be back online momentarily.'));
      process.exit(0);
    }

    // Run post-update migration on startup — ensures agent knowledge stays current
    // regardless of how the update was applied (shadow install, npx, etc.).
    // This is the SAFETY NET: catches all upgrades regardless of how they were applied.
    try {
      const installedVersion = getInstalledVersion();
      const versionFile = path.join(config.stateDir, 'state', 'last-migrated-version.json');
      let lastMigrated = '';
      try { lastMigrated = JSON.parse(fs.readFileSync(versionFile, 'utf-8')).version || ''; } catch { /* first run */ }
      if (installedVersion && installedVersion !== lastMigrated) {
        // Backup config.json before migration — protects against accidental wipes
        const configPath = path.join(config.stateDir, 'config.json');
        if (fs.existsSync(configPath)) {
          const backupPath = path.join(config.stateDir, 'config.json.backup');
          fs.copyFileSync(configPath, backupPath);
        }
        const hasTelegram = config.messaging?.some((m: any) => m.type === 'telegram') ?? false;
        const migrator = new PostUpdateMigrator({
          projectDir: config.projectDir,
          stateDir: config.stateDir,
          port: config.port,
          hasTelegram,
          projectName: config.projectName,
        });
        const migration = migrator.migrate();
        if (migration.upgraded.length > 0) {
          console.log(pc.green(`  Knowledge upgrade (v${lastMigrated || '?'} → v${installedVersion}): ${migration.upgraded.join(', ')}`));
        }
        // Record the migrated version
        const dir = path.dirname(versionFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(versionFile, JSON.stringify({ version: installedVersion, migratedAt: new Date().toISOString() }));
      }

      // ALWAYS process upgrade guides on startup — regardless of version match.
      // This is the critical safety net that catches manual `npm install -g` updates
      // where the auto-updater pipeline was bypassed. UpgradeGuideProcessor handles
      // deduplication internally via processed-upgrades.json, so re-running is safe.
      // Removing the old `hasPendingGuide()` guard that caused guides to be skipped.
      try {
        const guideProcessor = new UpgradeGuideProcessor({
          stateDir: config.stateDir,
          currentVersion: installedVersion || config.version || '0.0.0',
          previousVersion: lastMigrated || undefined,
        });
        const guideResult = guideProcessor.process();
        if (guideResult.pendingGuides.length > 0) {
          console.log(pc.green(`  Upgrade guides pending: ${guideResult.pendingGuides.join(', ')}`));
        }
      } catch (guideErr) {
        console.log(pc.yellow(`  Upgrade guide check: ${guideErr instanceof Error ? guideErr.message : String(guideErr)}`));
      }
    } catch (err) {
      console.log(pc.yellow(`  Post-update migration check: ${err instanceof Error ? err.message : String(err)}`));
    }

    // Register this agent in the global registry (multi-instance support)
    try {
      registerAgent(config.projectDir, config.projectName, config.port);
      console.log(pc.green(`  Registered agent "${config.projectName}" on port ${config.port}`));
    } catch (err) {
      console.log(pc.red(`  Port conflict: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
    let stopHeartbeat: (() => void) | undefined;
    try {
      stopHeartbeat = startHeartbeat(config.projectDir);
    } catch (err) {
      // Registry heartbeat is non-critical — server should run without it.
      // ELOCKED errors from concurrent agent startups are transient.
      console.log(pc.yellow(`  Registry heartbeat failed to start (non-critical): ${err instanceof Error ? err.message : err}`));
    }

    // Warn if no auth token configured — server allows unauthenticated access
    if (!config.authToken) {
      console.log(pc.yellow(pc.bold('  ⚠ WARNING: No auth token configured — all API endpoints are unauthenticated!')));
      console.log(pc.yellow('  Set authToken in .instar/config.json or re-run instar init'));
      console.log();
    }

    const state = new StateManager(config.stateDir);
    _notifyState = state; // Wire state into notify() gateway

    // Multi-machine coordinator — determines role (awake/standby) before other components start.
    // If standby, StateManager becomes read-only and processing is gated.
    const coordinator = new MultiMachineCoordinator(state, {
      stateDir: config.stateDir,
      multiMachine: config.multiMachine,
    });
    const machineRole = coordinator.start();
    if (coordinator.enabled) {
      console.log(pc.green(`  Multi-machine: ${pc.bold(machineRole)} (${coordinator.identity!.machineId.slice(0, 12)}...)`));
      if (machineRole === 'standby') {
        console.log(pc.yellow('  Standby mode — processing gated, writes disabled'));
      }
    }

    // Read local signing key for machine route authentication
    let localSigningKeyPem = '';
    if (coordinator.enabled && coordinator.identity) {
      try {
        const keyPath = path.join(config.stateDir, 'machine', 'signing-private.pem');
        if (fs.existsSync(keyPath)) {
          localSigningKeyPem = fs.readFileSync(keyPath, 'utf-8');
        }
      } catch { /* @silent-fallback-ok — signing key optional */ }
    }

    // Git sync for multi-machine (awake machines only — standby pulls via cron or manual)
    // Only attempt git sync if the project directory is actually a git repo.
    // Standalone agents don't have git repos unless the user opted into cloud backup.
    let gitSync: GitSyncManager | undefined;
    const isGitRepo = fs.existsSync(path.join(config.projectDir, '.git'));
    const gitBackupEnabled = config.gitBackup?.enabled !== false;
    if (coordinator.enabled && coordinator.isAwake && isGitRepo && gitBackupEnabled) {
      try {
        gitSync = new GitSyncManager({
          projectDir: config.projectDir,
          stateDir: config.stateDir,
          identityManager: coordinator.managers.identityManager,
          securityLog: coordinator.managers.securityLog,
          machineId: coordinator.identity!.machineId,
        });

        // Configure commit signing if not already done
        if (!gitSync.isSigningConfigured() && localSigningKeyPem) {
          gitSync.configureCommitSigning();
          console.log(pc.green('  Git commit signing configured'));
        }

        // Pull latest on startup
        const syncResult = await gitSync.sync();
        if (syncResult.pulled) {
          console.log(pc.green(`  Git sync: pulled ${syncResult.commitsPulled} commit(s)`));
        }
      } catch (err) {
        // @silent-fallback-ok — git sync disabled gracefully
        console.log(pc.yellow(`  Git sync setup: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    const sessionManager = new SessionManager(config.sessions, state);

    // Input Guard is constructed later (after sharedIntelligence is available)
    // so the topic coherence reviewer can route through the IntelligenceProvider
    // abstraction instead of calling Anthropic directly.

    // TopicResumeMap: persist Claude session UUIDs across session restarts.
    // When a session is killed/restarted, we save its UUID so the next spawn
    // can use --resume to reattach to the existing conversation context.
    const { TopicResumeMap } = await import('../core/TopicResumeMap.js');
    _topicResumeMap = new TopicResumeMap(config.stateDir, config.sessions.projectDir, config.sessions.tmuxPath);
    _projectDir = config.sessions.projectDir;

    // Shared intelligence provider — lightweight LLM for internal classification tasks.
    // Priority: Claude CLI subscription (zero extra cost, default) → Anthropic API (explicit opt-in)
    // Components that need LLM intelligence (Sentinel, TelegramAdapter, etc.) share this.
    //
    // Rationale: Instar must not depend on an API key. The subscription path is the default so
    // every agent gets LLM-gated features out of the box. Users who prefer direct API access can
    // set `intelligenceProvider: "anthropic-api"` in config.json.
    let sharedIntelligence: IntelligenceProvider | undefined;
    const explicitIntelligenceProvider =
      (config as unknown as { intelligenceProvider?: string }).intelligenceProvider;
    let intelligenceSource = 'none';

    if (explicitIntelligenceProvider === 'anthropic-api') {
      try {
        const apiProvider = AnthropicIntelligenceProvider.fromEnv();
        if (apiProvider) {
          sharedIntelligence = apiProvider;
          intelligenceSource = 'Anthropic API (explicit opt-in)';
        } else {
          console.log(pc.yellow('  intelligenceProvider: "anthropic-api" set but ANTHROPIC_API_KEY not found — falling back to Claude CLI'));
        }
      } catch { /* no API key available */ }
    }

    if (!sharedIntelligence) {
      try {
        sharedIntelligence = new ClaudeCliIntelligenceProvider(config.sessions.claudePath);
        intelligenceSource = 'Claude CLI subscription';
      } catch { /* CLI not available */ }
    }

    if (!sharedIntelligence && explicitIntelligenceProvider !== 'anthropic-api') {
      // Last resort: if user has API key but didn't explicitly opt in, use it rather than
      // leaving the agent flying blind. We prefer subscription, but degrading to heuristics
      // is worse than using whatever LLM is available.
      try {
        const apiProvider = AnthropicIntelligenceProvider.fromEnv();
        if (apiProvider) {
          sharedIntelligence = apiProvider;
          intelligenceSource = 'Anthropic API (CLI unavailable — last resort)';
        }
      } catch { /* no API key available */ }
    }

    _sharedIntelligence = sharedIntelligence ?? null;
    if (sharedIntelligence) {
      console.log(pc.gray(`  Intelligence: ${intelligenceSource}`));
    } else {
      console.log(pc.yellow('  Intelligence: none (no Claude CLI, no API key) — LLM-gated features degraded'));
      // Visible degradation — every downstream LLM-gated feature depends on this.
      // The DegradationReporter routes to console, disk, Telegram alert, and feedback.
      // Keep the externally-rendered impact string generic; the detailed
      // capability-down enumeration (tone gate, input guard, coherence gate, stall
      // triage, job reflection) stays in the yellow console line above and the
      // local degradations.json log. We don't broadcast a "which defenses are down"
      // checklist to Telegram/feedback channels.
      const { DegradationReporter } = await import('../monitoring/DegradationReporter.js');
      DegradationReporter.getInstance().report({
        feature: 'SharedIntelligenceProvider',
        primary: 'Shared LLM provider (Claude CLI subscription by default, Anthropic API opt-in)',
        fallback: 'Heuristic-only operation for LLM-gated features',
        reason: 'No LLM transport configured on this machine (see local startup logs for detail).',
        impact: 'LLM-gated features degraded; defense-in-depth reduced. See local logs for the affected feature list.',
      });
    }

    // Wire intelligence into git sync for LLM conflict resolution (Tier 1 → 2)
    if (gitSync && sharedIntelligence) {
      gitSync.setIntelligence(sharedIntelligence);
    }

    // Input Guard — cross-topic injection defense (Layer 1 + 1.5 + 2).
    // Constructed AFTER sharedIntelligence so the topic-coherence reviewer routes
    // through the IntelligenceProvider (subscription-first). InputGuard no longer
    // carries a direct Anthropic API path — all LLM usage flows through the shared
    // provider abstraction, enforcing the subscription-first principle at the
    // single provider-selection layer rather than in each consumer.
    if (config.inputGuard?.enabled !== false) {
      const guardConfig = config.inputGuard ?? { enabled: true };
      const { InputGuard } = await import('../core/InputGuard.js');
      const inputGuard = new InputGuard({
        config: {
          enabled: true,
          provenanceCheck: guardConfig.provenanceCheck ?? true,
          injectionPatterns: guardConfig.injectionPatterns ?? true,
          topicCoherenceReview: guardConfig.topicCoherenceReview ?? true,
          action: guardConfig.action ?? 'warn',
          reviewTimeout: guardConfig.reviewTimeout ?? 3000,
        },
        stateDir: config.stateDir,
        intelligence: sharedIntelligence,
      });
      const registryPath = path.join(config.stateDir, 'topic-session-registry.json');
      sessionManager.setInputGuard(inputGuard, registryPath);
      const reviewBackend = sharedIntelligence
        ? 'via shared IntelligenceProvider'
        : 'provenance + patterns only (no LLM review)';
      console.log(pc.green(`  Input Guard: enabled (action: ${guardConfig.action ?? 'warn'}, ${reviewBackend})`));
    }

    let relationships: RelationshipManager | undefined;
    if (config.relationships) {
      // Wire LLM intelligence for identity resolution.
      // Priority: Claude CLI (subscription, zero extra cost) > Anthropic API (explicit opt-in only)
      const claudePath = config.sessions.claudePath;
      let intelligenceMode = 'heuristic-only';

      // Check if user explicitly opted into API-based intelligence
      // (intelligenceProvider is a config-file-only field, not in the TypeScript type)
      const explicitProvider = (config.relationships as unknown as { intelligenceProvider?: string }).intelligenceProvider;

      if (explicitProvider === 'anthropic-api') {
        // User explicitly chose API — respect their decision
        const apiProvider = AnthropicIntelligenceProvider.fromEnv();
        if (apiProvider) {
          config.relationships.intelligence = apiProvider;
          intelligenceMode = 'LLM-supervised (Anthropic API — user choice)';
        } else {
          console.log(pc.yellow('  intelligenceProvider: "anthropic-api" set but ANTHROPIC_API_KEY not found'));
        }
      } else if (claudePath) {
        // Default: use Claude CLI via subscription (zero extra cost)
        config.relationships.intelligence = new ClaudeCliIntelligenceProvider(claudePath);
        intelligenceMode = 'LLM-supervised (Claude CLI subscription)';
      }

      relationships = new RelationshipManager(config.relationships);
      const count = relationships.getAll().length;
      console.log(pc.green(`  Relationships loaded: ${count} tracked (${intelligenceMode})`));
    }

    // Set up quota tracking if enabled
    let quotaTracker: QuotaTracker | undefined;
    let quotaManager: QuotaManager | undefined;
    if (config.monitoring?.quotaTracking) {
      const quotaFile = (config.monitoring as any).quotaStateFile
        || path.join(config.stateDir, 'quota-state.json');
      quotaTracker = new QuotaTracker({
        quotaFile,
        thresholds: config.scheduler?.quotaThresholds ?? { normal: 50, elevated: 60, critical: 80, shutdown: 95 },
      });
      console.log(pc.green(`  Quota tracking enabled (${quotaFile})`));
    }

    // Set up opt-in telemetry heartbeat
    let telemetryHeartbeat: import('../monitoring/TelemetryHeartbeat.js').TelemetryHeartbeat | undefined;
    if (config.monitoring?.telemetry?.enabled) {
      const { TelemetryHeartbeat } = await import('../monitoring/TelemetryHeartbeat.js');
      telemetryHeartbeat = new TelemetryHeartbeat(
        config.monitoring.telemetry,
        config.stateDir,
        config.projectDir,
        config.version || 'unknown',
      );
      // Note: .start() is deferred until after scheduler is available so
      // TelemetryCollector can be wired for Baseline submissions.
      console.log(pc.green(`  Telemetry: enabled (${config.monitoring.telemetry.level || 'basic'} level, every ${Math.round((config.monitoring.telemetry.intervalMs || 21600000) / 3600000)}h)`));
    }

    // ── Prompt Gate: detect and handle interactive prompts in sessions ──
    const promptGateConfig = config.monitoring?.promptGate;
    if (promptGateConfig?.enabled) {
      const { InputDetector } = await import('../monitoring/PromptGate.js');
      const { InputClassifier } = await import('../monitoring/InputClassifier.js');
      const { AutoApprover } = await import('../core/AutoApprover.js');

      const detector = new InputDetector({
        detectionWindowLines: promptGateConfig.detectionWindowLines ?? 50,
        enabled: true,
        intelligence: sharedIntelligence ?? undefined,
      });

      const classifier = new InputClassifier({
        projectDir: config.sessions.projectDir,
        autoApprove: {
          enabled: promptGateConfig.autoApprove?.enabled ?? false,
          fileCreation: promptGateConfig.autoApprove?.fileCreation ?? true,
          fileEdits: promptGateConfig.autoApprove?.fileEdits ?? true,
          planApproval: promptGateConfig.autoApprove?.planApproval ?? true,
        },
        dryRun: promptGateConfig.dryRun ?? false,
        intelligence: sharedIntelligence,
      });

      const autoApprover = new AutoApprover({
        stateDir: config.stateDir,
        logRetentionDays: promptGateConfig.logRetentionDays ?? 30,
        verboseLogging: promptGateConfig.verboseLogging ?? false,
        sendKey: (tmuxSession, key) => sessionManager.sendKey(tmuxSession, key),
      });

      // Wire detector into SessionManager
      sessionManager.setPromptDetector(detector);

      // Handle detected prompts: classify → auto-approve or relay to Telegram
      detector.on('prompt', async (prompt: import('../monitoring/PromptGate.js').DetectedPrompt) => {
        try {
          const classification = await classifier.classify(prompt);

          if (classification.action === 'auto-approve') {
            const handled = autoApprover.handle(prompt, classification);
            if (handled) {
              // Clear dedup so detector is ready for the next prompt
              detector.onInputSent(prompt.sessionName);
              return;
            }
            // If handle() returned false, fall through to relay
          }

          // Relay to messaging platform if adapter is available and session has a binding
          if (classification.action === 'relay' || classification.action === 'auto-approve') {
            let relayed = false;

            // Try Telegram first
            if (telegram) {
              const topicId = telegram.getTopicForSession(prompt.sessionName);
              if (topicId) {
                try {
                  await telegram.relayPrompt(topicId, prompt);
                  console.log(`[PromptGate] Relayed ${prompt.type} prompt to Telegram topic ${topicId}`);
                  relayed = true;
                } catch (relayErr) {
                  console.error(`[PromptGate] Telegram relay failed: ${relayErr instanceof Error ? relayErr.message : relayErr}`);
                }
              }
            }

            // Try Slack if not already relayed via Telegram
            if (!relayed && _slackAdapter) {
              const channelId = _slackAdapter.getChannelForSession(prompt.sessionName);
              if (channelId) {
                try {
                  const question = prompt.summary || 'Agent needs your input';
                  const options = (prompt.options || []).map((opt, i) => ({
                    label: opt.label.slice(0, 75),
                    value: opt.key,
                    primary: i === 0,
                  }));
                  if (options.length > 0) {
                    await _slackAdapter.relayPrompt(channelId, prompt.id, question, options);
                  } else {
                    await _slackAdapter.sendToChannel(channelId,
                      `⏳ *Agent needs your input:*\n${question}\n\n_Reply in this channel to respond._`
                    );
                  }
                  console.log(`[PromptGate] Relayed ${prompt.type} prompt to Slack channel ${channelId}`);
                } catch (relayErr) {
                  console.error(`[PromptGate] Slack relay failed: ${relayErr instanceof Error ? relayErr.message : relayErr}`);
                }
              }
            }
          }
        } catch (err) {
          console.error(`[PromptGate] Classification error: ${err instanceof Error ? err.message : err}`);
        }
      });

      const mode = promptGateConfig.autoApprove?.enabled
        ? (promptGateConfig.dryRun ? 'dry-run' : 'auto-approve')
        : 'detect-only';
      console.log(pc.green(`  Prompt Gate: enabled (mode: ${mode})`));
    }

    let scheduler: JobScheduler | undefined;
    if (config.scheduler.enabled && coordinator.isAwake) {
      scheduler = new JobScheduler(config.scheduler, sessionManager, state, config.stateDir);
      // Wire machine identity for machine-scoped job filtering
      if (coordinator.identity) {
        scheduler.setMachineIdentity(coordinator.identity.machineId, coordinator.identity.name);
      }
      if (quotaTracker) {
        // Basic binding — QuotaManager will override this once wired
        scheduler.canRunJob = quotaTracker.canRunJob.bind(quotaTracker);
        scheduler.setQuotaTracker(quotaTracker);
      }
      if (sharedIntelligence) {
        scheduler.setIntelligence(sharedIntelligence);
      }

      // Wire IntegrationGate — enforces learning consolidation after job completion
      const integrationGate = new IntegrationGate({
        stateDir: config.stateDir,
        intelligence: sharedIntelligence ?? null,
        runHistory: new JobRunHistory(config.stateDir),
      });
      scheduler.setIntegrationGate(integrationGate);

      scheduler.start();
      console.log(pc.green('  Scheduler started'));

      // Wire up Baseline TelemetryCollector now that scheduler is available
      if (telemetryHeartbeat && scheduler) {
        const sched = scheduler; // capture for closure narrowing
        const { TelemetryCollector } = await import('../monitoring/TelemetryCollector.js');
        const collector = new TelemetryCollector({
          skipLedger: sched.getSkipLedger(),
          runHistory: sched.getRunHistory(),
          getJobs: () => sched.getJobs(),
          version: config.version || 'unknown',
          startTime: Date.now(),
          getSessionCount24h: () => telemetryHeartbeat!.getStatus().counters.sessionsSpawned,
          getConfig: () => config as unknown as Record<string, unknown>,
          // Watchdog stats — lazy getter since watchdog may be initialized later
          getWatchdogStats: (sinceMs: number) => {
            if (!watchdog) return { interventionsTotal: 0, interventionsByLevel: {}, recoveries: 0, sessionDeaths: 0, llmGateOverrides: 0 };
            return watchdog.getStats(sinceMs);
          },
          // Session recovery stats — lazy getter (declared later in scope via `let`)
          getRecoveryStats: (_sinceMs: number) => {
            return { attempts: { stall: 0, crash: 0, errorLoop: 0 }, successes: { stall: 0, crash: 0, errorLoop: 0 } };
          },
          // Triage orchestrator stats — lazy getter (declared later in scope via `let`)
          getTriageStats: (_sinceMs: number) => {
            return { activations: 0, heuristicResolutions: 0, llmResolutions: 0, failures: 0, actionCounts: {} };
          },
          // Notification batcher stats — lazy getter
          getNotificationStats: () => {
            if (!notificationBatcher) return { flushed: 0, suppressed: 0, summaryQueueSize: 0, digestQueueSize: 0 };
            const s = notificationBatcher.getStats();
            return { flushed: s.totalFlushed, suppressed: s.totalSuppressed, summaryQueueSize: s.summaryQueueSize, digestQueueSize: s.digestQueueSize };
          },
          // Process staleness stats — lazy getter
          getStalenessStats: () => {
            const pi = ProcessIntegrity.getInstance();
            if (!pi) return { versionMismatch: false, driftCount: 0 };
            const drifts = staleGuard.checkAll();
            return { versionMismatch: pi.versionMismatch, driftCount: drifts.length };
          },
        });
        telemetryHeartbeat.setCollector(collector);
        console.log(pc.green('  Baseline telemetry collector wired'));
      }
    } else if (config.scheduler.enabled && !coordinator.isAwake) {
      console.log(pc.yellow('  Scheduler skipped (standby mode)'));
    }

    // Start telemetry heartbeat (deferred to here so collector can be wired first)
    if (telemetryHeartbeat) {
      telemetryHeartbeat.start();
    }

    // Helper: resolve pending plan prompts when a prompt response arrives.
    // Calls the internal route endpoint to mark the plan prompt as resolved,
    // which unblocks the PreToolUse hook that's polling for the response.
    const resolvePlanPromptForSession = (sessionName: string, key: string) => {
      const port = config.port ?? 4042;
      const payload = JSON.stringify({ sessionName, key });
      const http = require('node:http');
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/hooks/plan-prompt/resolve',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization': `Bearer ${config.authToken}`,
        },
        timeout: 2000,
      });
      req.on('error', () => {}); // Best-effort
      req.write(payload);
      req.end();
    };

    // Set up Telegram if configured
    // When --no-telegram is set (lifeline owns polling), create adapter in send-only mode
    // so the server can still relay replies via /telegram/reply/:topicId
    let telegram: TelegramAdapter | undefined;
    let topicMemory: TopicMemory | undefined;
    const telegramConfig = config.messaging.find(m => m.type === 'telegram' && m.enabled);
    const skipTelegram = options.telegram === false; // --no-telegram sets telegram: false
    // Standby machines use send-only Telegram — they don't poll for messages
    const isStandbyTelegram = !coordinator.isAwake && telegramConfig;
    if ((skipTelegram || isStandbyTelegram) && telegramConfig) {
      // Send-only mode: no polling, but sendToTopic() works for session replies
      telegram = new TelegramAdapter(
        {
          ...(telegramConfig.config as any),
          // PR2: hot-reloadable accessors. Sending-side authoritative —
          // each send re-reads config so a canary flip lands without restart.
          getFormatMode: () =>
            (config as unknown as { telegramFormatMode?: 'plain' | 'html' | 'code' | 'markdown' | 'legacy-passthrough' })
              .telegramFormatMode,
          getLintStrict: () =>
            (config as unknown as { telegramLintStrict?: boolean }).telegramLintStrict,
        },
        config.stateDir,
      );
      console.log(pc.green(`  Telegram send-only mode (${isStandbyTelegram ? 'standby' : 'lifeline owns polling'})`));

      // Resolve any topic names still using the fallback "topic-NNNN" pattern
      telegram.resolveUnknownTopicNames().catch(err => {
        console.warn(`[telegram] Topic name resolution failed: ${err}`);
      });

      // Ensure topics exist even in send-only mode (createForumTopic is a simple API call)
      ensureAgentAttentionTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Attention topic: ${err}`);
      });
      ensureAgentUpdatesTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Updates topic: ${err}`);
      });

      // Wire Prompt Gate callbacks in send-only mode too — the lifeline forwards
      // callback queries via /internal/telegram-callback, and we need handlers for them
      if (promptGateConfig?.enabled) {
        telegram.onPromptResponse = (sessionName, key) => {
          if (!sessionManager.isSessionAlive(sessionName)) {
            console.warn(`[PromptGate] Skipping injection — session "${sessionName}" is no longer alive`);
            return false;
          }
          // Also resolve any pending plan prompt for this session (unblocks the hook)
          resolvePlanPromptForSession(sessionName, key);
          return sessionManager.sendKey(sessionName, key);
        };
        telegram.onPromptTextResponse = (sessionName, text) => {
          if (!sessionManager.isSessionAlive(sessionName)) {
            console.warn(`[PromptGate] Skipping text injection — session "${sessionName}" is no longer alive`);
            return false;
          }
          return sessionManager.sendInput(sessionName, text);
        };
        telegram.onRelayLeaseStart = (sessionName) => {
          const sessions = sessionManager.listRunningSessions();
          const session = sessions.find(s => s.tmuxSession === sessionName);
          if (session) {
            const leaseMs = (promptGateConfig.relayTimeoutSeconds ?? 300) * 2 * 1000;
            sessionManager.grantRelayLease(session.id, leaseMs);
          }
        };
        telegram.onRelayLeaseEnd = (sessionName) => {
          const sessions = sessionManager.listRunningSessions();
          const session = sessions.find(s => s.tmuxSession === sessionName);
          if (session) {
            sessionManager.clearRelayLease(session.id);
          }
        };
        console.log(pc.green('  Prompt Gate: Telegram relay wired (via lifeline callback forwarding)'));
      }
    }

    if (telegramConfig && !skipTelegram && !isStandbyTelegram) {
      telegram = new TelegramAdapter(
        {
          ...(telegramConfig.config as any),
          // PR2: hot-reloadable accessors. Sending-side authoritative —
          // each send re-reads config so a canary flip lands without restart.
          getFormatMode: () =>
            (config as unknown as { telegramFormatMode?: 'plain' | 'html' | 'code' | 'markdown' | 'legacy-passthrough' })
              .telegramFormatMode,
          getLintStrict: () =>
            (config as unknown as { telegramLintStrict?: boolean }).telegramLintStrict,
        },
        config.stateDir,
      );
      telegram.intelligence = sharedIntelligence ?? null;
      await telegram.start();
      console.log(pc.green(`  Telegram connected (stall alerts: ${sharedIntelligence ? 'LLM-gated' : 'timer-only'})`));

      // Wire Prompt Gate callbacks — connect Telegram relay responses to sessions
      if (promptGateConfig?.enabled) {
        telegram.onPromptResponse = (sessionName, key) => {
          // Pre-injection verification: confirm session is still alive
          if (!sessionManager.isSessionAlive(sessionName)) {
            console.warn(`[PromptGate] Skipping injection — session "${sessionName}" is no longer alive`);
            return false;
          }
          // Also resolve any pending plan prompt for this session (unblocks the hook)
          resolvePlanPromptForSession(sessionName, key);
          return sessionManager.sendKey(sessionName, key);
        };
        telegram.onPromptTextResponse = (sessionName, text) => {
          // Pre-injection verification: confirm session is still alive
          if (!sessionManager.isSessionAlive(sessionName)) {
            console.warn(`[PromptGate] Skipping text injection — session "${sessionName}" is no longer alive`);
            return false;
          }
          return sessionManager.sendInput(sessionName, text);
        };
        telegram.onRelayLeaseStart = (sessionName) => {
          // Find the session by tmux name and grant a relay lease
          const sessions = sessionManager.listRunningSessions();
          const session = sessions.find(s => s.tmuxSession === sessionName);
          if (session) {
            const leaseMs = (promptGateConfig.relayTimeoutSeconds ?? 300) * 2 * 1000;
            sessionManager.grantRelayLease(session.id, leaseMs);
          }
        };
        telegram.onRelayLeaseEnd = (sessionName) => {
          const sessions = sessionManager.listRunningSessions();
          const session = sessions.find(s => s.tmuxSession === sessionName);
          if (session) {
            sessionManager.clearRelayLease(session.id);
          }
        };
        // Periodic relay timeout checker (every 60s)
        const relayPruneTimer = setInterval(() => {
          telegram!.pruneExpiredRelays().catch(err => {
            console.error(`[PromptGate] Relay prune error: ${err instanceof Error ? err.message : err}`);
          });
        }, 60_000);
        if (relayPruneTimer.unref) relayPruneTimer.unref();
        console.log(pc.green('  Prompt Gate: Telegram relay wired'));
      }

      // Wire NotificationBatcher to Telegram and start batching
      notificationBatcher.setSendFunction(
        async (topicId, text) => {
          await telegram!.sendToTopic(topicId, text);
          // NOTE: Batched notifications (SUMMARY/DIGEST) are NOT mirrored to Slack.
          // Only IMMEDIATE notifications reach Slack (via the notify() gateway).
          // This prevents notification spam in the attention channel.
          return { messageId: 0 };
        }
      );
      notificationBatcher.start();
      console.log(pc.green('  Notification batcher enabled (SUMMARY: 30m, DIGEST: 2h)'));

      // Set up account switcher (Keychain-based OAuth account swapping)
      const accountSwitcher = new AccountSwitcher();

      // Set up quota notifier (Telegram alerts on threshold crossings)
      const quotaNotifier = new QuotaNotifier(config.stateDir);
      const alertTopicId = state.get<number>('agent-attention-topic') ?? null;
      quotaNotifier.configure(
        async (_topicId, text) => {
          // Quota exhaustion is IMMEDIATE; warnings are SUMMARY
          const tier: NotificationTier = text.includes('EXHAUSTED') || text.includes('critical') ? 'IMMEDIATE' : 'SUMMARY';
          notify(tier, 'quota', text);
        },
        alertTopicId,
      );

      // Set up QuotaManager orchestration hub (Phase 4)
      if (quotaTracker) {
        // Try to set up the full collector-driven pipeline
        let collector: InstanceType<typeof import('../monitoring/QuotaCollector.js').QuotaCollector> | null = null;
        let migrator: InstanceType<typeof import('../monitoring/SessionMigrator.js').SessionMigrator> | null = null;

        try {
          const { QuotaCollector } = await import('../monitoring/QuotaCollector.js');
          const { createDefaultProvider } = await import('../monitoring/CredentialProvider.js');
          const provider = createDefaultProvider();
          collector = new QuotaCollector(provider, quotaTracker);
        } catch (err) {
          console.log(pc.yellow(`  QuotaCollector not available: ${err instanceof Error ? err.message : err}`));
        }

        try {
          const { SessionMigrator } = await import('../monitoring/SessionMigrator.js');
          migrator = new SessionMigrator({ stateDir: config.stateDir });
        } catch (err) {
          console.log(pc.yellow(`  SessionMigrator not available: ${err instanceof Error ? err.message : err}`));
        }

        quotaManager = new QuotaManager(
          { stateDir: config.stateDir },
          {
            tracker: quotaTracker,
            collector,
            switcher: accountSwitcher,
            migrator,
            notifier: quotaNotifier,
          },
        );

        // Wire session manager and scheduler for migration support
        quotaManager.setSessionManager(sessionManager);
        if (scheduler) {
          quotaManager.setScheduler(scheduler);
        }

        // Wire Telegram notifications
        quotaManager.setNotificationSender(async (message) => {
          const tier: NotificationTier = message.includes('❌') || message.includes('EXHAUSTED') ? 'IMMEDIATE' : 'SUMMARY';
          notify(tier, 'quota', message);
        });

        // Start adaptive polling (replaces the 10-min setInterval)
        quotaManager.start();
        console.log(pc.green('  QuotaManager started (adaptive polling, auto-migration)'));
      } else {
        console.log(pc.yellow('  QuotaManager skipped (no quota tracker)'));
      }

      // Initialize persistent UserManager for user identity resolution (Gap 8)
      const userManager = new UserManager(config.stateDir, config.users);

      // Fix command dependencies — populated later when subsystems initialize.
      // Uses a mutable ref so wireTelegramRouting can capture it in a closure now.
      _fixDeps = {
        state,
        liveConfig,
        sessionManager,
        telegram,
        config,
      };

      // Wire up topic → session routing and session management callbacks
      wireTelegramRouting(telegram, sessionManager, quotaTracker, topicMemory, userManager,
        (topicId, text) => handleFixCommand(topicId, text, _fixDeps!));
      wireTelegramCallbacks(telegram, sessionManager, state, quotaTracker, accountSwitcher, config.sessions.claudePath, topicMemory);

      // Wire up unknown-user handling (Multi-User Setup Wizard Phase 4.5)
      telegram.onGetRegistrationPolicy = () => ({
        policy: config.userRegistrationPolicy ?? 'admin-only',
        contactHint: config.registrationContactHint,
        agentName: config.projectName,
      });

      telegram.onNotifyAdminJoinRequest = async (request) => {
        const { JoinRequestManager } = await import('../users/UserOnboarding.js');
        const joinManager = new JoinRequestManager(config.stateDir);
        const joinRequest = joinManager.createRequest(
          request.name,
          request.telegramUserId,
          null, // agentAssessment — could be enhanced later with LLM evaluation
        );

        // Notify admin via Lifeline topic (the always-available admin channel)
        const lifelineTopicId = telegram!.getLifelineTopicId();
        if (lifelineTopicId) {
          const userLabel = request.username ? `@${request.username}` : request.name;
          await telegram!.sendToTopic(lifelineTopicId,
            `\ud83d\udc64 **Join Request** from ${userLabel} (ID: ${request.telegramUserId})\n\n` +
            `To approve: \`/approve ${joinRequest.approvalCode}\`\n` +
            `To deny: \`/deny ${joinRequest.approvalCode}\``,
          ).catch(() => {});
        }
      };

      telegram.onStartMiniOnboarding = async (telegramUserId, firstName, username) => {
        const { buildUserProfile, buildCondensedConsentDisclosure } = await import('../users/UserOnboarding.js');

        // Send consent disclosure first
        const consentText = buildCondensedConsentDisclosure(config.projectName);
        await telegram!.sendToTopic(1, consentText).catch(() => {}); // General topic

        // Build a basic profile (consent will be confirmed via follow-up reply)
        const profile = buildUserProfile({
          name: firstName,
          telegramUserId,
        });

        // Add to persistent UserManager (reuses the instance created above)
        userManager.upsertUser(profile);

        // Add to authorized user IDs so future messages are accepted
        const telegramConfig = config.messaging?.find(m => m.type === 'telegram');
        if (telegramConfig?.config) {
          const authIds = (telegramConfig.config.authorizedUserIds as number[]) ?? [];
          if (!authIds.includes(telegramUserId)) {
            authIds.push(telegramUserId);
            telegramConfig.config.authorizedUserIds = authIds;
          }
        }

        console.log(`[telegram] Mini-onboarding complete for ${firstName} (${telegramUserId})`);
      };

      console.log(pc.green('  Telegram message routing active'));

      if (scheduler) {
        scheduler.setMessenger(telegram);
        scheduler.setTelegram(telegram);
        if (topicMemory?.isReady()) {
          scheduler.setTopicMemory(topicMemory);
        }
      }

      // Ensure Agent Attention topic exists (the agent's direct line to the user)
      ensureAgentAttentionTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Attention topic: ${err}`);
      });

      // Ensure Agent Updates topic exists (informational updates, not critical)
      ensureAgentUpdatesTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Updates topic: ${err}`);
      });
    }

    // Initialize TopicMemory whenever Telegram is configured (any mode).
    // TopicMemory provides session context — needed even when lifeline owns polling.
    if (telegram) {
      topicMemory = new TopicMemory(config.stateDir);
      try {
        try {
          await topicMemory.open();
        } catch (openErr) {
          const reason = openErr instanceof Error ? openErr.message : String(openErr);
          const isBindingError = reason.includes('Could not locate the bindings file') ||
            reason.includes('better-sqlite3') ||
            reason.includes('was compiled against a different Node.js version');

          if (!isBindingError) throw openErr;

          console.log(pc.yellow('  TopicMemory: native binding mismatch — auto-rebuilding better-sqlite3...'));
          const fixScript = new URL('../../../scripts/fix-better-sqlite3.cjs', import.meta.url).pathname;
          if (fs.existsSync(fixScript)) {
            execFileSync(process.execPath, [fixScript], { encoding: 'utf-8', timeout: 60000, stdio: 'pipe' });
          } else {
            const npmCli = findNpmCli();
            const globalInstarDir = execFileSync(process.execPath, [npmCli, 'root', '-g'], { encoding: 'utf-8', timeout: 10000 }).toString().trim() + '/instar';
            execFileSync(process.execPath, [npmCli, 'rebuild', 'better-sqlite3'], {
              cwd: globalInstarDir,
              encoding: 'utf-8',
              timeout: 60000,
              stdio: 'pipe',
            });
          }
          console.log(pc.green('  TopicMemory: better-sqlite3 rebuilt successfully, retrying...'));

          topicMemory = new TopicMemory(config.stateDir);
          await topicMemory.open();
        }

        const jsonlPath = path.join(config.stateDir, 'telegram-messages.jsonl');
        if (fs.existsSync(jsonlPath)) {
          const imported = await topicMemory.importFromJsonl(jsonlPath);
          if (imported > 0) {
            console.log(pc.green(`  TopicMemory: imported ${imported} messages from JSONL`));
          }
        }

        const tmStats = topicMemory.stats();
        console.log(pc.green(`  TopicMemory: ${tmStats.totalMessages} messages, ${tmStats.totalTopics} topics, ${tmStats.topicsWithSummaries} summaries`));

        // Wire dual-write: every message logged to JSONL also goes to SQLite.
        // Includes sender identity for multi-user topic context (Phase 1D — User-Agent Topology Spec).
        const tm = topicMemory;
        telegram.onMessageLogged = (entry) => {
          if (entry.topicId != null && tm) {
            tm.insertMessage({
              messageId: entry.messageId,
              topicId: entry.topicId,
              text: entry.text,
              fromUser: entry.fromUser,
              timestamp: entry.timestamp,
              sessionName: entry.sessionName,
              senderName: entry.senderName,
              senderUsername: entry.senderUsername,
              telegramUserId: entry.telegramUserId,
            });
          }
        };
      } catch (err) {
        // @silent-fallback-ok — already uses DegradationReporter
        const reason = err instanceof Error ? err.message : String(err);
        topicMemory = undefined;

        degradationReporter.report({
          feature: 'TopicMemory',
          primary: 'SQLite-backed conversational memory with summaries and FTS5 search',
          fallback: 'JSONL-based last 20 messages (no summaries, no search)',
          reason: `TopicMemory init failed: ${reason}`,
          impact: 'Sessions start without conversation summaries. Search unavailable. Context limited to last 20 raw messages.',
        });
      }
    }

    // ── WhatsApp adapter initialization ──────────────────────────────
    let whatsappAdapter: import('../messaging/WhatsAppAdapter.js').WhatsAppAdapter | undefined;
    let whatsappBusinessBackend: import('../messaging/backends/BusinessApiBackend.js').BusinessApiBackend | undefined;
    let messageBridge: import('../messaging/shared/MessageBridge.js').MessageBridge | undefined;

    const whatsappConfig = config.messaging?.find(m => m.type === 'whatsapp' && m.enabled);
    if (whatsappConfig) {
      try {
        const { WhatsAppAdapter } = await import('../messaging/WhatsAppAdapter.js');
        whatsappAdapter = new WhatsAppAdapter(whatsappConfig.config as Record<string, unknown>, config.stateDir);
        await whatsappAdapter.start();

        const waConf = whatsappConfig.config as Record<string, unknown>;
        const backendType = (waConf.backend as string) ?? 'baileys';

        if (backendType === 'business-api') {
          const { BusinessApiBackend } = await import('../messaging/backends/BusinessApiBackend.js');
          const businessApiConf = waConf.businessApi as { phoneNumberId: string; accessToken: string; webhookVerifyToken: string; webhookPort?: number };
          whatsappBusinessBackend = new BusinessApiBackend(
            whatsappAdapter,
            businessApiConf,
            {
              onConnected: (phone) => console.log(pc.green(`  WhatsApp Business API connected: ${phone}`)),
              onMessage: async (jid: string, msgId: string, text: string, senderName?: string, timestamp?: number) => {
                await whatsappAdapter!.handleIncomingMessage(jid, msgId, text, senderName, timestamp);
              },
              onButtonReply: (_jid, _msgId, buttonId, _title) => {
                console.log(`[whatsapp] Button reply: ${buttonId}`);
              },
              onError: (err) => console.error(`[whatsapp] Business API error: ${err.message}`),
              onStatusUpdate: (_msgId, status) => {
                if (status === 'failed') console.warn(`[whatsapp] Message delivery failed`);
              },
            },
          );
          await whatsappBusinessBackend.connect();
          console.log(pc.green(`  WhatsApp Business API: webhook routes at /webhooks/whatsapp`));
        } else {
          // Baileys backend
          const { BaileysBackend } = await import('../messaging/backends/BaileysBackend.js');
          const baileysConfig = whatsappAdapter.getBaileysConfig();
          const baileysBackend = new BaileysBackend(
            whatsappAdapter,
            baileysConfig,
            {
              onQrCode: (qr) => console.log(`[whatsapp] QR code: ${qr.substring(0, 20)}...`),
              onPairingCode: (code) => console.log(`[whatsapp] Pairing code: ${code}`),
              onConnected: (phone) => console.log(pc.green(`  WhatsApp (Baileys) connected: ${phone}`)),
              onDisconnected: (reason, shouldReconnect) => {
                console.log(`[whatsapp] Disconnected: ${reason}${shouldReconnect ? ' (reconnecting)' : ''}`);
              },
              onMessage: async (jid, msgId, text, senderName, timestamp, msgKey, participant, mentionedJids) => {
                await whatsappAdapter!.handleIncomingMessage(jid, msgId, text, senderName, timestamp, msgKey, participant, mentionedJids);
              },
              onError: (err) => console.error(`[whatsapp] Baileys error: ${err.message}`),
            },
          );
          await baileysBackend.connect();
        }

        // Wire WhatsApp → Claude session routing
        wireWhatsAppRouting(whatsappAdapter, sessionManager);
        console.log(pc.green('  WhatsApp message routing: wired'));

        // Wire cross-platform alerts if both adapters are available
        if (telegram && whatsappAdapter) {
          const { CrossPlatformAlerts } = await import('../messaging/shared/CrossPlatformAlerts.js');
          const crossAlerts = new CrossPlatformAlerts({
            telegram,
            whatsapp: whatsappAdapter,
            businessApiBackend: whatsappBusinessBackend,
            getAlertTopicId: () => state.get<number>('agent-attention-topic') ?? null,
          });
          crossAlerts.start();
          console.log(pc.green('  Cross-platform alerts: WhatsApp <-> Telegram'));

          // Wire message bridge for cross-platform message forwarding
          try {
            const { MessageBridge } = await import('../messaging/shared/MessageBridge.js');
            messageBridge = new MessageBridge({
              registryPath: path.join(config.stateDir ?? '.instar/state', 'bridge-registry.json'),
              whatsappEventBus: whatsappAdapter.getEventBus() ?? undefined,
              telegramEventBus: telegram.getEventBus() ?? undefined,
              sendToTelegram: async (topicId, text) => {
                await telegram.sendToTopic(topicId, text);
              },
              sendToWhatsApp: async (jid, text) => {
                await whatsappAdapter!.send({
                  content: text,
                  userId: jid,
                  channel: { type: 'whatsapp', identifier: jid },
                });
              },
            });
            messageBridge.start();
            console.log(pc.green('  Message bridge: WhatsApp <-> Telegram'));
          } catch (bridgeErr) {
            console.error(`  Message bridge init failed: ${bridgeErr}`);
          }
        }

        console.log(pc.green(`  WhatsApp adapter: ${backendType} backend`));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`  WhatsApp init failed: ${reason}`));
        whatsappAdapter = undefined;
        whatsappBusinessBackend = undefined;

        degradationReporter.report({
          feature: 'WhatsApp',
          primary: 'WhatsApp messaging adapter',
          fallback: 'Telegram only',
          reason: `WhatsApp init failed: ${reason}`,
          impact: 'WhatsApp messaging unavailable. Telegram continues working.',
        });
      }
    }

    // ── Slack adapter initialization ─────────────────────────────────
    let slackAdapter: import('../messaging/slack/SlackAdapter.js').SlackAdapter | undefined;

    const slackConfig = config.messaging?.find(m => m.type === 'slack' && m.enabled);
    if (slackConfig) {
      try {
        const { SlackAdapter } = await import('../messaging/slack/index.js');
        slackAdapter = new SlackAdapter(slackConfig.config as Record<string, unknown>, config.stateDir);

        // Wire message handler — inject Slack messages into sessions
        slackAdapter.onMessage(async (message) => {
          const channelId = message.channel.identifier;
          const isDM = message.metadata?.isDM as boolean;
          const senderName = message.metadata?.senderName as string || 'User';

          // Sentinel intercept — classify message for emergency stop/pause
          if (sentinel) {
            try {
              const classification = await sentinel.classify(message.content);
              if (classification.category === 'emergency-stop') {
                // Kill all sessions
                const sessions = sessionManager.listRunningSessions();
                for (const s of sessions) {
                  try { sessionManager.killSession(s.id); } catch { /* ok */ }
                }
                slackAdapter!.sendToChannel(channelId, '🛑 Emergency stop — all sessions killed.').catch(() => {});
                return;
              } else if (classification.category === 'pause') {
                const existingSession = slackAdapter!.getSessionForChannel(channelId);
                if (existingSession) {
                  sessionManager.sendKey(existingSession, 'Escape');
                  slackAdapter!.sendToChannel(channelId, '⏸️ Session paused.').catch(() => {});
                }
                return;
              }
            } catch { /* fail-open — if Sentinel errors, process message normally */ }
          }

          // Build injection tag with sender info (matches Telegram's buildInjectionTag pattern)
          const slackUserId = message.metadata?.slackUserId as string;
          // Sanitize sender name at injection boundary (prevents injection attacks)
          const safeSenderName = senderName
            ? senderName.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').replace(/["\[\]]/g, '').trim().slice(0, 64) || 'User'
            : undefined;
          let prefix = `[slack:${channelId}]`;
          if (safeSenderName && slackUserId) {
            prefix = `[slack:${channelId} from ${safeSenderName} (uid:${slackUserId})]`;
          } else if (safeSenderName) {
            prefix = `[slack:${channelId} from ${safeSenderName}]`;
          }

          // Build context for the session — inject inline like Telegram does
          // Use async fallback to fetch from Slack API if ring buffer is empty
          const tmpDir = '/tmp/instar-slack';
          fs.mkdirSync(tmpDir, { recursive: true });
          const history = await slackAdapter!.getChannelMessagesWithFallback(channelId, 30);
          const unansweredCount = slackAdapter!.getUnansweredCount(channelId);

          const botUserId = slackAdapter!.getBotUserId?.() ?? null;

          // Build human-readable thread history (matches Telegram's inline context pattern)
          const contextLines: string[] = [];
          if (history.length > 0) {
            contextLines.push('CONTINUATION — You are resuming an EXISTING Slack conversation. Read the context below before responding. Do NOT ask what was being discussed.');
            contextLines.push('');
            contextLines.push(`--- Thread History (last ${history.length} messages) ---`);
            contextLines.push('IMPORTANT: Read this history carefully before taking any action.');
            contextLines.push('Your task is to continue THIS conversation, not start something new.');
            contextLines.push(`Channel: ${channelId}`);
            contextLines.push('');
            for (const m of history) {
              const date = new Date(parseFloat(m.ts) * 1000);
              const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
              const isBot = botUserId && m.user === botUserId;
              const label = isBot ? 'Agent' : (senderName || m.user);
              contextLines.push(`[${time}] ${label}: ${m.text}`);
            }
            contextLines.push('');
            contextLines.push('--- End Thread History ---');
          } else {
            console.warn(`[slack→context] No history available for channel ${channelId} — session starts without thread context`);
          }
          contextLines.push('');
          contextLines.push('CRITICAL: You MUST relay your response back to Slack after responding.');
          contextLines.push('Use the relay script (write ONLY your reply text — do NOT pipe or cat this file into the script):');
          contextLines.push('');
          contextLines.push(`cat <<'EOF' | .claude/scripts/slack-reply.sh ${channelId}`);
          contextLines.push('Your response text here');
          contextLines.push('EOF');
          contextLines.push('');
          contextLines.push('Strip the [slack:] prefix before interpreting the message.');
          contextLines.push('Only relay conversational text — not tool output, file contents, or internal reasoning.');

          const contextData = contextLines.join('\n');

          // Also write to file as backup reference
          const ctxPath = path.join(tmpDir, `ctx-${channelId}-${Date.now()}.txt`);
          fs.writeFileSync(ctxPath, contextData);

          // Transform [image:path] and [document:path] tags into explicit read instructions
          let transformedContent = message.content.replace(
            /\[image:([^\]]+)\]/g,
            (_, imagePath: string) => {
              if (imagePath === 'download-failed') {
                return '[User sent a photo but the download failed]';
              }
              return `[User sent a photo — read the image file at ${imagePath} to view it. If the image cannot be processed, acknowledge you received it and describe what you can see, or let the user know the image format may not be supported.]`;
            },
          ).replace(
            /\[document:([^\]]+)\]/g,
            (_, docPath: string) => {
              if (docPath === 'download-failed') {
                return '[User sent a file but the download failed]';
              }
              return `[User sent a file — it has been saved to ${docPath}. Read the file to view its contents]`;
            },
          );

          // Inject context INLINE in the bootstrap message (matches Telegram pattern).
          // This ensures the agent sees thread history immediately without needing to read a file.
          const fullMessage = `${prefix} ${transformedContent} (IMPORTANT: Read ${ctxPath} for thread history and Slack relay instructions — you MUST relay your response back.)`;

          // Large bootstrap messages: write to file with INLINE context included
          const FILE_THRESHOLD = 500;
          let bootstrapMessage: string;
          if (fullMessage.length > FILE_THRESHOLD) {
            // Write full message + inline context to the file so agent gets everything in one read
            const msgFilePath = path.join(tmpDir, `msg-${channelId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`);
            const fullContent = `${fullMessage}\n\n${contextData}`;
            fs.writeFileSync(msgFilePath, fullContent);
            bootstrapMessage = `${prefix} [Long message saved to ${msgFilePath} — read it to see the full message and thread history]`;
          } else {
            bootstrapMessage = fullMessage;
          }

          // Check for existing session bound to this channel
          const existingSession = slackAdapter!.getSessionForChannel(channelId);
          if (existingSession) {
            // Try to inject into existing session via tmux
            const sessions = sessionManager.listRunningSessions();
            const alive = sessions.find(s => s.tmuxSession === existingSession);
            if (alive) {
              console.log(`[slack→session] Injecting into ${existingSession}: "${message.content.slice(0, 80)}"`);
              // Wait for Claude to be ready (handles race with recently spawned sessions)
              const ready = await sessionManager.waitForClaudeReady(existingSession, 15000);
              if (!ready) {
                // Session is stuck (permissions prompt, tool hang, etc.)
                // Kill it and fall through to spawn a fresh session — never silently lose messages
                console.warn(`[slack→session] Session ${existingSession} not ready after 15s — killing and respawning`);
                try {
                  const stuckSession = sessionManager.listRunningSessions().find(s => s.tmuxSession === existingSession);
                  if (stuckSession) {
                    sessionManager.killSession(stuckSession.id);
                  }
                } catch { /* ok if already dead */ }
                // Fall through to respawn below — registerChannelSession will be called with new session name
              } else {
                // Session is ready — inject via SessionManager (handles idle timer reset + bracketed paste)
                try {
                  sessionManager.injectMessage(existingSession, bootstrapMessage);
                  // Track for stall detection
                  slackAdapter!.trackMessageInjection(channelId, existingSession, message.content);
                  // Delivery confirmation via reaction only (no text message — the ✅ reaction is sufficient)
                } catch (injectErr) {
                  console.error(`[slack→session] Injection failed: ${injectErr instanceof Error ? injectErr.message : injectErr}`);
                }
                return;
              }
            }
            console.log(`[slack→session] Session "${existingSession}" died, respawning...`);
          }

          // Check resume map for session continuity
          const resumeInfo = slackAdapter!.getChannelResume(channelId);
          const resumeSessionId = resumeInfo?.uuid ?? undefined;
          if (resumeInfo) {
            slackAdapter!.removeChannelResume(channelId);
          }

          // Route: DMs go to lifeline session, channels spawn new sessions
          const targetSession = isDM ? 'lifeline' : undefined;
          try {
            const newSessionName = await sessionManager.spawnInteractiveSession(
              bootstrapMessage,
              targetSession,
              { resumeSessionId, slackChannelId: channelId },
            );
            if (newSessionName) {
              slackAdapter!.registerChannelSession(channelId, newSessionName);
              slackAdapter!.trackMessageInjection(channelId, newSessionName, message.content);
              console.log(`[slack→session] ${resumeSessionId ? 'Resumed' : 'Spawned'} "${newSessionName}" for channel ${channelId}`);
            }
          } catch (err) {
            console.error(`[slack] Session spawn failed: ${err instanceof Error ? err.message : err}`);
          }
        });

        await slackAdapter.start();
        _slackAdapter = slackAdapter;
        console.log(pc.green(`  Slack connected (workspace: ${(slackConfig.config as Record<string, unknown>).workspaceName || 'unknown'})`));

        // Ensure Slack system channels exist
        ensureSlackAttentionChannel(slackAdapter, state).catch(err => {
          console.error(`[server] Failed to ensure Slack Attention channel: ${err}`);
        });
        ensureSlackUpdatesChannel(slackAdapter, state).catch(err => {
          console.error(`[server] Failed to ensure Slack Updates channel: ${err}`);
        });

        // Wire stall detection — route stall alerts to Slack attention channel
        slackAdapter.onStallDetected = (channelId, sessionName, messageText, injectedAt) => {
          const slackAttentionChannel = state.get<string>('slack-attention-channel');
          if (slackAttentionChannel) {
            slackAdapter!.sendToChannel(slackAttentionChannel,
              `⚠️ Stall detected in session "${sessionName}" (channel ${channelId}). Message may not have been answered: "${messageText.slice(0, 100)}"`
            ).catch(() => {});
          }
          // Also notify in the originating channel
          slackAdapter!.sendToChannel(channelId,
            `⚠️ The session appears to have stalled. Use \`!restart\` to restart or \`!interrupt\` to nudge it.`
          ).catch(() => {});
        };

        // Wire voice transcription (reuses Telegram's provider resolution: Groq → OpenAI)
        slackAdapter.transcribeVoice = async (filePath: string) => {
          const providers: Record<string, { envKey: string; baseUrl: string; model: string }> = {
            groq: { envKey: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
            openai: { envKey: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
          };
          let provider: { apiKey: string; baseUrl: string; model: string } | null = null;
          const explicit = (slackConfig.config as Record<string, unknown>).audioTranscriptionProvider as string;
          if (explicit && providers[explicit.toLowerCase()]) {
            const p = providers[explicit.toLowerCase()];
            const apiKey = process.env[p.envKey];
            if (apiKey) provider = { apiKey, baseUrl: p.baseUrl, model: p.model };
          }
          if (!provider) {
            for (const [, p] of Object.entries(providers)) {
              const apiKey = process.env[p.envKey];
              if (apiKey) { provider = { apiKey, baseUrl: p.baseUrl, model: p.model }; break; }
            }
          }
          if (!provider) throw new Error('No voice transcription provider. Set GROQ_API_KEY or OPENAI_API_KEY.');

          const formData = new FormData();
          const fileBuffer = fs.readFileSync(filePath);
          const blob = new Blob([fileBuffer], { type: 'audio/ogg' });
          formData.append('file', blob, path.basename(filePath));
          formData.append('model', provider.model);

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 60_000);
          try {
            const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${provider.apiKey}` },
              body: formData,
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`Transcription API error (${response.status}): ${await response.text()}`);
            const data = await response.json() as { text: string };
            return data.text;
          } finally {
            clearTimeout(timer);
          }
        };

        // Wire intelligence provider for LLM-gated stall confirmation
        if (sharedIntelligence) {
          slackAdapter.intelligence = sharedIntelligence;
        }

        // Start stall detection timer (with promise tracking)
        const stallTimeout = (slackConfig.config as Record<string, unknown>).stallTimeoutMinutes as number ?? 5;
        const promiseTimeout = (slackConfig.config as Record<string, unknown>).promiseTimeoutMinutes as number ?? 10;
        if (stallTimeout > 0) {
          slackAdapter.startStallDetection(stallTimeout * 60 * 1000, promiseTimeout * 60 * 1000);
        }

        // Wire session management callbacks for slash commands
        slackAdapter.onInterruptSession = async (sessionName) => {
          return sessionManager.sendKey(sessionName, 'Escape');
        };
        slackAdapter.onRestartSession = async (sessionName, channelId) => {
          try {
            const stuckSession = sessionManager.listRunningSessions().find(s => s.tmuxSession === sessionName);
            if (stuckSession) {
              sessionManager.killSession(stuckSession.id);
            }
          } catch { /* ok if already dead */ }
        };
        slackAdapter.onListSessions = () => {
          return sessionManager.listRunningSessions().map(s => ({
            name: s.name,
            tmuxSession: s.tmuxSession,
            status: s.status,
            alive: sessionManager.isSessionAlive(s.tmuxSession),
          }));
        };
        slackAdapter.onIsSessionAlive = (tmuxSession) => {
          return sessionManager.isSessionAlive(tmuxSession);
        };

        // Wire prompt response callback — inject button presses into sessions
        slackAdapter.onPromptResponse = (channelId, promptId, value) => {
          // Look up which session is bound to this channel
          const sessionName = slackAdapter!.getSessionForChannel(channelId);
          if (!sessionName) {
            console.warn(`[slack] Prompt response for channel ${channelId} but no session bound`);
            return;
          }
          if (!sessionManager.isSessionAlive(sessionName)) {
            console.warn(`[slack] Prompt response for dead session "${sessionName}"`);
            return;
          }
          sessionManager.sendKey(sessionName, value);
          console.log(`[slack] Prompt response injected: session="${sessionName}" key="${value}"`);
        };

        // Standby commands and triage status will be wired after PresenceProxy/TriageOrchestrator (below)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`  Slack init failed: ${reason}`));
        slackAdapter = undefined;

        degradationReporter.report({
          feature: 'Slack',
          primary: 'Slack messaging adapter',
          fallback: 'Other messaging channels',
          reason: `Slack init failed: ${reason}`,
          impact: 'Slack messaging unavailable.',
        });
      }
    }

    // ── iMessage adapter initialization ────────────────────────────────
    let imessageAdapter: import('../messaging/imessage/IMessageAdapter.js').IMessageAdapter | undefined;

    const imessageConfig = config.messaging?.find(m => m.type === 'imessage' && m.enabled);
    if (imessageConfig) {
      try {
        const { IMessageAdapter } = await import('../messaging/imessage/index.js');
        imessageAdapter = new IMessageAdapter(imessageConfig.config as Record<string, unknown>, config.stateDir);

        // Wire session routing (following Telegram/WhatsApp pattern)
        wireIMessageRouting(imessageAdapter, sessionManager);

        // Set agent name for mention-based triggering
        const imAgentName = (imessageConfig.config as any)?.agentName || config.projectName;
        if (imAgentName) imessageAdapter.setAgentName(imAgentName);

        await imessageAdapter.start();
        const triggerInfo = imessageAdapter.getTriggerMode() === 'mention'
          ? `trigger: @${imAgentName}`
          : 'trigger: all messages';
        console.log(pc.green(`  iMessage adapter: connected (${triggerInfo})`));
        console.log(pc.green('  iMessage message routing: wired'));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`  iMessage init failed: ${reason}`));
        imessageAdapter = undefined;

        degradationReporter.report({
          feature: 'iMessage',
          primary: 'iMessage messaging adapter',
          fallback: 'Other messaging channels',
          reason: `iMessage init failed: ${reason}`,
          impact: 'iMessage messaging unavailable.',
        });
      }
    }

    // Initialize SemanticMemory — the knowledge graph that unifies all memory systems.
    // Uses the same better-sqlite3 as TopicMemory; shares the rebuild path.
    let semanticMemory: SemanticMemory | undefined;
    try {
      semanticMemory = new SemanticMemory({
        dbPath: path.join(config.stateDir, 'semantic.db'),
        decayHalfLifeDays: 30,
        lessonDecayHalfLifeDays: 90,
        staleThreshold: 0.2,
      });
      await semanticMemory.open();
      const smStats = semanticMemory.stats();
      console.log(pc.green(`  SemanticMemory: ${smStats.totalEntities} entities, ${smStats.totalEdges} edges`));

      // Phase 5: Hybrid Search — attach EmbeddingProvider for vector-enhanced search.
      // Loads all-MiniLM-L6-v2 (~80MB ONNX model, cached after first download) and
      // sqlite-vec extension for KNN queries alongside FTS5.
      // Graceful degradation: if either fails, SemanticMemory continues FTS5-only.
      try {
        const { EmbeddingProvider } = await import('../memory/EmbeddingProvider.js');
        const embeddingProvider = new EmbeddingProvider();
        const vecModuleLoaded = await embeddingProvider.loadVecModule();
        if (vecModuleLoaded) {
          semanticMemory.setEmbeddingProvider(embeddingProvider);
          const vecReady = await semanticMemory.initializeVectorSearch();
          if (vecReady) {
            // Initialize model in background — don't block server startup
            embeddingProvider.initialize().then(() => {
              const updatedStats = semanticMemory!.stats();
              console.log(pc.green(`  Vector search: ready (${updatedStats.embeddingCount ?? 0}/${updatedStats.totalEntities} embeddings)`));
            }).catch((modelErr) => { // @silent-fallback-ok: embedding model load is non-blocking, FTS5-only degradation logged
              console.log(pc.yellow(`  Vector search: model load failed (${modelErr instanceof Error ? modelErr.message : String(modelErr)}). FTS5-only mode.`));
            });
          } else {
            console.log(pc.yellow('  Vector search: sqlite-vec extension failed to initialize. FTS5-only mode.'));
          }
        } else {
          console.log(pc.yellow('  Vector search: sqlite-vec not available. FTS5-only mode.'));
        }
      } catch (vecErr) { // @silent-fallback-ok: vector search is optional enhancement, FTS5-only degradation logged
        console.log(pc.yellow(`  Vector search: ${vecErr instanceof Error ? vecErr.message : String(vecErr)}. FTS5-only mode.`));
      }
    } catch (err) {
      let reason = err instanceof Error ? err.message : String(err);
      semanticMemory = undefined;
      // Add actionable guidance for disk I/O errors (SQLITE_IOERR) — disk full or failing
      if (reason.toLowerCase().includes('disk i/o') || reason.includes('SQLITE_IOERR')) {
        reason += '. Likely cause: disk full or filesystem error. Diagnose: run `df -h` to check disk usage and free space if needed. Semantic.db path: ' + path.join(config.stateDir, 'semantic.db');
      }
      DegradationReporter.getInstance().report({
        feature: 'SemanticMemory',
        primary: 'SQLite-backed knowledge graph with FTS5 + vector hybrid search',
        fallback: 'Legacy memory systems (MEMORY.md, CanonicalState, MemoryIndex)',
        reason: `SemanticMemory init failed: ${reason}`,
        impact: 'Knowledge graph unavailable. Migration, semantic search, and entity-relationship queries disabled.',
      });
    }

    // Fast startup purge — remove session records for dead tmux sessions BEFORE
    // monitoring starts. Prevents the death spiral where stale sessions overwhelm
    // the health endpoint (synchronous tmux has-session calls) and cause the
    // lifeline to restart the server in a tight loop.
    await sessionManager.purgeDeadSessions();

    sessionManager.startMonitoring();

    // Proactive resume heartbeat: every 60s, update the topic→UUID mapping
    // for all active topic-linked sessions. Ensures crash recovery via --resume.
    if (_topicResumeMap && (telegram || _slackAdapter)) {
      const resumeHeartbeatInterval = setInterval(() => {
        try {
          const enriched = new Map<number, { sessionName: string; claudeSessionId?: string }>();

          // Telegram topic-session mappings
          if (telegram) {
            const topicSessions = telegram.getAllTopicSessions();
            for (const [topicId, sessionName] of topicSessions) {
              const sessions = sessionManager.listRunningSessions();
              const session = sessions.find(s => s.tmuxSession === sessionName);
              enriched.set(topicId, {
                sessionName,
                claudeSessionId: session?.claudeSessionId ?? undefined,
              });
            }
          }

          // Slack channel-session mappings (use synthetic IDs for compatibility)
          if (_slackAdapter) {
            const registry = _slackAdapter.getChannelRegistry();
            const runningSessions = sessionManager.listRunningSessions();
            for (const [channelId, entry] of Object.entries(registry)) {
              const syntheticId = slackChannelToSyntheticId(channelId);
              const session = runningSessions.find(s => s.tmuxSession === entry.sessionName);
              enriched.set(syntheticId, {
                sessionName: entry.sessionName,
                claudeSessionId: session?.claudeSessionId ?? undefined,
              });

              // Also save to the Slack-specific resume map so that
              // getChannelResume() finds the UUID on next message.
              // refreshResumeMappings only writes to topic-resume-map.json
              // (keyed by synthetic numeric ID), but Slack message handling
              // reads from slack-channel-resume-map.json (keyed by channel ID).
              // ONLY use authoritative claudeSessionId — never mtime fallback,
              // which can cross-contaminate when multiple sessions are active.
              if (session?.claudeSessionId && _topicResumeMap!.jsonlExistsPublic(session.claudeSessionId)) {
                _slackAdapter.saveChannelResume(channelId, session.claudeSessionId, entry.sessionName);
              }
            }
          }

          _topicResumeMap?.refreshResumeMappings(enriched);
        } catch (err) {
          console.error('[server] Resume heartbeat error:', err);
        }
      }, 60_000);
      // Don't prevent process exit
      resumeHeartbeatInterval.unref();
      console.log(pc.green('  Resume heartbeat: active (60s interval)'));
    }

    // Save Claude session UUID before any session kill so the topic can be
    // resumed later with --resume. This fires BEFORE the tmux session is
    // destroyed, so the UUID can still be discovered from the JSONL mtime.
    if (_topicResumeMap) {
      sessionManager.on('beforeSessionKill', (session: import('../core/types.js').Session) => {
        try {
          // Save Telegram topic resume UUID (if Telegram is configured)
          // Skip for context exhaustion kills — re-saving would cause a death loop
          if (telegram && !contextExhaustionKills.has(session.tmuxSession)) {
            const topicId = telegram!.getTopicForSession(session.tmuxSession);
            if (topicId) {
              const uuid = _topicResumeMap!.findUuidForSession(session.tmuxSession, session.claudeSessionId ?? undefined);
              if (uuid) {
                _topicResumeMap!.save(topicId, uuid, session.tmuxSession);
                console.log(`[beforeSessionKill] Saved resume UUID ${uuid} for topic ${topicId} (session: ${session.name}, source: ${session.claudeSessionId ? 'hook' : 'mtime'})`);
              }
            }
          }

          // Save Slack channel resume UUID (if Slack is configured)
          // Skip if the session is being killed for context exhaustion — saving the UUID
          // would cause a death loop where the next respawn loads the same bloated conversation.
          if (_slackAdapter && !contextExhaustionKills.has(session.tmuxSession)) {
            const channelId = _slackAdapter.getChannelForSession(session.tmuxSession);
            if (channelId) {
              const uuid = _topicResumeMap!.findUuidForSession(session.tmuxSession, session.claudeSessionId ?? undefined);
              if (uuid) {
                _slackAdapter.saveChannelResume(channelId, uuid, session.tmuxSession);
                console.log(`[beforeSessionKill] Saved Slack resume UUID ${uuid} for channel ${channelId} (session: ${session.name})`);
              }
            }
          } else if (contextExhaustionKills.has(session.tmuxSession)) {
            console.log(`[beforeSessionKill] Skipping Slack resume UUID save for ${session.name} — context exhaustion recovery`);
          }
        } catch (err) {
          console.error(`[beforeSessionKill] Failed to save resume UUID:`, err);
        }
      });

      // Auto-respawn sessions that die with unanswered Telegram injections.
      // When a session crashes or is cleaned up before replying, re-forward the
      // user's message so it gets a fresh session and a response.
      sessionManager.on('injectionDropped', (info: { topicId: number; sessionName: string; text: string; injectedAt: number }) => {
        const elapsed = Date.now() - info.injectedAt;
        // Only respawn if the injection is recent (< 10 minutes old).
        // Stale injections may have been superseded by newer messages.
        if (elapsed > 10 * 60_000) {
          console.log(`[injectionDropped] Skipping respawn for topic ${info.topicId} — injection is ${Math.round(elapsed / 60_000)}m old`);
          return;
        }
        console.log(`[injectionDropped] Session "${info.sessionName}" died with unanswered message for topic ${info.topicId}. Triggering respawn.`);
        // Re-trigger the telegram-forward endpoint internally using fetch
        fetch(`http://localhost:${config.port}/internal/telegram-forward`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.authToken}`,
          },
          body: JSON.stringify({ topicId: info.topicId, text: info.text, fromFirstName: 'User' }),
        }).then(async (res) => {
          if (res.ok) {
            console.log(`[injectionDropped] Respawn successful for topic ${info.topicId}`);
          } else {
            const body = await res.text().catch(() => '');
            console.error(`[injectionDropped] Respawn failed (${res.status}): ${body}`);
          }
        }).catch((err: Error) => {
          console.error(`[injectionDropped] Respawn request failed:`, err.message);
        });
      });
    }

    if (scheduler) {
      sessionManager.on('sessionComplete', (session) => {
        scheduler!.processQueue();
        scheduler!.notifyJobComplete(session.id, session.tmuxSession);
        // Record telemetry events
        if (telemetryHeartbeat && session.jobSlug) {
          telemetryHeartbeat.recordJobRun();
        }
      });
    }

    // Wire telemetry counters
    if (telemetryHeartbeat) {
      sessionManager.on('sessionStart', () => {
        telemetryHeartbeat!.recordSessionSpawned();
      });
    }

    // Auto-summarize topics on session completion.
    // When a Telegram-linked session ends, check if its topic needs a summary update.
    // Uses Haiku for cost efficiency — summaries don't need deep reasoning.
    if (topicMemory && telegram) {
      const { TopicSummarizer } = await import('../memory/TopicSummarizer.js');
      const { ClaudeCliIntelligenceProvider } = await import('../core/ClaudeCliIntelligenceProvider.js');
      const summaryIntelligence = new ClaudeCliIntelligenceProvider(config.sessions.claudePath);
      const summarizer = new TopicSummarizer(summaryIntelligence, topicMemory);

      sessionManager.on('sessionComplete', (session) => {
        // Find the topic linked to this session
        const sessionTopicId = telegram!.getTopicForSession(session.tmuxSession);
        if (!sessionTopicId) return;

        // Check if this topic needs a summary update (async, fire-and-forget)
        summarizer.summarize(sessionTopicId).then((result) => {
          if (result) {
            console.log(`[TopicSummarizer] Updated summary for topic ${sessionTopicId}: ${result.messagesProcessed} messages processed in ${result.durationMs}ms`);
          }
        }).catch((err) => {
          console.error(`[TopicSummarizer] Failed for topic ${sessionTopicId}: ${err instanceof Error ? err.message : err}`);
        });
      });
      console.log(pc.green('  Topic auto-summarization enabled (on session end)'));
    }

    // Session Activity Sentinel — episodic memory digestion.
    // Creates mid-session mini-digests via LLM, and session syntheses on completion.
    let activitySentinel: import('../monitoring/SessionActivitySentinel.js').SessionActivitySentinel | undefined;
    if (sharedIntelligence) {
      const { SessionActivitySentinel } = await import('../monitoring/SessionActivitySentinel.js');
      activitySentinel = new SessionActivitySentinel({
        stateDir: config.stateDir,
        intelligence: sharedIntelligence,
        getActiveSessions: () => sessionManager.listRunningSessions(),
        captureSessionOutput: (tmuxSession) => sessionManager.captureOutput(tmuxSession),
        getTelegramMessages: telegram
          ? (topicId, since) => telegram!.searchLog({
              topicId,
              since: since ? new Date(since) : undefined,
              limit: 200,
            })
          : undefined,
        getTopicForSession: telegram
          ? (tmuxSession) => telegram!.getTopicForSession(tmuxSession)
          : undefined,
      });

      sessionManager.on('sessionComplete', (session) => {
        activitySentinel!.synthesizeSession(session).then((report) => {
          if (report.synthesisCreated) {
            console.log(`[ActivitySentinel] Session synthesis created for ${session.name}: ${report.digestCount} digests`);
          }
        }).catch((err) => {
          console.error(`[ActivitySentinel] Synthesis failed for ${session.name}: ${err instanceof Error ? err.message : err}`);
        });
      });

      console.log(pc.green('  Episodic memory sentinel enabled (LLM-powered digestion)'));
    }

    // Session Watchdog — auto-remediation for stuck commands
    let watchdog: SessionWatchdog | undefined;
    if (config.monitoring.watchdog?.enabled) {
      watchdog = new SessionWatchdog(config, sessionManager, state);
      watchdog.intelligence = sharedIntelligence ?? null;

      watchdog.on('intervention', (event: any) => {
        // Routine recovery (Ctrl+C, SIGTERM) stays as console diagnostics only.
        // The user only hears when we had to force-kill (SIGKILL / session-kill) —
        // that's the "actual issue" threshold. See watchdog-notifications.ts.
        const userMsg = formatWatchdogUserMessage(event);
        if (!userMsg) return;

        if (telegram) {
          const topicId = telegram.getTopicForSession(event.sessionName);
          if (topicId) telegram.sendToTopic(topicId, userMsg).catch(() => {});
        }
        if (_slackAdapter) {
          const channelId = _slackAdapter.getChannelForSession(event.sessionName);
          if (channelId) _slackAdapter.sendToChannel(channelId, userMsg).catch(() => {});
        }
      });

      // Recovery events stay silent to the user. If we didn't announce the
      // problem (Ctrl+C / SIGTERM are now silent), announcing recovery is
      // noise. Intervention log still records it for diagnostics.

      watchdog.start();
      console.log(pc.green('  Session Watchdog enabled'));
    }

    // StallTriageNurse — LLM-powered session recovery (uses shared intelligence)
    // Platform-aware: works with Telegram topics AND Slack channels
    let triageNurse: StallTriageNurse | undefined;
    if (config.monitoring.triage?.enabled && (telegram || _slackAdapter)) {
      triageNurse = new StallTriageNurse(
        {
          captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          sendKey: (name, key) => sessionManager.sendKey(name, key),
          sendInput: (name, text) => sessionManager.sendInput(name, text),
          getTopicHistory: (topicId, limit) => {
            // Check if this is a Slack synthetic ID
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              const msgs = _slackAdapter.getChannelMessages(slackChId, limit);
              return msgs.map(m => ({ text: m.text, fromUser: true, timestamp: new Date(parseFloat(m.ts) * 1000).toISOString() }));
            }
            if (telegram) {
              const entries = telegram.getTopicHistory(topicId, limit);
              return entries.map(e => ({ text: e.text, fromUser: e.fromUser, timestamp: e.timestamp }));
            }
            return [];
          },
          sendToTopic: async (topicId, text) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              // Never send monitoring messages to system channels (dashboard, lifeline)
              if (_slackAdapter.isSystemChannel(slackChId)) return;
              await _slackAdapter.sendToChannel(slackChId, text);
              return;
            }
            if (telegram) await telegram.sendToTopic(topicId, text);
          },
          respawnSession: (name, topicId, options) => {
            if (telegram) {
              return respawnSessionForTopic(sessionManager, telegram, name, topicId, undefined, topicMemory, undefined, undefined, options);
            }
            // Slack respawn: kill and let next message trigger fresh session
            const stuckSession = sessionManager.listRunningSessions().find(s => s.tmuxSession === name);
            if (stuckSession) sessionManager.killSession(stuckSession.id);
            return Promise.resolve();
          },
          clearStallForTopic: (topicId) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              _slackAdapter.clearStallTracking(slackChId);
              return;
            }
            if (telegram) telegram.clearStallTracking(topicId);
          },
        },
        {
          config: config.monitoring.triage,
          state,
          intelligence: sharedIntelligence,
        },
      );

      // Wire nurse into stall detection — both Telegram and Slack
      // Note: presenceProxy may be set later — use late-binding check
      const stallTriageHandler = async (topicId: number, sessionName: string, messageText: string, injectedAt: number) => {
        // If PresenceProxy Tier 3 is actively handling this topic, defer to it
        if (presenceProxy) {
          const proxyState = presenceProxy.getState(topicId);
          if (proxyState && proxyState.tier3FiredAt && !proxyState.cancelled) {
            const tier3Age = Date.now() - proxyState.tier3FiredAt;
            if (tier3Age < 60_000) {
              console.log(`[StallTriageNurse] Deferring — PresenceProxy Tier 3 active for topic ${topicId}`);
              return { resolved: false };
            }
          }
        }
        const result = await triageNurse!.triage(topicId, sessionName, messageText, injectedAt, 'telegram_stall');
        return { resolved: result.resolved };
      };

      if (telegram) {
        telegram.onStallDetected = stallTriageHandler;
      }

      console.log(pc.green('  Stall Triage Nurse enabled'));
    }

    // TriageOrchestrator — next-gen session recovery with scoped Claude Code sessions
    // Platform-aware: works with Telegram topics AND Slack channels
    let triageOrchestrator: TriageOrchestrator | undefined;
    if (config.monitoring.triageOrchestrator?.enabled && (telegram || _slackAdapter)) {
      triageOrchestrator = new TriageOrchestrator(
        {
          captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          sendKey: (name, key) => sessionManager.sendKey(name, key),
          sendInput: (name, text) => sessionManager.sendInput(name, text),
          getTopicHistory: (topicId, limit) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              const msgs = _slackAdapter.getChannelMessages(slackChId, limit);
              return msgs.map(m => ({ text: m.text, fromUser: true, timestamp: new Date(parseFloat(m.ts) * 1000).toISOString() }));
            }
            if (telegram) {
              const entries = telegram.getTopicHistory(topicId, limit);
              return entries.map(e => ({ text: e.text, fromUser: e.fromUser, timestamp: e.timestamp }));
            }
            return [];
          },
          sendToTopic: async (topicId, text) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              if (_slackAdapter.isSystemChannel(slackChId)) return;
              await _slackAdapter.sendToChannel(slackChId, text);
              return;
            }
            if (telegram) await telegram.sendToTopic(topicId, text);
          },
          respawnSession: (name, topicId, options) => {
            if (telegram) return respawnSessionForTopic(sessionManager, telegram, name, topicId, undefined, topicMemory, undefined, undefined, options);
            const stuckSession = sessionManager.listRunningSessions().find(s => s.tmuxSession === name);
            if (stuckSession) sessionManager.killSession(stuckSession.id);
            return Promise.resolve();
          },
          clearStallForTopic: (topicId) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) { _slackAdapter.clearStallTracking(slackChId); return; }
            if (telegram) telegram.clearStallTracking(topicId);
          },
          spawnTriageSession: (name, options) => sessionManager.spawnTriageSession(name, options),
          getTriageSessionUuid: (sessionName) => {
            return _topicResumeMap?.findUuidForSession(sessionName) ?? undefined;
          },
          killTriageSession: (name) => {
            try {
              const tmux = detectTmuxPath() || 'tmux';
              execFileSync(tmux, ['kill-session', '-t', `=${name}`], { encoding: 'utf-8' });
            } catch { /* best-effort — session may already be dead */ }
          },
          scheduleFollowUpJob: (slug, delayMs, callback) => {
            const jobId = `${slug}-${Date.now()}`;
            const timer = setTimeout(callback, delayMs);
            (triageOrchestrator as any).__timers = (triageOrchestrator as any).__timers || new Map();
            (triageOrchestrator as any).__timers.set(jobId, timer);
            return jobId;
          },
          cancelJob: (jobId) => {
            const timers = (triageOrchestrator as any).__timers as Map<string, NodeJS.Timeout> | undefined;
            if (timers?.has(jobId)) {
              clearTimeout(timers.get(jobId)!);
              timers.delete(jobId);
            }
          },
          injectMessage: (name, text) => sessionManager.sendInput(name, text),
          captureTriageOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          isTriageSessionAlive: (name) => sessionManager.tmuxSessionExists(name),
          projectDir: config.projectDir,
        },
        {
          config: {
            cooldownMs: config.monitoring.triageOrchestrator.cooldownMs,
            maxConcurrentTriages: config.monitoring.triageOrchestrator.maxConcurrentTriages,
            autoActionEnabled: config.monitoring.triageOrchestrator.autoActionEnabled,
            maxAutoActionsPerHour: config.monitoring.triageOrchestrator.maxAutoActionsPerHour,
            defaultModel: config.monitoring.triageOrchestrator.defaultModel,
          },
          state,
        },
      );

      // TriageOrchestrator takes over stall detection from StallTriageNurse
      const triageStallHandler = async (topicId: number, sessionName: string, messageText: string, injectedAt: number) => {
        const result = await triageOrchestrator!.activate(topicId, sessionName, 'stall_detector', messageText, injectedAt);
        return { resolved: result.resolved };
      };

      if (telegram) {
        telegram.onStallDetected = triageStallHandler;

        // Cancel triage when stall tracking clears (session responded)
        const origClearStall = telegram.clearStallTracking.bind(telegram);
        telegram.clearStallTracking = (topicId: number) => {
          origClearStall(topicId);
          triageOrchestrator!.onTargetSessionResponded(topicId);
        };

        // Wire /triage command
        telegram.onGetTriageStatus = (topicId) => {
          const ts = triageOrchestrator!.getTriageState(topicId);
          if (!ts) return null;
          return {
            active: true,
            classification: ts.classification,
            checkCount: ts.checkCount,
            lastCheck: new Date(ts.lastCheckAt).toISOString(),
          };
        };
      }

      console.log(pc.green('  Triage Orchestrator enabled (replaces Stall Triage Nurse for stall detection)'));
    }

    // SessionRecovery — fast mechanical recovery (JSONL analysis, no LLM)
    // Platform-aware: works with Telegram topics AND Slack channels
    let sessionRecovery: SessionRecovery | undefined;
    // Track sessions being killed for context exhaustion — prevents beforeSessionKill
    // from re-saving resume UUIDs (which would cause an infinite death loop)
    const contextExhaustionKills = new Set<string>();
    if (telegram || _slackAdapter) {
      sessionRecovery = new SessionRecovery(
        { enabled: true, projectDir: config.projectDir },
        {
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          getPanePid: (name) => {
            try {
              const tmux = detectTmuxPath();
              if (!tmux) return null;
              const pid = execFileSync(tmux, ['list-panes', '-t', `=${name}:`, '-F', '#{pane_pid}'], { encoding: 'utf-8', timeout: 5000 }).trim();
              return /^\d+$/.test(pid) ? parseInt(pid, 10) : null;
            } catch { return null; }
          },
          killSession: (name) => {
            // Route through SessionManager to fire beforeSessionKill hook
            const session = sessionManager.listRunningSessions().find(s => s.tmuxSession === name);
            if (session) { sessionManager.killSession(session.id); return; }
            // Fallback: direct tmux kill for untracked sessions
            try {
              const tmux = detectTmuxPath();
              if (!tmux) return;
              execFileSync(tmux, ['kill-session', '-t', `=${name}`], { encoding: 'utf-8' });
            } catch { /* may already be dead */ }
          },
          respawnSession: async (topicId, _sessionName, recoveryPrompt) => {
            // Check Slack first (synthetic IDs are negative)
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              // Slack respawn: kill existing, next message triggers fresh session
              const session = sessionManager.listRunningSessions().find(s => s.tmuxSession === _sessionName);
              if (session) sessionManager.killSession(session.id);
              return;
            }
            if (telegram) {
              const targetSession = telegram.getSessionForTopic(topicId);
              if (!targetSession) return;
              await respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, undefined, topicMemory, undefined, recoveryPrompt, { silent: true });
            }
          },
          sendToTopic: async (topicId, message) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) { await _slackAdapter.sendToChannel(slackChId, message); return; }
            if (telegram) await telegram.sendToTopic(topicId, message);
          },
          captureSessionOutput: (name, lines) => {
            return sessionManager.captureOutput(name, lines);
          },
          getRecentTopicMessages: (topicId, limit) => {
            // Used by context-exhaustion recovery to capture any in-flight agent
            // reply that lands after the session is killed, so the fresh session
            // can avoid duplicating it. TopicMemory is the authoritative source
            // once the adapter has written the reply to the store.
            if (!topicMemory || !topicMemory.isReady()) return [];
            try {
              return topicMemory.getRecentMessages(topicId, limit).map(m => ({
                text: m.text,
                fromUser: m.fromUser,
                timestamp: m.timestamp,
              }));
            } catch {
              return [];
            }
          },
          respawnSessionFresh: async (topicId, _sessionName, recoveryPrompt) => {
            // Fresh respawn for context exhaustion — explicitly clear resume UUID
            // so the new session starts clean with history, not --resume.
            if (_topicResumeMap) {
              _topicResumeMap.remove(topicId);
            }

            // Check if this is a Slack channel (synthetic negative topic IDs)
            let slackChId = slackProxyChannelMap.get(topicId);

            // Fallback: reverse-lookup from adapter channel registry if map doesn't have it
            if (!slackChId && _slackAdapter && topicId < 0) {
              const registry = _slackAdapter.getChannelRegistry();
              for (const channelId of Object.keys(registry)) {
                if (slackChannelToSyntheticId(channelId) === topicId) {
                  slackChId = channelId;
                  break;
                }
              }
              if (slackChId) {
                console.log(`[respawnSessionFresh] Resolved slackChId=${slackChId} via reverse lookup (map miss for topicId=${topicId})`);
              }
            }

            console.log(`[respawnSessionFresh] topicId=${topicId} slackChId=${slackChId || 'none'} slackAdapter=${!!_slackAdapter} session=${_sessionName} mapSize=${slackProxyChannelMap.size}`);

            if (slackChId && _slackAdapter) {
              // Kill existing session (already flagged in contextExhaustionKills via event listener)
              const session = sessionManager.listRunningSessions().find(s => s.tmuxSession === _sessionName);
              if (session) sessionManager.killSession(session.id);

              // Clear the channel resume so the new session starts fresh
              _slackAdapter.removeChannelResume(slackChId);

              // Spawn a fresh session with recovery context
              await new Promise(resolve => setTimeout(resolve, 2000));

              // Build a recovery bootstrap message with thread history (inline, matching Telegram pattern)
              // Use async fallback to fetch from Slack API if ring buffer is empty (race condition on restart)
              const history = await _slackAdapter.getChannelMessagesWithFallback(slackChId, 30);
              const botUserId = _slackAdapter.getBotUserId?.() ?? null;
              const lines: string[] = [];
              lines.push(`CONTINUATION — You are resuming an EXISTING Slack conversation after context exhaustion. Read the context below and pick up where you left off. Do NOT ask what was being discussed.`);
              lines.push('');
              lines.push(`[RECOVERY] Previous session hit the context window limit. This is a FRESH restart with thread history.`);
              if (recoveryPrompt) lines.push(recoveryPrompt);
              lines.push('');
              if (history.length > 0) {
                lines.push(`--- Thread History (last ${history.length} messages) ---`);
                for (const m of history) {
                  const date = new Date(parseFloat(m.ts) * 1000);
                  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                  const isBot = botUserId && m.user === botUserId;
                  const label = isBot ? 'Agent' : m.user;
                  lines.push(`[${time}] ${label}: ${m.text}`);
                }
                lines.push('--- End Thread History ---');
              } else {
                console.warn(`[slack→recovery] WARNING: No history available for channel ${slackChId} — recovery context is empty. Ring buffer may not be populated yet.`);
                lines.push('[WARNING: Thread history unavailable — ring buffer may not be populated. Check Slack channel for recent messages before responding.]');
              }
              lines.push('');
              lines.push('CRITICAL: You MUST relay your response back to Slack.');
              lines.push(`cat <<'EOF' | .claude/scripts/slack-reply.sh ${slackChId}`);
              lines.push('Your response text here');
              lines.push('EOF');

              const tmpDir = '/tmp/instar-slack';
              fs.mkdirSync(tmpDir, { recursive: true });
              const ctxPath = path.join(tmpDir, `recovery-${slackChId}-${Date.now()}.txt`);
              const contextData = lines.join('\n');
              fs.writeFileSync(ctxPath, contextData);

              const bootstrapMessage = `[slack:${slackChId}] ${contextData}`;

              try {
                const newSessionName = await sessionManager.spawnInteractiveSession(bootstrapMessage, undefined, { slackChannelId: slackChId });
                if (newSessionName) {
                  _slackAdapter.registerChannelSession(slackChId, newSessionName);
                  console.log(`[slack→recovery] Fresh session "${newSessionName}" spawned for channel ${slackChId} (context exhaustion recovery)`);
                }
              } catch (err) {
                console.error(`[slack→recovery] Fresh session spawn failed for ${slackChId}: ${err instanceof Error ? err.message : err}`);
              }
              return;
            }

            if (telegram) {
              const targetSession = telegram.getSessionForTopic(topicId);
              if (!targetSession) {
                console.warn(`[respawnSessionFresh] No Telegram or Slack session found for topicId=${topicId} — recovery has no target`);
                return;
              }
              await respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, undefined, topicMemory, undefined, recoveryPrompt, { silent: true });
            } else if (!slackChId) {
              console.warn(`[respawnSessionFresh] No platform handler for topicId=${topicId} — recovery is a no-op`);
            }
          },
        },
      );
      // Track context exhaustion kills to prevent beforeSessionKill from re-saving
      // resume UUIDs (which would cause an infinite death loop)
      sessionRecovery.on('recovery:context_exhaustion', ({ sessionName }: { sessionName: string }) => {
        contextExhaustionKills.add(sessionName);
        // Clean up after 60 seconds — by then the kill and respawn are done
        setTimeout(() => contextExhaustionKills.delete(sessionName), 60_000);
      });
      console.log(pc.green('  Session Recovery enabled (mechanical fast-path)'));
    }

    // SessionMonitor — proactive session health monitoring
    // Platform-aware: monitors both Telegram and Slack sessions
    let sessionMonitor: SessionMonitor | undefined;
    if (telegram || _slackAdapter) {
      sessionMonitor = new SessionMonitor(
        {
          getActiveTopicSessions: () => {
            const sessions = new Map<number, string>();
            // Telegram topic sessions
            if (telegram && telegram.getActiveTopicSessions) {
              const telegramSessions = telegram.getActiveTopicSessions();
              for (const [topicId, sessionName] of telegramSessions) {
                sessions.set(topicId, sessionName);
              }
            }
            // Slack channel sessions (using synthetic IDs)
            // Exclude system channels (dashboard, lifeline) — they don't have interactive sessions
            if (_slackAdapter) {
              const registry = _slackAdapter.getChannelRegistry();
              for (const [channelId, entry] of Object.entries(registry)) {
                if (_slackAdapter.isSystemChannel(channelId)) continue;
                const syntheticId = slackChannelToSyntheticId(channelId);
                sessions.set(syntheticId, entry.sessionName);
              }
            }
            return sessions;
          },
          captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          getTopicHistory: (topicId, limit) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              const msgs = _slackAdapter.getChannelMessages(slackChId, limit);
              return msgs.map(m => ({ text: m.text, fromUser: true, timestamp: new Date(parseFloat(m.ts) * 1000).toISOString() }));
            }
            if (telegram) {
              const history = telegram.getMessageLog?.();
              if (!history) return [];
              return history
                .filter((m: any) => m.topicId === topicId)
                .slice(-limit)
                .map((m: any) => ({ text: m.text, fromUser: m.fromUser, timestamp: m.timestamp }));
            }
            return [];
          },
          sendToTopic: async (topicId, text) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              if (_slackAdapter.isSystemChannel(slackChId)) return;
              await _slackAdapter.sendToChannel(slackChId, text);
              return;
            }
            if (telegram) await telegram.sendToTopic(topicId, text);
          },
          triggerTriage: triageOrchestrator
            ? async (topicId, sessionName, reason) => {
                const result = await triageOrchestrator!.activate(topicId, sessionName, 'watchdog', reason, Date.now());
                return { resolved: result.resolved };
              }
            : triageNurse
              ? async (topicId, sessionName, reason) => {
                  const result = await triageNurse!.triage(topicId, sessionName, reason, Date.now(), 'watchdog');
                  return { resolved: result.resolved };
                }
              : undefined,
          sessionRecovery,
        },
        config.monitoring.sessionMonitor,
      );
      sessionMonitor.start();
      console.log(pc.green('  Session Monitor enabled'));
    }

    // Set up feedback and update checking
    let feedback: FeedbackManager | undefined;
    let feedbackAnomalyDetector: FeedbackAnomalyDetector | undefined;
    if (config.feedback) {
      feedback = new FeedbackManager({
        ...config.feedback,
        version: startupVersion,
      });
      feedbackAnomalyDetector = new FeedbackAnomalyDetector();
      console.log(pc.green('  Feedback loop enabled (with anomaly detection)'));
    }
    // Set up dispatch system with auto-dispatcher
    let dispatches: DispatchManager | undefined;
    let autoDispatcher: AutoDispatcher | undefined;
    if (config.dispatches) {
      dispatches = new DispatchManager({
        ...config.dispatches,
        version: startupVersion,
      });

      const dispatchExecutor = new DispatchExecutor(config.projectDir, sessionManager);
      autoDispatcher = new AutoDispatcher(
        dispatches,
        dispatchExecutor,
        state,
        config.stateDir,
        {
          pollIntervalMinutes: 30,
          autoApplyPassive: config.dispatches.autoApply ?? true,
          autoExecuteActions: true,
        },
        telegram,
      );
      // Wire dispatch decision journal for Discernment Layer (Milestone 1)
      const { DispatchDecisionJournal } = await import('../core/DispatchDecisionJournal.js');
      const dispatchDecisionJournal = new DispatchDecisionJournal(config.stateDir);
      autoDispatcher.setDecisionJournal(dispatchDecisionJournal);

      autoDispatcher.start();
      console.log(pc.green('  Dispatch system enabled (auto-polling active)'));
    }

    const updateChecker = new UpdateChecker({
      stateDir: config.stateDir,
      projectDir: config.projectDir,
      port: config.port,
      hasTelegram: config.messaging.some(m => m.type === 'telegram' && m.enabled),
      projectName: config.projectName,
    });

    // Check for updates on startup (non-blocking)
    updateChecker.check().then(info => {
      if (info.updateAvailable) {
        console.log(pc.yellow(`  Update available: ${info.currentVersion} → ${info.latestVersion}`));
      } else {
        console.log(pc.green(`  Instar ${info.currentVersion} is up to date`));
      }
    }).catch(() => { /* ignore startup check failures */ });

    // Start auto-updater — periodic check + auto-apply + notify + restart
    // Notifications routed dynamically to Updates topic (see getNotificationTopicId)
    const autoUpdater = new AutoUpdater(
      updateChecker,
      state,
      config.stateDir,
      {
        checkIntervalMinutes: 30,
        autoApply: config.updates?.autoApply ?? true,
        autoRestart: true,
        restartWindow: config.updates?.restartWindow ?? null,
      },
      telegram,
      liveConfig,
    );
    // Wire session deps for session-aware restart gating (Phase 2B)
    autoUpdater.setSessionDeps(sessionManager, sessionMonitor);
    autoUpdater.start();

    // ForegroundRestartWatcher — the critical gap fix (v0.9.72).
    // In foreground mode there's no supervisor to pick up restart-requested.json.
    // Without this, AutoUpdater installs the update, writes the flag, and nobody
    // acts on it — the process stays stale forever (the Luna/v0.9.70 incident).
    const restartWatcher = new ForegroundRestartWatcher({
      stateDir: config.stateDir,
      // Don't let the watcher call process.exit() directly — it crashes with
      // "mutex lock failed" because better-sqlite3 databases aren't closed.
      // Instead, we wire the 'restartDetected' event to the graceful shutdown
      // function (defined below) which closes all resources before exiting.
      exitOnRestart: false,
      onRestartDetected: async (request) => {
        // Only notify if there are active sessions — silent restart otherwise.
        // Phase 1C of GRACEFUL_UPDATES: reduce noise for routine maintenance.
        const runningSessions = sessionManager.listRunningSessions();
        if (runningSessions.length > 0) {
          notify('IMMEDIATE', 'system',
            `Applying update to v${request.targetVersion} — restarting now. Active sessions will resume automatically.`
          );
        } else {
          console.log(`[ForegroundRestartWatcher] Silent restart — no active sessions (v${request.previousVersion} → v${request.targetVersion})`);
        }
      },
    });
    restartWatcher.start();

    // Set up Telegraph publishing (auto-enabled when config exists or Telegram is configured)
    let publisher: TelegraphService | undefined;
    const pubConfig = config.publishing;
    if (pubConfig?.enabled !== false) {
      publisher = new TelegraphService({
        stateDir: config.stateDir,
        shortName: pubConfig?.shortName || config.projectName,
        authorName: pubConfig?.authorName,
        authorUrl: pubConfig?.authorUrl,
      });
      console.log(pc.green(`  Publishing enabled (Telegraph)`));
    }

    // Set up private viewer (always enabled — stores rendered markdown locally)
    const viewer = new PrivateViewer({
      viewsDir: path.join(config.stateDir, 'views'),
    });
    console.log(pc.green(`  Private viewer enabled`));

    // Set up paste manager (Drop Zone — always enabled)
    const { PasteManager } = await import('../paste/PasteManager.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- paste config fields are optional extensions
    const cfgAny = config as any;
    const pasteManager = new PasteManager({
      pasteDir: path.join(config.stateDir, 'paste'),
      stateDir: path.join(config.stateDir, 'state'),
      projectDir: config.projectDir,
      maxSizeBytes: cfgAny.pasteMaxSizeMB ? cfgAny.pasteMaxSizeMB * 1024 * 1024 : undefined,
      retentionDays: cfgAny.pasteRetentionDays ?? undefined,
    });
    console.log(pc.green(`  Drop Zone (paste) enabled`));

    // Set up Cloudflare Tunnel — enabled by default (quick tunnel, zero-config)
    // Only disabled if explicitly set to tunnel.enabled = false
    const tunnelEnabled = config.tunnel?.enabled !== false;
    let tunnel: TunnelManager | undefined;
    if (tunnelEnabled) {
      // Persist tunnel config if it wasn't in config.json yet (existing agents)
      if (!config.tunnel) {
        liveConfig.set('tunnel', { enabled: true, type: 'quick' });
      }
      tunnel = new TunnelManager({
        enabled: true,
        type: config.tunnel?.type || 'quick',
        token: config.tunnel?.token,
        configFile: config.tunnel?.configFile,
        hostname: config.tunnel?.hostname,
        port: config.port,
        stateDir: config.stateDir,
      });
    }

    // Set up evolution system (always enabled — the feedback loop infrastructure)
    const evolution = new EvolutionManager({
      stateDir: config.stateDir,
      ...(config.evolution || {}),
    });
    console.log(pc.green('  Evolution system enabled'));

    // Start MemoryPressureMonitor (platform-aware memory tracking)
    const { MemoryPressureMonitor } = await import('../monitoring/MemoryPressureMonitor.js');
    const memoryMonitor = new MemoryPressureMonitor({ stateDir: config.stateDir });
    // Memory notification cooldown removed — handled by NotificationBatcher (SUMMARY tier)
    memoryMonitor.on('stateChange', ({ from, to, state: memState }: { from: string; to: string; state: any }) => {
      // Gate scheduler spawning on memory pressure
      if (scheduler && (to === 'elevated' || to === 'critical')) {
        console.log(`[MemoryPressure] ${from} -> ${to} — scheduler should respect canSpawnSession()`);
      }
      // Alert via batcher — critical memory is IMMEDIATE, elevated is SUMMARY
      if (to !== 'normal') {
        const tier: NotificationTier = to === 'critical' ? 'IMMEDIATE' : 'SUMMARY';
        const freeGb = memState.freeGB.toFixed(1);
        const msg = to === 'critical'
          ? `The machine is running very low on memory (only ${freeGb}GB free). I'll hold off on starting new sessions until this clears up.`
          : `Memory is getting tight (${freeGb}GB free). I'll be conservative about spinning up new work.`;
        notify(tier, 'system', msg);
      }
    });
    memoryMonitor.start();

    // Wire memory gate into scheduler
    if (scheduler) {
      const originalCanRun = scheduler.canRunJob;
      scheduler.canRunJob = (priority) => {
        // Check memory first — return a rich result so the scheduler can
        // log the actual gating reason instead of mislabelling it as 'quota'.
        const memCheck = memoryMonitor.canSpawnSession();
        if (!memCheck.allowed) {
          return {
            allowed: false,
            reason: 'memory-pressure',
            detail: memCheck.reason ?? 'memory pressure elevated',
          };
        }
        // Then check original gate (quota, etc.)
        return originalCanRun(priority);
      };
    }

    // Start OrphanProcessReaper (detect and clean up untracked Claude processes)
    const { OrphanProcessReaper } = await import('../monitoring/OrphanProcessReaper.js');
    const orphanReaper = new OrphanProcessReaper(config, sessionManager, {
      pollIntervalMs: 60_000,      // Check every minute
      orphanMaxAgeMs: 3_600_000,   // Kill Instar orphans after 1 hour
      externalReportAgeMs: 14_400_000, // Report external processes after 4 hours
      highMemoryThresholdMB: 500,  // Flag processes using >500MB
      autoKillOrphans: true,       // Auto-kill Instar orphans (safe — only project-prefixed tmux sessions)
      reportExternalProcesses: config.monitoring?.reportExternalProcesses !== false,
      alertCallback: async (msg: string) => {
        notify('DIGEST', 'system', msg);
      },
    });
    orphanReaper.start();
    _orphanReaper = orphanReaper;
    if (_fixDeps) _fixDeps.orphanReaper = orphanReaper;
    _memoryMonitor = memoryMonitor;
    console.log(pc.green('  Orphan process reaper enabled'));

    // Hook Event Receiver — receives HTTP hook events from Claude Code sessions
    const { HookEventReceiver } = await import('../monitoring/HookEventReceiver.js');
    const hookEventReceiver = new HookEventReceiver({ stateDir: config.stateDir });
    console.log(pc.green('  Hook event receiver enabled'));

    // ── Compaction Resume: unified recovery for one session ──────────────
    // After compaction, the session's working context is gone. Rather than
    // replaying the user's last message (which assumes the agent still has
    // thread context), we inject a prompt telling the agent to re-read recent
    // topic messages and continue. The agent fetches its own history, so this
    // restores continuity without pretending no compaction happened.
    //
    // Note: we deliberately bypass triageOrchestrator here. Its reinject_message
    // heuristic unconditionally re-sends the last user message from topic
    // history — fine for "message lost mid-flight" stalls, wrong for compaction
    // recovery where the agent needs to re-orient first.
    //
    // Three independent triggers call into this:
    //   1. PreCompact hook event (Claude Code fires it — unreliable)
    //   2. SessionWatchdog 'compaction-idle' polling (default-enabled)
    //   3. POST /internal/compaction-resume (compaction-recovery.sh hook)
    // After compaction the agent needs three things: orientation, user-facing
    // transparency, and a clear handoff back to whatever they were doing.
    //
    // The payload embeds the same context block the session-spawn path uses
    // (topicMemory.formatContextForSession → summary + recent messages + a
    // search hint for deeper lookup). Before this, the prompt was a single
    // sentence asking the agent to "read recent messages" on its own — which
    // let it fabricate a plausible-sounding status summary instead of
    // answering the actual intent of the user's last message. Giving it the
    // same shape of context it had at first spawn removes the reason to
    // hallucinate.
    const { isSystemOrProxyMessage, findLastRealMessage } = await import('../messaging/shared/isSystemOrProxyMessage.js');
    const {
      buildCompactionResumePayload,
      formatInlineHistory,
      prepareInjectionText,
    } = await import('../messaging/shared/compactionResumePayload.js');

    const recoverCompactedSession = async (sessionName: string, triggerLabel: string): Promise<boolean> => {
      if (!sessionManager.isSessionAlive(sessionName)) return false;

      // Telegram path
      if (telegram) {
        const topicId = telegram.getTopicForSession(sessionName);
        if (topicId) {
          // Walk history backward, skipping PresenceProxy standby messages and
          // server-emitted delivery/lifecycle acks. Those are from-agent but
          // they are NOT real responses — treating them as "agent answered"
          // is what let this recovery path silently decline for 15 minutes
          // while the user's question sat unanswered. See
          // isSystemOrProxyMessage / findLastRealMessage for the canonical filter.
          const history = telegram.getTopicHistory(topicId, 20);
          const lastReal = findLastRealMessage(history);
          if (lastReal?.fromUser) {
            console.log(`[CompactionResume] (${triggerLabel}) topic ${topicId} session "${sessionName}" has unanswered message — recovering`);

            // Prefer topicMemory (summary + recent messages + search hint);
            // fall back to inline JSONL history when the SQLite store isn't
            // ready. Matches the session-spawn precedence in this file.
            let contextBlock = '';
            if (topicMemory?.isReady()) {
              try {
                contextBlock = topicMemory.formatContextForSession(topicId, 20);
              } catch (err) {
                console.warn(`[CompactionResume] (${triggerLabel}) topicMemory failed, falling back to inline history:`, err);
              }
            }
            if (!contextBlock) {
              const topicName = telegram.getTopicName?.(topicId) ?? undefined;
              contextBlock = formatInlineHistory(history, { topicName, label: 'TOPIC CONTEXT' });
            }

            const payload = buildCompactionResumePayload(contextBlock);
            const injectText = prepareInjectionText(payload, triggerLabel, topicId);
            // Direct injection with topic tag so InputGuard accepts it.
            const tagged = `[telegram:${topicId}] ${injectText}`;
            const ok = sessionManager.injectMessage(sessionName, tagged);
            if (ok) {
              console.log(`[CompactionResume] (${triggerLabel}) direct re-inject OK for topic ${topicId}`);
              return true;
            }
            console.warn(`[CompactionResume] (${triggerLabel}) direct re-inject FAILED for topic ${topicId}`);
          }
        }
      }

      // Slack path — handled in the Slack-aware block below (needs slackChannelToSyntheticId).
      // We attempt it here lazily via a deferred handler set on globalThis to avoid TDZ.
      const slackHandler = (globalThis as Record<string, unknown>).__instarSlackCompactionResume as
        | ((sessionName: string, triggerLabel: string) => Promise<boolean>)
        | undefined;
      if (slackHandler) {
        try { return await slackHandler(sessionName, triggerLabel); } catch { /* fall through */ }
      }
      return false;
    };

    // ── CompactionSentinel ────────────────────────────────────────────
    // Owns the full recovery lifecycle: detect → inject → verify (jsonl
    // growth) → retry on failure → finalize. Replaces the fire-and-forget
    // calls that used to live here. Dedupes across the three triggers and
    // vetoes zombie cleanup while a recovery is in flight.
    const { CompactionSentinel } = await import('../monitoring/CompactionSentinel.js');
    const compactionSentinel = new CompactionSentinel(
      {
        recoverFn: recoverCompactedSession,
        projectDir: config.projectDir,
        getClaudeSessionId: (sessionName: string) => {
          const session = sessionManager.listRunningSessions()
            .find(s => s.tmuxSession === sessionName);
          return session?.claudeSessionId;
        },
      },
      // Defaults are production-sensible; override here only if needed.
      {},
    );
    sessionManager.setActiveRecoveryChecker(
      session => compactionSentinel.isRecoveryActive(session.tmuxSession),
    );
    console.log(pc.green('  CompactionSentinel enabled (verified recovery lifecycle)'));

    // Trigger 1: PreCompact hook event — report to sentinel.
    hookEventReceiver.on('PreCompact', () => {
      // Delay to let compaction + recovery hooks finish
      setTimeout(() => {
        if (!telegram) return;
        const topicSessions = telegram.getAllTopicSessions();
        for (const [, sessionName] of topicSessions) {
          compactionSentinel.report(sessionName, 'PreCompact');
        }
      }, 10_000);
    });
    console.log(pc.green('  Compaction auto-resume wired (PreCompact hook event)'));

    // Trigger 2: Watchdog 'compaction-idle' polling — report to sentinel.
    if (watchdog) {
      watchdog.on('compaction-idle', (sessionName: string) => {
        compactionSentinel.report(sessionName, 'watchdog-poll');
      });
      console.log(pc.green('  Compaction auto-resume wired (watchdog poll)'));
    }

    // Trigger 3: stash a function on globalThis so the HTTP route (registered
    // later in AgentServer) and the compaction-recovery.sh hook can invoke it
    // via POST /internal/compaction-resume. Routes into the sentinel so the
    // dedupe/verify/retry lifecycle applies to this path too.
    (globalThis as Record<string, unknown>).__instarCompactionRecover = (
      sessionName: string,
      triggerLabel: string,
    ) => {
      compactionSentinel.report(sessionName, triggerLabel || 'recovery-hook');
      return Promise.resolve(true);
    };

    // Subagent Tracker — monitors subagent lifecycle via hook events
    const { SubagentTracker } = await import('../monitoring/SubagentTracker.js');
    const subagentTracker = new SubagentTracker({ stateDir: config.stateDir });
    console.log(pc.green('  Subagent tracker enabled'));

    // Helper Watchdog — detects subagent stalls and rate-limit failures,
    // surfacing them back into the parent session's stdin so the agent
    // can decide whether to retry smaller. Complements SessionWatchdog,
    // which only covers the top-level session.
    const { HelperWatchdog } = await import('../monitoring/HelperWatchdog.js');
    const helperWatchdog = new HelperWatchdog({ subagentTracker });
    helperWatchdog.start();
    const findTmuxForClaudeSession = (claudeSessionId: string): string | null => {
      const running = sessionManager
        .listRunningSessions()
        .filter((s) => s.claudeSessionId === claudeSessionId);
      return running[0]?.tmuxSession ?? null;
    };
    const deliverHelperAlert = (tmux: string | null, msg: string): void => {
      console.warn(msg);
      if (!tmux) return;
      try {
        sessionManager.injectMessage(tmux, msg);
      } catch (err) {
        console.warn(
          `[HelperWatchdog] inject failed for ${tmux}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    helperWatchdog.on(
      'stall',
      (e: { agentId: string; agentType: string; sessionId: string; elapsedMs: number }) => {
        const minutes = Math.round(e.elapsedMs / 60_000);
        deliverHelperAlert(
          findTmuxForClaudeSession(e.sessionId),
          `[helper-watchdog] Your ${e.agentType} helper (agent ${e.agentId}) has been running for ${minutes}m with no stop event — likely stalled. Consider retrying with a smaller scope or aborting.`,
        );
      },
    );
    helperWatchdog.on(
      'helper-failed',
      (e: {
        record: { agentId: string; agentType: string; sessionId: string; lastMessage: string | null };
        reason: string;
      }) => {
        const snippet = (e.record.lastMessage ?? '').slice(0, 160);
        deliverHelperAlert(
          findTmuxForClaudeSession(e.record.sessionId),
          `[helper-watchdog] Your ${e.record.agentType} helper (agent ${e.record.agentId}) died with reason=${e.reason}. Last message: ${snippet}`,
        );
      },
    );
    console.log(pc.green('  Helper watchdog enabled'));

    // Wire subagent awareness into zombie cleanup — prevents killing sessions
    // that are idle at the prompt but waiting for subagent results.
    const MAX_SUBAGENT_WAIT_MS = 60 * 60_000; // 60 minutes — stale subagent safety cap
    sessionManager.setSubagentChecker((session: import('../core/types.js').Session) => {
      if (!session.claudeSessionId) return false;
      const active = subagentTracker.getActiveSubagents(session.claudeSessionId);
      if (active.length === 0) return false;
      // Safety cap: if ALL active subagents have been running > 60 minutes,
      // treat them as stale (likely missed a SubagentStop event) and allow the kill.
      const now = Date.now();
      const allStale = active.every(a =>
        now - new Date(a.startedAt).getTime() > MAX_SUBAGENT_WAIT_MS,
      );
      if (allStale) {
        console.warn(`[SessionManager] Session "${session.name}" has ${active.length} stale subagent(s) (>60m). Allowing zombie kill.`);
        return false;
      }
      return true;
    });

    // Worktree Monitor — detects orphaned worktrees after sessions complete
    const { WorktreeMonitor } = await import('../monitoring/WorktreeMonitor.js');
    const worktreeMonitor = new WorktreeMonitor({
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      pollIntervalMs: 300_000, // 5 minutes
      alertCallback: async (msg: string) => {
        notify('IMMEDIATE', 'system', msg);
      },
    });
    worktreeMonitor.start();

    // Wire worktree scan to session completion
    sessionManager.on('sessionComplete', async (session: import('../core/types.js').Session) => {
      try {
        await worktreeMonitor.onSessionComplete(session);
      } catch (err) {
        console.error('[WorktreeMonitor] Post-session scan failed:', err);
      }
    });
    console.log(pc.green('  Worktree monitor enabled (post-session + periodic)'));

    // Session-end maintenance — lightweight housekeeping at session boundaries
    // Cross-pollinated from Dawn: distributes maintenance load across all sessions
    const { SessionMaintenanceRunner } = await import('../core/SessionMaintenanceRunner.js');
    const sessionMaintenance = new SessionMaintenanceRunner({ stateDir: config.stateDir });
    sessionManager.on('sessionComplete', async () => {
      try {
        const result = await sessionMaintenance.run();
        if (result.tasksRun.length > 0) {
          console.log(`[SessionMaintenance] ${result.summary}`);
        }
      } catch (err) {
        // Fire-and-forget — maintenance failures never block session cleanup
        console.error('[SessionMaintenance] Failed:', err);
      }
    });
    console.log(pc.green('  Session-end maintenance enabled'));

    // Instructions Verifier — tracks which CLAUDE.md files loaded
    const { InstructionsVerifier } = await import('../monitoring/InstructionsVerifier.js');
    const instructionsVerifier = new InstructionsVerifier({ stateDir: config.stateDir });
    console.log(pc.green('  Instructions verifier enabled'));

    // Coherence Monitor — runtime self-awareness for homeostasis.
    // Periodically checks config coherence, state durability, output sanity,
    // and feature readiness. Self-corrects where possible, notifies otherwise.
    const coherenceMonitor = new CoherenceMonitor({
      stateDir: config.stateDir,
      liveConfig,
      port: config.port,
      onIncoherence: (report) => {
        const failedChecks = report.checks.filter(c => !c.passed && !c.corrected);
        const parts = failedChecks.map(c => formatCoherenceFailure(c.name, c.message));
        notify('SUMMARY', 'attention-update', parts.join('\n\n'));
      },
    });
    coherenceMonitor.start();
    if (_fixDeps) _fixDeps.coherenceMonitor = coherenceMonitor;
    console.log(pc.green('  Coherence monitor enabled'));

    // Commitment Tracker — durable promise enforcement for agent commitments.
    // When users ask agents to change settings/behavior, this ensures it sticks.
    const { CommitmentTracker } = await import('../monitoring/CommitmentTracker.js');
    const commitmentTracker = new CommitmentTracker({
      stateDir: config.stateDir,
      liveConfig,
      onViolation: (commitment, detail) => {
        notify('IMMEDIATE', 'commitment',
          `You asked me to "${commitment.userRequest}" but it looks like that setting reverted. ${detail}`
        );
      },
      onVerified: (commitment) => {
        console.log(`[CommitmentTracker] First verification passed: ${commitment.id} "${commitment.userRequest}"`);
      },
      onEscalation: (commitment, detail) => {
        notify('IMMEDIATE', 'commitment',
          `The change you asked for ("${commitment.userRequest}") keeps reverting — this looks like a bug I need to fix. ${detail}`
        );
      },
    });
    commitmentTracker.start();
    console.log(pc.green('  Commitment tracker enabled'));

    // Commitment Sentinel — LLM-powered scanner that finds unregistered commitments.
    let commitmentSentinel: import('../monitoring/CommitmentSentinel.js').CommitmentSentinel | undefined;
    if (sharedIntelligence) {
      const { CommitmentSentinel } = await import('../monitoring/CommitmentSentinel.js');
      commitmentSentinel = new CommitmentSentinel({
        stateDir: config.stateDir,
        intelligence: sharedIntelligence,
        commitmentTracker,
      });
      commitmentSentinel.start();
      console.log(pc.green('  Commitment sentinel enabled (LLM-powered)'));
    }

    // Presence Proxy — Intelligent Response Standby (tiered status updates)
    // Slack bridge: PresenceProxy uses numeric topicIds internally. For Slack channels,
    // we assign stable negative synthetic IDs and route sendMessage to the correct platform.
    const slackProxyChannelMap = new Map<number, string>(); // syntheticId -> Slack channelId
    function slackChannelToSyntheticId(channelId: string): number {
      // Stable hash: sum of char codes, negated to avoid Telegram topic ID collisions
      let hash = 0;
      for (let i = 0; i < channelId.length; i++) {
        hash = ((hash << 5) - hash + channelId.charCodeAt(i)) | 0;
      }
      const syntheticId = -(Math.abs(hash) + 1); // Always negative, never 0
      slackProxyChannelMap.set(syntheticId, channelId);
      return syntheticId;
    }

    // Pre-populate the Slack proxy channel map from existing channel registry
    // so PresenceProxy state recovery can resolve synthetic IDs on restart
    if (_slackAdapter) {
      const registry = _slackAdapter.getChannelRegistry();
      for (const channelId of Object.keys(registry)) {
        slackChannelToSyntheticId(channelId);
      }
    }

    // Slack compaction-resume wiring — registered as a deferred handler the
    // unified recoverCompactedSession() helper above will call. Works with or
    // without triageOrchestrator (falls back to direct sessionManager inject).
    if (_slackAdapter) {
      const _slack = _slackAdapter;
      const slackRecover = async (sessionName: string, triggerLabel: string): Promise<boolean> => {
        const channelId = _slack.getChannelForSession(sessionName);
        if (!channelId) return false;
        const slackLogPath = path.join(config.stateDir, 'slack-messages.jsonl');
        // Load up to the last 20 messages for this channel so we can both
        // verify the most recent entry is unanswered (last real message is
        // user) AND build an inline history block for the resume payload.
        interface SlackLogEntry { text?: string; fromUser?: boolean; timestamp?: string; senderName?: string; channelId?: string }
        const channelMessages: SlackLogEntry[] = [];
        try {
          const content = fs.readFileSync(slackLogPath, 'utf-8');
          const lines = content.trim().split('\n');
          for (let i = lines.length - 1; i >= 0 && channelMessages.length < 20; i--) {
            try {
              const msg = JSON.parse(lines[i]) as SlackLogEntry;
              if (msg.channelId === channelId) {
                channelMessages.unshift(msg);
              }
            } catch { /* skip malformed */ }
          }
        } catch { /* no log */ }
        if (channelMessages.length === 0) return false;
        const lastReal = findLastRealMessage(channelMessages);
        if (!lastReal?.fromUser) return false;
        console.log(`[CompactionResume] (${triggerLabel}) Slack channel ${channelId} has unanswered message — recovering`);

        const contextBlock = formatInlineHistory(channelMessages, { label: 'SLACK CHANNEL CONTEXT' });
        const payload = buildCompactionResumePayload(contextBlock);
        const injectText = prepareInjectionText(payload, triggerLabel, channelId);
        // Direct injection — bypass triage (see comment on recoverCompactedSession).
        const ok = sessionManager.injectMessage(sessionName, injectText);
        if (ok) {
          console.log(`[CompactionResume] (${triggerLabel}) Slack direct re-inject OK for channel ${channelId}`);
          return true;
        }
        return false;
      };
      (globalThis as Record<string, unknown>).__instarSlackCompactionResume = slackRecover;
      console.log(pc.green('  Compaction auto-resume registered (Slack channels)'));
    }

    // ── ProxyCoordinator (shared between PresenceProxy and PromiseBeacon) ──
    // Per PROMISE-BEACON-SPEC.md §A10: a per-topic mutex that prevents
    // ⏳ (PromiseBeacon) and 🔭 (PresenceProxy) from double-posting.
    const { ProxyCoordinator } = await import('../monitoring/ProxyCoordinator.js');
    const proxyCoordinator = new ProxyCoordinator();

    // ── Shared LlmQueue (priority-laned, daily-spend-capped) ──
    const { LlmQueue: SharedLlmQueueCls } = await import('../monitoring/LlmQueue.js');
    const promiseBeaconCfg = ((config as any).promiseBeacon ?? {}) as {
      prefix?: string;
      maxDailyLlmSpendCents?: number;
      sentinelAutoEnable?: boolean;
      quietHours?: { start: string; end: string; timezone?: string };
      maxActiveBeacons?: number;
    };
    const sharedLlmQueue = new SharedLlmQueueCls({
      maxConcurrent: 3,
      interactiveReservePct: 0.4,
      maxDailyCents: promiseBeaconCfg.maxDailyLlmSpendCents ?? 100,
    });
    // sharedLlmQueue is wired into both PromiseBeacon (background lane) and
    // PresenceProxy (interactive lane) below.

    let presenceProxy: import('../monitoring/PresenceProxy.js').PresenceProxy | undefined;
    if (sharedIntelligence && telegram) {
      try {
        const { PresenceProxy } = await import('../monitoring/PresenceProxy.js');
        const { execSync: shellExecSync } = await import('child_process');

        const messagesLogPath = path.join(config.stateDir, 'telegram-messages.jsonl');
        const slackMessagesLogPath = path.join(config.stateDir, 'slack-messages.jsonl');

        // Shared helper: check a messages log file for agent responses after a timestamp.
        // System/proxy-message filtering is delegated to isSystemOrProxyMessage so all
        // three callsites (this one, PresenceProxy.isSystemMessage, and the compaction
        // recoverFn) stay in sync.
        const checkLogForAgentResponse = (logPath: string, topicId: number, sinceIso: string): boolean => {
          try {
            const content = fs.readFileSync(logPath, 'utf-8');
            const lines = content.trim().split('\n').slice(-50);
            for (const line of lines) {
              try {
                const msg = JSON.parse(line);
                // Slack logs use channelId (string); Telegram logs use topicId (number).
                // For Slack synthetic IDs (negative), match against channelId via the map.
                const matchesTopic = msg.topicId === topicId
                  || (topicId < 0 && msg.channelId && slackChannelToSyntheticId(String(msg.channelId)) === topicId);
                if (matchesTopic && !msg.fromUser && msg.timestamp > sinceIso) {
                  if (!isSystemOrProxyMessage(msg.text)) return true;
                }
              } catch { /* skip malformed lines */ }
            }
            return false;
          } catch {
            return false;
          }
        };

        presenceProxy = new PresenceProxy({
          stateDir: config.stateDir,
          intelligence: sharedIntelligence,
          agentName: config.projectName ?? 'the agent',
          hasAgentRespondedSince: (topicId, sinceMs) => {
            const sinceIso = new Date(sinceMs).toISOString();
            // Check Telegram log
            if (checkLogForAgentResponse(messagesLogPath, topicId, sinceIso)) return true;
            // Also check Slack log (for Slack synthetic IDs or cross-platform responses)
            if (checkLogForAgentResponse(slackMessagesLogPath, topicId, sinceIso)) return true;
            return false;
          },
          captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          getSessionForTopic: (topicId) => {
            // Check if this is a Slack synthetic ID
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              return _slackAdapter.getSessionForChannel(slackChId) ?? null;
            }
            return telegram!.getSessionForTopic(topicId);
          },
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          sendMessage: async (topicId, text, metadata) => {
            // Check if this is a Slack synthetic ID (negative = Slack channel)
            const slackChannelId = slackProxyChannelMap.get(topicId);
            if (slackChannelId && _slackAdapter) {
              // Never send proxy messages to system channels (dashboard, lifeline)
              if (_slackAdapter.isSystemChannel(slackChannelId)) return;
              // Route directly to Slack channel
              await _slackAdapter.sendToChannel(slackChannelId, text);
              return;
            }

            // Send to Telegram
            const url = `http://localhost:${config.port}/telegram/reply/${topicId}`;
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.authToken}`,
              },
              body: JSON.stringify({ text, metadata }),
            });
            if (!response.ok) {
              throw new Error(`Reply failed: ${response.status}`);
            }

            // Slack standby is now handled directly via its own PresenceProxy wiring
            // (Slack onMessageLogged → synthetic ID → PresenceProxy → sendMessage → Slack channel).
            // No more Telegram→Slack mirroring — that caused standby spam when only Telegram was active.
          },
          getAuthorizedUserIds: () => {
            const ids = config.messaging?.[0]?.config?.authorizedUserIds;
            if (Array.isArray(ids)) return ids;
            const ownerId = config.monitoring?.promptGate?.ownerId;
            return ownerId ? [ownerId] : [];
          },
          getProcessTree: (sessionName) => {
            // Return only genuinely active processes — filter out Claude Code itself
            // and baseline children (MCP servers, caffeinate, etc.) so that
            // PresenceProxy tier 3 falls through to LLM assessment when the session
            // is idle at its prompt. Without this filtering, the Claude node process
            // alone makes tier 3 conclude "working" and skip stall detection.
            const BASELINE_PATTERNS = [
              /\bplaywright-mcp\b/,
              /\bplaywright\/mcp\b/,
              /\bmcp-stdio-entry\b/,
              /\bmcp.*server\b/i,
              /\bcaffeinate\b/,
              /\bnpm exec\b.*mcp/,
              /\bclaude\b/,
              /\bnode\b.*\bclaude\b/,
            ];
            try {
              const panePid = shellExecSync(
                `tmux display-message -t '=${sessionName}' -p '#{pane_pid}' 2>/dev/null`
              ).toString().trim();
              if (!panePid) return [];
              const childPids = shellExecSync(
                `pgrep -P ${panePid} 2>/dev/null`
              ).toString().trim();
              if (!childPids) return [];
              const pids = childPids.split('\n').filter(Boolean).join(',');
              const psOutput = shellExecSync(
                `ps -o pid=,command= -p ${pids} 2>/dev/null`
              ).toString().trim();
              if (!psOutput) return [];
              return psOutput.split('\n').map(line => {
                const match = line.trim().match(/^(\d+)\s+(.+)$/);
                return match ? { pid: parseInt(match[1], 10), command: match[2] } : null;
              }).filter((p): p is { pid: number; command: string } => {
                if (!p) return false;
                return !BASELINE_PATTERNS.some(pattern => pattern.test(p.command));
              });
            } catch {
              return [];
            }
          },
          triggerManualTriage: triageNurse
            ? async (topicId, sessionName) => {
                await triageNurse!.triage(topicId, sessionName, '', Date.now(), 'manual');
              }
            : undefined,
          recoverContextExhaustion: sessionRecovery
            ? async (topicId, sessionName) => {
                const result = await sessionRecovery!.checkAndRecover(topicId, sessionName);
                return { recovered: result.recovered };
              }
            : undefined,
          // Shared per-topic mutex — coordinates with PromiseBeacon.
          acquireProxyMutex: (topicId, holder) => proxyCoordinator.tryAcquire(topicId, holder),
          releaseProxyMutex: (topicId, holder) => proxyCoordinator.release(topicId, holder),
          // BUILD-STALL-VISIBILITY-SPEC Fix 2 — suppress generic standby when
          // a /build heartbeat landed recently on this topic.
          hasRecentBuildHeartbeat: (topicId, windowMs) => proxyCoordinator.hasRecentBuildHeartbeat(topicId, windowMs),
          // Shared LLM queue (interactive lane) — cross-monitor concurrency
          // and daily-spend-cap with PromiseBeacon.
          sharedLlmQueue,
        });

        // Hook into Telegram's onMessageLogged callback (always active, unlike EventBus which requires a feature flag)
        const existingCallback = telegram.onMessageLogged;
        telegram.onMessageLogged = (entry) => {
          // Call existing callback first (TopicMemory dual-write)
          if (existingCallback) {
            existingCallback(entry);
          }
          // Forward to PresenceProxy
          presenceProxy!.onMessageLogged({
            messageId: entry.messageId,
            channelId: entry.topicId?.toString() ?? '',
            text: entry.text,
            fromUser: entry.fromUser,
            timestamp: entry.timestamp,
            sessionName: entry.sessionName,
            senderName: entry.senderName,
            senderUsername: entry.senderUsername,
            platformUserId: entry.telegramUserId?.toString(),
          });
        };

        presenceProxy.start();

        // ── PromiseBeacon ────────────────────────────────────────────────
        // Watches beacon-enabled commitments and emits ⏳ heartbeats so the
        // user knows the agent hasn't gone silent on an open promise.
        // Spec: docs/specs/PROMISE-BEACON-SPEC.md
        try {
          const { PromiseBeacon } = await import('../monitoring/PromiseBeacon.js');
          const promiseBeacon = new PromiseBeacon({
            stateDir: config.stateDir,
            commitmentTracker,
            llmQueue: sharedLlmQueue,
            proxyCoordinator,
            captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
            getSessionForTopic: (topicId) => telegram!.getSessionForTopic(topicId),
            isSessionAlive: (name) => sessionManager.isSessionAlive(name),
            sendMessage: async (topicId, text, metadata) => {
              const url = `http://localhost:${config.port}/telegram/reply/${topicId}`;
              const response = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${config.authToken}`,
                },
                body: JSON.stringify({ text, metadata }),
              });
              if (!response.ok) throw new Error(`Beacon reply failed: ${response.status}`);
            },
            prefix: promiseBeaconCfg.prefix ?? '⏳',
            maxDailyLlmSpendCents: promiseBeaconCfg.maxDailyLlmSpendCents ?? 100,
            sentinelAutoEnable: promiseBeaconCfg.sentinelAutoEnable ?? false,
            quietHours: promiseBeaconCfg.quietHours ?? { start: '22:00', end: '08:00' },
            maxActiveBeacons: promiseBeaconCfg.maxActiveBeacons ?? 20,
          });
          promiseBeacon.start();
          (globalThis as Record<string, unknown>).__instarPromiseBeacon = promiseBeacon;
        } catch (err) {
          console.warn('[PromiseBeacon] init failed:', (err as Error).message);
        }

        // Wire Slack's onMessageLogged into PresenceProxy + TopicMemory (if Slack is active)
        if (_slackAdapter) {
          const existingSlackCallback = _slackAdapter.onMessageLogged;
          _slackAdapter.onMessageLogged = (entry) => {
            if (existingSlackCallback) {
              existingSlackCallback(entry);
            }

            // TopicMemory dual-write (matches Telegram's insertMessage pattern)
            // TopicMemory uses numeric topicId; for Slack we use the synthetic hash
            if (entry.channelId && topicMemory) {
              const synId = slackChannelToSyntheticId(String(entry.channelId));
              topicMemory.insertMessage({
                messageId: typeof entry.messageId === 'number' ? entry.messageId : 0,
                topicId: synId,
                text: entry.text,
                fromUser: entry.fromUser,
                timestamp: entry.timestamp,
                sessionName: entry.sessionName,
                senderName: entry.senderName,
              });
            }

            // Clear stall tracking when agent responds in this channel
            if (!entry.fromUser && entry.channelId) {
              _slackAdapter!.clearStallTracking(String(entry.channelId));
            }

            // Convert Slack channelId to synthetic numeric ID for PresenceProxy
            // Skip system channels (dashboard, lifeline) — they don't have interactive sessions
            if (!entry.channelId) return;
            if (_slackAdapter!.isSystemChannel(String(entry.channelId))) return;
            const syntheticId = slackChannelToSyntheticId(String(entry.channelId));
            presenceProxy!.onMessageLogged({
              messageId: typeof entry.messageId === 'number' ? entry.messageId : parseInt(String(entry.messageId), 10) || 0,
              channelId: syntheticId.toString(),
              text: entry.text,
              fromUser: entry.fromUser,
              timestamp: entry.timestamp,
              sessionName: entry.sessionName,
              senderName: entry.senderName,
              platformUserId: entry.platformUserId != null ? String(entry.platformUserId) : undefined,
            });
          };
          console.log(pc.green('  Presence Proxy wired to Slack'));

          // Wire standby commands for Slack (unstick, quiet, resume, restart)
          _slackAdapter.onStandbyCommand = async (channelId, command, userId) => {
            const syntheticId = slackChannelToSyntheticId(channelId);
            return presenceProxy!.handleCommand(syntheticId, command, parseInt(userId, 10) || 0);
          };

          // Wire triage status for Slack !triage command
          if (triageOrchestrator) {
            _slackAdapter.onGetTriageStatus = (channelId) => {
              const syntheticId = slackChannelToSyntheticId(channelId);
              const ts = triageOrchestrator!.getTriageState(syntheticId);
              if (!ts) return null;
              return {
                active: true,
                classification: ts.classification,
                checkCount: ts.checkCount,
                lastCheck: new Date(ts.lastCheckAt).toISOString(),
              };
            };
          }
        }

        console.log(pc.green('  Presence Proxy enabled (🔭 [Standby])'));
      } catch (err) {
        console.error(`[PresenceProxy] Failed to initialize:`, err);
      }
    }

    // Start CaffeinateManager (prevents macOS system sleep)
    const { CaffeinateManager } = await import('../core/CaffeinateManager.js');
    const caffeinateManager = new CaffeinateManager({ stateDir: config.stateDir });
    caffeinateManager.start();

    // Start SleepWakeDetector (re-validate sessions on wake)
    const { SleepWakeDetector } = await import('../core/SleepWakeDetector.js');
    const sleepWakeDetector = new SleepWakeDetector();
    sleepWakeDetector.on('wake', async (event: { sleepDurationSeconds: number; timestamp: string }) => {
      console.log(`[SleepWake] Wake detected after ~${event.sleepDurationSeconds}s sleep`);

      // Checkpoint SQLite WAL files to flush stale locks from pre-sleep connections
      try { topicMemory?.checkpoint(); } catch { /* non-critical */ }
      try { semanticMemory?.checkpoint(); } catch { /* non-critical */ }

      // Re-validate tmux sessions
      try {
        const tmuxPath = detectTmuxPath();
        if (tmuxPath) {
          const { execFileSync } = await import('child_process');
          const result = execFileSync(tmuxPath, ['list-sessions'], { encoding: 'utf-8', timeout: 5000 }).trim();
          console.log(`[SleepWake] tmux sessions after wake: ${result.split('\n').length}`);
        }
      } catch {
        console.warn('[SleepWake] tmux check failed after wake');
      }

      // Restart tunnel if configured — disable auto-reconnect first to prevent
      // a cascade of competing reconnection attempts, then forceStop to handle
      // zombie cloudflared processes that may be hung after sleep.
      if (tunnel) {
        try {
          await Promise.race([
            (async () => {
              tunnel.disableAutoReconnect();
              await tunnel.forceStop(5000);
              tunnel.enableAutoReconnect();
              const tunnelUrl = await tunnel.start();
              console.log(`[SleepWake] Tunnel restarted: ${tunnelUrl}`);

              // Re-broadcast dashboard URL after tunnel restart (quick tunnels get new URL)
              if (tunnelUrl) {
                const tunnelType = config.tunnel?.type || 'quick';
                if (telegram) {
                  await telegram.broadcastDashboardUrl(tunnelUrl, tunnelType as 'quick' | 'named').catch(() => {});
                }
                if (_slackAdapter) {
                  await _slackAdapter.broadcastDashboardUrl(tunnelUrl).catch(() => {});
                }
              }
            })(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Tunnel restart timed out after 15s')), 15_000)
            ),
          ]);
        } catch (err) {
          console.error(`[SleepWake] Tunnel restart failed:`, err);
          // Re-enable auto-reconnect even on failure so it can self-heal
          tunnel.enableAutoReconnect();
        }
      }

      // Reconnect Slack after sleep — WebSocket connections die during sleep
      // and the close-handler reconnect can silently fail if the network isn't
      // fully up yet. Proactive reconnect after a short delay is more reliable.
      if (slackAdapter) {
        // Wait 2s for network to stabilize after wake before reconnecting
        setTimeout(async () => {
          try {
            await slackAdapter!.reconnect();
            console.log('[SleepWake] Slack reconnected');
          } catch (err) {
            console.error('[SleepWake] Slack reconnect failed:', (err as Error).message);
          }
        }, 2000);
      }

      // Notify via batcher — wake events are informational, not urgent
      // Only notify for long sleeps (>5 min) — short sleeps are routine and not worth mentioning
      if (event.sleepDurationSeconds > 300) {
        const mins = Math.round(event.sleepDurationSeconds / 60);
        notify('DIGEST', 'system',
          `Machine woke up after ${mins > 60 ? `${Math.round(mins / 60)}h` : `${mins}m`} of sleep. Everything's reconnected and running.`
        );
      }
    });
    sleepWakeDetector.start();

    // Project Map + Coherence Gate — spatial awareness and pre-action verification
    const projectMapper = new ProjectMapper({ projectDir: config.projectDir, stateDir: config.stateDir });
    try {
      projectMapper.generateAndSave();
      console.log(pc.green('  Project map generated'));
    } catch (err) {
      // @silent-fallback-ok — project map non-critical
      console.error(`  Project map generation failed (non-critical): ${err instanceof Error ? err.message : err}`);
    }

    // Self-Knowledge Tree — tree-based agent self-knowledge with LLM triage
    let selfKnowledgeTree: SelfKnowledgeTree | undefined;
    let coverageAuditor: CoverageAuditor | undefined;
    try {
      selfKnowledgeTree = new SelfKnowledgeTree({
        projectDir: config.projectDir,
        stateDir: config.stateDir,
        intelligence: sharedIntelligence ?? null,
        memoryIndex: semanticMemory ?? undefined,
      });
      coverageAuditor = new CoverageAuditor(config.projectDir, config.stateDir);
      _selfKnowledgeTree = selfKnowledgeTree;

      const treeConfig = selfKnowledgeTree.getConfig();
      if (treeConfig) {
        const totalNodes = treeConfig.layers.reduce((s: number, l: { children: unknown[] }) => s + l.children.length, 0);
        console.log(pc.green(`  Self-knowledge tree loaded (${totalNodes} nodes)`));
      } else {
        console.log(pc.dim('  Self-knowledge tree: not generated yet (run instar init or doctor)'));
      }
    } catch (err) {
      // @silent-fallback-ok — self-knowledge tree non-critical at startup
      console.error(`  Self-knowledge tree init failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Capability Map — fractal self-knowledge for agent introspection
    const capabilityMapper = new CapabilityMapper({
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      projectName: config.projectName,
      version: config.version || '0.0.0',
      port: config.port,
    });
    // Initial map generation (async, non-blocking)
    capabilityMapper.refresh().then(() => {
      console.log(pc.green('  Capability map generated'));
    }).catch((err: Error) => {
      // @silent-fallback-ok — capability map non-critical at startup
      console.error(`  Capability map generation failed (non-critical): ${err.message}`);
    });

    const scopeVerifier = new ScopeVerifier({
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      projectName: config.projectName,
    });
    // Load any persisted topic-project bindings
    scopeVerifier.loadTopicBindings();

    // Context Hierarchy — tiered context loading for session efficiency
    const contextHierarchy = new ContextHierarchy({
      stateDir: config.stateDir,
      projectDir: config.projectDir,
      projectName: config.projectName,
    });
    const ctxResult = contextHierarchy.initialize();
    if (ctxResult.created.length > 0) {
      console.log(pc.green(`  Context hierarchy: ${ctxResult.created.length} segments created`));
    }

    // Canonical State — registry-first state management
    const canonicalState = new CanonicalState({ stateDir: config.stateDir });
    const stateResult = canonicalState.initialize(config.projectName, config.projectDir);
    if (stateResult.created.length > 0) {
      console.log(pc.green(`  Canonical state: ${stateResult.created.length} registries created`));
    }

    // External Operation Safety — gate, sentinel, trust
    const extOpsConfig = config.externalOperations;
    const extOpsEnabled = extOpsConfig?.enabled !== false;
    const autonomyLevel = config.agentAutonomy?.level ?? 'collaborative';
    const autonomyProfile = AUTONOMY_PROFILES[autonomyLevel] ?? AUTONOMY_PROFILES.collaborative;
    const operationGate = extOpsEnabled ? new ExternalOperationGate({
      stateDir: config.stateDir,
      autonomyDefaults: autonomyProfile,
      services: (extOpsConfig?.services ?? {}) as Record<string, import('../core/ExternalOperationGate.js').ServicePermissions>,
      readOnlyServices: extOpsConfig?.readOnlyServices ?? [],
    }) : undefined;
    const sentinel = extOpsEnabled && extOpsConfig?.sentinel?.enabled !== false
      ? new MessageSentinel({ intelligence: sharedIntelligence })
      : undefined;
    const adaptiveTrust = extOpsEnabled ? new AdaptiveTrust({
      stateDir: config.stateDir,
    }) : undefined;
    if (extOpsEnabled) {
      const sentinelMode = sentinel
        ? (sharedIntelligence ? 'LLM-supervised' : 'fast-path only')
        : 'off';
      console.log(pc.green(`  External operation safety: gate=${autonomyLevel}, sentinel=${sentinelMode}, trust=on`));
    }

    // Adaptive Autonomy — unified profile coordinator
    const autonomyManager = new AutonomyProfileManager({
      stateDir: config.stateDir,
      config,
      adaptiveTrust: adaptiveTrust ?? null,
      evolution: evolution ?? null,
    });
    console.log(pc.green(`  Autonomy profile: ${autonomyManager.getProfile()}`));

    // Trust Elevation Tracker — monitors acceptance rates and surfaces upgrade opportunities
    const trustElevationTracker = new TrustElevationTracker({
      stateDir: config.stateDir,
    });

    // Autonomous Evolution — auto-approval and auto-implementation of proposals
    const autonomousEvolution = new AutonomousEvolution({
      stateDir: config.stateDir,
      enabled: autonomyManager.getResolvedState().evolutionApprovalMode === 'autonomous',
    });

    // Dispatch Scope Enforcer — scope tiers for dispatch execution
    const dispatchScopeEnforcer = new DispatchScopeEnforcer();

    // Trust Recovery — recovery path after trust incidents
    const trustRecovery = extOpsEnabled ? new TrustRecovery({
      stateDir: config.stateDir,
    }) : undefined;

    // ── Adaptive Autonomy Wiring ──────────────────────────────────────
    // Wire the new modules together so they exchange events at runtime.

    // 1. AdaptiveTrust ↔ TrustRecovery
    //    When trust drops (incident), record in TrustRecovery.
    //    When operations succeed post-incident, increment recovery counter.
    if (adaptiveTrust && trustRecovery) {
      adaptiveTrust.setTrustRecovery(trustRecovery);
    }

    // 2. AutoDispatcher ↔ DispatchScopeEnforcer
    //    Before executing a dispatch, check scope permissions against current autonomy profile.
    if (autoDispatcher) {
      autoDispatcher.setScopeEnforcer(dispatchScopeEnforcer, autonomyManager);
    }

    // 3. EvolutionManager ↔ TrustElevationTracker + AutonomousEvolution
    //    Proposal decisions feed trust elevation tracking.
    //    Autonomous mode uses AutonomousEvolution for auto-implementation.
    evolution.setAdaptiveAutonomyModules({
      trustElevationTracker,
      autonomousEvolution,
      autonomyManager,
    });

    // Wire sentinel into Telegram message flow — intercepts BEFORE session routing.
    // Must be wired AFTER sentinel is created but BEFORE server starts.
    if (sentinel && telegram) {
      telegram.onSentinelIntercept = async (text: string, _topicId: number) => {
        const classification = await sentinel.classify(text);
        if (classification.category === 'emergency-stop' || classification.category === 'pause') {
          return {
            category: classification.category,
            action: classification.action as { type: string; message?: string },
            reason: classification.reason,
          };
        }
        return null; // Normal messages pass through
      };
      telegram.onSentinelKillSession = (sessionName: string) => {
        // Save resume UUID before killing so respawn can --resume
        if (_topicResumeMap) {
          try {
            const sessions = sessionManager.listRunningSessions();
            const session = sessions.find(s => s.tmuxSession === sessionName);
            const uuid = _topicResumeMap.findUuidForSession(sessionName, session?.claudeSessionId ?? undefined);
            if (uuid) {
              const topicSessions = telegram.getAllTopicSessions();
              for (const [topicId, sessName] of topicSessions) {
                if (sessName === sessionName) {
                  _topicResumeMap.save(topicId, uuid, sessionName);
                  console.log(`[sentinel] Saved resume UUID ${uuid} for topic ${topicId} before kill`);
                  break;
                }
              }
            }
          } catch { /* best effort */ }
        }
        return sessionManager.killSession(sessionName);
      };
      telegram.onSentinelPauseSession = (sessionName: string) => {
        // Save resume UUID so if the session dies during pause, respawn can --resume
        if (_topicResumeMap) {
          try {
            const sessions = sessionManager.listRunningSessions();
            const session = sessions.find(s => s.tmuxSession === sessionName);
            const uuid = _topicResumeMap.findUuidForSession(sessionName, session?.claudeSessionId ?? undefined);
            if (uuid) {
              const topicSessions = telegram.getAllTopicSessions();
              for (const [topicId, sessName] of topicSessions) {
                if (sessName === sessionName) {
                  _topicResumeMap.save(topicId, uuid, sessionName);
                  console.log(`[sentinel] Saved resume UUID ${uuid} for topic ${topicId} on pause`);
                  break;
                }
              }
            }
          } catch { /* best effort */ }
        }
      };
      console.log(pc.green('  Sentinel wired into Telegram message flow'));
    }

    // Inter-Agent Messaging — structured communication between sessions
    const messageStore = new MessageStore(path.join(config.stateDir, 'messages'));
    await messageStore.initialize();
    const threadResumeMap = new ThreadResumeMap(config.stateDir, config.stateDir);
    const messageFormatter = new MessageFormatter();
    const tmuxBin = config.sessions.tmuxPath;
    const tmuxOps: TmuxOperations = {
      getForegroundProcess(tmuxSession: string): string {
        try {
          return execFileSync(tmuxBin, ['list-panes', '-t', `=${tmuxSession}:`, '-F', '#{pane_current_command}'], {
            encoding: 'utf-8', timeout: 5000,
          }).trim().split('\n')[0] || 'unknown';
        } catch { /* @silent-fallback-ok — tmux query, delivery layer handles unknown */ return 'unknown'; }
      },
      isSessionAlive(tmuxSession: string): boolean {
        return sessionManager.isSessionAlive(tmuxSession);
      },
      hasActiveHumanInput(_tmuxSession: string): boolean {
        // Agent sessions don't have human input — safe to inject
        return false;
      },
      sendKeys(tmuxSession: string, text: string): boolean {
        try {
          const target = `=${tmuxSession}:`;
          execFileSync(tmuxBin, ['send-keys', '-t', target, '-l', text], { encoding: 'utf-8', timeout: 5000 });
          execFileSync(tmuxBin, ['send-keys', '-t', target, 'Enter'], { encoding: 'utf-8', timeout: 5000 });
          return true;
        } catch { /* @silent-fallback-ok — send-keys boolean return */ return false; }
      },
      getOutputLineCount(tmuxSession: string): number {
        try {
          const output = execFileSync(tmuxBin, ['capture-pane', '-t', `=${tmuxSession}:`, '-p'], {
            encoding: 'utf-8', timeout: 5000,
          });
          return output.split('\n').length;
        } catch { /* @silent-fallback-ok — capture-pane line count, 0 triggers inline delivery */ return 0; }
      },
    };
    const messageDelivery = new MessageDelivery(messageFormatter, tmuxOps);
    const machineId = coordinator.identity?.machineId ?? os.hostname();
    // Build cross-machine deps if multi-machine is enabled
    const crossMachineDeps = coordinator.enabled && coordinator.identity
      ? {
          identityManager: coordinator.managers.identityManager,
          signingKeyPem: localSigningKeyPem,
          nonceStore: coordinator.managers.nonceStore,
          securityLog: coordinator.managers.securityLog,
        }
      : undefined;
    const messageRouter = new MessageRouter(messageStore, messageDelivery, {
      localAgent: config.projectName,
      localMachine: machineId,
      serverUrl: `http://localhost:${config.port}`,
    }, crossMachineDeps);
    // Generate/persist agent token for cross-agent auth (idempotent — reuses existing token)
    const agentToken = generateAgentToken(config.projectName);

    // Pick up any messages dropped while this agent was offline
    const dropResult = await pickupDroppedMessages(config.projectName, messageStore);
    const dropSummary = dropResult.ingested > 0
      ? ` | picked up ${dropResult.ingested} dropped message(s)`
      : '';
    if (dropResult.rejected > 0) {
      console.warn(pc.yellow(`  Messaging: rejected ${dropResult.rejected} dropped message(s): ${dropResult.rejections.map(r => r.reason).join(', ')}`));
    }

    // Pick up any messages received via git-sync while offline (Phase 4: cross-machine)
    const localMachineId = coordinator.identity?.machineId;
    if (localMachineId) {
      const gitSyncResult = await pickupGitSyncMessages({
        localMachineId,
        stateDir: config.stateDir,
        store: messageStore,
        verifySignature: crossMachineDeps
          ? (envelope) => messageRouter.verifyInboundSignature(envelope)
          : undefined,
      });
      if (gitSyncResult.ingested > 0) {
        console.log(pc.green(`  Git-sync: picked up ${gitSyncResult.ingested} cross-machine message(s)`));
      }
      if (gitSyncResult.rejected > 0) {
        console.warn(pc.yellow(`  Git-sync: rejected ${gitSyncResult.rejected} message(s): ${gitSyncResult.rejections.map(r => r.reason).join(', ')}`));
      }
    }

    // Start delivery retry manager for automatic retries, watchdog, and TTL expiry
    const retryManager = new DeliveryRetryManager(messageStore, messageDelivery, {
      agentName: config.projectName,
      onEscalate: (envelope, reason) => {
        notify('IMMEDIATE', 'messaging', `Message escalation: ${reason}\n  From: ${envelope.message.from.agent}\n  Subject: ${envelope.message.subject}`);
      },
    });
    retryManager.start();

    // Session summary sentinel for intelligent routing (Phase 2)
    const { SessionSummarySentinel } = await import('../messaging/SessionSummarySentinel.js');
    const summarySentinel = new SessionSummarySentinel({
      stateDir: config.stateDir,
      getActiveSessions: () => sessionManager.listRunningSessions(),
      captureOutput: (tmuxSession: string) => {
        try {
          const tmuxBin = detectTmuxPath();
          if (!tmuxBin) return null;
          const output = execFileSync(tmuxBin, ['capture-pane', '-t', `=${tmuxSession}:`, '-p'], {
            encoding: 'utf-8', timeout: 5000,
          });
          return output;
        } catch { return null; } // @silent-fallback-ok — tmux capture-pane for sentinel
      },
    });
    summarySentinel.start();
    messageRouter.setSummarySentinel(summarySentinel);

    // On-demand session spawning for message delivery (Phase 5)
    // §4.4: spawn knobs are read from config.threadline.spawn — see
    // ThreadlineSpawnConfig in core/types.ts. All fields are optional and
    // fall through to manager-level defaults if absent.
    const spawnConfig = config.threadline?.spawn;
    // Forward-declared `let` so the onDrainReady callback can reference the
    // manager it belongs to (for re-entrant evaluate() calls during drain).
    let spawnManager: SpawnRequestManager;
    spawnManager = new SpawnRequestManager({
      maxSessions: config.sessions.maxSessions ?? 5,
      getActiveSessions: () => sessionManager.listRunningSessions(),
      spawnSession: async (prompt, opts) => {
        const session = await sessionManager.spawnSession({
          name: `msg-spawn-${Date.now()}`,
          prompt,
          model: opts?.model as import('../core/types.js').ModelTier | undefined,
          maxDurationMinutes: opts?.maxDurationMinutes,
          // §4.5: honor SpawnRequestManager's provenance tag so drain-spawned
          // sessions are distinguishable from inline-spawned ones in logs/stream.
          triggeredBy: opts?.triggeredBy ?? 'spawn-request',
        });
        return session.id;
      },
      isMemoryPressureHigh: memoryMonitor
        ? () => {
            const state = memoryMonitor!.getState();
            return state.state === 'critical' || state.state === 'elevated';
          }
        : undefined,
      onEscalate: (request, reason) => {
        notify('IMMEDIATE', 'messaging', `Spawn escalation: ${reason}\n  Requester: ${request.requester.agent}\n  Target: ${request.target.agent}`);
      },
      // §4.5: emit degradation breadcrumbs on edge transitions.
      onDegradation: (event) => {
        try {
          const reporter = DegradationReporter.getInstance();
          if (event.kind === 'spawn-penalty-tripped') {
            reporter.report({
              feature: 'Threadline.SpawnPenalty',
              primary: `Open spawn slot for peer "${event.agent}"`,
              fallback: `Spawn blocked for ${Math.round(event.penaltyMs / 1000)}s after ${event.consecutiveFailures} consecutive agent-attributable failures`,
              reason: `Peer "${event.agent}" tripped the consecutive-failure penalty (3 strikes)`,
              impact: 'Peer cannot spawn sessions until penalty clears. Successful inbound spawn from a different peer is unaffected.',
            });
          } else if (event.kind === 'spawn-infra-degraded') {
            reporter.report({
              feature: 'Threadline.SpawnInfraDegraded',
              primary: `Full queue admission (cap 10) for peer "${event.agent}"`,
              fallback: `Degraded admission (cap ${spawnConfig?.degradedMaxQueuedPerAgent ?? 1}) for ${Math.round(event.degradationMs / 60_000)}min`,
              reason: `Peer "${event.agent}" tripped the infra-failure soft limiter (${event.failureCount} non-attributable failures in 10min)`,
              impact: 'Peer\'s queue depth is capped; older messages are dropped. No blame attribution.',
            });
          }
        } catch (err) {
          console.warn(`[spawn-manager] degradation reporter failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      // §4.4: optional knobs from config.
      cooldownMs: spawnConfig?.cooldownMs,
      maxDrainsPerTick: spawnConfig?.maxDrainsPerTick,
      maxEnvelopeBytes: spawnConfig?.maxEnvelopeBytes,
      maxGlobalQueued: spawnConfig?.maxGlobalQueued,
      degradedMaxQueuedPerAgent: spawnConfig?.degradedMaxQueuedPerAgent,
      // §4.4 commit 2 + §4.5: drain-loop consumer wiring.
      // When the drain loop finds an agent ready (cooldown cleared + queued
      // messages present), this callback re-invokes evaluate() with a
      // synthetic SpawnRequest tagged `triggeredBy: 'spawn-request-drain'`.
      // The real queued context is reattached by SpawnRequestManager.evaluate
      // via its internal drainQueue() call. Stub session/machine values:
      // requester.session/machine isn't preserved per-message — those fields
      // are only used in the spawn prompt template for display.
      onDrainReady: async (agent: string) => {
        try {
          const result = await spawnManager.evaluate({
            requester: { agent, session: 'drain', machine: 'drain' },
            target: { agent: config.projectName, machine: os.hostname() },
            reason: `Drain re-attempt for queued messages from ${agent}`,
            priority: 'medium',
            triggeredBy: 'spawn-request-drain',
          });
          if (!result.approved) {
            console.log(`[spawn-manager] drain re-attempt for ${agent} not approved: ${result.reason}`);
          }
        } catch (err) {
          console.warn(`[spawn-manager] drain re-attempt for ${agent} threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    // §4.4 kill switch: drain loop runs unless explicitly disabled in config.
    // Wired here so emergency rollback is a config flip, not a code change.
    if (spawnConfig?.drainEnabled !== false) {
      spawnManager.start();
      console.log(`[spawn-manager] drain loop started (tick=${spawnManager.getDrainTickMs()}ms)`);
    } else {
      console.log('[spawn-manager] drain loop disabled by config.threadline.spawn.drainEnabled=false');
    }

    // Threadline Router — handles threaded cross-agent conversations via relay
    const threadlineRouter = new ThreadlineRouter(
      messageRouter, spawnManager, threadResumeMap, messageStore,
      { localAgent: config.projectName, localMachine: os.hostname() },
      null, // autonomyGate
      messageDelivery, // PR-4: live-session injection path
    );

    // Listener Session Manager — warm session for fast relay responses (Phase 2)
    const listenerManager = config.threadline?.relayEnabled
      ? new ListenerSessionManager(config.stateDir, config.authToken ?? '', config.threadline as Partial<import('../threadline/ListenerSessionManager.js').ListenerConfig>)
      : null;

    // Wake Socket Server — receives signals from the standalone listener daemon (Phase 1)
    let wakeSocketServer: import('../threadline/WakeSocketServer.js').WakeSocketServer | undefined;
    try {
      const { WakeSocketServer } = await import('../threadline/WakeSocketServer.js');
      wakeSocketServer = new WakeSocketServer(config.stateDir);
      wakeSocketServer.on('wake', () => {
        // Daemon wrote a new inbox entry — read and process it
        const inboxPath = path.join(config.stateDir, 'threadline', 'inbox.jsonl.active');
        if (fs.existsSync(inboxPath)) {
          console.log('[wake-socket] Received wake signal from listener daemon');
        }
      });

      // Phase 3: Fast failover via relay presence detection
      wakeSocketServer.on('failover-trigger', () => {
        console.log('[wake-socket] Received FAILOVER_TRIGGER from listener daemon');
        // Read trigger details
        const triggerPath = path.join(config.stateDir, 'failover-trigger.json');
        if (fs.existsSync(triggerPath)) {
          try {
            const trigger = JSON.parse(fs.readFileSync(triggerPath, 'utf-8'));
            console.log(`[wake-socket] Peer agent ${trigger.agentId?.slice(0, 8)}... disconnected from relay`);
            // The MultiMachineCoordinator can use this to speed up failover
            // For now, log the event. Full failover integration requires
            // evaluating whether this agent is a standby for the disconnected peer.
          } catch { /* ignore parse errors */ }
        }
      });

      wakeSocketServer.start();
      console.log(pc.dim(`  Wake socket: listening at ${path.join(config.stateDir, 'listener.sock')}`));
    } catch (err) {
      console.log(pc.dim(`  Wake socket: not started (${err instanceof Error ? err.message : err})`));
    }

    // Pipe Session Spawner — lightweight claude -p sessions for simple queries (Phase 2)
    let pipeSpawner: import('../threadline/PipeSessionSpawner.js').PipeSessionSpawner | undefined;
    if (config.threadline?.relayEnabled) {
      try {
        const { PipeSessionSpawner } = await import('../threadline/PipeSessionSpawner.js');
        const pipeConfig = config.threadline?.listener?.pipeMode;
        pipeSpawner = new PipeSessionSpawner({
          stateDir: config.stateDir,
          model: pipeConfig?.model ?? 'sonnet',
          timeoutMs: pipeConfig?.timeoutMs ?? 600_000,
          warningMs: pipeConfig?.warningMs ?? 480_000,
          maxConcurrent: pipeConfig?.maxConcurrent ?? 5,
          allowedTools: pipeConfig?.allowedTools ?? ['threadline_send', 'Read', 'Glob', 'Grep'],
          allowedPaths: pipeConfig?.allowedPaths ?? ['src/', 'docs/', 'specs/'],
          minIqsBand: pipeConfig?.minIqsBand ?? 70,
        });
        console.log(pc.dim(`  Pipe sessions: enabled (model: ${pipeConfig?.model ?? 'sonnet'}, max: ${pipeConfig?.maxConcurrent ?? 5})`));
      } catch (err) {
        console.log(pc.dim(`  Pipe sessions: not available (${err instanceof Error ? err.message : err})`));
      }
    }

    console.log(pc.green(`  Inter-agent messaging: enabled (token: ${agentToken.slice(0, 8)}...)${dropSummary}`));

    // ── System Reviewer: self-monitoring feature health ──────────────
    const systemReviewConfig = config.monitoring?.systemReview;
    const systemReviewEnabled = systemReviewConfig?.enabled !== false; // default: enabled
    let systemReviewer: SystemReviewer | undefined;
    if (systemReviewEnabled) {
      const alertTopicId = state.get<number>('agent-attention-topic') ?? undefined;
      systemReviewer = new SystemReviewer(
        {
          enabled: true,
          scheduleMs: systemReviewConfig?.scheduleMs,
          scheduledTiers: systemReviewConfig?.scheduledTiers,
          autoSubmitFeedback: systemReviewConfig?.autoSubmitFeedback,
          feedbackConsentGiven: systemReviewConfig?.feedbackConsentGiven,
          alertOnCritical: systemReviewConfig?.alertOnCritical,
          alertCooldownMs: systemReviewConfig?.alertCooldownMs,
          disabledProbes: systemReviewConfig?.disabledProbes,
        },
        {
          stateDir: config.stateDir,
          sendAlert: telegram
            ? (_topicId, text) => {
                notify('SUMMARY', 'system-review', text, alertTopicId);
                return Promise.resolve();
              }
            : undefined,
          submitFeedback: feedback
            ? (item) => feedback!.submit({ ...item, os: `${process.platform} ${process.arch}` })
            : undefined,
        },
      );

      // Register Tier 1 probes with real dependencies
      const tmuxPath = detectTmuxPath() ?? '/usr/bin/tmux';
      const probes = [
        ...createSessionProbes({
          listRunningSessions: () => sessionManager.listRunningSessions(),
          getSessionDiagnostics: () => sessionManager.getSessionDiagnostics(),
          maxSessions: config.sessions?.maxSessions ?? 10,
          tmuxPath,
        }),
        ...createSchedulerProbes({
          getJobs: () => (scheduler?.getJobs() ?? []).map(j => ({ id: j.slug, name: j.name, enabled: j.enabled })),
          getStatus: () => scheduler?.getStatus() ?? { running: false, paused: false, jobCount: 0, enabledJobs: 0, queueLength: 0 },
          jobsFilePath: config.scheduler.jobsFile,
        }),
        ...(telegram ? createMessagingProbes({
          getStatus: () => telegram!.getStatus(),
          messageLogPath: path.join(config.stateDir, 'telegram-messages.jsonl'),
          isConfigured: () => true,
        }) : []),
        ...createLifelineProbes({
          // Supervisor status intentionally omitted: the supervisor only exists
          // in the lifeline process, not in the server. The process + queue probes
          // here check lifeline health via the lock file and queue contents,
          // which is the correct signal from the server's vantage point.
          getQueueLength: () => 0,
          peekQueue: () => [],
          lockFilePath: path.join(config.stateDir, 'lifeline.lock'),
          isEnabled: () => fs.existsSync(path.join(config.stateDir, 'lifeline.lock')),
        }),
        ...createPlatformProbes({
          tmuxPath,
        }),
      ];
      systemReviewer.registerAll(probes);
      systemReviewer.start();
      console.log(pc.green(`  System Reviewer: ${probes.length} probes registered`));
    }

    // ── Threadline Protocol: auto-bootstrap ──────────────────────────
    // Threadline is always ON — MCP tools registered into Claude Code,
    // discovery heartbeat running, identity keys persisted.
    // The user never sees any of this. The agent IS the interface.
    let threadlineHandshake: import('../threadline/HandshakeManager.js').HandshakeManager | undefined;
    let threadlineShutdown: (() => Promise<void>) | undefined;
    let threadlineRelayClient: import('../threadline/client/ThreadlineClient.js').ThreadlineClient | undefined;
    let unifiedTrust: UnifiedTrustSystem | undefined;
    /** Shared reply waiters for threadline waitForReply support */
    const threadlineReplyWaiters = new Map<string, { resolve: (reply: string) => void; threadId: string; senderAgent: string; timer: ReturnType<typeof setTimeout> }>();
    try {
      const threadline = await bootstrapThreadline({
        agentName: config.projectName,
        stateDir: config.stateDir,
        projectDir: config.projectDir,
        port: config.port,
        relayEnabled: config.threadline?.relayEnabled,
        relayUrl: config.threadline?.relayUrl,
        visibility: config.threadline?.visibility,
        capabilities: config.threadline?.capabilities,
      });
      threadlineHandshake = threadline.handshakeManager;
      threadlineShutdown = threadline.shutdown;
      threadlineRelayClient = threadline.relayClient;

      // Initialize unified trust system (three-layer model + MoltBridge)
      if (threadline.trustManager) {
        try {
          unifiedTrust = createUnifiedTrustSystem(threadline.trustManager, {
            stateDir: config.stateDir,
            moltbridge: config.moltbridge,
          });
          console.log(`Unified trust system initialized (identity: ${unifiedTrust.identity.get()?.displayFingerprint ?? 'none'})`);
        } catch (err) {
          console.error(`Unified trust system init failed (non-fatal): ${err instanceof Error ? err.message : err}`);
        }
      }

      if (threadlineRelayClient) {
        // Wire relay message delivery through ThreadlineRouter (Phase 1).
        // Replaces the ad-hoc handler with proper thread persistence, auto-ack,
        // and warm listener routing (Phase 2).

        // Per-sender stable synthetic threadId for messages without threadId
        const syntheticThreadIds = new Map<string, string>();
        function getSyntheticThreadId(fingerprint: string): string {
          if (!syntheticThreadIds.has(fingerprint)) {
            syntheticThreadIds.set(fingerprint, `auto-${crypto.randomUUID()}`);
          }
          return syntheticThreadIds.get(fingerprint)!;
        }

        // Per-sender ack rate limiter
        const ackTimestamps = new Map<string, number[]>();
        const ACK_RATE_LIMIT = config.threadline?.ackRateLimit ?? 5;
        const ACK_WINDOW_MS = 60 * 1000;
        function isAckRateLimited(fingerprint: string): boolean {
          const now = Date.now();
          let timestamps = ackTimestamps.get(fingerprint);
          if (!timestamps) { timestamps = []; ackTimestamps.set(fingerprint, timestamps); }
          const filtered = timestamps.filter(t => now - t < ACK_WINDOW_MS);
          ackTimestamps.set(fingerprint, filtered);
          if (filtered.length >= ACK_RATE_LIMIT) return true;
          filtered.push(now);
          return false;
        }

        // Wire router reference into InboundMessageGate
        if (threadline.inboundGate) {
          threadline.inboundGate.setRouter(threadlineRouter);
        }

        threadlineRelayClient.on('gate-passed', async (decision: { message?: { from: string; content: unknown; threadId?: string; messageId?: string }; trustLevel?: string }) => {
          if (!decision.message) return;
          const msg = decision.message;
          const senderFingerprint = msg.from;
          const senderName = senderFingerprint.slice(0, 8);
          const trustLevel = (decision.trustLevel ?? 'untrusted') as import('../threadline/AgentTrustManager.js').AgentTrustLevel;

          // Extract text content
          let textContent: string;
          if (typeof msg.content === 'string') { textContent = msg.content; }
          else if (typeof msg.content === 'object' && msg.content !== null) {
            const c = msg.content as Record<string, unknown>;
            textContent = String(c.content ?? c.text ?? JSON.stringify(msg.content));
          } else { textContent = JSON.stringify(msg.content); }

          // Check if this message resolves a pending waitForReply request.
          // Skip auto-ack messages (they're from us, not a real reply).
          // PR-3: Waiters are now keyed by threadId (unique per conversation)
          // rather than sender fingerprint or agent name. Fall back to the
          // legacy fingerprint/name lookup only if no threadId is present,
          // for compatibility with older senders.
          const isAutoAck = textContent.startsWith('Message received.') || textContent.startsWith('Message received,');
          let waiter = msg.threadId ? threadlineReplyWaiters.get(msg.threadId) : undefined;
          if (!waiter) {
            // Legacy fallback: try by sender fingerprint, then by resolved name
            waiter = threadlineReplyWaiters.get(senderFingerprint);
            if (!waiter) {
              const resolvedName = (() => {
                try {
                  const kaPath = path.join(config.stateDir, 'threadline', 'known-agents.json');
                  const kaData = JSON.parse(fs.readFileSync(kaPath, 'utf-8'));
                  const agents = kaData.agents ?? kaData;
                  if (Array.isArray(agents)) {
                    const match = agents.find((a: { publicKey?: string; name?: string }) =>
                      a.publicKey === senderFingerprint || a.publicKey?.startsWith(senderFingerprint));
                    return match?.name ?? null;
                  }
                  return null;
                } catch { return null; }
              })();
              if (resolvedName) waiter = threadlineReplyWaiters.get(resolvedName);
            }
          }
          if (waiter && !isAutoAck) {
            waiter.resolve(textContent);
            // Don't return — still process the message normally for routing
          }

          // Auto-ack (post-trust-verification, never ack status messages)
          const msgType = typeof msg.content === 'object' && msg.content !== null ? (msg.content as Record<string, unknown>).type : undefined;
          if (trustLevel !== 'untrusted' && msgType !== 'status' && config.threadline?.autoAck !== false && !isAckRateLimited(senderFingerprint)) {
            try {
              threadlineRelayClient!.sendPlaintext(senderFingerprint, config.threadline?.autoAckMessage ?? 'Message received. Composing response...', msg.threadId);
            } catch (ackErr) { console.error(`[relay] Auto-ack failed: ${ackErr instanceof Error ? ackErr.message : ackErr}`); }
          }

          // Phase 2a: Pipe-mode session for simple queries (lightweight, auto-exit)
          // Rapid-fire same-thread guard: if an active pipe session already exists for this
          // thread, fall through to the listener/cold-spawn path so messages queue serially
          // via ListenerSessionManager.writeToInbox instead of killing the prior tmux session.
          if (
            pipeSpawner &&
            msg.threadId &&
            !threadResumeMap.get(msg.threadId) &&
            !pipeSpawner.hasActiveSessionForThread(msg.threadId)
          ) {
            const pipeCheck = pipeSpawner.shouldUsePipeMode({
              threadId: msg.threadId,
              messageText: textContent,
              fromFingerprint: senderFingerprint,
              fromName: senderName,
              trustLevel,
            });
            if (pipeCheck.eligible) {
              try {
                const { classifyIntent, summarizeThreadHistory } = await import('../threadline/PipeSessionSpawner.js');
                const intent = await classifyIntent(textContent);
                if (intent === 'pipe') {
                  const result = await pipeSpawner.spawn({
                    threadId: msg.threadId,
                    messageText: textContent,
                    fromFingerprint: senderFingerprint,
                    fromName: senderName,
                    trustLevel,
                  });
                  if (result.spawned) {
                    console.log(`[relay] Pipe session spawned for ${senderName} (thread: ${msg.threadId.slice(0, 8)})`);
                    return;
                  }
                }
              } catch (err) {
                console.error(`[relay] Pipe session error (falling through to interactive): ${err instanceof Error ? err.message : err}`);
              }
            }
          }

          // Phase 2b: Route to warm listener if available and appropriate
          if (listenerManager && listenerManager.shouldUseListener(trustLevel, textContent.length)) {
            listenerManager.writeToInbox({ from: senderFingerprint, senderName, trustLevel, threadId: msg.threadId ?? getSyntheticThreadId(senderFingerprint), text: textContent });
            console.log(`[relay] Routed to listener inbox from ${senderName} (trust: ${trustLevel})`);
            return;
          }

          // Route through ThreadlineRouter (cold-spawn path)
          const envelope = {
            schemaVersion: 1 as const,
            message: { id: msg.messageId ?? crypto.randomUUID(), from: { agent: senderFingerprint, session: 'relay', machine: 'relay' }, to: { agent: config.projectName, session: 'best', machine: 'local' }, subject: 'Relay message', body: textContent, type: 'query' as const, priority: 'medium' as const, threadId: msg.threadId, createdAt: new Date().toISOString() },
            transport: { protocol: 'relay' as const, origin: { agent: senderFingerprint, machine: 'relay' }, nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`, timestamp: new Date().toISOString() },
            delivery: { status: 'delivered' as const, attempts: 1, lastAttempt: new Date().toISOString() },
          } as unknown as import('../messaging/types.js').MessageEnvelope;

          const relayContext = {
            trust: { kind: 'plaintext-tofu' as const, senderFingerprint },
            senderFingerprint,
            senderName,
            trustLevel,
          };
          let result = await threadlineRouter.handleInboundMessage(envelope, relayContext);

          // Fallback for threadId-less messages
          if (!result.handled && !msg.threadId) {
            (envelope.message as { threadId?: string }).threadId = getSyntheticThreadId(senderFingerprint);
            result = await threadlineRouter.handleInboundMessage(envelope, relayContext);
          }

          if (result.error) console.warn(`[relay] Router error: ${result.error}`);
          if (result.spawned) console.log(`[relay] Spawned session for ${senderName} (trust: ${trustLevel}, thread: ${result.threadId})`);
          if (result.resumed) console.log(`[relay] Resumed session for ${senderName} (thread: ${result.threadId})`);
        });

        // Relay client is passed to AgentServer → RouteContext for the /threadline/relay-send endpoint

        console.log(pc.green(`  Threadline: relay connected to ${config.threadline?.relayUrl ?? 'threadline-relay.fly.dev'}`));
      }
      console.log(pc.green(`  Threadline: enabled (MCP tools registered, discovery heartbeat active)`));
    } catch (err) {
      // Non-fatal — agent works without Threadline
      console.warn(pc.yellow(`  Threadline: failed to bootstrap — ${err instanceof Error ? err.message : String(err)}`));
    }

    // Messaging Tone Gate — always-on tone check on outbound messaging routes.
    // Uses the shared IntelligenceProvider (Claude CLI subscription by default,
    // Anthropic API if key is set). No opt-in. Catches CLI commands, file paths,
    // config syntax, and other technical leakage in agent-to-user messages.
    let messagingToneGate: import('../core/MessagingToneGate.js').MessagingToneGate | undefined;
    if (sharedIntelligence) {
      const { MessagingToneGate } = await import('../core/MessagingToneGate.js');
      messagingToneGate = new MessagingToneGate(sharedIntelligence);
      console.log(pc.green('  Messaging tone gate: active (Haiku via shared IntelligenceProvider)'));
    } else {
      console.log(pc.yellow('  Messaging tone gate: inactive (no IntelligenceProvider available)'));
    }

    // Outbound dedup gate — deterministic near-duplicate detection on every
    // outbound agent message. Catches respawn races and idempotency gaps.
    const { OutboundDedupGate } = await import('../core/OutboundDedupGate.js');
    const outboundDedupGate = new OutboundDedupGate();
    console.log(pc.green('  Outbound dedup gate: active (word-3gram Jaccard, threshold 0.7, 5min window)'));

    // Response Review Pipeline (Coherence Gate) — evaluates agent responses before delivery.
    // Prefers the shared IntelligenceProvider (subscription-compatible) so the gate works
    // even without ANTHROPIC_API_KEY. Falls back to direct Anthropic API if a key is set
    // and no intelligence is available.
    let responseReviewGate: import('../core/CoherenceGate.js').CoherenceGate | undefined;
    if (config.responseReview?.enabled) {
      const anthropicKey = process.env['ANTHROPIC_API_KEY']?.trim() ?? '';
      if (sharedIntelligence || anthropicKey) {
        const { CoherenceGate } = await import('../core/CoherenceGate.js');
        responseReviewGate = new CoherenceGate({
          config: config.responseReview,
          stateDir: config.stateDir,
          apiKey: anthropicKey,
          intelligence: sharedIntelligence,
          relationships: relationships ?? undefined,
          adaptiveTrust: adaptiveTrust ?? undefined,
        });
        const backend = sharedIntelligence
          ? 'via shared IntelligenceProvider'
          : 'via Anthropic API (direct)';
        console.log(pc.green(`  Response review pipeline: enabled ${backend} (${Object.keys(config.responseReview.reviewers ?? {}).length} reviewers configured)`));
      } else {
        console.warn(pc.yellow(`  Response review pipeline: configured but no IntelligenceProvider or ANTHROPIC_API_KEY available`));
      }
    }

    // Feature Registry (Consent & Discovery Framework — Phase 1)
    const { FeatureRegistry } = await import('../core/FeatureRegistry.js');
    const { BUILTIN_FEATURES } = await import('../core/FeatureDefinitions.js');
    const featureRegistry = new FeatureRegistry(config.stateDir, {
      hmacKey: config.authToken || undefined,
    });
    let featureRegistryReady = false;
    try {
      await featureRegistry.open();
      featureRegistryReady = true;
    } catch (frErr: unknown) {
      const msg = frErr instanceof Error ? frErr.message : String(frErr);
      console.warn(pc.yellow(`  FeatureRegistry: failed to open (${msg.slice(0, 120)})`));
      const { DegradationReporter } = await import('../monitoring/DegradationReporter.js');
      DegradationReporter.getInstance().report({
        feature: 'FeatureRegistry',
        primary: 'SQLite-backed feature registry with discovery state tracking',
        fallback: 'Feature definitions available in-memory only (no persistent state)',
        reason: `FeatureRegistry open failed: ${msg.slice(0, 200)}`,
        impact: 'Feature discovery state not persisted. Features default to definitions only.',
      });
    }
    for (const def of BUILTIN_FEATURES) {
      featureRegistry.register(def);
    }
    if (featureRegistryReady) {
      featureRegistry.bootstrap(config as unknown as Record<string, unknown>);
    }
    {
      const summaries = featureRegistry.getSummaries();
      const enabledCount = summaries.filter((f: { enabled: boolean }) => f.enabled).length;
      console.log(pc.green(`  Feature registry: ${summaries.length} features (${enabledCount} enabled, ${summaries.length - enabledCount} undiscovered)`));
    }

    // Wire Baseline telemetry consent check to FeatureRegistry
    if (telemetryHeartbeat) {
      telemetryHeartbeat.setConsentChecker(() => {
        const state = featureRegistry.getState('baseline-telemetry');
        return state?.enabled === true;
      });
      console.log(pc.green('  Baseline telemetry: consent check wired to feature registry'));
    }

    // Discovery Evaluator (Consent & Discovery Framework — Phase 3)
    let discoveryEvaluator: import('../core/DiscoveryEvaluator.js').DiscoveryEvaluator | undefined;
    if (sharedIntelligence) {
      const { DiscoveryEvaluator } = await import('../core/DiscoveryEvaluator.js');
      discoveryEvaluator = new DiscoveryEvaluator(featureRegistry, sharedIntelligence);
      console.log(pc.green('  Discovery evaluator: active (Haiku-class LLM)'));
    } else {
      console.log(pc.yellow('  Discovery evaluator: inactive (no IntelligenceProvider)'));
    }

    // Register feature-discovery probe for self-knowledge tree (Phase 4: Agent Integration)
    if (selfKnowledgeTree && featureRegistry) {
      selfKnowledgeTree.probes.register('feature-discovery', async () => {
        const start = Date.now();
        const summaries = featureRegistry.getSummaries();
        const byState: Record<string, string[]> = {};
        for (const s of summaries) {
          (byState[s.discoveryState] ??= []).push(`${s.name} (${s.consentTier})`);
        }
        const lines: string[] = ['Feature Discovery Status:'];
        for (const [state, features] of Object.entries(byState)) {
          lines.push(`  ${state}: ${features.join(', ')}`);
        }
        lines.push('');
        lines.push('Behavioral contract: max 1 feature per turn, never during frustration,');
        lines.push('network/self-governing tier requires local tier enabled first.');
        lines.push('Use POST /features/:id/surface to record surfacings.');
        lines.push('Use POST /features/evaluate-context for LLM-powered recommendations.');
        return { content: lines.join('\n'), truncated: false, elapsedMs: Date.now() - start };
      }, { description: 'Feature discovery state and behavioral contract summary' });
    }

    // ── Integrated-Being ledger (v1) ──────────────────────────────────
    // Spec: docs/specs/integrated-being-ledger-v1.md
    let sharedStateLedger: import('../core/SharedStateLedger.js').SharedStateLedger | undefined;
    let ledgerSessionRegistry:
      | import('../core/LedgerSessionRegistry.js').LedgerSessionRegistry
      | undefined;
    {
      const ibConfig = config.integratedBeing ?? {};
      const ibEnabled = ibConfig.enabled === undefined ? true : ibConfig.enabled !== false;
      if (ibEnabled) {
        const { SharedStateLedger } = await import('../core/SharedStateLedger.js');
        const { randomBytes } = await import('node:crypto');
        // Generate salt on first use — persisted via LiveConfig.
        let salt = ibConfig.counterpartyHashSalt ?? '';
        if (!salt) {
          salt = randomBytes(32).toString('hex');
          try {
            if (liveConfig) liveConfig.set('integratedBeing.counterpartyHashSalt', salt);
          } catch { /* best effort */ }
        }
        sharedStateLedger = new SharedStateLedger({
          stateDir: config.stateDir,
          config: ibConfig,
          salt,
          degradationReporter,
        });
        // Wire emitters (single call-site; revert = delete this block).
        const { registerLedgerEmitters } = await import('../core/registerLedgerEmitters.js');
        // Note: dispatchExecutor is scoped inside the dispatches.enabled block.
        // AutoDispatcher wraps it; the emitter sink is set via
        // autoDispatcher.executor.setLedgerEventSink(). We access it through
        // autoDispatcher — if dispatches are disabled, no emitter is installed.
        const dispatchExec = autoDispatcher
          ? (autoDispatcher as any).executor as import('../core/DispatchExecutor.js').DispatchExecutor | undefined
          : undefined;
        registerLedgerEmitters(sharedStateLedger, {
          threadlineRouter: threadlineRouter ?? undefined,
          dispatchExecutor: dispatchExec ?? undefined,
          coherenceGate: responseReviewGate ?? undefined,
          config: ibConfig,
          instance: config.projectName ?? 'server',
        });
        console.log(pc.green('  Integrated-Being ledger: enabled'));

        // ── Integrated-Being v2 (session-write surface) ────────────────
        // Spec: docs/specs/integrated-being-ledger-v2.md
        // Gated by config.integratedBeing.v2Enabled (default false).
        // When false the registry is still instantiated so endpoints can
        // consistently 503 with X-Disabled: v2; only the endpoint guards
        // read the flag. Keeping the registry in-scope avoids a second
        // branch in server.ts wiring.
        if (ibConfig.v2Enabled === true) {
          const { LedgerSessionRegistry } = await import(
            '../core/LedgerSessionRegistry.js'
          );
          ledgerSessionRegistry = new LedgerSessionRegistry({
            stateDir: config.stateDir,
            config: ibConfig,
          });
          console.log(
            pc.green('  Integrated-Being v2 (session-write surface): enabled')
          );
          // Start background sweepers (expired + stranded). Bounded
          // per-run; safe to run on every server start.
          const { CommitmentSweeper } = await import(
            '../core/CommitmentSweeper.js'
          );
          const sweeper = new CommitmentSweeper({
            ledger: sharedStateLedger!,
            registry: ledgerSessionRegistry,
            instance: config.projectName ?? 'server',
          });
          sweeper.start();
          console.log(
            pc.green('  Integrated-Being v2 (commitment sweepers): running')
          );
        } else {
          console.log(
            pc.dim('  Integrated-Being v2 (session-write surface): disabled')
          );
        }
      }
    }

    // Parallel-dev isolation (PARALLEL-DEV-ISOLATION-SPEC.md) — off by default.
    // When enabled, each topic session spawns in its own git worktree, with
    // fencing tokens, Ed25519-signed commit trailers, and (at phase='enforce')
    // an authoritative push gate at GitHub Actions.
    let worktreeManager: import('../core/WorktreeManager.js').WorktreeManager | undefined;
    const parallelDevConfig = config.parallelDev;
    if (parallelDevConfig && parallelDevConfig.phase !== 'off') {
      const { wireParallelDev } = await import('../core/ParallelDevWiring.js');
      const wired = await wireParallelDev({
        config: parallelDevConfig,
        projectDir: config.projectDir,
        stateDir: config.stateDir,
      });
      if (wired) {
        worktreeManager = wired.worktreeManager;
        sessionManager.setWorktreeManager(worktreeManager, wired.shimRoot);
        console.log(
          pc.green(`  Parallel-dev isolation: ${parallelDevConfig.phase} (WorktreeManager wired)`)
        );
      }
    }

    const { InitiativeTracker } = await import('../core/InitiativeTracker.js');
    const initiativeTracker = new InitiativeTracker(config.stateDir);

    const server = new AgentServer({ config, sessionManager, state, scheduler, telegram, relationships, feedback, feedbackAnomalyDetector, dispatches, updateChecker, autoUpdater, autoDispatcher, quotaTracker, quotaManager, publisher, viewer, tunnel, evolution, watchdog, topicMemory, triageNurse, projectMapper, coherenceGate: scopeVerifier, contextHierarchy, canonicalState, operationGate, sentinel, adaptiveTrust, memoryMonitor, orphanReaper, coherenceMonitor, commitmentTracker, semanticMemory, activitySentinel, messageRouter, summarySentinel, spawnManager, systemReviewer, capabilityMapper, selfKnowledgeTree, coverageAuditor, topicResumeMap: _topicResumeMap ?? undefined, autonomyManager, trustElevationTracker, autonomousEvolution, coordinator: coordinator.enabled ? coordinator : undefined, localSigningKeyPem, whatsapp: whatsappAdapter, slack: slackAdapter, imessage: imessageAdapter, whatsappBusinessBackend, messageBridge, hookEventReceiver, worktreeMonitor, subagentTracker, instructionsVerifier, handshakeManager: threadlineHandshake, threadlineRouter, threadlineRelayClient, threadlineReplyWaiters, listenerManager: listenerManager ?? undefined, responseReviewGate, messagingToneGate, outboundDedupGate, telemetryHeartbeat, pasteManager, featureRegistry, discoveryEvaluator, unifiedTrust, liveConfig, sharedStateLedger, ledgerSessionRegistry, worktreeManager, oidcEnrolledRepos: parallelDevConfig?.oidcEnrolledRepos, initiativeTracker, proxyCoordinator });
    await server.start();

    // Connect DegradationReporter downstream systems now that everything is initialized.
    // Any degradation events queued during startup will drain to feedback + telegram.
    {
      const alertTopicId = state.get<number>('agent-attention-topic') ?? null;
      degradationReporter.connectDownstream({
        feedbackSubmitter: feedback ? (item) => feedback!.submit(item) : undefined,
        // Route degradation alerts through the batcher — these are important but not urgent
        telegramSender: (_topicId, text) => {
          notify('SUMMARY', 'system', text);
          return Promise.resolve();
        },
        alertTopicId,
      });
    }

    // Periodic housekeeping — calls orphaned cleanup methods every 6 hours.
    // These methods exist on their respective classes but were never scheduled.
    const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;
    setInterval(() => {
      try { triageOrchestrator?.cleanup(); } catch { /* best-effort */ }
      try { sessionRecovery?.cleanup(); } catch { /* best-effort */ }
      try { messageStore?.cleanup(); } catch { /* best-effort */ }
      console.log('[Housekeeping] Periodic cleanup completed');
    }, HOUSEKEEPING_INTERVAL_MS);

    // Start tunnel AFTER server is listening (with retry on failure)
    if (tunnel) {
      tunnel.enableAutoReconnect();
      const maxRetries = 5;
      let tunnelStarted = false;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const tunnelUrl = await tunnel.start();
          console.log(pc.green(`  Tunnel active: ${pc.bold(tunnelUrl)}`));
          tunnelStarted = true;
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < maxRetries) {
            const delay = Math.min(15_000 * Math.pow(2, attempt - 1), 120_000); // 15s, 30s, 60s, 120s
            console.log(pc.yellow(`  Tunnel failed (attempt ${attempt}/${maxRetries}): ${msg}`));
            console.log(pc.yellow(`  Retrying in ${delay / 1000}s...`));
            await new Promise(r => setTimeout(r, delay));
          } else {
            console.error(pc.red(`  Tunnel failed after ${maxRetries} attempts: ${msg}`));
          }
        }
      }
      // If tunnel didn't start, schedule background retries
      if (!tunnelStarted) {
        const retryIntervals = [5, 10, 20]; // minutes
        console.log(pc.yellow(`  Will retry tunnel in ${retryIntervals[0]} minutes...`));
        const scheduleRetry = (index: number) => {
          if (index >= retryIntervals.length) return;
          setTimeout(async () => {
            try {
              const tunnelUrl = await tunnel!.start();
              console.log(pc.green(`[tunnel] Connected: ${tunnelUrl}`));
              if (tunnelUrl) {
                const tunnelType = (config.tunnel?.type || 'quick') as 'quick' | 'named';
                if (telegram) {
                  await telegram.broadcastDashboardUrl(tunnelUrl, tunnelType).catch(() => {});
                }
                if (_slackAdapter) {
                  await _slackAdapter.broadcastDashboardUrl(tunnelUrl).catch(() => {});
                }
              }
            } catch (retryErr) {
              const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              console.error(`[tunnel] Retry failed: ${msg}`);
              if (index + 1 < retryIntervals.length) {
                console.log(`[tunnel] Will retry in ${retryIntervals[index + 1]} minutes...`);
                scheduleRetry(index + 1);
              } else {
                console.error('[tunnel] All retries exhausted. Tunnel unavailable until server restart.');
                if (telegram) {
                  try {
                    const lifelineId = telegram.getLifelineTopicId?.();
                    if (lifelineId) {
                      await telegram.sendToTopic(
                        lifelineId,
                        '⚠️ Tunnel failed after all retries. Dashboard link is unavailable until the server is restarted.',
                      ).catch(() => {});
                    }
                  } catch { /* best-effort notification */ }
                }
              }
            }
          }, retryIntervals[index] * 60_000);
        };
        scheduleRetry(0);
      }
    }

    // ── Dashboard Topic: always-available link ──────────────────────────
    // Retroactive: creates the topic on first run for existing agents.
    // Posts tunnel URL + PIN and pins the message for instant access.
    if (telegram) {
      try {
        const dashTopicId = await telegram.ensureDashboardTopic();
        if (dashTopicId) {
          console.log(pc.green(`  Dashboard topic: ${dashTopicId}`));

          // Auto-generate dashboardPin if missing — do this on every startup,
          // not just during upgrades. The PIN should always exist.
          if (!config.dashboardPin) {
            const pin = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
            config.dashboardPin = pin;
            // Persist via LiveConfig so it survives restart
            liveConfig.set('dashboardPin', pin);
            console.log(pc.green(`  Auto-generated dashboard PIN: ${pin}`));
          }

          // Only broadcast if we have a tunnel URL — posting localhost to Telegram
          // is useless noise. The user can't access localhost remotely.
          const dashUrl = tunnel?.url;
          const tunnelType = config.tunnel?.type || 'quick';

          if (dashUrl) {
            // Pass dashboard PIN to TelegramAdapter so the broadcast includes it
            const telegramConfig = config.messaging?.find(
              (m: { type: string }) => m.type === 'telegram'
            );
            if (telegramConfig?.config) {
              (telegramConfig.config as Record<string, unknown>).dashboardPin = config.dashboardPin || '';
              // Update the adapter's config reference
              (telegram as unknown as { config: { dashboardPin?: string } }).config.dashboardPin = config.dashboardPin || '';
            }

            await telegram.broadcastDashboardUrl(dashUrl, tunnelType as 'quick' | 'named');

            // Also broadcast to Slack dashboard channel if configured
            if (_slackAdapter) {
              await _slackAdapter.broadcastDashboardUrl(dashUrl).catch((err: Error) => {
                console.warn(`[server] Slack dashboard broadcast failed: ${err.message}`);
              });
            }
          } else {
            console.log(pc.yellow(`  Dashboard available locally at http://localhost:${config.port}/dashboard (no tunnel configured — not broadcasting to Telegram)`));
          }
        }
      } catch (err) {
        // @silent-fallback-ok — dashboard topic is nice-to-have
        console.warn(`[server] Dashboard topic setup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Self-healing: ensure autostart is installed AND uses the correct format.
    // This is a non-negotiable requirement — the user must always be able to reach their agent remotely.
    // If autostart isn't installed, install it silently. If it uses the old /bin/bash entry point
    // (vulnerable to macOS TCC/FDA restrictions), regenerate it with the node + JS wrapper.
    try {
      const hasTelegram = !!telegram;
      const autostartInstalled = isAutostartInstalled(config.projectName);
      let needsReinstall = !autostartInstalled;

      // On macOS, keep node symlink fresh and check plist format
      if (process.platform === 'darwin') {
        // Always update the node symlink — primary defense against NVM/asdf switches
        try {
          const { ensureStableNodeSymlink } = await import('./setup.js');
          ensureStableNodeSymlink(config.projectDir);
        } catch { /* non-critical */ }

        if (!needsReinstall) {
          const label = `ai.instar.${config.projectName}`;
          const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
          try {
            const plistContent = fs.readFileSync(plistPath, 'utf-8');
            if (!plistContent.includes('instar-boot.js')) {
              needsReinstall = true;
              console.log(pc.yellow(`  Auto-start uses legacy format — upgrading to TCC-safe node entry point`));
            } else if (!plistContent.includes('.instar/bin/node')) {
              needsReinstall = true;
              console.log(pc.yellow(`  Auto-start uses direct node path — upgrading to stable symlink`));
            } else {
              // Verify node path in plist still exists (should be the symlink)
              const nodeMatch = plistContent.match(/<string>(\/[^<]+node[^<]*)<\/string>/);
              if (nodeMatch && !fs.existsSync(nodeMatch[1])) {
                needsReinstall = true;
                console.log(pc.yellow(`  Auto-start node path stale (${nodeMatch[1]}) — regenerating`));
              }
            }
          } catch { /* plist read failed — will reinstall */ needsReinstall = true; }
        }
      }

      if (needsReinstall) {
        const { installAutoStart } = await import('./setup.js');
        const installed = installAutoStart(config.projectName, config.projectDir, hasTelegram);
        if (installed) {
          console.log(pc.green(`  Auto-start self-healed: installed ${process.platform === 'darwin' ? 'LaunchAgent (node + JS wrapper)' : 'systemd service'}`));
        } else {
          console.log(pc.yellow(`  Auto-start not available on ${process.platform}`));
        }
      }
    } catch (err) {
      // @silent-fallback-ok — auto-start non-critical
      console.error(`  Auto-start check failed: ${err instanceof Error ? err.message : err}`);
    }

    // Upgrade guide delivery — silent approach.
    // The pending guide file is preserved at .instar/state/pending-upgrade-guide.md
    // and gets injected into the agent's context at the NEXT natural session start
    // (via ContextHierarchy). No dedicated notification session is spawned.
    //
    // Previous approach spawned a Claude session (haiku → sonnet escalation) that
    // messaged the user via Telegram — too noisy. Updates should be invisible
    // unless the user's active work is interrupted.
    try {
      const pendingGuidePath = path.join(config.stateDir, 'state', 'pending-upgrade-guide.md');
      if (fs.existsSync(pendingGuidePath)) {
        const guideContent = fs.readFileSync(pendingGuidePath, 'utf-8');
        if (guideContent.trim()) {
          console.log(pc.green('  Pending upgrade guide detected — will be injected at next session start'));
        }
      }
    } catch {
      // @silent-fallback-ok — upgrade guide check non-critical
    }

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');

      // Save resume UUIDs for ALL active topic-linked sessions before exit.
      // Without this, server restarts lose all resume mappings because:
      // 1. Resume entries are consumed (removed) on spawn
      // 2. Proactive save may not have run yet
      // 3. beforeSessionKill doesn't fire for bulk process exit
      if (_topicResumeMap) {
        try {
          const runningSessions = sessionManager.listRunningSessions();
          let saved = 0;

          // Save Telegram topic resume UUIDs
          if (telegram) {
            const topicSessions = telegram.getAllTopicSessions?.();
            if (topicSessions) {
              for (const [topicId, sessionName] of topicSessions) {
                const session = runningSessions.find(s => s.tmuxSession === sessionName);
                const uuid = _topicResumeMap.findUuidForSession(sessionName, session?.claudeSessionId ?? undefined);
                if (uuid) {
                  _topicResumeMap.save(topicId, uuid, sessionName);
                  saved++;
                }
              }
            }
          }

          // Save Slack channel resume UUIDs
          if (_slackAdapter) {
            const registry = _slackAdapter.getChannelRegistry();
            for (const [channelId, entry] of Object.entries(registry)) {
              const session = runningSessions.find(s => s.tmuxSession === entry.sessionName);
              const uuid = _topicResumeMap.findUuidForSession(entry.sessionName, session?.claudeSessionId ?? undefined);
              if (uuid) {
                _slackAdapter.saveChannelResume(channelId, uuid, entry.sessionName);
                saved++;
              }
            }
          }

          if (saved > 0) {
            console.log(`[shutdown] Saved ${saved} resume UUID(s) for active sessions`);
          }
        } catch (err) {
          console.error('[shutdown] Failed to save resume UUIDs:', err);
        }
      }

      gitSync?.stop();
      coordinator.stop();
      coherenceMonitor.stop();
      commitmentTracker.stop();
      commitmentSentinel?.stop();
      await notificationBatcher.flushAll(); // Drain pending notifications before exit
      notificationBatcher.stop();
      retryManager.stop();
      spawnManager.dispose(); // §4.4: stop drain loop + clear DRR state
      summarySentinel.stop();
      memoryMonitor.stop();
      caffeinateManager.stop();
      sleepWakeDetector.stop();
      autoUpdater.stop();
      autoDispatcher?.stop();
      sessionMonitor?.stop();
      if (tunnel) await tunnel.stop();
      if (threadlineShutdown) await threadlineShutdown();
      wakeSocketServer?.stop();
      pipeSpawner?.killAll();
      try { stopHeartbeat?.(); } catch { /* non-critical during shutdown */ }
      try { unregisterAgent(config.projectDir); } catch { /* ELOCKED is non-critical during shutdown */ }
      scheduler?.stop();
      if (telegram) await telegram.stop();
      sessionManager.stopMonitoring();
      // Close SQLite databases before exit — prevents "mutex lock failed" crash
      // when better-sqlite3 destructors fire during process teardown.
      topicMemory?.close();
      semanticMemory?.close();
      // Integrated-Being v1 — flush stats sidecar (coalesces pending writes).
      try { sharedStateLedger?.shutdown(); } catch { /* best effort */ }
      await server.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Last-resort SQLite cleanup — if the process crashes from an uncaught exception
    // (e.g., cloudflared crash cascade during sleep/wake), close databases to prevent
    // the "mutex lock failed" error on next start. This doesn't prevent the crash,
    // but ensures the next boot is clean.
    process.on('uncaughtException', (err) => {
      // Non-fatal HTTP errors — log and continue, don't crash the server.
      // "Cannot set headers" is a double-response race condition (common during
      // tunnel reconnect storms). The affected request is already handled; the
      // server can keep serving new requests.
      const nonFatalPatterns = [
        'Cannot set headers after they are sent',
        'write after end',
        'ERR_HTTP_HEADERS_SENT',
        'ERR_STREAM_WRITE_AFTER_END',
      ];
      if (nonFatalPatterns.some(p => err.message?.includes(p))) {
        console.warn(`[WARN] Non-fatal uncaught exception (suppressed): ${err.message}`);
        return; // Don't crash — the server is fine
      }

      console.error('[FATAL] Uncaught exception — closing databases before crash:', err.message);
      try { topicMemory?.close(); } catch { /* best effort */ }
      try { semanticMemory?.close(); } catch { /* best effort */ }
      process.exit(1);
    });

    // Wire the ForegroundRestartWatcher to the graceful shutdown function.
    // This ensures auto-update restarts close all resources (especially SQLite
    // databases) before exiting, preventing the "mutex lock failed" crash.
    restartWatcher.on('restartDetected', shutdown);
  } else {
    // Run in tmux background session
    const tmuxPath = detectTmuxPath();
    if (!tmuxPath) {
      console.log(pc.red('tmux not found. Use --foreground to run without tmux.'));
      process.exit(1);
    }

    // Check if already running
    try {
      execFileSync(tmuxPath, ['has-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
      console.log(pc.yellow(`Server already running in tmux session: ${serverSessionName}`));
      console.log(`  Attach with: tmux attach -t '=${serverSessionName}'`);
      return;
    } catch {
      // Not running — good
    }

    // Get the path to the CLI entry point
    const cliPath = new URL('../cli.js', import.meta.url).pathname;

    // Use shell-safe command construction: pass node + args as separate tokens
    // tmux new-session runs the remainder as a shell command, so we quote each arg
    const nodeCmd = ['node', cliPath, 'server', 'start', '--foreground']
      .map(arg => `'${arg.replace(/'/g, "'\\''")}'`)
      .join(' ');

    try {
      execFileSync(tmuxPath, ['new-session', '-d', '-s', serverSessionName, '-c', config.projectDir, nodeCmd], { stdio: 'ignore' });
      console.log(pc.green(`Server started in tmux session: ${pc.bold(serverSessionName)}`));
      console.log(`  Port: ${config.port}`);
      console.log(`  Attach: tmux attach -t '=${serverSessionName}'`);
      console.log(`  Health: curl http://localhost:${config.port}/health`);
    } catch (err) {
      console.log(pc.red(`Failed to start server: ${err}`));
      process.exit(1);
    }
  }
}

export async function stopServer(options: { dir?: string }): Promise<void> {
  const config = loadConfig(options.dir);
  const serverSessionName = `${config.projectName}-server`;
  const tmuxPath = detectTmuxPath();

  if (!tmuxPath) {
    console.log(pc.red('tmux not found'));
    process.exit(1);
  }

  // Check if the session exists
  try {
    execFileSync(tmuxPath, ['has-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
  } catch {
    console.log(pc.yellow(`No server running (no tmux session: ${serverSessionName})`));
    return;
  }

  // Send SIGTERM first for graceful shutdown, then force kill after timeout
  try {
    // Send C-c (SIGINT) to the foreground process in the session
    execFileSync(tmuxPath, ['send-keys', '-t', `=${serverSessionName}:`, 'C-c'], { stdio: 'ignore' });
    console.log(`  Sent shutdown signal to ${serverSessionName}...`);

    // Wait up to 5 seconds for graceful shutdown
    let stopped = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        execFileSync(tmuxPath, ['has-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
        // Still running
      } catch {
        // @silent-fallback-ok — session check
        stopped = true;
        break;
      }
    }

    if (!stopped) {
      // Force kill after graceful timeout
      execFileSync(tmuxPath, ['kill-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
      console.log(pc.yellow(`  Forced kill after graceful shutdown timeout`));
    }

    console.log(pc.green(`Server stopped (session: ${serverSessionName})`));
  } catch {
    // @silent-fallback-ok — graceful shutdown fallback to force
    try {
      execFileSync(tmuxPath, ['kill-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
      console.log(pc.green(`Server stopped (forced kill: ${serverSessionName})`));
    } catch {
      console.log(pc.yellow(`No server running (no tmux session: ${serverSessionName})`));
    }
  }
}

/**
 * Restart the agent server — handles launchd/systemd lifecycle correctly.
 *
 * When autostart (launchd/systemd) is active, simply stopping the server causes
 * the service manager to respawn it with the OLD binary within seconds. This
 * makes it impossible to apply patches. The restart command handles this by:
 *   1. Temporarily disabling the autostart service
 *   2. Stopping the running server
 *   3. Re-enabling autostart (which starts the server with the new binary)
 *
 * Without autostart, falls back to stop + start.
 */
export async function restartServer(options: { dir?: string }): Promise<void> {
  const config = loadConfig(options.dir);

  if (process.platform === 'darwin') {
    const label = `ai.instar.${config.projectName}`;
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

    if (fs.existsSync(plistPath)) {
      const uid = process.getuid?.() ?? 501;
      console.log(`  Restarting via launchd (${label})...`);

      // Bootout the service (stops process + unloads)
      try {
        execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
      } catch { /* @silent-fallback-ok — may not be loaded */ }

      // Wait for process to die
      await new Promise(r => setTimeout(r, 1000));

      // Bootstrap it back (loads + starts)
      try {
        execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'pipe' });
        console.log(pc.green(`  Server restarted via launchd (${label})`));
      } catch (err) {
        // If bootstrap fails (already loaded), try kickstart
        try {
          execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { stdio: 'pipe' });
          console.log(pc.green(`  Server restarted via launchd kickstart (${label})`));
        } catch { /* @silent-fallback-ok — logs manual instructions below */
          console.log(pc.red(`  Failed to restart via launchd: ${err instanceof Error ? err.message : err}`));
          console.log(pc.yellow(`  Try manually: launchctl bootout gui/${uid}/${label} && launchctl bootstrap gui/${uid} ${plistPath}`));
        }
      }
      return;
    }
  } else if (process.platform === 'linux') {
    const serviceName = `instar-${config.projectName}.service`;
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', serviceName);
    if (fs.existsSync(servicePath)) {
      console.log(`  Restarting via systemd (${serviceName})...`);
      try {
        execFileSync('systemctl', ['--user', 'restart', serviceName], { stdio: 'pipe' });
        console.log(pc.green(`  Server restarted via systemd (${serviceName})`));
      } catch (err) {
        console.log(pc.red(`  Failed to restart via systemd: ${err instanceof Error ? err.message : err}`));
      }
      return;
    }
  }

  // No autostart — manual stop + start
  console.log('  Restarting server (stop + start)...');
  await stopServer(options);
  await new Promise(r => setTimeout(r, 500));
  await startServer({ dir: options.dir });
}
