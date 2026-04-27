/**
 * TelemetryAuth — Installation identity and HMAC signing for Baseline telemetry.
 *
 * Manages:
 *   - Installation ID: Random UUID, stored at {stateDir}/telemetry/install-id
 *   - HMAC secret: 32 random bytes (hex), stored at {stateDir}/telemetry/local-secret
 *   - Signature generation using canonical message format
 *
 * Security:
 *   - Secret file is chmod 600 (owner read/write only)
 *   - Telemetry directory is chmod 700
 *   - Secret never leaves the machine — only the HMAC signature is transmitted
 */

import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class TelemetryAuth {
  private telemetryDir: string;
  private installIdPath: string;
  private secretPath: string;

  constructor(stateDir: string) {
    this.telemetryDir = path.join(stateDir, 'telemetry');
    this.installIdPath = path.join(this.telemetryDir, 'install-id');
    this.secretPath = path.join(this.telemetryDir, 'local-secret');
  }

  /**
   * Check if this installation has been provisioned (has install-id and secret).
   */
  isProvisioned(): boolean {
    return fs.existsSync(this.installIdPath) && fs.existsSync(this.secretPath);
  }

  /**
   * Provision identity files. Called on `instar telemetry enable`.
   * Creates install-id and local-secret with secure permissions.
   */
  provision(): { installationId: string; created: boolean } {
    // Ensure directory exists with restricted permissions
    if (!fs.existsSync(this.telemetryDir)) {
      fs.mkdirSync(this.telemetryDir, { recursive: true, mode: 0o700 });
    } else {
      // Ensure correct permissions even if directory already exists
      try { fs.chmodSync(this.telemetryDir, 0o700); } catch { /* best-effort */ }
    }

    let created = false;

    // Generate install-id if missing
    if (!fs.existsSync(this.installIdPath)) {
      const installId = randomUUID();
      fs.writeFileSync(this.installIdPath, installId, { mode: 0o600 });
      created = true;
    }

    // Generate secret if missing
    if (!fs.existsSync(this.secretPath)) {
      const secret = randomBytes(32).toString('hex');
      fs.writeFileSync(this.secretPath, secret, { mode: 0o600 });
      created = true;
    }

    return { installationId: this.getInstallationId()!, created };
  }

  /**
   * Read the installation ID, or null if not provisioned.
   */
  getInstallationId(): string | null {
    try {
      return fs.readFileSync(this.installIdPath, 'utf-8').trim();
    } catch {
      // @silent-fallback-ok — missing install ID file is normal pre-provisioning state
      return null;
    }
  }

  /**
   * Read the HMAC secret, or null if not provisioned.
   */
  private getSecret(): string | null {
    try {
      return fs.readFileSync(this.secretPath, 'utf-8').trim();
    } catch {
      // @silent-fallback-ok — missing secret file is normal pre-provisioning state
      return null;
    }
  }

  /**
   * Sign a submission payload using HMAC-SHA256 with canonical message format.
   *
   * Canonical message: installationId:timestamp:hex(SHA-256(payload))
   *
   * @param installationId - The 36-character UUID
   * @param timestamp - Unix epoch seconds as decimal string
   * @param payloadBytes - The exact JSON request body as bytes
   * @returns The hex-encoded HMAC signature, or null if not provisioned
   */
  sign(installationId: string, timestamp: string, payloadBytes: Buffer): string | null {
    const secret = this.getSecret();
    if (!secret) return null;

    const payloadHash = createHash('sha256').update(payloadBytes).digest('hex');
    const message = `${installationId}:${timestamp}:${payloadHash}`;

    return createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(message)
      .digest('hex');
  }

  /**
   * Compute the key fingerprint for server-side binding.
   * SHA-256(installationId + ":" + localSecret)
   */
  getKeyFingerprint(): string | null {
    const installId = this.getInstallationId();
    const secret = this.getSecret();
    if (!installId || !secret) return null;

    return createHash('sha256')
      .update(`${installId}:${secret}`)
      .digest('hex');
  }

  /**
   * Delete all local identity files. Called on `instar telemetry disable`.
   */
  deprovision(): void {
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(this.installIdPath); } catch { /* may not exist */ }
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(this.secretPath); } catch { /* may not exist */ }
  }

  /**
   * Get the first 8 characters of the installation ID (for status display).
   */
  getInstallationIdPrefix(): string | null {
    const id = this.getInstallationId();
    return id ? id.slice(0, 8) : null;
  }
}
