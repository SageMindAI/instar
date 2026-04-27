/**
 * E2E tests for multi-machine coordination.
 *
 * Simulates two machines sharing state via a common directory:
 * - Machine pairing (identity exchange)
 * - Failover detection and role transfer
 * - Secret migration and encrypted store
 * - Git sync with relationship merge
 * - Heartbeat timeout and auto-promotion
 * - Challenge-response verification
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecretStore, MasterKeyManager, encryptForSync, decryptFromSync } from '../../src/core/SecretStore.js';
import { migrateSecrets, mergeConfigWithSecrets } from '../../src/core/SecretMigrator.js';
import { mergeRelationship } from '../../src/core/GitSync.js';
import {
  generatePairingCode,
  comparePairingCodes,
  createPairingSession,
  isPairingSessionValid,
  validatePairingCode,
  generateEphemeralKeyPair,
  deriveSessionKey,
  deriveSAS,
  encrypt,
  decrypt,
} from '../../src/core/PairingProtocol.js';
import {
  generateMachineId,
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  sign,
  verify,
} from '../../src/core/MachineIdentity.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-e2e-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Extract raw 32-byte public key from PEM and return as base64.
 * This matches what MachineIdentityManager.generateIdentity() stores.
 */
function pemToRawBase64(pem: string, keyType: 'ed25519' | 'x25519'): string {
  const keyObj = crypto.createPublicKey(pem);
  const der = keyObj.export({ type: 'spki', format: 'der' });
  // SPKI DER: header + 32 raw bytes — extract raw key
  return der.subarray(der.length - 32).toString('base64');
}

/**
 * Create a fully initialized machine in a temp directory.
 */
function createMachine(name: string, role: 'awake' | 'standby' = 'awake') {
  const stateDir = createTempDir();
  const mgr = new MachineIdentityManager(stateDir);

  const machineId = generateMachineId();
  const signingKeys = generateSigningKeyPair();
  const encryptionKeys = generateEncryptionKeyPair();

  const identity = {
    machineId,
    signingPublicKey: pemToRawBase64(signingKeys.publicKey, 'ed25519'),
    encryptionPublicKey: pemToRawBase64(encryptionKeys.publicKey, 'x25519'),
    name,
    platform: `${os.platform()}-${os.arch()}`,
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'] as string[],
  };

  // Save identity and keys
  const machineDir = path.join(stateDir, 'machine');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'identity.json'), JSON.stringify(identity, null, 2));
  fs.writeFileSync(path.join(machineDir, 'signing-private.pem'), signingKeys.privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(machineDir, 'encryption-private.pem'), encryptionKeys.privateKey, { mode: 0o600 });

  // Register self
  mgr.registerMachine(identity as any, role);

  return {
    stateDir,
    mgr,
    identity,
    machineId,
    signingKeys,
    encryptionKeys,
  };
}

/**
 * Share machine awareness: register machine B's identity in machine A's registry.
 */
function shareMachineAwareness(
  targetMgr: MachineIdentityManager,
  remoteIdentity: any,
  role: 'awake' | 'standby',
) {
  targetMgr.registerMachine(remoteIdentity, role);
}

