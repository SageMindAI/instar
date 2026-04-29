/**
 * Unit tests for findBetterSqlite3Copies.
 *
 * Background: 2026-04-29 Inspec post-mortem found that the supervisor's
 * preflight self-heal only checked the hoisted path
 * `shadow-install/node_modules/better-sqlite3/...`, but the actually-loaded
 * binary on Inspec was at the nested path
 * `shadow-install/node_modules/instar/node_modules/better-sqlite3/...`.
 *
 * These tests verify the scanner finds both shapes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findBetterSqlite3Copies } from '../../src/lifeline/ServerSupervisor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-scan-test-'));
  tmpDirs.push(dir);
  return dir;
}

function writeFakeBinary(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'fake-binary');
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/find-better-sqlite3-copies.test.ts:cleanup' }); } catch { /* ignore */ }
  }
});

describe('findBetterSqlite3Copies', () => {
  it('returns empty when node_modules root does not exist', () => {
    expect(findBetterSqlite3Copies('/nonexistent/path/never/exists')).toEqual([]);
  });

  it('returns empty when no better-sqlite3 anywhere in tree', () => {
    const root = makeTmp();
    fs.mkdirSync(path.join(root, 'lodash', 'lib'), { recursive: true });
    expect(findBetterSqlite3Copies(root)).toEqual([]);
  });

  it('finds top-level hoisted copy', () => {
    const root = makeTmp();
    const binaryPath = path.join(root, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    writeFakeBinary(binaryPath);

    const copies = findBetterSqlite3Copies(root);
    expect(copies).toHaveLength(1);
    expect(copies[0].binaryPath).toBe(binaryPath);
    expect(copies[0].packageDir).toBe(path.join(root, 'better-sqlite3'));
    // Prefix for a top-level copy is the parent of the parent of the package dir.
    // root/better-sqlite3 → parent is root → parent of that is root's parent.
    expect(copies[0].prefixDir).toBe(path.dirname(root));
  });

  it('finds nested copy under instar/node_modules/ (the Inspec case)', () => {
    const root = makeTmp();
    const nestedBinary = path.join(
      root, 'instar', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node',
    );
    writeFakeBinary(nestedBinary);

    const copies = findBetterSqlite3Copies(root);
    expect(copies).toHaveLength(1);
    expect(copies[0].binaryPath).toBe(nestedBinary);
    // Prefix for a nested copy = the parent package dir (the one whose deps include better-sqlite3).
    expect(copies[0].prefixDir).toBe(path.join(root, 'instar'));
  });

  it('finds both hoisted and nested copies in same tree', () => {
    const root = makeTmp();
    const hoisted = path.join(root, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    const nested = path.join(root, 'instar', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    writeFakeBinary(hoisted);
    writeFakeBinary(nested);

    const copies = findBetterSqlite3Copies(root);
    expect(copies).toHaveLength(2);
    const paths = copies.map(c => c.binaryPath).sort();
    expect(paths).toEqual([hoisted, nested].sort());
  });

  it('skips a better-sqlite3 dir without a compiled binary (fresh install pre-build)', () => {
    const root = makeTmp();
    fs.mkdirSync(path.join(root, 'better-sqlite3', 'lib'), { recursive: true });
    expect(findBetterSqlite3Copies(root)).toEqual([]);
  });

  it('does not descend into better-sqlite3/node_modules/ to find recursive copies', () => {
    const root = makeTmp();
    const outer = path.join(root, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    // A deps-of-better-sqlite3 directory that happens to be named the same.
    // We must not descend into the better-sqlite3 package's own node_modules.
    const inner = path.join(root, 'better-sqlite3', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    writeFakeBinary(outer);
    writeFakeBinary(inner);

    const copies = findBetterSqlite3Copies(root);
    expect(copies).toHaveLength(1);
    expect(copies[0].binaryPath).toBe(outer);
  });

  it('respects the MAX_COPIES cap on pathological trees', () => {
    const root = makeTmp();
    // Plant 10 copies; expect cap of 5.
    for (let i = 0; i < 10; i++) {
      const p = path.join(root, `pkg${i}`, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
      writeFakeBinary(p);
    }
    const copies = findBetterSqlite3Copies(root);
    expect(copies.length).toBeLessThanOrEqual(5);
    expect(copies.length).toBeGreaterThan(0);
  });
});
