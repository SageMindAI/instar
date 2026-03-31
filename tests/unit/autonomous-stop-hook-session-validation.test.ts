/**
 * Autonomous stop hook session ID validation — regression test.
 *
 * Root cause: The autonomous skill instructs Claude to write the state file
 * with $CLAUDE_CODE_SESSION_ID, but Claude sometimes writes a custom string
 * (e.g. "autonomous-prod-audit-20260330") instead of the real UUID. The stop
 * hook compares this against the real session_id from hook input — mismatch
 * means the hook fails open and allows premature exit. Autonomous mode
 * enforcement is completely broken.
 *
 * Fix: The stop hook now validates that session_id in the state file is a
 * valid UUID. Non-UUID values are cleared, triggering the self-bootstrap
 * path which captures the real UUID from the first hook call.
 *
 * These tests verify the UUID validation is in place and correct.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HOOK_PATH = path.join(
  process.cwd(),
  '.claude',
  'skills',
  'autonomous',
  'hooks',
  'autonomous-stop-hook.sh',
);
const HOOK_SRC = fs.readFileSync(HOOK_PATH, 'utf-8');

// The UUID regex from the hook script — must match lowercase hex UUID v4 format
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Stop hook session_id UUID validation (source analysis)', () => {
  it('contains UUID validation regex', () => {
    expect(HOOK_SRC).toContain('UUID_REGEX');
    expect(HOOK_SRC).toMatch(/\[0-9a-f\]\{8\}/);
  });

  it('clears non-UUID session_id values', () => {
    // When session_id doesn't match UUID, it should be set to empty
    expect(HOOK_SRC).toContain('STATE_SESSION=""');
    expect(HOOK_SRC).toMatch(/! \[\[.*STATE_SESSION.*=~.*UUID_REGEX/);
  });

  it('logs a warning for invalid session_id', () => {
    expect(HOOK_SRC).toMatch(/Invalid session_id.*not UUID/);
  });

  it('preserves the self-bootstrap path for empty session_id', () => {
    // After clearing an invalid session_id, the self-bootstrap block should fire
    expect(HOOK_SRC).toContain('if [[ -z "$STATE_SESSION" ]]; then');
    expect(HOOK_SRC).toContain('claimed autonomous mode');
  });

  it('UUID validation runs BEFORE hook session_id parsing', () => {
    // The validation must run before HOOK_SESSION is parsed,
    // so that an invalid STATE_SESSION is cleared before comparison
    const validationIdx = HOOK_SRC.indexOf('UUID_REGEX=');
    const hookSessionIdx = HOOK_SRC.indexOf('HOOK_SESSION=');
    expect(validationIdx).toBeGreaterThan(-1);
    expect(hookSessionIdx).toBeGreaterThan(-1);
    expect(validationIdx).toBeLessThan(hookSessionIdx);
  });
});

describe('UUID regex correctness', () => {
  // Port the same regex to TypeScript to validate its behavior

  it('matches valid lowercase UUIDs', () => {
    const validUUIDs = [
      '550e8400-e29b-41d4-a716-446655440000',
      '04db2de7-8e82-4baf-9136-7a067bb2ec53',
      'a13495fb-bbb5-4a90-8c72-aa1e0e9e395e',
      '00000000-0000-0000-0000-000000000000',
    ];
    for (const uuid of validUUIDs) {
      expect(UUID_REGEX.test(uuid), `Expected "${uuid}" to match`).toBe(true);
    }
  });

  it('rejects custom strings Claude might write', () => {
    const invalidValues = [
      'autonomous-prod-audit-20260330',
      'my-autonomous-session',
      'AUTONOMOUS_SESSION_123',
      'session-1',
      'test',
      'undefined',
      'null',
    ];
    for (const val of invalidValues) {
      expect(UUID_REGEX.test(val), `Expected "${val}" to NOT match`).toBe(false);
    }
  });

  it('rejects empty string', () => {
    expect(UUID_REGEX.test('')).toBe(false);
  });

  it('rejects UUIDs with uppercase hex', () => {
    // Claude Code session IDs use lowercase
    expect(UUID_REGEX.test('550E8400-E29B-41D4-A716-446655440000')).toBe(false);
  });

  it('rejects UUIDs without dashes', () => {
    expect(UUID_REGEX.test('550e8400e29b41d4a716446655440000')).toBe(false);
  });

  it('rejects UUIDs with wrong segment lengths', () => {
    expect(UUID_REGEX.test('550e840-e29b-41d4-a716-446655440000')).toBe(false);
    expect(UUID_REGEX.test('550e8400-e29-41d4-a716-446655440000')).toBe(false);
  });
});
