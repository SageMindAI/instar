/**
 * State Write Authority — enforces primary-machine-writes-only model.
 *
 * In multi-machine setups:
 * - The primary machine is the canonical writer for agent state files
 * - Secondary machines submit changes via API to the primary
 * - If primary is offline, secondaries queue changes locally
 * - Write-tokens are scoped to non-escalating operations
 *
 * Project files (source code) are unaffected — normal git workflow.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MachineIdentity, AgentAutonomyConfig } from './types.js';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';

// ── Types ────────────────────────────────────────────────────────────

export type WriteOperation =
  | 'addMemory'
  | 'updateProfile'
  | 'heartbeat'
  | 'modifyUser'
  | 'modifyPermissions'
  | 'transferPrimary';

export interface WriteToken {
  /** 32-byte random token */
  token: string;
  /** Machine ID this token was issued to */
  machineId: string;
  /** ISO timestamp of issuance */
  issuedAt: string;
  /** Whether this token has been revoked */
  revoked: boolean;
}

export interface OfflineQueueEntry {
  /** ISO timestamp of the queued operation */
  timestamp: string;
  /** Operation type */
  operation: WriteOperation;
  /** Operation payload */
  payload: Record<string, unknown>;
  /** Number of replay attempts */
  retryCount: number;
  /** Machine that queued this operation */
  sourceMachineId: string;
}

/** Operations that can never be queued or replayed */
const ESCALATING_OPERATIONS: WriteOperation[] = [
  'modifyUser',
  'modifyPermissions',
  'transferPrimary',
];

/** Operations that can be queued for offline replay */
const NON_ESCALATING_OPERATIONS: WriteOperation[] = [
  'addMemory',
  'updateProfile',
  'heartbeat',
];

const OFFLINE_QUEUE_TTL_DAYS = 7;

// ── Write Token Management ───────────────────────────────────────────

/**
 * Generate a new write token for a machine.
 */
export function generateWriteToken(machineId: string): WriteToken {
  return {
    token: crypto.randomBytes(32).toString('hex'),
    machineId,
    issuedAt: new Date().toISOString(),
    revoked: false,
  };
}

/**
 * Validate a write token.
 */
export function validateWriteToken(
  token: string,
  storedTokens: WriteToken[],
): { valid: boolean; machineId?: string; error?: string } {
  const match = storedTokens.find(t => t.token === token && !t.revoked);
  if (!match) {
    return { valid: false, error: 'Invalid or revoked write token' };
  }
  return { valid: true, machineId: match.machineId };
}

// ── Operation Authorization ──────────────────────────────────────────

/**
 * Check if an operation can be performed by a secondary machine.
 * Escalating operations require interactive confirmation from primary admin.
 */
export function canPerformOperation(operation: WriteOperation): {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason?: string;
} {
  if (ESCALATING_OPERATIONS.includes(operation)) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: `${operation} requires interactive confirmation from the primary machine's admin`,
    };
  }
  return { allowed: true, requiresConfirmation: false };
}

// ── Offline Queue ────────────────────────────────────────────────────

/**
 * Manages the offline queue for secondary machines.
 * When the primary is unreachable, changes are queued locally.
 */
export class OfflineQueue {
  private queueDir: string;
  private queueFile: string;

  constructor(stateDir: string, agentId: string) {
    this.queueDir = path.join(
      process.env.HOME || process.env.USERPROFILE || '/tmp',
      '.instar',
      'offline-queue',
    );
    fs.mkdirSync(this.queueDir, { recursive: true });
    this.queueFile = path.join(this.queueDir, `${agentId}.jsonl`);
  }

  /**
   * Add an operation to the offline queue.
   * Only non-escalating operations can be queued.
   */
  enqueue(operation: WriteOperation, payload: Record<string, unknown>, machineId: string): boolean {
    if (ESCALATING_OPERATIONS.includes(operation)) {
      return false; // Cannot queue escalating operations
    }

    const entry: OfflineQueueEntry = {
      timestamp: new Date().toISOString(),
      operation,
      payload,
      retryCount: 0,
      sourceMachineId: machineId,
    };

    maybeRotateJsonl(this.queueFile, { maxBytes: 5 * 1024 * 1024, keepRatio: 0.5 });
    fs.appendFileSync(this.queueFile, JSON.stringify(entry) + '\n');
    return true;
  }

  /**
   * Read and drain the offline queue (for replay on reconnect).
   * Returns entries in order. Expired entries (>7 days) are skipped.
   */
  drain(): OfflineQueueEntry[] {
    if (!fs.existsSync(this.queueFile)) return [];

    const content = fs.readFileSync(this.queueFile, 'utf-8').trim();
    if (!content) return [];

    const now = Date.now();
    const ttlMs = OFFLINE_QUEUE_TTL_DAYS * 24 * 60 * 60 * 1000;

    const entries: OfflineQueueEntry[] = [];
    const expired: OfflineQueueEntry[] = [];

    for (const line of content.split('\n')) {
      try {
        const entry: OfflineQueueEntry = JSON.parse(line);
        const age = now - new Date(entry.timestamp).getTime();
        if (age > ttlMs) {
          expired.push(entry);
        } else {
          entries.push(entry);
        }
      } catch {
        // @silent-fallback-ok — skip malformed queue entries
      }
    }

    // Clear the queue file
    fs.writeFileSync(this.queueFile, '');

    if (expired.length > 0) {
      console.warn(`[OfflineQueue] ${expired.length} entries expired (>7 days)`);
    }

    return entries;
  }

  /**
   * Get the count of queued operations.
   */
  count(): number {
    if (!fs.existsSync(this.queueFile)) return 0;
    const content = fs.readFileSync(this.queueFile, 'utf-8').trim();
    if (!content) return 0;
    return content.split('\n').filter(l => l.trim()).length;
  }
}

// ── Conflict Resolution ──────────────────────────────────────────────

export interface ConflictResolution {
  file: string;
  machineA: { machineId: string; change: string };
  machineB: { machineId: string; change: string };
  agentRecommendation?: string;
  autoResolvable: boolean;
}

/**
 * Assess a merge conflict and determine if it can be auto-resolved.
 * users.json additions can be merged; config.json always escalates.
 */
export function assessConflict(
  file: string,
  autonomy?: AgentAutonomyConfig,
): { autoResolvable: boolean; reason: string } {
  // config.json always requires human judgment
  if (file === 'config.json') {
    return { autoResolvable: false, reason: 'Config conflicts always require human judgment' };
  }

  // users.json: additions can be auto-merged
  if (file === 'users.json') {
    // At collaborative+, propose resolution
    if (autonomy && autonomy.level !== 'supervised') {
      return { autoResolvable: true, reason: 'User additions can be merged automatically' };
    }
    return { autoResolvable: false, reason: 'Escalated per supervised autonomy level' };
  }

  // Other files: auto-resolve at autonomous level
  if (autonomy?.level === 'autonomous' && autonomy.capabilities.proposeConflictResolution) {
    return { autoResolvable: true, reason: 'Auto-resolved per autonomous autonomy level' };
  }

  return { autoResolvable: false, reason: 'Requires manual resolution' };
}
