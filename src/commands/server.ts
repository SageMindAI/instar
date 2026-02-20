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
import { FeedbackManager } from '../core/FeedbackManager.js';
import { UpdateChecker } from '../core/UpdateChecker.js';
import type { Message } from '../core/types.js';

interface StartOptions {
  foreground?: boolean;
  dir?: string;
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

  // Always keep the user's message inline — never hide it behind a file reference.
  // Only thread history goes into a file for supplementary context.
  let bootstrapMessage: string;

  if (historyLines.length > 0) {
    const historyContent = historyLines.join('\n');
    const tmpDir = '/tmp/instar-telegram';
    fs.mkdirSync(tmpDir, { recursive: true });
    const filepath = path.join(tmpDir, `history-${topicId}-${Date.now()}-${process.pid}.txt`);
    fs.writeFileSync(filepath, historyContent);

    bootstrapMessage = [
      `[telegram:${topicId}] ${msg}`,
      ``,
      `(Session was respawned. Thread history is at ${filepath} — read it for context. Then RESPOND to the user's message above via Telegram relay.)`,
    ].join('\n');
  } else {
    bootstrapMessage = `[telegram:${topicId}] ${msg}`;
  }

  const storedName = telegram.getTopicName(topicId);
  const topicName = storedName || targetSession;
  const newSessionName = await sessionManager.spawnInteractiveSession(bootstrapMessage, topicName);

  telegram.registerTopicSession(topicId, newSessionName);
  await telegram.sendToTopic(topicId, `Session respawned.`);
  console.log(`[telegram→session] Respawned "${newSessionName}" for topic ${topicId}`);
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

    // Handle /new command — spawn a new session with its own topic
    const newMatch = text.match(/^\/new(?:\s+(.+))?$/);
    if (newMatch) {
      const sessionName = newMatch[1]?.trim() || null;
      const topicName = sessionName || `session-${new Date().toISOString().slice(5, 16).replace('T', '-').replace(':', '')}`;

      (async () => {
        try {
          const topic = await telegram.createForumTopic(topicName, 9367192); // Green
          const newSession = await sessionManager.spawnInteractiveSession(
            `[telegram:${topic.topicId}] New session started.`,
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
      } else {
        // Session died — respawn with thread history
        respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, text).catch(err => {
          console.error(`[telegram→session] Respawn failed:`, err);
        });
      }
    } else {
      // No session mapped — auto-spawn one
      console.log(`[telegram→session] No session for topic ${topicId}, auto-spawning...`);
      const storedName = telegram.getTopicName(topicId) || `topic-${topicId}`;

      // Always keep the user's message inline — never hide it behind a file reference
      const bootstrapMessage = [
        `[telegram:${topicId}] ${text}`,
        ``,
        `(This session was auto-created for a Telegram topic. Respond to the user's message above via Telegram relay.)`,
      ].join('\n');

      sessionManager.spawnInteractiveSession(bootstrapMessage, storedName).then((newSessionName) => {
        telegram.registerTopicSession(topicId, newSessionName);
        telegram.sendToTopic(topicId, `Session auto-created. I'm here.`).catch(() => {});
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
      relationships = new RelationshipManager(config.relationships);
      console.log(pc.green(`  Relationships loaded: ${relationships.getAll().length} tracked`));
    }

    let scheduler: JobScheduler | undefined;
    if (config.scheduler.enabled) {
      scheduler = new JobScheduler(config.scheduler, sessionManager, state);
      scheduler.start();
      console.log(pc.green('  Scheduler started'));
    }

    // Set up Telegram if configured
    let telegram: TelegramAdapter | undefined;
    const telegramConfig = config.messaging.find(m => m.type === 'telegram' && m.enabled);
    if (telegramConfig) {
      telegram = new TelegramAdapter(telegramConfig.config as any, config.stateDir);
      await telegram.start();
      console.log(pc.green('  Telegram connected'));

      // Wire up topic → session routing
      wireTelegramRouting(telegram, sessionManager);
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
      feedback = new FeedbackManager(config.feedback);
      console.log(pc.green('  Feedback loop enabled'));
    }
    const updateChecker = new UpdateChecker(config.stateDir);

    // Check for updates on startup
    updateChecker.check().then(info => {
      if (info.updateAvailable) {
        console.log(pc.yellow(`  Update available: ${info.currentVersion} → ${info.latestVersion}`));
        console.log(pc.yellow(`  Run: npm update -g instar`));
      } else {
        console.log(pc.green(`  Instar ${info.currentVersion} is up to date`));
      }
    }).catch(() => { /* ignore startup check failures */ });

    const server = new AgentServer({ config, sessionManager, state, scheduler, telegram, relationships, feedback, updateChecker });
    await server.start();

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
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

    const nodeCmd = `node '${cliPath}' server start --foreground`;

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
