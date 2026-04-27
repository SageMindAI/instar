/**
 * CredentialProvider — cross-platform abstraction for Claude Code OAuth credential access.
 *
 * Implementations:
 * - KeychainCredentialProvider: macOS Keychain (os-encrypted, production-proven)
 * - ClaudeConfigCredentialProvider: File-based fallback (all platforms, 0600 permissions)
 *
 * Part of the Instar Quota Migration spec (Phase 1).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Interfaces ──────────────────────────────────────────────────────

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt: number;       // Unix timestamp (ms)
  refreshToken?: string;   // If available from OAuth flow
  email?: string;
}

export interface AccountInfo {
  email: string;
  name: string | null;
  hasToken: boolean;
  tokenExpired: boolean;
}

export type SecurityLevel = 'os-encrypted' | 'file-permission-only';

export interface CredentialProvider {
  /** Read the current active credentials */
  readCredentials(): Promise<ClaudeCredentials | null>;
  /** Write/update credentials */
  writeCredentials(creds: ClaudeCredentials): Promise<void>;
  /** Delete credentials for a specific account */
  deleteCredentials?(email: string): Promise<void>;
  /** List all known accounts */
  listAccounts?(): Promise<AccountInfo[]>;
  /** Platform identifier */
  platform: string;
  /** Security level of this provider's storage */
  securityLevel: SecurityLevel;
}

// ── Token Redaction ─────────────────────────────────────────────────

/**
 * Redact a token for safe logging. Shows first 4 chars only.
 * Returns "[TOKEN:abc1****]" format.
 */
export function redactToken(token: string): string {
  if (!token || token.length < 4) return '[TOKEN:****]';
  return `[TOKEN:${token.slice(0, 4)}****]`;
}

/**
 * Redact an email for safe logging.
 * Returns "[EMAIL:j***@***.com]" format.
 */
export function redactEmail(email: string): string {
  if (!email || !email.includes('@')) return '[EMAIL:****]';
  const [local, domain] = email.split('@');
  const domainParts = domain.split('.');
  const tld = domainParts[domainParts.length - 1];
  return `[EMAIL:${local[0]}***@***.${tld}]`;
}

// ── Keychain Provider (macOS) ───────────────────────────────────────

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export class KeychainCredentialProvider implements CredentialProvider {
  readonly platform = 'darwin';
  readonly securityLevel: SecurityLevel = 'os-encrypted';
  private keychainAccount: string;

  constructor() {
    this.keychainAccount = os.userInfo().username;
  }

  async readCredentials(): Promise<ClaudeCredentials | null> {
    try {
      const result = execFileSync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const data = JSON.parse(result.trim());
      const oauth = data.claudeAiOauth;
      if (!oauth?.accessToken) return null;

      return {
        accessToken: oauth.accessToken,
        expiresAt: oauth.expiresAt ?? 0,
        refreshToken: oauth.refreshToken,
        email: oauth.email,
      };
    } catch {
      // @silent-fallback-ok — Keychain may not have Claude credentials; null is expected
      return null;
    }
  }

  async writeCredentials(creds: ClaudeCredentials): Promise<void> {
    // Read existing data to preserve non-credential fields
    let existingData: Record<string, unknown> = {};
    try {
      const result = execFileSync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      existingData = JSON.parse(result.trim());
    } catch {
      // @silent-fallback-ok — no existing Keychain entry; start fresh
    }

    const newData = {
      ...existingData,
      claudeAiOauth: {
        ...(existingData.claudeAiOauth as Record<string, unknown> || {}),
        accessToken: creds.accessToken,
        expiresAt: creds.expiresAt,
        ...(creds.refreshToken ? { refreshToken: creds.refreshToken } : {}),
        ...(creds.email ? { email: creds.email } : {}),
      },
    };

    const jsonStr = JSON.stringify(newData);
    const hexStr = Buffer.from(jsonStr).toString('hex');
    execFileSync('security', ['-i'], {
      input: `add-generic-password -U -a "${this.keychainAccount}" -s "${KEYCHAIN_SERVICE}" -X "${hexStr}"\n`,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async deleteCredentials(_email: string): Promise<void> {
    try {
      execFileSync(
        'security',
        ['delete-generic-password', '-s', KEYCHAIN_SERVICE],
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch {
      // @silent-fallback-ok — Keychain entry already deleted or never existed
    }
  }
}

// ── Claude Config File Provider (All Platforms) ─────────────────────

/**
 * Reads credentials from Claude Code's local config files.
 * Falls back to file-based storage with enforced 0600 permissions.
 *
 * Config path: ~/.claude/ (standard Claude Code config directory)
 */
export class ClaudeConfigCredentialProvider implements CredentialProvider {
  readonly platform = process.platform;
  readonly securityLevel: SecurityLevel = 'file-permission-only';
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || path.join(os.homedir(), '.claude');
  }

  async readCredentials(): Promise<ClaudeCredentials | null> {
    try {
      // Try the credentials file first
      const credPath = path.join(this.configDir, 'credentials.json');
      if (!fs.existsSync(credPath)) {
        // Try the legacy .credentials file
        const legacyPath = path.join(this.configDir, '.credentials');
        if (!fs.existsSync(legacyPath)) return null;
        return this.parseCredentialFile(legacyPath);
      }
      return this.parseCredentialFile(credPath);
    } catch {
      // @silent-fallback-ok — credential file may be missing or malformed; null is expected
      return null;
    }
  }

  async writeCredentials(creds: ClaudeCredentials): Promise<void> {
    // Ensure directory exists with proper permissions
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    }

    const credPath = path.join(this.configDir, 'credentials.json');
    const data = {
      accessToken: creds.accessToken,
      expiresAt: creds.expiresAt,
      ...(creds.refreshToken ? { refreshToken: creds.refreshToken } : {}),
      ...(creds.email ? { email: creds.email } : {}),
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(credPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async deleteCredentials(_email: string): Promise<void> {
    const credPath = path.join(this.configDir, 'credentials.json');
    try {
      if (fs.existsSync(credPath)) {
        // safe-git-allow: incremental-migration
        fs.unlinkSync(credPath);
      }
    } catch {
      // @silent-fallback-ok — file already deleted or never existed
    }
  }

  private parseCredentialFile(filePath: string): ClaudeCredentials | null {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    // Handle multiple possible formats
    const token = data.accessToken || data.claudeAiOauth?.accessToken;
    if (!token) return null;

    return {
      accessToken: token,
      expiresAt: data.expiresAt || data.claudeAiOauth?.expiresAt || 0,
      refreshToken: data.refreshToken || data.claudeAiOauth?.refreshToken,
      email: data.email || data.claudeAiOauth?.email,
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create the best available credential provider for the current platform.
 *
 * Priority:
 * 1. macOS: Keychain (os-encrypted)
 * 2. All platforms: File-based (~/.claude/) with 0600 permissions
 *
 * Note: keytar support (Linux libsecret, Windows Credential Manager)
 * is planned but not yet implemented. When added, it will slot between
 * Keychain and file-based in the priority chain.
 */
export function createDefaultProvider(): CredentialProvider {
  if (process.platform === 'darwin') {
    return new KeychainCredentialProvider();
  }

  // File-based fallback — log security warning
  console.warn(
    '[CredentialProvider] Using file-based credential storage (less secure). ' +
    'Consider installing keytar for OS-native encrypted storage.'
  );
  return new ClaudeConfigCredentialProvider();
}
