import { describe, it, expect } from 'vitest';
import {
  validatePrivacyScope,
  isValidScopeType,
  isVisibleToUser,
  buildPrivacySqlFilter,
  defaultScope,
  privateScope,
  sharedTopicScope,
  sharedProjectScope,
  isValidOnboardingTransition,
  createOnboardingSession,
  transitionOnboarding,
  MAX_PENDING_MESSAGES,
  ONBOARDING_TIMEOUT_MINUTES,
} from '../../src/utils/privacy.js';
import type {
  PrivacyScopeType,
  PrivacyScope,
  OnboardingState,
  OnboardingSession,
} from '../../src/core/types.js';

// ── validatePrivacyScope ──────────────────────────────────────────

describe('validatePrivacyScope', () => {
  it('accepts a valid private scope with ownerId', () => {
    expect(validatePrivacyScope({ type: 'private', ownerId: 'user-123' })).toBeNull();
  });

  it('rejects private scope without ownerId', () => {
    const err = validatePrivacyScope({ type: 'private' });
    expect(err).toContain('ownerId');
  });

  it('accepts a valid shared-topic scope with topicId', () => {
    expect(validatePrivacyScope({ type: 'shared-topic', topicId: 42 })).toBeNull();
  });

  it('rejects shared-topic scope without topicId', () => {
    const err = validatePrivacyScope({ type: 'shared-topic' });
    expect(err).toContain('topicId');
  });

  it('accepts shared-project scope with no extras', () => {
    expect(validatePrivacyScope({ type: 'shared-project' })).toBeNull();
  });

  it('accepts shared-project scope with optional ownerId', () => {
    expect(validatePrivacyScope({ type: 'shared-project', ownerId: 'alice' })).toBeNull();
  });

  it('rejects invalid scope type', () => {
    const err = validatePrivacyScope({ type: 'public' as PrivacyScopeType });
    expect(err).toContain('Invalid scope type');
  });

  it('rejects empty string scope type', () => {
    const err = validatePrivacyScope({ type: '' as PrivacyScopeType });
    expect(err).toContain('Invalid scope type');
  });
});

// ── isValidScopeType ──────────────────────────────────────────────

describe('isValidScopeType', () => {
  it('returns true for private', () => {
    expect(isValidScopeType('private')).toBe(true);
  });

  it('returns true for shared-topic', () => {
    expect(isValidScopeType('shared-topic')).toBe(true);
  });

  it('returns true for shared-project', () => {
    expect(isValidScopeType('shared-project')).toBe(true);
  });

  it('returns false for unknown type', () => {
    expect(isValidScopeType('public')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidScopeType('')).toBe(false);
  });

  it('returns false for similar but wrong strings', () => {
    expect(isValidScopeType('Private')).toBe(false);
    expect(isValidScopeType('PRIVATE')).toBe(false);
    expect(isValidScopeType('shared')).toBe(false);
  });
});

// ── isVisibleToUser ───────────────────────────────────────────────

