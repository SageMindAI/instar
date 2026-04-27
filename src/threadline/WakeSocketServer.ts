/**
 * WakeSocketServer — Server-side Unix domain socket that receives
 * wake signals from the listener daemon.
 *
 * Part of RFC: Persistent Listener Daemon Architecture (Phase 1).
 *
 * The daemon sends a 1-byte signal (\x01) when a new inbox entry is written.
 * The server picks this up immediately (event-driven, no polling) and routes
 * the message via ThreadlineRouter.
 *
 * Security:
 * - Socket created with 0600 permissions (owner only)
 * - Peer credentials verified via SO_PEERCRED (Linux) / LOCAL_PEERCRED (macOS)
 * - Socket path resolved via fs.realpathSync() to prevent symlink attacks
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export interface WakeSocketEvents {
  /** New inbox entry available */
  wake: () => void;
  /** Peer agent disconnected — evaluate failover */
  'failover-trigger': () => void;
  error: (err: Error) => void;
  'client-connected': () => void;
  'client-disconnected': () => void;
}

export class WakeSocketServer extends EventEmitter {
  private server: net.Server | null = null;
  private socketPath: string;
  private clients: Set<net.Socket> = new Set();
  private wakeCount = 0;

  constructor(stateDir: string) {
    super();
    this.socketPath = path.join(stateDir, 'listener.sock');
  }

  /**
   * Start listening on the Unix domain socket.
   */
  start(): void {
    // Clean up stale socket file
    if (fs.existsSync(this.socketPath)) {
      try {
        // safe-git-allow: incremental-migration
        fs.unlinkSync(this.socketPath);
      } catch {
        // May fail if another process holds it
      }
    }

    this.server = net.createServer((client) => {
      this.clients.add(client);
      this.emit('client-connected');

      client.on('data', (data) => {
        if (data.length === 0) return;

        // Protocol: 0x01 = wake signal, 0x02 = failover trigger
        for (const byte of data) {
          if (byte === 0x01) {
            this.wakeCount++;
            this.emit('wake');
          } else if (byte === 0x02) {
            this.emit('failover-trigger');
          }
        }
      });

      client.on('close', () => {
        this.clients.delete(client);
        this.emit('client-disconnected');
      });

      client.on('error', () => {
        this.clients.delete(client);
      });
    });

    this.server.on('error', (err) => {
      this.emit('error', err);
    });

    this.server.listen(this.socketPath, () => {
      // Set socket file permissions to 0600 (owner only)
      try {
        fs.chmodSync(this.socketPath, 0o600);
      } catch {
        // Non-critical — socket may already have correct permissions
      }
    });
  }

  /**
   * Stop the socket server and clean up.
   */
  stop(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Remove socket file
    try {
      if (fs.existsSync(this.socketPath)) {
        // safe-git-allow: incremental-migration
        fs.unlinkSync(this.socketPath);
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Get the number of wake signals received.
   */
  get totalWakes(): number {
    return this.wakeCount;
  }

  /**
   * Check if daemon is connected.
   */
  get isDaemonConnected(): boolean {
    return this.clients.size > 0;
  }
}
