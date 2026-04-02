/**
 * SessionMonitor — Proactive session health monitoring.
 *
 * Unlike StallTriageNurse (reactive — triggers on unanswered messages) or
 * SessionWatchdog (reactive — triggers on stuck bash commands), the
 * SessionMonitor is PROACTIVE: it periodically checks all active sessions
 * and ensures users experience the responsiveness they'd expect.
 *
 * Responsibilities:
 * 1. Detect idle sessions (no tmux output changes for extended periods)
 * 2. Track session responsiveness (time between user message and agent reply)
 * 3. Send proactive health updates to users (not overbearing)
 * 4. Coordinate with StallTriageNurse for recovery when issues are found
 *
 * Design principle: Responsive and informative but not overbearing.
 * One update per issue per session — not a stream of "still checking" messages.
 */

import { EventEmitter } from 'events';
import type { SessionRecovery, RecoveryResult } from './SessionRecovery.js';

export interface SessionMonitorConfig {
  /** Enable the session monitor (default: true) */
  enabled?: boolean;
  /** How often to check sessions, in seconds (default: 60) */
  pollIntervalSec?: number;
  /** Minutes of inactivity before a session is flagged as idle (default: 15) */
  idleThresholdMinutes?: number;
  /** Minimum minutes between user notifications per topic (default: 30) */
  notificationCooldownMinutes?: number;
}

interface SessionSnapshot {
  sessionName: string;
  topicId: number;
  lastOutput: string;
  lastOutputAt: number;
  lastUserMessageAt: number;
  lastAgentMessageAt: number;
  notifiedAt: number | null;
  status: 'healthy' | 'idle' | 'unresponsive' | 'dead';
}

export interface SessionMonitorEvents {
  'monitor:idle-detected': { topicId: number; sessionName: string; idleMinutes: number };
  'monitor:unresponsive': { topicId: number; sessionName: string; waitMinutes: number };
  'monitor:recovery-triggered': { topicId: number; sessionName: string; reason: string };
  'monitor:mechanical-recovery': { topicId: number; sessionName: string; result: RecoveryResult };
  'monitor:user-notified': { topicId: number; message: string };
}

export interface SessionMonitorDeps {
  /** Get all active topic-to-session mappings */
  getActiveTopicSessions: () => Map<number, string>;
  /** Capture tmux output for a session */
  captureSessionOutput: (sessionName: string, lines: number) => string | null;
  /** Check if a session is alive */
  isSessionAlive: (sessionName: string) => boolean;
  /** Get recent messages for a topic */
  getTopicHistory: (topicId: number, limit: number) => Array<{ text: string; fromUser: boolean; timestamp: string }>;
  /** Send a message to a topic */
  sendToTopic: (topicId: number, text: string) => Promise<any>;
  /** Trigger triage recovery for a session */
  triggerTriage?: (topicId: number, sessionName: string, reason: string) => Promise<{ resolved: boolean }>;
  /** Optional mechanical recovery layer — runs before LLM triage */
  sessionRecovery?: SessionRecovery;
}

const DEFAULT_CONFIG: Required<SessionMonitorConfig> = {
  enabled: true,
  pollIntervalSec: 60,
  idleThresholdMinutes: 15,
  notificationCooldownMinutes: 30,
};

