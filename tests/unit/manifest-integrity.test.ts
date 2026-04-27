import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ManifestIntegrity } from '../../src/security/ManifestIntegrity.js';

describe('ManifestIntegrity', () => {
  let tmpDir: string;
  let integrity: ManifestIntegrity;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-integrity-'));
    integrity = new ManifestIntegrity(tmpDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates a key on first call', () => {
    expect(integrity.hasKey()).toBe(false);
    const created = integrity.ensureKey();
    expect(created).toBe(true);
    expect(integrity.hasKey()).toBe(true);
  });

  it('does not overwrite existing key', () => {
    integrity.ensureKey();
    const keyPath = path.join(tmpDir, '.manifest-key');
    const firstKey = fs.readFileSync(keyPath, 'utf-8');

    const created = integrity.ensureKey();
    expect(created).toBe(false);
    const secondKey = fs.readFileSync(keyPath, 'utf-8');
    expect(secondKey).toBe(firstKey);
  });

  it('signs and verifies a manifest', () => {
    integrity.ensureKey();

    const manifest = {
      schemaVersion: 1,
      version: '0.10.9',
      generatedAt: new Date().toISOString(),
      entries: { 'hook:session-start': { id: 'hook:session-start', type: 'hook' } },
    };

    const signed = integrity.sign(manifest);
    expect(signed._hmac).toBeDefined();
    expect(typeof signed._hmac).toBe('string');
    expect(signed._hmac.length).toBe(64); // SHA-256 hex

    expect(integrity.verify(signed)).toBe(true);
  });

  it('rejects tampered manifest', () => {
    integrity.ensureKey();

    const manifest = {
      schemaVersion: 1,
      version: '0.10.9',
      generatedAt: new Date().toISOString(),
      entries: { 'hook:session-start': { id: 'hook:session-start', type: 'hook' } },
    };

    const signed = integrity.sign(manifest);

    // Tamper with the entries
    (signed.entries as any)['malicious:entry'] = { id: 'malicious:entry', type: 'hack' };

    expect(integrity.verify(signed)).toBe(false);
  });

  it('rejects manifest with missing HMAC', () => {
    integrity.ensureKey();
    const manifest = { schemaVersion: 1, entries: {} };
    expect(integrity.verify(manifest)).toBe(false);
  });

  it('writes and reads a signed manifest file', () => {
    integrity.ensureKey();

    const manifestPath = path.join(tmpDir, 'capability-manifest.json');
    const manifest = {
      schemaVersion: 1,
      version: '0.10.9',
      generatedAt: new Date().toISOString(),
      entries: { 'hook:session-start': { id: 'hook:session-start' } },
    };

    integrity.writeAndSign(manifestPath, manifest);

    expect(fs.existsSync(manifestPath)).toBe(true);

    const result = integrity.readAndVerify(manifestPath);
    expect(result.verified).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.schemaVersion).toBe(1);
  });

  it('detects tampered file on disk', () => {
    integrity.ensureKey();

    const manifestPath = path.join(tmpDir, 'capability-manifest.json');
    const manifest = {
      schemaVersion: 1,
      version: '0.10.9',
      generatedAt: new Date().toISOString(),
      entries: {},
    };

    integrity.writeAndSign(manifestPath, manifest);

    // Tamper with the file
    const content = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    content.entries['injected'] = { id: 'injected', type: 'attack' };
    fs.writeFileSync(manifestPath, JSON.stringify(content, null, 2));

    const result = integrity.readAndVerify(manifestPath);
    expect(result.verified).toBe(false);
  });

  it('handles missing manifest file gracefully', () => {
    integrity.ensureKey();
    const result = integrity.readAndVerify(path.join(tmpDir, 'nonexistent.json'));
    expect(result.manifest).toBeNull();
    expect(result.verified).toBe(false);
    expect(result.error).toContain('File not found');
  });

  it('rotates key and re-signs manifest', () => {
    integrity.ensureKey();

    const manifestPath = path.join(tmpDir, 'capability-manifest.json');
    const manifest = {
      schemaVersion: 1,
      version: '0.10.9',
      generatedAt: new Date().toISOString(),
      entries: { 'hook:test': { id: 'hook:test' } },
    };

    integrity.writeAndSign(manifestPath, manifest);

    // Read the old HMAC
    const oldContent = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const oldHmac = oldContent._hmac;

    // Rotate
    const backupPath = integrity.rotateKey(manifestPath);
    expect(backupPath).toBeDefined();
    expect(fs.existsSync(backupPath!)).toBe(true);

    // New HMAC should be different
    const newContent = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(newContent._hmac).not.toBe(oldHmac);

    // Should still verify with new key
    const result = integrity.readAndVerify(manifestPath);
    expect(result.verified).toBe(true);
  });

  it('key file has restricted permissions', () => {
    integrity.ensureKey();
    const keyPath = path.join(tmpDir, '.manifest-key');
    const stats = fs.statSync(keyPath);
    // Owner read/write only (0o600)
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
