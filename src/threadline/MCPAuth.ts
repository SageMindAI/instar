/**
 * MCPAuth — Token-based authentication for the Threadline MCP Tool Server.
 *
 * Manages bearer tokens for network transports (SSE, HTTP streamable).
 * Local stdio transport needs no auth — this module is only relevant
 * when the MCP server is exposed over the network.
 *
 * Security model:
 * - Tokens generated with crypto.randomBytes (32 bytes, hex-encoded)
 * - Only SHA-256 hashes stored on disk — raw tokens returned once at creation
 * - Scoped access: send, read, discover, admin (admin implies all others)
 * - Optional expiry, explicit revocation, soft-delete
 *
 * Storage: {stateDir}/threadline/mcp-tokens.json
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export type MCPTokenScope =
  | 'threadline:send'
  | 'threadline:read'
  | 'threadline:discover'
  | 'threadline:admin';

/** Stored token record (never contains raw token) */
export interface MCPTokenInfo {
  id: string;
  name: string;
  scopes: MCPTokenScope[];
  hashedToken: string;
  createdAt: string;
  expiresAt: string | null;
  revoked: boolean;
}

/** Returned once at token creation — the only time the raw token is available */
export interface MCPTokenCreateResult {
  id: string;
  name: string;
  scopes: MCPTokenScope[];
  rawToken: string;
  createdAt: string;
  expiresAt: string | null;
}

// ── Constants ────────────────────────────────────────────────────────

/** Token byte length (32 bytes → 64 hex chars) */
const TOKEN_BYTES = 32;

/** Scopes that threadline:admin implicitly includes */
const ADMIN_IMPLIED_SCOPES: MCPTokenScope[] = [
  'threadline:send',
  'threadline:read',
  'threadline:discover',
];

// ── Helpers ──────────────────────────────────────────────────────────

function atomicWrite(filePath: string, data: string): void {
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

function safeJsonParse<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateTokenId(): string {
  return `mcp_${crypto.randomBytes(8).toString('hex')}`;
}

function generateRawToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// ── Implementation ───────────────────────────────────────────────────

interface TokensFile {
  tokens: MCPTokenInfo[];
  updatedAt: string;
}

export class MCPAuth {
  private readonly threadlineDir: string;
  private readonly tokensPath: string;
  private tokens: MCPTokenInfo[];

  constructor(stateDir: string) {
    this.threadlineDir = path.join(stateDir, 'threadline');
    fs.mkdirSync(this.threadlineDir, { recursive: true });
    this.tokensPath = path.join(this.threadlineDir, 'mcp-tokens.json');
    this.tokens = this.loadTokens();
  }

  // ── Token Creation ───────────────────────────────────────────────

  /**
   * Create a new MCP auth token.
   *
   * The raw token is returned exactly once in the result. It is never
   * stored — only a SHA-256 hash is persisted. Callers must save the
   * raw token securely.
   *
   * @param name Human-readable label for the token
   * @param scopes Access scopes granted to this token
   * @param expiresInSeconds Optional TTL; omit for non-expiring tokens
   */
  createToken(
    name: string,
    scopes: MCPTokenScope[],
    expiresInSeconds?: number
  ): MCPTokenCreateResult {
    const id = generateTokenId();
    const rawToken = generateRawToken();
    const now = new Date();

    const expiresAt = expiresInSeconds != null
      ? new Date(now.getTime() + expiresInSeconds * 1000).toISOString()
      : null;

    const tokenInfo: MCPTokenInfo = {
      id,
      name,
      scopes: [...scopes],
      hashedToken: hashToken(rawToken),
      createdAt: now.toISOString(),
      expiresAt,
      revoked: false,
    };

    this.tokens.push(tokenInfo);
    this.save();

    return {
      id,
      name,
      scopes: [...scopes],
      rawToken,
      createdAt: tokenInfo.createdAt,
      expiresAt,
    };
  }

  // ── Token Validation ─────────────────────────────────────────────

  /**
   * Validate a raw bearer token.
   *
   * Returns the token info if the token is valid, not expired, and not
   * revoked. Returns null otherwise.
   */
  validateToken(rawToken: string): MCPTokenInfo | null {
    const hashed = hashToken(rawToken);
    const token = this.tokens.find(t => t.hashedToken === hashed);

    if (!token) return null;
    if (token.revoked) return null;

    // Check expiry
    if (token.expiresAt) {
      const expiresAt = new Date(token.expiresAt).getTime();
      if (Date.now() >= expiresAt) return null;
    }

    return token;
  }

  // ── Scope Checking ───────────────────────────────────────────────

  /**
   * Check whether a token has the required scope.
   *
   * `threadline:admin` implicitly grants all other threadline scopes.
   */
  hasScope(tokenInfo: MCPTokenInfo, requiredScope: MCPTokenScope): boolean {
    // Direct scope match
    if (tokenInfo.scopes.includes(requiredScope)) return true;

    // Admin implies all other scopes
    if (tokenInfo.scopes.includes('threadline:admin')) {
      if (ADMIN_IMPLIED_SCOPES.includes(requiredScope)) return true;
      // Admin also matches itself
      if (requiredScope === 'threadline:admin') return true;
    }

    return false;
  }

  // ── Token Revocation ─────────────────────────────────────────────

  /**
   * Revoke a token by ID. The token remains in storage (for audit
   * purposes) but will no longer validate.
   *
   * Returns true if the token was found and revoked, false if not found
   * or already revoked.
   */
  revokeToken(tokenId: string): boolean {
    const token = this.tokens.find(t => t.id === tokenId);
    if (!token) return false;
    if (token.revoked) return false;

    token.revoked = true;
    this.save();
    return true;
  }

  // ── Token Listing ────────────────────────────────────────────────

  /**
   * List all tokens with metadata. The hashedToken field is included
   * (it's a hash, not the raw token) but raw tokens are never exposed.
   *
   * Returns all tokens including revoked ones — callers can filter
   * by the `revoked` field.
   */
  listTokens(): MCPTokenInfo[] {
    // Return copies to prevent external mutation
    return this.tokens.map(t => ({ ...t, scopes: [...t.scopes] }));
  }

  // ── Token Deletion ───────────────────────────────────────────────

  /**
   * Permanently delete a token by ID.
   *
   * Unlike revocation, this removes the token from storage entirely.
   * Use revocation for audit trails; deletion for cleanup.
   *
   * Returns true if the token was found and deleted.
   */
  deleteToken(tokenId: string): boolean {
    const idx = this.tokens.findIndex(t => t.id === tokenId);
    if (idx === -1) return false;

    this.tokens.splice(idx, 1);
    this.save();
    return true;
  }

  // ── Persistence ────────────────────────────────────────────────────

  /**
   * Force reload tokens from disk.
   */
  reload(): void {
    this.tokens = this.loadTokens();
  }

  // ── Private ────────────────────────────────────────────────────────

  private loadTokens(): MCPTokenInfo[] {
    const data = safeJsonParse<TokensFile>(this.tokensPath, {
      tokens: [],
      updatedAt: '',
    });
    return data.tokens;
  }

  private save(): void {
    try {
      const data: TokensFile = {
        tokens: this.tokens,
        updatedAt: new Date().toISOString(),
      };
      atomicWrite(this.tokensPath, JSON.stringify(data, null, 2));
    } catch {
      // Save failure should never break auth evaluation
    }
  }
}
