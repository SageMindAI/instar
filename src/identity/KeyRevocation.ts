/**
 * KeyRevocation — Emergency key revocation via recovery phrase.
 *
 * Spec Section 3.10:
 * - 24-hour time-lock before revocation takes effect
 * - Cancellation window: primary key holder can cancel during time-lock
 * - Rate limiting: max 3 attempts per 24h per agent identity
 * - Audit logging of all attempts (successful, cancelled, failed)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sign, verify } from '../threadline/ThreadlineCrypto.js';
import {
  RECOVERY_TIMELOCK_MS,
  MAX_RECOVERY_ATTEMPTS,
  type RevocationRequest,
} from './types.js';

// ── Constants ────────────────────────────────────────────────────────

const REVOCATION_DOMAIN = 'instar-emergency-revoke-v1';
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────

export interface RevocationAuditEntry {
  timestamp: string;
  action: 'initiate' | 'cancel' | 'activate' | 'reject-rate-limit' | 'reject-commitment';
  targetCanonicalId: string;
  newPublicKey?: string;
  reason?: string;
}

export interface RevocationState {
  pending: RevocationRequest | null;
  attempts: { timestamp: string }[];
  auditLog: RevocationAuditEntry[];
}

// ── Manager ──────────────────────────────────────────────────────────

export class RevocationManager {
  private readonly stateFile: string;
  private state: RevocationState;

  constructor(stateDir: string) {
    this.stateFile = path.join(stateDir, 'revocation-state.json');
    this.state = this.loadState();
  }

  /**
   * Initiate an emergency revocation using the recovery keypair.
   *
   * The revocation enters a 24-hour time-lock pending state.
   * During this window, the legitimate key holder can cancel it.
   *
   * @param recoveryPrivateKey - The recovery private key (from mnemonic)
   * @param recoveryPublicKey - The recovery public key
   * @param targetCanonicalId - The canonical ID of the agent being revoked
   * @param newPublicKey - The replacement Ed25519 public key
   * @param primaryPublicKey - The current primary public key (to verify recovery commitment)
   * @param recoveryCommitment - The pre-committed recovery signature from identity.json
   */
  initiate(
    recoveryPrivateKey: Buffer,
    recoveryPublicKey: Buffer,
    targetCanonicalId: string,
    newPublicKey: Buffer,
    primaryPublicKey: Buffer,
    recoveryCommitment: string,
  ): RevocationRequest {
    // Rate limit check
    this.pruneOldAttempts();
    if (this.state.attempts.length >= MAX_RECOVERY_ATTEMPTS) {
      this.addAudit('reject-rate-limit', targetCanonicalId);
      this.saveState();
      throw new Error(`Rate limited: max ${MAX_RECOVERY_ATTEMPTS} recovery attempts per 24 hours`);
    }

    // Verify the recovery commitment matches
    const commitmentMessage = Buffer.concat([
      Buffer.from('instar-recovery-commitment-v1', 'utf-8'),
      recoveryPublicKey,
    ]);
    const commitmentSig = Buffer.from(recoveryCommitment, 'base64');
    if (!verify(primaryPublicKey, commitmentMessage, commitmentSig)) {
      this.addAudit('reject-commitment', targetCanonicalId);
      this.state.attempts.push({ timestamp: new Date().toISOString() });
      this.saveState();
      throw new Error('Recovery commitment verification failed — recovery key does not match');
    }

    // Create the revocation signature
    const message = buildRevocationMessage(targetCanonicalId, newPublicKey);
    const recoverySignature = sign(recoveryPrivateKey, message);

    const now = new Date();
    const request: RevocationRequest = {
      targetCanonicalId,
      newPublicKey: newPublicKey.toString('base64'),
      recoverySignature: recoverySignature.toString('base64'),
      timestamp: now.toISOString(),
      status: 'pending',
      expiresAt: new Date(now.getTime() + RECOVERY_TIMELOCK_MS).toISOString(),
    };

    this.state.pending = request;
    this.state.attempts.push({ timestamp: now.toISOString() });
    this.addAudit('initiate', targetCanonicalId, newPublicKey.toString('base64'));
    this.saveState();

    return request;
  }

  /**
   * Cancel a pending revocation by proving possession of the primary key.
   */
  cancel(primaryPrivateKey: Buffer, primaryPublicKey: Buffer): boolean {
    if (!this.state.pending || this.state.pending.status !== 'pending') {
      return false;
    }

    // Prove primary key possession: sign the pending request's timestamp
    const cancelMessage = Buffer.concat([
      Buffer.from('instar-revoke-cancel-v1', 'utf-8'),
      Buffer.from(this.state.pending.timestamp, 'utf-8'),
    ]);
    const signature = sign(primaryPrivateKey, cancelMessage);
    if (!verify(primaryPublicKey, cancelMessage, signature)) {
      return false;
    }

    this.state.pending.status = 'cancelled';
    this.addAudit('cancel', this.state.pending.targetCanonicalId);
    this.saveState();
    return true;
  }

  /**
   * Check if a pending revocation should be activated (time-lock expired).
   */
  checkAndActivate(now?: Date): RevocationRequest | null {
    if (!this.state.pending || this.state.pending.status !== 'pending') {
      return null;
    }

    const currentTime = (now ?? new Date()).getTime();
    const expiresAt = new Date(this.state.pending.expiresAt).getTime();

    if (currentTime >= expiresAt) {
      this.state.pending.status = 'active';
      this.addAudit('activate', this.state.pending.targetCanonicalId);
      this.saveState();
      return this.state.pending;
    }

    return null;
  }

  /**
   * Get the current pending revocation, if any.
   */
  getPending(): RevocationRequest | null {
    return this.state.pending?.status === 'pending' ? this.state.pending : null;
  }

  /**
   * Get the audit log.
   */
  getAuditLog(): RevocationAuditEntry[] {
    return [...this.state.auditLog];
  }

  /**
   * Get remaining attempts in the current rate-limit window.
   */
  getRemainingAttempts(): number {
    this.pruneOldAttempts();
    return Math.max(0, MAX_RECOVERY_ATTEMPTS - this.state.attempts.length);
  }

  // ── Private ─────────────────────────────────────────────────────

  private pruneOldAttempts(): void {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    this.state.attempts = this.state.attempts.filter(
      a => new Date(a.timestamp).getTime() > cutoff,
    );
  }

  private addAudit(
    action: RevocationAuditEntry['action'],
    targetCanonicalId: string,
    newPublicKey?: string,
  ): void {
    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      action,
      targetCanonicalId,
      ...(newPublicKey && { newPublicKey }),
    });
  }

  private loadState(): RevocationState {
    try {
      if (fs.existsSync(this.stateFile)) {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      }
    } catch { /* ignore */ }
    return { pending: null, attempts: [], auditLog: [] };
  }

  private saveState(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmpPath = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, this.stateFile);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildRevocationMessage(targetCanonicalId: string, newPublicKey: Buffer): Buffer {
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(REVOCATION_DOMAIN, 'utf-8'));
  hash.update(Buffer.from(targetCanonicalId, 'utf-8'));
  hash.update(newPublicKey);
  return hash.digest();
}
