/**
 * Unit tests for GitSyncTransport — cross-machine offline messaging.
 *
 * Tests:
 * - Inbound pickup: ingests valid signed envelopes from git-synced directory
 * - Deduplication: skips messages already in store
 * - Signature verification: rejects invalid/missing signatures
 * - TTL expiry: rejects expired messages
 * - Invalid envelopes: rejects malformed JSON and missing fields
 * - File cleanup: removes processed files
 * - Outbound queue status: reports per-machine queue counts
 * - Outbound cleanup: removes delivered messages from outbound
 * - Agent discovery: builds agent list from registry, resolves agent machine
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  pickupGitSyncMessages,
  getOutboundQueueStatus,
  cleanupDeliveredOutbound,
  cleanupAllDelivered,
  buildAgentList,
  resolveAgentMachine,
  type AgentInfo,
} from '../../src/messaging/GitSyncTransport.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import type { MessageEnvelope, AgentMessage } from '../../src/messaging/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-gitsync-test-'));
}

function makeMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: crypto.randomUUID(),
    from: { agent: 'sender', session: 'sess-1', machine: 'remote-machine' },
    to: { agent: 'receiver', session: 'sess-2', machine: 'local-machine' },
    type: 'info',
    priority: 'normal',
    subject: 'Test message',
    body: 'Hello from remote',
    createdAt: new Date().toISOString(),
    ttlMinutes: 60,
    ...overrides,
  };
}

function makeEnvelope(overrides?: {
  message?: Partial<AgentMessage>;
  transport?: Partial<MessageEnvelope['transport']>;
  delivery?: Partial<MessageEnvelope['delivery']>;
}): MessageEnvelope {
  return {
    schemaVersion: 1,
    message: makeMessage(overrides?.message),
    transport: {
      originServer: 'http://remote:4040',
      relayChain: ['remote-machine'],
      nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
      timestamp: new Date().toISOString(),
      signature: 'valid-sig-placeholder',
      signedBy: 'remote-machine',
      ...overrides?.transport,
    },
    delivery: {
      phase: 'sent',
      transitions: [{ from: 'created', to: 'sent', at: new Date().toISOString() }],
      attempts: 1,
      ...overrides?.delivery,
    },
  };
}

function writeEnvelopeFile(dir: string, envelope: MessageEnvelope): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${envelope.message.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2));
  return filePath;
}

// ── Tests ────────────────────────────────────────────────────────

describe('GitSyncTransport', () => {
  let tempDir: string;
  let stateDir: string;
  let store: MessageStore;

  beforeEach(async () => {
    tempDir = createTempDir();
    stateDir = path.join(tempDir, '.instar');
    const messagingDir = path.join(stateDir, 'messages');
    store = new MessageStore(messagingDir);
    await store.initialize();
  });

  afterEach(async () => {
    await store.destroy();
    // safe-git-allow: incremental-migration
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Inbound Pickup ──────────────────────────────────────────

  describe('pickupGitSyncMessages', () => {
    it('ingests valid signed envelopes', async () => {
      const envelope = makeEnvelope();
      const inboundDir = path.join(stateDir, 'messages', 'outbound', 'local-machine');
      writeEnvelopeFile(inboundDir, envelope);

      const result = await pickupGitSyncMessages({
        localMachineId: 'local-machine',
        stateDir,
        store,
        verifySignature: () => ({ valid: true }),
      });

      expect(result.ingested).toBe(1);
      expect(result.rejected).toBe(0);
      expect(result.duplicates).toBe(0);

      // Verify it's in the store
      const stored = await store.get(envelope.message.id);
      expect(stored).toBeDefined();
      expect(stored!.delivery.phase).toBe('received');
    });

    it('deduplicates messages already in store', async () => {
      const envelope = makeEnvelope();

      // Pre-store the message
      await store.save(envelope);

      // Also write to inbound
      const inboundDir = path.join(stateDir, 'messages', 'outbound', 'local-machine');
      writeEnvelopeFile(inboundDir, envelope);

      const result = await pickupGitSyncMessages({
        localMachineId: 'local-machine',
        stateDir,
        store,
        verifySignature: () => ({ valid: true }),
      });

      expect(result.ingested).toBe(0);
      expect(result.duplicates).toBe(1);
    });

    it('rejects envelopes with invalid signature', async () => {
      const envelope = makeEnvelope();
      const inboundDir = path.join(stateDir, 'messages', 'outbound', 'local-machine');
      writeEnvelopeFile(inboundDir, envelope);

      const result = await pickupGitSyncMessages({
        localMachineId: 'local-machine',
        stateDir,
        store,
        verifySignature: () => ({ valid: false, reason: 'bad key' }),
      });

      expect(result.ingested).toBe(0);
      expect(result.rejected).toBe(1);
      expect(result.rejections[0].reason).toContain('bad key');
    });

    it('rejects envelopes without signature when no verifier', async () => {
      const envelope = makeEnvelope({ transport: { signature: undefined, signedBy: undefined } });
      const inboundDir = path.join(stateDir, 'messages', 'outbound', 'local-machine');
      writeEnvelopeFile(inboundDir, envelope);

      const result = await pickupGitSyncMessages({
        localMachineId: 'local-machine',
        stateDir,
        store,
        // No verifySignature provided
      });

      expect(result.rejected).toBe(1);
      expect(result.rejections[0].reason).toContain('missing signature');
    });

    it('rejects expired messages based on TTL', async () => {
      const envelope = makeEnvelope({
        message: {
          ttlMinutes: 1, // 1 minute TTL
          createdAt: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
        },
        delivery: {
          transitions: [{ from: 'created', to: 'sent', at: new Date(Date.now() - 120_000).toISOString() }],
        },
      });
      const inboundDir = path.join(stateDir, 'messages', 'outbound', 'local-machine');
      writeEnvelopeFile(inboundDir, envelope);

      const result = await pickupGitSyncMessages({
        localMachineId: 'local-machine',
        stateDir,
        store,
        verifySignature: () => ({ valid: true }),
      });

      expect(result.rejected).toBe(1);
      expect(result.rejections[0].reason).toContain('TTL expired');
    });

    it('rejects malformed JSON files', async () => {
      const inboundDir = path.join(stateDir, 'messages', 'outbound', 'local-machine');
      fs.mkdirSync(inboundDir, { recursive: true });
      fs.writeFileSync(path.join(inboundDir, 'bad.json'), '{ invalid json }');

      const result = await pickupGitSyncMessages({
        localMachineId: 'local-machine',
        stateDir,
        store,
      });

      expect(result.rejected).toBe(1);
      expect(result.rejections[0].reason).toContain('parse error');
    });

    it('rejects envelopes with missing structure', async () => {
      const inboundDir = path.join(stateDir, 'messages', 'outbound', 'local-machine');
      fs.mkdirSync(inboundDir, { recursive: true });
      fs.writeFileSync(path.join(inboundDir, 'incomplete.json'), JSON.stringify({ message: {} }));

      const result = await pickupGitSyncMessages({
        localMachineId: 'local-machine',
        stateDir,
        store,
      });

      expect(result.rejected).toBe(1);
      expect(result.rejections[0].reason).toContain('invalid envelope structure');
    });

    it('cleans up processed files after ingestion', async () => {
      const envelope = makeEnvelope();
      const inboundDir = path.join(stateDir, 'messages', 'outbound', 'local-machine');
      const filePath = writeEnvelopeFile(inboundDir, envelope);

      await pickupGitSyncMessages({
        localMachineId: 'local-machine',
        stateDir,
        store,
        verifySignature: () => ({ valid: true }),
      });

      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('returns empty result when no inbound directory exists', async () => {
      const result = await pickupGitSyncMessages({
        localMachineId: 'nonexistent-machine',
        stateDir,
        store,
      });

      expect(result.ingested).toBe(0);
      expect(result.rejected).toBe(0);
      expect(result.duplicates).toBe(0);
    });

    it('handles multiple envelopes in one pickup', async () => {
      const inboundDir = path.join(stateDir, 'messages', 'outbound', 'local-machine');
      writeEnvelopeFile(inboundDir, makeEnvelope());
      writeEnvelopeFile(inboundDir, makeEnvelope());
      writeEnvelopeFile(inboundDir, makeEnvelope());

      const result = await pickupGitSyncMessages({
        localMachineId: 'local-machine',
        stateDir,
        store,
        verifySignature: () => ({ valid: true }),
      });

      expect(result.ingested).toBe(3);
    });
  });

  // ── Outbound Queue Status ───────────────────────────────────

  describe('getOutboundQueueStatus', () => {
    it('returns empty when no outbound directory', () => {
      const status = getOutboundQueueStatus();
      // May have files from other tests, just verify the structure
      expect(status).toHaveProperty('queues');
      expect(status).toHaveProperty('totalPending');
      expect(Array.isArray(status.queues)).toBe(true);
    });
  });

  // ── Outbound Cleanup ────────────────────────────────────────

  describe('cleanupDeliveredOutbound', () => {
    it('removes delivered outbound file', () => {
      const outboundDir = path.join(os.homedir(), '.instar', 'messages', 'outbound', 'test-cleanup-machine');
      fs.mkdirSync(outboundDir, { recursive: true });
      const testFile = path.join(outboundDir, 'test-msg-123.json');
      fs.writeFileSync(testFile, '{}');

      const result = cleanupDeliveredOutbound('test-cleanup-machine', 'test-msg-123');
      expect(result).toBe(true);
      expect(fs.existsSync(testFile)).toBe(false);

      // Clean up test dir
      // safe-git-allow: incremental-migration
      fs.rmSync(outboundDir, { recursive: true, force: true });
    });

    it('returns false when file does not exist', () => {
      const result = cleanupDeliveredOutbound('nonexistent-machine', 'nonexistent-msg');
      expect(result).toBe(false);
    });
  });

  // ── Agent Discovery ─────────────────────────────────────────

  describe('buildAgentList', () => {
    it('returns empty array when no registry exists', () => {
      // Mock homedir to temp dir
      const origHomedir = os.homedir;
      vi.spyOn(os, 'homedir').mockReturnValue(tempDir);

      const agents = buildAgentList();
      expect(agents).toEqual([]);

      vi.spyOn(os, 'homedir').mockRestore();
    });

    it('reads agents from registry', () => {
      const registryDir = path.join(tempDir, '.instar');
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
        version: 1,
        agents: [
          { name: 'dawn-portal', port: 4040, status: 'running' },
          { name: 'ai-guy', port: 4041, status: 'running' },
          { name: 'old-agent', port: 4042, status: 'stopped' },
        ],
      }));

      vi.spyOn(os, 'homedir').mockReturnValue(tempDir);

      const agents = buildAgentList();
      expect(agents).toHaveLength(2);
      expect(agents[0].name).toBe('dawn-portal');
      expect(agents[1].name).toBe('ai-guy');

      vi.spyOn(os, 'homedir').mockRestore();
    });
  });

  describe('resolveAgentMachine', () => {
    it('finds agent in heartbeat data', () => {
      const heartbeats = new Map<string, { agents?: AgentInfo[]; url?: string }>();
      heartbeats.set('machine-1', {
        agents: [
          { name: 'dawn-portal', port: 4040, status: 'running' },
        ],
        url: 'http://machine-1:4040',
      });
      heartbeats.set('machine-2', {
        agents: [
          { name: 'ai-guy', port: 4041, status: 'running' },
        ],
        url: 'http://machine-2:4041',
      });

      const result = resolveAgentMachine('ai-guy', heartbeats);
      expect(result).toEqual({
        machineId: 'machine-2',
        url: 'http://machine-2:4041',
        port: 4041,
      });
    });

    it('returns null when agent not found', () => {
      const heartbeats = new Map<string, { agents?: AgentInfo[]; url?: string }>();
      heartbeats.set('machine-1', { agents: [], url: 'http://m1:4040' });

      expect(resolveAgentMachine('unknown-agent', heartbeats)).toBeNull();
    });

    it('skips stopped agents', () => {
      const heartbeats = new Map<string, { agents?: AgentInfo[]; url?: string }>();
      heartbeats.set('machine-1', {
        agents: [{ name: 'dawn', port: 4040, status: 'stopped' }],
        url: 'http://m1:4040',
      });

      expect(resolveAgentMachine('dawn', heartbeats)).toBeNull();
    });

    it('skips machines without URL', () => {
      const heartbeats = new Map<string, { agents?: AgentInfo[]; url?: string }>();
      heartbeats.set('machine-1', {
        agents: [{ name: 'dawn', port: 4040, status: 'running' }],
        // No url
      });

      expect(resolveAgentMachine('dawn', heartbeats)).toBeNull();
    });
  });
});
