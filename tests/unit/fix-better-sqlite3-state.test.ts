/**
 * Unit tests for the attempt-tracking state in scripts/fix-better-sqlite3.cjs.
 * Protects the loop-breaker guarantee: once a tuple has exhausted both
 * prebuild AND source, the next invocation must short-circuit instead of
 * re-downloading the same broken prebuild on every launchd respawn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Load the .cjs via createRequire so ESM doesn't choke on the non-module format.
const fixModule: {
  tupleKey: (v: string) => string;
  readState: (dir: string) => unknown;
  writeState: (dir: string, state: unknown) => void;
  recordAttempt: (
    dir: string,
    existing: unknown,
    version: string,
    step: string,
    result: string,
  ) => { key: string; attempts: Array<{ step: string; result: string }>; lastResult: string };
  testBinary: (dir: string) => boolean;
  verifyChildAbiMatches: () => boolean;
} = require('../../scripts/fix-better-sqlite3.cjs');

let tmpPkg: string;

beforeEach(() => {
  tmpPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-bs3-'));
});

afterEach(() => {
  try {
    // safe-git-allow: incremental-migration
    if (fs.existsSync(tmpPkg)) fs.rmSync(tmpPkg, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe('fix-better-sqlite3 state machine', () => {
  it('tupleKey includes version, moduleVersion, platform, and arch', () => {
    const key = fixModule.tupleKey('11.3.0');
    // Should not be empty and must contain the version.
    expect(key).toContain('11.3.0');
    expect(key.split('|')).toHaveLength(4);
  });

  it('readState returns null when no state file exists', () => {
    expect(fixModule.readState(tmpPkg)).toBeNull();
  });

  it('readState returns null on corrupt JSON', () => {
    fs.writeFileSync(path.join(tmpPkg, '.instar-fix-state.json'), '{not: valid');
    expect(fixModule.readState(tmpPkg)).toBeNull();
  });

  it('recordAttempt creates a new state with the correct tuple key', () => {
    const state = fixModule.recordAttempt(tmpPkg, null, '11.3.0', 'prebuild', 'prebuild-ok');
    expect(state.key).toBe(fixModule.tupleKey('11.3.0'));
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0].step).toBe('prebuild');
    expect(state.attempts[0].result).toBe('prebuild-ok');
    expect(state.lastResult).toBe('prebuild-ok');
  });

  it('recordAttempt appends to existing state when the tuple key matches', () => {
    const first = fixModule.recordAttempt(tmpPkg, null, '11.3.0', 'prebuild', 'prebuild-failed');
    const second = fixModule.recordAttempt(tmpPkg, first, '11.3.0', 'source', 'source-ok');
    expect(second.attempts).toHaveLength(2);
    expect(second.lastResult).toBe('source-ok');
    // Persisted to disk.
    const onDisk = fixModule.readState(tmpPkg) as typeof second;
    expect(onDisk.attempts).toHaveLength(2);
  });

  it('recordAttempt resets the attempt log when the tuple key changes', () => {
    const first = fixModule.recordAttempt(tmpPkg, null, '11.3.0', 'prebuild', 'prebuild-failed');
    expect(first.attempts).toHaveLength(1);
    // Simulate a different tuple (e.g., bumping better-sqlite3 version) —
    // caller passes `first` as existing, but the key won't match, so recordAttempt
    // must start fresh.
    const second = fixModule.recordAttempt(tmpPkg, first, '11.4.0', 'prebuild', 'prebuild-ok');
    expect(second.key).not.toBe(first.key);
    expect(second.attempts).toHaveLength(1);
    expect(second.lastResult).toBe('prebuild-ok');
  });

  it('state persists across readState/writeState roundtrip with attempt history intact', () => {
    const written = fixModule.recordAttempt(tmpPkg, null, '11.3.0', 'prebuild', 'prebuild-failed');
    const appended = fixModule.recordAttempt(tmpPkg, written, '11.3.0', 'source', 'source-failed');
    const reloaded = fixModule.readState(tmpPkg) as {
      key: string;
      lastResult: string;
      attempts: Array<{ step: string; result: string }>;
    };
    expect(reloaded.key).toBe(appended.key);
    expect(reloaded.lastResult).toBe('source-failed');
    expect(reloaded.attempts.map((a) => `${a.step}:${a.result}`)).toEqual([
      'prebuild:prebuild-failed',
      'source:source-failed',
    ]);
  });

  it('writeState tolerates an unwritable state-file path without throwing', () => {
    // Point at a directory the caller cannot write to; writeState is best-effort.
    const unwritable = '/dev/null/blocked';
    expect(() => fixModule.writeState(unwritable, { key: 'x', attempts: [] })).not.toThrow();
  });
});

/**
 * Regression: testBinary must spawn process.execPath, NOT bare `node` from PATH.
 *
 * If the script is invoked with an asdf / shim / user-PATH `node` that differs
 * from process.execPath (which is how the instar server actually invokes it),
 * using `node` from PATH would test the binary against the wrong Node ABI.
 * That produces a false positive when the binary happens to match PATH's Node
 * but not process.execPath's Node — which is exactly the silent degradation
 * on Inspec 2026-04-21 (ABI-127 binary "passed" testBinary under an asdf
 * Node 22 PATH, but the server's Node 25 then failed to load it).
 *
 * This test reads the script source and asserts testBinary uses execFileSync
 * with process.execPath, not execSync('node ...'). A structural check on the
 * source is the right level: we can't spawn real Nodes of different ABIs in
 * CI, but we CAN guarantee the code never reintroduces the `node`-from-PATH
 * spawn shape.
 */
