/**
 * Tests for GDPR Data Access Commands (/mydata and /forget).
 *
 * Covers:
 *   1. /mydata export from TopicMemory
 *   2. /mydata export from SemanticMemory
 *   3. /mydata cross-store export (both stores)
 *   4. /forget erasure from TopicMemory
 *   5. /forget erasure from SemanticMemory
 *   6. /forget cross-store erasure
 *   7. Idempotent /forget (running twice is safe)
 *   8. CRITICAL: /forget only removes requesting user's data
 *   9. Format summaries for display
 *  10. Graceful handling of unavailable stores
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import type { TopicMessage } from '../../src/memory/TopicMemory.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import {
  exportUserData,
  eraseUserData,
  formatExportSummary,
  formatErasureSummary,
} from '../../src/users/GdprCommands.js';

// ── Fixtures ────────────────────────────────────────────────────

let testDir: string;
let topicMemory: TopicMemory;
let semanticMemory: SemanticMemory;

const ALICE = { id: 'alice', telegramUserId: 11111, name: 'Alice' };
const BOB = { id: 'bob', telegramUserId: 22222, name: 'Bob' };

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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdpr-test-'));

  topicMemory = new TopicMemory(testDir);
  await topicMemory.open();

  semanticMemory = new SemanticMemory({
    dbPath: path.join(testDir, 'semantic.db'),
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
  await semanticMemory.open();
});

afterEach(() => {
  topicMemory.close();
  semanticMemory.close();
  // safe-git-allow: incremental-migration
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ── Seed data helper ──────────────────────────────────────────────

function seedData() {
  // Alice: 3 messages in topic 42, 1 in topic 99
  for (let i = 1; i <= 3; i++) {
    topicMemory.insertMessage(makeMsg({
      messageId: i, topicId: 42,
      userId: ALICE.id, privacyScope: 'private',
      text: `Alice msg ${i}`,
    }));
  }
  topicMemory.insertMessage(makeMsg({
    messageId: 4, topicId: 99,
    userId: ALICE.id, privacyScope: 'shared-project',
    text: 'Alice cross-topic',
  }));

  // Bob: 2 messages in topic 42
  for (let i = 5; i <= 6; i++) {
    topicMemory.insertMessage(makeMsg({
      messageId: i, topicId: 42,
      userId: BOB.id, privacyScope: 'private',
      text: `Bob msg ${i}`,
    }));
  }

  // Alice: 2 semantic entities
  semanticMemory.remember({
    type: 'fact', name: 'Alice Fact', content: 'Alice private knowledge',
    confidence: 0.9, lastVerified: new Date().toISOString(),
    source: `user:${ALICE.id}`, tags: ['test'],
    ownerId: ALICE.id, privacyScope: 'private',
  });
  semanticMemory.remember({
    type: 'lesson', name: 'Alice Lesson', content: 'Alice learned something',
    confidence: 0.8, lastVerified: new Date().toISOString(),
    source: `session:abc`, tags: ['learning'],
    ownerId: ALICE.id, privacyScope: 'private',
  });

  // Bob: 1 semantic entity
  semanticMemory.remember({
    type: 'fact', name: 'Bob Fact', content: 'Bob private knowledge',
    confidence: 0.9, lastVerified: new Date().toISOString(),
    source: `user:${BOB.id}`, tags: ['test'],
    ownerId: BOB.id, privacyScope: 'private',
  });

  // Shared entity (no owner)
  semanticMemory.remember({
    type: 'fact', name: 'Shared Fact', content: 'Everyone sees this',
    confidence: 0.95, lastVerified: new Date().toISOString(),
    source: 'agent:discovery', tags: ['shared'],
    privacyScope: 'shared-project',
  });
}

// ── /mydata Export ────────────────────────────────────────────────

describe('/mydata export', () => {
  beforeEach(seedData);

  it('exports all messages by user grouped by topic', () => {
    const result = exportUserData(ALICE.id, { topicMemory, semanticMemory });

    expect(result.userId).toBe(ALICE.id);
    expect(result.exportVersion).toBe('2.0');
    expect(result.messages).toHaveLength(2); // 2 topics (42 and 99)

    const topic42 = result.messages.find(m => m.topicId === 42);
    expect(topic42!.messageCount).toBe(3);

    const topic99 = result.messages.find(m => m.topicId === 99);
    expect(topic99!.messageCount).toBe(1);
  });

  it('exports semantic entities owned by user', () => {
    const result = exportUserData(ALICE.id, { topicMemory, semanticMemory });

    expect(result.knowledgeEntities).toHaveLength(2);
    expect(result.knowledgeEntities.map(e => e.name)).toContain('Alice Fact');
    expect(result.knowledgeEntities.map(e => e.name)).toContain('Alice Lesson');
  });

  it('CRITICAL: does not include other users\' data', () => {
    const result = exportUserData(ALICE.id, { topicMemory, semanticMemory });

    // No Bob messages
    const allMessages = result.messages.flatMap(t => t.messages);
    expect(allMessages.some(m => m.text.includes('Bob'))).toBe(false);

    // No Bob or shared entities
    expect(result.knowledgeEntities.some(e => e.name.includes('Bob'))).toBe(false);
    expect(result.knowledgeEntities.some(e => e.name === 'Shared Fact')).toBe(false);
  });

  it('handles missing stores gracefully', () => {
    const result = exportUserData(ALICE.id, {});
    expect(result.messages).toHaveLength(0);
    expect(result.knowledgeEntities).toHaveLength(0);
  });

  it('returns empty for non-existent user', () => {
    const result = exportUserData('nonexistent', { topicMemory, semanticMemory });
    expect(result.messages).toHaveLength(0);
    expect(result.knowledgeEntities).toHaveLength(0);
  });
});

// ── /forget Erasure ──────────────────────────────────────────────

describe('/forget erasure', () => {
  beforeEach(seedData);

  it('deletes all user messages and entities', () => {
    const result = eraseUserData(ALICE.id, { topicMemory, semanticMemory });

    expect(result.messagesDeleted).toBe(4); // 3 in topic 42 + 1 in topic 99
    expect(result.entitiesDeleted).toBe(2); // fact + lesson
  });

  it('CRITICAL: does not delete other users\' data', () => {
    eraseUserData(ALICE.id, { topicMemory, semanticMemory });

    // Bob's data untouched
    const bobMessages = topicMemory.getMessagesByUser(BOB.id);
    expect(bobMessages).toHaveLength(2);

    const bobEntities = semanticMemory.getEntitiesByUser(BOB.id);
    expect(bobEntities).toHaveLength(1);

    // Shared entity untouched
    const shared = semanticMemory.search('Everyone sees');
    expect(shared.length).toBeGreaterThan(0);
  });

  it('CRITICAL: erased data is unrecoverable via search', () => {
    eraseUserData(ALICE.id, { topicMemory, semanticMemory });

    // Cannot find Alice's data anymore
    expect(topicMemory.getMessagesByUser(ALICE.id)).toHaveLength(0);
    expect(semanticMemory.getEntitiesByUser(ALICE.id)).toHaveLength(0);
    expect(semanticMemory.search('Alice', { userId: ALICE.id })).toHaveLength(0);
  });

  it('idempotent — running /forget twice is safe', () => {
    const first = eraseUserData(ALICE.id, { topicMemory, semanticMemory });
    expect(first.messagesDeleted).toBe(4);
    expect(first.entitiesDeleted).toBe(2);

    const second = eraseUserData(ALICE.id, { topicMemory, semanticMemory });
    expect(second.messagesDeleted).toBe(0);
    expect(second.entitiesDeleted).toBe(0);
  });

  it('handles missing stores gracefully', () => {
    const result = eraseUserData(ALICE.id, {});
    expect(result.messagesDeleted).toBe(0);
    expect(result.entitiesDeleted).toBe(0);
  });
});

// ── Format Summaries ─────────────────────────────────────────────

describe('format summaries', () => {
  it('formatExportSummary shows message and entity counts', () => {
    seedData();
    const data = exportUserData(ALICE.id, { topicMemory, semanticMemory });
    const summary = formatExportSummary(data);

    expect(summary).toContain('alice');
    expect(summary).toContain('4'); // total messages
    expect(summary).toContain('2 topic'); // 2 topics
    expect(summary).toContain('2'); // entities
  });

  it('formatErasureSummary shows deletion counts', () => {
    seedData();
    const result = eraseUserData(ALICE.id, { topicMemory, semanticMemory });
    const summary = formatErasureSummary(result);

    expect(summary).toContain('alice');
    expect(summary).toContain('4'); // messages
    expect(summary).toContain('2'); // entities
  });
});

// ── Cross-store Consistency ──────────────────────────────────────

describe('cross-store consistency', () => {
  it('export then erase produces matching counts', () => {
    seedData();

    const exported = exportUserData(ALICE.id, { topicMemory, semanticMemory });
    const totalMessages = exported.messages.reduce((sum, t) => sum + t.messageCount, 0);

    const erased = eraseUserData(ALICE.id, { topicMemory, semanticMemory });

    expect(erased.messagesDeleted).toBe(totalMessages);
    expect(erased.entitiesDeleted).toBe(exported.knowledgeEntities.length);
  });

  it('export after erase returns empty', () => {
    seedData();
    eraseUserData(ALICE.id, { topicMemory, semanticMemory });

    const afterExport = exportUserData(ALICE.id, { topicMemory, semanticMemory });
    expect(afterExport.messages).toHaveLength(0);
    expect(afterExport.knowledgeEntities).toHaveLength(0);
  });
});
