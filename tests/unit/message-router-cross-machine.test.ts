/**
 * Unit tests for MessageRouter — cross-machine routing with Ed25519 signatures.
 *
 * Tests:
 * - Cross-machine routing with Ed25519 signing
 * - Outbound queue for offline machines
 * - Relay signature verification (valid + invalid)
 * - Clock skew rejection
 * - Unknown/revoked machine rejection
 * - Canonical JSON determinism
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageRouter, canonicalJSON } from '../../src/messaging/MessageRouter.js';
import type { CrossMachineDeps } from '../../src/messaging/MessageRouter.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { sign, verify, generateSigningKeyPair } from '../../src/core/MachineIdentity.js';
import type { MessageEnvelope, SignedPayload } from '../../src/messaging/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-crossmachine-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

function createMockTmuxOps() {
  return {
    getForegroundProcess: vi.fn().mockReturnValue('bash'),
    isSessionAlive: vi.fn().mockReturnValue(true),
    hasActiveHumanInput: vi.fn().mockReturnValue(false),
    sendKeys: vi.fn().mockReturnValue(true),
    getOutputLineCount: vi.fn().mockReturnValue(100),
  };
}

/** Create a mock MachineIdentityManager */
function createMockIdentityManager(opts: {
  localMachineId: string;
  activeMachines: string[];
  machineUrls: Record<string, string>;
  machineKeys: Record<string, { publicPem: string; privatePem: string }>;
}) {
  return {
    isMachineActive: vi.fn((id: string) => opts.activeMachines.includes(id)),
    getMachineUrl: vi.fn((id: string) => opts.machineUrls[id] ?? null),
    getSigningPublicKeyPem: vi.fn((id: string) => opts.machineKeys[id]?.publicPem ?? null),
    loadIdentity: vi.fn(() => ({ machineId: opts.localMachineId })),
    loadSigningKey: vi.fn(() => opts.machineKeys[opts.localMachineId]?.privatePem ?? ''),
    loadRegistry: vi.fn(),
    saveRegistry: vi.fn(),
    updateMachineUrl: vi.fn(),
    touchMachine: vi.fn(),
  } as any;
}

function createMockNonceStore() {
  return {
    validate: vi.fn().mockReturnValue({ valid: true }),
    getNextSequence: vi.fn().mockReturnValue(0),
    initialize: vi.fn(),
    destroy: vi.fn(),
  } as any;
}

function createMockSecurityLog() {
  const events: any[] = [];
  return {
    append: vi.fn((event: any) => events.push(event)),
    events,
  } as any;
}

function signEnvelope(envelope: MessageEnvelope, privateKeyPem: string, machineId: string): void {
  const signedPayload: SignedPayload = {
    message: envelope.message,
    relayChain: envelope.transport.relayChain,
    originServer: envelope.transport.originServer,
    nonce: envelope.transport.nonce,
    timestamp: envelope.transport.timestamp,
  };
  envelope.transport.signature = sign(canonicalJSON(signedPayload), privateKeyPem);
  envelope.transport.signedBy = machineId;
}

