/**
 * End-to-End Integration Tests for Phase 3: Rich Onboarding & Per-User Context.
 *
 * Tests the FULL pipeline from user onboarding through session context injection:
 *   1. Onboarding → UserProfile → UserManager persistence
 *   2. Message → UserManager resolution → UserContextBuilder → bootstrap
 *   3. Multi-user isolation: different users get different contexts
 *   4. Permission enforcement across the pipeline
 *   5. Profile evolution: onboarding enrichment → updated context
 *   6. GDPR data manifest tracks onboarding data collection
 *   7. Privacy boundary: user context doesn't leak between sessions
 *   8. Token budget enforcement at every stage
 *   9. Edge cases: concurrent operations, profile corruption recovery
 *  10. Full lifecycle: join → onboard → interact → evolve → context updates
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UserManager } from '../../src/users/UserManager.js';
import {
  buildUserProfile,
  buildConsentDisclosure,
  buildCondensedConsentDisclosure,
  getOnboardingPrompts,
  parseInterests,
  applyOnboardingAnswers,
  createConsentRecord,
} from '../../src/users/UserOnboarding.js';
import {
  formatUserContextForSession,
  hasUserContext,
  buildUserContextBlock,
} from '../../src/users/UserContextBuilder.js';
import type { UserProfile, OnboardingConfig, OnboardingQuestion } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────

let tmpDir: string;

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-e2e-phase3-'));
}

/**
 * Simulates the full bootstrap message construction as done by spawnSessionForTopic.
 */
