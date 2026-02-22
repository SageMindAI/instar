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
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig, ensureStateDir, detectTmuxPath } from '../core/Config.js';
import { SessionManager } from '../core/SessionManager.js';
import { StateManager } from '../core/StateManager.js';
import { JobScheduler } from '../scheduler/JobScheduler.js';
import { AgentServer } from '../server/AgentServer.js';
import { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import { RelationshipManager } from '../core/RelationshipManager.js';
import { ClaudeCliIntelligenceProvider } from '../core/ClaudeCliIntelligenceProvider.js';
import { AnthropicIntelligenceProvider } from '../core/AnthropicIntelligenceProvider.js';
import { FeedbackManager } from '../core/FeedbackManager.js';
import { DispatchManager } from '../core/DispatchManager.js';
import { UpdateChecker } from '../core/UpdateChecker.js';
import { AutoUpdater } from '../core/AutoUpdater.js';
import { registerPort, unregisterPort, startHeartbeat } from '../core/PortRegistry.js';
import { TelegraphService } from '../publishing/TelegraphService.js';
import { PrivateViewer } from '../publishing/PrivateViewer.js';
import { TunnelManager } from '../tunnel/TunnelManager.js';
import { EvolutionManager } from '../core/EvolutionManager.js';
import { QuotaTracker } from '../monitoring/QuotaTracker.js';
import type { Message } from '../core/types.js';

interface StartOptions {
  foreground?: boolean;
  dir?: string;
  /** When false, skip Telegram polling (used when lifeline owns the Telegram connection).
   *  Commander maps --no-telegram to telegram: false. */
  telegram?: boolean;
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
): Promise<void> {
  console.log(`[telegram→session] Session "${targetSession}" needs respawn for topic ${topicId}`);

  const msg = latestMessage || 'Session respawned — send a message to continue.';

  // Fetch thread history for context
  let historyLines: string[] = [];
  try {
    const history = telegram.getTopicHistory(topicId, 20);
    if (history.length > 0) {
      historyLines.push(`--- Thread History (last ${history.length} messages) ---`);
      historyLines.push(`IMPORTANT: Read this history carefully before taking any action.`);
      historyLines.push(`Your task is to continue THIS conversation, not start something new.`);
      historyLines.push(``);
      for (const m of history) {
        const sender = m.fromUser ? 'User' : 'Agent';
        const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
        const text = (m.text || '').slice(0, 300);
        historyLines.push(`[${ts}] ${sender}: ${text}`);
      }
      historyLines.push(``);
      historyLines.push(`--- End Thread History ---`);
    }
  } catch (err) {
    console.error(`[telegram→session] Failed to fetch thread history:`, err);
  }

  // Single-line bootstrap to avoid tmux send-keys newline issues.
  // Thread history and context go into temp files for Claude to read.
  const tmpDir = '/tmp/instar-telegram';
  fs.mkdirSync(tmpDir, { recursive: true });

  let bootstrapMessage: string;
  const relayNote = `You MUST relay your response via: cat <<'EOF' | .claude/scripts/telegram-reply.sh ${topicId}\nYour response\nEOF`;

  if (historyLines.length > 0) {
    const historyContent = historyLines.join('\n');
    const filepath = path.join(tmpDir, `history-${topicId}-${Date.now()}-${process.pid}.txt`);
    fs.writeFileSync(filepath, historyContent);

    // Single-line: user message + file reference for history + relay instructions
    bootstrapMessage = `[telegram:${topicId}] ${msg} (Session respawned. Thread history at ${filepath} — read it for context before responding. ${relayNote})`;
  } else {
    bootstrapMessage = `[telegram:${topicId}] ${msg} (${relayNote})`;
  }

  const storedName = telegram.getTopicName(topicId);
  // Use topic name, not tmux session name — tmux names include the project prefix
  // which causes cascading names like ai-guy-ai-guy-ai-guy-topic-1 on each respawn.
  const topicName = storedName || `topic-${topicId}`;
  const newSessionName = await sessionManager.spawnInteractiveSession(bootstrapMessage, topicName);

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
): void {
  // /interrupt — send Escape key to a tmux session
  telegram.onInterruptSession = async (sessionName: string): Promise<boolean> => {
    try {
      execFileSync(detectTmuxPath()!, ['send-keys', '-t', `=${sessionName}:`, 'Escape'], {
        encoding: 'utf-8', timeout: 5000,
      });
      return true;
    } catch {
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
    await respawnSessionForTopic(sessionManager, telegram, sessionName, topicId);
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
}

/**
 * Wire up Telegram message routing: topic messages → Claude sessions.
 * This is the core handler that makes Telegram topics work like sessions.
 */
function wireTelegramRouting(
  telegram: TelegramAdapter,
  sessionManager: SessionManager,
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

      (async () => {
        try {
          const topic = await telegram.createForumTopic(topicName, 9367192); // Green
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

    // Route message to corresponding session
    const targetSession = telegram.getSessionForTopic(topicId);

    if (targetSession) {
      // Session is mapped — check if it's alive, inject or respawn
      if (sessionManager.isSessionAlive(targetSession)) {
        console.log(`[telegram→session] Injecting into ${targetSession}: "${text.slice(0, 80)}"`);
        sessionManager.injectTelegramMessage(targetSession, topicId, text);
        // Delivery confirmation — let the user know the message reached the session
        telegram.sendToTopic(topicId, `✓ Delivered`).catch(() => {});
        // Track for stall detection
        telegram.trackMessageInjection(topicId, targetSession, text);
      } else {
        // Session died — respawn with thread history
        telegram.sendToTopic(topicId, `🔄 Session restarting — message queued.`).catch(() => {});
        respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, text).catch(err => {
          console.error(`[telegram→session] Respawn failed:`, err);
        });
      }
    } else {
      // No session mapped — auto-spawn one
      console.log(`[telegram→session] No session for topic ${topicId}, auto-spawning...`);
      const storedName = telegram.getTopicName(topicId) || `topic-${topicId}`;

      // Write relay instructions to a temp file and reference it in the bootstrap message.
      // The session needs to know HOW to respond back to Telegram.
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

      sessionManager.spawnInteractiveSession(bootstrapMessage, storedName, { telegramTopicId: topicId }).then((newSessionName) => {
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
      'Agent Attention',
      9367192, // Green — direct line to user
    );
    state.set('agent-attention-topic', topic.topicId);
    await telegram.sendToTopic(topic.topicId,
      `This is your agent's direct line to you.\n\nInfrastructure issues, proactive observations, relationship insights, and anything that doesn't fit into another topic will appear here.`
    );
    console.log(pc.green(`  Created Agent Attention topic: ${topic.topicId}`));
  } catch (err) {
    console.error(`  Failed to create Agent Attention topic: ${err}`);
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
      } catch { /* skip individual file errors */ }
    }
    if (cleaned > 0) {
      console.log(`[cleanup] Removed ${cleaned} stale temp files from ${tmpDir}`);
    }
  } catch {
    // Non-critical — don't fail startup on cleanup errors
  }
}

/**
 * Tee stdout/stderr to a log file for observability.
 * The self-diagnosis job checks .instar/logs/server.log — this ensures it exists.
 * Log is truncated at 5MB to prevent unbounded growth.
 */
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

  const serverSessionName = `${config.projectName}-server`;

  if (options.foreground) {
    // Run in foreground — useful for development
    console.log(pc.bold(`Starting instar server for ${pc.cyan(config.projectName)}`));
    console.log(`  Port: ${config.port}`);
    console.log(`  State: ${config.stateDir}`);
    console.log();

    // Set up file logging for observability
    setupServerLog(config.stateDir);

    // Clean up stale Telegram temp files on startup
    cleanupTelegramTempFiles();

    // Register this instance in the port registry (multi-instance support)
    try {
      registerPort(config.projectName, config.port, config.projectDir);
      console.log(pc.green(`  Registered port ${config.port} for "${config.projectName}"`));
    } catch (err) {
      console.log(pc.red(`  Port conflict: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
    const stopHeartbeat = startHeartbeat(config.projectName);

    // Warn if no auth token configured — server allows unauthenticated access
    if (!config.authToken) {
      console.log(pc.yellow(pc.bold('  ⚠ WARNING: No auth token configured — all API endpoints are unauthenticated!')));
      console.log(pc.yellow('  Set authToken in .instar/config.json or re-run instar init'));
      console.log();
    }

    const state = new StateManager(config.stateDir);
    const sessionManager = new SessionManager(config.sessions, state);
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
    if (config.scheduler.enabled) {
      scheduler = new JobScheduler(config.scheduler, sessionManager, state, config.stateDir);
      if (quotaTracker) {
        scheduler.canRunJob = quotaTracker.canRunJob.bind(quotaTracker);
        scheduler.setQuotaTracker(quotaTracker);
      }
      scheduler.start();
      console.log(pc.green('  Scheduler started'));
    }

    // Set up Telegram if configured (skip if lifeline owns the connection)
    let telegram: TelegramAdapter | undefined;
    const telegramConfig = config.messaging.find(m => m.type === 'telegram' && m.enabled);
    const skipTelegram = options.telegram === false; // --no-telegram sets telegram: false
    if (skipTelegram && telegramConfig) {
      console.log(pc.dim('  Telegram polling skipped (--no-telegram flag)'));
    }
    if (telegramConfig && !skipTelegram) {
      telegram = new TelegramAdapter(telegramConfig.config as any, config.stateDir);
      await telegram.start();
      console.log(pc.green('  Telegram connected'));

      // Wire up topic → session routing and session management callbacks
      wireTelegramRouting(telegram, sessionManager);
      wireTelegramCallbacks(telegram, sessionManager, state);
      console.log(pc.green('  Telegram message routing active'));

      if (scheduler) {
        scheduler.setMessenger(telegram);
        scheduler.setTelegram(telegram);
      }

      // Ensure Agent Attention topic exists (the agent's direct line to the user)
      ensureAgentAttentionTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Attention topic: ${err}`);
      });
    }

    sessionManager.startMonitoring();
    if (scheduler) {
      sessionManager.on('sessionComplete', (session) => {
        scheduler!.processQueue();
        scheduler!.notifyJobComplete(session.id, session.tmuxSession);
      });
    }

    // Set up feedback and update checking
    let feedback: FeedbackManager | undefined;
    if (config.feedback) {
      feedback = new FeedbackManager({
        ...config.feedback,
        version: config.version,
      });
      console.log(pc.green('  Feedback loop enabled'));
    }
    // Set up dispatch system
    let dispatches: DispatchManager | undefined;
    if (config.dispatches) {
      dispatches = new DispatchManager({
        ...config.dispatches,
        version: config.version,
      });
      console.log(pc.green('  Dispatch system enabled'));
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
    );
    autoUpdater.start();

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

    const server = new AgentServer({ config, sessionManager, state, scheduler, telegram, relationships, feedback, dispatches, updateChecker, autoUpdater, quotaTracker, publisher, viewer, tunnel, evolution });
    await server.start();

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

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      autoUpdater.stop();
      if (tunnel) await tunnel.stop();
      stopHeartbeat();
      unregisterPort(config.projectName);
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
    // Fallback: force kill
    try {
      execFileSync(tmuxPath, ['kill-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
      console.log(pc.green(`Server stopped (forced kill: ${serverSessionName})`));
    } catch {
      console.log(pc.yellow(`No server running (no tmux session: ${serverSessionName})`));
    }
  }
}
