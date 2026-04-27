/**
 * Unit tests for DropPickup — offline message ingestion.
 *
 * Tests:
 * - Picks up valid HMAC-signed messages from drop directory
 * - Rejects messages with invalid HMAC
 * - Rejects messages without HMAC
 * - Skips duplicate messages (already in store)
 * - Handles empty/missing drop directory
 * - Cleans up processed files
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { pickupDroppedMessages } from '../../src/messaging/DropPickup.js';
import { generateAgentToken, computeDropHmac } from '../../src/messaging/AgentTokenManager.js';
import type { MessageEnvelope } from '../../src/messaging/types.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-drop-test-'));
}

function makeEnvelope(overrides?: Partial<MessageEnvelope>): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: crypto.randomUUID(),
      from: { agent: 'sender-agent', session: 'test', machine: 'test-machine' },
      to: { agent: 'target-agent', session: 'best', machine: 'local' },
      type: 'info',
      priority: 'medium',
      subject: 'Dropped message',
      body: 'Left while you were away',
      createdAt: now,
      ttlMinutes: 30,
    },
    transport: {
      relayChain: [],
      originServer: 'http://localhost:3000',
      nonce: `${crypto.randomUUID()}:${now}`,
      timestamp: now,
    },
    delivery: {
      phase: 'queued',
      transitions: [
        { from: 'sent', to: 'queued', at: now, reason: 'drop: agent not registered' },
      ],
      attempts: 1,
    },
    ...overrides,
  };
}

describe('DropPickup', () => {
  let storeDir: string;
  let store: MessageStore;
  const targetAgent = 'target-agent';
  const senderAgent = 'sender-agent';

  beforeEach(async () => {
    storeDir = createTempDir();
    store = new MessageStore(storeDir);
    await store.initialize();

    // Ensure tokens exist for both agents
    generateAgentToken(senderAgent);
    generateAgentToken(targetAgent);
  });

  afterEach(async () => {
    await store.destroy();
    // safe-git-allow: incremental-migration
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  function dropDir(): string {
    return path.join(os.homedir(), '.instar', 'messages', 'drop', targetAgent);
  }

  function writeDrop(envelope: MessageEnvelope): void {
    const dir = dropDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${envelope.message.id}.json`),
      JSON.stringify(envelope),
      'utf-8',
    );
  }

  it('ingests a valid HMAC-signed message', async () => {
    const envelope = makeEnvelope();
    const senderToken = generateAgentToken(senderAgent);

    // Compute and attach HMAC
    envelope.transport.hmac = computeDropHmac(senderToken, {
      message: envelope.message,
      originServer: envelope.transport.originServer,
      nonce: envelope.transport.nonce,
      timestamp: envelope.transport.timestamp,
    });
    envelope.transport.hmacBy = senderAgent;

    writeDrop(envelope);

    const result = await pickupDroppedMessages(targetAgent, store);

    expect(result.ingested).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.duplicates).toBe(0);

    // Verify message is in store
    const stored = await store.get(envelope.message.id);
    expect(stored).not.toBeNull();
    expect(stored!.delivery.phase).toBe('received');

    // Verify file was cleaned up
    const files = fs.readdirSync(dropDir());
    expect(files.length).toBe(0);
  });

  it('rejects message with invalid HMAC', async () => {
    const envelope = makeEnvelope();
    envelope.transport.hmac = 'deadbeef'.repeat(8); // Wrong HMAC
    envelope.transport.hmacBy = senderAgent;

    writeDrop(envelope);

    const result = await pickupDroppedMessages(targetAgent, store);

    expect(result.ingested).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.rejections[0].reason).toContain('invalid HMAC');
  });

  it('rejects message without HMAC', async () => {
    const envelope = makeEnvelope();
    // No HMAC set

    writeDrop(envelope);

    const result = await pickupDroppedMessages(targetAgent, store);

    expect(result.ingested).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.rejections[0].reason).toContain('missing HMAC');
  });

  it('skips duplicate messages', async () => {
    const envelope = makeEnvelope();
    const senderToken = generateAgentToken(senderAgent);
    envelope.transport.hmac = computeDropHmac(senderToken, {
      message: envelope.message,
      originServer: envelope.transport.originServer,
      nonce: envelope.transport.nonce,
      timestamp: envelope.transport.timestamp,
    });
    envelope.transport.hmacBy = senderAgent;

    // Pre-save to store
    await store.save(envelope);

    // Write to drop directory (duplicate)
    writeDrop(envelope);

    const result = await pickupDroppedMessages(targetAgent, store);

    expect(result.ingested).toBe(0);
    expect(result.duplicates).toBe(1);
  });

  it('returns empty result when no drop directory exists', async () => {
    // Don't create any drop directory
    const result = await pickupDroppedMessages('nonexistent-agent', store);

    expect(result.ingested).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.duplicates).toBe(0);
  });

  it('handles malformed JSON files gracefully', async () => {
    const dir = dropDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'garbage.json'), 'not valid json{{{', 'utf-8');

    const result = await pickupDroppedMessages(targetAgent, store);

    expect(result.rejected).toBe(1);
    expect(result.rejections[0].reason).toContain('parse error');
  });

  it('processes multiple messages at once', async () => {
    const senderToken = generateAgentToken(senderAgent);

    for (let i = 0; i < 3; i++) {
      const envelope = makeEnvelope();
      envelope.transport.hmac = computeDropHmac(senderToken, {
        message: envelope.message,
        originServer: envelope.transport.originServer,
        nonce: envelope.transport.nonce,
        timestamp: envelope.transport.timestamp,
      });
      envelope.transport.hmacBy = senderAgent;
      writeDrop(envelope);
    }

    const result = await pickupDroppedMessages(targetAgent, store);

    expect(result.ingested).toBe(3);
    expect(result.rejected).toBe(0);
  });
});