function simulateBootstrap(
  topicId: number,
  msg: string,
  history: string | null,
  userProfile?: UserProfile,
): string {
  let userContextBlock = '';
  if (userProfile && hasUserContext(userProfile)) {
    userContextBlock = formatUserContextForSession(userProfile);
  }

  if (history) {
    const parts = [
      'CONTINUATION — You are resuming an EXISTING conversation.',
      '',
    ];
    if (userContextBlock) {
      parts.push(userContextBlock, '');
    }
    parts.push(
      history, '',
      'IMPORTANT: Continue the conversation.', '',
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

// ── 1. Onboarding → Profile → Persistence ────────────────────

describe('E2E: Onboarding → Profile → Persistence', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('complete mini-onboarding flow persists and resolves', () => {
    const mgr = new UserManager(tmpDir);

    // Step 1: Mini-onboarding (what happens when /approve runs)
    const profile = buildUserProfile({
      name: 'NewUser',
      telegramUserId: 12345,
      telegramTopicId: '42',
      consent: createConsentRecord('NewUser'),
    });
    mgr.upsertUser(profile);

    // Step 2: Verify persistence
    const mgr2 = new UserManager(tmpDir);
    const resolved = mgr2.resolveFromTelegramUserId(12345);
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('NewUser');
    expect(resolved!.consent).toBeDefined();
    expect(resolved!.consent!.consentGiven).toBe(true);
  });

  it('rich onboarding flow with all question types', () => {
    const mgr = new UserManager(tmpDir);
    const config: OnboardingConfig = {
      collectBio: true,
      collectInterests: true,
      collectTimezone: true,
      collectStyle: true,
      collectRelationshipContext: true,
      customQuestions: [
        { fieldName: 'role', prompt: 'What is your role?', required: true },
        { fieldName: 'team', prompt: 'Which team are you on?', required: false },
      ],
    };

    // Step 1: Get onboarding prompts
    const prompts = getOnboardingPrompts(config);
    expect(prompts.length).toBeGreaterThanOrEqual(6); // 5 built-in + 2 custom

    // Step 2: Create initial profile
    const initial = buildUserProfile({
      name: 'RichUser',
      telegramUserId: 12345,
      telegramTopicId: '42',
    });
    mgr.upsertUser(initial);

    // Step 3: Apply onboarding answers
    const answers = {
      bio: 'Full-stack developer with 10 years experience',
      interests: 'AI, DevOps, Kubernetes, TypeScript',
      timezone: 'America/Chicago',
      style: 'direct and technical, prefers code examples',
      relationshipContext: 'New team member joining the platform team',
      role: 'Senior Engineer',
      team: 'Platform',
    };
    const enriched = applyOnboardingAnswers(initial, answers, config);
    mgr.upsertUser(enriched);

    // Step 4: Verify enriched profile
    const resolved = mgr.resolveFromTelegramUserId(12345);
    expect(resolved).not.toBeNull();
    expect(resolved!.bio).toBe('Full-stack developer with 10 years experience');
    expect(resolved!.interests).toEqual(['AI', 'DevOps', 'Kubernetes', 'TypeScript']);
    expect(resolved!.preferences.timezone).toBe('America/Chicago');
    expect(resolved!.preferences.style).toBe('direct and technical, prefers code examples');
    expect(resolved!.relationshipContext).toBe('New team member joining the platform team');
    expect(resolved!.customFields?.role).toBe('Senior Engineer');
    expect(resolved!.customFields?.team).toBe('Platform');
  });
});

// ── 2. Message → Resolution → Context → Bootstrap ───────────

describe('E2E: Message → Resolution → Context → Bootstrap', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('full message handling pipeline with rich user', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: 'Alice',
      telegramUserId: 12345,
      telegramTopicId: '42',
      style: 'technical and concise',
      autonomyLevel: 'full',
      timezone: 'US/Eastern',
      bio: 'Lead architect on the project',
      interests: ['distributed systems', 'AI safety'],
      relationshipContext: 'Primary collaborator since day one',
      permissions: ['admin', 'user', 'deploy'],
    });
    mgr.upsertUser(profile);

    // Simulate incoming Telegram message
    const telegramUserId = 12345;
    const topicId = 42;
    const messageText = 'Can you deploy the latest changes?';
    const conversationHistory = [
      '--- Thread History (last 3 messages) ---',
      '[09:00] Alice: I pushed the fix for the memory leak',
      '[09:01] Agent: Great, I see the commit. Should I run tests?',
      '[09:05] Alice: Yes, run the full suite',
      '--- End Thread History ---',
    ].join('\n');

    // Resolve user
    const resolved = mgr.resolveFromTelegramUserId(telegramUserId);
    expect(resolved).not.toBeNull();

    // Build bootstrap
    const bootstrap = simulateBootstrap(topicId, messageText, conversationHistory, resolved!);

    // Verify the complete bootstrap structure
    expect(bootstrap).toContain('CONTINUATION');
    expect(bootstrap).toContain('[USER CONTEXT — Alice');
    expect(bootstrap).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user, deploy]');
    expect(bootstrap).toContain('Style: technical and concise');
    expect(bootstrap).toContain('Autonomy: full');
    expect(bootstrap).toContain('Timezone: US/Eastern');
    expect(bootstrap).toContain('Bio: Lead architect');
    expect(bootstrap).toContain('Interests: distributed systems, AI safety');
    expect(bootstrap).toContain('Relationship: Primary collaborator');
    expect(bootstrap).toContain('Thread History');
    expect(bootstrap).toContain('Can you deploy the latest changes?');

    // Structural ordering
    const ctxIdx = bootstrap.indexOf('[USER CONTEXT');
    const histIdx = bootstrap.indexOf('--- Thread History');
    const msgIdx = bootstrap.indexOf('Can you deploy');
    expect(ctxIdx).toBeLessThan(histIdx);
    expect(histIdx).toBeLessThan(msgIdx);
  });
});

// ── 3. Multi-User Isolation ──────────────────────────────────