function createEnvelope(overrides?: Partial<{ from: any; to: any; relayChain: string[] }>): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: crypto.randomUUID(),
      from: overrides?.from ?? { agent: 'remote-agent', session: 'rs', machine: 'remote-machine' },
      to: overrides?.to ?? { agent: 'local-agent', session: 'best', machine: 'local' },
      type: 'info',
      priority: 'medium',
      subject: 'Test message',
      body: 'Test body',
      createdAt: now,
      ttlMinutes: 30,
    },
    transport: {
      relayChain: overrides?.relayChain ?? ['remote-machine'],
      originServer: 'http://remote:6060',
      nonce: `${crypto.randomUUID()}:${now}`,
      timestamp: now,
    },
    delivery: {
      phase: 'sent',
      transitions: [{ from: 'created', to: 'sent', at: now }],
      attempts: 0,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('MessageRouter — Cross-Machine', () => {
  let tmpDir: string;
  let store: MessageStore;
  let delivery: MessageDelivery;

  // Ed25519 key pairs for local and remote machines
  let localKeys: { publicKey: string; privateKey: string };
  let remoteKeys: { publicKey: string; privateKey: string };

  const LOCAL_MACHINE = 'm_local_machine_001';
  const REMOTE_MACHINE = 'm_remote_machine_002';

  beforeEach(async () => {
    tmpDir = createTempDir();
    store = new MessageStore(tmpDir);
    await store.initialize();

    const formatter = new MessageFormatter();
    delivery = new MessageDelivery(formatter, createMockTmuxOps() as any);

    localKeys = generateSigningKeyPair();
    remoteKeys = generateSigningKeyPair();
  });

  afterEach(async () => {
    await store.destroy();
    cleanup(tmpDir);
  });

  function createRouterWithCrossMachine(opts?: {
    machineUrls?: Record<string, string>;
    activeMachines?: string[];
  }): MessageRouter {
    const machineKeys: Record<string, { publicPem: string; privatePem: string }> = {
      [LOCAL_MACHINE]: { publicPem: localKeys.publicKey, privatePem: localKeys.privateKey },
      [REMOTE_MACHINE]: { publicPem: remoteKeys.publicKey, privatePem: remoteKeys.privateKey },
    };

    const identityManager = createMockIdentityManager({
      localMachineId: LOCAL_MACHINE,
      activeMachines: opts?.activeMachines ?? [LOCAL_MACHINE, REMOTE_MACHINE],
      machineUrls: opts?.machineUrls ?? { [REMOTE_MACHINE]: 'https://remote.tunnel.dev' },
      machineKeys,
    });

    const crossMachineDeps: CrossMachineDeps = {
      identityManager,
      signingKeyPem: localKeys.privateKey,
      nonceStore: createMockNonceStore(),
      securityLog: createMockSecurityLog(),
    };

    return new MessageRouter(store, delivery, {
      localAgent: 'local-agent',
      localMachine: LOCAL_MACHINE,
      serverUrl: 'http://localhost:6060',
    }, crossMachineDeps);
  }

  // ── Cross-Machine Send ─────────────────────────────────────────

  describe('cross-machine send', () => {
    it('signs envelope when sending cross-machine', async () => {
      // Mock fetch to simulate successful relay
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({ ok: true });

      try {
        const router = createRouterWithCrossMachine();
        const result = await router.send(
          { agent: 'local-agent', session: 'ls', machine: LOCAL_MACHINE },
          { agent: 'remote-agent', session: 'best', machine: REMOTE_MACHINE },
          'info',
          'medium',
          'Cross-machine test',
          'Hello from local machine',
        );

        expect(result.phase).toBe('received');

        // Verify the envelope was signed
        const envelope = await store.get(result.messageId);
        expect(envelope!.transport.signature).toBeDefined();
        expect(envelope!.transport.signedBy).toBe(LOCAL_MACHINE);
        expect(envelope!.transport.relayChain).toContain(LOCAL_MACHINE);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('queues to outbound when remote machine has no URL', async () => {
      const router = createRouterWithCrossMachine({ machineUrls: {} }); // No URLs

      const result = await router.send(
        { agent: 'local-agent', session: 'ls', machine: LOCAL_MACHINE },
        { agent: 'remote-agent', session: 'best', machine: REMOTE_MACHINE },
        'info',
        'medium',
        'Offline cross-machine',
        'This should go to outbound queue',
      );

      expect(result.phase).toBe('queued');

      // Verify outbound file exists
      const outboundDir = path.join(os.homedir(), '.instar', 'messages', 'outbound', REMOTE_MACHINE);
      const outboundFile = path.join(outboundDir, `${result.messageId}.json`);
      expect(fs.existsSync(outboundFile)).toBe(true);

      // Cleanup outbound
      // safe-git-allow: incremental-migration
      fs.rmSync(outboundFile, { force: true });
      // safe-git-allow: incremental-migration
      try { fs.rmdirSync(outboundDir); } catch { /* ignore */ }
      // safe-git-allow: incremental-migration
      try { fs.rmdirSync(path.join(os.homedir(), '.instar', 'messages', 'outbound')); } catch { /* ignore */ }
    });

    it('fails when target machine is not active', async () => {
      const router = createRouterWithCrossMachine({
        activeMachines: [LOCAL_MACHINE], // Remote not active
      });

      const result = await router.send(
        { agent: 'local-agent', session: 'ls', machine: LOCAL_MACHINE },
        { agent: 'remote-agent', session: 'best', machine: REMOTE_MACHINE },
        'info',
        'medium',
        'Unknown machine',
        'This should fail',
      );

      expect(result.phase).toBe('failed');
    });

    it('queues to outbound when HTTP relay fails', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      try {
        const router = createRouterWithCrossMachine();
        const result = await router.send(
          { agent: 'local-agent', session: 'ls', machine: LOCAL_MACHINE },
          { agent: 'remote-agent', session: 'best', machine: REMOTE_MACHINE },
          'info',
          'medium',
          'Relay fail test',
          'This should be queued',
        );

        expect(result.phase).toBe('queued');

        // Cleanup outbound
        const outboundDir = path.join(os.homedir(), '.instar', 'messages', 'outbound', REMOTE_MACHINE);
        const outboundFile = path.join(outboundDir, `${result.messageId}.json`);
        // safe-git-allow: incremental-migration
        fs.rmSync(outboundFile, { force: true });
        // safe-git-allow: incremental-migration
        try { fs.rmdirSync(outboundDir); } catch { /* ignore */ }
        // safe-git-allow: incremental-migration
        try { fs.rmdirSync(path.join(os.homedir(), '.instar', 'messages', 'outbound')); } catch { /* ignore */ }
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // ── Relay Signature Verification ───────────────────────────────

  describe('relay — machine source', () => {
    it('accepts a validly signed envelope', async () => {
      const router = createRouterWithCrossMachine();
      const envelope = createEnvelope();

      // Sign with remote machine's key
      signEnvelope(envelope, remoteKeys.privateKey, REMOTE_MACHINE);

      const result = await router.relay(envelope, 'machine');
      expect(result).toBe(true);

      const stored = await store.get(envelope.message.id);
      expect(stored).not.toBeNull();
      expect(stored!.delivery.phase).toBe('received');
    });

    it('rejects envelope with missing signature', async () => {
      const router = createRouterWithCrossMachine();
      const envelope = createEnvelope();
      // No signature set

      const result = await router.relay(envelope, 'machine');
      expect(result).toBe(false);
    });

    it('rejects envelope with invalid signature', async () => {
      const router = createRouterWithCrossMachine();
      const envelope = createEnvelope();

      // Sign with WRONG key (local key instead of remote)
      signEnvelope(envelope, localKeys.privateKey, REMOTE_MACHINE);

      const result = await router.relay(envelope, 'machine');
      expect(result).toBe(false);
    });

    it('rejects envelope signed by unknown machine', async () => {
      const unknownKeys = generateSigningKeyPair();
      const router = createRouterWithCrossMachine({
        activeMachines: [LOCAL_MACHINE], // Only local is active
      });
      const envelope = createEnvelope();
      signEnvelope(envelope, unknownKeys.privateKey, REMOTE_MACHINE);

      const result = await router.relay(envelope, 'machine');
      expect(result).toBe(false);
    });

    it('rejects envelope with timestamp outside clock skew tolerance', async () => {
      const router = createRouterWithCrossMachine();
      const envelope = createEnvelope();

      // Set timestamp 10 minutes in the past (tolerance is 5 min)
      const oldTimestamp = new Date(Date.now() - 10 * 60_000).toISOString();
      envelope.transport.timestamp = oldTimestamp;

      // Sign with remote key (valid signature, but old timestamp)
      signEnvelope(envelope, remoteKeys.privateKey, REMOTE_MACHINE);

      const result = await router.relay(envelope, 'machine');
      expect(result).toBe(false);
    });

    it('accepts envelope from agent source without signature', async () => {
      const router = createRouterWithCrossMachine();
      const envelope = createEnvelope();
      // No signature — but source is 'agent' (same machine), so no sig needed

      const result = await router.relay(envelope, 'agent');
      expect(result).toBe(true);
    });

    it('rejects cross-machine relay when crossMachine deps not configured', async () => {
      // Router without cross-machine deps
      const router = new MessageRouter(store, delivery, {
        localAgent: 'local-agent',
        localMachine: LOCAL_MACHINE,
        serverUrl: 'http://localhost:6060',
      });
      const envelope = createEnvelope();
      signEnvelope(envelope, remoteKeys.privateKey, REMOTE_MACHINE);

      const result = await router.relay(envelope, 'machine');
      expect(result).toBe(false);
    });

    it('logs security events for invalid signatures', async () => {
      const securityLog = createMockSecurityLog();
      const machineKeys: Record<string, { publicPem: string; privatePem: string }> = {
        [LOCAL_MACHINE]: { publicPem: localKeys.publicKey, privatePem: localKeys.privateKey },
        [REMOTE_MACHINE]: { publicPem: remoteKeys.publicKey, privatePem: remoteKeys.privateKey },
      };
      const identityManager = createMockIdentityManager({
        localMachineId: LOCAL_MACHINE,
        activeMachines: [LOCAL_MACHINE, REMOTE_MACHINE],
        machineUrls: {},
        machineKeys,
      });

      const router = new MessageRouter(store, delivery, {
        localAgent: 'local-agent',
        localMachine: LOCAL_MACHINE,
        serverUrl: 'http://localhost:6060',
      }, {
        identityManager,
        signingKeyPem: localKeys.privateKey,
        nonceStore: createMockNonceStore(),
        securityLog,
      });

      const envelope = createEnvelope();
      // Sign with wrong key
      signEnvelope(envelope, localKeys.privateKey, REMOTE_MACHINE);

      await router.relay(envelope, 'machine');

      // Should have logged a security event
      expect(securityLog.append).toHaveBeenCalled();
      const event = securityLog.events[0];
      expect(event.event).toBe('relay_signature_invalid');
    });
  });

  // ── Signature Round-Trip ───────────────────────────────────────

  describe('signature round-trip', () => {
    it('sign + verify with canonicalJSON produces deterministic results', () => {
      const payload: SignedPayload = {
        message: {
          id: 'test-msg-id',
          from: { agent: 'a', session: 's', machine: 'm' },
          to: { agent: 'b', session: 'best', machine: 'other' },
          type: 'info',
          priority: 'medium',
          subject: 'Test',
          body: 'Body',
          createdAt: '2026-01-01T00:00:00.000Z',
          ttlMinutes: 30,
        },
        relayChain: ['m_machine_1'],
        originServer: 'http://localhost:6060',
        nonce: 'test-nonce:2026-01-01T00:00:00.000Z',
        timestamp: '2026-01-01T00:00:00.000Z',
      };

      const canonical = canonicalJSON(payload);
      const sig = sign(canonical, localKeys.privateKey);

      // Verify with matching public key
      const isValid = verify(canonical, sig, localKeys.publicKey);
      expect(isValid).toBe(true);

      // Verify with WRONG public key
      const isInvalid = verify(canonical, sig, remoteKeys.publicKey);
      expect(isInvalid).toBe(false);
    });
  });
});

// ── Canonical JSON Tests ─────────────────────────────────────────

describe('canonicalJSON', () => {
  it('sorts object keys alphabetically', () => {
    expect(canonicalJSON({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}');
  });

  it('handles nested objects', () => {
    expect(canonicalJSON({ b: { y: 1, x: 2 }, a: 0 })).toBe('{"a":0,"b":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJSON([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles null', () => {
    expect(canonicalJSON(null)).toBe('null');
  });

  it('handles strings with special characters', () => {
    expect(canonicalJSON('hello "world"')).toBe('"hello \\"world\\""');
  });

  it('handles booleans', () => {
    expect(canonicalJSON(true)).toBe('true');
    expect(canonicalJSON(false)).toBe('false');
  });

  it('handles numbers', () => {
    expect(canonicalJSON(42)).toBe('42');
    expect(canonicalJSON(3.14)).toBe('3.14');
  });

  it('omits undefined values in objects', () => {
    expect(canonicalJSON({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('produces deterministic output regardless of key insertion order', () => {
    const a = { foo: 1, bar: 2, baz: 3 };
    const b = { baz: 3, foo: 1, bar: 2 };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });

  it('handles complex nested structures', () => {
    const payload = {
      message: { id: 'abc', from: { agent: 'x', session: 's', machine: 'm' } },
      relayChain: ['m1', 'm2'],
      nonce: 'nonce-value',
    };
    const result = canonicalJSON(payload);

    // Should be valid JSON
    const parsed = JSON.parse(result);
    expect(parsed.message.id).toBe('abc');
    expect(parsed.relayChain).toEqual(['m1', 'm2']);

    // Keys should be sorted
    expect(result.indexOf('"message"')).toBeLessThan(result.indexOf('"nonce"'));
    expect(result.indexOf('"nonce"')).toBeLessThan(result.indexOf('"relayChain"'));
  });
});
