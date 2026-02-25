/**
 * Telegram Lifeline — minimal persistent process that owns the Telegram connection.
 *
 * Architecture:
 *   Lifeline (this process)
 *     ├── Telegram Bot polling (always running)
 *     ├── Message queue (persisted to disk)
 *     └── Server Supervisor (manages full Instar server as child)
 *
 * The lifeline is intentionally minimal — it only handles:
 *   1. Telegram message polling
 *   2. Forwarding messages to the server
 *   3. Queuing messages when server is down
 *   4. Replaying queued messages when server recovers
 *   5. Responding to /lifeline commands directly
 *   6. Supervising the server process
 *
 * This ensures the user always has a communication channel even when
 * the full server crashes, runs out of memory, or gets stuck.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig, ensureStateDir } from '../core/Config.js';
import { registerAgent, unregisterAgent, startHeartbeat } from '../core/AgentRegistry.js';
// setup.ts uses @inquirer/prompts which requires Node 20.12+
// Dynamic import to avoid breaking the lifeline on older Node versions
// import { installAutoStart } from '../commands/setup.js';
import { MessageQueue, type QueuedMessage } from './MessageQueue.js';
import { ServerSupervisor } from './ServerSupervisor.js';

/**
 * Acquire an exclusive lock file to prevent multiple lifeline instances.
 * Returns true if lock acquired, false if another instance holds it.
 */