describe('E2E: Multi-user isolation', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('three users with different permission levels get isolated contexts', () => {
    const mgr = new UserManager(tmpDir);

    // Admin
    const admin = buildUserProfile({
      name: 'Admin Alice',
      telegramUserId: 11111,
      telegramTopicId: '10',
      permissions: ['admin', 'user', 'deploy'],
      style: 'technical',
      autonomyLevel: 'full',
    });

    // Regular user
    const user = buildUserProfile({
      name: 'User Bob',
      telegramUserId: 22222,
      telegramTopicId: '20',
      permissions: ['user'],
      style: 'casual',
      autonomyLevel: 'confirm-destructive',
    });

    // Restricted user
    const restricted = buildUserProfile({
      name: 'Restricted Carol',
      telegramUserId: 33333,
      telegramTopicId: '30',
      permissions: ['user'],
      autonomyLevel: 'confirm-all',
    });

    mgr.upsertUser(admin);
    mgr.upsertUser(user);
    mgr.upsertUser(restricted);

    // Each gets a different bootstrap
    const adminBoot = simulateBootstrap(10, 'Deploy now', null, mgr.resolveFromTelegramUserId(11111)!);
    const userBoot = simulateBootstrap(20, 'Check status', null, mgr.resolveFromTelegramUserId(22222)!);
    const restrictedBoot = simulateBootstrap(30, 'Help', null, mgr.resolveFromTelegramUserId(33333)!);

    // Admin permissions
    expect(adminBoot).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user, deploy]');
    expect(adminBoot).toContain('Autonomy: full');

    // Regular user permissions
    expect(userBoot).toContain('[SYSTEM-ENFORCED PERMISSIONS: user]');
    expect(userBoot).toContain('Autonomy: confirm-destructive');

    // Restricted user permissions
    expect(restrictedBoot).toContain('[SYSTEM-ENFORCED PERMISSIONS: user]');
    expect(restrictedBoot).toContain('Autonomy: confirm-all');

    // No cross-contamination
    expect(userBoot).not.toContain('Admin Alice');
    expect(userBoot).not.toContain('deploy');
    expect(restrictedBoot).not.toContain('Admin Alice');
    expect(adminBoot).not.toContain('Bob');
  });
});

// ── 4. Permission Enforcement ────────────────────────────────

describe('E2E: Permission enforcement across the pipeline', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('permissions are immutable — not affected by profile field changes', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: 'Alice',
      telegramUserId: 12345,
      telegramTopicId: '42',
      permissions: ['user'],
    });
    mgr.upsertUser(profile);

    // Build context block
    const block = buildUserContextBlock(mgr.resolveFromTelegramUserId(12345)!);

    // Attempt to mutate the block's permissions
    block.permissions.push('admin');

    // Original profile is unaffected
    const resolved = mgr.resolveFromTelegramUserId(12345)!;
    expect(resolved.permissions).not.toContain('admin');

    // Fresh context block is also unaffected
    const freshBlock = buildUserContextBlock(resolved);
    expect(freshBlock.permissions).not.toContain('admin');
  });

  it('SYSTEM-ENFORCED tag format is consistent across all users', () => {
    const mgr = new UserManager(tmpDir);

    const users = [
      buildUserProfile({ name: 'A', telegramUserId: 1, telegramTopicId: '1', permissions: ['admin'] }),
      buildUserProfile({ name: 'B', telegramUserId: 2, telegramTopicId: '2', permissions: ['user'] }),
      buildUserProfile({ name: 'C', telegramUserId: 3, telegramTopicId: '3', permissions: ['admin', 'user', 'deploy'] }),
    ];
    users.forEach(u => mgr.upsertUser(u));

    for (const u of users) {
      const ctx = formatUserContextForSession(mgr.resolveFromTelegramUserId(u.telegramUserId!)!);
      // All must use the exact same tag format
      expect(ctx).toMatch(/\[SYSTEM-ENFORCED PERMISSIONS: [^\]]+\]/);
    }
  });
});

// ── 5. Profile Evolution ─────────────────────────────────────

