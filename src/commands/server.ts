/**
 * `instar server start|stop` — Manage the persistent agent server.
 *
 * Start launches the server in a tmux session (background) or foreground.
 * Stop kills the server tmux session.
 *
 * When Telegram is configured, wires up message routing:
 *   topic message → find/spawn session → inject message → session replies via [telegram:N]
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig, ensureStateDir, detectTmuxPath } from '../core/Config.js';
import { SessionManager } from '../core/SessionManager.js';
import { StateManager } from '../core/StateManager.js';
import { JobScheduler } from '../scheduler/JobScheduler.js';
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
import { QuotaTracker } from '../monitoring/QuotaTracker.js';
import { AccountSwitcher } from '../monitoring/AccountSwitcher.js';
import { QuotaNotifier } from '../monitoring/QuotaNotifier.js';
import { classifySessionDeath } from '../monitoring/QuotaExhaustionDetector.js';
import { SessionWatchdog } from '../monitoring/SessionWatchdog.js';
import { StallTriageNurse } from '../monitoring/StallTriageNurse.js';
import { SessionMonitor } from '../monitoring/SessionMonitor.js';
import { MultiMachineCoordinator } from '../core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../core/MachineIdentity.js';
import { GitSyncManager } from '../core/GitSync.js';
import { ProjectMapper } from '../core/ProjectMapper.js';
import { CoherenceGate } from '../core/CoherenceGate.js';
import { ContextHierarchy } from '../core/ContextHierarchy.js';
import { CanonicalState } from '../core/CanonicalState.js';
import { ExternalOperationGate, AUTONOMY_PROFILES } from '../core/ExternalOperationGate.js';
import { MessageSentinel } from '../core/MessageSentinel.js';
import { AdaptiveTrust } from '../core/AdaptiveTrust.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { LiveConfig } from '../config/LiveConfig.js';
import { CoherenceMonitor } from '../monitoring/CoherenceMonitor.js';
import { ProcessIntegrity } from '../core/ProcessIntegrity.js';
import { StaleProcessGuard } from '../core/StaleProcessGuard.js';
import { ForegroundRestartWatcher } from '../core/ForegroundRestartWatcher.js';
import { NotificationBatcher } from '../messaging/NotificationBatcher.js';
import type { NotificationTier } from '../messaging/NotificationBatcher.js';
import type { PipelineMessage } from '../types/pipeline.js';
import { toPipeline, toInjection, toLogEntry, formatHistoryLine } from '../types/pipeline.js';
import type { Message, IntelligenceProvider } from '../core/types.js';
// setup.ts uses @inquirer/prompts which requires Node 20.12+
// Dynamic import to avoid breaking the server on older Node versions
// import { installAutoStart } from './setup.js';

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

async function spawnSessionForTopic(
  sessionManager: SessionManager,
  telegram: TelegramAdapter,
  sessionName: string,
  topicId: number,
  latestMessage?: string,
  topicMemory?: TopicMemory,
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
      contextContent = topicMemory.formatContextForSession(topicId, 30);
    } catch (err) {
      // @silent-fallback-ok — TopicMemory format, JSONL fallback
      console.error(`[telegram→session] TopicMemory context failed, falling back to JSONL:`, err);
    }
  }

  // Fallback to JSONL-based history — this means TopicMemory is broken
  if (!contextContent) {
    usedFallback = true;
    try {
      const history = telegram.getTopicHistory(topicId, 20);
      if (history.length > 0) {
        const lines: string[] = [];
        lines.push(`--- Thread History (last ${history.length} messages) ---`);
        lines.push(`IMPORTANT: Read this history carefully before taking any action.`);
        lines.push(`Your task is to continue THIS conversation, not start something new.`);
        lines.push(``);
        for (const m of history) {
          // Use actual sender name if available (multi-user topics), fall back to generic
          const sender = m.fromUser
            ? (m.senderName || 'User')
            : 'Agent';
          const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
          const text = (m.text || '').slice(0, 300);
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

    // Truncate inline context to keep injection manageable.
    // Summary + last ~10 messages is usually under 4KB — enough for continuity.
    // Full history remains in the file for deeper searches.
    const MAX_INLINE_CHARS = 4000;
    const inlineContext = contextContent.length > MAX_INLINE_CHARS
      ? contextContent.slice(0, MAX_INLINE_CHARS) + `\n... (full history: ${filepath})`
      : contextContent;

    bootstrapMessage = [
      `CONTINUATION — You are resuming an EXISTING conversation. Read the context below before responding.`,
      ``,
      inlineContext,
      ``,
      `IMPORTANT: Your response MUST acknowledge and continue the conversation above. Do NOT introduce yourself or ask "how can I help" — the user has been talking to you. Pick up where the conversation left off.`,
      ``,
      `The user's latest message:`,
      `[telegram:${topicId}] ${msg}`,
    ].join('\n');
  } else {
    bootstrapMessage = `[telegram:${topicId}] ${msg}`;
  }

  const newSessionName = await sessionManager.spawnInteractiveSession(bootstrapMessage, sessionName, { telegramTopicId: topicId });
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
): Promise<void> {
  console.log(`[telegram→session] Session "${targetSession}" needs respawn for topic ${topicId}`);

  const storedName = telegram.getTopicName(topicId);
  // Use topic name, not tmux session name — tmux names include the project prefix
  // which causes cascading names like ai-guy-ai-guy-ai-guy-topic-1 on each respawn.
  const topicName = storedName || `topic-${topicId}`;

  const newSessionName = await spawnSessionForTopic(sessionManager, telegram, topicName, topicId, latestMessage, topicMemory);

  telegram.registerTopicSession(topicId, newSessionName);
  await telegram.sendToTopic(topicId, `Session respawned.`);
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
        await telegram.sendToTopic(replyTopicId, `Account switch failed: ${err instanceof Error ? err.message : String(err)}`);
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
        await telegram.sendToTopic(replyTopicId, `Failed to get quota: ${err instanceof Error ? err.message : String(err)}`);
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
      await telegram.sendToTopic(replyTopicId, 'tmux not found — cannot run login flow.');
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
        await telegram.sendToTopic(replyTopicId, 'Login flow ended. Check `claude auth status` to verify.');
      }
    } catch (err) {
      // Clean up on error
      try {
        execFileSync(tmuxPath, ['kill-session', '-t', `=${loginSession}`], { stdio: 'ignore' });
      } catch { /* ignore */ }
      await telegram.sendToTopic(replyTopicId, `Login failed: ${err instanceof Error ? err.message : String(err)}`);
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
      : 'text',
    timestamp: msg.receivedAt,
  };
}

