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
import { AgentServer } from '../server/AgentServer.js';
import { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import { RelationshipManager } from '../core/RelationshipManager.js';
import { ClaudeCliIntelligenceProvider } from '../core/ClaudeCliIntelligenceProvider.js';
import { AnthropicIntelligenceProvider } from '../core/AnthropicIntelligenceProvider.js';
import { FeedbackManager } from '../core/FeedbackManager.js';
import { DispatchManager } from '../core/DispatchManager.js';
import { UpdateChecker } from '../core/UpdateChecker.js';
import { AutoUpdater } from '../core/AutoUpdater.js';
import { AutoDispatcher } from '../core/AutoDispatcher.js';
import { DispatchExecutor } from '../core/DispatchExecutor.js';
import { registerPort, unregisterPort, startHeartbeat } from '../core/PortRegistry.js';
import { TelegraphService } from '../publishing/TelegraphService.js';
import { PrivateViewer } from '../publishing/PrivateViewer.js';
import { TunnelManager } from '../tunnel/TunnelManager.js';
import { PostUpdateMigrator } from '../core/PostUpdateMigrator.js';
import { UpgradeGuideProcessor } from '../core/UpgradeGuideProcessor.js';
import { EvolutionManager } from '../core/EvolutionManager.js';
import { QuotaTracker } from '../monitoring/QuotaTracker.js';
import { AccountSwitcher } from '../monitoring/AccountSwitcher.js';
import { QuotaNotifier } from '../monitoring/QuotaNotifier.js';
import { classifySessionDeath } from '../monitoring/QuotaExhaustionDetector.js';
import { SessionWatchdog } from '../monitoring/SessionWatchdog.js';
import type { Message } from '../core/types.js';
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
  const newSessionName = await sessionManager.spawnInteractiveSession(bootstrapMessage, topicName, { telegramTopicId: topicId });

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
      } catch { /* not running */ }

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
function wireTelegramRouting(
  telegram: TelegramAdapter,
  sessionManager: SessionManager,
  quotaTracker?: QuotaTracker,
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
          respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, text).catch(err => {
            console.error(`[telegram→session] Respawn failed:`, err);
          });
        }
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
      'Agent Updates',
      7322096, // Blue — informational
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
function getInstalledVersion(): string {
  try {
    const pkgPath = path.resolve(new URL(import.meta.url).pathname, '../../../package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || '';
  } catch {
    return '';
  }
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

    // Run post-update migration on startup — ensures agent knowledge stays current
    // even if the update was installed externally (e.g., via `npm install -g instar@latest`)
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

        // Also run upgrade guide processing — ensures pending guide file exists
        // even if the update was installed without running `instar migrate`.
        // Skip if a pending guide already exists (from a prior `instar migrate` run).
        try {
          const guideProcessor = new UpgradeGuideProcessor({
            stateDir: config.stateDir,
            currentVersion: installedVersion,
          });
          if (!guideProcessor.hasPendingGuide()) {
            const guideResult = guideProcessor.process();
            if (guideResult.pendingGuides.length > 0) {
              console.log(pc.green(`  Upgrade guides pending: ${guideResult.pendingGuides.join(', ')}`));
            }
          }
        } catch (guideErr) {
          console.log(pc.yellow(`  Upgrade guide check: ${guideErr instanceof Error ? guideErr.message : String(guideErr)}`));
        }
      }
    } catch (err) {
      console.log(pc.yellow(`  Post-update migration check: ${err instanceof Error ? err.message : String(err)}`));
    }

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

    // Set up Telegram if configured
    // When --no-telegram is set (lifeline owns polling), create adapter in send-only mode
    // so the server can still relay replies via /telegram/reply/:topicId
    let telegram: TelegramAdapter | undefined;
    const telegramConfig = config.messaging.find(m => m.type === 'telegram' && m.enabled);
    const skipTelegram = options.telegram === false; // --no-telegram sets telegram: false
    if (skipTelegram && telegramConfig) {
      // Send-only mode: no polling, but sendToTopic() works for session replies
      telegram = new TelegramAdapter(telegramConfig.config as any, config.stateDir);
      console.log(pc.green('  Telegram send-only mode (lifeline owns polling)'));

      // Ensure topics exist even in send-only mode (createForumTopic is a simple API call)
      ensureAgentAttentionTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Attention topic: ${err}`);
      });
      ensureAgentUpdatesTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Updates topic: ${err}`);
      });
    }
    if (telegramConfig && !skipTelegram) {
      telegram = new TelegramAdapter(telegramConfig.config as any, config.stateDir);
      await telegram.start();
      console.log(pc.green('  Telegram connected'));

      // Set up account switcher (Keychain-based OAuth account swapping)
      const accountSwitcher = new AccountSwitcher();

      // Set up quota notifier (Telegram alerts on threshold crossings)
      const quotaNotifier = new QuotaNotifier(config.stateDir);
      const alertTopicId = state.get<number>('agent-attention-topic') ?? null;
      quotaNotifier.configure(
        async (topicId, text) => { await telegram!.sendToTopic(topicId, text); },
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
      wireTelegramRouting(telegram, sessionManager, quotaTracker);
      wireTelegramCallbacks(telegram, sessionManager, state, quotaTracker, accountSwitcher, config.sessions.claudePath);
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

    sessionManager.startMonitoring();
    if (scheduler) {
      sessionManager.on('sessionComplete', (session) => {
        scheduler!.processQueue();
        scheduler!.notifyJobComplete(session.id, session.tmuxSession);
      });
    }

    // Session Watchdog — auto-remediation for stuck commands
    let watchdog: SessionWatchdog | undefined;
    if (config.monitoring.watchdog?.enabled) {
      watchdog = new SessionWatchdog(config, sessionManager, state);

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
            ).catch(() => {});
          }
        }
      });

      watchdog.start();
      console.log(pc.green('  Session Watchdog enabled'));
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
    // Set up dispatch system with auto-dispatcher
    let dispatches: DispatchManager | undefined;
    let autoDispatcher: AutoDispatcher | undefined;
    if (config.dispatches) {
      dispatches = new DispatchManager({
        ...config.dispatches,
        version: config.version,
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

    // Start MemoryPressureMonitor (platform-aware memory tracking)
    const { MemoryPressureMonitor } = await import('../monitoring/MemoryPressureMonitor.js');
    const memoryMonitor = new MemoryPressureMonitor({});
    memoryMonitor.on('stateChange', ({ from, to, state: memState }: { from: string; to: string; state: any }) => {
      // Gate scheduler spawning on memory pressure
      if (scheduler && (to === 'elevated' || to === 'critical')) {
        console.log(`[MemoryPressure] ${from} -> ${to} — scheduler should respect canSpawnSession()`);
      }
      // Alert via Telegram attention topic
      if (telegram && to !== 'normal') {
        const attentionTopicId = state.get<number>('agent-attention-topic');
        if (attentionTopicId) {
          telegram.sendToTopic(attentionTopicId,
            `Memory ${to}: ${memState.pressurePercent.toFixed(1)}% used, ${memState.freeGB.toFixed(1)}GB free (trend: ${memState.trend})`
          ).catch(() => {});
        }
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
        } catch (err) {
          console.error(`[SleepWake] Tunnel restart failed:`, err);
        }
      }

      // Notify via Telegram attention topic
      if (telegram) {
        const attentionTopicId = state.get<number>('agent-attention-topic');
        if (attentionTopicId) {
          telegram.sendToTopic(attentionTopicId, `Wake detected after ~${event.sleepDurationSeconds}s sleep. Sessions re-validated.`).catch(() => {});
        }
      }
    });
    sleepWakeDetector.start();

    const server = new AgentServer({ config, sessionManager, state, scheduler, telegram, relationships, feedback, dispatches, updateChecker, autoUpdater, autoDispatcher, quotaTracker, publisher, viewer, tunnel, evolution, watchdog });
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
      // Non-critical — don't crash the server over autostart
      console.error(`  Auto-start check failed: ${err instanceof Error ? err.message : err}`);
    }

    // Spawn a short session to process any pending upgrade guide and message the user.
    // This fires after full server initialization — sessionManager, telegram, everything is ready.
    // The guide was written by `instar migrate` (during auto-update) or by the startup migration above.
    try {
      const pendingGuidePath = path.join(config.stateDir, 'state', 'pending-upgrade-guide.md');
      if (fs.existsSync(pendingGuidePath)) {
        const guideContent = fs.readFileSync(pendingGuidePath, 'utf-8');
        if (guideContent.trim()) {
          console.log(pc.green('  Pending upgrade guide detected — spawning session to notify user'));

          // Brief delay so server is fully ready (scheduler, tunnel, etc.)
          setTimeout(async () => {
            try {
              // Find the Telegram reply script for the prompt (may be in .claude/scripts or .instar/scripts)
              const replyScriptClaude = path.join(config.projectDir, '.claude', 'scripts', 'telegram-reply.sh');
              const replyScriptInstar = path.join(config.projectDir, '.instar', 'scripts', 'telegram-reply.sh');
              const replyScript = fs.existsSync(replyScriptClaude) ? replyScriptClaude
                : fs.existsSync(replyScriptInstar) ? replyScriptInstar : '';
              const hasReplyScript = !!replyScript;
              // Route upgrade notifications to Updates topic (informational, not critical)
              const notifyTopicId = state.get<number>('agent-updates-topic') || state.get<number>('agent-attention-topic') || 0;

              // Gather concrete details the agent should include in the message
              const dashboardPin = config.dashboardPin || '';
              const tunnelUrl = tunnel?.url || '';
              const dashboardUrl = tunnelUrl
                ? `${tunnelUrl}/dashboard`
                : `http://localhost:${config.port}/dashboard`;

              await sessionManager.spawnSession({
                name: 'upgrade-notify',
                prompt: [
                  'IMPORTANT: You are a SHORT-LIVED session with ONE specific task. Do NOT search for files or explore the codebase. Everything you need is in this prompt.',
                  '',
                  'You have been updated to a new Instar version. Read the upgrade guide below, then:',
                  '',
                  '1. Compose a brief, personalized message (3-8 sentences) for your user about the new features.',
                  '   RULES:',
                  '   - Write like you\'re texting a friend — warm, conversational, no jargon',
                  '   - This should NOT look like a changelog or release notes',
                  '   - Lead with the biggest USER-VISIBLE feature (usually the dashboard if this is the first time)',
                  '   - Include CONCRETE details — actual URLs, PINs, things they can click/use right now',
                  '   - NEVER mention "bearer tokens", "auth tokens", version numbers in headers, or internal implementation details',
                  '   - Focus on what matters to THEM, not internal plumbing',
                  '   - NO bullet lists, NO markdown headers, NO technical formatting — just natural sentences',
                  '',
                  '   CONCRETE DETAILS TO INCLUDE:',
                  `   - Dashboard URL: ${dashboardUrl}`,
                  dashboardPin ? `   - Dashboard PIN: ${dashboardPin}` : '   - No dashboard PIN set',
                  `   - Current version: ${getInstalledVersion()}`,
                  '',
                  `2. Send the message via Telegram:`,
                  hasReplyScript && notifyTopicId
                    ? `   Run: cat <<'MSGEOF' | bash ${replyScript} ${notifyTopicId}\nYOUR_MESSAGE_HERE\nMSGEOF`
                    : `   Use the telegram-reply script in .instar/scripts/ to send to the updates topic.`,
                  '',
                  '3. Run: instar upgrade-ack',
                  '',
                  'That is ALL. Do not do anything else. Do not search for files. Do not read config files. Just compose, send, ack.',
                  '',
                  '--- UPGRADE GUIDE ---',
                  guideContent,
                  '--- END GUIDE ---',
                ].join('\n'),
                model: 'haiku',
                jobSlug: 'upgrade-notify',
                maxDurationMinutes: 5,
              });
            } catch (err) {
              console.error(`[UpgradeGuide] Failed to spawn notification session: ${err instanceof Error ? err.message : err}`);
            }
          }, 15_000); // 15 second delay — let everything settle
        }
      }
    } catch {
      // Non-critical — don't crash the server over upgrade guide processing
    }

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      memoryMonitor.stop();
      caffeinateManager.stop();
      sleepWakeDetector.stop();
      autoUpdater.stop();
      autoDispatcher?.stop();
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
