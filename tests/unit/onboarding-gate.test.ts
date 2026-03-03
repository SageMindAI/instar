/**
 * Tests for OnboardingGate — atomic consent gating for multi-user onboarding.
 *
 * Covers the critical invariants:
 *   1. Race condition prevention: concurrent messages don't bypass consent
 *   2. State machine transitions: pending → consented → authorized (only valid path)
 *   3. Consent bypass blocked: cannot skip from pending to authorized
 *   4. Message buffering during pending state
 *   5. Buffer overflow protection (MAX_PENDING_MESSAGES)
 *   6. Session timeout handling
 *   7. Reject and retry flows
 *   8. Pre-authorization for existing users
 *   9. Stats tracking
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OnboardingGate } from '../../src/users/OnboardingGate.js';
import { MAX_PENDING_MESSAGES, ONBOARDING_TIMEOUT_MINUTES } from '../../src/utils/privacy.js';

// ── Fixtures ────────────────────────────────────────────────────

const ALICE_TG = 11111;
const BOB_TG = 22222;
const CHARLIE_TG = 33333;

let gate: OnboardingGate;

beforeEach(() => {
  gate = new OnboardingGate();
});

// ── Pre-authorization ────────────────────────────────────────────

describe('pre-authorization', () => {
  it('pre-authorized users bypass the gate', () => {
    gate.preAuthorize(ALICE_TG);

    const decision = gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('authorized');
  });

  it('isAuthorized returns true for pre-authorized users', () => {
    gate.preAuthorize(ALICE_TG);
    expect(gate.isAuthorized(ALICE_TG)).toBe(true);
  });

  it('isAuthorized returns false for unknown users', () => {
    expect(gate.isAuthorized(ALICE_TG)).toBe(false);
  });

  it('pre-authorizing cleans up stale sessions', () => {
    // Start onboarding
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    expect(gate.getSession(ALICE_TG)).not.toBeNull();

    // Pre-authorize cleans up
    gate.preAuthorize(ALICE_TG);
    expect(gate.getSession(ALICE_TG)).toBeNull();
    expect(gate.getBufferedMessages(ALICE_TG)).toHaveLength(0);
  });
});

// ── Happy path: pending → consented → authorized ─────────────────

describe('happy path onboarding', () => {
  it('first message from unknown user creates pending session', () => {
    const decision = gate.gate(ALICE_TG, 'Alice', 42, 'Hello');

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('pending');
    expect(decision.session).toBeDefined();
    expect(decision.session!.state).toBe('pending');
    expect(decision.session!.telegramUserId).toBe(ALICE_TG);
    expect(decision.session!.name).toBe('Alice');
  });

  it('consent transitions to consented state', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');

    const consented = gate.recordConsent(ALICE_TG);
    expect(consented).not.toBeNull();
    expect(consented!.state).toBe('consented');
  });

  it('authorization after consent transitions to authorized', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.recordConsent(ALICE_TG);

    const result = gate.authorize(ALICE_TG);
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(true);
    expect(result!.reason).toBe('authorized');
    expect(result!.session!.state).toBe('authorized');
  });

  it('authorization releases buffered messages', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.gate(ALICE_TG, 'Alice', 42, 'Second message');
    gate.recordConsent(ALICE_TG);

    const result = gate.authorize(ALICE_TG);
    expect(result!.releasedMessages).toHaveLength(2);
    expect(result!.releasedMessages![0].text).toBe('Hello');
    expect(result!.releasedMessages![1].text).toBe('Second message');
  });

  it('after authorization, subsequent messages are allowed', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.recordConsent(ALICE_TG);
    gate.authorize(ALICE_TG);

    const decision = gate.gate(ALICE_TG, 'Alice', 42, 'Now I am authorized');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('authorized');
  });

  it('isAuthorized returns true after full onboarding', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.recordConsent(ALICE_TG);
    gate.authorize(ALICE_TG);

    expect(gate.isAuthorized(ALICE_TG)).toBe(true);
  });
});

// ── CRITICAL: Consent bypass prevention ──────────────────────────

describe('CRITICAL: consent bypass prevention', () => {
  it('cannot authorize directly from pending (skipping consent)', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');

    const result = gate.authorize(ALICE_TG);
    expect(result).toBeNull(); // BLOCKED
    expect(gate.isAuthorized(ALICE_TG)).toBe(false);
  });

  it('cannot record consent without a session', () => {
    const result = gate.recordConsent(ALICE_TG);
    expect(result).toBeNull();
  });

  it('cannot authorize without a session', () => {
    const result = gate.authorize(ALICE_TG);
    expect(result).toBeNull();
  });

  it('cannot consent twice', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.recordConsent(ALICE_TG);

    // Second consent attempt — consented → consented is not a valid transition
    const result = gate.recordConsent(ALICE_TG);
    expect(result).toBeNull();
  });

  it('cannot authorize twice', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.recordConsent(ALICE_TG);
    gate.authorize(ALICE_TG);

    // No session exists anymore
    const result = gate.authorize(ALICE_TG);
    expect(result).toBeNull();
  });
});

// ── Race condition simulation ────────────────────────────────────

describe('race condition prevention', () => {
  it('CRITICAL: rapid messages create only ONE session', () => {
    const d1 = gate.gate(ALICE_TG, 'Alice', 42, 'Message 1');
    const d2 = gate.gate(ALICE_TG, 'Alice', 42, 'Message 2');
    const d3 = gate.gate(ALICE_TG, 'Alice', 42, 'Message 3');

    // First creates the session
    expect(d1.reason).toBe('pending');
    // Subsequent buffer into the same session
    expect(d2.reason).toBe('buffered');
    expect(d3.reason).toBe('buffered');

    // Only one session exists
    const session = gate.getSession(ALICE_TG);
    expect(session).not.toBeNull();
    expect(session!.pendingMessageCount).toBe(3);
  });

  it('CRITICAL: messages from different users create separate sessions', () => {
    const d1 = gate.gate(ALICE_TG, 'Alice', 42, 'Alice msg');
    const d2 = gate.gate(BOB_TG, 'Bob', 42, 'Bob msg');

    expect(d1.reason).toBe('pending');
    expect(d2.reason).toBe('pending');

    // Separate sessions
    expect(gate.getSession(ALICE_TG)!.name).toBe('Alice');
    expect(gate.getSession(BOB_TG)!.name).toBe('Bob');
  });

  it('CRITICAL: authorizing one user does not authorize another', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Alice msg');
    gate.gate(BOB_TG, 'Bob', 42, 'Bob msg');

    gate.recordConsent(ALICE_TG);
    gate.authorize(ALICE_TG);

    expect(gate.isAuthorized(ALICE_TG)).toBe(true);
    expect(gate.isAuthorized(BOB_TG)).toBe(false);

    // Bob's session still exists
    expect(gate.getSession(BOB_TG)).not.toBeNull();
  });
});

// ── Message buffering ────────────────────────────────────────────

describe('message buffering', () => {
  it('buffers messages during pending state', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'First');
    gate.gate(ALICE_TG, 'Alice', 42, 'Second');
    gate.gate(ALICE_TG, 'Alice', 42, 'Third');

    const buffered = gate.getBufferedMessages(ALICE_TG);
    expect(buffered).toHaveLength(3);
    expect(buffered[0].text).toBe('First');
    expect(buffered[1].text).toBe('Second');
    expect(buffered[2].text).toBe('Third');
  });

  it('buffer preserves message metadata', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');

    const buffered = gate.getBufferedMessages(ALICE_TG);
    expect(buffered[0].topicId).toBe(42);
    expect(buffered[0].telegramUserId).toBe(ALICE_TG);
    expect(buffered[0].timestamp).toBeDefined();
  });

  it(`rejects after ${MAX_PENDING_MESSAGES} buffered messages`, () => {
    for (let i = 0; i < MAX_PENDING_MESSAGES; i++) {
      gate.gate(ALICE_TG, 'Alice', 42, `Message ${i + 1}`);
    }

    // One more should be buffer-full
    const overflow = gate.gate(ALICE_TG, 'Alice', 42, 'Overflow');
    expect(overflow.allowed).toBe(false);
    expect(overflow.reason).toBe('buffer-full');

    // Buffer still has exactly MAX_PENDING_MESSAGES
    expect(gate.getBufferedMessages(ALICE_TG)).toHaveLength(MAX_PENDING_MESSAGES);
  });

  it('returns empty array for users with no buffer', () => {
    expect(gate.getBufferedMessages(99999)).toHaveLength(0);
  });
});

// ── Reject and retry ─────────────────────────────────────────────

describe('reject and retry', () => {
  it('rejection drops buffered messages', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.gate(ALICE_TG, 'Alice', 42, 'More');

    const rejected = gate.reject(ALICE_TG);
    expect(rejected).not.toBeNull();
    expect(rejected!.state).toBe('rejected');

    // Buffer is cleared
    expect(gate.getBufferedMessages(ALICE_TG)).toHaveLength(0);
  });

  it('rejected user can retry', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.reject(ALICE_TG);

    const retried = gate.allowRetry(ALICE_TG);
    expect(retried).not.toBeNull();
    expect(retried!.state).toBe('pending');

    // New buffer is empty
    expect(gate.getBufferedMessages(ALICE_TG)).toHaveLength(0);
  });

  it('retried user can complete onboarding', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.reject(ALICE_TG);
    gate.allowRetry(ALICE_TG);

    // New message gets buffered
    gate.gate(ALICE_TG, 'Alice', 42, 'Retry message');

    gate.recordConsent(ALICE_TG);
    const result = gate.authorize(ALICE_TG);

    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(true);
    expect(result!.releasedMessages).toHaveLength(1);
    expect(result!.releasedMessages![0].text).toBe('Retry message');
  });

  it('cannot reject an authorized user', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.recordConsent(ALICE_TG);
    gate.authorize(ALICE_TG);

    // No session to reject
    const result = gate.reject(ALICE_TG);
    expect(result).toBeNull();
  });

  it('cannot retry a non-rejected user', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');

    // State is 'pending', not 'rejected'
    const result = gate.allowRetry(ALICE_TG);
    expect(result).toBeNull();
  });
});

// ── Timeout handling ─────────────────────────────────────────────

describe('timeout handling', () => {
  it('timed-out session is cleaned up on next gate() call', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');

    // Simulate timeout by manipulating session
    const session = gate.getSession(ALICE_TG)!;
    const timedOutDate = new Date(Date.now() - (ONBOARDING_TIMEOUT_MINUTES + 1) * 60 * 1000);
    // Access internal map to set the timed-out session
    (gate as any).sessions.set(ALICE_TG, {
      ...session,
      startedAt: timedOutDate.toISOString(),
    });

    // Next gate() creates a fresh session
    const decision = gate.gate(ALICE_TG, 'Alice', 42, 'After timeout');
    expect(decision.reason).toBe('pending');

    // New session, not the old one
    const newSession = gate.getSession(ALICE_TG);
    expect(newSession).not.toBeNull();
    expect(new Date(newSession!.startedAt).getTime()).toBeGreaterThan(timedOutDate.getTime());
  });

  it('timed-out session blocks consent', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');

    // Simulate timeout
    const session = gate.getSession(ALICE_TG)!;
    (gate as any).sessions.set(ALICE_TG, {
      ...session,
      startedAt: new Date(Date.now() - (ONBOARDING_TIMEOUT_MINUTES + 1) * 60 * 1000).toISOString(),
    });

    const result = gate.recordConsent(ALICE_TG);
    expect(result).toBeNull();
  });

  it('cleanupTimedOut removes stale sessions', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.gate(BOB_TG, 'Bob', 42, 'Hello');

    // Only timeout Alice
    const aliceSession = gate.getSession(ALICE_TG)!;
    (gate as any).sessions.set(ALICE_TG, {
      ...aliceSession,
      startedAt: new Date(Date.now() - (ONBOARDING_TIMEOUT_MINUTES + 1) * 60 * 1000).toISOString(),
    });

    const cleaned = gate.cleanupTimedOut();
    expect(cleaned).toBe(1);

    expect(gate.getSession(ALICE_TG)).toBeNull();
    expect(gate.getSession(BOB_TG)).not.toBeNull();
  });

  it('authorized sessions are not timed out', () => {
    gate.preAuthorize(ALICE_TG);

    const cleaned = gate.cleanupTimedOut();
    expect(cleaned).toBe(0);
    expect(gate.isAuthorized(ALICE_TG)).toBe(true);
  });
});

// ── Stats ────────────────────────────────────────────────────────

describe('stats', () => {
  it('reports correct counts', () => {
    // Pre-authorize one user
    gate.preAuthorize(CHARLIE_TG);

    // Start onboarding for two users
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.gate(ALICE_TG, 'Alice', 42, 'Second');
    gate.gate(BOB_TG, 'Bob', 42, 'Hi');

    const stats = gate.stats();
    expect(stats.authorizedCount).toBe(1); // Charlie
    expect(stats.pendingCount).toBe(2); // Alice + Bob
    expect(stats.totalBufferedMessages).toBe(3); // Alice(2) + Bob(1)
  });

  it('stats update after authorization', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    gate.recordConsent(ALICE_TG);
    gate.authorize(ALICE_TG);

    const stats = gate.stats();
    expect(stats.authorizedCount).toBe(1);
    expect(stats.pendingCount).toBe(0);
    expect(stats.totalBufferedMessages).toBe(0);
  });
});

// ── Edge cases ───────────────────────────────────────────────────

describe('edge cases', () => {
  it('gate returns no session for authorized users', () => {
    gate.preAuthorize(ALICE_TG);
    const decision = gate.gate(ALICE_TG, 'Alice', 42, 'Hello');
    expect(decision.session).toBeUndefined();
  });

  it('multiple rapid gates from multiple users are isolated', () => {
    const users = [ALICE_TG, BOB_TG, CHARLIE_TG];

    // Rapid fire from all users
    for (const userId of users) {
      for (let i = 0; i < 3; i++) {
        gate.gate(userId, `User${userId}`, 42, `Message ${i}`);
      }
    }

    // Each has their own session with 3 buffered messages
    for (const userId of users) {
      expect(gate.getBufferedMessages(userId)).toHaveLength(3);
    }

    // Authorize only Alice
    gate.recordConsent(ALICE_TG);
    gate.authorize(ALICE_TG);

    expect(gate.isAuthorized(ALICE_TG)).toBe(true);
    expect(gate.isAuthorized(BOB_TG)).toBe(false);
    expect(gate.isAuthorized(CHARLIE_TG)).toBe(false);
  });

  it('messages from different topics are buffered correctly', () => {
    gate.gate(ALICE_TG, 'Alice', 42, 'Topic 42 msg');
    gate.gate(ALICE_TG, 'Alice', 99, 'Topic 99 msg');

    const buffered = gate.getBufferedMessages(ALICE_TG);
    expect(buffered).toHaveLength(2);
    expect(buffered[0].topicId).toBe(42);
    expect(buffered[1].topicId).toBe(99);
  });
});