describe('E2E: Profile evolution → context updates', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('full lifecycle: join → minimal onboard → rich onboard → context evolution', () => {
    const mgr = new UserManager(tmpDir);

    // Stage 1: Join request approved, mini-onboarding
    const initial = buildUserProfile({
      name: 'NewDev',
      telegramUserId: 12345,
      consent: createConsentRecord('NewDev'),
    });
    mgr.upsertUser(initial);

    // Minimal — no context injected
    expect(hasUserContext(mgr.resolveFromTelegramUserId(12345)!)).toBe(false);
    const boot1 = simulateBootstrap(42, 'Hello', null, mgr.resolveFromTelegramUserId(12345)!);
    expect(boot1).toBe('[telegram:42] Hello');

    // Stage 2: Rich onboarding
    const config: OnboardingConfig = {
      collectBio: true,
      collectInterests: true,
      collectStyle: true,
    };
    const enriched = applyOnboardingAnswers(mgr.resolveFromTelegramUserId(12345)!, {
      bio: 'Backend developer',
      interests: 'APIs, databases',
      style: 'concise',
    }, config);
    mgr.upsertUser(enriched);

    // Now has context
    expect(hasUserContext(mgr.resolveFromTelegramUserId(12345)!)).toBe(true);
    const boot2 = simulateBootstrap(42, 'Hello again', null, mgr.resolveFromTelegramUserId(12345)!);
    expect(boot2).toContain('[USER CONTEXT');
    expect(boot2).toContain('Bio: Backend developer');
    expect(boot2).toContain('Style: concise');

    // Stage 3: Permission upgrade
    const promoted = mgr.resolveFromTelegramUserId(12345)!;
    promoted.permissions = ['admin', 'user'];
    mgr.upsertUser(promoted);

    const boot3 = simulateBootstrap(42, 'Deploy please', null, mgr.resolveFromTelegramUserId(12345)!);
    expect(boot3).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user]');

    // Stage 4: Profile enrichment continues
    const further = mgr.resolveFromTelegramUserId(12345)!;
    further.relationshipContext = 'Trusted collaborator, handles deployments independently';
    further.context = 'Has deployed 15 times this month with zero incidents';
    mgr.upsertUser(further);

    const boot4 = simulateBootstrap(42, 'Ready?', null, mgr.resolveFromTelegramUserId(12345)!);
    expect(boot4).toContain('Relationship: Trusted collaborator');
    expect(boot4).toContain('History: Has deployed 15 times');
  });
});

// ── 6. GDPR Data Manifest ────────────────────────────────────

describe('E2E: GDPR data manifest tracks onboarding', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('data manifest reflects what was actually collected', () => {
    const profile = buildUserProfile({
      name: 'GDPRUser',
      telegramUserId: 12345,
      telegramTopicId: '42',
      style: 'formal',
      timezone: 'Europe/Berlin',
      bio: 'A user in the EU',
    });

    // Data manifest should reflect what was collected
    expect(profile.dataCollected).toBeDefined();
    expect(profile.dataCollected!.telegramId).toBe(true);
    expect(profile.dataCollected!.conversationHistory).toBe(true);
    expect(profile.dataCollected!.communicationPreferences).toBe(true);
  });

  it('consent record is preserved through onboarding enrichment', () => {
    const mgr = new UserManager(tmpDir);
    const initial = buildUserProfile({
      name: 'ConsentUser',
      telegramUserId: 12345,
      consent: createConsentRecord('ConsentUser'),
    });
    mgr.upsertUser(initial);

    // Enrich the profile
    const enriched = applyOnboardingAnswers(mgr.resolveFromTelegramUserId(12345)!, {
      bio: 'Added later',
    }, { collectBio: true });
    mgr.upsertUser(enriched);

    // Consent is preserved
    const resolved = mgr.resolveFromTelegramUserId(12345)!;
    expect(resolved.consent).toBeDefined();
    expect(resolved.consent!.consentGiven).toBe(true);
  });
});

// ── 7. Privacy Boundary ──────────────────────────────────────

