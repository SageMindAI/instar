/**
 * WorktreeKeyVault — Ed25519 + HMAC key storage for parallel-dev isolation.
 *
 * Per PARALLEL-DEV-ISOLATION-SPEC.md "Key management (iter 4)" + K1 (iter-4
 * adversarial finding: Ed25519 private-key extraction via flat-file fallback).
 *
 * Storage strategy:
 *   1. macOS — Keychain Services via `security` CLI.
 *   2. Linux — libsecret via `secret-tool` CLI when available.
 *   3. Windows — Credential Manager via `cmdkey`/`Get-Credential` (best-effort).
 *   4. Headless fallback — flat file at `<stateDir>/local-state/keys.enc`,
 *      AES-GCM encrypted with key derived from user passphrase via Argon2id-style
 *      scrypt KDF (Node has scrypt built-in; Argon2id would require a dep).
 *      File is chmod 0600.
 *
 * K1: passphrase REQUIRED in headless mode. Caller can pass `headless.allowed=true`
 * with a passphrase resolver (env var, prompt, etc.); otherwise headless = error.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SECURE_FILE_MODE = 0o600;
const SCRYPT_PARAMS = { N: 1 << 16, r: 8, p: 1 }; // ~64MB, ~250ms
const SCRYPT_KEY_LEN = 32;

export interface KeyMaterial {
  /** Ed25519 keypair PEMs for trailer signing. */
  signing: { privateKeyPem: string; publicKeyPem: string; keyVersion: number };
  /** HMAC-SHA256 32-byte key for bindings/locks/heartbeats. */
  hmacKey: Buffer;
  /** Server-generated machineId UUID (NOT OS-derived; defeats disk-imaging collisions). */
  machineId: string;
}

export interface KeyVaultOptions {
  stateDir: string;
  /** Allow flat-file fallback when keychain is unreachable. */
  headlessAllowed?: boolean;
  /** Resolver for user passphrase (REQUIRED for headless mode per K1). */
  passphraseResolver?: () => Promise<string> | string;
  /** Forces a specific backend (used by tests). */
  forceBackend?: 'keychain' | 'flatfile';
}

const KEYCHAIN_SERVICE = 'instar.parallel-dev';
const KEYCHAIN_ITEM_HMAC = 'hmac-key';
const KEYCHAIN_ITEM_SIGNING_PRIV = 'signing-private';
const KEYCHAIN_ITEM_SIGNING_PUB = 'signing-public';
const KEYCHAIN_ITEM_MACHINE_ID = 'machine-id';
const KEYCHAIN_ITEM_KEY_VERSION = 'key-version';

// ── Backend probes ───────────────────────────────────────────────────

function macOsKeychainAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('security', ['list-keychains', '-d', 'user'], { stdio: 'pipe', timeout: 2000 });
    return true;
  } catch { return false; }
}

function linuxLibsecretAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('secret-tool', ['--version'], { stdio: 'pipe', timeout: 2000 });
    return !!process.env.DBUS_SESSION_BUS_ADDRESS;
  } catch { return false; }
}

// ── Backend impls ────────────────────────────────────────────────────

/**
 * Base64-wrap every value we store so multi-line content (PEM keys) survives
 * macOS keychain's `security -w` round-trip. Without wrapping, `security`
 * detects non-printable bytes (PEM newlines = 0x0a) and returns the value
 * as hex instead of the original text, which silently corrupts consumers
 * that expect a PEM string back.
 *
 * We always wrap — including single-line items like machineId — so the
 * format is uniform and self-describing. The `b64:` prefix lets us detect
 * legacy raw entries (none exist in practice, but belt-and-suspenders).
 */
const KEYCHAIN_VALUE_PREFIX = 'b64:';

export function encodeForKeychain(value: string): string {
  return KEYCHAIN_VALUE_PREFIX + Buffer.from(value, 'utf-8').toString('base64');
}

export function decodeFromKeychain(stored: string | null): string | null {
  if (stored === null || stored === undefined) return null;
  if (stored.startsWith(KEYCHAIN_VALUE_PREFIX)) {
    try {
      return Buffer.from(stored.slice(KEYCHAIN_VALUE_PREFIX.length), 'base64').toString('utf-8');
    } catch {
      return null;
    }
  }
  // Backwards-compat: if macOS emitted hex (even-length all-hex ≥ 40 chars,
  // typical for anything with newlines), decode it back to text. Short
  // single-line strings (machineId, keyVersion) pass through unchanged.
  if (/^[0-9a-f]+$/.test(stored) && stored.length >= 40 && stored.length % 2 === 0) {
    try {
      return Buffer.from(stored, 'hex').toString('utf-8');
    } catch {
      return stored;
    }
  }
  return stored;
}

