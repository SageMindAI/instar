/**
 * Integration tests for OnboardingGate with TopicMemory privacy scoping.
 *
 * Tests the full pipeline: message arrives → gate checks → buffering during onboarding →
 * consent → authorization → buffered messages released with privacy scoping.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OnboardingGate } from '../../src/users/OnboardingGate.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import type { TopicMessage } from '../../src/memory/TopicMemory.js';

// ── Fixtures ─────────────────────────────────────────────────────

let testDir: string;
let memory: TopicMemory;
let gate: OnboardingGate;

const ALICE = { telegramUserId: 11111, name: 'Alice', id: 'alice' };
const BOB = { telegramUserId: 22222, name: 'Bob', id: 'bob' };

function makeMsg(overrides: Partial<TopicMessage> & { messageId: number; topicId: number }): TopicMessage {
  return {
    text: `Message ${overrides.messageId}`,
    fromUser: true,
    timestamp: new Date(Date.now() + overrides.messageId * 1000).toISOString(),
    sessionName: null,
    ...overrides,
  };
}

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-integ-'));
  memory = new TopicMemory(testDir);
  await memory.open();
  gate = new OnboardingGate();
});

afterEach(() => {
  memory.close();
  // safe-git-allow: incremental-migration
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ── Full Onboarding → Message Storage Pipeline ──────────────────

describe('full onboarding → message storage pipeline', () => {
  it('authorized user messages are stored with privacy scoping', () => {
    // Pre-authorize Alice
    gate.preAuthorize(ALICE.telegramUserId);

    // Gate check passes
    const decision = gate.gate(ALICE.telegramUserId, ALICE.name, 42, 'Hello from Alice');
    expect(decision.allowed).toBe(true);

    // Store with privacy scope
    memory.insertMessage(makeMsg({
      messageId: 1,
      topicId: 42,
      userId: ALICE.id,
      telegramUserId: ALICE.telegramUserId,
      privacyScope: 'private',
      senderName: ALICE.name,
      text: 'Hello from Alice',
    }));

    // Verify storage
    const messages = memory.getRecentMessagesForUser(42, ALICE.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].privacyScope).toBe('private');
  });

  it('buffered messages are stored after authorization', () => {
    // Alice sends messages before authorization
    gate.gate(ALICE.telegramUserId, ALICE.name, 42, 'First message');
    gate.gate(ALICE.telegramUserId, ALICE.name, 42, 'Second message');

    // Go through full onboarding
    gate.recordConsent(ALICE.telegramUserId);
    const result = gate.authorize(ALICE.telegramUserId);

    // Store released messages with privacy scope
    for (const msg of result!.releasedMessages!) {
      memory.insertMessage(makeMsg({
        messageId: Math.floor(Math.random() * 10000),
        topicId: msg.topicId,
        userId: ALICE.id,
        telegramUserId: msg.telegramUserId,
        privacyScope: 'private',
        senderName: ALICE.name,
        text: msg.text,
      }));
    }

    // Verify both messages stored
    const messages = memory.getRecentMessagesForUser(42, ALICE.id);
    expect(messages).toHaveLength(2);
  });

  it('CRITICAL: pending user messages are NOT stored', () => {
    // Alice is pending — message should be gated
    const decision = gate.gate(ALICE.telegramUserId, ALICE.name, 42, 'Should not be stored');
    expect(decision.allowed).toBe(false);

    // DO NOT store — simulate the behavior of the message handler
    // that checks gate.allowed before storing

    // Memory should be empty
    const messages = memory.getRecentMessagesForUser(42, ALICE.id);
    expect(messages).toHaveLength(0);
  });
});

// ── Multi-user Isolation with Gate ───────────────────────────────

describe('multi-user isolation with onboarding gate', () => {
  it('CRITICAL: Alice authorized, Bob pending — Bob cannot see Alice data', () => {
    // Alice is pre-authorized
    gate.preAuthorize(ALICE.telegramUserId);

    // Store Alice's message
    memory.insertMessage(makeMsg({
      messageId: 1,
      topicId: 42,
      userId: ALICE.id,
      telegramUserId: ALICE.telegramUserId,
      privacyScope: 'private',
      senderName: ALICE.name,
      text: 'Alice sensitive data',
    }));

    // Bob is pending — gate blocks
    const bobDecision = gate.gate(BOB.telegramUserId, BOB.name, 42, 'Bob message');
    expect(bobDecision.allowed).toBe(false);

    // Even if Bob somehow queries memory, privacy scoping blocks
    const bobContext = memory.formatContextForUser(42, BOB.id);
    expect(bobContext).not.toContain('Alice sensitive data');
  });

  it('Alice and Bob both authorized — shared messages visible to both', () => {
    gate.preAuthorize(ALICE.telegramUserId);
    gate.preAuthorize(BOB.telegramUserId);

    // Shared message
    memory.insertMessage(makeMsg({
      messageId: 1,
      topicId: 42,
      userId: ALICE.id,
      telegramUserId: ALICE.telegramUserId,
      privacyScope: 'shared-project',
      senderName: ALICE.name,
      text: 'Shared announcement',
    }));

    // Both can see it
    const aliceContext = memory.formatContextForUser(42, ALICE.id);
    const bobContext = memory.formatContextForUser(42, BOB.id);

    expect(aliceContext).toContain('Shared announcement');
    expect(bobContext).toContain('Shared announcement');
  });
});

// ── Onboarding Timeout + Memory Cleanup ──────────────────────────

describe('onboarding timeout integration', () => {
  it('timed-out user gets fresh session on next message', () => {
    // Start onboarding
    gate.gate(ALICE.telegramUserId, ALICE.name, 42, 'First attempt');

    // Simulate timeout
    const session = gate.getSession(ALICE.telegramUserId)!;
    (gate as any).sessions.set(ALICE.telegramUserId, {
      ...session,
      startedAt: new Date(0).toISOString(), // Way in the past
    });

    // Next message creates fresh session
    const decision = gate.gate(ALICE.telegramUserId, ALICE.name, 42, 'After timeout');
    expect(decision.reason).toBe('pending');

    // Old buffered message is gone
    const buffered = gate.getBufferedMessages(ALICE.telegramUserId);
    expect(buffered).toHaveLength(1);
    expect(buffered[0].text).toBe('After timeout');
  });
});

// ── Reject + Retry Flow ──────────────────────────────────────────

describe('reject + retry with message storage', () => {
  it('rejected user can re-onboard and get messages stored', () => {
    // First attempt — rejected
    gate.gate(ALICE.telegramUserId, ALICE.name, 42, 'Hello');
    gate.reject(ALICE.telegramUserId);

    // Retry
    gate.allowRetry(ALICE.telegramUserId);
    gate.gate(ALICE.telegramUserId, ALICE.name, 42, 'Trying again');

    // Complete onboarding
    gate.recordConsent(ALICE.telegramUserId);
    const result = gate.authorize(ALICE.telegramUserId);

    // Only the retry message is released (original was dropped on reject)
    expect(result!.releasedMessages).toHaveLength(1);
    expect(result!.releasedMessages![0].text).toBe('Trying again');

    // Store and verify
    memory.insertMessage(makeMsg({
      messageId: 1,
      topicId: 42,
      userId: ALICE.id,
      telegramUserId: ALICE.telegramUserId,
      privacyScope: 'private',
      senderName: ALICE.name,
      text: 'Trying again',
    }));

    const messages = memory.getRecentMessagesForUser(42, ALICE.id);
    expect(messages).toHaveLength(1);
  });
});
