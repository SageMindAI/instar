/**
 * Unit tests for UserOnboarding module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateVerificationCode,
  generateConnectCode,
  hashCode,
  generateRecoveryKey,
  hashRecoveryKey,
  buildConsentDisclosure,
  buildCondensedConsentDisclosure,
  createConsentRecord,
  createDataManifest,
  VerificationManager,
  JoinRequestManager,
  buildUserProfile,
  getDefaultAutonomyConfig,
} from '../../src/users/UserOnboarding.js';

// ── generateVerificationCode ────────────────────────────────────────

describe('generateVerificationCode', () => {
  it('returns a string of the correct default digit count (6)', () => {
    const code = generateVerificationCode();
    expect(code).toHaveLength(6);
  });

  it('returns a string of the specified digit count', () => {
    const code4 = generateVerificationCode(4);
    expect(code4).toHaveLength(4);

    const code8 = generateVerificationCode(8);
    expect(code8).toHaveLength(8);
  });

  it('returns only numeric characters', () => {
    for (let i = 0; i < 20; i++) {
      const code = generateVerificationCode();
      expect(code).toMatch(/^\d+$/);
    }
  });

  it('does not have leading zeros (minimum value is 10^(digits-1))', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateVerificationCode(6);
      expect(Number(code)).toBeGreaterThanOrEqual(100000);
      expect(Number(code)).toBeLessThan(1000000);
    }
  });
});

// ── generateConnectCode ─────────────────────────────────────────────

describe('generateConnectCode', () => {
  const UNAMBIGUOUS_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

  it('returns the correct default length (8)', () => {
    const code = generateConnectCode();
    expect(code).toHaveLength(8);
  });

  it('returns the specified length', () => {
    expect(generateConnectCode(12)).toHaveLength(12);
    expect(generateConnectCode(4)).toHaveLength(4);
  });

  it('uses only unambiguous characters (no 0, O, 1, l, I)', () => {
    for (let i = 0; i < 30; i++) {
      const code = generateConnectCode(16);
      for (const ch of code) {
        expect(UNAMBIGUOUS_CHARS).toContain(ch);
      }
      // Specifically assert ambiguous chars are absent
      expect(code).not.toMatch(/[0O1lI]/);
    }
  });
});

// ── hashCode ────────────────────────────────────────────────────────

describe('hashCode', () => {
  it('is deterministic (same input produces same hash)', () => {
    const a = hashCode('123456');
    const b = hashCode('123456');
    expect(a).toBe(b);
  });

  it('different inputs produce different hashes', () => {
    const a = hashCode('123456');
    const b = hashCode('654321');
    expect(a).not.toBe(b);
  });

  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = hashCode('test');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── generateRecoveryKey ─────────────────────────────────────────────

describe('generateRecoveryKey', () => {
  it('returns a 64-character hex string (32 bytes)', () => {
    const key = generateRecoveryKey();
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique keys each time', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 20; i++) {
      keys.add(generateRecoveryKey());
    }
    expect(keys.size).toBe(20);
  });
});

// ── hashRecoveryKey ─────────────────────────────────────────────────

describe('hashRecoveryKey', () => {
  it('is deterministic', () => {
    const key = 'abc123';
    expect(hashRecoveryKey(key)).toBe(hashRecoveryKey(key));
  });

  it('different keys produce different hashes', () => {
    expect(hashRecoveryKey('keyA')).not.toBe(hashRecoveryKey('keyB'));
  });

  it('returns a 64-character hex string', () => {
    const hash = hashRecoveryKey('test-key');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── buildConsentDisclosure ──────────────────────────────────────────

describe('buildConsentDisclosure', () => {
  it('includes the agent name', () => {
    const text = buildConsentDisclosure('TestBot');
    expect(text).toContain('TestBot');
  });

  it('includes data categories', () => {
    const text = buildConsentDisclosure('MyAgent');
    expect(text).toContain('name');
    expect(text).toContain('communication preferences');
    expect(text).toContain('Telegram user ID');
    expect(text).toContain('Conversation history');
    expect(text).toContain('Memory entries');
  });

  it('mentions deletion rights', () => {
    const text = buildConsentDisclosure('Bot');
    expect(text).toContain('deletion');
  });
});

// ── buildCondensedConsentDisclosure ─────────────────────────────────

describe('buildCondensedConsentDisclosure', () => {
  it('includes the agent name', () => {
    const text = buildCondensedConsentDisclosure('TestBot');
    expect(text).toContain('TestBot');
  });

  it('is shorter than the full disclosure', () => {
    const full = buildConsentDisclosure('Agent');
    const condensed = buildCondensedConsentDisclosure('Agent');
    expect(condensed.length).toBeLessThan(full.length);
  });

  it('mentions deletion right', () => {
    const text = buildCondensedConsentDisclosure('Bot');
    expect(text).toContain('deletion');
  });
});

// ── createConsentRecord ─────────────────────────────────────────────

describe('createConsentRecord', () => {
  it('sets consentGiven to true', () => {
    const record = createConsentRecord();
    expect(record.consentGiven).toBe(true);
  });

  it('has an ISO date string for consentDate', () => {
    const record = createConsentRecord();
    const parsed = new Date(record.consentDate);
    expect(parsed.toISOString()).toBe(record.consentDate);
  });

  it('includes the version when provided', () => {
    const record = createConsentRecord('v2.0');
    expect(record.consentNoticeVersion).toBe('v2.0');
  });

  it('has undefined version when not provided', () => {
    const record = createConsentRecord();
    expect(record.consentNoticeVersion).toBeUndefined();
  });
});

// ── createDataManifest ──────────────────────────────────────────────

describe('createDataManifest', () => {
  it('has correct defaults', () => {
    const manifest = createDataManifest();
    expect(manifest.name).toBe(true);
    expect(manifest.telegramId).toBe(false);
    expect(manifest.communicationPreferences).toBe(true);
    expect(manifest.conversationHistory).toBe(false);
    expect(manifest.memoryEntries).toBe(false);
    expect(manifest.machineIdentities).toBe(false);
  });

  it('overrides work correctly', () => {
    const manifest = createDataManifest({ telegramId: true, memoryEntries: true });
    expect(manifest.telegramId).toBe(true);
    expect(manifest.memoryEntries).toBe(true);
    // Defaults preserved
    expect(manifest.name).toBe(true);
    expect(manifest.conversationHistory).toBe(false);
  });

  it('can override defaults to false', () => {
    const manifest = createDataManifest({ name: false, communicationPreferences: false });
    expect(manifest.name).toBe(false);
    expect(manifest.communicationPreferences).toBe(false);
  });
});

// ── VerificationManager ─────────────────────────────────────────────

describe('VerificationManager', () => {
  let vm: VerificationManager;

  beforeEach(() => {
    vm = new VerificationManager();
  });

  it('createCode returns a code string and expiresAt date', () => {
    const { code, expiresAt } = vm.createCode('user-1', 'telegram-push');
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(0);
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('createCode for telegram-push returns a numeric code', () => {
    const { code } = vm.createCode('user-1', 'telegram-push');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('createCode for pairing-code returns an alphanumeric code', () => {
    const { code } = vm.createCode('machine-1', 'pairing-code');
    expect(code).toHaveLength(8);
    expect(code).not.toMatch(/^[0-9]+$/); // Not purely numeric (statistically)
  });

  it('verifyCode accepts the correct code', () => {
    const { code } = vm.createCode('user-1', 'telegram-push');
    const result = vm.verifyCode('user-1', code);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('verifyCode rejects an incorrect code', () => {
    vm.createCode('user-1', 'telegram-push');
    const result = vm.verifyCode('user-1', '000000');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('verifyCode decrements remaining attempts on wrong code', () => {
    vm.createCode('user-1', 'telegram-push');
    const r1 = vm.verifyCode('user-1', '000000');
    expect(r1.error).toContain('4 attempts remaining');

    const r2 = vm.verifyCode('user-1', '000000');
    expect(r2.error).toContain('3 attempts remaining');
  });

  it('code expires after expiryMinutes', () => {
    vi.useFakeTimers();
    try {
      const { code } = vm.createCode('user-1', 'telegram-push');

      // Advance past expiry (10 minutes default + 1ms)
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);

      const result = vm.verifyCode('user-1', code);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('locks out after maxAttempts exceeded', () => {
    vm.createCode('user-1', 'telegram-push');

    // Exhaust all 5 attempts + 1 to trigger lockout
    for (let i = 0; i < 5; i++) {
      vm.verifyCode('user-1', '000000');
    }
    // The 6th attempt (attempts > maxAttempts) triggers lockout
    const lockoutResult = vm.verifyCode('user-1', '000000');
    // After lockout, code is deleted so we get "No verification code found"
    expect(lockoutResult.valid).toBe(false);

    // Trying to create a new code should throw during lockout
    expect(() => vm.createCode('user-1', 'telegram-push')).toThrow('Too many failed attempts');
  });

  it('code is single-use (cannot verify same code twice)', () => {
    const { code } = vm.createCode('user-1', 'telegram-push');

    const first = vm.verifyCode('user-1', code);
    expect(first.valid).toBe(true);

    // Second attempt — code should be deleted after successful verification
    const second = vm.verifyCode('user-1', code);
    expect(second.valid).toBe(false);
    expect(second.error).toContain('No verification code found');
  });

  it('returns error for unknown targetId', () => {
    const result = vm.verifyCode('nonexistent', '123456');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('No verification code found');
  });
});

// ── JoinRequestManager ──────────────────────────────────────────────

describe('JoinRequestManager', () => {
  let tmpDir: string;
  let jrm: JoinRequestManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-join-req-test-'));
    jrm = new JoinRequestManager(tmpDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createRequest persists to file', () => {
    jrm.createRequest('Alice', 12345, 'Seems friendly');

    const filePath = path.join(tmpDir, 'join-requests.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('Alice');
    expect(data[0].telegramUserId).toBe(12345);
    expect(data[0].status).toBe('pending');
  });

  it('createRequest returns a well-formed JoinRequest', () => {
    const req = jrm.createRequest('Bob', 67890, null);
    expect(req.requestId).toBeDefined();
    expect(req.name).toBe('Bob');
    expect(req.telegramUserId).toBe(67890);
    expect(req.agentAssessment).toBeNull();
    expect(req.approvalCode).toBeDefined();
    expect(req.status).toBe('pending');
    expect(req.requestedAt).toBeDefined();
  });

  it('resolveRequest with correct approval code works', () => {
    const req = jrm.createRequest('Carol', 11111, 'Trusted');
    const resolved = jrm.resolveRequest(req.approvalCode, 'approved', 'admin');

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe('approved');
    expect(resolved!.resolvedBy).toBe('admin');
    expect(resolved!.resolvedAt).toBeDefined();
  });

  it('resolveRequest with wrong code returns null', () => {
    jrm.createRequest('Dave', 22222, null);
    const result = jrm.resolveRequest('wrongcode', 'approved', 'admin');
    expect(result).toBeNull();
  });

  it('resolveRequest does not resolve already-resolved requests', () => {
    const req = jrm.createRequest('Eve', 33333, null);
    jrm.resolveRequest(req.approvalCode, 'denied', 'admin');

    // Try to approve the same request again
    const result = jrm.resolveRequest(req.approvalCode, 'approved', 'admin');
    expect(result).toBeNull();
  });

  it('getPendingRequests filters correctly', () => {
    const req1 = jrm.createRequest('Alice', 11111, null);
    jrm.createRequest('Bob', 22222, null);
    jrm.resolveRequest(req1.approvalCode, 'approved', 'admin');

    const pending = jrm.getPendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe('Bob');
  });

  it('getRequestByTelegramUser works', () => {
    jrm.createRequest('Frank', 44444, 'Some assessment');
    jrm.createRequest('Grace', 55555, null);

    const result = jrm.getRequestByTelegramUser(44444);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Frank');
  });

  it('getRequestByTelegramUser returns null for unknown user', () => {
    const result = jrm.getRequestByTelegramUser(99999);
    expect(result).toBeNull();
  });

  it('getRequestByTelegramUser ignores resolved requests', () => {
    const req = jrm.createRequest('Henry', 66666, null);
    jrm.resolveRequest(req.approvalCode, 'denied', 'admin');

    const result = jrm.getRequestByTelegramUser(66666);
    expect(result).toBeNull();
  });

  it('persists and loads across instances', () => {
    jrm.createRequest('Ivy', 77777, null);

    // Create a new manager from the same directory
    const jrm2 = new JoinRequestManager(tmpDir);
    const pending = jrm2.getPendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe('Ivy');
  });
});

// ── buildUserProfile ────────────────────────────────────────────────

describe('buildUserProfile', () => {
  it('generates a URL-safe ID from the name', () => {
    const profile = buildUserProfile({ name: 'John Doe' });
    expect(profile.id).toBe('john-doe');
  });

  it('uses the provided userId if given', () => {
    const profile = buildUserProfile({ name: 'John', userId: 'custom-id' });
    expect(profile.id).toBe('custom-id');
  });

  it('sets default permissions to ["user"]', () => {
    const profile = buildUserProfile({ name: 'Test' });
    expect(profile.permissions).toEqual(['user']);
  });

  it('sets default autonomyLevel to confirm-destructive', () => {
    const profile = buildUserProfile({ name: 'Test' });
    expect(profile.preferences.autonomyLevel).toBe('confirm-destructive');
  });

  it('includes consent when provided', () => {
    const consent = createConsentRecord('v1');
    const profile = buildUserProfile({ name: 'Test', consent });
    expect(profile.consent).toBeDefined();
    expect(profile.consent!.consentGiven).toBe(true);
  });

  it('creates telegram channel when telegramTopicId is provided', () => {
    const profile = buildUserProfile({ name: 'Test', telegramTopicId: 'topic_99' });
    expect(profile.channels).toContainEqual({ type: 'telegram', identifier: 'topic_99' });
  });

  it('creates email channel when email is provided', () => {
    const profile = buildUserProfile({ name: 'Test', email: 'test@example.com' });
    expect(profile.channels).toContainEqual({ type: 'email', identifier: 'test@example.com' });
  });

  it('sets pendingTelegramTopic to false', () => {
    const profile = buildUserProfile({ name: 'Test' });
    expect(profile.pendingTelegramTopic).toBe(false);
  });

  it('has a valid ISO createdAt timestamp', () => {
    const profile = buildUserProfile({ name: 'Test' });
    const parsed = new Date(profile.createdAt!);
    expect(parsed.toISOString()).toBe(profile.createdAt);
  });

  it('sets telegramUserId when provided', () => {
    const profile = buildUserProfile({ name: 'Test', telegramUserId: 12345 });
    expect(profile.telegramUserId).toBe(12345);
  });

  it('sets dataCollected.telegramId when telegramTopicId is given', () => {
    const profile = buildUserProfile({ name: 'Test', telegramTopicId: 'topic_1' });
    expect(profile.dataCollected!.telegramId).toBe(true);
    expect(profile.dataCollected!.conversationHistory).toBe(true);
  });

  it('sets dataCollected.telegramId when telegramUserId is given', () => {
    const profile = buildUserProfile({ name: 'Test', telegramUserId: 12345 });
    expect(profile.dataCollected!.telegramId).toBe(true);
  });

  it('handles names with special characters', () => {
    const profile = buildUserProfile({ name: '---Special!!!Name---' });
    expect(profile.id).not.toBe('');
    // Should strip leading/trailing dashes and collapse multiples
    expect(profile.id).not.toMatch(/^-|-$/);
    expect(profile.id).not.toMatch(/--/);
  });
});

// ── getDefaultAutonomyConfig ────────────────────────────────────────

describe('getDefaultAutonomyConfig', () => {
  it('supervised preset disables all capabilities', () => {
    const config = getDefaultAutonomyConfig('supervised');
    expect(config.level).toBe('supervised');
    const caps = Object.values(config.capabilities);
    expect(caps.every(v => v === false)).toBe(true);
  });

  it('collaborative preset enables some capabilities', () => {
    const config = getDefaultAutonomyConfig('collaborative');
    expect(config.level).toBe('collaborative');
    expect(config.capabilities.assessJoinRequests).toBe(true);
    expect(config.capabilities.proposeConflictResolution).toBe(true);
    expect(config.capabilities.recommendConfigChanges).toBe(true);
    expect(config.capabilities.proactiveStatusAlerts).toBe(true);
    // Still disabled
    expect(config.capabilities.autoEnableVerifiedJobs).toBe(false);
    expect(config.capabilities.autoApproveKnownContacts).toBe(false);
  });

  it('autonomous preset enables all capabilities', () => {
    const config = getDefaultAutonomyConfig('autonomous');
    expect(config.level).toBe('autonomous');
    const caps = Object.values(config.capabilities);
    expect(caps.every(v => v === true)).toBe(true);
  });
});
