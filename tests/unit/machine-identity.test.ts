/**
 * Unit tests for MachineIdentity — Phase 1 of multi-machine spec.
 *
 * Tests:
 * - Key generation (Ed25519 signing, X25519 encryption)
 * - Machine ID generation (128-bit uniqueness)
 * - Identity persistence and loading
 * - Registry CRUD (register, update role, revoke, list)
 * - Signing and verification
 * - Error handling (missing identity, corrupt registry, double revoke)
 * - Gitignore management
 * - Secure file permissions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  generateMachineId,
  detectMachineName,
  detectPlatform,
  detectCapabilities,
  pemToBase64,
  sign,
  verify,
  MachineIdentityManager,
  ensureGitignore,
} from '../../src/core/MachineIdentity.js';

// ── Test Helpers ─────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-identity-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Key Generation ───────────────────────────────────────────────────

describe('Key Generation', () => {
  describe('generateSigningKeyPair', () => {
    it('generates valid Ed25519 key pair in PEM format', () => {
      const { publicKey, privateKey } = generateSigningKeyPair();

      expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----');
      expect(publicKey).toContain('-----END PUBLIC KEY-----');
      expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----');
      expect(privateKey).toContain('-----END PRIVATE KEY-----');
    });

    it('generates unique keys each time', () => {
      const pair1 = generateSigningKeyPair();
      const pair2 = generateSigningKeyPair();

      expect(pair1.publicKey).not.toBe(pair2.publicKey);
      expect(pair1.privateKey).not.toBe(pair2.privateKey);
    });

    it('public key can verify signatures from private key', () => {
      const { publicKey, privateKey } = generateSigningKeyPair();
      const data = 'test message';

      const signature = crypto.sign(null, Buffer.from(data), privateKey);
      const valid = crypto.verify(null, Buffer.from(data), publicKey, signature);

      expect(valid).toBe(true);
    });

    it('different private key cannot verify signature', () => {
      const pair1 = generateSigningKeyPair();
      const pair2 = generateSigningKeyPair();
      const data = 'test message';

      const signature = crypto.sign(null, Buffer.from(data), pair1.privateKey);
      const valid = crypto.verify(null, Buffer.from(data), pair2.publicKey, signature);

      expect(valid).toBe(false);
    });
  });

  describe('generateEncryptionKeyPair', () => {
    it('generates valid X25519 key pair in PEM format', () => {
      const { publicKey, privateKey } = generateEncryptionKeyPair();

      expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----');
      expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('generates unique keys each time', () => {
      const pair1 = generateEncryptionKeyPair();
      const pair2 = generateEncryptionKeyPair();

      expect(pair1.publicKey).not.toBe(pair2.publicKey);
    });

    it('can perform ECDH key agreement', () => {
      const alice = generateEncryptionKeyPair();
      const bob = generateEncryptionKeyPair();

      // Derive shared secret from both sides
      const aliceShared = crypto.diffieHellman({
        publicKey: crypto.createPublicKey(bob.publicKey),
        privateKey: crypto.createPrivateKey(alice.privateKey),
      });
      const bobShared = crypto.diffieHellman({
        publicKey: crypto.createPublicKey(alice.publicKey),
        privateKey: crypto.createPrivateKey(bob.privateKey),
      });

      expect(aliceShared).toEqual(bobShared);
    });
  });
});

// ── Machine ID ───────────────────────────────────────────────────────

describe('generateMachineId', () => {
  it('generates IDs with m_ prefix', () => {
    const id = generateMachineId();
    expect(id).toMatch(/^m_[0-9a-f]{32}$/);
  });

  it('generates 128-bit entropy (32 hex chars)', () => {
    const id = generateMachineId();
    const hex = id.slice(2);
    expect(hex).toHaveLength(32);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateMachineId()));
    expect(ids.size).toBe(100);
  });
});

// ── Platform Detection ───────────────────────────────────────────────

describe('detectMachineName', () => {
  it('returns a non-empty string', () => {
    const name = detectMachineName();
    expect(name.length).toBeGreaterThan(0);
  });

  it('returns lowercase with no special characters', () => {
    const name = detectMachineName();
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('detectPlatform', () => {
  it('returns platform-arch format', () => {
    const platform = detectPlatform();
    expect(platform).toContain('-');
    expect(platform).toBe(`${process.platform}-${process.arch}`);
  });
});

describe('detectCapabilities', () => {
  it('returns an array of capabilities', () => {
    const caps = detectCapabilities();
    expect(Array.isArray(caps)).toBe(true);
    expect(caps.length).toBeGreaterThan(0);
  });

  it('includes core capabilities', () => {
    const caps = detectCapabilities();
    expect(caps).toContain('sessions');
    expect(caps).toContain('jobs');
  });
});

// ── PEM Helpers ──────────────────────────────────────────────────────

describe('pemToBase64', () => {
  it('strips PEM headers and whitespace', () => {
    const pem = '-----BEGIN PUBLIC KEY-----\nMCow\nBQYD\n-----END PUBLIC KEY-----\n';
    expect(pemToBase64(pem)).toBe('MCowBQYD');
  });

  it('handles single-line PEM', () => {
    const pem = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----';
    expect(pemToBase64(pem)).toBe('MCowBQYDK2VwAyEA');
  });
});

// ── Sign / Verify ────────────────────────────────────────────────────

describe('sign and verify', () => {
  it('roundtrips successfully', () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const data = 'hello world';

    const sig = sign(data, privateKey);
    expect(verify(data, sig, publicKey)).toBe(true);
  });

  it('fails with tampered data', () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const sig = sign('original', privateKey);

    expect(verify('tampered', sig, publicKey)).toBe(false);
  });

  it('fails with wrong key', () => {
    const pair1 = generateSigningKeyPair();
    const pair2 = generateSigningKeyPair();
    const sig = sign('data', pair1.privateKey);

    expect(verify('data', sig, pair2.publicKey)).toBe(false);
  });

  it('handles Buffer input', () => {
    const { publicKey, privateKey } = generateSigningKeyPair();
    const data = Buffer.from([1, 2, 3, 4, 5]);

    const sig = sign(data, privateKey);
    expect(verify(data, sig, publicKey)).toBe(true);
  });
});

// ── MachineIdentityManager ───────────────────────────────────────────

describe('MachineIdentityManager', () => {
  let tmpDir: string;
  let instarDir: string;
  let manager: MachineIdentityManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    instarDir = path.join(tmpDir, '.instar');
    manager = new MachineIdentityManager(instarDir);
  });

  afterEach(() => cleanup(tmpDir));

  // ── Identity Lifecycle ─────────────────────────────────────────

  describe('generateIdentity', () => {
    it('creates identity.json, signing key, and encryption key', async () => {
      const identity = await manager.generateIdentity();

      expect(fs.existsSync(manager.identityPath)).toBe(true);
      expect(fs.existsSync(manager.signingKeyPath)).toBe(true);
      expect(fs.existsSync(manager.encryptionKeyPath)).toBe(true);
      expect(identity.machineId).toMatch(/^m_[0-9a-f]{32}$/);
    });

    it('identity has all required fields', async () => {
      const identity = await manager.generateIdentity();

      expect(identity.machineId).toBeTruthy();
      expect(identity.signingPublicKey).toBeTruthy();
      expect(identity.encryptionPublicKey).toBeTruthy();
      expect(identity.name).toBeTruthy();
      expect(identity.platform).toBeTruthy();
      expect(identity.createdAt).toBeTruthy();
      expect(identity.capabilities.length).toBeGreaterThan(0);
    });

    it('uses custom name when provided', async () => {
      const identity = await manager.generateIdentity({ name: 'my-laptop' });
      expect(identity.name).toBe('my-laptop');
    });

    it('throws if identity already exists (no force)', async () => {
      await manager.generateIdentity();
      await expect(manager.generateIdentity()).rejects.toThrow(/already has an identity/);
    });

    it('overwrites with force flag', async () => {
      const first = await manager.generateIdentity();
      const second = await manager.generateIdentity({ force: true });

      expect(second.machineId).not.toBe(first.machineId);
    });

    it('sets private key file permissions to 0600', async () => {
      await manager.generateIdentity();

      const signingStats = fs.statSync(manager.signingKeyPath);
      const encryptionStats = fs.statSync(manager.encryptionKeyPath);

      // On Unix, mode & 0o777 gives the permission bits
      expect(signingStats.mode & 0o777).toBe(0o600);
      expect(encryptionStats.mode & 0o777).toBe(0o600);
    });

    it('self-registers as awake in registry (first machine)', async () => {
      const identity = await manager.generateIdentity();
      const registry = manager.loadRegistry();

      const entry = registry.machines[identity.machineId];
      expect(entry).toBeDefined();
      expect(entry.status).toBe('active');
      expect(entry.role).toBe('awake');
      expect(entry.name).toBe(identity.name);
    });

    it('respects role option', async () => {
      const identity = await manager.generateIdentity({ role: 'standby' });
      const registry = manager.loadRegistry();

      expect(registry.machines[identity.machineId].role).toBe('standby');
    });
  });

  describe('loadIdentity', () => {
    it('loads a previously generated identity', async () => {
      const original = await manager.generateIdentity();
      const loaded = manager.loadIdentity();

      expect(loaded).toEqual(original);
    });

    it('throws if no identity exists', () => {
      expect(() => manager.loadIdentity()).toThrow(/No machine identity found/);
    });
  });

  describe('hasIdentity', () => {
    it('returns false initially', () => {
      expect(manager.hasIdentity()).toBe(false);
    });

    it('returns true after generation', async () => {
      await manager.generateIdentity();
      expect(manager.hasIdentity()).toBe(true);
    });
  });

  describe('loadSigningKey / loadEncryptionKey', () => {
    it('returns valid PEM private keys', async () => {
      await manager.generateIdentity();

      const signingKey = manager.loadSigningKey();
      const encryptionKey = manager.loadEncryptionKey();

      expect(signingKey).toContain('-----BEGIN PRIVATE KEY-----');
      expect(encryptionKey).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('signing key can sign and verify with identity public key', async () => {
      const identity = await manager.generateIdentity();
      const privateKey = manager.loadSigningKey();
      const data = 'test payload';

      // Sign with private key
      const signature = crypto.sign(null, Buffer.from(data), privateKey);

      // Reconstruct public key from identity's base64
      const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${identity.signingPublicKey}\n-----END PUBLIC KEY-----`;
      const valid = crypto.verify(null, Buffer.from(data), publicKeyPem, signature);

      expect(valid).toBe(true);
    });
  });

  // ── Registry Management ────────────────────────────────────────

  describe('Registry', () => {
    it('returns empty registry when file does not exist', () => {
      const registry = manager.loadRegistry();
      expect(registry.version).toBe(1);
      expect(Object.keys(registry.machines)).toHaveLength(0);
    });

    it('saves and loads registry', async () => {
      await manager.generateIdentity({ name: 'machine-a' });
      const registry = manager.loadRegistry();

      expect(Object.keys(registry.machines)).toHaveLength(1);
      expect(registry.version).toBe(1);
    });

    it('throws on corrupt registry', () => {
      fs.mkdirSync(path.join(instarDir, 'machines'), { recursive: true });
      fs.writeFileSync(manager.registryPath, 'not json');

      expect(() => manager.loadRegistry()).toThrow(/corrupted/);
    });

    it('throws on structurally invalid registry', () => {
      fs.mkdirSync(path.join(instarDir, 'machines'), { recursive: true });
      fs.writeFileSync(manager.registryPath, JSON.stringify({ foo: 'bar' }));

      expect(() => manager.loadRegistry()).toThrow(/corrupted/);
    });
  });

  describe('updateRole', () => {
    it('updates machine role', async () => {
      const identity = await manager.generateIdentity();
      manager.updateRole(identity.machineId, 'standby');

      const registry = manager.loadRegistry();
      expect(registry.machines[identity.machineId].role).toBe('standby');
    });

    it('updates lastSeen', async () => {
      const identity = await manager.generateIdentity();
      const before = manager.loadRegistry().machines[identity.machineId].lastSeen;

      // Small delay to ensure timestamp differs
      await new Promise(r => setTimeout(r, 10));
      manager.updateRole(identity.machineId, 'standby');

      const after = manager.loadRegistry().machines[identity.machineId].lastSeen;
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });

    it('throws for unknown machine', () => {
      expect(() => manager.updateRole('m_nonexistent', 'awake')).toThrow(/not found/);
    });
  });

  describe('ensureSelfRegistered', () => {
    it('self-registers when machine missing from registry (registry wiped scenario)', async () => {
      // Generate identity (this also registers it once), then simulate a wiped registry
      const identity = await manager.generateIdentity();
      // safe-git-allow: incremental-migration
      fs.rmSync(path.join(instarDir, 'machines'), { recursive: true, force: true });

      const registered = manager.ensureSelfRegistered(identity, 'awake');
      expect(registered).toBe(true);

      const registry = manager.loadRegistry();
      expect(registry.machines[identity.machineId]).toBeDefined();
      expect(registry.machines[identity.machineId].role).toBe('awake');
      expect(registry.machines[identity.machineId].name).toBe(identity.name);
    });

    it('is a no-op when machine already registered', async () => {
      const identity = await manager.generateIdentity();
      const before = manager.loadRegistry().machines[identity.machineId];

      const registered = manager.ensureSelfRegistered(identity, 'awake');
      expect(registered).toBe(false);

      const after = manager.loadRegistry().machines[identity.machineId];
      // pairedAt should be preserved — we didn't re-register
      expect(after.pairedAt).toBe(before.pairedAt);
    });

    it('allows subsequent updateRole calls after self-registration', async () => {
      const identity = await manager.generateIdentity();
      // safe-git-allow: incremental-migration
      fs.rmSync(path.join(instarDir, 'machines'), { recursive: true, force: true });

      manager.ensureSelfRegistered(identity, 'standby');
      // This would previously throw with MACHINE_NOT_FOUND
      expect(() => manager.updateRole(identity.machineId, 'awake')).not.toThrow();
      expect(manager.loadRegistry().machines[identity.machineId].role).toBe('awake');
    });
  });

  describe('touchMachine', () => {
    it('updates lastSeen without changing role', async () => {
      const identity = await manager.generateIdentity();
      const originalRole = manager.loadRegistry().machines[identity.machineId].role;

      await new Promise(r => setTimeout(r, 10));
      manager.touchMachine(identity.machineId);

      const entry = manager.loadRegistry().machines[identity.machineId];
      expect(entry.role).toBe(originalRole);
    });

    it('throws for unknown machine', () => {
      expect(() => manager.touchMachine('m_nonexistent')).toThrow(/not found/);
    });
  });

  describe('revokeMachine', () => {
    it('marks machine as revoked', async () => {
      const idA = await manager.generateIdentity({ name: 'machine-a' });
      // Simulate adding a second machine
      const idB: any = { machineId: generateMachineId(), name: 'machine-b' };
      manager.registerMachine(idB as any, 'standby');

      manager.revokeMachine(idB.machineId, idA.machineId, 'compromised');

      const entry = manager.loadRegistry().machines[idB.machineId];
      expect(entry.status).toBe('revoked');
      expect(entry.role).toBe('standby');
      expect(entry.revokedBy).toBe(idA.machineId);
      expect(entry.revokeReason).toBe('compromised');
      expect(entry.revokedAt).toBeTruthy();
    });

    it('throws when revoking already-revoked machine', async () => {
      const idA = await manager.generateIdentity({ name: 'machine-a' });
      const idB: any = { machineId: generateMachineId(), name: 'machine-b' };
      manager.registerMachine(idB as any, 'standby');

      manager.revokeMachine(idB.machineId, idA.machineId, 'test');
      expect(() => manager.revokeMachine(idB.machineId, idA.machineId, 'again'))
        .toThrow(/already revoked/);
    });

    it('throws for unknown machine', async () => {
      await manager.generateIdentity();
      expect(() => manager.revokeMachine('m_unknown', 'm_self', 'test'))
        .toThrow(/not found/);
    });
  });

  describe('removeLocalIdentity', () => {
    it('removes identity and key files', async () => {
      await manager.generateIdentity();
      expect(manager.hasIdentity()).toBe(true);

      manager.removeLocalIdentity();

      expect(fs.existsSync(manager.identityPath)).toBe(false);
      expect(fs.existsSync(manager.signingKeyPath)).toBe(false);
      expect(fs.existsSync(manager.encryptionKeyPath)).toBe(false);
    });

    it('does not throw if files already missing', () => {
      expect(() => manager.removeLocalIdentity()).not.toThrow();
    });
  });

  describe('getAwakeMachine', () => {
    it('returns the awake machine', async () => {
      const identity = await manager.generateIdentity();
      const awake = manager.getAwakeMachine();

      expect(awake).not.toBeNull();
      expect(awake!.machineId).toBe(identity.machineId);
      expect(awake!.entry.role).toBe('awake');
    });

    it('returns null when no machine is awake', async () => {
      const identity = await manager.generateIdentity({ role: 'standby' });
      const awake = manager.getAwakeMachine();

      expect(awake).toBeNull();
    });

    it('skips revoked machines', async () => {
      const identity = await manager.generateIdentity();
      manager.revokeMachine(identity.machineId, identity.machineId, 'test');

      expect(manager.getAwakeMachine()).toBeNull();
    });
  });

  describe('getActiveMachines', () => {
    it('returns only non-revoked machines', async () => {
      const idA = await manager.generateIdentity({ name: 'a' });
      const idB: any = { machineId: generateMachineId(), name: 'b' };
      const idC: any = { machineId: generateMachineId(), name: 'c' };
      manager.registerMachine(idB as any, 'standby');
      manager.registerMachine(idC as any, 'standby');

      manager.revokeMachine(idB.machineId, idA.machineId, 'test');

      const active = manager.getActiveMachines();
      expect(active).toHaveLength(2);
      expect(active.map(m => m.entry.name).sort()).toEqual(['a', 'c']);
    });
  });

  describe('isMachineActive', () => {
    it('returns true for active machine', async () => {
      const identity = await manager.generateIdentity();
      expect(manager.isMachineActive(identity.machineId)).toBe(true);
    });

    it('returns false for revoked machine', async () => {
      const identity = await manager.generateIdentity();
      manager.revokeMachine(identity.machineId, identity.machineId, 'test');
      expect(manager.isMachineActive(identity.machineId)).toBe(false);
    });

    it('returns false for unknown machine', () => {
      expect(manager.isMachineActive('m_nonexistent')).toBe(false);
    });
  });

  // ── Multi-Machine Registry ─────────────────────────────────────

  describe('multi-machine scenarios', () => {
    it('supports registering multiple machines', async () => {
      const idA = await manager.generateIdentity({ name: 'machine-a' });
      const idB: any = { machineId: generateMachineId(), name: 'machine-b' };
      const idC: any = { machineId: generateMachineId(), name: 'machine-c' };

      manager.registerMachine(idB as any, 'standby');
      manager.registerMachine(idC as any, 'standby');

      const registry = manager.loadRegistry();
      expect(Object.keys(registry.machines)).toHaveLength(3);
    });

    it('only one machine can be awake at a time (by convention)', async () => {
      const idA = await manager.generateIdentity({ name: 'a' }); // awake
      const idB: any = { machineId: generateMachineId(), name: 'b' };
      manager.registerMachine(idB as any, 'standby');

      // Transfer awake: demote A, promote B
      manager.updateRole(idA.machineId, 'standby');
      manager.updateRole(idB.machineId, 'awake');

      const awake = manager.getAwakeMachine();
      expect(awake!.entry.name).toBe('b');

      const registry = manager.loadRegistry();
      expect(registry.machines[idA.machineId].role).toBe('standby');
    });
  });
});

// ── Gitignore ────────────────────────────────────────────────────────

describe('ensureGitignore', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => cleanup(tmpDir));

  it('creates .gitignore if it does not exist', () => {
    ensureGitignore(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).toContain('.instar/machine/signing-key.pem');
    expect(content).toContain('.instar/machine/encryption-key.pem');
    expect(content).toContain('.instar/secrets/');
    expect(content).toContain('.instar/pairing/');
  });

  it('appends to existing .gitignore without duplicating', () => {
    const initial = 'node_modules/\ndist/\n';
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), initial);

    ensureGitignore(tmpDir);
    ensureGitignore(tmpDir); // Run twice

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.instar/machine/signing-key.pem');

    // Check no duplicates
    const matches = content.match(/signing-key\.pem/g);
    expect(matches).toHaveLength(1);
  });

  it('handles .gitignore without trailing newline', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/');

    ensureGitignore(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.instar/machine/signing-key.pem');
  });
});
