/**
 * EncryptedAuthStore — encrypts Baileys auth state at rest.
 *
 * Wraps Baileys' useMultiFileAuthState with AES-256-GCM encryption.
 * Auth credentials contain session keys that grant full access to
 * the linked WhatsApp account — they MUST be encrypted at rest.
 *
 * The encryption key is derived from a user-provided passphrase
 * using PBKDF2 (100k iterations, SHA-512).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha512';

// Header for encrypted files — helps detect unencrypted vs encrypted state
const ENCRYPTED_HEADER = Buffer.from('INSTAR_ENC_V1');

export interface EncryptedAuthStoreOptions {
  /** Directory to store encrypted auth files */
  authDir: string;
  /** Passphrase for key derivation. If not provided, files are stored unencrypted (backward-compatible). */
  passphrase?: string;
}

/**
 * Derive an AES-256 key from a passphrase using PBKDF2.
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

/**
 * Encrypt data with AES-256-GCM.
 * Format: HEADER(13) + SALT(32) + IV(16) + AUTH_TAG(16) + CIPHERTEXT(variable)
 */
export function encryptData(data: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([ENCRYPTED_HEADER, salt, iv, authTag, encrypted]);
}

/**
 * Decrypt data encrypted with encryptData.
 */
export function decryptData(data: Buffer, passphrase: string): Buffer {
  const headerLen = ENCRYPTED_HEADER.length;

  if (data.length < headerLen + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short');
  }

  const header = data.subarray(0, headerLen);
  if (!header.equals(ENCRYPTED_HEADER)) {
    throw new Error('Invalid encrypted data: wrong header');
  }

  let offset = headerLen;
  const salt = data.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = data.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = data.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const ciphertext = data.subarray(offset);

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Check if a file is encrypted (has our header).
 */
export function isEncryptedFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(ENCRYPTED_HEADER.length);
    fs.readSync(fd, buf, 0, ENCRYPTED_HEADER.length, 0);
    fs.closeSync(fd);
    return buf.equals(ENCRYPTED_HEADER);
  } catch {
    return false;
  }
}

/**
 * Read a file, decrypting if encrypted.
 * If no passphrase provided, reads as plain text (backward-compatible).
 */
export function readAuthFile(filePath: string, passphrase?: string): string {
  const data = fs.readFileSync(filePath);

  if (passphrase && data.subarray(0, ENCRYPTED_HEADER.length).equals(ENCRYPTED_HEADER)) {
    return decryptData(data, passphrase).toString('utf-8');
  }

  // Unencrypted — return as-is
  return data.toString('utf-8');
}

/**
 * Write a file, encrypting if passphrase is provided.
 * Uses atomic write (write-to-tmp then rename) to prevent corruption.
 */
export function writeAuthFile(filePath: string, content: string, passphrase?: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const data = Buffer.from(content, 'utf-8');
  const output = passphrase ? encryptData(data, passphrase) : data;

  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, output);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Create a Baileys-compatible auth state that encrypts credentials at rest.
 * Drop-in replacement for useMultiFileAuthState from Baileys.
 *
 * When passphrase is provided: files are encrypted with AES-256-GCM.
 * When passphrase is absent: files are stored in plain text (backward-compatible).
 */
export async function useEncryptedAuthState(authDir: string, passphrase?: string): Promise<{
  state: any;
  saveCreds: () => Promise<void>;
}> {
  // Dynamic import — Baileys is an optional dependency
  // Try v7 (baileys) first (preferred), then v6 (@whiskeysockets/baileys, deprecated)
  let baileys = await import('baileys').catch(() => null) as any;
  if (!baileys) {
    // @ts-expect-error — try deprecated v6 package name
    baileys = await import('@whiskeysockets/baileys').catch(() => null);
  }
  if (!baileys) {
    throw new Error('Baileys is not installed. Run: npm install baileys');
  }

  const { initAuthCreds, proto, BufferJSON } = baileys;

  fs.mkdirSync(authDir, { recursive: true });

  const credsFile = path.join(authDir, 'creds.json');

  const readFile = (file: string): any => {
    try {
      const content = readAuthFile(file, passphrase);
      return JSON.parse(content, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const writeFile = (file: string, data: any): void => {
    const json = JSON.stringify(data, BufferJSON.replacer, 2);
    writeAuthFile(file, json, passphrase);
  };

  const creds = readFile(credsFile) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: (type: string, ids: string[]) => {
          const data: Record<string, any> = {};
          for (const id of ids) {
            const file = path.join(authDir, `${type}-${id}.json`);
            const value = readFile(file);
            if (value) {
              if (type === 'app-state-sync-key' && value.keyData) {
                data[id] = proto.Message.AppStateSyncKeyData.fromObject(value);
              } else {
                data[id] = value;
              }
            }
          }
          return data;
        },
        set: (data: Record<string, Record<string, any>>) => {
          for (const [category, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              const file = path.join(authDir, `${category}-${id}.json`);
              if (value) {
                writeFile(file, value);
              } else {
                // safe-git-allow: incremental-migration
                try { fs.unlinkSync(file); } catch { /* ignore */ }
              }
            }
          }
        },
      },
    },
    saveCreds: async () => {
      writeFile(credsFile, creds);
    },
  };
}
