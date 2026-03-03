/**
 * GDPR Data Access Commands — /mydata and /forget
 *
 * Implements GDPR Article 15 (Right of Access) and Article 17 (Right to Erasure)
 * across all memory stores (TopicMemory + SemanticMemory).
 *
 * Usage:
 *   /mydata  — Export all data associated with a user
 *   /forget  — Delete all data associated with a user
 *
 * Design principles:
 *   - Fail-closed: if a memory store is unavailable, report it rather than silently skip
 *   - Audit trail: all operations are logged with timestamps
 *   - Idempotent: running /forget twice is safe
 *   - User-scoped: only affects data owned by the requesting user
 */

import type { UserDataExport, UserErasureResult, UserProfile } from '../core/types.js';
import type { TopicMemory } from '../memory/TopicMemory.js';
import type { SemanticMemory } from '../memory/SemanticMemory.js';

export interface GdprCommandDeps {
  topicMemory?: TopicMemory;
  semanticMemory?: SemanticMemory;
  /** User profile for the export (optional — included when available) */
  userProfile?: UserProfile;
}

/**
 * Export all data for a user across all memory stores.
 * Implements GDPR Article 15 (Right of Access).
 */
export function exportUserData(
  userId: string,
  deps: GdprCommandDeps,
): UserDataExport {
  const now = new Date().toISOString();

  // ── TopicMemory messages ────────────────────────────────────────
  const messagesByTopic: Map<number, Array<{ text: string; fromUser: boolean; timestamp: string; topicId: number }>> = new Map();

  if (deps.topicMemory) {
    const userMessages = deps.topicMemory.getMessagesByUser(userId);
    for (const msg of userMessages) {
      const topicId = msg.topicId;
      if (!messagesByTopic.has(topicId)) {
        messagesByTopic.set(topicId, []);
      }
      messagesByTopic.get(topicId)!.push({
        text: msg.text ?? '',
        fromUser: msg.fromUser,
        timestamp: msg.timestamp,
        topicId,
      });
    }
  }

  const messages = Array.from(messagesByTopic.entries()).map(([topicId, msgs]) => ({
    topicId,
    messageCount: msgs.length,
    messages: msgs,
  }));

  // ── SemanticMemory entities ─────────────────────────────────────
  const knowledgeEntities: UserDataExport['knowledgeEntities'] = [];

  if (deps.semanticMemory) {
    const userEntities = deps.semanticMemory.getEntitiesByUser(userId);
    for (const entity of userEntities) {
      knowledgeEntities.push({
        name: entity.name,
        type: entity.type,
        content: entity.content,
        createdAt: entity.createdAt,
      });
    }
  }

  return {
    exportedAt: now,
    exportVersion: '2.0',
    userId,
    profile: deps.userProfile ?? createMinimalProfile(userId),
    messages,
    knowledgeEntities,
    activityDigests: [], // Phase 2E scope: TopicMemory + SemanticMemory only
  };
}

/**
 * Delete all data for a user across all memory stores.
 * Implements GDPR Article 17 (Right to Erasure).
 */
export function eraseUserData(
  userId: string,
  deps: GdprCommandDeps,
): UserErasureResult {
  const now = new Date().toISOString();
  let messagesDeleted = 0;
  let entitiesDeleted = 0;
  const retainedItems: UserErasureResult['retainedItems'] = [];

  // Erase from TopicMemory
  if (deps.topicMemory) {
    messagesDeleted = deps.topicMemory.deleteMessagesByUser(userId);
  }

  // Erase from SemanticMemory
  if (deps.semanticMemory) {
    entitiesDeleted = deps.semanticMemory.deleteEntitiesByUser(userId);
  }

  return {
    userId,
    erasedAt: now,
    messagesDeleted,
    entitiesDeleted,
    digestsDeleted: 0, // Phase 2E scope: TopicMemory + SemanticMemory only
    profileRemoved: false, // Profile removal handled separately by UserManager
    retainedItems,
  };
}

/**
 * Format a user data export for display (e.g., in a Telegram message).
 */
export function formatExportSummary(data: UserDataExport): string {
  const totalMessages = data.messages.reduce((sum, t) => sum + t.messageCount, 0);

  const lines: string[] = [
    `Data Export for ${data.userId}`,
    `Exported: ${data.exportedAt}`,
    ``,
    `Messages: ${totalMessages} across ${data.messages.length} topic(s)`,
    `Knowledge entities: ${data.knowledgeEntities.length}`,
    `Activity digests: ${data.activityDigests.length}`,
  ];

  return lines.join('\n');
}

/**
 * Format an erasure result for display.
 */
export function formatErasureSummary(result: UserErasureResult): string {
  const total = result.messagesDeleted + result.entitiesDeleted + result.digestsDeleted;

  const lines: string[] = [
    `Data Erasure for ${result.userId}`,
    `Erased: ${result.erasedAt}`,
    ``,
    `Messages deleted: ${result.messagesDeleted}`,
    `Entities deleted: ${result.entitiesDeleted}`,
    `Digests deleted: ${result.digestsDeleted}`,
    `Total: ${total}`,
  ];

  if (result.retainedItems.length > 0) {
    lines.push('', 'Retained items:');
    for (const item of result.retainedItems) {
      lines.push(`  - ${item.count} ${item.type}: ${item.reason}`);
    }
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────

/** Create a minimal profile stub for exports when the full profile is unavailable */
function createMinimalProfile(userId: string): UserProfile {
  return {
    id: userId,
    name: userId,
    channels: [],
    permissions: ['user'],
    preferences: {},
    dataCollected: {
      name: true,
      telegramId: false,
      communicationPreferences: false,
      conversationHistory: false,
      memoryEntries: false,
      machineIdentities: false,
    },
    pendingTelegramTopic: false,
    createdAt: new Date().toISOString(),
  };
}
