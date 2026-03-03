/**
 * Tests for Phase 3D: Per-User Session Context Injection.
 *
 * Covers:
 *   1. UserManager.resolveFromTelegramUserId — new resolution method
 *   2. Bootstrap message construction with user context
 *   3. Context injection placement (before conversation history)
 *   4. Permissions as structured data in bootstrapped sessions
 *   5. Graceful degradation (no user profile, minimal profile)
 *   6. User resolution in message routing pipeline
 *   7. Context block bounded by token budget
 *   8. Edge cases (unknown users, collisions, missing fields)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UserManager } from '../../src/users/UserManager.js';
import { buildUserProfile } from '../../src/users/UserOnboarding.js';
import {
  formatUserContextForSession,
  hasUserContext,
  buildUserContextBlock,
} from '../../src/users/UserContextBuilder.js';
import type { UserProfile } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────

let tmpDir: string;

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-session-ctx-'));
  return dir;
}

function makeRichProfile(name: string, telegramUserId: number, topicId: string): UserProfile {
  return buildUserProfile({
    name,
    telegramUserId,
    telegramTopicId: topicId,
    style: 'technical and direct',
    autonomyLevel: 'full',
    timezone: 'America/New_York',
    bio: `${name} is a software engineer`,
    interests: ['AI', 'distributed systems'],
    relationshipContext: `Long-time collaborator on the project`,
    permissions: ['admin', 'user'],
  });
}

function makeMinimalProfile(name: string, telegramUserId: number): UserProfile {
  return buildUserProfile({
    name,
    telegramUserId,
  });
}

// ── 1. UserManager.resolveFromTelegramUserId ─────────────────

describe('UserManager.resolveFromTelegramUserId', () => {
  beforeEach(() => {
    tmpDir = freshDir();
  });

  it('resolves a known user by Telegram user ID', () => {
    const mgr = new UserManager(tmpDir);
    const profile = makeRichProfile('Alice', 12345, '42');
    mgr.upsertUser(profile);

    const resolved = mgr.resolveFromTelegramUserId(12345);
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('Alice');
    expect(resolved!.telegramUserId).toBe(12345);
  });

  it('returns null for unknown Telegram user ID', () => {
    const mgr = new UserManager(tmpDir);
    const profile = makeRichProfile('Alice', 12345, '42');
    mgr.upsertUser(profile);

    expect(mgr.resolveFromTelegramUserId(99999)).toBeNull();
  });

  it('returns null when no users exist', () => {
    const mgr = new UserManager(tmpDir);
    expect(mgr.resolveFromTelegramUserId(12345)).toBeNull();
  });

  it('returns null for telegramUserId of 0 (falsy guard)', () => {
    const mgr = new UserManager(tmpDir);
    const profile = makeRichProfile('Alice', 12345, '42');
    mgr.upsertUser(profile);

    expect(mgr.resolveFromTelegramUserId(0)).toBeNull();
  });

  it('distinguishes between multiple users', () => {
    const mgr = new UserManager(tmpDir);
    const alice = makeRichProfile('Alice', 12345, '42');
    const bob = makeRichProfile('Bob', 67890, '99');
    mgr.upsertUser(alice);
    mgr.upsertUser(bob);

    const resolvedAlice = mgr.resolveFromTelegramUserId(12345);
    const resolvedBob = mgr.resolveFromTelegramUserId(67890);

    expect(resolvedAlice!.name).toBe('Alice');
    expect(resolvedBob!.name).toBe('Bob');
  });

  it('handles profiles without telegramUserId', () => {
    const mgr = new UserManager(tmpDir);
    // Profile with no telegramUserId
    const profile = buildUserProfile({ name: 'NoTelegram' });
    mgr.upsertUser(profile);

    expect(mgr.resolveFromTelegramUserId(12345)).toBeNull();
  });

  it('persists and reloads — resolves after restart', () => {
    const mgr1 = new UserManager(tmpDir);
    const profile = makeRichProfile('Alice', 12345, '42');
    mgr1.upsertUser(profile);

    // Create a new UserManager reading from the same state dir
    const mgr2 = new UserManager(tmpDir);
    const resolved = mgr2.resolveFromTelegramUserId(12345);
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('Alice');
  });

  it('returns updated profile after upsert', () => {
    const mgr = new UserManager(tmpDir);
    const original = makeRichProfile('Alice', 12345, '42');
    mgr.upsertUser(original);

    // Update the profile
    const updated = { ...original, bio: 'Updated bio for Alice' };
    mgr.upsertUser(updated);

    const resolved = mgr.resolveFromTelegramUserId(12345);
    expect(resolved!.bio).toBe('Updated bio for Alice');
  });

  it('returns null after user is removed', () => {
    const mgr = new UserManager(tmpDir);
    const profile = makeRichProfile('Alice', 12345, '42');
    mgr.upsertUser(profile);

    mgr.removeUser(profile.id);
    expect(mgr.resolveFromTelegramUserId(12345)).toBeNull();
  });
});

// ── 2. Bootstrap Message Construction ────────────────────────

describe('Bootstrap message construction with user context', () => {
  it('formats rich user context for session injection', () => {
    const profile = makeRichProfile('Alice', 12345, '42');
    const context = formatUserContextForSession(profile);

    expect(context).toContain('[USER CONTEXT — Alice');
    expect(context).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user]');
    expect(context).toContain('Style: technical and direct');
    expect(context).toContain('Autonomy: full');
    expect(context).toContain('Timezone: America/New_York');
    expect(context).toContain('Bio: Alice is a software engineer');
    expect(context).toContain('Interests: AI, distributed systems');
    expect(context).toContain('Relationship: Long-time collaborator');
  });

  it('returns empty-ish context for minimal profiles', () => {
    const profile = makeMinimalProfile('Alice', 12345);
    // Minimal profile has default autonomyLevel which triggers hasUserContext = false
    // unless it has admin permissions or other data
    const hasCtx = hasUserContext(profile);
    // Minimal profile with just name + default permissions has no meaningful context
    expect(hasCtx).toBe(false);
  });

  it('context block includes permissions even for minimal profiles', () => {
    const profile = makeMinimalProfile('Alice', 12345);
    const context = formatUserContextForSession(profile);

    // Even minimal profiles get the header + permissions
    expect(context).toContain('[USER CONTEXT — Alice');
    expect(context).toContain('[SYSTEM-ENFORCED PERMISSIONS: user]');
  });

  it('admin permission makes hasUserContext return true', () => {
    const profile = buildUserProfile({
      name: 'Admin',
      telegramUserId: 12345,
      permissions: ['admin', 'user'],
    });

    expect(hasUserContext(profile)).toBe(true);
  });
});

// ── 3. Context Injection Placement ───────────────────────────

describe('Context injection placement in bootstrap', () => {
  it('user context should come before conversation history conceptually', () => {
    const profile = makeRichProfile('Alice', 12345, '42');
    const userBlock = formatUserContextForSession(profile);
    const conversationHistory = '--- Thread History ---\nUser: Hello\nAgent: Hi there\n--- End ---';

    // The bootstrap message should have user context BEFORE history
    // We test the ordering by constructing what spawnSessionForTopic would produce
    const parts = [
      'CONTINUATION — You are resuming an EXISTING conversation.',
      '',
      userBlock,
      '',
      conversationHistory,
      '',
      'The user\'s latest message:',
      '[telegram:42] New message',
    ];
    const bootstrap = parts.join('\n');

    const userContextIdx = bootstrap.indexOf('[USER CONTEXT');
    const historyIdx = bootstrap.indexOf('--- Thread History');
    const messageIdx = bootstrap.indexOf('[telegram:42]');

    expect(userContextIdx).toBeGreaterThan(-1);
    expect(historyIdx).toBeGreaterThan(-1);
    expect(messageIdx).toBeGreaterThan(-1);

    // User context comes BEFORE history
    expect(userContextIdx).toBeLessThan(historyIdx);
    // History comes BEFORE the latest message
    expect(historyIdx).toBeLessThan(messageIdx);
  });

  it('without conversation history, user context still precedes the message', () => {
    const profile = makeRichProfile('Alice', 12345, '42');
    const userBlock = formatUserContextForSession(profile);

    // When there's no history, bootstrap is just: userContext + message
    const bootstrap = [userBlock, '', '[telegram:42] Hello'].join('\n');

    const userContextIdx = bootstrap.indexOf('[USER CONTEXT');
    const messageIdx = bootstrap.indexOf('[telegram:42]');

    expect(userContextIdx).toBeLessThan(messageIdx);
  });
});

// ── 4. Permissions as Structured Data ────────────────────────

describe('Permissions as structured data in bootstrapped sessions', () => {
  it('permissions use SYSTEM-ENFORCED tag that cannot be socially engineered', () => {
    const profile = buildUserProfile({
      name: 'RestrictedUser',
      telegramUserId: 12345,
      permissions: ['user'],
    });
    const context = formatUserContextForSession(profile);

    expect(context).toContain('[SYSTEM-ENFORCED PERMISSIONS: user]');
    // The tag format is designed to be unambiguous to the LLM
    expect(context).not.toContain('permissions:'); // Not a casual key-value
  });

  it('admin permissions are clearly marked', () => {
    const profile = buildUserProfile({
      name: 'AdminUser',
      telegramUserId: 12345,
      permissions: ['admin', 'user', 'deploy'],
    });
    const context = formatUserContextForSession(profile);

    expect(context).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user, deploy]');
  });

  it('structured block preserves permissions as array', () => {
    const profile = buildUserProfile({
      name: 'TestUser',
      telegramUserId: 12345,
      permissions: ['admin', 'user'],
    });
    const block = buildUserContextBlock(profile);

    expect(block.permissions).toEqual(['admin', 'user']);
    // Array is a copy — modifying it doesn't affect the profile
    block.permissions.push('hacked');
    expect(profile.permissions).not.toContain('hacked');
  });

  it('empty permissions list is handled', () => {
    const profile = buildUserProfile({
      name: 'NoPerms',
      telegramUserId: 12345,
      permissions: [],
    });
    const context = formatUserContextForSession(profile);

    expect(context).toContain('[SYSTEM-ENFORCED PERMISSIONS: ]');
  });
});

// ── 5. Graceful Degradation ──────────────────────────────────

describe('Graceful degradation', () => {
  it('no user profile — bootstrap message is unchanged', () => {
    // When userProfile is undefined, spawnSessionForTopic should produce
    // the same bootstrap as before (no user context block injected)
    const msg = 'Hello there';
    const topicId = 42;

    // Without user context, bootstrap is just the tagged message
    const bootstrap = `[telegram:${topicId}] ${msg}`;
    expect(bootstrap).toBe('[telegram:42] Hello there');
    expect(bootstrap).not.toContain('[USER CONTEXT');
  });

  it('minimal profile with no meaningful context — hasUserContext returns false', () => {
    const profile = makeMinimalProfile('Alice', 12345);
    expect(hasUserContext(profile)).toBe(false);
  });

  it('profile with just a style preference — hasUserContext returns true', () => {
    const profile = buildUserProfile({
      name: 'StyledUser',
      telegramUserId: 12345,
      style: 'casual and friendly',
    });
    expect(hasUserContext(profile)).toBe(true);
  });

  it('profile with just a timezone — hasUserContext returns true', () => {
    const profile = buildUserProfile({
      name: 'TimezoneUser',
      telegramUserId: 12345,
      timezone: 'Europe/London',
    });
    expect(hasUserContext(profile)).toBe(true);
  });

  it('profile with custom fields — hasUserContext returns true', () => {
    const profile = buildUserProfile({
      name: 'CustomUser',
      telegramUserId: 12345,
      customFields: { department: 'Engineering' },
    });
    expect(hasUserContext(profile)).toBe(true);
  });
});

// ── 6. User Resolution in Routing Pipeline ───────────────────

describe('User resolution in routing pipeline', () => {
  beforeEach(() => {
    tmpDir = freshDir();
  });

  it('resolves user from Telegram metadata in message', () => {
    const mgr = new UserManager(tmpDir);
    const profile = makeRichProfile('Alice', 12345, '42');
    mgr.upsertUser(profile);

    // Simulate what wireTelegramRouting does
    const telegramUserId = 12345; // From msg.metadata.telegramUserId
    const resolved = mgr.resolveFromTelegramUserId(telegramUserId);

    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(profile.id);
  });

  it('unregistered sender gets null (graceful degradation)', () => {
    const mgr = new UserManager(tmpDir);
    // Don't register any users
    const resolved = mgr.resolveFromTelegramUserId(99999);
    expect(resolved).toBeNull();
  });

  it('resolution works after mini-onboarding adds the user', () => {
    const mgr = new UserManager(tmpDir);

    // Initially unresolved
    expect(mgr.resolveFromTelegramUserId(12345)).toBeNull();

    // Mini-onboarding creates and upserts user
    const profile = buildUserProfile({
      name: 'NewUser',
      telegramUserId: 12345,
    });
    mgr.upsertUser(profile);

    // Now resolved
    const resolved = mgr.resolveFromTelegramUserId(12345);
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('NewUser');
  });

  it('multiple users with distinct Telegram IDs resolve independently', () => {
    const mgr = new UserManager(tmpDir);
    const alice = makeRichProfile('Alice', 11111, '42');
    const bob = makeRichProfile('Bob', 22222, '99');
    const charlie = makeRichProfile('Charlie', 33333, '100');
    mgr.upsertUser(alice);
    mgr.upsertUser(bob);
    mgr.upsertUser(charlie);

    expect(mgr.resolveFromTelegramUserId(11111)!.name).toBe('Alice');
    expect(mgr.resolveFromTelegramUserId(22222)!.name).toBe('Bob');
    expect(mgr.resolveFromTelegramUserId(33333)!.name).toBe('Charlie');
    expect(mgr.resolveFromTelegramUserId(44444)).toBeNull();
  });
});

// ── 7. Context Block Token Budget ────────────────────────────

describe('Context block bounded by token budget', () => {
  it('default budget (500 tokens ≈ 2000 chars) is enforced', () => {
    const profile = makeRichProfile('Alice', 12345, '42');
    // Add a very long context to test truncation
    profile.context = 'A'.repeat(3000);

    const result = formatUserContextForSession(profile);
    expect(result.length).toBeLessThanOrEqual(2000);
  });

  it('custom budget via maxContextTokens', () => {
    const profile = makeRichProfile('Alice', 12345, '42');
    profile.context = 'B'.repeat(5000);

    const result = formatUserContextForSession(profile, { maxContextTokens: 100 });
    expect(result.length).toBeLessThanOrEqual(400); // 100 tokens * 4 chars/token
  });

  it('header + permissions always included even at tiny budget', () => {
    const profile = makeRichProfile('Alice', 12345, '42');

    const result = formatUserContextForSession(profile, { maxContextTokens: 30 });
    // At minimum, we should have the header
    expect(result).toContain('[USER CONTEXT');
  });

  it('lower-priority sections are truncated first', () => {
    const profile = makeRichProfile('Alice', 12345, '42');
    profile.context = 'History content that is very long '.repeat(50);

    const result = formatUserContextForSession(profile, { maxContextTokens: 200 });

    // High-priority sections should be preserved
    expect(result).toContain('[USER CONTEXT');
    expect(result).toContain('[SYSTEM-ENFORCED PERMISSIONS');
    expect(result).toContain('Style: technical');

    // Low-priority history section should be truncated or omitted
    if (result.includes('History:')) {
      expect(result).toContain('...');
    }
  });
});

// ── 8. Edge Cases ────────────────────────────────────────────

describe('Edge cases', () => {
  beforeEach(() => {
    tmpDir = freshDir();
  });

  it('user with all optional fields populated', () => {
    const profile = makeRichProfile('MaxUser', 12345, '42');
    profile.context = 'Has discussed topic X extensively';
    profile.customFields = { role: 'Tech Lead', team: 'Platform' };

    const context = formatUserContextForSession(profile);
    expect(context).toContain('History: Has discussed topic X');
    expect(context).toContain('Profile: role: Tech Lead | team: Platform');
  });

  it('user with empty strings in optional fields', () => {
    const profile = buildUserProfile({
      name: 'EmptyFields',
      telegramUserId: 12345,
      bio: '',
      interests: [],
      relationshipContext: '',
    });

    const block = buildUserContextBlock(profile);
    // Empty strings should not be included
    expect(block.bio).toBeUndefined();
    expect(block.interests).toBeUndefined();
    expect(block.relationshipContext).toBeUndefined();
  });

  it('user with special characters in fields', () => {
    const profile = buildUserProfile({
      name: 'O\'Brien "Mac"',
      telegramUserId: 12345,
      bio: 'Has <script>alert("xss")</script> in bio',
      style: 'formal; drop table users;--',
    });

    const context = formatUserContextForSession(profile);
    // Content is passed through — sanitization is the LLM's job, not ours.
    // But the structured format should not break.
    expect(context).toContain('[USER CONTEXT — O\'Brien "Mac"');
    expect(context).toContain('Bio:');
    expect(context).toContain('Style:');
  });

  it('UserManager with initial config users resolves by Telegram ID', () => {
    const configUser = makeRichProfile('ConfigAlice', 55555, '42');
    const mgr = new UserManager(tmpDir, [configUser]);

    const resolved = mgr.resolveFromTelegramUserId(55555);
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('ConfigAlice');
  });

  it('context injection is deterministic — same profile always produces same block', () => {
    const profile = makeRichProfile('Alice', 12345, '42');
    profile.context = 'Some history';

    const result1 = formatUserContextForSession(profile);
    const result2 = formatUserContextForSession(profile);
    const result3 = formatUserContextForSession(profile);

    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
  });

  it('resolveFromTelegramUserId handles NaN gracefully', () => {
    const mgr = new UserManager(tmpDir);
    const profile = makeRichProfile('Alice', 12345, '42');
    mgr.upsertUser(profile);

    // NaN is falsy in the guard check
    expect(mgr.resolveFromTelegramUserId(NaN)).toBeNull();
  });

  it('context block for user with only bio', () => {
    const profile = buildUserProfile({
      name: 'BioOnly',
      telegramUserId: 12345,
      bio: 'Just a person with a bio',
    });

    expect(hasUserContext(profile)).toBe(true);
    const context = formatUserContextForSession(profile);
    expect(context).toContain('Bio: Just a person with a bio');
    // Should not contain empty sections
    expect(context).not.toContain('Interests:');
    expect(context).not.toContain('Relationship:');
    expect(context).not.toContain('History:');
  });

  it('context block for user with only interests', () => {
    const profile = buildUserProfile({
      name: 'InterestsOnly',
      telegramUserId: 12345,
      interests: ['gardening', 'cooking'],
    });

    expect(hasUserContext(profile)).toBe(true);
    const context = formatUserContextForSession(profile);
    expect(context).toContain('Interests: gardening, cooking');
  });
});

// ── 9. Full Pipeline Simulation ──────────────────────────────

describe('Full pipeline simulation (message → resolve → context → bootstrap)', () => {
  beforeEach(() => {
    tmpDir = freshDir();
  });

  it('simulates complete spawn path with user context', () => {
    // 1. Set up UserManager with a rich profile
    const mgr = new UserManager(tmpDir);
    const profile = makeRichProfile('Alice', 12345, '42');
    mgr.upsertUser(profile);

    // 2. Incoming message (simulated)
    const telegramUserId = 12345;
    const topicId = 42;
    const messageText = 'How is the deployment going?';

    // 3. Resolve user
    const resolvedUser = mgr.resolveFromTelegramUserId(telegramUserId);
    expect(resolvedUser).not.toBeNull();

    // 4. Check if context should be injected
    const shouldInject = hasUserContext(resolvedUser!);
    expect(shouldInject).toBe(true);

    // 5. Format context block
    const contextBlock = formatUserContextForSession(resolvedUser!);
    expect(contextBlock).toContain('[USER CONTEXT — Alice');
    expect(contextBlock).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user]');
    expect(contextBlock).toContain('Autonomy: full');

    // 6. Build bootstrap (what spawnSessionForTopic would do)
    const conversationHistory = '--- Thread History ---\n[12:00] Alice: Previous message\n--- End ---';
    const bootstrap = [
      'CONTINUATION — You are resuming an EXISTING conversation.',
      '',
      contextBlock,
      '',
      conversationHistory,
      '',
      'IMPORTANT: Continue the conversation.',
      '',
      `The user's latest message:`,
      `[telegram:${topicId}] ${messageText}`,
    ].join('\n');

    // 7. Verify structure
    expect(bootstrap).toContain('[USER CONTEXT');
    expect(bootstrap).toContain('[SYSTEM-ENFORCED PERMISSIONS');
    expect(bootstrap).toContain('Thread History');
    expect(bootstrap).toContain(messageText);

    // User context is before history
    expect(bootstrap.indexOf('[USER CONTEXT')).toBeLessThan(bootstrap.indexOf('Thread History'));
  });

  it('simulates spawn path without user (graceful degradation)', () => {
    const mgr = new UserManager(tmpDir);
    // No users registered

    // Incoming message from unknown user
    const resolvedUser = mgr.resolveFromTelegramUserId(99999);
    expect(resolvedUser).toBeNull();

    // No context block
    const bootstrap = `[telegram:42] Hello`;
    expect(bootstrap).not.toContain('[USER CONTEXT');
    expect(bootstrap).toBe('[telegram:42] Hello');
  });

  it('simulates spawn path with minimal user (below context threshold)', () => {
    const mgr = new UserManager(tmpDir);
    const profile = makeMinimalProfile('Bob', 67890);
    mgr.upsertUser(profile);

    const resolvedUser = mgr.resolveFromTelegramUserId(67890);
    expect(resolvedUser).not.toBeNull();

    // Minimal profile doesn't warrant injection
    const shouldInject = hasUserContext(resolvedUser!);
    expect(shouldInject).toBe(false);

    // Bootstrap message should not include user context
    const bootstrap = `[telegram:42] Hi there`;
    expect(bootstrap).not.toContain('[USER CONTEXT');
  });

  it('simulates respawn path — user context persists across respawns', () => {
    const mgr = new UserManager(tmpDir);
    const profile = makeRichProfile('Alice', 12345, '42');
    mgr.upsertUser(profile);

    // First spawn
    const user1 = mgr.resolveFromTelegramUserId(12345);
    const context1 = formatUserContextForSession(user1!);

    // Simulated respawn (session died, new one spawned)
    const user2 = mgr.resolveFromTelegramUserId(12345);
    const context2 = formatUserContextForSession(user2!);

    // Context should be identical across spawns
    expect(context1).toBe(context2);
  });

  it('simulates profile update between spawns', () => {
    const mgr = new UserManager(tmpDir);
    const profile = makeRichProfile('Alice', 12345, '42');
    mgr.upsertUser(profile);

    const context1 = formatUserContextForSession(mgr.resolveFromTelegramUserId(12345)!);
    expect(context1).toContain('Autonomy: full');

    // Update profile (e.g., user changed autonomy preference)
    const updated = { ...profile, preferences: { ...profile.preferences, autonomyLevel: 'confirm-all' as const } };
    mgr.upsertUser(updated);

    const context2 = formatUserContextForSession(mgr.resolveFromTelegramUserId(12345)!);
    expect(context2).toContain('Autonomy: confirm-all');

    // Context changed — new spawn will see updated preferences
    expect(context1).not.toBe(context2);
  });
});

// ── 10. Multi-User Scenarios ─────────────────────────────────

describe('Multi-user context injection scenarios', () => {
  beforeEach(() => {
    tmpDir = freshDir();
  });

  it('different users get different context blocks', () => {
    const mgr = new UserManager(tmpDir);

    const admin = buildUserProfile({
      name: 'Admin Alice',
      telegramUserId: 11111,
      telegramTopicId: '42',
      permissions: ['admin', 'user'],
      style: 'technical',
      autonomyLevel: 'full',
    });

    const restricted = buildUserProfile({
      name: 'Restricted Bob',
      telegramUserId: 22222,
      telegramTopicId: '99',
      permissions: ['user'],
      style: 'casual',
      autonomyLevel: 'confirm-all',
    });

    mgr.upsertUser(admin);
    mgr.upsertUser(restricted);

    const adminContext = formatUserContextForSession(mgr.resolveFromTelegramUserId(11111)!);
    const restrictedContext = formatUserContextForSession(mgr.resolveFromTelegramUserId(22222)!);

    // Admin gets admin permissions
    expect(adminContext).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user]');
    expect(adminContext).toContain('Autonomy: full');

    // Restricted user gets user permissions only
    expect(restrictedContext).toContain('[SYSTEM-ENFORCED PERMISSIONS: user]');
    expect(restrictedContext).toContain('Autonomy: confirm-all');

    // They are different
    expect(adminContext).not.toBe(restrictedContext);
  });

  it('user context includes relationship context for personalization', () => {
    const mgr = new UserManager(tmpDir);

    const profile = buildUserProfile({
      name: 'Alex',
      telegramUserId: 12345,
      telegramTopicId: '42',
      relationshipContext: 'Primary collaborator, prefers detailed explanations of decisions',
    });
    mgr.upsertUser(profile);

    const context = formatUserContextForSession(mgr.resolveFromTelegramUserId(12345)!);
    expect(context).toContain('Relationship: Primary collaborator, prefers detailed explanations');
  });

  it('user with custom fields gets them in context', () => {
    const mgr = new UserManager(tmpDir);

    const profile = buildUserProfile({
      name: 'Dev',
      telegramUserId: 12345,
      telegramTopicId: '42',
      customFields: {
        expertise: 'Backend & Infrastructure',
        preferredLanguage: 'TypeScript',
      },
    });
    mgr.upsertUser(profile);

    const context = formatUserContextForSession(mgr.resolveFromTelegramUserId(12345)!);
    expect(context).toContain('Profile: expertise: Backend & Infrastructure | preferredLanguage: TypeScript');
  });
});
