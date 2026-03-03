/**
 * Integration tests for Phase 3D: Session Context Injection Wiring.
 *
 * Tests the actual integration between UserManager, UserContextBuilder,
 * and the bootstrap message construction pipeline. These tests verify
 * that the components work together correctly, not just in isolation.
 *
 * Covers:
 *   1. UserManager → UserContextBuilder pipeline
 *   2. Bootstrap message structure with all components
 *   3. User profile evolution reflected in subsequent spawns
 *   4. Multi-user session isolation
 *   5. Onboarding → profile → context injection flow
 *   6. Token budget respected in full pipeline
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UserManager } from '../../src/users/UserManager.js';
import {
  buildUserProfile,
  applyOnboardingAnswers,
} from '../../src/users/UserOnboarding.js';
import {
  formatUserContextForSession,
  hasUserContext,
  buildUserContextBlock,
} from '../../src/users/UserContextBuilder.js';
import type { UserProfile, OnboardingConfig } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────

let tmpDir: string;

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ctx-wiring-'));
}

/**
 * Simulate what spawnSessionForTopic does when building a bootstrap message.
 * This mirrors the actual code path in server.ts.
 */
function buildBootstrapMessage(
  topicId: number,
  msg: string,
  contextContent: string | null,
  userProfile?: UserProfile,
): string {
  // Mirror the actual logic in spawnSessionForTopic
  let userContextBlock = '';
  if (userProfile && hasUserContext(userProfile)) {
    userContextBlock = formatUserContextForSession(userProfile);
  }

  if (contextContent) {
    const parts = [
      'CONTINUATION — You are resuming an EXISTING conversation. Read the context below before responding.',
      '',
    ];

    if (userContextBlock) {
      parts.push(userContextBlock);
      parts.push('');
    }

    parts.push(
      contextContent,
      '',
      'IMPORTANT: Your response MUST acknowledge and continue the conversation above.',
      '',
      `The user's latest message:`,
      `[telegram:${topicId}] ${msg}`,
    );

    return parts.join('\n');
  } else {
    if (userContextBlock) {
      return [userContextBlock, '', `[telegram:${topicId}] ${msg}`].join('\n');
    }
    return `[telegram:${topicId}] ${msg}`;
  }
}

// ── 1. UserManager → UserContextBuilder Pipeline ─────────────

describe('UserManager → UserContextBuilder pipeline', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('full pipeline: create user → resolve → format context', () => {
    const mgr = new UserManager(tmpDir);

    // Create a user via buildUserProfile (onboarding path)
    const profile = buildUserProfile({
      name: 'Alice',
      telegramUserId: 12345,
      telegramTopicId: '42',
      style: 'technical',
      autonomyLevel: 'full',
      timezone: 'US/Pacific',
      bio: 'Senior engineer working on distributed systems',
      interests: ['AI', 'Rust', 'system design'],
      relationshipContext: 'Primary collaborator since project inception',
      permissions: ['admin', 'user'],
    });
    mgr.upsertUser(profile);

    // Resolve from incoming message
    const resolved = mgr.resolveFromTelegramUserId(12345);
    expect(resolved).not.toBeNull();

    // Build context block
    const block = buildUserContextBlock(resolved!);
    expect(block.name).toBe('Alice');
    expect(block.permissions).toContain('admin');
    expect(block.preferences?.style).toBe('technical');
    expect(block.bio).toContain('Senior engineer');
    expect(block.interests).toContain('Rust');

    // Format for session injection
    const text = formatUserContextForSession(resolved!);
    expect(text).toContain('[USER CONTEXT — Alice');
    expect(text).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user]');
    expect(text).toContain('Style: technical');
    expect(text).toContain('Autonomy: full');
    expect(text).toContain('Timezone: US/Pacific');
    expect(text).toContain('Bio: Senior engineer');
    expect(text).toContain('Interests: AI, Rust, system design');
    expect(text).toContain('Relationship: Primary collaborator');
  });

  it('pipeline with persistence: create → restart → resolve', () => {
    // Create and persist
    const mgr1 = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: 'Bob',
      telegramUserId: 67890,
      telegramTopicId: '99',
      style: 'casual',
      permissions: ['user'],
    });
    mgr1.upsertUser(profile);

    // New UserManager instance (simulates server restart)
    const mgr2 = new UserManager(tmpDir);
    const resolved = mgr2.resolveFromTelegramUserId(67890);
    expect(resolved).not.toBeNull();

    const text = formatUserContextForSession(resolved!);
    expect(text).toContain('[USER CONTEXT — Bob');
    expect(text).toContain('[SYSTEM-ENFORCED PERMISSIONS: user]');
    expect(text).toContain('Style: casual');
  });
});

