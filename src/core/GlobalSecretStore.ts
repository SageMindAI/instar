/**
 * Global encrypted secret store — lives at ~/.instar/secrets/ to survive repo nukes.
 *
 * Unlike the per-agent SecretStore (which lives inside .instar/secrets/),
 * this store persists across agent deletions and reinstalls on the same machine.
 *
 * Encryption: AES-256-GCM with a master key stored in:
 *   1. macOS Keychain (preferred — transparent, no password needed)
 *   2. Password-derived key via PBKDF2 (fallback — user enters password)
 *
 * File layout:
 *   ~/.instar/secrets/
 *     global.secrets.enc    — encrypted secrets (all agents on this machine)
 *     global.key            — master key file (0600, only if keychain unavailable)
 *
 * Secrets are organized by agent name:
 *   {
 *     "agents": {
 *       "my-agent": {
 *         "telegram-token": "bot123:ABC",
 *         "telegram-chat-id": "-100123",
 *         ...
 *       }
 *     }
 *   }
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// ── Constants ────────────────────────────────────────────────────────

function defaultSecretsDir(): string { return path.join(os.homedir(), '.instar', 'secrets'); }

const KEYCHAIN_SERVICE = 'instar-global-secrets';
const KEYCHAIN_ACCOUNT = 'master-key';
const MASTER_KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 600000; // OWASP recommendation for PBKDF2-SHA256
const PBKDF2_SALT_LENGTH = 32;

// ── Types ────────────────────────────────────────────────────────────

export interface GlobalSecrets {
  agents: Record<string, Record<string, string>>;
}

// ── Global Secret Store ──────────────────────────────────────────────

export class GlobalSecretStore {
  private masterKey: Buffer | null = null;
  private secretsDir: string;
  private encryptedFile: string;
  private keyFile: string;
  private useKeychain: boolean;

  constructor(basePath?: string) {
    this.secretsDir = basePath || defaultSecretsDir();
    // Skip keychain when a custom basePath is provided (tests / self-contained stores)
    this.useKeychain = !basePath;
    this.encryptedFile = path.join(this.secretsDir, 'global.secrets.enc');
    this.keyFile = path.join(this.secretsDir, 'global.key');

    // Ensure directory exists
    if (!fs.existsSync(this.secretsDir)) {
      fs.mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    }
  }

  // ── Agent-Scoped Operations ───────────────────────────────────────

  /**
   * Get a secret for an agent.
   * Returns null if the agent or key doesn't exist.
   */
  getSecret(agentName: string, key: string): string | null {
    const secrets = this.readSecrets();
    if (!secrets) return null;
    return secrets.agents?.[agentName]?.[key] ?? null;
  }

  /**
   * Set a secret for an agent.
   */
  setSecret(agentName: string, key: string, value: string): void {
    const secrets = this.readSecrets() || { agents: {} };
    if (!secrets.agents[agentName]) {
      secrets.agents[agentName] = {};
    }
    secrets.agents[agentName][key] = value;
    this.writeSecrets(secrets);
  }

  /**
   * Get all secrets for an agent.
   * Returns empty object if agent has no secrets.
   */
  getAgentSecrets(agentName: string): Record<string, string> {
    const secrets = this.readSecrets();
    if (!secrets) return {};
    return secrets.agents?.[agentName] ?? {};
  }

  /**
   * Set multiple secrets for an agent at once.
   */
  setAgentSecrets(agentName: string, newSecrets: Record<string, string>): void {
    const secrets = this.readSecrets() || { agents: {} };
    secrets.agents[agentName] = {
      ...(secrets.agents[agentName] || {}),
      ...newSecrets,
    };
    this.writeSecrets(secrets);
  }

  /**
   * Delete all secrets for an agent.
   */
  deleteAgent(agentName: string): void {
    const secrets = this.readSecrets();
    if (!secrets || !secrets.agents[agentName]) return;
    delete secrets.agents[agentName];
    this.writeSecrets(secrets);
  }

  /**
   * Delete a specific secret for an agent.
   */
  deleteSecret(agentName: string, key: string): void {
    const secrets = this.readSecrets();
    if (!secrets || !secrets.agents?.[agentName]) return;
    delete secrets.agents[agentName][key];
    // Clean up empty agent entries
    if (Object.keys(secrets.agents[agentName]).length === 0) {
      delete secrets.agents[agentName];
    }
    this.writeSecrets(secrets);
  }

  /**
   * Check if any secrets exist for an agent.
   */
  hasAgent(agentName: string): boolean {
    const secrets = this.readSecrets();
    if (!secrets) return false;
    return !!secrets.agents?.[agentName] && Object.keys(secrets.agents[agentName]).length > 0;
  }

  /**
   * Check if a specific secret exists for an agent.
   */
  hasSecret(agentName: string, key: string): boolean {
    return this.getSecret(agentName, key) !== null;
  }

  /**
   * List all agent names that have stored secrets.
   */
  listAgents(): string[] {
    const secrets = this.readSecrets();
    if (!secrets) return [];
    return Object.keys(secrets.agents);
  }

  /** Whether the encrypted store file exists. */
  get exists(): boolean {
    return fs.existsSync(this.encryptedFile);
  }

  // ── Key Management ────────────────────────────────────────────────

  /**
   * Initialize with a user-provided password.
   * Derives the master key via PBKDF2.
   * Returns true if this created a new store (vs unlocked existing).
   */
  initWithPassword(password: string): boolean {
    const isNew = !this.exists;

    if (isNew) {
      // Generate salt and derive key
      const salt = crypto.randomBytes(PBKDF2_SALT_LENGTH);
      const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, MASTER_KEY_LENGTH, 'sha256');

      // Store salt alongside key file (salt is not secret, just needs to be consistent)
      const keyData = JSON.stringify({
        type: 'pbkdf2',
        salt: salt.toString('base64'),
        iterations: PBKDF2_ITERATIONS,
      });
      fs.writeFileSync(this.keyFile, keyData, { mode: 0o600 });

      this.masterKey = key;
      // Create empty secrets
      this.writeSecrets({ agents: {} });
    } else {
      // Read salt from key file and derive key
      this.masterKey = this.deriveKeyFromPassword(password);
      // Verify by trying to read — will throw if wrong password
      this.readSecrets();
    }

    return isNew;
  }

  /**
   * Initialize with auto-generated key in OS keychain.
   * Transparent — no password needed.
   * Returns false if keychain is not available.
   */
  initWithKeychain(): boolean {
    if (!this.useKeychain) return false;
    const key = this.readKeychain();
    if (key) {
      this.masterKey = key;
      return true;
    }

    // Generate a new key and store in keychain
    const newKey = crypto.randomBytes(MASTER_KEY_LENGTH);
    if (this.writeKeychain(newKey)) {
      this.masterKey = newKey;
      // Mark key file as keychain-backed
      fs.writeFileSync(this.keyFile, JSON.stringify({ type: 'keychain' }), { mode: 0o600 });
      if (!this.exists) {
        this.writeSecrets({ agents: {} });
      }
      return true;
    }

    return false;
  }

  /**
   * Auto-initialize: respects existing store type, falls back to keychain for new stores.
   * When keychain is unavailable, falls back to a machine-derived password.
   * Returns true if the store is ready to use without user interaction.
   */
  autoInit(): boolean {
    // If already initialized, we're good
    if (this.masterKey) return true;

    // Check existing key file type FIRST — don't override an existing store
    if (fs.existsSync(this.keyFile)) {
      try {
        const keyData = JSON.parse(fs.readFileSync(this.keyFile, 'utf-8'));
        if (keyData.type === 'keychain') {
          // Keychain-backed store — try to read from keychain
          return this.initWithKeychain();
        }
        if (keyData.type === 'pbkdf2-auto') {
          // Auto-generated machine-derived password — can re-unlock
          return this.initWithMachinePassword();
        }
        if (keyData.type === 'pbkdf2') {
          // User-set password store — need user to provide password
          return false;
        }
      } catch {
        // @silent-fallback-ok — fallback to local store when global unavailable
        return false;
      }
    }

    // No key file exists yet — try keychain, then machine-derived password
    if (this.initWithKeychain()) return true;

    // Keychain not available — auto-create with machine-derived password
    return this.initWithMachinePassword();
  }

  /**
   * Initialize with a machine-derived password (hostname + homedir).
   * The key file is marked as 'pbkdf2-auto' so autoInit() can re-unlock.
   */
  private initWithMachinePassword(): boolean {
    const password = `instar-local-${os.hostname()}-${os.homedir()}`;
    const isNew = !this.exists;

    if (isNew) {
      const salt = crypto.randomBytes(PBKDF2_SALT_LENGTH);
      const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, MASTER_KEY_LENGTH, 'sha256');
      const keyData = JSON.stringify({
        type: 'pbkdf2-auto',
        salt: salt.toString('base64'),
        iterations: PBKDF2_ITERATIONS,
      });
      fs.writeFileSync(this.keyFile, keyData, { mode: 0o600 });
      this.masterKey = key;
      this.writeSecrets({ agents: {} });
    } else {
      this.masterKey = this.deriveKeyFromPassword(password);
      this.readSecrets(); // Verify
    }

    return true;
  }

  /** Whether the store requires a password to unlock. */
  requiresPassword(): boolean {
    if (!fs.existsSync(this.keyFile)) return false;
    try {
      const keyData = JSON.parse(fs.readFileSync(this.keyFile, 'utf-8'));
      return keyData.type === 'pbkdf2';
    } catch {
      return false;
    }
  }

  // ── Encryption ────────────────────────────────────────────────────

  private readSecrets(): GlobalSecrets | null {
    if (!fs.existsSync(this.encryptedFile)) return null;
    if (!this.masterKey) {
      // Try auto-init
      if (!this.autoInit()) return null;
    }

    const raw = fs.readFileSync(this.encryptedFile);
    return this.decrypt(raw);
  }

  private writeSecrets(secrets: GlobalSecrets): void {
    if (!this.masterKey) throw new Error('GlobalSecretStore not initialized — call initWithKeychain() or initWithPassword() first');

    const encrypted = this.encrypt(secrets);

    // Atomic write
    const tmpPath = this.encryptedFile + '.tmp';
    fs.writeFileSync(tmpPath, encrypted, { mode: 0o600 });
    fs.renameSync(tmpPath, this.encryptedFile);
  }

  private encrypt(data: GlobalSecrets): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey!, iv);
    const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: [iv (12)] [tag (16)] [ciphertext]
    return Buffer.concat([iv, tag, encrypted]);
  }

  private decrypt(raw: Buffer): GlobalSecrets {
    if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      throw new Error('GlobalSecretStore: encrypted file is too short (corrupted?)');
    }

    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey!, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf-8'));
  }

  // ── Key Derivation ────────────────────────────────────────────────

  private deriveKeyFromPassword(password: string): Buffer {
    if (!fs.existsSync(this.keyFile)) {
      throw new Error('No key file found — store has not been initialized');
    }

    const keyData = JSON.parse(fs.readFileSync(this.keyFile, 'utf-8'));
    if (keyData.type !== 'pbkdf2' && keyData.type !== 'pbkdf2-auto') {
      throw new Error('Store is not password-based');
    }

    const salt = Buffer.from(keyData.salt, 'base64');
    const iterations = keyData.iterations || PBKDF2_ITERATIONS;
    return crypto.pbkdf2Sync(password, salt, iterations, MASTER_KEY_LENGTH, 'sha256');
  }

  // ── macOS Keychain ────────────────────────────────────────────────

  private readKeychain(): Buffer | null {
    if (process.platform !== 'darwin') return null;

    try {
      const result = execFileSync('security', [
        'find-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', KEYCHAIN_ACCOUNT,
        '-w',
      ], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      return Buffer.from(result, 'base64');
    } catch {
      // @silent-fallback-ok — fallback to local store when global unavailable
      return null;
    }
  }

  private writeKeychain(key: Buffer): boolean {
    if (process.platform !== 'darwin') return false;

    try {
      // Delete existing entry first
      try {
        execFileSync('security', [
          'delete-generic-password',
          '-s', KEYCHAIN_SERVICE,
          '-a', KEYCHAIN_ACCOUNT,
        ], { stdio: 'pipe', timeout: 5000 });
      } catch {
        // @silent-fallback-ok — fallback to local store when global unavailable
        // Entry may not exist
      }

      execFileSync('security', [
        'add-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', KEYCHAIN_ACCOUNT,
        '-w', key.toString('base64'),
      ], { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch {
      // @silent-fallback-ok — fallback to local store when global unavailable
      return false;
    }
  }

  /** Destroy all stored secrets and keys. For testing only. */
  destroy(): void {
    // safe-git-allow: incremental-migration
    if (fs.existsSync(this.encryptedFile)) fs.unlinkSync(this.encryptedFile);
    // safe-git-allow: incremental-migration
    if (fs.existsSync(this.keyFile)) fs.unlinkSync(this.keyFile);
    this.masterKey = null;
  }
}
