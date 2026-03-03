/**
 * OnboardingGate — Atomic consent gating for multi-user onboarding.
 *
 * Prevents the onboarding race condition (Gap 13, User-Agent Topology Spec):
 *   If two rapid messages arrive from an unknown user during onboarding,
 *   and isAuthorized() + onboarding trigger are not atomic, the user
 *   can bypass consent.
 *
 * The gate ensures:
 *   1. Only ONE onboarding session exists per user (no duplicates)
 *   2. Messages are buffered during 'pending' state (max MAX_PENDING_MESSAGES)
 *   3. Consent must be recorded before authorization is granted
 *   4. Stale pending sessions are auto-rejected after ONBOARDING_TIMEOUT_MINUTES
 *   5. All state transitions are synchronous (no async gaps for races)
 *
 * State machine:
 *   unknown → pending → consented → authorized (happy path)
 *   unknown → pending → rejected (user declines)
 *   pending → rejected → pending (user retries)
 */

import type { OnboardingState, OnboardingSession } from '../core/types.js';
import {
  createOnboardingSession,
  transitionOnboarding,
  isValidOnboardingTransition,
  MAX_PENDING_MESSAGES,
  ONBOARDING_TIMEOUT_MINUTES,
} from '../utils/privacy.js';

export interface PendingMessage {
  text: string;
  topicId: number;
  telegramUserId: number;
  timestamp: string;
}

export interface GateDecision {
  /** Whether the message should be processed */
  allowed: boolean;
  /** Reason for the decision */
  reason: 'authorized' | 'pending' | 'buffered' | 'rejected' | 'buffer-full' | 'timed-out';
  /** The current onboarding session, if one exists */
  session?: OnboardingSession;
  /** Buffered messages released on authorization */
  releasedMessages?: PendingMessage[];
}

export class OnboardingGate {
  /** Active onboarding sessions keyed by telegramUserId */
  private sessions: Map<number, OnboardingSession> = new Map();
  /** Buffered messages for pending users */
  private buffers: Map<number, PendingMessage[]> = new Map();
  /** Set of authorized telegramUserIds (fast lookup) */
  private authorizedUsers: Set<number> = new Set();

  /**
   * Pre-authorize a user (e.g., loaded from persisted state).
   * Skips the onboarding flow entirely.
   */
  preAuthorize(telegramUserId: number): void {
    this.authorizedUsers.add(telegramUserId);
    // Clean up any stale session/buffer
    this.sessions.delete(telegramUserId);
    this.buffers.delete(telegramUserId);
  }

  /**
   * Check if a user is authorized (has completed onboarding).
   */
  isAuthorized(telegramUserId: number): boolean {
    return this.authorizedUsers.has(telegramUserId);
  }

  /**
   * Gate a message from a user. Returns a decision about whether to process it.
   *
   * This is the ATOMIC entry point — it handles the full check-and-act cycle
   * synchronously to prevent race conditions.
   */
  gate(telegramUserId: number, name: string, topicId: number, messageText: string): GateDecision {
    // Fast path: already authorized
    if (this.authorizedUsers.has(telegramUserId)) {
      return { allowed: true, reason: 'authorized' };
    }

    // Check for existing session
    const existing = this.sessions.get(telegramUserId);

    if (existing) {
      // Check for timeout
      if (this.isTimedOut(existing)) {
        this.cleanupSession(telegramUserId);
        // Start fresh — fall through to create new session
      } else {
        // Session exists — buffer the message
        return this.bufferMessage(telegramUserId, topicId, messageText, existing);
      }
    }

    // No session exists — create one atomically
    const session = createOnboardingSession(telegramUserId, name, topicId);
    this.sessions.set(telegramUserId, session);
    this.buffers.set(telegramUserId, []);

    // Buffer this first message
    this.buffers.get(telegramUserId)!.push({
      text: messageText,
      topicId,
      telegramUserId,
      timestamp: new Date().toISOString(),
    });

    return {
      allowed: false,
      reason: 'pending',
      session,
    };
  }

  /**
   * Record user consent. Transitions pending → consented.
   * Returns null if no pending session or invalid transition.
   */
  recordConsent(telegramUserId: number): OnboardingSession | null {
    const session = this.sessions.get(telegramUserId);
    if (!session) return null;

    // Check timeout first
    if (this.isTimedOut(session)) {
      this.cleanupSession(telegramUserId);
      return null;
    }

    const updated = transitionOnboarding(session, 'consented');
    if (!updated) return null;

    this.sessions.set(telegramUserId, updated);
    return updated;
  }