// ── 2. Bootstrap Message Structure ───────────────────────────

describe('Bootstrap message structure with all components', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('with user context + conversation history + latest message', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: 'Alice',
      telegramUserId: 12345,
      telegramTopicId: '42',
      permissions: ['admin', 'user'],
      style: 'technical',
      autonomyLevel: 'full',
    });
    mgr.upsertUser(profile);

    const resolved = mgr.resolveFromTelegramUserId(12345)!;
    const history = '--- Thread History (last 5 messages) ---\n[10:00] Alice: How is the build?\n[10:01] Agent: Running now.\n--- End ---';

    const bootstrap = buildBootstrapMessage(42, 'Any update?', history, resolved);

    // Structure check: CONTINUATION → user context → history → latest message
    const lines = bootstrap.split('\n');
    expect(lines[0]).toContain('CONTINUATION');

    const userCtxIdx = bootstrap.indexOf('[USER CONTEXT');
    const histIdx = bootstrap.indexOf('--- Thread History');
    const msgIdx = bootstrap.indexOf('[telegram:42] Any update?');

    expect(userCtxIdx).toBeGreaterThan(0);
    expect(histIdx).toBeGreaterThan(userCtxIdx);
    expect(msgIdx).toBeGreaterThan(histIdx);
  });

  it('with user context but no conversation history', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: 'Bob',
      telegramUserId: 67890,
      telegramTopicId: '99',
      permissions: ['user'],
      style: 'casual',
    });
    mgr.upsertUser(profile);

    const resolved = mgr.resolveFromTelegramUserId(67890)!;
    const bootstrap = buildBootstrapMessage(99, 'Hello!', null, resolved);

    // Should have user context followed by message — no CONTINUATION header
    expect(bootstrap).toContain('[USER CONTEXT — Bob');
    expect(bootstrap).toContain('[telegram:99] Hello!');
    expect(bootstrap).not.toContain('CONTINUATION');
    expect(bootstrap).not.toContain('Thread History');
  });

  it('without user context but with conversation history', () => {
    const history = '--- Thread History ---\nSome history\n--- End ---';
    const bootstrap = buildBootstrapMessage(42, 'Hello', history, undefined);

    expect(bootstrap).toContain('CONTINUATION');
    expect(bootstrap).toContain('Thread History');
    expect(bootstrap).not.toContain('[USER CONTEXT');
    expect(bootstrap).toContain('[telegram:42] Hello');
  });

  it('without user context and without conversation history', () => {
    const bootstrap = buildBootstrapMessage(42, 'Hello', null, undefined);

    expect(bootstrap).toBe('[telegram:42] Hello');
    expect(bootstrap).not.toContain('[USER CONTEXT');
    expect(bootstrap).not.toContain('CONTINUATION');
  });

  it('with minimal user (below threshold) — no context injected', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({ name: 'Minimal', telegramUserId: 11111 });
    mgr.upsertUser(profile);

    const resolved = mgr.resolveFromTelegramUserId(11111)!;
    expect(hasUserContext(resolved)).toBe(false);

    const bootstrap = buildBootstrapMessage(42, 'Hi', null, resolved);
    expect(bootstrap).toBe('[telegram:42] Hi');
  });
});

