/**
 * WorktreeKeyVault tests — K1 hardening (headless flat-file passphrase).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorktreeKeyVault } from '../../src/core/WorktreeKeyVault.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-keyvault-')); });
// safe-git-allow: incremental-migration
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('WorktreeKeyVault', () => {
  it('K1: headless mode without passphrase resolver throws', async () => {
    const vault = new WorktreeKeyVault({
      stateDir: tmp,
      headlessAllowed: true,
      forceBackend: 'flatfile',
    });
    await expect(vault.loadOrInit()).rejects.toThrow(/passphraseResolver/);
  });

  it('K1: passphrase shorter than 12 chars rejected', async () => {
    const vault = new WorktreeKeyVault({
      stateDir: tmp,
      headlessAllowed: true,
      passphraseResolver: () => 'short',
      forceBackend: 'flatfile',
    });
    await expect(vault.loadOrInit()).rejects.toThrow(/12 characters/);
  });

  it('K1: flat-file with valid passphrase generates + persists keys', async () => {
    const vault = new WorktreeKeyVault({
      stateDir: tmp,
      headlessAllowed: true,
      passphraseResolver: () => 'a-valid-passphrase-of-sufficient-length',
      forceBackend: 'flatfile',
    });
    const m1 = await vault.loadOrInit();
    expect(m1.machineId).toBeTruthy();
    expect(m1.hmacKey.length).toBe(32);
    expect(m1.signing.privateKeyPem).toContain('PRIVATE KEY');
    expect(m1.signing.publicKeyPem).toContain('PUBLIC KEY');

    // Roundtrip: load again with same passphrase returns same material
    const vault2 = new WorktreeKeyVault({
      stateDir: tmp,
      headlessAllowed: true,
      passphraseResolver: () => 'a-valid-passphrase-of-sufficient-length',
      forceBackend: 'flatfile',
    });
    const m2 = await vault2.loadOrInit();
    expect(m2.machineId).toBe(m1.machineId);
    expect(m2.hmacKey.equals(m1.hmacKey)).toBe(true);
    expect(m2.signing.privateKeyPem).toBe(m1.signing.privateKeyPem);
  }, 30_000);

  it('K1: wrong passphrase fails to decrypt', async () => {
    const vault = new WorktreeKeyVault({
      stateDir: tmp,
      headlessAllowed: true,
      passphraseResolver: () => 'a-valid-passphrase-of-sufficient-length',
      forceBackend: 'flatfile',
    });
    await vault.loadOrInit();

    const vault2 = new WorktreeKeyVault({
      stateDir: tmp,
      headlessAllowed: true,
      passphraseResolver: () => 'a-different-passphrase-of-12-or-more',
      forceBackend: 'flatfile',
    });
    await expect(vault2.loadOrInit()).rejects.toThrow();
  }, 30_000);

  it('K1: flat-file is chmod 0600', async () => {
    const vault = new WorktreeKeyVault({
      stateDir: tmp,
      headlessAllowed: true,
      passphraseResolver: () => 'a-valid-passphrase-of-sufficient-length',
      forceBackend: 'flatfile',
    });
    await vault.loadOrInit();
    const flatFilePath = path.join(tmp, 'local-state', 'keys.enc');
    const st = fs.statSync(flatFilePath);
    expect(st.mode & 0o777).toBe(0o600);
  }, 30_000);

  it('importKeyMaterial round-trips through flat-file', async () => {
    const vault = new WorktreeKeyVault({
      stateDir: tmp,
      headlessAllowed: true,
      passphraseResolver: () => 'import-test-passphrase-xyz',
      forceBackend: 'flatfile',
    });

    const { generateKeyPairSync, randomBytes, randomUUID } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const expected = {
      signing: { privateKeyPem: privateKey, publicKeyPem: publicKey, keyVersion: 1 },
      hmacKey: randomBytes(32),
      machineId: randomUUID(),
    };

    await vault.importKeyMaterial(expected);

    const vault2 = new WorktreeKeyVault({
      stateDir: tmp,
      headlessAllowed: true,
      passphraseResolver: () => 'import-test-passphrase-xyz',
      forceBackend: 'flatfile',
    });
    const loaded = await vault2.loadOrInit();
    expect(loaded.signing.privateKeyPem).toBe(expected.signing.privateKeyPem);
    expect(loaded.signing.publicKeyPem).toBe(expected.signing.publicKeyPem);
    expect(loaded.signing.keyVersion).toBe(1);
    expect(loaded.hmacKey.equals(expected.hmacKey)).toBe(true);
    expect(loaded.machineId).toBe(expected.machineId);
  }, 30_000);

  it('decodeFromKeychain: base64-wrapped PEM survives a multi-line roundtrip', async () => {
    // Direct test of the encode/decode helpers via a fake in-memory "keychain"
    // — we can't invoke macOS `security` in CI reliably, so unit-test the wrap.
    const { encodeForKeychain, decodeFromKeychain } = await import(
      '../../src/core/WorktreeKeyVault.js'
    );
    const multiLinePem =
      '-----BEGIN PRIVATE KEY-----\n' +
      'MC4CAQAwBQYDK2VwBCIEIO+o3abc123def456xyz==\n' +
      '-----END PRIVATE KEY-----\n';
    const encoded = encodeForKeychain(multiLinePem);
    expect(encoded.startsWith('b64:')).toBe(true);
    // Encoded value has no newlines — that's the whole point; macOS
    // `security -w` returns printable text without hex fallback.
    expect(encoded).not.toMatch(/\n/);
    const decoded = decodeFromKeychain(encoded);
    expect(decoded).toBe(multiLinePem);
  });

  it('decodeFromKeychain: legacy hex-encoded fallback decodes correctly', async () => {
    const { decodeFromKeychain } = await import('../../src/core/WorktreeKeyVault.js');
    const original = '-----BEGIN KEY-----\nmulti line data\n-----END KEY-----\n';
    const hex = Buffer.from(original, 'utf-8').toString('hex');
    expect(decodeFromKeychain(hex)).toBe(original);
  });

  it('decodeFromKeychain: passes short single-line values through unchanged', async () => {
    const { decodeFromKeychain } = await import('../../src/core/WorktreeKeyVault.js');
    // UUID, key-version etc. — no newlines, no hex-looking, no prefix.
    expect(decodeFromKeychain('8a589411-7a62-45bd-a140-6d610a516746'))
      .toBe('8a589411-7a62-45bd-a140-6d610a516746');
    expect(decodeFromKeychain('1')).toBe('1');
  });
});
