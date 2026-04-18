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
});