describe('isVisibleToUser', () => {
  // ── shared-project visibility ──

  describe('shared-project scope', () => {
    it('is visible to any user', () => {
      expect(isVisibleToUser('shared-project', null, 'alice')).toBe(true);
      expect(isVisibleToUser('shared-project', null, 'bob')).toBe(true);
    });

    it('is visible even when ownerId is set', () => {
      expect(isVisibleToUser('shared-project', 'alice', 'bob')).toBe(true);
    });
  });

  // ── null/undefined scope (legacy backward compat) ──

  describe('null/undefined scope (legacy data)', () => {
    it('treats null scope as shared-project', () => {
      expect(isVisibleToUser(null, null, 'alice')).toBe(true);
    });

    it('treats undefined scope as shared-project', () => {
      expect(isVisibleToUser(undefined, null, 'alice')).toBe(true);
    });

    it('is visible to any user regardless of ownerId', () => {
      expect(isVisibleToUser(null, 'bob', 'alice')).toBe(true);
    });
  });

  // ── private visibility ──

  describe('private scope', () => {
    it('is visible to the owner', () => {
      expect(isVisibleToUser('private', 'alice', 'alice')).toBe(true);
    });

    it('is NOT visible to a different user', () => {
      expect(isVisibleToUser('private', 'alice', 'bob')).toBe(false);
    });

    it('is NOT visible to any user when ownerId is a different string', () => {
      expect(isVisibleToUser('private', 'user-123', 'user-456')).toBe(false);
    });

    it('treats private with null ownerId as visible (legacy)', () => {
      expect(isVisibleToUser('private', null, 'alice')).toBe(true);
    });

    it('treats private with undefined ownerId as visible (legacy)', () => {
      expect(isVisibleToUser('private', undefined, 'alice')).toBe(true);
    });
  });

  // ── shared-topic visibility ──

  describe('shared-topic scope', () => {
    it('is visible to a user in the topic', () => {
      expect(isVisibleToUser('shared-topic', null, 'alice', [42, 99], 42)).toBe(true);
    });

    it('is NOT visible to a user NOT in the topic', () => {
      expect(isVisibleToUser('shared-topic', null, 'bob', [99, 100], 42)).toBe(false);
    });

    it('is NOT visible when user has no topics', () => {
      expect(isVisibleToUser('shared-topic', null, 'alice', undefined, 42)).toBe(false);
    });

    it('is NOT visible when user has empty topic list', () => {
      expect(isVisibleToUser('shared-topic', null, 'alice', [], 42)).toBe(false);
    });

    it('is visible when no dataTopicId constraint (null)', () => {
      expect(isVisibleToUser('shared-topic', null, 'alice', [42], undefined)).toBe(true);
    });

    it('handles topicId = 0 (General topic)', () => {
      expect(isVisibleToUser('shared-topic', null, 'alice', [0, 42], 0)).toBe(true);
    });
  });

  // ── unknown scope type ──

  describe('unknown scope type', () => {
    it('fails closed (not visible) for unknown scope', () => {
      expect(isVisibleToUser('public' as PrivacyScopeType, null, 'alice')).toBe(false);
    });
  });

  // ── Critical cross-user isolation tests ──

  describe('CRITICAL: cross-user isolation', () => {
    it("User B CANNOT see User A's private memories", () => {
      expect(isVisibleToUser('private', 'user-a', 'user-b')).toBe(false);
    });

    it("User A CAN see their own private memories", () => {
      expect(isVisibleToUser('private', 'user-a', 'user-a')).toBe(true);
    });

    it("Both users CAN see shared-project data", () => {
      expect(isVisibleToUser('shared-project', 'user-a', 'user-b')).toBe(true);
      expect(isVisibleToUser('shared-project', 'user-a', 'user-a')).toBe(true);
    });

    it("User B in different topic CANNOT see User A's topic-shared data", () => {
      expect(isVisibleToUser('shared-topic', 'user-a', 'user-b', [200], 100)).toBe(false);
    });

    it("User B in same topic CAN see topic-shared data", () => {
      expect(isVisibleToUser('shared-topic', 'user-a', 'user-b', [100], 100)).toBe(true);
    });
  });
});

// ── buildPrivacySqlFilter ─────────────────────────────────────────

describe('buildPrivacySqlFilter', () => {
  it('returns a clause with default column names', () => {
    const { clause, params } = buildPrivacySqlFilter('alice');
    expect(clause).toContain('owner_id');
    expect(clause).toContain('privacy_scope');
    expect(params).toContain('alice');
  });

  it('uses custom column names', () => {
    const { clause } = buildPrivacySqlFilter('alice', {
      ownerColumn: 'user_id',
      scopeColumn: 'scope',
    });
    expect(clause).toContain('user_id');
    expect(clause).toContain('scope');
    expect(clause).not.toContain('owner_id');
  });

  it('includes NULL scope (legacy data)', () => {
    const { clause } = buildPrivacySqlFilter('alice');
    expect(clause).toContain('IS NULL');
  });

  it('includes shared-project visibility', () => {
    const { clause } = buildPrivacySqlFilter('alice');
    expect(clause).toContain("'shared-project'");
  });

  it('includes private + owner check', () => {
    const { clause, params } = buildPrivacySqlFilter('alice');
    expect(clause).toContain("'private'");
    expect(params[0]).toBe('alice');
  });

  it('includes topic IDs when provided', () => {
    const { clause, params } = buildPrivacySqlFilter('alice', {
      userTopicIds: [42, 99],
    });
    expect(clause).toContain("'shared-topic'");
    expect(clause).toContain('topic_id IN');
    expect(params).toContain(42);
    expect(params).toContain(99);
  });

  it('omits topic clause when no topic IDs', () => {
    const { clause } = buildPrivacySqlFilter('alice');
    expect(clause).not.toContain('shared-topic');
  });

  it('generates valid SQL-like syntax (parenthesized OR)', () => {
    const { clause } = buildPrivacySqlFilter('alice', { userTopicIds: [42] });
    // Should be wrapped in parens
    expect(clause.startsWith('(')).toBe(true);
    expect(clause.endsWith(')')).toBe(true);
    // Should contain OR operators
    expect(clause).toContain(' OR ');
  });
});

// ── defaultScope ──────────────────────────────────────────────────

