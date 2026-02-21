/**
 * Cloudflare Tunnel manager for Instar agents.
 *
 * Manages cloudflared tunnel lifecycle — quick tunnels (zero-config,
 * ephemeral) and named tunnels (persistent, custom domain).
 *
 * Quick tunnels require no Cloudflare account. Named tunnels require
 * a tunnel token from the Cloudflare dashboard.
 *
 * The tunnel exposes the agent's local HTTP server to the internet,
 * enabling:
 *   - Private content viewing (auth-gated rendered markdown)
 *   - Remote API access from anywhere
 *   - File serving (logs, reports, exports)
 *   - Webhook endpoints for external integrations
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { bin, install, Tunnel } from 'cloudflared';

// ── Types ──────────────────────────────────────────────────────────

export interface TunnelConfig {
  /** Whether tunnel is enabled */
  enabled: boolean;
  /** Tunnel type: 'quick' (ephemeral, no account) or 'named' (persistent, requires token) */
  type: 'quick' | 'named';
  /** Cloudflare tunnel token (required for named tunnels) */
  token?: string;
  /** Local port to tunnel to */
  port: number;
  /** State directory for persisting tunnel info */
  stateDir: string;
}

export interface TunnelState {
  /** Current tunnel URL (null if not connected) */
  url: string | null;
  /** Tunnel type */
  type: 'quick' | 'named';
  /** When the tunnel was started */
  startedAt: string | null;
  /** Connection info from cloudflared */
  connectionId?: string;
  /** Connection location */
  connectionLocation?: string;
}

export interface TunnelEvents {
  url: (url: string) => void;
  connected: (info: { id: string; ip: string; location: string }) => void;
  disconnected: () => void;
  error: (error: Error) => void;
  stopped: () => void;
}

// ── Manager ────────────────────────────────────────────────────────

export class TunnelManager extends EventEmitter {
  private config: TunnelConfig;
  private tunnel: Tunnel | null = null;
  private stateFile: string;
  private _state: TunnelState;
  private _stopped = false;

  constructor(config: TunnelConfig) {
    super();
    this.config = config;
    this.stateFile = path.join(config.stateDir, 'tunnel.json');
    this._state = {
      url: null,
      type: config.type,
      startedAt: null,
    };
  }

  /** Current tunnel URL, or null if not connected */
  get url(): string | null {
    return this._state.url;
  }

  /** Whether the tunnel is currently running */
  get isRunning(): boolean {
    return this.tunnel !== null && !this._stopped;
  }

  /** Current tunnel state */
  get state(): TunnelState {
    return { ...this._state };
  }

  /**
   * Start the tunnel. Ensures the cloudflared binary is installed,
   * then starts the appropriate tunnel type.
   */
  async start(): Promise<string> {
    if (this.tunnel) {
      throw new Error('Tunnel is already running');
    }

    this._stopped = false;

    // Ensure cloudflared binary is installed
    await this.ensureBinary();

    // Start the appropriate tunnel type
    if (this.config.type === 'named') {
      if (!this.config.token) {
        throw new Error('Named tunnel requires a token. Set tunnel.token in config.');
      }
      return this.startNamedTunnel();
    } else {
      return this.startQuickTunnel();
    }
  }

  /**
   * Stop the tunnel gracefully.
   */
  async stop(): Promise<void> {
    this._stopped = true;
    if (this.tunnel) {
      this.tunnel.stop();
      this.tunnel = null;
    }
    this._state.url = null;
    this._state.startedAt = null;
    this.saveState();
    this.emit('stopped');
  }

  /**
   * Get the full external URL for a local path.
   * Returns null if tunnel is not connected.
   */
  getExternalUrl(localPath: string): string | null {
    if (!this._state.url) return null;
    const base = this._state.url.replace(/\/$/, '');
    const p = localPath.startsWith('/') ? localPath : `/${localPath}`;
    return `${base}${p}`;
  }

  // ── Internal ───────────────────────────────────────────────────

  private async ensureBinary(): Promise<void> {
    if (!fs.existsSync(bin)) {
      await install(bin);
    }
  }

  private startQuickTunnel(): Promise<string> {
    return new Promise((resolve, reject) => {
      const localUrl = `http://127.0.0.1:${this.config.port}`;

      try {
        // Write an empty config to prevent cloudflared from loading
        // ~/.cloudflared/config.yml, which may contain named tunnel
        // ingress rules that override the quick tunnel's --url proxy.
        const emptyConfig = path.join(this.config.stateDir, 'cloudflared-quick.yml');
        const dir = path.dirname(emptyConfig);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(emptyConfig, '# Quick tunnel — no ingress rules\n');
        this.tunnel = Tunnel.quick(localUrl, { '--config': emptyConfig });
      } catch (err) {
        reject(new Error(`Failed to start quick tunnel: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Tunnel connection timed out after 30 seconds'));
        }
      }, 30_000);

      this.tunnel.once('url', (url: string) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);

        this._state.url = url;
        this._state.startedAt = new Date().toISOString();
        this.saveState();
        this.emit('url', url);
        resolve(url);
      });

      this.tunnel.once('connected', (info: { id: string; ip: string; location: string }) => {
        this._state.connectionId = info.id;
        this._state.connectionLocation = info.location;
        this.saveState();
        this.emit('connected', info);
      });

      this.tunnel.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
        this.emit('error', err);
      });

      this.tunnel.on('exit', (code: number | null) => {
        if (!this._stopped) {
          this._state.url = null;
          this.saveState();
          this.emit('disconnected');
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error(`Tunnel process exited with code ${code}`));
          }
        }
      });
    });
  }

  private startNamedTunnel(): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        this.tunnel = Tunnel.withToken(this.config.token!);
      } catch (err) {
        reject(new Error(`Failed to start named tunnel: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Named tunnel connection timed out after 30 seconds'));
        }
      }, 30_000);

      this.tunnel.once('url', (url: string) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);

        this._state.url = url;
        this._state.startedAt = new Date().toISOString();
        this.saveState();
        this.emit('url', url);
        resolve(url);
      });

      this.tunnel.once('connected', (info: { id: string; ip: string; location: string }) => {
        this._state.connectionId = info.id;
        this._state.connectionLocation = info.location;
        this.saveState();
        this.emit('connected', info);

        // For named tunnels, the URL may come from the connection info
        // rather than the 'url' event, since the URL is pre-configured
        if (!resolved && this._state.url) {
          resolved = true;
          clearTimeout(timeout);
          resolve(this._state.url);
        }
      });

      this.tunnel.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
        this.emit('error', err);
      });

      this.tunnel.on('exit', (code: number | null) => {
        if (!this._stopped) {
          this._state.url = null;
          this.saveState();
          this.emit('disconnected');
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error(`Named tunnel process exited with code ${code}`));
          }
        }
      });
    });
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFile, JSON.stringify(this._state, null, 2));
    } catch {
      // Non-critical — don't crash if state save fails
    }
  }
}