export class SessionMonitor extends EventEmitter {
  private config: Required<SessionMonitorConfig>;
  private deps: SessionMonitorDeps;
  private snapshots = new Map<number, SessionSnapshot>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: SessionMonitorDeps, config?: Partial<SessionMonitorConfig>) {
    super();
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Typed Events ────────────────────────────────────────
  override emit<K extends keyof SessionMonitorEvents>(event: K, data: SessionMonitorEvents[K]): boolean {
    return super.emit(event, data);
  }
  override on<K extends keyof SessionMonitorEvents>(event: K, listener: (data: SessionMonitorEvents[K]) => void): this {
    return super.on(event, listener);
  }

  // ── Public API ──────────────────────────────────────────
  start(): void {
    if (!this.config.enabled || this.interval) return;
    console.log(`[SessionMonitor] Starting (poll: ${this.config.pollIntervalSec}s, idle: ${this.config.idleThresholdMinutes}m)`);
    this.interval = setInterval(() => this.poll(), this.config.pollIntervalSec * 1000);
    // Initial poll after 10 seconds (let other systems initialize)
    setTimeout(() => this.poll(), 10_000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getStatus(): {
    enabled: boolean;
    trackedSessions: number;
    sessionHealth: Array<{ topicId: number; sessionName: string; status: string; idleMinutes: number }>;
  } {
    const health = [];
    for (const [topicId, snap] of this.snapshots) {
      health.push({
        topicId,
        sessionName: snap.sessionName,
        status: snap.status,
        idleMinutes: Math.round((Date.now() - snap.lastOutputAt) / 60000),
      });
    }
    return {
      enabled: this.config.enabled,
      trackedSessions: this.snapshots.size,
      sessionHealth: health,
    };
  }

  // ── Core Polling ────────────────────────────────────────
  async poll(): Promise<void> {
    if (!this.config.enabled || this.running) return;
    this.running = true;

    try {
      const activeTopics = this.deps.getActiveTopicSessions();

      // Clean up snapshots for topics that no longer have sessions
      for (const topicId of this.snapshots.keys()) {
        if (!activeTopics.has(topicId)) {
          this.snapshots.delete(topicId);
        }
      }

      // Check each active session
      for (const [topicId, sessionName] of activeTopics) {
        try {
          await this.checkSession(topicId, sessionName);
        } catch (err) {
          console.error(`[SessionMonitor] Error checking topic ${topicId}:`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async checkSession(topicId: number, sessionName: string): Promise<void> {
    const now = Date.now();
    const alive = this.deps.isSessionAlive(sessionName);

    // Get or create snapshot
    let snap = this.snapshots.get(topicId);
    if (!snap) {
      snap = {
        sessionName,
        topicId,
        lastOutput: '',
        lastOutputAt: now,
        lastUserMessageAt: 0,
        lastAgentMessageAt: 0,
        notifiedAt: null,
        status: 'healthy',
      };
      this.snapshots.set(topicId, snap);
    }

    // Update session name if it changed (respawn)
    snap.sessionName = sessionName;

    // Capture current output
    const currentOutput = alive ? (this.deps.captureSessionOutput(sessionName, 30) || '') : '';

    // Check if output changed
    if (currentOutput !== snap.lastOutput && currentOutput.length > 0) {
      snap.lastOutput = currentOutput;
      snap.lastOutputAt = now;
    }

    // Get recent message timestamps
    const history = this.deps.getTopicHistory(topicId, 5);
    for (const msg of history) {
      const ts = new Date(msg.timestamp).getTime();
      if (msg.fromUser && ts > snap.lastUserMessageAt) {
        snap.lastUserMessageAt = ts;
      } else if (!msg.fromUser && ts > snap.lastAgentMessageAt) {
        snap.lastAgentMessageAt = ts;
      }
    }

    // Determine session health
    const idleMinutes = Math.round((now - snap.lastOutputAt) / 60000);
    const prevStatus = snap.status;

    if (!alive) {
      snap.status = 'dead';
    } else if (snap.lastUserMessageAt > snap.lastAgentMessageAt &&
               now - snap.lastUserMessageAt > 10 * 60 * 1000) {
      // User sent a message > 10 min ago and agent hasn't replied
      snap.status = 'unresponsive';
    } else if (idleMinutes >= this.config.idleThresholdMinutes) {
      snap.status = 'idle';
    } else {
      snap.status = 'healthy';
    }

    // Take action based on health status
    if (snap.status === 'healthy') return;
    if (snap.status === prevStatus && snap.notifiedAt) return; // Already handled

    // Check notification cooldown
    if (snap.notifiedAt && now - snap.notifiedAt < this.config.notificationCooldownMinutes * 60 * 1000) {
      return;
    }

    // Only act if the user has sent a message that's gone unanswered.
    // A session sitting idle after the agent responded is NORMAL — the user
    // just hasn't sent a new message yet. "Recently active" is not a reason
    // to escalate; only an unanswered user message is.
    const userExpectsResponse = snap.lastUserMessageAt > snap.lastAgentMessageAt;

    if (!userExpectsResponse) return; // Session idle but no unanswered message — normal state

    // Try mechanical recovery first (fast, no LLM) before escalating to triage.
    // Run for ALL unhealthy statuses — context exhaustion can occur in alive sessions
    // that appear "unresponsive" or even "idle" (the session is alive at a prompt
    // but can't process input because the conversation is too long).
    if (this.deps.sessionRecovery) {
      try {
        const recoveryResult = await this.deps.sessionRecovery.checkAndRecover(topicId, sessionName);
        this.emit('monitor:mechanical-recovery', { topicId, sessionName, result: recoveryResult });
        if (recoveryResult.recovered) {
          console.log(`[SessionMonitor] Mechanical recovery succeeded for topic ${topicId}: ${recoveryResult.message}`);
          snap.status = 'healthy';
          snap.notifiedAt = now;
          return;
        }
      } catch (err) {
        console.error(`[SessionMonitor] Mechanical recovery error for topic ${topicId}:`, err);
      }
    }

    switch (snap.status) {
      case 'dead': {
        this.emit('monitor:recovery-triggered', { topicId, sessionName, reason: 'session_dead' });
        if (this.deps.triggerTriage) {
          const result = await this.deps.triggerTriage(topicId, sessionName, 'Session died while user was waiting');
          if (result.resolved) {
            snap.status = 'healthy';
            snap.notifiedAt = now;
            return;
          }
        }
        // If triage didn't resolve or isn't available, notify user
        if (userExpectsResponse) {
          await this.deps.sendToTopic(topicId,
            `The session has stopped. Send a new message to start a fresh session with full conversation context.`
          ).catch(() => {});
          this.emit('monitor:user-notified', { topicId, message: 'session_dead' });
        }
        snap.notifiedAt = now;
        break;
      }

      case 'unresponsive': {
        const waitMinutes = Math.round((now - snap.lastUserMessageAt) / 60000);
        this.emit('monitor:unresponsive', { topicId, sessionName, waitMinutes });

        if (this.deps.triggerTriage) {
          const result = await this.deps.triggerTriage(topicId, sessionName,
            `Session unresponsive for ${waitMinutes} minutes after user message`);
          if (result.resolved) {
            snap.status = 'healthy';
            snap.notifiedAt = now;
            return;
          }
        }
        snap.notifiedAt = now;
        break;
      }

      case 'idle': {
        this.emit('monitor:idle-detected', { topicId, sessionName, idleMinutes });
        // For idle sessions, only notify if user is actively waiting
        if (userExpectsResponse) {
          const msg = `Session has been idle for ${idleMinutes} minutes. Checking if it needs attention...`;
          await this.deps.sendToTopic(topicId, msg).catch(() => {});
          this.emit('monitor:user-notified', { topicId, message: 'session_idle' });

          if (this.deps.triggerTriage) {
            await this.deps.triggerTriage(topicId, sessionName, `Session idle for ${idleMinutes} minutes, user waiting`);
          }
        }
        snap.notifiedAt = now;
        break;
      }
    }
  }
}
