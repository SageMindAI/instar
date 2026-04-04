/**
 * KeyRotation — Ed25519 key rotation with dual-signed proofs.
 *
 * Spec Section 3.10:
 * - Generate new keypair
 * - Sign rotation proof with BOTH old and new keys
 * - Broadcast to contacts and MoltBridge
 * - Old key enters 72h grace period (can verify old sigs, can't create new grants)
 * - After grace period, old key permanently revoked
 */

import crypto from 'node:crypto';
import { generateIdentityKeyPair, sign, verify } from '../threadline/ThreadlineCrypto.js';
import { computeCanonicalId, computeDisplayFingerprint, KEY_ROTATION_GRACE_MS, type RotationProof } from './types.js';

// ── Constants ────────────────────────────────────────────────────────

const ROTATION_PROOF_DOMAIN = 'instar-key-rotation-v1';

// ── Public API ───────────────────────────────────────────────────────

/**
 * Generate a new keypair and create a dual-signed rotation proof.
 *
 * Both the old and new private keys sign the same rotation payload,
 * proving the holder controls both keys.
 */
export function createRotation(
  oldPrivateKey: Buffer,
  oldPublicKey: Buffer,
  reason: string,
): { newKeypair: { publicKey: Buffer; privateKey: Buffer }; proof: RotationProof } {
  const newKeypair = generateIdentityKeyPair();
  const timestamp = new Date().toISOString();

  const message = buildRotationMessage(oldPublicKey, newKeypair.publicKey, timestamp, reason);

  const oldKeySignature = sign(oldPrivateKey, message);
  const newKeySignature = sign(newKeypair.privateKey, message);

  const proof: RotationProof = {
    oldPublicKey: oldPublicKey.toString('base64'),
    newPublicKey: newKeypair.publicKey.toString('base64'),
    timestamp,
    reason,
    oldKeySignature: oldKeySignature.toString('base64'),
    newKeySignature: newKeySignature.toString('base64'),
  };

  return { newKeypair, proof };
}

/**
 * Verify a rotation proof: both signatures must be valid.
 */
export function verifyRotationProof(proof: RotationProof): boolean {
  const oldPub = Buffer.from(proof.oldPublicKey, 'base64');
  const newPub = Buffer.from(proof.newPublicKey, 'base64');

  const message = buildRotationMessage(oldPub, newPub, proof.timestamp, proof.reason);

  const oldSigValid = verify(oldPub, message, Buffer.from(proof.oldKeySignature, 'base64'));
  const newSigValid = verify(newPub, message, Buffer.from(proof.newKeySignature, 'base64'));

  return oldSigValid && newSigValid;
}

/**
 * Check if a rotation is within the grace period.
 *
 * During grace: old key can verify old signatures but not create new grants.
 * After grace: old key is permanently revoked.
 */
export function isWithinGracePeriod(rotationTimestamp: string, now?: Date): boolean {
  const rotatedAt = new Date(rotationTimestamp).getTime();
  const currentTime = (now ?? new Date()).getTime();
  return currentTime - rotatedAt < KEY_ROTATION_GRACE_MS;
}

/**
 * Compute the canonical ID for the new key after rotation.
 */
export function computeRotatedCanonicalId(newPublicKey: Buffer): {
  canonicalId: string;
  displayFingerprint: string;
} {
  const canonicalId = computeCanonicalId(newPublicKey);
  return {
    canonicalId,
    displayFingerprint: computeDisplayFingerprint(canonicalId),
  };
}

// ── Internal ─────────────────────────────────────────────────────────

function buildRotationMessage(
  oldPub: Buffer,
  newPub: Buffer,
  timestamp: string,
  reason: string,
): Buffer {
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(ROTATION_PROOF_DOMAIN, 'utf-8'));
  hash.update(oldPub);
  hash.update(newPub);
  hash.update(Buffer.from(timestamp, 'utf-8'));
  hash.update(Buffer.from(reason, 'utf-8'));
  return hash.digest();
}
