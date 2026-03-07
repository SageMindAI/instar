/**
 * Platform-agnostic stall detection and promise tracking.
 *
 * Extracted from TelegramAdapter as part of Phase 1 shared infrastructure.
 * Monitors message injection timestamps and detects when sessions
 * fail to respond within configured timeouts.
 */

export interface PendingMessage {
  channelId: string;
  sessionName: string;
  messageText: string;
  injectedAt: number; // Date.now()
  alerted: boolean;
}

export interface PendingPromise {
  channelId: string;
  sessionName: string;
  promiseText: string;
  promisedAt: number;
  alerted: boolean;
}

export interface StallEvent {
  type: 'stall' | 'promise-expired';
  channelId: string;
  sessionName: string;
  messageText: string;
  injectedAt: number;
  minutesElapsed: number;
}

export interface StallDetectorConfig {
  /** Minutes before a message is considered stalled (0 to disable) */
  stallTimeoutMinutes?: number;
  /** Minutes before a promise is considered expired (0 to disable) */
  promiseTimeoutMinutes?: number;
  /** Interval in ms between stall checks (default: 30000) */
  checkIntervalMs?: number;
}

/** Callback to check if a session is still running */
export type IsSessionAliveCheck = (sessionName: string) => boolean;

/** Callback to check if a session is actively producing output */
export type IsSessionActiveCheck = (sessionName: string) => Promise<boolean>;

/** Called when a stall or expired promise is detected */
export type OnStallCallback = (event: StallEvent, sessionAlive: boolean) => Promise<void>;

export class StallDetector {
  private pendingMessages: Map<string, PendingMessage> = new Map();
  private pendingPromises: Map<string, PendingPromise> = new Map();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private stallTimeoutMs: number;
  private promiseTimeoutMs: number;
  private checkIntervalMs: number;

  private isSessionAlive: IsSessionAliveCheck | null = null;
  private isSessionActive: IsSessionActiveCheck | null = null;
  private onStall: OnStallCallback | null = null;

  constructor(config: StallDetectorConfig = {}) {
    const stallMinutes = config.stallTimeoutMinutes ?? 5;
    const promiseMinutes = config.promiseTimeoutMinutes ?? 10;
    this.stallTimeoutMs = stallMinutes * 60 * 1000;
    this.promiseTimeoutMs = promiseMinutes * 60 * 1000;
    this.checkIntervalMs = config.checkIntervalMs ?? 30_000;
  }

  /** Set callback to check session liveness */
  setIsSessionAlive(check: IsSessionAliveCheck | null): void {
    this.isSessionAlive = check;
  }

  /** Set callback to check session activity */
  setIsSessionActive(check: IsSessionActiveCheck | null): void {
    this.isSessionActive = check;
  }

  /** Set callback for stall events */
  setOnStall(callback: OnStallCallback | null): void {
    this.onStall = callback;
  }

  /** Start periodic stall checking */
  start(): void {
    if (this.stallTimeoutMs <= 0 && this.promiseTimeoutMs <= 0) return;
    if (this.checkInterval) return;
    this.checkInterval = setInterval(() => this.check(), this.checkIntervalMs);
  }

  /** Stop periodic stall checking */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /** Track that a message was injected into a session */
  trackMessageInjection(channelId: string, sessionName: string, messageText: string): void {
    const key = `${channelId}-${Date.now()}`;
    this.pendingMessages.set(key, {
      channelId,
      sessionName,
      messageText: messageText.slice(0, 100),
      injectedAt: Date.now(),
      alerted: false,
    });
  }

  /** Clear stall tracking for a channel (agent responded) */
  clearStallForChannel(channelId: string): void {
    for (const [key, pending] of this.pendingMessages) {
      if (pending.channelId === channelId) {
        this.pendingMessages.delete(key);
      }
    }
  }

  /** Clear promise tracking for a channel */
  clearPromiseForChannel(channelId: string): void {
    this.pendingPromises.delete(channelId);
  }

  /** Track an outbound message for promise detection */
  trackOutboundMessage(channelId: string, sessionName: string, text: string): void {
    if (this.isPromiseMessage(text)) {
      this.pendingPromises.set(channelId, {
        channelId,
        sessionName,
        promiseText: text.slice(0, 100),
        promisedAt: Date.now(),
        alerted: false,
      });
    } else if (this.pendingPromises.has(channelId) && this.isFollowThroughMessage(text)) {
      this.pendingPromises.delete(channelId);
    }
  }