  /**
   * Authorize a user after consent. Transitions consented → authorized.
   * Returns the released buffered messages, or null if invalid transition.
   *
   * CRITICAL: This is the only path to authorization. Cannot bypass consent.
   */
  authorize(telegramUserId: number): GateDecision | null {
    const session = this.sessions.get(telegramUserId);
    if (!session) return null;

    // Must be in 'consented' state — cannot skip from pending to authorized
    const updated = transitionOnboarding(session, 'authorized');
    if (!updated) return null;

    // Mark as authorized
    this.authorizedUsers.add(telegramUserId);

    // Release buffered messages
    const released = this.buffers.get(telegramUserId) || [];

    // Clean up
    this.sessions.delete(telegramUserId);
    this.buffers.delete(telegramUserId);

    return {
      allowed: true,
      reason: 'authorized',
      session: updated,
      releasedMessages: released,
    };
  }

  /**
   * Reject a user. Transitions pending → rejected.
   */
  reject(telegramUserId: number): OnboardingSession | null {
    const session = this.sessions.get(telegramUserId);
    if (!session) return null;

    const updated = transitionOnboarding(session, 'rejected');
    if (!updated) return null;

    // Drop buffered messages
    this.buffers.delete(telegramUserId);
    this.sessions.set(telegramUserId, updated);

    return updated;
  }

  /**
   * Allow a rejected user to retry onboarding.
   * Transitions rejected → pending.
   */
  allowRetry(telegramUserId: number): OnboardingSession | null {
    const session = this.sessions.get(telegramUserId);
    if (!session || session.state !== 'rejected') return null;

    const updated = transitionOnboarding(session, 'pending');
    if (!updated) return null;

    this.buffers.set(telegramUserId, []);
    this.sessions.set(telegramUserId, updated);

    return updated;
  }

  /**
   * Get the current onboarding session for a user.
   */
  getSession(telegramUserId: number): OnboardingSession | null {
    return this.sessions.get(telegramUserId) ?? null;
  }

  /**
   * Get buffered messages for a user.
   */
  getBufferedMessages(telegramUserId: number): PendingMessage[] {
    return this.buffers.get(telegramUserId) ?? [];
  }

  /**
   * Clean up timed-out sessions. Returns the count of cleaned sessions.
   * Should be called periodically (e.g., every minute).
   */
  cleanupTimedOut(): number {
    let count = 0;
    for (const [userId, session] of this.sessions) {
      if (this.isTimedOut(session)) {
        this.cleanupSession(userId);
        count++;
      }
    }
    return count;
  }

  /**
   * Get stats about the gate's current state.
   */
  stats(): {
    authorizedCount: number;
    pendingCount: number;
    totalBufferedMessages: number;
  } {
    let totalBuffered = 0;
    for (const buffer of this.buffers.values()) {
      totalBuffered += buffer.length;
    }

    return {
      authorizedCount: this.authorizedUsers.size,
      pendingCount: this.sessions.size,
      totalBufferedMessages: totalBuffered,
    };
  }

  // ── Private helpers ────────────────────────────────────────────

  private bufferMessage(
    telegramUserId: number,
    topicId: number,
    text: string,
    session: OnboardingSession,
  ): GateDecision {
    const buffer = this.buffers.get(telegramUserId) ?? [];

    if (buffer.length >= MAX_PENDING_MESSAGES) {
      return {
        allowed: false,
        reason: 'buffer-full',
        session,
      };
    }

    buffer.push({
      text,
      topicId,
      telegramUserId,
      timestamp: new Date().toISOString(),
    });
    this.buffers.set(telegramUserId, buffer);

    // Update pending message count in session
    const updated = { ...session, pendingMessageCount: buffer.length, updatedAt: new Date().toISOString() };
    this.sessions.set(telegramUserId, updated);

    return {
      allowed: false,
      reason: 'buffered',
      session: updated,
    };
  }

  private isTimedOut(session: OnboardingSession): boolean {
    if (session.state === 'authorized') return false;
    const elapsed = Date.now() - new Date(session.startedAt).getTime();
    return elapsed > ONBOARDING_TIMEOUT_MINUTES * 60 * 1000;
  }

  private cleanupSession(telegramUserId: number): void {
    this.sessions.delete(telegramUserId);
    this.buffers.delete(telegramUserId);
  }
}