describe('defaultScope', () => {
  it('returns shared-project for agent-sourced data', () => {
    expect(defaultScope('agent:discovery')).toBe('shared-project');
  });

  it('returns shared-project for observations', () => {
    expect(defaultScope('observation')).toBe('shared-project');
  });

  it('returns shared-project for migration data', () => {
    expect(defaultScope('migration')).toBe('shared-project');
  });

  it('returns private for user-sourced data', () => {
    expect(defaultScope('user:alice')).toBe('private');
  });

  it('returns private for session-sourced data', () => {
    expect(defaultScope('session:abc-123')).toBe('private');
  });

  it('returns private for unknown sources', () => {
    expect(defaultScope('unknown')).toBe('private');
  });

  it('returns private for empty source', () => {
    expect(defaultScope('')).toBe('private');
  });
});

// ── Scope factory functions ───────────────────────────────────────

describe('scope factory functions', () => {
  describe('privateScope', () => {
    it('creates a private scope with ownerId', () => {
      const scope = privateScope('alice');
      expect(scope.type).toBe('private');
      expect(scope.ownerId).toBe('alice');
    });
  });

  describe('sharedTopicScope', () => {
    it('creates a shared-topic scope with topicId', () => {
      const scope = sharedTopicScope(42);
      expect(scope.type).toBe('shared-topic');
      expect(scope.topicId).toBe(42);
      expect(scope.ownerId).toBeUndefined();
    });

    it('creates a shared-topic scope with optional ownerId', () => {
      const scope = sharedTopicScope(42, 'alice');
      expect(scope.type).toBe('shared-topic');
      expect(scope.topicId).toBe(42);
      expect(scope.ownerId).toBe('alice');
    });
  });

  describe('sharedProjectScope', () => {
    it('creates a shared-project scope', () => {
      const scope = sharedProjectScope();
      expect(scope.type).toBe('shared-project');
      expect(scope.ownerId).toBeUndefined();
      expect(scope.topicId).toBeUndefined();
    });
  });
});

// ── Onboarding State Machine ──────────────────────────────────────

describe('isValidOnboardingTransition', () => {
  // ── Valid transitions ──

  it('allows unknown → pending', () => {
    expect(isValidOnboardingTransition('unknown', 'pending')).toBe(true);
  });

  it('allows unknown → authorized (admin pre-approve)', () => {
    expect(isValidOnboardingTransition('unknown', 'authorized')).toBe(true);
  });

  it('allows pending → consented', () => {
    expect(isValidOnboardingTransition('pending', 'consented')).toBe(true);
  });

  it('allows pending → rejected', () => {
    expect(isValidOnboardingTransition('pending', 'rejected')).toBe(true);
  });

  it('allows consented → authorized', () => {
    expect(isValidOnboardingTransition('consented', 'authorized')).toBe(true);
  });

  it('allows rejected → pending (retry)', () => {
    expect(isValidOnboardingTransition('rejected', 'pending')).toBe(true);
  });

  // ── Invalid transitions ──

  it('rejects unknown → consented (must go through pending)', () => {
    expect(isValidOnboardingTransition('unknown', 'consented')).toBe(false);
  });

  it('rejects unknown → rejected', () => {
    expect(isValidOnboardingTransition('unknown', 'rejected')).toBe(false);
  });

  it('rejects pending → authorized (must consent first)', () => {
    expect(isValidOnboardingTransition('pending', 'authorized')).toBe(false);
  });

  it('rejects authorized → anything (terminal state)', () => {
    expect(isValidOnboardingTransition('authorized', 'pending')).toBe(false);
    expect(isValidOnboardingTransition('authorized', 'unknown')).toBe(false);
    expect(isValidOnboardingTransition('authorized', 'consented')).toBe(false);
    expect(isValidOnboardingTransition('authorized', 'rejected')).toBe(false);
  });

  it('rejects consented → pending (cannot go back)', () => {
    expect(isValidOnboardingTransition('consented', 'pending')).toBe(false);
  });

  it('rejects rejected → authorized (must consent first)', () => {
    expect(isValidOnboardingTransition('rejected', 'authorized')).toBe(false);
  });

  it('rejects same → same transitions', () => {
    expect(isValidOnboardingTransition('pending', 'pending')).toBe(false);
    expect(isValidOnboardingTransition('authorized', 'authorized')).toBe(false);
  });

  // ── CRITICAL: Consent bypass prevention (Gap 13) ──

  describe('CRITICAL: consent bypass prevention', () => {
    it('cannot skip consent: unknown → authorized requires admin pre-approval only', () => {
      // This is valid only because admin pre-approves — it's a conscious bypass
      expect(isValidOnboardingTransition('unknown', 'authorized')).toBe(true);
    });

    it('cannot skip consent: pending → authorized is BLOCKED', () => {
      // This is THE consent bypass that Gap 13 prevents
      expect(isValidOnboardingTransition('pending', 'authorized')).toBe(false);
    });

    it('consent is REQUIRED: pending → consented → authorized', () => {
      expect(isValidOnboardingTransition('pending', 'consented')).toBe(true);
      expect(isValidOnboardingTransition('consented', 'authorized')).toBe(true);
    });
  });
});