describe('fix-better-sqlite3 testBinary Node resolution', () => {
  const scriptPath = require.resolve('../../scripts/fix-better-sqlite3.cjs');
  const src = fs.readFileSync(scriptPath, 'utf8');

  it('testBinary must invoke process.execPath, not bare `node`', () => {
    // Extract the testBinary function body (between `function testBinary` and
    // the matching closing brace at column 0 "^}"). A conservative regex is
    // fine here — we just need to isolate the function body to grep inside.
    const fnStart = src.indexOf('function testBinary(');
    expect(fnStart).toBeGreaterThan(-1);
    // Find the end of the function — first `\n}` after the opening brace at col 0.
    const fnEnd = src.indexOf('\n}', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = src.slice(fnStart, fnEnd);

    // MUST reference process.execPath as the spawn target.
    expect(body).toMatch(/process\.execPath/);

    // MUST NOT invoke `node -e` via a shell — that reads PATH and picks up
    // whatever Node is there, which can differ from process.execPath.
    expect(body).not.toMatch(/`node\s+-e/);
    expect(body).not.toMatch(/"node\s+-e/);
    expect(body).not.toMatch(/'node\s+-e/);
  });

  it('trySourceBuild must prepend execDir to PATH so bare `node` in child resolves correctly', () => {
    const fnStart = src.indexOf('function trySourceBuild(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\n}', fnStart);
    const body = src.slice(fnStart, fnEnd);

    // Must compute the exec dir AND prepend it to the child's PATH.
    expect(body).toMatch(/path\.dirname\(process\.execPath\)/);
    expect(body).toMatch(/PATH:/);
  });

  it('trySourceBuild must invoke the npm CLI via process.execPath, not a shell', () => {
    const fnStart = src.indexOf('function trySourceBuild(');
    const fnEnd = src.indexOf('\n}', fnStart);
    const body = src.slice(fnStart, fnEnd);

    // execFileSync(process.execPath, [npmCli, ...]) — not a shelled execSync
    // with a quoted command string (which can re-expand PATH unexpectedly).
    expect(body).toMatch(/execFileSync\(\s*process\.execPath/);
    // The one legitimate remaining execSync inside trySourceBuild would be
    // a smell — fail the test if we see it there.
    expect(body).not.toMatch(/execSync\(/);
  });

  // Positive canary: if testBinary is ever renamed/deleted, the source-regex
  // tests above would silently pass against an empty body. These export-level
  // checks fail noisily when the surface drifts.
  it('testBinary is exported and callable', () => {
    expect(typeof fixModule.testBinary).toBe('function');
  });

  it('verifyChildAbiMatches is exported and returns true when script runs under its own execPath', () => {
    // Under the test runner, process.execPath IS the Node running this test —
    // so the child's MODULE_VERSION matches by construction. This test would
    // fail if the function were accidentally deleted, renamed, or rewritten
    // to always return false.
    expect(typeof fixModule.verifyChildAbiMatches).toBe('function');
    expect(fixModule.verifyChildAbiMatches()).toBe(true);
  });

  it('testBinary -e payload is a static string literal (no interpolation)', () => {
    // Structural guard against a future refactor interpolating user-controlled
    // data into the -e payload. That would turn this spawn into arbitrary-code
    // execution inside the server's Node. Today the payload is literal;
    // keep it that way.
    const fnStart = src.indexOf('function testBinary(');
    const fnEnd = src.indexOf('\n}', fnStart);
    const body = src.slice(fnStart, fnEnd);
    // No template backticks inside the -e argument.
    expect(body).not.toMatch(/'-e',\s*`/);
    // No string concatenation (`+`) inside the -e argument.
    expect(body).not.toMatch(/'-e',\s*[^,]*\+/);
  });
});