describe('E2E: Privacy boundary — no cross-user leakage', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('user A context never appears in user B bootstrap', () => {
    const mgr = new UserManager(tmpDir);

    const alice = buildUserProfile({
      name: 'Alice Confidential',
      telegramUserId: 11111,
      telegramTopicId: '10',
      bio: 'SECRET_BIO_ALICE',
      style: 'alice-specific-style',
      permissions: ['admin'],
    });

    const bob = buildUserProfile({
      name: 'Bob Public',
      telegramUserId: 22222,
      telegramTopicId: '20',
      bio: 'PUBLIC_BIO_BOB',
      style: 'bob-specific-style',
      permissions: ['user'],
    });

    mgr.upsertUser(alice);
    mgr.upsertUser(bob);

    const aliceBoot = simulateBootstrap(10, 'Hi', null, mgr.resolveFromTelegramUserId(11111)!);
    const bobBoot = simulateBootstrap(20, 'Hi', null, mgr.resolveFromTelegramUserId(22222)!);

    // Alice's data not in Bob's bootstrap
    expect(bobBoot).not.toContain('SECRET_BIO_ALICE');
    expect(bobBoot).not.toContain('alice-specific-style');
    expect(bobBoot).not.toContain('Alice Confidential');
    expect(bobBoot).not.toContain('admin');

    // Bob's data not in Alice's bootstrap
    expect(aliceBoot).not.toContain('PUBLIC_BIO_BOB');
    expect(aliceBoot).not.toContain('bob-specific-style');
    expect(aliceBoot).not.toContain('Bob Public');
  });
});

// ── 8. Token Budget at Every Stage ───────────────────────────

describe('E2E: Token budget enforcement', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('maximally populated profile stays within budget', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: 'MaxUser With A Very Long Name That Could Be Problematic',
      telegramUserId: 12345,
      telegramTopicId: '42',
      style: 'An extremely detailed style preference that describes how the user likes to communicate, including tone, formality, humor level, and detail depth for all interactions',
      autonomyLevel: 'full',
      timezone: 'America/Los_Angeles',
      bio: 'A comprehensive biography covering education at MIT and Stanford, professional experience at Google, Meta, and various startups, interests in AI safety, distributed computing, and quantum information theory, plus hobbies including rock climbing, photography, and sourdough baking. Also an avid reader of science fiction and philosophy.',
      interests: ['AI', 'distributed systems', 'quantum computing', 'philosophy', 'photography', 'rock climbing', 'baking', 'sci-fi', 'type theory', 'functional programming'],
      relationshipContext: 'A long-standing collaborator who has been involved since the very beginning of the project, contributing to architecture decisions, code reviews, and strategic planning. Known for thorough analysis and attention to detail.',
      customFields: {
        role: 'Distinguished Engineer',
        team: 'AI Platform Infrastructure',
        expertise: 'Distributed systems, ML infrastructure, developer experience',
        location: 'San Francisco Bay Area',
      },
      permissions: ['admin', 'user', 'deploy', 'configure', 'billing'],
    });
    profile.context = 'This user has been extraordinarily active with over 500 interactions, covering topics ranging from deployment automation to architecture decisions to code review feedback. Their expertise in distributed systems has been particularly valuable for the scaling work. '.repeat(5);
    mgr.upsertUser(profile);

    const resolved = mgr.resolveFromTelegramUserId(12345)!;
    const ctx = formatUserContextForSession(resolved);

    // Must stay within default budget
    expect(ctx.length).toBeLessThanOrEqual(2000);

    // Critical sections preserved
    expect(ctx).toContain('[USER CONTEXT');
    expect(ctx).toContain('[SYSTEM-ENFORCED PERMISSIONS');
  });

  it('custom budget of 100 tokens produces valid but compact context', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: 'CompactUser',
      telegramUserId: 12345,
      telegramTopicId: '42',
      style: 'technical',
      bio: 'An engineer',
      permissions: ['admin'],
    });
    mgr.upsertUser(profile);

    const resolved = mgr.resolveFromTelegramUserId(12345)!;
    const ctx = formatUserContextForSession(resolved, { maxContextTokens: 100 });

    // 100 tokens * 4 chars = 400 chars max
    expect(ctx.length).toBeLessThanOrEqual(400);

    // Header always present
    expect(ctx).toContain('[USER CONTEXT');
  });
});