function macReadItem(account: string): string | null {
  try {
    const raw = execFileSync('security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).trim();
    return decodeFromKeychain(raw);
  } catch { return null; }
}

function macWriteItem(account: string, value: string): void {
  // Delete first if exists, then add (security tool doesn't have upsert)
  try {
    execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], {
      stdio: 'pipe', timeout: 5000,
    });
  } catch { /* @silent-fallback-ok */ }
  execFileSync('security', [
    'add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', encodeForKeychain(value),
  ], { stdio: 'pipe', timeout: 5000 });
}

function linuxReadItem(account: string): string | null {
  try {
    const raw = execFileSync('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
    return decodeFromKeychain(raw);
  } catch { return null; }
}

function linuxWriteItem(account: string, value: string): void {
  // secret-tool reads from stdin
  execFileSync('secret-tool', ['store', '--label', `instar:${account}`,
    'service', KEYCHAIN_SERVICE, 'account', account], {
    input: encodeForKeychain(value), timeout: 5000,
  });
}

// ── Flat-file backend (K1: passphrase required) ──────────────────────

interface FlatFilePayload {
  version: 1;
  kdf: 'scrypt';
  scryptParams: { N: number; r: number; p: number };
  salt: string; // base64
  iv: string;   // base64
  ciphertext: string; // base64
  authTag: string;    // base64
}

async function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must be ≥ 128 * N * r (per Node docs); set generous headroom.
    const maxmem = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;
    crypto.scrypt(passphrase, salt, SCRYPT_KEY_LEN, { ...SCRYPT_PARAMS, maxmem }, (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
}

async function flatFileWrite(filePath: string, plaintext: string, passphrase: string): Promise<void> {
  const salt = crypto.randomBytes(16);
  const key = await deriveKeyFromPassphrase(passphrase, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload: FlatFilePayload = {
    version: 1,
    kdf: 'scrypt',
    scryptParams: SCRYPT_PARAMS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ct.toString('base64'),
    authTag: authTag.toString('base64'),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload), { mode: SECURE_FILE_MODE });
}

async function flatFileRead(filePath: string, passphrase: string): Promise<string> {
  const payload: FlatFilePayload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (payload.version !== 1 || payload.kdf !== 'scrypt') {
    throw new Error(`unsupported keyvault version: ${payload.version}/${payload.kdf}`);
  }
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const ct = Buffer.from(payload.ciphertext, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const key = await deriveKeyFromPassphrase(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf-8');
}

// ── Public API ───────────────────────────────────────────────────────

export class WorktreeKeyVault {
  private stateDir: string;
  private opts: Required<Omit<KeyVaultOptions, 'forceBackend' | 'passphraseResolver'>> & {
    forceBackend: 'keychain' | 'flatfile' | null;
    passphraseResolver: (() => Promise<string> | string) | null;
  };
  private flatFilePath: string;

  constructor(opts: KeyVaultOptions) {
    this.stateDir = opts.stateDir;
    this.opts = {
      stateDir: opts.stateDir,
      headlessAllowed: opts.headlessAllowed ?? false,
      forceBackend: opts.forceBackend ?? null,
      passphraseResolver: opts.passphraseResolver ?? null,
    };
    this.flatFilePath = path.join(opts.stateDir, 'local-state', 'keys.enc');
  }

  async loadOrInit(): Promise<KeyMaterial> {
    const backend = this.detectBackend();
    if (backend === 'keychain') return this.loadOrInitKeychain();
    if (backend === 'flatfile') return this.loadOrInitFlatFile();
    throw new Error('no keyvault backend available; set headlessAllowed=true with passphraseResolver to use flat-file fallback');
  }

  /**
   * Store externally-provided key material, replacing any existing entries.
   * Used by `instar worktree register-keypair` to move a key generated by
   * the Day-2 migration script into the configured backend.
   *
   * The caller is responsible for sourcing the material (reading a PEM file,
   * deriving the public key, generating hmac + machineId). This method only
   * handles the write.
   */
  async importKeyMaterial(material: KeyMaterial): Promise<void> {
    const backend = this.detectBackend();
    if (backend === 'keychain') {
      this.writeKeychain(material);
      return;
    }
    if (backend === 'flatfile') {
      await this.writeFlatFile(material);
      return;
    }
    throw new Error('no keyvault backend available for importKeyMaterial');
  }

  private writeKeychain(m: KeyMaterial): void {
    const macOs = process.platform === 'darwin';
    const write = macOs ? macWriteItem : linuxWriteItem;
    write(KEYCHAIN_ITEM_HMAC, m.hmacKey.toString('base64'));
    write(KEYCHAIN_ITEM_SIGNING_PRIV, m.signing.privateKeyPem);
    write(KEYCHAIN_ITEM_SIGNING_PUB, m.signing.publicKeyPem);
    write(KEYCHAIN_ITEM_MACHINE_ID, m.machineId);
    write(KEYCHAIN_ITEM_KEY_VERSION, String(m.signing.keyVersion));
  }

  private async writeFlatFile(m: KeyMaterial): Promise<void> {
    if (!this.opts.passphraseResolver) {
      throw new Error('K1: headless flat-file mode requires passphraseResolver');
    }
    const passphrase = await this.opts.passphraseResolver();
    if (!passphrase || passphrase.length < 12) {
      throw new Error('K1: passphrase must be ≥12 characters');
    }
    const payload = JSON.stringify({
      hmacB64: m.hmacKey.toString('base64'),
      signingPriv: m.signing.privateKeyPem,
      signingPub: m.signing.publicKeyPem,
      machineId: m.machineId,
      keyVersion: m.signing.keyVersion,
    });
    await flatFileWrite(this.flatFilePath, payload, passphrase);
  }

  private detectBackend(): 'keychain' | 'flatfile' | null {
    if (this.opts.forceBackend) return this.opts.forceBackend;
    if (macOsKeychainAvailable()) return 'keychain';
    if (linuxLibsecretAvailable()) return 'keychain';
    if (this.opts.headlessAllowed) return 'flatfile';
    return null;
  }

  private async loadOrInitKeychain(): Promise<KeyMaterial> {
    const macOs = process.platform === 'darwin';
    const read = macOs ? macReadItem : linuxReadItem;
    const write = macOs ? macWriteItem : linuxWriteItem;

    let hmacB64 = read(KEYCHAIN_ITEM_HMAC);
    let signingPriv = read(KEYCHAIN_ITEM_SIGNING_PRIV);
    let signingPub = read(KEYCHAIN_ITEM_SIGNING_PUB);
    let machineId = read(KEYCHAIN_ITEM_MACHINE_ID);
    let keyVersionStr = read(KEYCHAIN_ITEM_KEY_VERSION);

    if (!hmacB64 || !signingPriv || !signingPub || !machineId) {
      const fresh = generateFreshMaterial();
      write(KEYCHAIN_ITEM_HMAC, fresh.hmacB64);
      write(KEYCHAIN_ITEM_SIGNING_PRIV, fresh.signingPriv);
      write(KEYCHAIN_ITEM_SIGNING_PUB, fresh.signingPub);
      write(KEYCHAIN_ITEM_MACHINE_ID, fresh.machineId);
      write(KEYCHAIN_ITEM_KEY_VERSION, '1');
      return materialFromParts(fresh, 1);
    }

    return {
      hmacKey: Buffer.from(hmacB64, 'base64'),
      signing: { privateKeyPem: signingPriv, publicKeyPem: signingPub, keyVersion: Number(keyVersionStr ?? 1) },
      machineId,
    };
  }

  private async loadOrInitFlatFile(): Promise<KeyMaterial> {
    if (!this.opts.passphraseResolver) {
      throw new Error('K1: headless flat-file mode requires passphraseResolver');
    }
    const passphrase = await this.opts.passphraseResolver();
    if (!passphrase || passphrase.length < 12) {
      throw new Error('K1: passphrase must be ≥12 characters');
    }

    if (fs.existsSync(this.flatFilePath)) {
      const decrypted = await flatFileRead(this.flatFilePath, passphrase);
      const parsed = JSON.parse(decrypted);
      return {
        hmacKey: Buffer.from(parsed.hmacB64, 'base64'),
        signing: { privateKeyPem: parsed.signingPriv, publicKeyPem: parsed.signingPub, keyVersion: parsed.keyVersion },
        machineId: parsed.machineId,
      };
    }

    const fresh = generateFreshMaterial();
    const payload = JSON.stringify({ ...fresh, keyVersion: 1 });
    await flatFileWrite(this.flatFilePath, payload, passphrase);
    return materialFromParts(fresh, 1);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

interface FreshMaterial {
  hmacB64: string;
  signingPriv: string;
  signingPub: string;
  machineId: string;
}

function generateFreshMaterial(): FreshMaterial {
  const hmac = crypto.randomBytes(32);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    hmacB64: hmac.toString('base64'),
    signingPriv: privateKey,
    signingPub: publicKey,
    machineId: crypto.randomUUID(),
  };
}

function materialFromParts(f: FreshMaterial, keyVersion: number): KeyMaterial {
  return {
    hmacKey: Buffer.from(f.hmacB64, 'base64'),
    signing: { privateKeyPem: f.signingPriv, publicKeyPem: f.signingPub, keyVersion },
    machineId: f.machineId,
  };
}