describe('Multi-Machine E2E', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps) {
      cleanup(dir);
    }
    temps.length = 0;
  });

  // ── Pairing Protocol E2E ────────────────────────────────────────

  describe('pairing protocol', () => {
    it('full pairing flow: code generation → session → validation → key exchange → SAS verification', () => {
      // Machine A generates pairing code
      const code = generatePairingCode();
      expect(code).toMatch(/^[A-Z]+-[A-Z]+-\d{4}$/);

      // Machine A creates a pairing session
      const session = createPairingSession({ code });
      expect(isPairingSessionValid(session)).toBe(true);

      // Machine B receives code out-of-band and validates
      const validation = validatePairingCode(session, code);
      expect(validation.valid).toBe(true);

      // Both machines generate ephemeral keys for the session
      const ephA = generateEphemeralKeyPair();
      const ephB = generateEphemeralKeyPair();

      // Both derive the same session key (bound to the pairing code)
      const sessionKeyA = deriveSessionKey(ephA.privateKey, ephB.publicKey, code);
      const sessionKeyB = deriveSessionKey(ephB.privateKey, ephA.publicKey, code);
      expect(sessionKeyA.toString('hex')).toBe(sessionKeyB.toString('hex'));

      // Both derive the same SAS (Short Authentication String)
      const pubAHex = ephA.publicKey.toString('hex');
      const pubBHex = ephB.publicKey.toString('hex');
      const sasA = deriveSAS(sessionKeyA, pubAHex, pubBHex);
      const sasB = deriveSAS(sessionKeyB, pubAHex, pubBHex);
      expect(sasA.display).toBe(sasB.display);
      expect(sasA.symbols.length).toBeGreaterThan(0);

      // Encrypted channel works
      const message = Buffer.from(JSON.stringify({ type: 'identity', data: 'test-machine-data' }));
      const encrypted = encrypt(message, sessionKeyA);
      const decrypted = decrypt(encrypted.ciphertext, sessionKeyB, encrypted.nonce, encrypted.tag);
      expect(decrypted.toString()).toBe(message.toString());
    });

    it('wrong pairing code is rejected', () => {
      const code = generatePairingCode();
      const session = createPairingSession({ code });

      const wrongCode = generatePairingCode();
      // Ensure codes are different (extremely unlikely to collide but be safe)
      const result = validatePairingCode(session, wrongCode);
      if (comparePairingCodes(code, wrongCode)) {
        expect(result.valid).toBe(true); // Would be a remarkable coincidence
      } else {
        expect(result.valid).toBe(false);
      }
    });

    it('expired session is rejected', () => {
      const code = generatePairingCode();
      const session = createPairingSession({ code, expiryMs: 1 }); // 1ms expiry

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      expect(isPairingSessionValid(session)).toBe(false);
      const result = validatePairingCode(session, code);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('expired');
    });
  });

  // ── Identity & Signing E2E ──────────────────────────────────────

  describe('identity and signing', () => {
    it('machine A signs a message and machine B verifies it', () => {
      const machineA = createMachine('machine-a');
      const machineB = createMachine('machine-b', 'standby');
      temps.push(machineA.stateDir, machineB.stateDir);

      // Machine A signs a message
      const message = 'heartbeat:machine-a:' + Date.now();
      const signature = sign(message, machineA.signingKeys.privateKey);

      // Machine B verifies using A's public key
      const verified = verify(message, signature, machineA.signingKeys.publicKey);
      expect(verified).toBe(true);

      // Tampered message fails
      const tampered = verify(message + 'x', signature, machineA.signingKeys.publicKey);
      expect(tampered).toBe(false);
    });

    it('nonce store prevents replay attacks', () => {
      const machineA = createMachine('machine-a');
      temps.push(machineA.stateDir);

      const store = new NonceStore(machineA.stateDir);
      store.initialize();
      const nonce = crypto.randomBytes(16).toString('hex');
      const peerId = 'test-peer';

      // First use succeeds
      const first = store.validate(Date.now().toString(), nonce, 1, peerId);
      expect(first.valid).toBe(true);

      // Replay fails (same nonce)
      const replay = store.validate(Date.now().toString(), nonce, 2, peerId);
      expect(replay.valid).toBe(false);

      store.destroy();
    });
  });

  // ── Coordinator Failover E2E ────────────────────────────────────

  describe('coordinator failover', () => {
    it('two machines coordinate: awake writes heartbeat, standby monitors', () => {
      // Create shared state directory (simulates git-synced state)
      const sharedDir = createTempDir();
      temps.push(sharedDir);

      // Machine A: awake
      const machineA = createMachine('machine-a');
      temps.push(machineA.stateDir);

      // Copy A's identity to shared dir
      const sharedMachineDir = path.join(sharedDir, 'machine');
      fs.mkdirSync(sharedMachineDir, { recursive: true });
      fs.cpSync(path.join(machineA.stateDir, 'machine'), sharedMachineDir, { recursive: true });

      // Copy registry
      const registryDir = path.join(machineA.stateDir, 'machines');
      if (fs.existsSync(registryDir)) {
        fs.cpSync(registryDir, path.join(sharedDir, 'machines'), { recursive: true });
      }

      // Start coordinator A (awake)
      const stateA = new StateManager(sharedDir);
      const coordA = new MultiMachineCoordinator(stateA, { stateDir: sharedDir });
      const roleA = coordA.start();

      expect(roleA).toBe('awake');
      expect(coordA.isAwake).toBe(true);

      // Verify heartbeat was written
      const hb = new HeartbeatManager(sharedDir, machineA.identity.machineId);
      const heartbeat = hb.readHeartbeat();
      expect(heartbeat).not.toBeNull();
      expect(heartbeat!.holder).toBe(machineA.identity.machineId);

      coordA.stop();
    });

    it('standby promotes when awake heartbeat goes stale', () => {
      const sharedDir = createTempDir();
      temps.push(sharedDir);

      // Create machine B as standby
      const machineB = createMachine('machine-b', 'standby');
      temps.push(machineB.stateDir);

      // Copy B's identity into shared
      const sharedMachineDir = path.join(sharedDir, 'machine');
      fs.mkdirSync(sharedMachineDir, { recursive: true });
      fs.cpSync(path.join(machineB.stateDir, 'machine'), sharedMachineDir, { recursive: true });

      if (fs.existsSync(path.join(machineB.stateDir, 'machines'))) {
        fs.cpSync(path.join(machineB.stateDir, 'machines'), path.join(sharedDir, 'machines'), { recursive: true });
      }

      // Register a fake "awake" machine with stale heartbeat
      const fakeMgr = new MachineIdentityManager(sharedDir);
      const fakeAwakeId = generateMachineId();
      fakeMgr.registerMachine({
        machineId: fakeAwakeId,
        signingPublicKey: 'k',
        encryptionPublicKey: 'k',
        name: 'stale-machine',
        platform: 'test',
        createdAt: new Date().toISOString(),
        capabilities: ['sessions'],
      } as any, 'awake');

      // Write a stale heartbeat (old timestamp, expired)
      const heartbeatDir = path.join(sharedDir, 'state');
      fs.mkdirSync(heartbeatDir, { recursive: true });
      const staleTime = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes ago
      fs.writeFileSync(
        path.join(heartbeatDir, 'heartbeat.json'),
        JSON.stringify({
          holder: fakeAwakeId,
          role: 'awake',
          timestamp: staleTime.toISOString(),
          expiresAt: new Date(staleTime.getTime() + 15 * 60_000).toISOString(), // expired 5 min ago
        }),
      );

      // Start coordinator B — should detect stale heartbeat and auto-promote
      const stateB = new StateManager(sharedDir);
      const coordB = new MultiMachineCoordinator(stateB, { stateDir: sharedDir });
      const roleB = coordB.start();

      expect(roleB).toBe('awake'); // Auto-promoted!
      expect(coordB.isAwake).toBe(true);
      expect(stateB.readOnly).toBe(false);

      coordB.stop();
    });

    it('standby stays standby when awake heartbeat is fresh', () => {
      const sharedDir = createTempDir();
      temps.push(sharedDir);

      const machineB = createMachine('machine-b', 'standby');
      temps.push(machineB.stateDir);

      const sharedMachineDir = path.join(sharedDir, 'machine');
      fs.mkdirSync(sharedMachineDir, { recursive: true });
      fs.cpSync(path.join(machineB.stateDir, 'machine'), sharedMachineDir, { recursive: true });

      if (fs.existsSync(path.join(machineB.stateDir, 'machines'))) {
        fs.cpSync(path.join(machineB.stateDir, 'machines'), path.join(sharedDir, 'machines'), { recursive: true });
      }

      // Register awake machine with fresh heartbeat
      const fakeMgr = new MachineIdentityManager(sharedDir);
      const awakeId = generateMachineId();
      fakeMgr.registerMachine({
        machineId: awakeId,
        signingPublicKey: 'k',
        encryptionPublicKey: 'k',
        name: 'awake-machine',
        platform: 'test',
        createdAt: new Date().toISOString(),
        capabilities: ['sessions'],
      } as any, 'awake');

      // Fresh heartbeat
      new HeartbeatManager(sharedDir, awakeId).writeHeartbeat();

      const stateB = new StateManager(sharedDir);
      const coordB = new MultiMachineCoordinator(stateB, { stateDir: sharedDir });
      const roleB = coordB.start();

      expect(roleB).toBe('standby');
      expect(coordB.isAwake).toBe(false);
      expect(stateB.readOnly).toBe(true);

      coordB.stop();
    });
  });

  // ── Secret Store & Migration E2E ────────────────────────────────

  describe('secret store and migration', () => {
    it('full lifecycle: config → migrate → encrypt → merge back → decrypt', () => {
      const tmpDir = createTempDir();
      temps.push(tmpDir);

      // Create a config.json with plaintext secrets
      const configPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        projectName: 'test',
        port: 4040,
        authToken: 'secret-bearer-token-123',
        dashboardPin: '9876',
        messaging: [{
          type: 'telegram',
          enabled: true,
          config: {
            token: 'bot-token-abc',
            chatId: '-100123',
          },
        }],
      }, null, 2));

      // Migrate secrets to encrypted store
      const result = migrateSecrets(configPath, tmpDir);
      expect(result.extracted).toBeGreaterThanOrEqual(4); // authToken, dashboardPin, telegram token, chatId

      // Config now has placeholders
      const configAfter = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(configAfter.authToken).toEqual({ secret: true });
      expect(configAfter.dashboardPin).toEqual({ secret: true });
      expect(configAfter.messaging[0].config.token).toEqual({ secret: true });
      expect(configAfter.messaging[0].config.chatId).toEqual({ secret: true });

      // Merge secrets back (this is what loadConfig does)
      const merged = mergeConfigWithSecrets(configAfter, tmpDir) as any;
      expect(merged.authToken).toBe('secret-bearer-token-123');
      expect(merged.dashboardPin).toBe('9876');
      expect(merged.messaging[0].config.token).toBe('bot-token-abc');
      expect(merged.messaging[0].config.chatId).toBe('-100123');

      // Idempotent: running migration again extracts nothing
      const result2 = migrateSecrets(configPath, tmpDir);
      expect(result2.extracted).toBe(0);
    });

    it('forward-secret wire encryption for syncing secrets between machines', () => {
      const machineA = createMachine('machine-a');
      const machineB = createMachine('machine-b', 'standby');
      temps.push(machineA.stateDir, machineB.stateDir);

      // Machine A encrypts secrets for machine B using B's base64 public key (as stored in identity)
      const secrets = {
        authToken: 'secret-value',
        dashboardPin: '1234',
      };

      const encrypted = encryptForSync(secrets, machineB.identity.encryptionPublicKey);

      // Verify it's actually encrypted
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.ephemeralPublicKey).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.tag).toBeTruthy();

      // Machine B decrypts with its private key (as KeyObject)
      const bPrivateKey = crypto.createPrivateKey(machineB.encryptionKeys.privateKey);
      const decrypted = decryptFromSync(encrypted, bPrivateKey);
      expect(decrypted).toEqual(secrets);

      // Machine A cannot decrypt (wrong private key)
      const aPrivateKey = crypto.createPrivateKey(machineA.encryptionKeys.privateKey);
      expect(() => decryptFromSync(encrypted, aPrivateKey)).toThrow();
    });
  });

  // ── Relationship Merge E2E ──────────────────────────────────────

  describe('relationship merge', () => {
    it('machines with divergent relationship data produce correct merge', () => {
      // Machine A's version: saw Alice recently, knows her as email contact
      const machineARelationship = {
        id: 'rel-alice',
        name: 'Alice',
        channels: [
          { type: 'email', identifier: 'alice@example.com' },
          { type: 'telegram', identifier: '123' },
        ],
        firstInteraction: '2026-01-10T00:00:00Z',
        lastInteraction: '2026-02-20T00:00:00Z',
        interactionCount: 15,
        themes: ['ai', 'philosophy', 'music'],
        notes: 'Updated notes from machine A — discussed new project',
        significance: 7,
        arcSummary: 'Research collaborator exploring consciousness',
        recentInteractions: [
          { timestamp: '2026-02-20T00:00:00Z', summary: 'Discussed new research project' },
          { timestamp: '2026-02-15T00:00:00Z', summary: 'Shared paper on AI consciousness' },
          { timestamp: '2026-02-01T00:00:00Z', summary: 'Intro conversation' },
        ],
      };

      // Machine B's version: older last interaction but knows Discord channel
      const machineBRelationship = {
        id: 'rel-alice',
        name: 'Alice Smith', // More complete name from this machine
        channels: [
          { type: 'telegram', identifier: '123' },
          { type: 'discord', identifier: 'alice#5678' },
        ],
        firstInteraction: '2026-01-05T00:00:00Z', // Earlier first interaction
        lastInteraction: '2026-02-10T00:00:00Z',
        interactionCount: 12,
        themes: ['ai', 'cooking', 'consciousness'],
        notes: 'Notes from machine B — met at conference',
        significance: 6,
        arcSummary: 'Met at AI conference, exploring consciousness together',
        recentInteractions: [
          { timestamp: '2026-02-10T00:00:00Z', summary: 'Conference follow-up' },
          { timestamp: '2026-02-01T00:00:00Z', summary: 'Intro conversation' }, // Duplicate
          { timestamp: '2026-01-20T00:00:00Z', summary: 'Pre-conference email' },
        ],
      };

      const merged = mergeRelationship(machineARelationship, machineBRelationship);

      // ID preserved from "ours"
      expect(merged.id).toBe('rel-alice');

      // Name from machine A (newer lastInteraction)
      expect(merged.name).toBe('Alice');

      // Notes from machine A (newer)
      expect(merged.notes).toContain('machine A');

      // Arc summary from machine A (newer)
      expect(merged.arcSummary).toContain('Research collaborator');

      // Channels: union of all three
      expect(merged.channels).toHaveLength(3);
      const channelTypes = merged.channels.map(c => c.type).sort();
      expect(channelTypes).toEqual(['discord', 'email', 'telegram']);

      // First interaction: earliest
      expect(merged.firstInteraction).toBe('2026-01-05T00:00:00Z');

      // Last interaction: latest
      expect(merged.lastInteraction).toBe('2026-02-20T00:00:00Z');

      // Interaction count: max
      expect(merged.interactionCount).toBe(15);

      // Significance: max
      expect(merged.significance).toBe(7);

      // Themes: union
      expect(merged.themes.sort()).toEqual(['ai', 'consciousness', 'cooking', 'music', 'philosophy']);

      // Recent interactions: deduplicated, sorted newest first
      // Machine A has: 2/20, 2/15, 2/1
      // Machine B has: 2/10, 2/1 (dup), 1/20
      // Merged: 2/20, 2/15, 2/10, 2/1, 1/20 = 5 unique
      expect(merged.recentInteractions).toHaveLength(5);
      expect(merged.recentInteractions[0].timestamp).toBe('2026-02-20T00:00:00Z');
      expect(merged.recentInteractions[4].timestamp).toBe('2026-01-20T00:00:00Z');
    });
  });

  // ── Full Lifecycle: Init → Pair → Failover → Sync ─────────────

  describe('full lifecycle simulation', () => {
    it('simulates complete multi-machine lifecycle with shared state', () => {
      // Use a single shared directory (simulates git-synced .instar/)
      // Both machines operate on the same state dir — in production, git sync keeps them in step
      const sharedDir = createTempDir();
      temps.push(sharedDir);

      // === Phase 1: Machine A initializes as awake ===
      const machineAId = generateMachineId();
      const machineAKeys = generateSigningKeyPair();
      const machineAEnc = generateEncryptionKeyPair();

      const mgrShared = new MachineIdentityManager(sharedDir);

      // Write machine A's identity into the shared dir
      const machineDir = path.join(sharedDir, 'machine');
      fs.mkdirSync(machineDir, { recursive: true });
      const identityA = {
        machineId: machineAId,
        signingPublicKey: machineAKeys.publicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\n/g, ''),
        encryptionPublicKey: machineAEnc.publicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\n/g, ''),
        name: 'workstation',
        platform: 'test',
        createdAt: new Date().toISOString(),
        capabilities: ['sessions'],
      };
      fs.writeFileSync(path.join(machineDir, 'identity.json'), JSON.stringify(identityA));
      fs.writeFileSync(path.join(machineDir, 'signing-private.pem'), machineAKeys.privateKey, { mode: 0o600 });
      mgrShared.registerMachine(identityA as any, 'awake');

      const stateA = new StateManager(sharedDir);
      const coordA = new MultiMachineCoordinator(stateA, { stateDir: sharedDir });
      const roleA = coordA.start();

      expect(roleA).toBe('awake');
      expect(coordA.isAwake).toBe(true);

      // A writes some state
      stateA.set('agent-version', '0.8.30');
      stateA.set('last-job', 'health-check');

      // === Phase 2: Machine B joins as standby ===
      const machineBId = generateMachineId();
      const identityB = {
        machineId: machineBId,
        signingPublicKey: 'key-b',
        encryptionPublicKey: 'enc-b',
        name: 'laptop',
        platform: 'test',
        createdAt: new Date().toISOString(),
        capabilities: ['sessions'],
      };
      mgrShared.registerMachine(identityB as any, 'standby');

      // A is still awake and its heartbeat is fresh
      coordA.stop();

      // === Phase 3: Machine A goes down — heartbeat goes stale ===
      // Write a stale heartbeat (simulating time passing since A stopped)
      const heartbeatDir = path.join(sharedDir, 'state');
      fs.mkdirSync(heartbeatDir, { recursive: true });
      const staleTime = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes ago
      fs.writeFileSync(
        path.join(heartbeatDir, 'heartbeat.json'),
        JSON.stringify({
          holder: machineAId,
          role: 'awake',
          timestamp: staleTime.toISOString(),
          expiresAt: new Date(staleTime.getTime() + 15 * 60_000).toISOString(), // expired 5 min ago
        }),
      );

      // === Phase 4: Machine B takes over ===
      // Swap identity to B in the shared dir
      fs.writeFileSync(path.join(machineDir, 'identity.json'), JSON.stringify(identityB));

      const stateB = new StateManager(sharedDir);
      const coordB = new MultiMachineCoordinator(stateB, { stateDir: sharedDir });
      const newRole = coordB.start();

      expect(newRole).toBe('awake'); // Auto-failover!
      expect(coordB.isAwake).toBe(true);
      expect(stateB.readOnly).toBe(false);

      // B can now write state
      stateB.set('failover-time', new Date().toISOString());
      expect(stateB.get('agent-version')).toBe('0.8.30'); // Preserved from A

      // === Phase 5: Verify security audit trail ===
      const securityLogB = coordB.managers.securityLog.readAll();
      expect(securityLogB.length).toBeGreaterThan(0);
      const startEvent = securityLogB.find(e => e.event === 'coordinator_started');
      expect(startEvent).toBeTruthy();

      coordB.stop();
    });
  });
});