function wireTelegramRouting(
  telegram: TelegramAdapter,
  sessionManager: SessionManager,
  quotaTracker?: QuotaTracker,
  topicMemory?: TopicMemory,
): void {
  telegram.onTopicMessage = (msg: Message) => {
    const topicId = (msg.metadata?.messageThreadId as number) ?? null;
    if (!topicId) return;

    const text = msg.content;

    // Most commands are handled inside TelegramAdapter.handleCommand().
    // /new is handled here because it needs sessionManager access.
    const newMatch = text.match(/^\/new(?:\s+(.+))?$/);
    if (newMatch) {
      const sessionName = newMatch[1]?.trim() || null;
      const topicName = sessionName || `session-${new Date().toISOString().slice(5, 16).replace('T', '-').replace(':', '')}`;
      const topicEmoji = sessionName ? selectTopicEmoji(sessionName) : TOPIC_STYLE.SESSION.emoji;
      const topicDisplayName = `${topicEmoji} ${topicName}`;

      (async () => {
        try {
          const topic = await telegram.findOrCreateForumTopic(topicDisplayName, TOPIC_STYLE.SESSION.color);
          const newSession = await sessionManager.spawnInteractiveSession(
            `[telegram:${topic.topicId}] New session started. (IMPORTANT: Relay all responses back via: cat <<'EOF' | .claude/scripts/telegram-reply.sh ${topic.topicId}\nYour response\nEOF)`,
            topicName,
          );
          telegram.registerTopicSession(topic.topicId, newSession);
          await telegram.sendToTopic(topic.topicId, `Session created. I'm here.`);
          await telegram.sendToTopic(topicId, `New session created: "${topicName}" — check the new topic above.`);
          console.log(`[telegram] Spawned session "${newSession}" for new topic ${topic.topicId}`);
        } catch (err) {
          console.error(`[telegram] /new failed:`, err);
          await telegram.sendToTopic(topicId, `Failed to spawn session: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
        }
      })();
      return;
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
          targetSession, topicId, text, pipeline.topicName, pipeline.sender.firstName,
        );
        // Delivery confirmation — let the user know the message reached the session
        telegram.sendToTopic(topicId, `✓ Delivered`).catch(() => {});
        // Track for stall detection
        telegram.trackMessageInjection(topicId, targetSession, text);
      } else {
        // Session died — check if it's a quota death before respawning
        let isQuotaDeath = false;
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
            }
          }
        } catch { /* classification failed — fall through to respawn */ }

        if (!isQuotaDeath) {
          telegram.sendToTopic(topicId, `🔄 Session restarting — message queued.`).catch(() => {});
          respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, text, topicMemory).catch(err => {
            console.error(`[telegram→session] Respawn failed:`, err);
          });
        }
      }
    } else {
      // No session mapped — auto-spawn with topic history (same as respawn path).
      // Without history, the agent has no conversational context and gives blind answers.
      console.log(`[telegram→session] No session for topic ${topicId}, auto-spawning with history...`);
      const spawnName = storedTopicName || `topic-${topicId}`;

      // Use the shared spawn helper that includes topic history
      spawnSessionForTopic(sessionManager, telegram, spawnName, topicId, text, topicMemory).then((newSessionName) => {
        telegram.registerTopicSession(topicId, newSessionName);
        telegram.sendToTopic(topicId, `Session starting up — reading your message now. One moment.`).catch(() => {});
        console.log(`[telegram→session] Auto-spawned "${newSessionName}" for topic ${topicId}`);
      }).catch((err) => {
        console.error(`[telegram→session] Auto-spawn failed:`, err);
        telegram.sendToTopic(topicId, `Failed to create session: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      });
    }
  };
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
  } catch { /* fallback */ }
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
   * Central notification gateway — ALL non-interactive Telegram notifications should go through here.
   * Interactive messages (session replies, user-facing responses) still use sendToTopic directly.
   */
  function notify(tier: NotificationTier, category: string, message: string, topicId?: number): void {
    const resolvedTopicId = topicId ?? _notifyState?.get<number>('agent-attention-topic') ?? 0;
    if (!resolvedTopicId) return;
    notificationBatcher.enqueue({
      tier,
      category,
      message,
      timestamp: new Date(),
      topicId: resolvedTopicId,
    }).catch(() => { /* @silent-fallback-ok */ });
  }

  // Migration: fix autoApply default bug from init.ts (pre-0.9.47).
  // init.ts wrote `updates.autoApply: false` despite the intended default being true.
  // One-time fix: rewrite the config file if autoApply is explicitly false.
  if (config.updates?.autoApply === false) {
    try {
      const configPath = path.join(config.projectDir, '.instar', 'config.json');
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (raw.updates?.autoApply === false) {
          raw.updates.autoApply = true;
          fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
          config.updates = { ...config.updates, autoApply: true };
          console.log(`[migration] Fixed updates.autoApply: false → true (bug in init.ts pre-0.9.47)`);
        }
      }
    } catch (err) {
      console.error(`[migration] Failed to fix autoApply config:`, err);
    }
  }

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

    // Run post-update migration on startup — ensures agent knowledge stays current
    // even if the update was installed externally (e.g., via `npm install -g instar@latest`).
    // This is the SAFETY NET: catches all upgrades regardless of how they were applied.
    try {
      const installedVersion = getInstalledVersion();
      const versionFile = path.join(config.stateDir, 'state', 'last-migrated-version.json');
      let lastMigrated = '';
      try { lastMigrated = JSON.parse(fs.readFileSync(versionFile, 'utf-8')).version || ''; } catch { /* first run */ }
      if (installedVersion && installedVersion !== lastMigrated) {
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
    const stopHeartbeat = startHeartbeat(config.projectDir);

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
        const syncResult = gitSync.sync();
        if (syncResult.pulled) {
          console.log(pc.green(`  Git sync: pulled ${syncResult.commitsPulled} commit(s)`));
        }
      } catch (err) {
        // @silent-fallback-ok — git sync disabled gracefully
        console.log(pc.yellow(`  Git sync setup: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    const sessionManager = new SessionManager(config.sessions, state);

    // Shared intelligence provider — lightweight LLM for internal classification tasks.
    // Prefer Anthropic API (faster, no tmux) → Claude CLI fallback.
    // Components that need LLM intelligence (Sentinel, TelegramAdapter, etc.) share this.
    let sharedIntelligence: IntelligenceProvider | undefined;
    try {
      const apiProvider = AnthropicIntelligenceProvider.fromEnv();
      if (apiProvider) {
        sharedIntelligence = apiProvider;
      }
    } catch { /* no API key available */ }
    if (!sharedIntelligence) {
      try {
        sharedIntelligence = new ClaudeCliIntelligenceProvider(config.sessions.claudePath);
      } catch { /* CLI not available */ }
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
    if (config.monitoring?.quotaTracking) {
      const quotaFile = (config.monitoring as any).quotaStateFile
        || path.join(config.stateDir, 'quota-state.json');
      quotaTracker = new QuotaTracker({
        quotaFile,
        thresholds: config.scheduler?.quotaThresholds ?? { normal: 50, elevated: 60, critical: 80, shutdown: 95 },
      });
      console.log(pc.green(`  Quota tracking enabled (${quotaFile})`));
    }

    let scheduler: JobScheduler | undefined;
    if (config.scheduler.enabled && coordinator.isAwake) {
      scheduler = new JobScheduler(config.scheduler, sessionManager, state, config.stateDir);
      if (quotaTracker) {
        scheduler.canRunJob = quotaTracker.canRunJob.bind(quotaTracker);
        scheduler.setQuotaTracker(quotaTracker);
      }
      scheduler.start();
      console.log(pc.green('  Scheduler started'));
    } else if (config.scheduler.enabled && !coordinator.isAwake) {
      console.log(pc.yellow('  Scheduler skipped (standby mode)'));
    }

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
      telegram = new TelegramAdapter(telegramConfig.config as any, config.stateDir);
      console.log(pc.green(`  Telegram send-only mode (${isStandbyTelegram ? 'standby' : 'lifeline owns polling'})`));

      // Ensure topics exist even in send-only mode (createForumTopic is a simple API call)
      ensureAgentAttentionTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Attention topic: ${err}`);
      });
      ensureAgentUpdatesTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Updates topic: ${err}`);
      });
    }

    if (telegramConfig && !skipTelegram && !isStandbyTelegram) {
      telegram = new TelegramAdapter(telegramConfig.config as any, config.stateDir);
      telegram.intelligence = sharedIntelligence ?? null;
      await telegram.start();
      console.log(pc.green(`  Telegram connected (stall alerts: ${sharedIntelligence ? 'LLM-gated' : 'timer-only'})`));

      // Wire NotificationBatcher to Telegram and start batching
      notificationBatcher.setSendFunction(
        async (topicId, text) => { await telegram!.sendToTopic(topicId, text); return { messageId: 0 }; }
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

      // Periodic quota notification check (every 10 minutes)
      if (quotaTracker) {
        setInterval(() => {
          const quotaState = quotaTracker!.getState();
          if (quotaState) {
            quotaNotifier.checkAndNotify(quotaState).catch(err => {
              console.error('[QuotaNotifier] Check failed:', err);
            });
          }
        }, 10 * 60 * 1000);
        console.log(pc.green('  Quota notifications enabled'));
      }

      // Wire up topic → session routing and session management callbacks
      wireTelegramRouting(telegram, sessionManager, quotaTracker, topicMemory);
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

        // Add to users via UserManager
        const { UserManager } = await import('../users/UserManager.js');
        const userManager = new UserManager(config.stateDir, config.users);
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
          const globalInstarDir = execSync('npm root -g', { encoding: 'utf-8', timeout: 10000 }).trim() + '/instar';
          execSync('npm rebuild better-sqlite3', {
            cwd: globalInstarDir,
            encoding: 'utf-8',
            timeout: 60000,
            stdio: 'pipe',
          });
          console.log(pc.green('  TopicMemory: better-sqlite3 rebuilt successfully, retrying...'));

          topicMemory = new TopicMemory(config.stateDir);
          await topicMemory.open();
        }

        const jsonlPath = path.join(config.stateDir, 'telegram-messages.jsonl');
        if (fs.existsSync(jsonlPath)) {
          const imported = topicMemory.importFromJsonl(jsonlPath);
          if (imported > 0) {
            console.log(pc.green(`  TopicMemory: imported ${imported} messages from JSONL`));
          }
        }

        const tmStats = topicMemory.stats();
        console.log(pc.green(`  TopicMemory: ${tmStats.totalMessages} messages, ${tmStats.totalTopics} topics, ${tmStats.topicsWithSummaries} summaries`));

        // Wire dual-write: every message logged to JSONL also goes to SQLite
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

    sessionManager.startMonitoring();
    if (scheduler) {
      sessionManager.on('sessionComplete', (session) => {
        scheduler!.processQueue();
        scheduler!.notifyJobComplete(session.id, session.tmuxSession);
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

    // Session Watchdog — auto-remediation for stuck commands
    let watchdog: SessionWatchdog | undefined;
    if (config.monitoring.watchdog?.enabled) {
      watchdog = new SessionWatchdog(config, sessionManager, state);
      watchdog.intelligence = sharedIntelligence ?? null;

      watchdog.on('intervention', (event: any) => {
        if (telegram) {
          const topicId = telegram.getTopicForSession(event.sessionName);
          if (topicId) {
            const levelNames = ['Monitoring', 'Ctrl+C', 'SIGTERM', 'SIGKILL', 'Kill Session'];
            const levelName = levelNames[event.level] || `Level ${event.level}`;
            telegram.sendToTopic(topicId,
              `🔧 Watchdog [${levelName}]: ${event.action}\nStuck: \`${event.stuckCommand.slice(0, 60)}\``
            ).catch(() => {});
          }
        }
      });

      watchdog.on('recovery', (sessionName: string, fromLevel: number) => {
        if (telegram) {
          const topicId = telegram.getTopicForSession(sessionName);
          if (topicId) {
            telegram.sendToTopic(topicId,
              `✅ Watchdog: session recovered (was at escalation level ${fromLevel})`
            ).catch(() => { /* @silent-fallback-ok — notification loss */ });
          }
        }
      });

      watchdog.start();
      console.log(pc.green('  Session Watchdog enabled'));
    }

    // StallTriageNurse — LLM-powered session recovery (uses shared intelligence)
    let triageNurse: StallTriageNurse | undefined;
    if (config.monitoring.triage?.enabled && telegram) {
      triageNurse = new StallTriageNurse(
        {
          captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          sendKey: (name, key) => sessionManager.sendKey(name, key),
          sendInput: (name, text) => sessionManager.sendInput(name, text),
          getTopicHistory: (topicId, limit) => {
            const entries = telegram!.getTopicHistory(topicId, limit);
            return entries.map(e => ({
              text: e.text,
              fromUser: e.fromUser,
              timestamp: e.timestamp,
            }));
          },
          sendToTopic: (topicId, text) => telegram!.sendToTopic(topicId, text),
          respawnSession: (name, topicId) => respawnSessionForTopic(sessionManager, telegram!, name, topicId, undefined, topicMemory),
          clearStallForTopic: (topicId) => telegram!.clearStallTracking(topicId),
        },
        {
          config: config.monitoring.triage,
          state,
          intelligence: sharedIntelligence,
        },
      );

      // Wire nurse into TelegramAdapter stall detection
      telegram.onStallDetected = async (topicId, sessionName, messageText, injectedAt) => {
        const result = await triageNurse!.triage(topicId, sessionName, messageText, injectedAt, 'telegram_stall');
        return { resolved: result.resolved };
      };

      console.log(pc.green('  Stall Triage Nurse enabled'));
    }

    // SessionMonitor — proactive session health monitoring
    let sessionMonitor: SessionMonitor | undefined;
    if (telegram) {
      sessionMonitor = new SessionMonitor(
        {
          getActiveTopicSessions: () => telegram!.getActiveTopicSessions(),
          captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          getTopicHistory: (topicId, limit) => {
            const history = telegram!.getMessageLog?.();
            if (!history) return [];
            return history
              .filter((m: any) => m.topicId === topicId)
              .slice(-limit)
              .map((m: any) => ({ text: m.text, fromUser: m.fromUser, timestamp: m.timestamp }));
          },
          sendToTopic: (topicId, text) => telegram!.sendToTopic(topicId, text),
          triggerTriage: triageNurse
            ? async (topicId, sessionName, reason) => {
                const result = await triageNurse!.triage(topicId, sessionName, reason, Date.now(), 'watchdog');
                return { resolved: result.resolved };
              }
            : undefined,
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
      },
      telegram,
      liveConfig,
    );
    autoUpdater.start();

    // ForegroundRestartWatcher — the critical gap fix (v0.9.72).
    // In foreground mode there's no supervisor to pick up restart-requested.json.
    // Without this, AutoUpdater installs the update, writes the flag, and nobody
    // acts on it — the process stays stale forever (the Luna/v0.9.70 incident).
    const restartWatcher = new ForegroundRestartWatcher({
      stateDir: config.stateDir,
      onRestartDetected: async (request) => {
        // IMMEDIATE tier sends directly — no batching delay
        notify('IMMEDIATE', 'system',
          `Update installed: v${request.previousVersion} → v${request.targetVersion}\n` +
          `Restarting now to load new code...`
        );
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

    // Set up Cloudflare Tunnel if configured
    let tunnel: TunnelManager | undefined;
    if (config.tunnel?.enabled) {
      tunnel = new TunnelManager({
        enabled: true,
        type: config.tunnel.type || 'quick',
        token: config.tunnel.token,
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
        notify(tier, 'system',
          `Memory ${to}: ${memState.pressurePercent.toFixed(1)}% used, ${memState.freeGB.toFixed(1)}GB free (trend: ${memState.trend})`
        );
      }
    });
    memoryMonitor.start();

    // Wire memory gate into scheduler
    if (scheduler) {
      const originalCanRun = scheduler.canRunJob;
      scheduler.canRunJob = (priority) => {
        // Check memory first
        const memCheck = memoryMonitor.canSpawnSession();
        if (!memCheck.allowed) {
          return false;
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
      alertCallback: async (msg: string) => {
        notify('SUMMARY', 'system', msg);
      },
    });
    orphanReaper.start();
    _orphanReaper = orphanReaper;
    _memoryMonitor = memoryMonitor;
    console.log(pc.green('  Orphan process reaper enabled'));

    // Coherence Monitor — runtime self-awareness for homeostasis.
    // Periodically checks config coherence, state durability, output sanity,
    // and feature readiness. Self-corrects where possible, notifies otherwise.
    const coherenceMonitor = new CoherenceMonitor({
      stateDir: config.stateDir,
      liveConfig,
      port: config.port,
      onIncoherence: (report) => {
        const failedChecks = report.checks.filter(c => !c.passed && !c.corrected);
        const summary = failedChecks.map(c => `• ${c.name}: ${c.message}`).join('\n');
        notify('SUMMARY', 'system',
          `Coherence: ${report.failed} issue(s):\n${summary}`
        );
      },
    });
    coherenceMonitor.start();
    console.log(pc.green('  Coherence monitor enabled'));

    // Commitment Tracker — durable promise enforcement for agent commitments.
    // When users ask agents to change settings/behavior, this ensures it sticks.
    const { CommitmentTracker } = await import('../monitoring/CommitmentTracker.js');
    const commitmentTracker = new CommitmentTracker({
      stateDir: config.stateDir,
      liveConfig,
      onViolation: (commitment, detail) => {
        notify('IMMEDIATE', 'commitment',
          `Commitment violated [${commitment.id}]: "${commitment.userRequest}"\n${detail}`
        );
      },
      onVerified: (commitment) => {
        console.log(`[CommitmentTracker] First verification passed: ${commitment.id} "${commitment.userRequest}"`);
      },
      onEscalation: (commitment, detail) => {
        notify('IMMEDIATE', 'commitment',
          `BUG DETECTED — Commitment ${commitment.id} keeps drifting:\n${detail}`
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

    // Start CaffeinateManager (prevents macOS system sleep)
    const { CaffeinateManager } = await import('../core/CaffeinateManager.js');
    const caffeinateManager = new CaffeinateManager({ stateDir: config.stateDir });
    caffeinateManager.start();

    // Start SleepWakeDetector (re-validate sessions on wake)
    const { SleepWakeDetector } = await import('../core/SleepWakeDetector.js');
    const sleepWakeDetector = new SleepWakeDetector();
    sleepWakeDetector.on('wake', async (event: { sleepDurationSeconds: number; timestamp: string }) => {
      console.log(`[SleepWake] Wake detected after ~${event.sleepDurationSeconds}s sleep`);

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

      // Restart tunnel if configured
      if (tunnel) {
        try {
          await tunnel.stop();
          const tunnelUrl = await tunnel.start();
          console.log(`[SleepWake] Tunnel restarted: ${tunnelUrl}`);

          // Re-broadcast dashboard URL after tunnel restart (quick tunnels get new URL)
          if (telegram && tunnelUrl) {
            const tunnelType = config.tunnel?.type || 'quick';
            await telegram.broadcastDashboardUrl(tunnelUrl, tunnelType as 'quick' | 'named').catch(() => {});
          }
        } catch (err) {
          console.error(`[SleepWake] Tunnel restart failed:`, err);
        }
      }

      // Notify via batcher — wake events are informational, not urgent
      notify('DIGEST', 'system',
        `Wake detected after ~${event.sleepDurationSeconds}s sleep. Sessions re-validated.`
      );
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

    const coherenceGate = new CoherenceGate({
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      projectName: config.projectName,
    });
    // Load any persisted topic-project bindings
    coherenceGate.loadTopicBindings();

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
        return sessionManager.killSession(sessionName);
      };
      console.log(pc.green('  Sentinel wired into Telegram message flow'));
    }

    const server = new AgentServer({ config, sessionManager, state, scheduler, telegram, relationships, feedback, feedbackAnomalyDetector, dispatches, updateChecker, autoUpdater, autoDispatcher, quotaTracker, publisher, viewer, tunnel, evolution, watchdog, topicMemory, triageNurse, projectMapper, coherenceGate, contextHierarchy, canonicalState, operationGate, sentinel, adaptiveTrust, memoryMonitor, orphanReaper, coherenceMonitor, commitmentTracker, coordinator: coordinator.enabled ? coordinator : undefined, localSigningKeyPem });
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

    // Start tunnel AFTER server is listening
    if (tunnel) {
      try {
        const tunnelUrl = await tunnel.start();
        console.log(pc.green(`  Tunnel active: ${pc.bold(tunnelUrl)}`));
      } catch (err) {
        console.error(pc.red(`  Tunnel failed: ${err instanceof Error ? err.message : String(err)}`));
        console.log(pc.yellow(`  Server running locally without tunnel. Fix tunnel config and restart.`));
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
          } else {
            console.log(pc.yellow(`  Dashboard available locally at http://localhost:${config.port}/dashboard (no tunnel configured — not broadcasting to Telegram)`));
          }
        }
      } catch (err) {
        // @silent-fallback-ok — dashboard topic is nice-to-have
        console.warn(`[server] Dashboard topic setup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Self-healing: ensure autostart is installed so the server always restarts
    // This is a non-negotiable requirement — the user must always be able to reach their agent remotely.
    // If autostart isn't installed, install it silently. The agent should never require human intervention
    // to ensure its own resilience.
    try {
      const hasTelegram = !!telegram;
      const autostartInstalled = isAutostartInstalled(config.projectName);
      if (!autostartInstalled) {
        const { installAutoStart } = await import('./setup.js');
        const installed = installAutoStart(config.projectName, config.projectDir, hasTelegram);
        if (installed) {
          console.log(pc.green(`  Auto-start self-healed: installed ${process.platform === 'darwin' ? 'LaunchAgent' : 'systemd service'}`));
        } else {
          console.log(pc.yellow(`  Auto-start not available on ${process.platform}`));
        }
      }
    } catch (err) {
      // @silent-fallback-ok — auto-start non-critical
      console.error(`  Auto-start check failed: ${err instanceof Error ? err.message : err}`);
    }

    // Spawn a short session to process any pending upgrade guide and message the user.
    // This fires after full server initialization — sessionManager, telegram, everything is ready.
    // The guide was written by `instar migrate` (during auto-update) or by the startup migration above.
    //
    // Uses UpgradeNotifyManager for verified delivery with model escalation:
    //   1. Try with haiku (fast, cheap)
    //   2. If guide wasn't acknowledged, retry with sonnet (more capable)
    //   3. If all attempts fail, preserve guide for next session-start
    try {
      const pendingGuidePath = path.join(config.stateDir, 'state', 'pending-upgrade-guide.md');
      if (fs.existsSync(pendingGuidePath)) {
        const guideContent = fs.readFileSync(pendingGuidePath, 'utf-8');
        if (guideContent.trim()) {
          console.log(pc.green('  Pending upgrade guide detected — spawning session to notify user'));

          // Brief delay so server is fully ready (scheduler, tunnel, etc.)
          setTimeout(async () => {
            try {
              const { UpgradeNotifyManager } = await import('../core/UpgradeNotifyManager.js');

              // Find the Telegram reply script for the prompt (may be in .claude/scripts or .instar/scripts)
              const replyScriptClaude = path.join(config.projectDir, '.claude', 'scripts', 'telegram-reply.sh');
              const replyScriptInstar = path.join(config.projectDir, '.instar', 'scripts', 'telegram-reply.sh');
              const replyScript = fs.existsSync(replyScriptClaude) ? replyScriptClaude
                : fs.existsSync(replyScriptInstar) ? replyScriptInstar : '';
              // Route upgrade notifications to Updates topic (informational, not critical)
              const notifyTopicId = state.get<number>('agent-updates-topic') || state.get<number>('agent-attention-topic') || 0;

              const notifyManager = new UpgradeNotifyManager(
                {
                  pendingGuidePath,
                  projectDir: config.projectDir,
                  stateDir: config.stateDir,
                  port: config.port,
                  dashboardPin: config.dashboardPin || '',
                  tunnelUrl: tunnel?.url || '',
                  currentVersion: getInstalledVersion(),
                  replyScript,
                  notifyTopicId,
                },
                // SessionSpawner
                (opts) => sessionManager.spawnSession(opts),
                // SessionCompletionChecker
                (sessionId) => {
                  const session = state.getSession(sessionId);
                  return !session || session.status === 'completed' || session.status === 'failed' || session.status === 'killed';
                },
                // ActivityLogger — writes to activity JSONL for observability
                (event) => {
                  try {
                    const logDir = path.join(config.stateDir, 'logs');
                    fs.mkdirSync(logDir, { recursive: true });
                    const today = new Date().toISOString().slice(0, 10);
                    const logFile = path.join(logDir, `activity-${today}.jsonl`);
                    const entry = { ...event, timestamp: new Date().toISOString() };
                    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
                  } catch { /* @silent-fallback-ok — activity log non-critical */ }
                },
              );

              const result = await notifyManager.notify();
              if (result.success) {
                console.log(pc.green(`  Upgrade guide delivered (${result.model}, ${result.attempts} attempt${result.attempts !== 1 ? 's' : ''})`));
              } else {
                console.warn(pc.yellow(`  Upgrade guide delivery failed after ${result.attempts} attempts: ${result.error}`));
                console.warn(pc.yellow('  Guide preserved — will be injected at next session-start'));
              }
            } catch (err) {
              console.error(`[UpgradeGuide] Failed to spawn notification session: ${err instanceof Error ? err.message : err}`);
              DegradationReporter.getInstance().report({
                feature: 'server.deliverUpgradeGuide',
                primary: 'Spawn session to deliver upgrade guide',
                fallback: 'Guide not delivered',
                reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
                impact: 'User misses upgrade instructions',
              });
            }
          }, 15_000); // 15 second delay — let everything settle
        }
      }
    } catch (err) {
      // Non-critical — don't crash the server over upgrade guide processing
      DegradationReporter.getInstance().report({
        feature: 'server.upgradeGuideProcessing',
        primary: 'Check for and process pending upgrade guide',
        fallback: 'Upgrade guide check skipped entirely',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Pending upgrade guide not detected — user may miss upgrade instructions until next restart',
      });
    }

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      gitSync?.stop();
      coordinator.stop();
      coherenceMonitor.stop();
      commitmentTracker.stop();
      commitmentSentinel?.stop();
      await notificationBatcher.flushAll(); // Drain pending notifications before exit
      notificationBatcher.stop();
      memoryMonitor.stop();
      caffeinateManager.stop();
      sleepWakeDetector.stop();
      autoUpdater.stop();
      autoDispatcher?.stop();
      sessionMonitor?.stop();
      if (tunnel) await tunnel.stop();
      stopHeartbeat();
      unregisterAgent(config.projectDir);
      scheduler?.stop();
      if (telegram) await telegram.stop();
      sessionManager.stopMonitoring();
      await server.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
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
