/**
 * Integration tests for Output Privacy Routing with TopicMemory and SemanticMemory.
 *
 * Tests the full pipeline: generate response → evaluate sensitivity → route decision.
 * Validates that the router correctly interacts with memory privacy scoping.
 *
 * Covers:
 *   1. Response using private memory → DM routing
 *   2. Response using shared memory → shared routing
 *   3. Mixed private/shared data in response
 *   4. Full pipeline: store → retrieve → respond → route
 *   5. GDPR export contents would trigger routing (meta-validation)
 *   6. OnboardingGate + OutputPrivacyRouter interaction
 *   7. Multiple users with interleaved sensitivity levels
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import type { TopicMessage } from '../../src/memory/TopicMemory.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import {
  evaluateResponseSensitivity,
  shouldRouteToDm,
  type RoutingContext,
} from '../../src/privacy/OutputPrivacyRouter.js';

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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-routing-integ-'));

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

// ── Helper: Simulate Response Generation ────────────────────────

/**
 * Simulates generating a response that incorporates memory data.
 * In production, the ChatPlanner would do this — here we just
 * combine memory context with a response template.
 */
function simulateResponse(
  template: string,
  memoryContext: string,
): string {
  return `${template}\n\nBased on your data: ${memoryContext}`;
}

// ── 1. Private Memory → DM Routing ─────────────────────────────

describe('private memory → DM routing', () => {
  it('response using private-scoped memory routes to DM', () => {
    // Store Alice's private data
    topicMemory.insertMessage(makeMsg({
      messageId: 1,
      topicId: 42,
      userId: ALICE.id,
      privacyScope: 'private',
      text: 'My API key is api_key = sk-test-12345',
    }));

    // Retrieve private context
    const context = topicMemory.formatContextForUser(42, ALICE.id);

    // Generate response incorporating private data
    const response = simulateResponse(
      'Here is your configuration:',
      context,
    );

    // Route decision: private memory was used
    const result = evaluateResponseSensitivity({
      responseText: response,
      usedPrivateMemory: true,
      sourceScopes: ['private'],
      isSharedTopic: true,
    });

    expect(result.route).toBe('dm');
    expect(result.triggers).toContain('private-memory-source');
    expect(result.triggers).toContain('private-scope-source');
  });

  it('private semantic memory triggers DM routing', () => {
    // Store private knowledge
    semanticMemory.remember({
      type: 'fact',
      name: 'Alice DB Password',
      content: 'password: supersecret123',
      confidence: 0.95,
      lastVerified: new Date().toISOString(),
      source: `user:${ALICE.id}`,
      tags: ['credentials'],
      ownerId: ALICE.id,
      privacyScope: 'private',
    });

    // Retrieve and generate response
    const entities = semanticMemory.getEntitiesByUser(ALICE.id);
    const response = `Your stored credential: ${entities[0].content}`;

    const result = evaluateResponseSensitivity({
      responseText: response,
      usedPrivateMemory: true,
      sourceScopes: ['private'],
      isSharedTopic: true,
    });

    expect(result.route).toBe('dm');
    // Both memory signal AND pattern match fire
    expect(result.triggers).toContain('private-memory-source');
    expect(result.triggers).toContain('password');
  });
});

// ── 2. Shared Memory → Shared Routing ──────────────────────────

describe('shared memory → shared routing', () => {
  it('response using only shared-project data stays in shared topic', () => {
    topicMemory.insertMessage(makeMsg({
      messageId: 1,
      topicId: 42,
      userId: ALICE.id,
      privacyScope: 'shared-project',
      text: 'The deployment is scheduled for Tuesday.',
    }));

    const context = topicMemory.formatContextForUser(42, ALICE.id);
    const response = simulateResponse(
      'Here is the project update:',
      context,
    );

    const result = evaluateResponseSensitivity({
      responseText: response,
      usedPrivateMemory: false,
      sourceScopes: ['shared-project'],
      isSharedTopic: true,
    });

    expect(result.route).toBe('shared');
  });

  it('shared semantic knowledge stays in shared topic', () => {
    semanticMemory.remember({
      type: 'fact',
      name: 'Project Deadline',
      content: 'The project deadline is March 15, 2026',
      confidence: 0.9,
      lastVerified: new Date().toISOString(),
      source: 'agent:planning',
      tags: ['project'],
      privacyScope: 'shared-project',
    });

    const response = 'The project deadline is March 15, 2026. Plan accordingly.';

    const result = evaluateResponseSensitivity({
      responseText: response,
      isSharedTopic: true,
    });

    expect(result.route).toBe('shared');
  });
});