  /** Get current stall/promise counts for health status */
  getStatus(): { pendingStalls: number; pendingPromises: number } {
    return {
      pendingStalls: this.pendingMessages.size,
      pendingPromises: this.pendingPromises.size,
    };
  }

  /** Detect "work-in-progress" messages that imply the agent will follow up */
  isPromiseMessage(text: string): boolean {
    const promisePatterns = [
      /give me (?:a )?(?:couple|few|some) (?:more )?minutes/i,
      /give me (?:a )?(?:minute|moment|second|sec)/i,
      /working on (?:it|this|that)/i,
      /looking into (?:it|this|that)/i,
      /let me (?:check|look|investigate|dig|research)/i,
      /investigating/i,
      /still (?:on it|working|looking)/i,
      /one moment/i,
      /be right back/i,
      /hang on/i,
      /bear with me/i,
      /i'll (?:get back|follow up|check|look into)/i,
      /narrowing (?:it |this |that )?down/i,
    ];
    return promisePatterns.some(p => p.test(text));
  }

  /** Detect messages that indicate the agent delivered on its promise */
  isFollowThroughMessage(text: string): boolean {
    if (text.length > 200) return true;

    const completionPatterns = [
      /here(?:'s| is| are) (?:what|the)/i,
      /i found/i,
      /the (?:issue|problem|bug|fix|solution|answer|result)/i,
      /done|completed|finished|resolved/i,
      /summary|overview|analysis/i,
    ];
    return completionPatterns.some(p => p.test(text));
  }

  /** Run stall/promise checks (called periodically by interval) */
  async check(): Promise<void> {
    const now = Date.now();

    // Check for stalled messages
    if (this.stallTimeoutMs > 0) {
      for (const [key, pending] of this.pendingMessages) {
        if (pending.alerted) continue;
        if (now - pending.injectedAt < this.stallTimeoutMs) continue;

        const alive = this.isSessionAlive
          ? this.isSessionAlive(pending.sessionName)
          : true;

        // Verify session is truly stalled
        if (alive && this.isSessionActive) {
          try {
            const active = await this.isSessionActive(pending.sessionName);
            if (active) {
              this.pendingMessages.delete(key);
              continue;
            }
          } catch {
            // Verifier failed — fall through to alert
          }
        }

        pending.alerted = true;
        const minutesElapsed = Math.round((now - pending.injectedAt) / 60000);

        if (this.onStall) {
          try {
            await this.onStall({
              type: 'stall',
              channelId: pending.channelId,
              sessionName: pending.sessionName,
              messageText: pending.messageText,
              injectedAt: pending.injectedAt,
              minutesElapsed,
            }, alive);
          } catch (err) {
            console.error(`[stall-detector] Stall callback error for ${pending.channelId}: ${err}`);
          }
        }
      }
    }

    // Check for expired promises
    if (this.promiseTimeoutMs > 0) {
      for (const [channelId, promise] of this.pendingPromises) {
        if (promise.alerted) continue;
        if (now - promise.promisedAt < this.promiseTimeoutMs) continue;

        promise.alerted = true;
        const minutesElapsed = Math.round((now - promise.promisedAt) / 60000);

        const alive = this.isSessionAlive
          ? this.isSessionAlive(promise.sessionName)
          : true;

        if (this.onStall) {
          try {
            await this.onStall({
              type: 'promise-expired',
              channelId: promise.channelId,
              sessionName: promise.sessionName,
              messageText: promise.promiseText,
              injectedAt: promise.promisedAt,
              minutesElapsed,
            }, alive);
          } catch (err) {
            console.error(`[stall-detector] Promise callback error for ${promise.channelId}: ${err}`);
          }
        }
      }

      // Clean up old promise entries
      for (const [channelId, promise] of this.pendingPromises) {
        if (promise.alerted && now - promise.promisedAt > 60 * 60 * 1000) {
          this.pendingPromises.delete(channelId);
        }
      }
    }

    // Clean up old stall entries
    for (const [key, pending] of this.pendingMessages) {
      if (pending.alerted && now - pending.injectedAt > 30 * 60 * 1000) {
        this.pendingMessages.delete(key);
      }
    }
  }
}