function acquireLockFile(lockPath: string): boolean {
  try {
    // Check if lock file exists and if the PID is still alive
    if (fs.existsSync(lockPath)) {
      const raw = fs.readFileSync(lockPath, 'utf-8');
      const data = JSON.parse(raw);
      if (data.pid && typeof data.pid === 'number') {
        try {
          // Signal 0 checks if process exists without killing it
          process.kill(data.pid, 0);
          // Process still alive — another lifeline is running
          return false;
        } catch {
          // Process is dead — stale lock, we can take over
          console.log(`[Lifeline] Removing stale lock (PID ${data.pid} is dead)`);
        }
      }
    }

    // Write our PID
    const tmpPath = `${lockPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.renameSync(tmpPath, lockPath);
    return true;
  } catch (err) {
    console.error(`[Lifeline] Lock acquisition failed: ${err}`);
    return false;
  }
}

function releaseLockFile(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) {
      const raw = fs.readFileSync(lockPath, 'utf-8');
      const data = JSON.parse(raw);
      // Only remove if we own it
      if (data.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch { /* best effort */ }
}

interface LifelineConfig {
  token: string;
  chatId: string;
  pollIntervalMs?: number;
  lifelineTopicId?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number };
    message_thread_id?: number;
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
    date: number;
  };
}

export class TelegramLifeline {
  private config: LifelineConfig;
  private projectConfig: ReturnType<typeof loadConfig>;
  private queue: MessageQueue;
  private supervisor: ServerSupervisor;
  private polling = false;
  private lastUpdateId = 0;
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;
  private offsetPath: string;
  private stopHeartbeat: (() => void) | null = null;
  private replayInterval: ReturnType<typeof setInterval> | null = null;
  private lifelineTopicId: number | null = null;
  private lockPath: string;

  constructor(projectDir?: string) {
    this.projectConfig = loadConfig(projectDir);
    ensureStateDir(this.projectConfig.stateDir);

    // Find Telegram config
    const telegramConfig = this.projectConfig.messaging.find(
      m => m.type === 'telegram' && m.enabled
    );
    if (!telegramConfig) {
      throw new Error('No Telegram messaging configured. Add it with: instar add telegram');
    }

    this.config = telegramConfig.config as unknown as LifelineConfig;
    this.queue = new MessageQueue(this.projectConfig.stateDir);
    this.offsetPath = path.join(this.projectConfig.stateDir, 'lifeline-poll-offset.json');
    this.lockPath = path.join(this.projectConfig.stateDir, 'lifeline.lock');

    this.supervisor = new ServerSupervisor({
      projectDir: this.projectConfig.projectDir,
      projectName: this.projectConfig.projectName,
      port: this.projectConfig.port,
      stateDir: this.projectConfig.stateDir,
    });

    // Wire supervisor events
    this.supervisor.on('serverUp', () => {
      console.log('[Lifeline] Server is up — replaying queued messages');
      this.replayQueue();
    });

    this.supervisor.on('serverDown', (reason: string) => {
      console.log(`[Lifeline] Server went down: ${reason}`);
      this.notifyServerDown(reason);
    });

    this.supervisor.on('serverRestarting', (attempt: number) => {
      console.log(`[Lifeline] Server restarting (attempt ${attempt})`);
    });

    this.loadOffset();
  }

  /**
   * Start the lifeline — begins Telegram polling and server supervision.
   */
  async start(): Promise<void> {
    console.log(pc.bold(`Starting Telegram Lifeline for ${pc.cyan(this.projectConfig.projectName)}`));
    console.log(`  Port: ${this.projectConfig.port}`);
    console.log(`  State: ${this.projectConfig.stateDir}`);
    console.log();

    // Acquire exclusive lock — prevent multiple lifeline instances
    if (!acquireLockFile(this.lockPath)) {
      console.error(pc.red('[Lifeline] Another lifeline instance is already running. Exiting.'));
      process.exit(0); // Clean exit — launchd will restart after ThrottleInterval, acting as a watchdog
    }

    // Register in agent registry (lifeline entry — uses project dir + "-lifeline" suffix)
    try {
      registerAgent(
        this.projectConfig.projectDir + '-lifeline',
        `${this.projectConfig.projectName}-lifeline`,
        this.projectConfig.port + 1000, // Lifeline uses port + 1000 to avoid conflict
      );
    } catch { /* non-critical */ }
    this.stopHeartbeat = startHeartbeat(this.projectConfig.projectDir + '-lifeline');

    // Ensure Lifeline topic exists (auto-recreate if deleted)
    this.lifelineTopicId = await this.ensureLifelineTopic();
    if (this.lifelineTopicId) {
      console.log(pc.green(`  Lifeline topic: ${this.lifelineTopicId}`));
    }

    // Start server supervisor
    const serverStarted = await this.supervisor.start();
    if (serverStarted) {
      console.log(pc.green('  Server supervisor active'));
    } else {
      console.log(pc.yellow('  Server failed to start — lifeline will keep trying'));
    }

    // Start Telegram polling
    this.polling = true;
    this.poll();
    console.log(pc.green('  Telegram polling active'));

    // Start periodic queue replay (in case server comes back between health checks)
    this.replayInterval = setInterval(() => {
      if (this.supervisor.healthy && this.queue.length > 0) {
        this.replayQueue();
      }
    }, 15_000);

    // Replay any messages queued from previous lifeline runs
    if (this.queue.length > 0) {
      console.log(`  ${this.queue.length} queued messages from previous run`);
      if (this.supervisor.healthy) {
        setTimeout(() => this.replayQueue(), 5000); // Wait for server to fully start
      }
    }

    // Self-healing: ensure autostart is installed so the lifeline persists across reboots.
    // The user must always be able to reach their agent remotely — this is non-negotiable.
    try {
      if (!this.isAutostartInstalled()) {
        // Dynamic import — setup.ts uses @inquirer/prompts which requires Node 20.12+
        const { installAutoStart } = await import('../commands/setup.js');
        const installed = installAutoStart(this.projectConfig.projectName, this.projectConfig.projectDir, true);
        if (installed) {
          console.log(pc.green(`  Auto-start self-healed: installed ${process.platform === 'darwin' ? 'LaunchAgent' : 'systemd service'}`));
        }
      }
    } catch {
      // Non-critical — don't crash the lifeline over autostart
    }

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nLifeline shutting down...');
      this.polling = false;
      if (this.pollTimeout) clearTimeout(this.pollTimeout);
      if (this.replayInterval) clearInterval(this.replayInterval);
      if (this.stopHeartbeat) this.stopHeartbeat();
      unregisterAgent(this.projectConfig.projectDir + '-lifeline');
      releaseLockFile(this.lockPath);
      await this.supervisor.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  // ── Telegram Polling ──────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.polling) return;

    try {
      const updates = await this.getUpdates();
      for (const update of updates) {
        await this.processUpdate(update);
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
      }
      if (updates.length > 0) this.saveOffset();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('401') || errMsg.includes('Unauthorized')) {
        console.error('[Lifeline] FATAL: Bot token invalid. Stopping.');
        this.polling = false;
        return;
      }
      // Non-fatal error — continue polling
      if (!errMsg.includes('abort')) {
        console.error(`[Lifeline] Poll error: ${errMsg}`);
      }
    }

    const interval = this.config.pollIntervalMs ?? 2000;
    this.pollTimeout = setTimeout(() => this.poll(), interval);
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;

    // Handle photo messages
    if (msg.photo && msg.photo.length > 0 && !msg.text) {
      await this.handlePhotoMessage(msg);
      return;
    }

    if (!msg.text) return;

    const topicId = msg.message_thread_id ?? 1;
    const text = msg.text;

    // Handle lifeline-specific commands directly (bypass server)
    if (text.startsWith('/lifeline')) {
      await this.handleLifelineCommand(text, topicId);
      return;
    }

    // Forward to server if healthy
    if (this.supervisor.healthy) {
      const forwarded = await this.forwardToServer(topicId, text, msg);
      if (forwarded) {
        // Delivery confirmation — user knows message reached the server
        await this.sendToTopic(topicId, '✓ Delivered');
        return;
      }
      // Server appears healthy but forward failed — queue with accurate message
      this.queue.enqueue({
        id: `tg-${msg.message_id}`,
        topicId,
        text,
        fromUserId: msg.from.id,
        fromUsername: msg.from.username,
        fromFirstName: msg.from.first_name,
        timestamp: new Date(msg.date * 1000).toISOString(),
      });
      await this.sendToTopic(topicId,
        `Server is restarting. Your message has been queued (${this.queue.length} in queue). It will be delivered when the server recovers.`
      );
      return;
    }

    // Server is down — queue the message
    this.queue.enqueue({
      id: `tg-${msg.message_id}`,
      topicId,
      text,
      fromUserId: msg.from.id,
      fromUsername: msg.from.username,
      fromFirstName: msg.from.first_name,
      timestamp: new Date(msg.date * 1000).toISOString(),
    });

    // Notify user that message is queued
    await this.sendToTopic(topicId,
      `Server is temporarily down. Your message has been queued (${this.queue.length} in queue). It will be delivered when the server recovers.`
    );
  }

  /**
   * Handle an incoming photo message: download it and forward/queue with [image:path] content.
   */
  private async handlePhotoMessage(
    msg: NonNullable<TelegramUpdate['message']>,
  ): Promise<void> {
    const topicId = msg.message_thread_id ?? 1;
    const photos = msg.photo!;
    const photo = photos[photos.length - 1]; // highest resolution
    const caption = msg.caption ?? '';

    let content: string;
    let photoPath: string | undefined;
    try {
      photoPath = await this.downloadPhoto(photo.file_id, msg.message_id);
      content = caption ? `[image:${photoPath}] ${caption}` : `[image:${photoPath}]`;
    } catch (err) {
      // Download failed — forward caption or placeholder so message isn't silently dropped
      content = caption ? `[image:download-failed] ${caption}` : '[image:download-failed]';
      console.error(`[lifeline] Failed to download photo: ${err}`);
    }

    if (this.supervisor.healthy) {
      const forwarded = await this.forwardToServer(topicId, content, msg);
      if (forwarded) {
        await this.sendToTopic(topicId, '✓ Delivered');
        return;
      }
    }

    // Queue the photo message (server down or forward failed)
    this.queue.enqueue({
      id: `tg-${msg.message_id}`,
      topicId,
      text: content,
      fromUserId: msg.from.id,
      fromUsername: msg.from.username,
      fromFirstName: msg.from.first_name,
      timestamp: new Date(msg.date * 1000).toISOString(),
      photoPath,
    });

    if (this.supervisor.healthy) {
      await this.sendToTopic(topicId,
        `Server is restarting. Your photo has been queued (${this.queue.length} in queue). It will be delivered when the server recovers.`
      );
    } else {
      await this.sendToTopic(topicId,
        `Server is temporarily down. Your photo has been queued (${this.queue.length} in queue). It will be delivered when the server recovers.`
      );
    }
  }

  /**
   * Download a photo from Telegram and save it to the state directory.
   */
  private async downloadPhoto(fileId: string, messageId: number): Promise<string> {
    // Get file path from Telegram
    const infoRes = await fetch(
      `https://api.telegram.org/bot${this.config.token}/getFile?file_id=${encodeURIComponent(fileId)}`
    );
    if (!infoRes.ok) throw new Error(`getFile failed: ${infoRes.status}`);
    const infoData = await infoRes.json() as { ok: boolean; result?: { file_path: string } };
    if (!infoData.ok || !infoData.result?.file_path) throw new Error('getFile returned no path');

    const filePath = infoData.result.file_path;
    const photoDir = path.join(this.projectConfig.stateDir, 'telegram-images');
    fs.mkdirSync(photoDir, { recursive: true });
    const filename = `photo-${Date.now()}-${messageId}.jpg`;
    const localPath = path.join(photoDir, filename);

    const fileRes = await fetch(
      `https://api.telegram.org/file/bot${this.config.token}/${filePath}`
    );
    if (!fileRes.ok) throw new Error(`File download failed: ${fileRes.status}`);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    fs.writeFileSync(localPath, buf);
    return localPath;
  }

  /**
   * Forward a message to the Instar server's Telegram webhook.
   */
  private async forwardToServer(
    topicId: number,
    text: string,
    rawMsg: NonNullable<TelegramUpdate['message']>,
  ): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(
          `http://127.0.0.1:${this.projectConfig.port}/internal/telegram-forward`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              topicId,
              text,
              fromUserId: rawMsg.from.id,
              fromUsername: rawMsg.from.username,
              fromFirstName: rawMsg.from.first_name,
              messageId: rawMsg.message_id,
              timestamp: new Date(rawMsg.date * 1000).toISOString(),
            }),
            signal: controller.signal,
          }
        );
        return response.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  // ── Lifeline Commands ─────────────────────────────────────

  private async handleLifelineCommand(text: string, topicId: number): Promise<void> {
    const cmd = text.trim().toLowerCase();

    if (cmd === '/lifeline' || cmd === '/lifeline status') {
      const status = this.supervisor.getStatus();
      const queueSize = this.queue.length;
      let serverLine = status.healthy ? '● healthy' : status.running ? '○ unhealthy' : '✗ down';
      if (status.coolingDown) {
        serverLine += ` (cooldown: ${Math.ceil(status.cooldownRemainingMs / 1000)}s)`;
      }
      const lines = [
        `Lifeline Status:`,
        `  Server: ${serverLine}`,
        `  Restart attempts: ${status.restartAttempts}`,
        `  Queued messages: ${queueSize}`,
        `  Last healthy: ${status.lastHealthy ? new Date(status.lastHealthy).toISOString().slice(11, 19) : 'never'}`,
      ];
      await this.sendToTopic(topicId, lines.join('\n'));
      return;
    }

    if (cmd === '/lifeline restart') {
      await this.sendToTopic(topicId, 'Restarting server...');
      await this.supervisor.stop();
      const started = await this.supervisor.start();
      await this.sendToTopic(topicId, started ? 'Server restarted.' : 'Server failed to restart.');
      return;
    }

    if (cmd === '/lifeline queue') {
      const messages = this.queue.peek();
      if (messages.length === 0) {
        await this.sendToTopic(topicId, 'No queued messages.');
        return;
      }
      const lines = messages.map((m, i) =>
        `${i + 1}. [${m.fromFirstName}] ${m.text.slice(0, 60)}${m.text.length > 60 ? '...' : ''}`
      );
      await this.sendToTopic(topicId, `Queued messages (${messages.length}):\n${lines.join('\n')}`);
      return;
    }

    if (cmd === '/lifeline help') {
      const lines = [
        'Lifeline Commands:',
        '  /lifeline — Show status',
        '  /lifeline restart — Restart the server',
        '  /lifeline queue — Show queued messages',
        '  /lifeline help — Show this help',
        '',
        'The lifeline keeps your Telegram connection alive even when the server is down.',
        'Messages sent while the server is down are queued and replayed on recovery.',
      ];
      await this.sendToTopic(topicId, lines.join('\n'));
      return;
    }

    await this.sendToTopic(topicId, 'Unknown lifeline command. Try /lifeline help');
  }

  // ── Queue Replay ──────────────────────────────────────────

  private async replayQueue(): Promise<void> {
    const messages = this.queue.drain();
    if (messages.length === 0) return;

    console.log(`[Lifeline] Replaying ${messages.length} queued messages`);
    let replayed = 0;
    let failed = 0;

    for (const msg of messages) {
      const forwarded = await this.forwardToServer(msg.topicId, msg.text, {
        message_id: parseInt(msg.id.replace('tg-', ''), 10) || 0,
        from: {
          id: msg.fromUserId,
          first_name: msg.fromFirstName,
          username: msg.fromUsername,
        },
        chat: { id: parseInt(this.config.chatId, 10) },
        message_thread_id: msg.topicId,
        text: msg.text,
        date: Math.floor(new Date(msg.timestamp).getTime() / 1000),
      });

      if (forwarded) {
        replayed++;
      } else {
        // Re-queue failed messages
        this.queue.enqueue(msg);
        failed++;
      }

      // Small delay between messages to avoid overwhelming the server
      await new Promise(r => setTimeout(r, 500));
    }

    if (replayed > 0 || failed > 0) {
      console.log(`[Lifeline] Replay complete: ${replayed} delivered, ${failed} re-queued`);
    }
  }

  // ── Notifications ─────────────────────────────────────────

  private async notifyServerDown(reason: string): Promise<void> {
    // Send to Lifeline topic if available, otherwise General
    const topicId = this.lifelineTopicId ?? 1;
    await this.sendToTopic(topicId,
      `Server went down: ${reason}\n\nYour messages will be queued until recovery. Use /lifeline status to check.`
    ).catch(() => {});
  }

  // ── Lifeline Topic ──────────────────────────────────────────

  /**
   * Check if OS-level autostart is installed for this project.
   */
  private isAutostartInstalled(): boolean {
    if (process.platform === 'darwin') {
      const label = `ai.instar.${this.projectConfig.projectName}`;
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      return fs.existsSync(plistPath);
    } else if (process.platform === 'linux') {
      const serviceName = `instar-${this.projectConfig.projectName}.service`;
      const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', serviceName);
      return fs.existsSync(servicePath);
    }
    return false;
  }

  /**
   * Ensure the Lifeline topic exists. Recreates if deleted.
   */
  private async ensureLifelineTopic(): Promise<number | null> {
    const existingId = this.config.lifelineTopicId;

    if (existingId) {
      // Verify it still exists
      try {
        await this.apiCall('sendMessage', {
          chat_id: this.config.chatId,
          message_thread_id: existingId,
          text: '🟢 Lifeline connected.',
        });
        return existingId;
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes('thread not found') || errStr.includes('TOPIC_DELETED') ||
            errStr.includes('TOPIC_CLOSED') || errStr.includes('not found')) {
          console.log(`[Lifeline] Topic ${existingId} was deleted — recreating`);
        } else {
          // Non-fatal error (network etc.) — assume it still exists
          console.warn(`[Lifeline] Topic check failed (non-fatal): ${err}`);
          return existingId;
        }
      }
    }

    // Create or recreate
    try {
      const result = await this.apiCall('createForumTopic', {
        chat_id: this.config.chatId,
        name: 'Lifeline',
        icon_color: 9367192, // green
      }) as { message_thread_id: number };

      const topicId = result.message_thread_id;
      this.config.lifelineTopicId = topicId;
      this.persistLifelineTopicId(topicId);
      console.log(`[Lifeline] ${existingId ? 'Recreated' : 'Created'} Lifeline topic: ${topicId}`);

      // Send welcome message in new topic
      await this.sendToTopic(topicId,
        '🟢 Lifeline connected. This topic is always available — even when the server is down.'
      );

      return topicId;
    } catch (err) {
      console.error(`[Lifeline] Failed to create Lifeline topic: ${err}`);
      return null;
    }
  }

  /**
   * Persist the Lifeline topic ID to config.json.
   */
  private persistLifelineTopicId(topicId: number): void {
    try {
      const configPath = path.join(this.projectConfig.projectDir, '.instar', 'config.json');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        if (Array.isArray(config.messaging)) {
          const entry = config.messaging.find(
            (m: { type: string }) => m.type === 'telegram'
          );
          if (entry?.config) {
            entry.config.lifelineTopicId = topicId;
            const tmpPath = `${configPath}.${process.pid}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
            fs.renameSync(tmpPath, configPath);
          }
        }
      }
    } catch (err) {
      console.warn(`[Lifeline] Failed to persist lifelineTopicId: ${err}`);
    }
  }

  // ── Telegram API ──────────────────────────────────────────

  private async sendToTopic(topicId: number, text: string): Promise<void> {
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text,
    };
    if (topicId > 1) {
      params.message_thread_id = topicId;
    }

    try {
      await this.apiCall('sendMessage', { ...params, parse_mode: 'Markdown' });
    } catch {
      // Retry without Markdown parse mode
      try {
        await this.apiCall('sendMessage', params);
      } catch (err) {
        console.error(`[Lifeline] Failed to send to topic ${topicId}: ${err}`);
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const result = await this.apiCall('getUpdates', {
      offset: this.lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message'],
    });
    return (result as TelegramUpdate[]) ?? [];
  }

  private async apiCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const url = `https://api.telegram.org/bot${this.config.token}/${method}`;
    const timeoutMs = method === 'getUpdates' ? 60_000 : 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Telegram API error (${response.status}): ${text}`);
    }

    const data = await response.json() as { ok: boolean; result: unknown };
    if (!data.ok) {
      throw new Error(`Telegram API returned not ok: ${JSON.stringify(data)}`);
    }

    return data.result;
  }

  // ── Offset Persistence ────────────────────────────────────

  private loadOffset(): void {
    try {
      if (fs.existsSync(this.offsetPath)) {
        const data = JSON.parse(fs.readFileSync(this.offsetPath, 'utf-8'));
        if (typeof data.lastUpdateId === 'number' && data.lastUpdateId > 0) {
          this.lastUpdateId = data.lastUpdateId;
        }
      }
    } catch { /* start from 0 */ }
  }

  private saveOffset(): void {
    try {
      const tmpPath = `${this.offsetPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ lastUpdateId: this.lastUpdateId }));
      fs.renameSync(tmpPath, this.offsetPath);
    } catch { /* non-critical */ }
  }
}
