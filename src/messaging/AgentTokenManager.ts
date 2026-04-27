/**
 * AgentTokenManager — per-agent authentication tokens for cross-agent messaging.
 *
 * Each agent on the machine gets a 256-bit random token stored at:
 *   ~/.instar/agent-tokens/{agentName}.token
 *
 * Tokens are generated on first agent registration and persist across restarts.
 * Used for:
 *   - Bearer auth on relay-agent endpoint (proving sender identity)
 *   - HMAC computation on message drops (tamper protection for offline delivery)
 *
 * Security properties:
 *   - Tokens are file-permission protected (0600 — owner read/write only)
 *   - Token directory is 0700
 *   - Agent names are validated to prevent path traversal
 *
 * Derived from: docs/specs/INTER-AGENT-MESSAGING-SPEC.md v3.1 §Cross-Agent Resolution
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const TOKEN_SIZE_BYTES = 32; // 256 bits
const TOKEN_DIR_NAME = 'agent-tokens';

/** Get the token directory path */
function tokenDir(): string {
  return path.join(os.homedir(), '.instar', TOKEN_DIR_NAME);
}

/** Get the token file path for a specific agent */
function tokenPath(agentName: string): string {
  return path.join(tokenDir(), `${agentName}.token`);
}

/**
 * Validate an agent name for safe use in file paths.
 * Rejects names with path separators, null bytes, dots, or non-alphanumeric chars.
 */
function validateTokenAgentName(name: string): boolean {
  if (!name || name.length > 64) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || name.includes('..')) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
}

/**
 * Ensure the token directory exists with proper permissions.
 */
export function ensureTokenDir(): void {
  const dir = tokenDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Enforce permissions even if dir already existed
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // @silent-fallback-ok — chmod may fail on some filesystems, token files themselves are still protected
  }
}

/**
 * Generate a new agent token and persist it to disk.
 * If a token already exists for this agent, returns the existing token.
 *
 * @param agentName - The agent's canonical name (validated for path safety)
 * @returns The hex-encoded token string
 */
export function generateAgentToken(agentName: string): string {
  if (!validateTokenAgentName(agentName)) {
    throw new Error(`Invalid agent name for token generation: "${agentName}"`);
  }

  ensureTokenDir();

  const filePath = tokenPath(agentName);

  // If token already exists, return it
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8').trim();
  }

  // Generate new 256-bit random token
  const token = crypto.randomBytes(TOKEN_SIZE_BYTES).toString('hex');

  // Write with restricted permissions
  fs.writeFileSync(filePath, token, { mode: 0o600, encoding: 'utf-8' });

  return token;
}

/**
 * Read an agent's token from disk.
 * Used by the sending agent to authenticate with the target agent's relay endpoint.
 *
 * @param agentName - The target agent's name
 * @returns The hex-encoded token, or null if no token exists
 */
export function getAgentToken(agentName: string): string | null {
  if (!validateTokenAgentName(agentName)) return null;

  const filePath = tokenPath(agentName);
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    // @silent-fallback-ok — token file doesn't exist or not readable
    return null;
  }
}

/**
 * Verify a bearer token matches the expected agent token.
 * Used by the relay-agent endpoint to authenticate incoming requests.
 *
 * @param agentName - The agent whose token to check against
 * @param bearerToken - The token provided in the Authorization header
 * @returns true if the token matches
 */
export function verifyAgentToken(agentName: string, bearerToken: string): boolean {
  const stored = getAgentToken(agentName);
  if (!stored || !bearerToken) return false;

  // Constant-time comparison to prevent timing attacks
  const storedBuf = Buffer.from(stored, 'utf-8');
  const providedBuf = Buffer.from(bearerToken, 'utf-8');

  if (storedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(storedBuf, providedBuf);
}

/**
 * Compute HMAC-SHA256 for a message drop envelope.
 * Used when writing to the drop directory for offline same-machine delivery.
 *
 * The HMAC covers the same core fields as the cross-machine SignedPayload
 * (minus relayChain and signature which don't apply to same-machine drops).
 *
 * @param agentToken - The sending agent's token
 * @param fields - The fields to sign: { message, originServer, nonce, timestamp }
 */
export function computeDropHmac(
  agentToken: string,
  fields: { message: unknown; originServer: string; nonce: string; timestamp: string },
): string {
  // Canonical JSON: recursively sorted keys at all nesting levels.
  // NOTE: Cannot use JSON.stringify(fields, arrayReplacer) because array replacers
  // filter properties at EVERY nesting level, stripping inner message properties.
  const canonical = canonicalJSON(fields);
  return crypto.createHmac('sha256', agentToken).update(canonical).digest('hex');
}

/**
 * Serialize an object to canonical JSON (RFC 8785 / JCS).
 * Recursively sorts keys at all nesting levels for deterministic output.
 */
function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Verify HMAC on a received drop envelope.
 *
 * @param senderAgent - Name of the agent that wrote the drop
 * @param hmac - The HMAC value from the envelope
 * @param fields - The fields that were signed
 * @returns true if the HMAC is valid
 */
export function verifyDropHmac(
  senderAgent: string,
  hmac: string,
  fields: { message: unknown; originServer: string; nonce: string; timestamp: string },
): boolean {
  const senderToken = getAgentToken(senderAgent);
  if (!senderToken || !hmac) return false;

  const expected = computeDropHmac(senderToken, fields);

  // Constant-time comparison
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const providedBuf = Buffer.from(hmac, 'utf-8');

  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Delete an agent's token. Used during agent unregistration.
 */
export function deleteAgentToken(agentName: string): boolean {
  if (!validateTokenAgentName(agentName)) return false;

  const filePath = tokenPath(agentName);
  try {
    // safe-git-allow: incremental-migration
    fs.unlinkSync(filePath);
    return true;
  } catch {
    // @silent-fallback-ok — file may not exist
    return false;
  }
}

/**
 * List all agents that have tokens.
 */
export function listAgentTokens(): string[] {
  try {
    const dir = tokenDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.token'))
      .map(f => f.replace(/\.token$/, ''));
  } catch {
    // @silent-fallback-ok — directory not readable
    return [];
  }
}
