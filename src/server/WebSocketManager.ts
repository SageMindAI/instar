/**
 * WebSocket Manager — real-time terminal streaming for the dashboard.
 *
 * Handles client subscriptions to tmux sessions, streams terminal output
 * via diff-based updates, and forwards input to sessions.
 *
 * Protocol (JSON messages):
 *
 * Client → Server:
 *   { type: 'subscribe', session: 'session-name' }
 *   { type: 'unsubscribe', session: 'session-name' }
 *   { type: 'history', session: 'session-name', lines: 5000 }
 *   { type: 'input', session: 'session-name', text: 'some input' }
 *   { type: 'key', session: 'session-name', key: 'C-c' }
 *   { type: 'ping' }
 *
 * Server → Client:
 *   { type: 'output', session: 'session-name', data: '...terminal output...' }
 *   { type: 'history', session: 'session-name', data: '...', lines: N }
 *   { type: 'sessions', sessions: [...] }
 *   { type: 'session_ended', session: 'session-name' }
 *   { type: 'subscribed', session: 'session-name' }
 *   { type: 'unsubscribed', session: 'session-name' }
 *   { type: 'input_ack', session: 'session-name', success: true }
 *   { type: 'pong' }
 *   { type: 'error', message: '...' }
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { HookEventReceiver } from '../monitoring/HookEventReceiver.js';

interface ClientState {
  ws: WebSocket;
  subscriptions: Set<string>;
  isAlive: boolean;
}

export class WebSocketManager {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, ClientState> = new Map();
  private sessionOutputCache: Map<string, string> = new Map();
  private streamInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sessionBroadcastInterval: ReturnType<typeof setInterval> | null = null;
  private sessionManager: SessionManager;
  private state: StateManager;
  private authToken?: string;
  private registryPath?: string;
  private hookEventReceiver?: HookEventReceiver;

  constructor(options: {
    server: HttpServer;
    sessionManager: SessionManager;
    state: StateManager;
    authToken?: string;
    instarDir?: string;
    hookEventReceiver?: HookEventReceiver;
  }) {
    this.sessionManager = options.sessionManager;
    this.state = options.state;
    this.authToken = options.authToken;
    this.hookEventReceiver = options.hookEventReceiver;
    if (options.instarDir) {
      this.registryPath = path.join(options.instarDir, 'topic-session-registry.json');
    }

    this.wss = new WebSocketServer({
      noServer: true,
    });

    // Handle upgrade manually for auth
    options.server.on('upgrade', (request, socket, head) => {
      // Only handle /ws path
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      // Authenticate via query param or header
      if (this.authToken && !this.authenticate(request, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws) => {
      const client: ClientState = {
        ws,
        subscriptions: new Set(),
        isAlive: true,
      };
      this.clients.set(ws, client);

      // Send initial session list
      this.sendSessionList(ws);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(client, msg);
        } catch {
          this.send(ws, { type: 'error', message: 'Invalid JSON' });
        }
      });

      ws.on('pong', () => {
        client.isAlive = true;
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });

    // Start streaming terminal output to subscribers
    this.startStreaming();

    // Heartbeat to detect dead connections
    this.heartbeatInterval = setInterval(() => {
      for (const [ws, client] of this.clients) {
        if (!client.isAlive) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        client.isAlive = false;
        ws.ping();
      }
    }, 30_000);
    this.heartbeatInterval.unref();

    // Broadcast session list periodically
    this.sessionBroadcastInterval = setInterval(() => {
      this.broadcastSessionList();
    }, 5_000);
    this.sessionBroadcastInterval.unref();
  }

  private authenticate(request: IncomingMessage, url: URL): boolean {
    if (!this.authToken) return true;

    // Check query param first (for browser WebSocket which can't set headers)
    const tokenParam = url.searchParams.get('token');
    if (tokenParam && this.verifyToken(tokenParam)) return true;

    // Check Authorization header
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7);
      if (this.verifyToken(token)) return true;
    }

    return false;
  }

  private verifyToken(token: string): boolean {
    if (!this.authToken) return true;
    const ha = createHash('sha256').update(token).digest();
    const hb = createHash('sha256').update(this.authToken).digest();
    return timingSafeEqual(ha, hb);
  }

  private handleMessage(client: ClientState, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'subscribe': {
        const session = String(msg.session || '');
        if (!session) {
          this.send(client.ws, { type: 'error', message: 'Missing session name' });
          return;
        }
        client.subscriptions.add(session);
        // Send current output immediately — use large capture for initial load
        const output = this.sessionManager.captureOutput(session, 2000);
        if (output) {
          this.sessionOutputCache.set(`${this.clientId(client)}:${session}`, output);
          this.send(client.ws, { type: 'output', session, data: output });
        }
        this.send(client.ws, { type: 'subscribed', session });
        break;
      }

      case 'unsubscribe': {
        const session = String(msg.session || '');
        client.subscriptions.delete(session);
        this.sessionOutputCache.delete(`${this.clientId(client)}:${session}`);
        this.send(client.ws, { type: 'unsubscribed', session });
        break;
      }

      case 'input': {
        const session = String(msg.session || '');
        const text = String(msg.text || '');
        if (!session || !text) {
          this.send(client.ws, { type: 'error', message: 'Missing session or text' });
          return;
        }
        const success = this.sessionManager.sendInput(session, text);
        this.send(client.ws, { type: 'input_ack', session, success });
        break;
      }

      case 'key': {
        const session = String(msg.session || '');
        const key = String(msg.key || '');
        if (!session || !key) {
          this.send(client.ws, { type: 'error', message: 'Missing session or key' });
          return;
        }
        const success = this.sessionManager.sendKey(session, key);
        this.send(client.ws, { type: 'input_ack', session, success });
        break;
      }

      case 'history': {
        const session = String(msg.session || '');
        const rawLines = parseInt(String(msg.lines || '5000'), 10);
        const lines = Math.min(Math.max(rawLines, 1), 50_000);
        if (!session) {
          this.send(client.ws, { type: 'error', message: 'Missing session name' });
          return;
        }
        const historyOutput = this.sessionManager.captureOutput(session, lines);
        if (historyOutput) {
          // Update the cache so streaming doesn't immediately overwrite with fewer lines
          this.sessionOutputCache.set(`${this.clientId(client)}:${session}`, historyOutput);
          this.send(client.ws, { type: 'history', session, data: historyOutput, lines });
        } else {
          this.send(client.ws, { type: 'error', message: `No output for session "${session}"` });
        }
        break;
      }

      case 'ping':
        this.send(client.ws, { type: 'pong' });
        break;

      default:
        this.send(client.ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  }

  /**
   * Stream terminal output to subscribed clients.
   * Uses diff-based approach: only sends new content since last capture.
   */
  private startStreaming(): void {
    this.streamInterval = setInterval(() => {
      // Collect all unique session subscriptions across clients
      const subscribedSessions = new Set<string>();
      for (const client of this.clients.values()) {
        for (const session of client.subscriptions) {
          subscribedSessions.add(session);
        }
      }

      // Capture output for each subscribed session
      for (const session of subscribedSessions) {
        const output = this.sessionManager.captureOutput(session, 2000);

        // Broadcast to each subscribed client
        for (const [, client] of this.clients) {
          if (!client.subscriptions.has(session)) continue;

          const cacheKey = `${this.clientId(client)}:${session}`;
          const cached = this.sessionOutputCache.get(cacheKey);

          if (output === null) {
            // Session may have ended
            if (cached !== undefined) {
              this.send(client.ws, { type: 'session_ended', session });
              this.sessionOutputCache.delete(cacheKey);
            }
            continue;
          }

          // Only send if output changed
          if (output !== cached) {
            this.sessionOutputCache.set(cacheKey, output);
            this.send(client.ws, { type: 'output', session, data: output });
          }
        }
      }
    }, 500);
    this.streamInterval.unref();
  }

  /**
   * Resolve display names by cross-referencing the topic-session registry.
   * Maps tmux session names to their Telegram topic names.
   */
  private getTopicDisplayNames(): Map<string, string> {
    const map = new Map<string, string>();
    if (!this.registryPath) return map;
    try {
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      const topicToSession: Record<string, string> = data.topicToSession || {};
      const topicToName: Record<string, string> = data.topicToName || {};
      // Build reverse map: tmux session name → topic display name
      for (const [topicId, tmuxSession] of Object.entries(topicToSession)) {
        const name = topicToName[topicId];
        if (name) {
          map.set(tmuxSession, name);
        }
      }
    } catch {
      // Registry missing or corrupt — skip
    }
    return map;
  }

  private buildSessionList() {
    const running = this.sessionManager.listRunningSessions();
    const displayNames = this.getTopicDisplayNames();
    return running.map(s => {
      const base: Record<string, unknown> = {
        id: s.id,
        name: displayNames.get(s.tmuxSession) || s.name,
        tmuxSession: s.tmuxSession,
        status: s.status,
        startedAt: s.startedAt,
        jobSlug: s.jobSlug,
        model: s.model,
        type: s.jobSlug ? 'job' : 'interactive',
      };

      // Enrich with hook event telemetry when available
      if (this.hookEventReceiver) {
        const summary = this.hookEventReceiver.getSessionSummary(s.tmuxSession);
        if (summary) {
          base.telemetry = {
            eventCount: summary.eventCount,
            toolsUsed: summary.toolsUsed,
            subagentsSpawned: summary.subagentsSpawned,
            lastActivity: summary.lastEvent,
          };
        }
      }

      return base;
    });
  }

  private sendSessionList(ws: WebSocket): void {
    const sessions = this.buildSessionList();
    this.send(ws, { type: 'sessions', sessions });
  }

  /**
   * Broadcast a custom event to all connected dashboard clients.
   * Used by PasteManager for paste_delivered / paste_acknowledged events.
   */
  broadcastEvent(event: Record<string, unknown>): void {
    // Notify in-process subscribers BEFORE the WebSocket fan-out so a
    // listener (e.g. the Layer 3 DeliveryFailureSentinel) reacts even
    // when no dashboard clients are connected. The sentinel does not
    // need a live WebSocket — it needs the event itself.
    for (const fn of this.eventSubscribers) {
      try {
        fn(event);
      } catch (err) {
        console.warn('[ws] in-process event subscriber threw:', err);
      }
    }
    if (this.clients.size === 0) return;
    const msg = JSON.stringify(event);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  /**
   * Register an in-process subscriber for events broadcast through this
   * manager. Returns an unsubscribe handle.
   *
   * Used by the Layer 3 DeliveryFailureSentinel to receive
   * `delivery_failed` events emitted by the script-side detector
   * (Layer 2c). The sentinel reacts in <1s rather than waiting for
   * its 5-minute watchdog tick.
   */
  private eventSubscribers = new Set<(event: Record<string, unknown>) => void>();
  subscribeEvents(fn: (event: Record<string, unknown>) => void): () => void {
    this.eventSubscribers.add(fn);
    return () => {
      this.eventSubscribers.delete(fn);
    };
  }

  private broadcastSessionList(): void {
    if (this.clients.size === 0) return;
    const sessions = this.buildSessionList();
    const msg = JSON.stringify({ type: 'sessions', sessions });
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  private clientId(client: ClientState): string {
    // Use object identity via a WeakRef-friendly approach
    return String((client.ws as unknown as { _socket?: { remotePort?: number } })._socket?.remotePort || Math.random());
  }

  private send(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Graceful shutdown — close all connections and stop intervals.
   */
  shutdown(): void {
    if (this.streamInterval) clearInterval(this.streamInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.sessionBroadcastInterval) clearInterval(this.sessionBroadcastInterval);

    for (const [ws] of this.clients) {
      ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.wss.close();
  }
}