describe('createOnboardingSession', () => {
  it('creates a session with pending state', () => {
    const session = createOnboardingSession(12345, 'Alice', 42);
    expect(session.telegramUserId).toBe(12345);
    expect(session.name).toBe('Alice');
    expect(session.state).toBe('pending');
    expect(session.topicId).toBe(42);
    expect(session.pendingMessageCount).toBe(0);
  });

  it('sets timestamps', () => {
    const before = new Date().toISOString();
    const session = createOnboardingSession(12345, 'Alice', 42);
    const after = new Date().toISOString();

    expect(session.startedAt >= before).toBe(true);
    expect(session.startedAt <= after).toBe(true);
    expect(session.updatedAt).toBe(session.startedAt);
  });

  it('handles telegramUserId = 0', () => {
    const session = createOnboardingSession(0, 'Zero', 1);
    expect(session.telegramUserId).toBe(0);
  });
});

describe('transitionOnboarding', () => {
  const baseSession: OnboardingSession = {
    telegramUserId: 12345,
    name: 'Alice',
    state: 'pending',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    topicId: 42,
    pendingMessageCount: 0,
  };

  it('transitions pending → consented', () => {
    const result = transitionOnboarding(baseSession, 'consented');
    expect(result).not.toBeNull();
    expect(result!.state).toBe('consented');
    expect(result!.updatedAt > baseSession.updatedAt).toBe(true);
  });

  it('transitions pending → rejected', () => {
    const result = transitionOnboarding(baseSession, 'rejected');
    expect(result).not.toBeNull();
    expect(result!.state).toBe('rejected');
  });

  it('returns null for invalid transition', () => {
    const result = transitionOnboarding(baseSession, 'authorized');
    expect(result).toBeNull();
  });

  it('preserves all other fields on valid transition', () => {
    const result = transitionOnboarding(baseSession, 'consented')!;
    expect(result.telegramUserId).toBe(baseSession.telegramUserId);
    expect(result.name).toBe(baseSession.name);
    expect(result.topicId).toBe(baseSession.topicId);
    expect(result.startedAt).toBe(baseSession.startedAt);
    expect(result.pendingMessageCount).toBe(baseSession.pendingMessageCount);
  });

  it('full lifecycle: pending → consented → authorized', () => {
    const step1 = transitionOnboarding(baseSession, 'consented');
    expect(step1).not.toBeNull();
    expect(step1!.state).toBe('consented');

    const step2 = transitionOnboarding(step1!, 'authorized');
    expect(step2).not.toBeNull();
    expect(step2!.state).toBe('authorized');
  });

  it('rejection and retry: pending → rejected → pending → consented', () => {
    const step1 = transitionOnboarding(baseSession, 'rejected');
    expect(step1).not.toBeNull();

    const step2 = transitionOnboarding(step1!, 'pending');
    expect(step2).not.toBeNull();
    expect(step2!.state).toBe('pending');

    const step3 = transitionOnboarding(step2!, 'consented');
    expect(step3).not.toBeNull();
    expect(step3!.state).toBe('consented');
  });
});

// ── Constants ─────────────────────────────────────────────────────

describe('constants', () => {
  it('MAX_PENDING_MESSAGES is a reasonable number', () => {
    expect(MAX_PENDING_MESSAGES).toBeGreaterThan(0);
    expect(MAX_PENDING_MESSAGES).toBeLessThanOrEqual(20);
  });

  it('ONBOARDING_TIMEOUT_MINUTES is a reasonable duration', () => {
    expect(ONBOARDING_TIMEOUT_MINUTES).toBeGreaterThan(5);
    expect(ONBOARDING_TIMEOUT_MINUTES).toBeLessThanOrEqual(120);
  });
});

// ── Type contract tests (compile-time + runtime) ──────────────────

describe('type contracts', () => {
  it('PrivacyScopeType has exactly 3 values', () => {
    const validTypes: PrivacyScopeType[] = ['private', 'shared-topic', 'shared-project'];
    expect(validTypes).toHaveLength(3);
    for (const t of validTypes) {
      expect(isValidScopeType(t)).toBe(true);
    }
  });

  it('OnboardingState has exactly 5 values', () => {
    const validStates: OnboardingState[] = ['unknown', 'pending', 'consented', 'rejected', 'authorized'];
    expect(validStates).toHaveLength(5);
  });

  it('PrivacyScope can be constructed for each type', () => {
    const scopes: PrivacyScope[] = [
      { type: 'private', ownerId: 'alice' },
      { type: 'shared-topic', topicId: 42 },
      { type: 'shared-project' },
    ];
    for (const scope of scopes) {
      expect(validatePrivacyScope(scope)).toBeNull();
    }
  });
});
