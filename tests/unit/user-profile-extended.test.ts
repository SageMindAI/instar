/**
 * Tests for Extended UserProfile Fields (Phase 3A).
 *
 * Validates:
 *   1. New fields are optional and backward compatible
 *   2. UserProfile serialization/deserialization with new fields
 *   3. OnboardingConfig type contracts
 *   4. OnboardingQuestion validation
 *   5. UserContextBlock construction
 *   6. UserManager handles extended profiles correctly
 *   7. Existing user flows work unchanged with new fields absent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  UserProfile,
  UserPreferences,
  OnboardingConfig,
  OnboardingQuestion,
  UserContextBlock,
  DataCollectedManifest,
  ConsentRecord,
} from '../../src/core/types.js';
import { UserManager } from '../../src/users/UserManager.js';

// ── Helpers ─────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-profile-ext-'));
});

afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(testDir, { recursive: true, force: true });
});

function makeMinimalProfile(id: string, overrides?: Partial<UserProfile>): UserProfile {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    channels: [],
    permissions: ['user'],
    preferences: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRichProfile(id: string): UserProfile {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    channels: [{ type: 'telegram', identifier: '42' }],
    permissions: ['user'],
    preferences: {
      style: 'technical and direct',
      autonomyLevel: 'confirm-destructive',
      timezone: 'America/New_York',
    },
    bio: 'Software engineer interested in AI safety',
    interests: ['AI safety', 'distributed systems', 'functional programming'],
    relationshipContext: 'Beta tester since day one, provides detailed bug reports',
    customFields: {
      company: 'Acme Corp',
      role: 'Senior Engineer',
    },
    consent: {
      consentGiven: true,
      consentDate: new Date().toISOString(),
      consentNoticeVersion: '2.0',
    },
    dataCollected: {
      name: true,
      telegramId: true,
      communicationPreferences: true,
      conversationHistory: true,
      memoryEntries: true,
      machineIdentities: false,
    },
    createdAt: new Date().toISOString(),
    telegramUserId: 12345,
  };
}

// ── 1. Backward Compatibility ──────────────────────────────────

describe('backward compatibility', () => {
  it('minimal profile (no new fields) is valid', () => {
    const profile = makeMinimalProfile('alice');
    expect(profile.id).toBe('alice');
    expect(profile.bio).toBeUndefined();
    expect(profile.interests).toBeUndefined();
    expect(profile.relationshipContext).toBeUndefined();
    expect(profile.customFields).toBeUndefined();
  });

  it('existing profiles without new fields work with UserManager', () => {
    const manager = new UserManager(testDir, [makeMinimalProfile('alice')]);

    const user = manager.getUser('alice');
    expect(user).toBeDefined();
    expect(user!.id).toBe('alice');
    expect(user!.bio).toBeUndefined();
  });

  it('UserManager persists and loads profiles without new fields', () => {
    const profile = makeMinimalProfile('alice');
    const manager1 = new UserManager(testDir, [profile]);
    manager1.upsertUser(profile);

    // Load from disk
    const manager2 = new UserManager(testDir, []);
    const loaded = manager2.getUser('alice');
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('alice');
    expect(loaded!.bio).toBeUndefined();
  });
});

// ── 2. New Fields Serialization ─────────────────────────────────

describe('new fields serialization', () => {
  it('bio field persists through UserManager', () => {
    const profile = makeMinimalProfile('alice', { bio: 'ML researcher' });
    const manager = new UserManager(testDir, [profile]);
    manager.upsertUser(profile);

    const manager2 = new UserManager(testDir, []);
    const loaded = manager2.getUser('alice');
    expect(loaded!.bio).toBe('ML researcher');
  });

  it('interests array persists through UserManager', () => {
    const profile = makeMinimalProfile('alice', {
      interests: ['AI', 'music', 'climbing'],
    });
    const manager = new UserManager(testDir, [profile]);
    manager.upsertUser(profile);

    const manager2 = new UserManager(testDir, []);
    const loaded = manager2.getUser('alice');
    expect(loaded!.interests).toEqual(['AI', 'music', 'climbing']);
  });

  it('relationshipContext persists through UserManager', () => {
    const profile = makeMinimalProfile('alice', {
      relationshipContext: 'Project lead and primary stakeholder',
    });
    const manager = new UserManager(testDir, [profile]);
    manager.upsertUser(profile);

    const manager2 = new UserManager(testDir, []);
    const loaded = manager2.getUser('alice');
    expect(loaded!.relationshipContext).toBe('Project lead and primary stakeholder');
  });

  it('customFields record persists through UserManager', () => {
    const profile = makeMinimalProfile('alice', {
      customFields: {
        department: 'Engineering',
        experience: '5 years',
      },
    });
    const manager = new UserManager(testDir, [profile]);
    manager.upsertUser(profile);

    const manager2 = new UserManager(testDir, []);
    const loaded = manager2.getUser('alice');
    expect(loaded!.customFields).toEqual({
      department: 'Engineering',
      experience: '5 years',
    });
  });

  it('all new fields persist together', () => {
    const profile = makeRichProfile('alice');
    const manager = new UserManager(testDir, [profile]);
    manager.upsertUser(profile);

    const manager2 = new UserManager(testDir, []);
    const loaded = manager2.getUser('alice');
    expect(loaded!.bio).toBe('Software engineer interested in AI safety');
    expect(loaded!.interests).toEqual(['AI safety', 'distributed systems', 'functional programming']);
    expect(loaded!.relationshipContext).toBe('Beta tester since day one, provides detailed bug reports');
    expect(loaded!.customFields).toEqual({ company: 'Acme Corp', role: 'Senior Engineer' });
  });
});

// ── 3. OnboardingConfig Type Contracts ─────────────────────────

describe('OnboardingConfig type contracts', () => {
  it('empty config is valid (all fields optional)', () => {
    const config: OnboardingConfig = {};
    expect(config.collectBio).toBeUndefined();
    expect(config.collectInterests).toBeUndefined();
    expect(config.collectTimezone).toBeUndefined();
    expect(config.collectStyle).toBeUndefined();
    expect(config.collectRelationshipContext).toBeUndefined();
    expect(config.customQuestions).toBeUndefined();
    expect(config.consentDisclosure).toBeUndefined();
    expect(config.maxContextTokens).toBeUndefined();
  });

  it('full config with all fields', () => {
    const config: OnboardingConfig = {
      collectBio: true,
      collectInterests: true,
      collectTimezone: true,
      collectStyle: true,
      collectRelationshipContext: true,
      customQuestions: [
        { fieldName: 'company', prompt: 'What company do you work for?', required: false },
        { fieldName: 'role', prompt: 'What is your role?', required: true, placeholder: 'e.g., Engineer' },
      ],
      consentDisclosure: 'Custom privacy notice...',
      maxContextTokens: 300,
    };

    expect(config.collectBio).toBe(true);
    expect(config.customQuestions).toHaveLength(2);
    expect(config.customQuestions![0].fieldName).toBe('company');
    expect(config.customQuestions![1].required).toBe(true);
    expect(config.maxContextTokens).toBe(300);
  });

  it('config defaults are reasonable when absent', () => {
    const config: OnboardingConfig = {};
    // All boolean defaults to undefined (treated as false)
    // maxContextTokens defaults to undefined (treated as 500 by consumer)
    expect(config.collectBio ?? false).toBe(false);
    expect(config.maxContextTokens ?? 500).toBe(500);
  });
});

// ── 4. OnboardingQuestion Validation ────────────────────────────

describe('OnboardingQuestion validation', () => {
  it('minimal question has fieldName and prompt', () => {
    const q: OnboardingQuestion = {
      fieldName: 'department',
      prompt: 'What department are you in?',
    };
    expect(q.fieldName).toBe('department');
    expect(q.prompt).toBe('What department are you in?');
    expect(q.required).toBeUndefined();
    expect(q.placeholder).toBeUndefined();
  });

  it('full question with all fields', () => {
    const q: OnboardingQuestion = {
      fieldName: 'expertise',
      prompt: 'What is your area of expertise?',
      required: true,
      placeholder: 'e.g., Machine Learning, Backend, DevOps',
    };
    expect(q.required).toBe(true);
    expect(q.placeholder).toContain('Machine Learning');
  });

  it('fieldName can be used as customFields key', () => {
    const questions: OnboardingQuestion[] = [
      { fieldName: 'team', prompt: 'Team?' },
      { fieldName: 'location', prompt: 'Location?' },
    ];

    const customFields: Record<string, string> = {};
    for (const q of questions) {
      customFields[q.fieldName] = 'test value';
    }

    expect(Object.keys(customFields)).toEqual(['team', 'location']);
  });
});

// ── 5. UserContextBlock Construction ────────────────────────────

describe('UserContextBlock construction', () => {
  it('minimal block from minimal profile', () => {
    const profile = makeMinimalProfile('alice');
    const block: UserContextBlock = {
      name: profile.name,
      userId: profile.id,
      permissions: profile.permissions,
    };

    expect(block.name).toBe('Alice');
    expect(block.userId).toBe('alice');
    expect(block.permissions).toEqual(['user']);
    expect(block.bio).toBeUndefined();
    expect(block.interests).toBeUndefined();
  });

  it('full block from rich profile', () => {
    const profile = makeRichProfile('alice');
    const block: UserContextBlock = {
      name: profile.name,
      userId: profile.id,
      permissions: profile.permissions,
      preferences: {
        style: profile.preferences.style,
        autonomyLevel: profile.preferences.autonomyLevel,
        timezone: profile.preferences.timezone,
      },
      bio: profile.bio,
      interests: profile.interests,
      relationshipContext: profile.relationshipContext,
      context: profile.context,
      customFields: profile.customFields,
    };

    expect(block.name).toBe('Alice');
    expect(block.permissions).toEqual(['user']);
    expect(block.preferences?.style).toBe('technical and direct');
    expect(block.preferences?.timezone).toBe('America/New_York');
    expect(block.bio).toBe('Software engineer interested in AI safety');
    expect(block.interests).toContain('AI safety');
    expect(block.relationshipContext).toContain('Beta tester');
    expect(block.customFields?.company).toBe('Acme Corp');
  });

  it('admin permissions are preserved in block', () => {
    const profile = makeMinimalProfile('admin', { permissions: ['admin', 'user'] });
    const block: UserContextBlock = {
      name: profile.name,
      userId: profile.id,
      permissions: profile.permissions,
    };

    expect(block.permissions).toContain('admin');
    expect(block.permissions).toContain('user');
  });

  it('block serializes to JSON cleanly', () => {
    const profile = makeRichProfile('alice');
    const block: UserContextBlock = {
      name: profile.name,
      userId: profile.id,
      permissions: profile.permissions,
      bio: profile.bio,
      interests: profile.interests,
    };

    const json = JSON.stringify(block);
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe('Alice');
    expect(parsed.permissions).toEqual(['user']);
    expect(parsed.bio).toBe('Software engineer interested in AI safety');
  });
});

// ── 6. UserManager with Extended Profiles ───────────────────────

describe('UserManager with extended profiles', () => {
  it('upsert preserves all new fields', () => {
    const manager = new UserManager(testDir, []);
    const profile = makeRichProfile('alice');

    manager.upsertUser(profile);
    const loaded = manager.getUser('alice');

    expect(loaded!.bio).toBe(profile.bio);
    expect(loaded!.interests).toEqual(profile.interests);
    expect(loaded!.relationshipContext).toBe(profile.relationshipContext);
    expect(loaded!.customFields).toEqual(profile.customFields);
  });

  it('upsert updates new fields without losing existing data', () => {
    const manager = new UserManager(testDir, []);

    // Create with bio only
    manager.upsertUser(makeMinimalProfile('alice', { bio: 'Original bio' }));
    expect(manager.getUser('alice')!.bio).toBe('Original bio');

    // Update with interests added
    manager.upsertUser(makeMinimalProfile('alice', {
      bio: 'Updated bio',
      interests: ['new interest'],
    }));

    const updated = manager.getUser('alice');
    expect(updated!.bio).toBe('Updated bio');
    expect(updated!.interests).toEqual(['new interest']);
  });

  it('mixed old and new profiles coexist', () => {
    const manager = new UserManager(testDir, []);

    // Old-style minimal profile
    manager.upsertUser(makeMinimalProfile('bob'));

    // New-style rich profile
    manager.upsertUser(makeRichProfile('alice'));

    const bob = manager.getUser('bob');
    const alice = manager.getUser('alice');

    expect(bob!.bio).toBeUndefined();
    expect(alice!.bio).toBeDefined();
    expect(alice!.interests).toBeDefined();

    // Both are listed
    const all = manager.listUsers();
    expect(all).toHaveLength(2);
  });

  it('listUsers returns profiles with new fields intact', () => {
    const manager = new UserManager(testDir, []);
    manager.upsertUser(makeRichProfile('alice'));
    // Bob gets a different channel to avoid collision with Alice's telegram:42
    const bobProfile = makeRichProfile('bob');
    bobProfile.channels = [{ type: 'telegram', identifier: '99' }];
    manager.upsertUser(bobProfile);

    const all = manager.listUsers();
    expect(all.every(u => u.bio !== undefined)).toBe(true);
    expect(all.every(u => u.interests !== undefined)).toBe(true);
  });
});

// ── 7. Edge Cases ──────────────────────────────────────────────

describe('edge cases', () => {
  it('empty strings for new fields', () => {
    const profile = makeMinimalProfile('alice', {
      bio: '',
      relationshipContext: '',
    });

    const manager = new UserManager(testDir, []);
    manager.upsertUser(profile);

    const loaded = manager.getUser('alice');
    expect(loaded!.bio).toBe('');
    expect(loaded!.relationshipContext).toBe('');
  });

  it('empty interests array', () => {
    const profile = makeMinimalProfile('alice', { interests: [] });

    const manager = new UserManager(testDir, []);
    manager.upsertUser(profile);

    const loaded = manager.getUser('alice');
    expect(loaded!.interests).toEqual([]);
  });

  it('empty customFields object', () => {
    const profile = makeMinimalProfile('alice', { customFields: {} });

    const manager = new UserManager(testDir, []);
    manager.upsertUser(profile);

    const loaded = manager.getUser('alice');
    expect(loaded!.customFields).toEqual({});
  });

  it('very long bio is preserved', () => {
    const longBio = 'A'.repeat(5000);
    const profile = makeMinimalProfile('alice', { bio: longBio });

    const manager = new UserManager(testDir, []);
    manager.upsertUser(profile);

    const loaded = manager.getUser('alice');
    expect(loaded!.bio).toBe(longBio);
    expect(loaded!.bio!.length).toBe(5000);
  });

  it('unicode in new fields', () => {
    const profile = makeMinimalProfile('alice', {
      bio: '日本語のプロフィール 🎉',
      interests: ['人工知能', 'ロボット工学'],
      relationshipContext: 'Ünïcödé tëster',
    });

    const manager = new UserManager(testDir, []);
    manager.upsertUser(profile);

    const loaded = manager.getUser('alice');
    expect(loaded!.bio).toBe('日本語のプロフィール 🎉');
    expect(loaded!.interests).toEqual(['人工知能', 'ロボット工学']);
  });

  it('special characters in customField keys', () => {
    const profile = makeMinimalProfile('alice', {
      customFields: {
        'field-with-dash': 'value1',
        'field_with_underscore': 'value2',
        'field.with.dots': 'value3',
      },
    });

    const manager = new UserManager(testDir, []);
    manager.upsertUser(profile);

    const loaded = manager.getUser('alice');
    expect(loaded!.customFields!['field-with-dash']).toBe('value1');
    expect(loaded!.customFields!['field_with_underscore']).toBe('value2');
    expect(loaded!.customFields!['field.with.dots']).toBe('value3');
  });

  it('profile removal then re-add with new fields works', () => {
    const manager = new UserManager(testDir, []);

    // Add and remove
    manager.upsertUser(makeMinimalProfile('alice', { bio: 'first' }));
    manager.removeUser('alice');
    expect(manager.getUser('alice')).toBeNull();

    // Re-add with different data
    manager.upsertUser(makeMinimalProfile('alice', { bio: 'second' }));
    expect(manager.getUser('alice')!.bio).toBe('second');
  });
});
