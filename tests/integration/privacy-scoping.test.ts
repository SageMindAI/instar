/**
 * Integration tests for Phase 2 Privacy & Memory Scoping.
 *
 * Tests the full pipeline: message insertion → privacy filtering → context assembly.
 * Verifies the critical invariant:
 *   "User B cannot receive memories or sensitive replies generated for User A."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import type { TopicMessage } from '../../src/memory/TopicMemory.js';
import {
  isVisibleToUser,
  privateScope,
  sharedTopicScope,
  sharedProjectScope,
  validatePrivacyScope,
  defaultScope,
  createOnboardingSession,
  transitionOnboarding,
} from '../../src/utils/privacy.js';
import {
  toInbound,
  toPipeline,
  toInjection,
  toLogEntry,
} from '../../src/types/pipeline.js';
import type { PipelineLogEntry } from '../../src/types/pipeline.js';

// ── Fixtures ─────────────────────────────────────────────────────

let testDir: string;
let memory: TopicMemory;

const ALICE = { id: 'alice', telegramUserId: 11111, name: 'Alice' };
const BOB = { id: 'bob', telegramUserId: 22222, name: 'Bob' };
const CHARLIE = { id: 'charlie', telegramUserId: 33333, name: 'Charlie' };

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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-integ-'));
  memory = new TopicMemory(testDir);
  await memory.open();
});

afterEach(() => {
  memory.close();
  // safe-git-allow: incremental-migration
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ── Full Pipeline: Message → Privacy Filter → Context ─────────────

describe('full pipeline privacy integration', () => {
  it('pipeline log entries carry userId for privacy-aware storage', () => {
    const rawMsg = {
      message_id: 100,
      from: { id: ALICE.telegramUserId, first_name: ALICE.name },
      message_thread_id: 42,
      date: Math.floor(Date.now() / 1000),
      text: 'Hello from Alice',
    };

    const inbound = toInbound(rawMsg, {
      content: rawMsg.text!,
      type: 'text',
      topicName: 'General',
    });

    const pipeline = toPipeline(inbound);
    const logEntry = toLogEntry(pipeline, 'test-session');

    // LogEntry carries the telegramUserId which maps to userId
    expect(logEntry.telegramUserId).toBe(ALICE.telegramUserId);
    expect(logEntry.senderName).toBe(ALICE.name);
  });

  it('TopicMemory stores and filters by userId end-to-end', () => {
    // Simulate Alice and Bob sending messages to the same topic
    memory.insertMessage(makeMsg({
      messageId: 1, topicId: 42,
      userId: ALICE.id, telegramUserId: ALICE.telegramUserId,
      privacyScope: 'private', senderName: ALICE.name,
      text: 'Alice: My bank PIN is 1234',
    }));

    memory.insertMessage(makeMsg({
      messageId: 2, topicId: 42,
      userId: BOB.id, telegramUserId: BOB.telegramUserId,
      privacyScope: 'private', senderName: BOB.name,
      text: 'Bob: My API key is sk-abc123',
    }));

    memory.insertMessage(makeMsg({
      messageId: 3, topicId: 42,
      userId: ALICE.id, telegramUserId: ALICE.telegramUserId,
      privacyScope: 'shared-project', senderName: ALICE.name,
      text: 'Alice: The deployment is at 3pm',
    }));

    // Alice's context should NOT include Bob's private message
    const aliceContext = memory.formatContextForUser(42, ALICE.id);
    expect(aliceContext).toContain('My bank PIN is 1234');
    expect(aliceContext).toContain('The deployment is at 3pm');
    expect(aliceContext).not.toContain('My API key is sk-abc123');

    // Bob's context should NOT include Alice's private message
    const bobContext = memory.formatContextForUser(42, BOB.id);
    expect(bobContext).toContain('My API key is sk-abc123');
    expect(bobContext).toContain('The deployment is at 3pm');
    expect(bobContext).not.toContain('My bank PIN is 1234');

    // Charlie shouldn't see any private messages
    const charlieContext = memory.formatContextForUser(42, CHARLIE.id);
    expect(charlieContext).toContain('The deployment is at 3pm');
    expect(charlieContext).not.toContain('My bank PIN is 1234');
    expect(charlieContext).not.toContain('My API key is sk-abc123');
  });
});

// ── Privacy Scope + Visibility Combined ──────────────────────────

describe('privacy scope validation + visibility', () => {
  it('validates and applies private scope correctly', () => {
    const scope = privateScope('alice');
    expect(validatePrivacyScope(scope)).toBeNull();
    expect(isVisibleToUser(scope.type, scope.ownerId!, 'alice')).toBe(true);
    expect(isVisibleToUser(scope.type, scope.ownerId!, 'bob')).toBe(false);
  });

  it('validates and applies shared-topic scope correctly', () => {
    const scope = sharedTopicScope(42);
    expect(validatePrivacyScope(scope)).toBeNull();
    expect(isVisibleToUser(scope.type, null, 'alice', [42], 42)).toBe(true);
    expect(isVisibleToUser(scope.type, null, 'bob', [99], 42)).toBe(false);
  });

  it('validates and applies shared-project scope correctly', () => {
    const scope = sharedProjectScope();
    expect(validatePrivacyScope(scope)).toBeNull();
    expect(isVisibleToUser(scope.type, null, 'alice')).toBe(true);
    expect(isVisibleToUser(scope.type, null, 'bob')).toBe(true);
  });
});

// ── Default Scope Assignment ─────────────────────────────────────

describe('default scope assignment by source', () => {
  it('user messages default to private', () => {
    expect(defaultScope('user:alice')).toBe('private');
    expect(defaultScope('session:abc')).toBe('private');
  });

  it('agent knowledge defaults to shared-project', () => {
    expect(defaultScope('agent:discovery')).toBe('shared-project');
    expect(defaultScope('observation')).toBe('shared-project');
  });
});

// ── GDPR Data Operations ─────────────────────────────────────────

describe('GDPR data operations', () => {
  beforeEach(() => {
    // Populate with mixed user data
    for (let i = 1; i <= 5; i++) {
      memory.insertMessage(makeMsg({
        messageId: i, topicId: 42,
        userId: ALICE.id, privacyScope: 'private',
        text: `Alice message ${i}`,
      }));
    }
    for (let i = 6; i <= 8; i++) {
      memory.insertMessage(makeMsg({
        messageId: i, topicId: 42,
        userId: BOB.id, privacyScope: 'private',
        text: `Bob message ${i}`,
      }));
    }
    memory.insertMessage(makeMsg({
      messageId: 9, topicId: 99,
      userId: ALICE.id, privacyScope: 'shared-project',
      text: 'Alice cross-topic message',
    }));
  });

  describe('/mydata export', () => {
    it('exports all messages by a specific user', () => {
      const aliceMessages = memory.getMessagesByUser(ALICE.id);
      expect(aliceMessages).toHaveLength(6); // 5 in topic 42 + 1 in topic 99
      expect(aliceMessages.every(m => m.userId === ALICE.id)).toBe(true);
    });

    it("does not include other users' messages", () => {
      const aliceMessages = memory.getMessagesByUser(ALICE.id);
      expect(aliceMessages.every(m => m.userId === ALICE.id)).toBe(true);
      // Verify none of Bob's messages are included
      expect(aliceMessages.some(m => m.text?.includes('Bob'))).toBe(false);
    });
  });

  describe('/forget erasure', () => {
    it('deletes all messages by a specific user', () => {
      const deleted = memory.deleteMessagesByUser(ALICE.id);
      expect(deleted).toBe(6);

      // Alice's messages are gone
      expect(memory.getMessagesByUser(ALICE.id)).toHaveLength(0);

      // Bob's messages are untouched
      expect(memory.getMessagesByUser(BOB.id)).toHaveLength(3);
    });

    it("does not affect other users' data", () => {
      memory.deleteMessagesByUser(ALICE.id);

      const bobMessages = memory.getMessagesByUser(BOB.id);
      expect(bobMessages).toHaveLength(3);
      expect(bobMessages.every(m => m.text?.includes('Bob'))).toBe(true);
    });
  });
});

// ── Onboarding State Integration ─────────────────────────────────

describe('onboarding state machine integration', () => {
  it('full consent lifecycle gates message access', () => {
    // User arrives — unknown state
    const session = createOnboardingSession(ALICE.telegramUserId, ALICE.name, 42);
    expect(session.state).toBe('pending');

    // User gives consent
    const consented = transitionOnboarding(session, 'consented');
    expect(consented).not.toBeNull();
    expect(consented!.state).toBe('consented');

    // Consent recorded → authorize
    const authorized = transitionOnboarding(consented!, 'authorized');
    expect(authorized).not.toBeNull();
    expect(authorized!.state).toBe('authorized');

    // Now their messages should be insertable with privacy scope
    memory.insertMessage(makeMsg({
      messageId: 1, topicId: 42,
      userId: ALICE.id, privacyScope: 'private',
      text: 'First authorized message',
    }));

    const messages = memory.getRecentMessagesForUser(42, ALICE.id);
    expect(messages).toHaveLength(1);
  });

  it('consent bypass is blocked', () => {
    const session = createOnboardingSession(ALICE.telegramUserId, ALICE.name, 42);

    // Cannot skip from pending directly to authorized
    const bypass = transitionOnboarding(session, 'authorized');
    expect(bypass).toBeNull();
  });
});

// ── Mixed Legacy + Privacy-Aware Data ────────────────────────────

describe('backward compatibility with mixed data', () => {
  it('legacy messages (no userId) are visible to all users', () => {
    // Legacy message — no userId, default privacy_scope
    memory.insertMessage(makeMsg({
      messageId: 1, topicId: 42,
      text: 'Legacy message from before Phase 2',
    }));

    // New message with privacy
    memory.insertMessage(makeMsg({
      messageId: 2, topicId: 42,
      userId: ALICE.id, privacyScope: 'private',
      text: 'Alice private message',
    }));

    // Alice sees both
    const aliceMessages = memory.getRecentMessagesForUser(42, ALICE.id);
    expect(aliceMessages).toHaveLength(2);

    // Bob sees legacy but not Alice's private
    const bobMessages = memory.getRecentMessagesForUser(42, BOB.id);
    expect(bobMessages).toHaveLength(1);
    expect(bobMessages[0].text).toBe('Legacy message from before Phase 2');
  });

  it('unscoped getRecentMessages still returns everything', () => {
    memory.insertMessage(makeMsg({
      messageId: 1, topicId: 42, userId: ALICE.id, privacyScope: 'private',
    }));
    memory.insertMessage(makeMsg({
      messageId: 2, topicId: 42, userId: BOB.id, privacyScope: 'private',
    }));
    memory.insertMessage(makeMsg({
      messageId: 3, topicId: 42, privacyScope: 'shared-project',
    }));

    // No user filter = all messages
    const all = memory.getRecentMessages(42);
    expect(all).toHaveLength(3);
  });
});

// ── Edge Cases ───────────────────────────────────────────────────

describe('edge cases', () => {
  it('userId with special characters', () => {
    memory.insertMessage(makeMsg({
      messageId: 1, topicId: 42,
      userId: "user-with-dashes_and_underscores.and.dots",
      privacyScope: 'private',
      text: 'Special chars in userId',
    }));

    const messages = memory.getRecentMessagesForUser(42, "user-with-dashes_and_underscores.and.dots");
    expect(messages).toHaveLength(1);
  });

  it('empty userId string is treated as a valid userId', () => {
    memory.insertMessage(makeMsg({
      messageId: 1, topicId: 42, userId: '', privacyScope: 'private',
      text: 'Empty userId message',
    }));

    // Empty string is a distinct userId — only visible to '' user
    const messages = memory.getRecentMessagesForUser(42, '');
    expect(messages).toHaveLength(1);
  });

  it('many users in same topic with mixed scopes', () => {
    const users = ['alice', 'bob', 'charlie', 'dave', 'eve'];

    for (let i = 0; i < users.length; i++) {
      // Each user sends 2 private + 1 shared message
      memory.insertMessage(makeMsg({
        messageId: i * 3 + 1, topicId: 42,
        userId: users[i], privacyScope: 'private',
        text: `${users[i]} private 1`,
      }));
      memory.insertMessage(makeMsg({
        messageId: i * 3 + 2, topicId: 42,
        userId: users[i], privacyScope: 'private',
        text: `${users[i]} private 2`,
      }));
      memory.insertMessage(makeMsg({
        messageId: i * 3 + 3, topicId: 42,
        userId: users[i], privacyScope: 'shared-project',
        text: `${users[i]} shared`,
      }));
    }

    // Total: 15 messages (5 users × 3 each)
    expect(memory.getRecentMessages(42, 100)).toHaveLength(15);

    // Each user sees: 2 own private + 5 shared = 7
    for (const user of users) {
      const messages = memory.getRecentMessagesForUser(42, user, 100);
      expect(messages).toHaveLength(7);

      // Verify they only see their own private messages
      const privateMessages = messages.filter(m => m.privacyScope === 'private');
      expect(privateMessages).toHaveLength(2);
      expect(privateMessages.every(m => m.userId === user)).toBe(true);
    }
  });
});