// ── 3. Profile Evolution Reflected in Spawns ─────────────────

describe('User profile evolution reflected in subsequent spawns', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('permission change reflected immediately', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: 'Alice',
      telegramUserId: 12345,
      telegramTopicId: '42',
      permissions: ['user'],
    });
    mgr.upsertUser(profile);

    // First spawn — user permissions only
    const ctx1 = formatUserContextForSession(mgr.resolveFromTelegramUserId(12345)!);
    expect(ctx1).toContain('[SYSTEM-ENFORCED PERMISSIONS: user]');

    // Promote to admin
    profile.permissions = ['admin', 'user'];
    mgr.upsertUser(profile);

    // Second spawn — admin permissions
    const ctx2 = formatUserContextForSession(mgr.resolveFromTelegramUserId(12345)!);
    expect(ctx2).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user]');
  });

  it('enriched profile after onboarding produces richer context', () => {
    const mgr = new UserManager(tmpDir);

    // Initial minimal profile (from join request)
    const initial = buildUserProfile({
      name: 'NewUser',
      telegramUserId: 12345,
    });
    mgr.upsertUser(initial);

    // First spawn — minimal context
    const resolved1 = mgr.resolveFromTelegramUserId(12345)!;
    expect(hasUserContext(resolved1)).toBe(false);

    // Rich onboarding completes
    const onboardingConfig: OnboardingConfig = {
      collectBio: true,
      collectInterests: true,
      collectTimezone: true,
      collectStyle: true,
    };
    const enriched = applyOnboardingAnswers(resolved1, {
      bio: 'A curious developer',
      interests: 'AI, music, hiking',
      timezone: 'Europe/Berlin',
      style: 'friendly and detailed',
    }, onboardingConfig);
    mgr.upsertUser(enriched);

    // Second spawn — rich context
    const resolved2 = mgr.resolveFromTelegramUserId(12345)!;
    expect(hasUserContext(resolved2)).toBe(true);

    const ctx = formatUserContextForSession(resolved2);
    expect(ctx).toContain('Bio: A curious developer');
    expect(ctx).toContain('Interests: AI, music, hiking');
    expect(ctx).toContain('Timezone: Europe/Berlin');
    expect(ctx).toContain('Style: friendly and detailed');
  });
});

// ── 4. Multi-User Session Isolation ──────────────────────────

describe('Multi-user session isolation', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('concurrent users get isolated context blocks', () => {
    const mgr = new UserManager(tmpDir);

    const admin = buildUserProfile({
      name: 'Admin',
      telegramUserId: 11111,
      telegramTopicId: '42',
      permissions: ['admin', 'user'],
      style: 'technical',
      autonomyLevel: 'full',
    });

    const guest = buildUserProfile({
      name: 'Guest',
      telegramUserId: 22222,
      telegramTopicId: '99',
      permissions: ['user'],
      style: 'casual',
      autonomyLevel: 'confirm-all',
    });

    mgr.upsertUser(admin);
    mgr.upsertUser(guest);

    // Simulate concurrent messages from different users
    const adminBootstrap = buildBootstrapMessage(
      42, 'Deploy now',
      '--- History ---\n[10:00] Admin: Ready to deploy?\n--- End ---',
      mgr.resolveFromTelegramUserId(11111)!,
    );

    const guestBootstrap = buildBootstrapMessage(
      99, 'How does this work?',
      '--- History ---\n[10:00] Guest: Hi!\n--- End ---',
      mgr.resolveFromTelegramUserId(22222)!,
    );

    // Admin gets admin permissions
    expect(adminBootstrap).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user]');
    expect(adminBootstrap).toContain('Autonomy: full');

    // Guest gets user permissions only
    expect(guestBootstrap).toContain('[SYSTEM-ENFORCED PERMISSIONS: user]');
    expect(guestBootstrap).toContain('Autonomy: confirm-all');

    // Admin context doesn't leak into guest session
    expect(guestBootstrap).not.toContain('Admin');
    expect(adminBootstrap).not.toContain('Guest');
  });
});

