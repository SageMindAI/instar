import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TelemetryAuth } from '../../src/monitoring/TelemetryAuth.js';

describe('TelemetryAuth', () => {
  let tmpDir: string;
  let auth: TelemetryAuth;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-auth-test-'));
    auth = new TelemetryAuth(tmpDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('isProvisioned()', () => {
    it('should return false before provisioning', () => {
      expect(auth.isProvisioned()).toBe(false);
    });

    it('should return true after provisioning', () => {
      auth.provision();
      expect(auth.isProvisioned()).toBe(true);
    });

    it('should return false if only install-id exists', () => {
      const telemetryDir = path.join(tmpDir, 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      fs.writeFileSync(path.join(telemetryDir, 'install-id'), 'test-id');
      expect(auth.isProvisioned()).toBe(false);
    });

    it('should return false if only secret exists', () => {
      const telemetryDir = path.join(tmpDir, 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      fs.writeFileSync(path.join(telemetryDir, 'local-secret'), 'test-secret');
      expect(auth.isProvisioned()).toBe(false);
    });
  });

  describe('provision()', () => {
    it('should create install-id as UUID', () => {
      const result = auth.provision();
      expect(result.created).toBe(true);
      // UUID v4 format
      expect(result.installationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('should create secret as 64-char hex (32 bytes)', () => {
      auth.provision();
      const secretPath = path.join(tmpDir, 'telemetry', 'local-secret');
      const secret = fs.readFileSync(secretPath, 'utf-8').trim();
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should set chmod 600 on secret file', () => {
      auth.provision();
      const secretPath = path.join(tmpDir, 'telemetry', 'local-secret');
      const stat = fs.statSync(secretPath);
      // 0o600 = 384 decimal, but only check owner bits (mask out other bits)
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('should set chmod 700 on telemetry directory', () => {
      auth.provision();
      const telemetryDir = path.join(tmpDir, 'telemetry');
      const stat = fs.statSync(telemetryDir);
      expect(stat.mode & 0o777).toBe(0o700);
    });

    it('should not overwrite existing install-id on re-provision', () => {
      const first = auth.provision();
      const second = auth.provision();
      expect(second.installationId).toBe(first.installationId);
      expect(second.created).toBe(false);
    });

    it('should regenerate missing secret while preserving install-id', () => {
      const first = auth.provision();
      // Delete only the secret
      // safe-git-allow: incremental-migration
      fs.unlinkSync(path.join(tmpDir, 'telemetry', 'local-secret'));
      const second = auth.provision();
      expect(second.installationId).toBe(first.installationId);
      expect(second.created).toBe(true);
    });
  });

  describe('getInstallationId()', () => {
    it('should return null before provisioning', () => {
      expect(auth.getInstallationId()).toBeNull();
    });

    it('should return the UUID after provisioning', () => {
      const result = auth.provision();
      expect(auth.getInstallationId()).toBe(result.installationId);
    });

    it('should trim whitespace from stored ID', () => {
      const telemetryDir = path.join(tmpDir, 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      fs.writeFileSync(path.join(telemetryDir, 'install-id'), '  test-uuid  \n');
      expect(auth.getInstallationId()).toBe('test-uuid');
    });
  });

  describe('sign()', () => {
    it('should return null before provisioning', () => {
      const result = auth.sign('test-id', '1234567890', Buffer.from('{}'));
      expect(result).toBeNull();
    });

    it('should produce a 64-char hex HMAC signature', () => {
      auth.provision();
      const installId = auth.getInstallationId()!;
      const sig = auth.sign(installId, '1234567890', Buffer.from('{"test":true}'));
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should use canonical message format: installationId:timestamp:payloadHash', () => {
      auth.provision();
      const installId = auth.getInstallationId()!;
      const timestamp = '1234567890';
      const payloadBytes = Buffer.from('{"test":true}');

      const sig = auth.sign(installId, timestamp, payloadBytes);

      // Manually compute expected signature
      const secret = fs.readFileSync(
        path.join(tmpDir, 'telemetry', 'local-secret'), 'utf-8'
      ).trim();
      const payloadHash = createHash('sha256').update(payloadBytes).digest('hex');
      const message = `${installId}:${timestamp}:${payloadHash}`;
      const expected = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(message)
        .digest('hex');

      expect(sig).toBe(expected);
    });

    it('should produce different signatures for different payloads', () => {
      auth.provision();
      const installId = auth.getInstallationId()!;
      const ts = '1234567890';
      const sig1 = auth.sign(installId, ts, Buffer.from('{"a":1}'));
      const sig2 = auth.sign(installId, ts, Buffer.from('{"a":2}'));
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different timestamps', () => {
      auth.provision();
      const installId = auth.getInstallationId()!;
      const payload = Buffer.from('{"test":true}');
      const sig1 = auth.sign(installId, '1000000000', payload);
      const sig2 = auth.sign(installId, '1000000001', payload);
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different installation IDs', () => {
      auth.provision();
      const payload = Buffer.from('{"test":true}');
      const ts = '1234567890';
      const sig1 = auth.sign('id-aaaa', ts, payload);
      const sig2 = auth.sign('id-bbbb', ts, payload);
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('getKeyFingerprint()', () => {
    it('should return null before provisioning', () => {
      expect(auth.getKeyFingerprint()).toBeNull();
    });

    it('should return a 64-char hex SHA-256 hash', () => {
      auth.provision();
      const fp = auth.getKeyFingerprint();
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should compute SHA-256(installationId:localSecret)', () => {
      auth.provision();
      const installId = auth.getInstallationId()!;
      const secret = fs.readFileSync(
        path.join(tmpDir, 'telemetry', 'local-secret'), 'utf-8'
      ).trim();

      const expected = createHash('sha256')
        .update(`${installId}:${secret}`)
        .digest('hex');

      expect(auth.getKeyFingerprint()).toBe(expected);
    });

    it('should be stable across calls', () => {
      auth.provision();
      const fp1 = auth.getKeyFingerprint();
      const fp2 = auth.getKeyFingerprint();
      expect(fp1).toBe(fp2);
    });
  });

  describe('deprovision()', () => {
    it('should remove both identity files', () => {
      auth.provision();
      expect(auth.isProvisioned()).toBe(true);
      auth.deprovision();
      expect(auth.isProvisioned()).toBe(false);
      expect(auth.getInstallationId()).toBeNull();
    });

    it('should not throw if files do not exist', () => {
      expect(() => auth.deprovision()).not.toThrow();
    });

    it('should clear signing capability', () => {
      auth.provision();
      auth.deprovision();
      expect(auth.sign('id', '123', Buffer.from('{}'))).toBeNull();
      expect(auth.getKeyFingerprint()).toBeNull();
    });
  });

  describe('getInstallationIdPrefix()', () => {
    it('should return null before provisioning', () => {
      expect(auth.getInstallationIdPrefix()).toBeNull();
    });

    it('should return first 8 characters of the install ID', () => {
      auth.provision();
      const fullId = auth.getInstallationId()!;
      expect(auth.getInstallationIdPrefix()).toBe(fullId.slice(0, 8));
    });
  });

  describe('HMAC round-trip verification', () => {
    it('should produce signatures verifiable by the worker canonical format', () => {
      // This test verifies that client-side signing matches what the worker expects.
      // The worker validates: HMAC-SHA256(secret, "installationId:timestamp:SHA256(body)")
      auth.provision();
      const installId = auth.getInstallationId()!;
      const secret = fs.readFileSync(
        path.join(tmpDir, 'telemetry', 'local-secret'), 'utf-8'
      ).trim();

      const payload = JSON.stringify({ v: 1, installationId: installId, test: true });
      const payloadBytes = Buffer.from(payload, 'utf-8');
      const timestamp = Math.floor(Date.now() / 1000).toString();

      // Client-side sign
      const clientSig = auth.sign(installId, timestamp, payloadBytes);

      // Server-side verify (simulating worker logic)
      const payloadHash = createHash('sha256').update(payloadBytes).digest('hex');
      const canonicalMessage = `${installId}:${timestamp}:${payloadHash}`;
      const serverSig = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(canonicalMessage)
        .digest('hex');

      expect(clientSig).toBe(serverSig);
    });
  });
});
