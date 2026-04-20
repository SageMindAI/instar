import { describe, it, expect } from 'vitest';
import {
  parseVersion,
  compareVersions,
  VERSION_MAX_LEN,
  PATCH_INFO_THRESHOLD,
} from '../../../src/lifeline/versionHandshake.js';

describe('parseVersion', () => {
  it('parses a plain semver', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: undefined });
  });

  it('parses semver with prerelease', () => {
    expect(parseVersion('0.28.66-rc.1')).toEqual({ major: 0, minor: 28, patch: 66, prerelease: 'rc.1' });
  });

  it('rejects non-strings', () => {
    expect(parseVersion(123 as unknown)).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });

  it('rejects strings longer than MAX_LEN', () => {
    const long = '1.2.3-' + 'a'.repeat(VERSION_MAX_LEN);
    expect(long.length > VERSION_MAX_LEN).toBe(true);
    expect(parseVersion(long)).toBeNull();
  });

  it('rejects malformed strings', () => {
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('1.2.3.4')).toBeNull();
    expect(parseVersion('v1.2.3')).toBeNull();
    expect(parseVersion('1.2.3 ')).toBeNull();
    expect(parseVersion('1.2.3; drop table')).toBeNull();
    expect(parseVersion('../../etc/passwd')).toBeNull();
  });

  it('rejects absurd component counts', () => {
    expect(parseVersion('99999.0.0')).toBeNull(); // 5 digits exceeds {1,4}
  });
});

describe('compareVersions', () => {
  const v = (s: string) => parseVersion(s)!;

  it('accepts matching versions', () => {
    expect(compareVersions(v('1.2.3'), v('1.2.3'))).toEqual({ kind: 'accept' });
  });

  it('accepts same-major-minor with small patch diff', () => {
    expect(compareVersions(v('1.2.9'), v('1.2.3'))).toEqual({ kind: 'accept' });
  });

  it('fires patch-info signal at PATCH drift > 10', () => {
    const r = compareVersions(v('1.2.30'), v('1.2.3'));
    expect(r.kind).toBe('accept-with-patch-info');
    if (r.kind === 'accept-with-patch-info') {
      expect(r.patchDiff).toBe(27);
    }
  });

  it('boundary: PATCH drift == 10 stays silent', () => {
    expect(compareVersions(v('1.2.13'), v('1.2.3'))).toEqual({ kind: 'accept' });
  });

  it('boundary: PATCH drift == 11 fires', () => {
    const r = compareVersions(v('1.2.14'), v('1.2.3'));
    expect(r.kind).toBe('accept-with-patch-info');
  });

  it('refuses MAJOR mismatch with 426 body reconstruction', () => {
    const r = compareVersions(v('2.0.0'), v('1.0.0'));
    expect(r.kind).toBe('upgrade-required');
    if (r.kind === 'upgrade-required') {
      expect(r.serverVersionString).toBe('2.0.0');
    }
  });

  it('refuses MINOR mismatch', () => {
    const r = compareVersions(v('1.3.0'), v('1.2.99'));
    expect(r.kind).toBe('upgrade-required');
  });

  it('server-version-string is reconstructed from parsed numbers, not raw input', () => {
    // This is the security guarantee: even if client-supplied input
    // looked weird, the body echoes only a reconstructed canonical form.
    const r = compareVersions(v('1.0.0'), v('0.99.99'));
    if (r.kind === 'upgrade-required') {
      expect(r.serverVersionString).toBe('1.0.0');
      expect(r.serverVersionString).not.toMatch(/[^0-9.]/);
    }
  });
});

describe('PATCH_INFO_THRESHOLD constant', () => {
  it('is 10 per spec', () => {
    expect(PATCH_INFO_THRESHOLD).toBe(10);
  });
});