// ── 3. Mixed Private/Shared Data ────────────────────────────────

describe('mixed private and shared data in response', () => {
  it('CRITICAL: response mixing private and shared data → routes to DM', () => {
    // Store both private and shared data
    topicMemory.insertMessage(makeMsg({
      messageId: 1, topicId: 42,
      userId: ALICE.id, privacyScope: 'shared-project',
      text: 'Team meeting at 3pm',
    }));
    topicMemory.insertMessage(makeMsg({
      messageId: 2, topicId: 42,
      userId: ALICE.id, privacyScope: 'private',
      text: 'My email is alice@secret.com',
    }));

    // Response incorporates both
    const response = 'Team meeting at 3pm. I also found alice@secret.com in your records.';

    const result = evaluateResponseSensitivity({
      responseText: response,
      usedPrivateMemory: true,
      sourceScopes: ['shared-project', 'private'],
      isSharedTopic: true,
    });

    // Private data presence → DM
    expect(result.route).toBe('dm');
    expect(result.triggers).toContain('email-address');
    expect(result.triggers).toContain('private-memory-source');
  });
});

// ── 4. Full Pipeline: Store → Retrieve → Respond → Route ───────

describe('full pipeline integration', () => {
  it('end-to-end: store private data, build response, verify routing', () => {
    // Step 1: Store user's sensitive data
    semanticMemory.remember({
      type: 'fact',
      name: 'Alice SSH Key',
      content: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...',
      confidence: 1.0,
      lastVerified: new Date().toISOString(),
      source: `user:${ALICE.id}`,
      tags: ['credential'],
      ownerId: ALICE.id,
      privacyScope: 'private',
    });

    // Step 2: Retrieve user's data (privacy-scoped)
    const entities = semanticMemory.search('SSH key', { userId: ALICE.id });
    expect(entities.length).toBeGreaterThan(0);

    // Step 3: Build response
    const response = `Here is your SSH key:\n${entities[0].content}`;

    // Step 4: Route decision
    const result = evaluateResponseSensitivity({
      responseText: response,
      usedPrivateMemory: true,
      sourceScopes: ['private'],
      isSharedTopic: true,
    });

    expect(result.route).toBe('dm');
    expect(result.triggers).toContain('ssh-key');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('end-to-end: shared data stays shared through full pipeline', () => {
    // Step 1: Store shared project data
    topicMemory.insertMessage(makeMsg({
      messageId: 1, topicId: 42,
      userId: ALICE.id, privacyScope: 'shared-project',
      text: 'Sprint review is Thursday at 2pm',
    }));

    // Step 2: Retrieve for context
    const context = topicMemory.formatContextForUser(42, ALICE.id);
    expect(context).toContain('Sprint review');

    // Step 3: Build response
    const response = `Reminder: Sprint review is Thursday at 2pm. Please prepare your updates.`;

    // Step 4: Route decision — no private data used
    const result = evaluateResponseSensitivity({
      responseText: response,
      usedPrivateMemory: false,
      isSharedTopic: true,
    });

    expect(result.route).toBe('shared');
  });
});

// ── 5. GDPR Export Meta-Validation ──────────────────────────────

describe('GDPR export sensitivity meta-validation', () => {
  it('GDPR export contents would trigger DM routing (validates export sensitivity)', () => {
    // This is a meta-test: GDPR exports contain sensitive data by definition.
    // If we were to send an export as a response, it MUST route to DM.

    const exportPayload = JSON.stringify({
      userId: ALICE.id,
      messages: [{ text: 'My password: secret123', topicId: 42 }],
      entities: [{ name: 'Alice Email', content: 'alice@private.org' }],
    });

    const result = evaluateResponseSensitivity({
      responseText: exportPayload,
      usedPrivateMemory: true,
      isSharedTopic: true,
    });

    expect(result.route).toBe('dm');
  });
});

// ── 6. Multi-User Interleaved Sensitivity ───────────────────────

describe('multi-user interleaved sensitivity', () => {
  it('Alice private response routes DM while Bob shared stays shared', () => {
    // Alice has private data
    topicMemory.insertMessage(makeMsg({
      messageId: 1, topicId: 42,
      userId: ALICE.id, privacyScope: 'private',
      text: 'Alice private note with api_key = sk-alice-key-123',
    }));

    // Bob has shared data
    topicMemory.insertMessage(makeMsg({
      messageId: 2, topicId: 42,
      userId: BOB.id, privacyScope: 'shared-project',
      text: 'Bob public status update',
    }));

    // Alice's response (from private memory)
    const aliceResponse = topicMemory.formatContextForUser(42, ALICE.id);
    const aliceResult = evaluateResponseSensitivity({
      responseText: `Response for Alice: ${aliceResponse}`,
      usedPrivateMemory: true,
      sourceScopes: ['private'],
      isSharedTopic: true,
    });

    // Bob's response (from shared memory)
    const bobResponse = topicMemory.formatContextForUser(42, BOB.id);
    const bobResult = evaluateResponseSensitivity({
      responseText: `Status update: ${bobResponse}`,
      usedPrivateMemory: false,
      sourceScopes: ['shared-project'],
      isSharedTopic: true,
    });

    expect(aliceResult.route).toBe('dm');
    expect(bobResult.route).toBe('shared');
  });

  it('CRITICAL: same topic, different users get correct routing', () => {
    // Both users in topic 42, but Alice's data is sensitive
    semanticMemory.remember({
      type: 'fact', name: 'Alice SSN',
      content: 'SSN: 123-45-6789',
      confidence: 1.0, lastVerified: new Date().toISOString(),
      source: `user:${ALICE.id}`, tags: ['pii'],
      ownerId: ALICE.id, privacyScope: 'private',
    });

    semanticMemory.remember({
      type: 'fact', name: 'Bob Preference',
      content: 'Bob prefers dark mode',
      confidence: 0.9, lastVerified: new Date().toISOString(),
      source: `user:${BOB.id}`, tags: ['preference'],
      ownerId: BOB.id, privacyScope: 'shared-project',
    });

    // Response for Alice (includes SSN)
    const aliceEntities = semanticMemory.getEntitiesByUser(ALICE.id);
    const aliceResponse = `Your records show: ${aliceEntities.map(e => e.content).join(', ')}`;

    // Response for Bob (includes preference)
    const bobEntities = semanticMemory.getEntitiesByUser(BOB.id);
    const bobResponse = `Your settings: ${bobEntities.map(e => e.content).join(', ')}`;

    const aliceRouting = evaluateResponseSensitivity({
      responseText: aliceResponse,
      usedPrivateMemory: true,
      sourceScopes: ['private'],
      isSharedTopic: true,
    });

    const bobRouting = evaluateResponseSensitivity({
      responseText: bobResponse,
      usedPrivateMemory: false,
      sourceScopes: ['shared-project'],
      isSharedTopic: true,
    });

    expect(aliceRouting.route).toBe('dm');
    expect(aliceRouting.triggers).toContain('ssn');
    expect(bobRouting.route).toBe('shared');
  });
});

// ── 7. Convenience Wrapper with Memory Context ──────────────────

describe('shouldRouteToDm with memory context', () => {
  it('convenience wrapper works with memory-sourced responses', () => {
    semanticMemory.remember({
      type: 'fact', name: 'Alice CC',
      content: 'Card: 4111 1111 1111 1111',
      confidence: 1.0, lastVerified: new Date().toISOString(),
      source: `user:${ALICE.id}`, tags: ['financial'],
      ownerId: ALICE.id, privacyScope: 'private',
    });

    const entities = semanticMemory.getEntitiesByUser(ALICE.id);
    const response = entities.map(e => e.content).join('\n');

    expect(shouldRouteToDm(response, {
      usedPrivateMemory: true,
      isSharedTopic: true,
    })).toBe(true);
  });

  it('non-sensitive shared data returns false', () => {
    topicMemory.insertMessage(makeMsg({
      messageId: 1, topicId: 42,
      userId: ALICE.id, privacyScope: 'shared-project',
      text: 'Next standup at 10am',
    }));

    const context = topicMemory.formatContextForUser(42, ALICE.id);
    expect(shouldRouteToDm(context, {
      usedPrivateMemory: false,
      isSharedTopic: true,
    })).toBe(false);
  });
});
