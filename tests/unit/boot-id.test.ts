/**
 * Unit tests for boot-id.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3b.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOrCreateBootId, getCurrentBootId, _resetCacheForTest, bootIdPath } from '../../src/server/boot-id.js';

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'boot-id-'));
}

beforeEach(() => {
  _resetCacheForTest();
});

describe('getOrCreateBootId', () => {
  it('creates a 32-hex-char id (16 bytes) on first call', () => {
    const dir = tmpStateDir();
    const id = getOrCreateBootId(dir, '0.28.0');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const stored = fs.readFileSync(bootIdPath(dir), 'utf-8');
    expect(JSON.parse(stored).bootId).toBe(id);
  });

  it('persists across calls within the same minor version', () => {
    const dir = tmpStateDir();
    const id1 = getOrCreateBootId(dir, '0.28.0');
    _resetCacheForTest();
    const id2 = getOrCreateBootId(dir, '0.28.5');
    expect(id1).toBe(id2);
  });

  it('rotates on minor-version bump', () => {
    const dir = tmpStateDir();
    const id1 = getOrCreateBootId(dir, '0.28.0');
    _resetCacheForTest();
    const id2 = getOrCreateBootId(dir, '0.29.0');
    expect(id1).not.toBe(id2);
  });

  it('regenerates on corrupt envelope', () => {
    const dir = tmpStateDir();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(bootIdPath(dir), 'not-json');
    const id = getOrCreateBootId(dir, '0.28.0');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('writes mode 0600', () => {
    const dir = tmpStateDir();
    getOrCreateBootId(dir, '0.28.0');
    const stat = fs.statSync(bootIdPath(dir));
    // POSIX-only check; skip on platforms that don't honor mode bits.
    if (process.platform !== 'win32') {
      expect((stat.mode & 0o777).toString(8)).toBe('600');
    }
  });

  it('uses crypto.randomBytes — different ids on different state dirs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      _resetCacheForTest();
      ids.add(getOrCreateBootId(tmpStateDir(), '0.28.0'));
    }
    expect(ids.size).toBe(5);
  });

  it('getCurrentBootId returns null before initialization', () => {
    expect(getCurrentBootId()).toBeNull();
  });

  it('getCurrentBootId returns the cached id after initialization', () => {
    const dir = tmpStateDir();
    const id = getOrCreateBootId(dir, '0.28.0');
    expect(getCurrentBootId()).toBe(id);
  });
});