// ── 5. Onboarding → Profile → Context Flow ──────────────────

describe('Onboarding → Profile → Context injection flow', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('mini-onboarding creates user that gets context in next spawn', () => {
    const mgr = new UserManager(tmpDir);

    // Mini-onboarding path (what onStartMiniOnboarding does)
    const profile = buildUserProfile({
      name: 'NewJoiner',
      telegramUserId: 12345,
    });
    mgr.upsertUser(profile);

    // Minimal profile — no context injected yet
    const resolved = mgr.resolveFromTelegramUserId(12345)!;
    expect(hasUserContext(resolved)).toBe(false);

    // After rich onboarding
    const enriched = applyOnboardingAnswers(resolved, {
      bio: 'Data scientist exploring AI agents',
      interests: 'ML, statistics, visualization',
      style: 'analytical',
    }, {
      collectBio: true,
      collectInterests: true,
      collectStyle: true,
    });
    mgr.upsertUser(enriched);

    // Now has context
    const resolvedAfter = mgr.resolveFromTelegramUserId(12345)!;
    expect(hasUserContext(resolvedAfter)).toBe(true);

    const ctx = formatUserContextForSession(resolvedAfter);
    expect(ctx).toContain('Bio: Data scientist');
    expect(ctx).toContain('Interests: ML, statistics, visualization');
    expect(ctx).toContain('Style: analytical');
  });
});

// ── 6. Token Budget in Full Pipeline ─────────────────────────

describe('Token budget respected in full pipeline', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('context block stays within budget even with all fields populated', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: 'MaxProfile',
      telegramUserId: 12345,
      telegramTopicId: '42',
      style: 'technical and direct with extensive details about preferences',
      autonomyLevel: 'full',
      timezone: 'America/Los_Angeles',
      bio: 'A very detailed biography that goes on and on about the person\'s background, experience, education, and professional history in software engineering and AI research.',
      interests: ['machine learning', 'distributed systems', 'functional programming', 'category theory', 'type theory'],
      relationshipContext: 'Long-standing collaborator who has been involved since the beginning of the project and has contributed significantly to the architecture decisions.',
      customFields: {
        role: 'Principal Engineer',
        team: 'Platform Infrastructure',
        focus: 'Scalability and reliability',
      },
      permissions: ['admin', 'user', 'deploy', 'configure'],
    });
    profile.context = 'Has discussed deployment strategies, reviewed PRs, and contributed to the architecture docs. Active in weekly syncs. Prefers async communication.';
    mgr.upsertUser(profile);

    const resolved = mgr.resolveFromTelegramUserId(12345)!;
    const ctx = formatUserContextForSession(resolved);

    // Default budget is 500 tokens ≈ 2000 chars
    expect(ctx.length).toBeLessThanOrEqual(2000);

    // High-priority sections must still be present
    expect(ctx).toContain('[USER CONTEXT');
    expect(ctx).toContain('[SYSTEM-ENFORCED PERMISSIONS');
  });

  it('onboarding config maxContextTokens is respected', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: 'TinyBudget',
      telegramUserId: 12345,
      telegramTopicId: '42',
      style: 'verbose',
      bio: 'A very long bio '.repeat(100),
      permissions: ['admin', 'user'],
    });
    mgr.upsertUser(profile);

    const resolved = mgr.resolveFromTelegramUserId(12345)!;
    const ctx = formatUserContextForSession(resolved, {
      onboardingConfig: { maxContextTokens: 50 },
    });

    // 50 tokens * 4 chars = 200 chars max
    expect(ctx.length).toBeLessThanOrEqual(200);
  });
});