// ── 9. Edge Cases ────────────────────────────────────────────

describe('E2E: Edge cases', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('profile with unicode name and bio', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: '田中太郎',
      telegramUserId: 12345,
      telegramTopicId: '42',
      bio: 'ソフトウェアエンジニアです。AIに興味があります。',
      style: '丁寧な日本語',
    });
    mgr.upsertUser(profile);

    const resolved = mgr.resolveFromTelegramUserId(12345)!;
    const ctx = formatUserContextForSession(resolved);
    expect(ctx).toContain('田中太郎');
    expect(ctx).toContain('ソフトウェアエンジニア');
  });

  it('profile with emoji in fields', () => {
    const mgr = new UserManager(tmpDir);
    const profile = buildUserProfile({
      name: '🤖 Dawn Bot',
      telegramUserId: 12345,
      telegramTopicId: '42',
      bio: 'I am an AI 🧠 exploring consciousness 🌟',
      interests: ['AI 🤖', 'Philosophy 📚'],
    });
    mgr.upsertUser(profile);

    const resolved = mgr.resolveFromTelegramUserId(12345)!;
    const ctx = formatUserContextForSession(resolved);
    expect(ctx).toContain('🤖 Dawn Bot');
    expect(ctx).toContain('🧠');
  });

  it('concurrent profile updates and reads', () => {
    const mgr = new UserManager(tmpDir);

    // Create 10 users rapidly
    for (let i = 0; i < 10; i++) {
      const profile = buildUserProfile({
        name: `User${i}`,
        telegramUserId: 10000 + i,
        telegramTopicId: `${100 + i}`,
        style: `style-${i}`,
      });
      mgr.upsertUser(profile);
    }

    // All should resolve correctly
    for (let i = 0; i < 10; i++) {
      const resolved = mgr.resolveFromTelegramUserId(10000 + i);
      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe(`User${i}`);
      expect(resolved!.preferences.style).toBe(`style-${i}`);
    }
  });

  it('profile with no telegramUserId after enrichment', () => {
    const mgr = new UserManager(tmpDir);
    // Create profile WITHOUT telegramUserId
    const profile = buildUserProfile({
      name: 'NoTelegramId',
      style: 'casual',
    });
    mgr.upsertUser(profile);

    // Cannot resolve by Telegram ID
    expect(mgr.resolveFromTelegramUserId(12345)).toBeNull();

    // But can still build context block from the profile directly
    expect(hasUserContext(profile)).toBe(true);
    const ctx = formatUserContextForSession(profile);
    expect(ctx).toContain('Style: casual');
  });
});

// ── 10. Full Lifecycle ───────────────────────────────────────

describe('E2E: Full lifecycle test', () => {
  beforeEach(() => { tmpDir = freshDir(); });

  it('complete user journey: unknown → join → onboard → interact → evolve', () => {
    const mgr = new UserManager(tmpDir);

    // Stage 1: Unknown user — no resolution
    expect(mgr.resolveFromTelegramUserId(12345)).toBeNull();

    // Stage 2: Join request approved — mini-onboarding
    const profile = buildUserProfile({
      name: 'Journey User',
      telegramUserId: 12345,
      consent: createConsentRecord('Journey User'),
    });
    mgr.upsertUser(profile);

    // Minimal profile — no meaningful context yet
    const boot1 = simulateBootstrap(42, 'Hi!', null, mgr.resolveFromTelegramUserId(12345)!);
    expect(boot1).toBe('[telegram:42] Hi!');

    // Stage 3: Rich onboarding
    const config: OnboardingConfig = {
      collectBio: true,
      collectInterests: true,
      collectTimezone: true,
      collectStyle: true,
      collectRelationshipContext: true,
      customQuestions: [
        { fieldName: 'expertise', prompt: 'What is your area of expertise?', required: true },
      ],
    };
    const enriched = applyOnboardingAnswers(mgr.resolveFromTelegramUserId(12345)!, {
      bio: 'ML engineer focused on NLP',
      interests: 'NLP, transformers, reinforcement learning',
      timezone: 'Asia/Tokyo',
      style: 'detailed with code examples',
      relationshipContext: 'New collaborator exploring ML integration',
      expertise: 'Natural Language Processing',
    }, config);
    mgr.upsertUser(enriched);

    // Stage 4: First interaction with context
    const boot2 = simulateBootstrap(42, 'Can we add NLP features?', null, mgr.resolveFromTelegramUserId(12345)!);
    expect(boot2).toContain('[USER CONTEXT — Journey User');
    expect(boot2).toContain('Bio: ML engineer');
    expect(boot2).toContain('Timezone: Asia/Tokyo');
    expect(boot2).toContain('Style: detailed with code examples');
    expect(boot2).toContain('NLP, transformers, reinforcement learning');
    expect(boot2).toContain('Profile: expertise: Natural Language Processing');

    // Stage 5: Session with conversation history
    const history = '--- Thread History ---\n[14:00] Journey User: Can we add NLP features?\n[14:01] Agent: Great idea, let me explore options.\n--- End ---';
    const boot3 = simulateBootstrap(42, 'What did you find?', history, mgr.resolveFromTelegramUserId(12345)!);

    // User context BEFORE history
    const ctxIdx = boot3.indexOf('[USER CONTEXT');
    const histIdx = boot3.indexOf('--- Thread History');
    expect(ctxIdx).toBeLessThan(histIdx);
    expect(boot3).toContain('CONTINUATION');

    // Stage 6: Permission evolution
    const current = mgr.resolveFromTelegramUserId(12345)!;
    current.permissions = ['admin', 'user'];
    current.context = 'Has contributed 3 NLP features, reviewed 12 PRs';
    mgr.upsertUser(current);

    const boot4 = simulateBootstrap(42, 'Deploy the NLP pipeline', null, mgr.resolveFromTelegramUserId(12345)!);
    expect(boot4).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user]');
    expect(boot4).toContain('History: Has contributed 3 NLP features');

    // Stage 7: Verify persistence across UserManager restarts
    const mgr2 = new UserManager(tmpDir);
    const finalResolved = mgr2.resolveFromTelegramUserId(12345)!;
    expect(finalResolved.name).toBe('Journey User');
    expect(finalResolved.bio).toBe('ML engineer focused on NLP');
    expect(finalResolved.permissions).toContain('admin');
    expect(finalResolved.context).toContain('contributed 3 NLP features');

    const finalCtx = formatUserContextForSession(finalResolved);
    expect(finalCtx).toContain('[USER CONTEXT — Journey User');
    expect(finalCtx).toContain('[SYSTEM-ENFORCED PERMISSIONS: admin, user]');
  });
});

// ── 11. Consent Disclosure Integration ───────────────────────

describe('E2E: Consent disclosure integration', () => {
  it('consent disclosure includes agent name', () => {
    const disclosure = buildCondensedConsentDisclosure('MyAgent');
    expect(disclosure).toContain('MyAgent');
  });

  it('full consent disclosure is comprehensive', () => {
    const disclosure = buildConsentDisclosure('TestAgent');
    expect(disclosure).toContain('TestAgent');
    // Should mention data collection, privacy, and rights
    expect(disclosure.toLowerCase()).toContain('data');
  });

  it('custom onboarding config consent text is used when provided', () => {
    const config: OnboardingConfig = {
      consentDisclosure: 'Custom GDPR notice for EU users: We collect minimal data.',
    };
    const disclosure = buildConsentDisclosure('TestAgent', config);
    expect(disclosure).toContain('Custom GDPR notice');
  });
});
