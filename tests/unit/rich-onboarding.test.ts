/**
 * Tests for Rich Onboarding Data Collection (Phase 3B).
 *
 * Covers:
 *   1. buildUserProfile with rich onboarding fields
 *   2. getOnboardingPrompts generation from config
 *   3. parseInterests utility
 *   4. applyOnboardingAnswers to existing profiles
 *   5. buildConsentDisclosure with custom text
 *   6. Backward compatibility — existing buildUserProfile calls unchanged
 *   7. Edge cases and validation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildUserProfile,
  buildConsentDisclosure,
  buildCondensedConsentDisclosure,
  getOnboardingPrompts,
  parseInterests,
  applyOnboardingAnswers,
  createConsentRecord,
} from '../../src/users/UserOnboarding.js';
import type { OnboardingConfig, UserProfile } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────

function makeMinimalConfig(): OnboardingConfig {
  return {};
}

function makeFullConfig(): OnboardingConfig {
  return {
    collectBio: true,
    collectInterests: true,
    collectTimezone: true,
    collectStyle: true,
    collectRelationshipContext: true,
    customQuestions: [
      { fieldName: 'company', prompt: 'What company?', required: false },
      { fieldName: 'role', prompt: 'Your role?', required: true, placeholder: 'e.g., Engineer' },
    ],
    consentDisclosure: 'Custom privacy text here.',
    maxContextTokens: 300,
  };
}

// ── 1. buildUserProfile with Rich Fields ────────────────────────

describe('buildUserProfile with rich fields', () => {
  it('minimal call (no rich fields) works as before', () => {
    const profile = buildUserProfile({ name: 'Alice' });

    expect(profile.name).toBe('Alice');
    expect(profile.id).toBe('alice');
    expect(profile.permissions).toEqual(['user']);
    expect(profile.bio).toBeUndefined();
    expect(profile.interests).toBeUndefined();
    expect(profile.relationshipContext).toBeUndefined();
    expect(profile.customFields).toBeUndefined();
  });

  it('includes bio when provided', () => {
    const profile = buildUserProfile({
      name: 'Alice',
      bio: 'ML researcher at Stanford',
    });

    expect(profile.bio).toBe('ML researcher at Stanford');
  });

  it('includes interests when provided', () => {
    const profile = buildUserProfile({
      name: 'Alice',
      interests: ['AI', 'ethics', 'philosophy'],
    });

    expect(profile.interests).toEqual(['AI', 'ethics', 'philosophy']);
  });

  it('includes timezone in preferences when provided', () => {
    const profile = buildUserProfile({
      name: 'Alice',
      timezone: 'America/New_York',
    });

    expect(profile.preferences.timezone).toBe('America/New_York');
  });

  it('includes relationshipContext when provided', () => {
    const profile = buildUserProfile({
      name: 'Alice',
      relationshipContext: 'Project lead, provides strategic direction',
    });

    expect(profile.relationshipContext).toBe('Project lead, provides strategic direction');
  });

  it('includes customFields when provided', () => {
    const profile = buildUserProfile({
      name: 'Alice',
      customFields: { company: 'Acme', department: 'R&D' },
    });

    expect(profile.customFields).toEqual({ company: 'Acme', department: 'R&D' });
  });

  it('all rich fields together', () => {
    const profile = buildUserProfile({
      name: 'Alice',
      telegramUserId: 12345,
      telegramTopicId: '42',
      style: 'technical and direct',
      autonomyLevel: 'full',
      consent: createConsentRecord('2.0'),
      bio: 'Researcher',
      interests: ['AI', 'robotics'],
      timezone: 'UTC',
      relationshipContext: 'Beta tester',
      customFields: { company: 'Acme' },
    });

    expect(profile.bio).toBe('Researcher');
    expect(profile.interests).toEqual(['AI', 'robotics']);
    expect(profile.preferences.timezone).toBe('UTC');
    expect(profile.preferences.style).toBe('technical and direct');
    expect(profile.relationshipContext).toBe('Beta tester');
    expect(profile.customFields).toEqual({ company: 'Acme' });
    expect(profile.telegramUserId).toBe(12345);
    expect(profile.consent!.consentGiven).toBe(true);
  });

  it('dataCollected reflects communication preferences when style/timezone set', () => {
    const profile = buildUserProfile({
      name: 'Alice',
      style: 'friendly',
      timezone: 'America/Chicago',
    });

    expect(profile.dataCollected!.communicationPreferences).toBe(true);
  });

  it('empty string bio is preserved (not treated as absent)', () => {
    const profile = buildUserProfile({ name: 'Alice', bio: '' });
    expect(profile.bio).toBe('');
  });

  it('empty interests array is preserved', () => {
    const profile = buildUserProfile({ name: 'Alice', interests: [] });
    expect(profile.interests).toEqual([]);
  });
});

// ── 2. getOnboardingPrompts ─────────────────────────────────────

describe('getOnboardingPrompts', () => {
  it('empty config produces no prompts', () => {
    const prompts = getOnboardingPrompts({});
    expect(prompts).toHaveLength(0);
  });

  it('full config produces all builtin + custom prompts', () => {
    const prompts = getOnboardingPrompts(makeFullConfig());

    // 5 builtin + 2 custom
    expect(prompts).toHaveLength(7);

    const builtins = prompts.filter(p => p.type === 'builtin');
    const customs = prompts.filter(p => p.type === 'custom');

    expect(builtins).toHaveLength(5);
    expect(customs).toHaveLength(2);
  });

  it('prompts are in order: bio, interests, timezone, style, relationship, then custom', () => {
    const prompts = getOnboardingPrompts(makeFullConfig());

    expect(prompts[0].fieldName).toBe('bio');
    expect(prompts[1].fieldName).toBe('interests');
    expect(prompts[2].fieldName).toBe('timezone');
    expect(prompts[3].fieldName).toBe('style');
    expect(prompts[4].fieldName).toBe('relationshipContext');
    expect(prompts[5].fieldName).toBe('company');
    expect(prompts[6].fieldName).toBe('role');
  });

  it('builtin prompts are not required by default', () => {
    const prompts = getOnboardingPrompts(makeFullConfig());
    const builtins = prompts.filter(p => p.type === 'builtin');
    expect(builtins.every(p => p.required === false)).toBe(true);
  });

  it('custom question required flag is preserved', () => {
    const prompts = getOnboardingPrompts(makeFullConfig());
    const customs = prompts.filter(p => p.type === 'custom');

    const company = customs.find(p => p.fieldName === 'company');
    const role = customs.find(p => p.fieldName === 'role');

    expect(company!.required).toBe(false);
    expect(role!.required).toBe(true);
  });

  it('selective config produces only enabled prompts', () => {
    const prompts = getOnboardingPrompts({
      collectBio: true,
      collectTimezone: true,
      // interests, style, relationship all false/undefined
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0].fieldName).toBe('bio');
    expect(prompts[1].fieldName).toBe('timezone');
  });

  it('custom questions only (no builtins)', () => {
    const prompts = getOnboardingPrompts({
      customQuestions: [
        { fieldName: 'team', prompt: 'Your team?' },
      ],
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0].type).toBe('custom');
    expect(prompts[0].fieldName).toBe('team');
  });

  it('custom question without required defaults to false', () => {
    const prompts = getOnboardingPrompts({
      customQuestions: [
        { fieldName: 'x', prompt: 'X?' },
      ],
    });

    expect(prompts[0].required).toBe(false);
  });
});

// ── 3. parseInterests ──────────────────────────────────────────

describe('parseInterests', () => {
  it('parses comma-separated string', () => {
    expect(parseInterests('AI, robotics, ethics')).toEqual(['AI', 'robotics', 'ethics']);
  });

  it('trims whitespace', () => {
    expect(parseInterests('  AI  ,  robotics  ')).toEqual(['AI', 'robotics']);
  });

  it('removes empty entries', () => {
    expect(parseInterests('AI,,robotics,')).toEqual(['AI', 'robotics']);
  });

  it('single item', () => {
    expect(parseInterests('AI')).toEqual(['AI']);
  });

  it('empty string returns empty array', () => {
    expect(parseInterests('')).toEqual([]);
  });

  it('only commas returns empty array', () => {
    expect(parseInterests(',,,')).toEqual([]);
  });

  it('preserves unicode', () => {
    expect(parseInterests('人工知能, ロボット')).toEqual(['人工知能', 'ロボット']);
  });
});

// ── 4. applyOnboardingAnswers ──────────────────────────────────

describe('applyOnboardingAnswers', () => {
  let baseProfile: UserProfile;

  beforeEach(() => {
    baseProfile = buildUserProfile({ name: 'Alice' });
  });

  it('applies bio answer', () => {
    const updated = applyOnboardingAnswers(
      baseProfile,
      { bio: 'ML researcher' },
      { collectBio: true },
    );
    expect(updated.bio).toBe('ML researcher');
  });

  it('applies interests answer (parsed from comma-separated)', () => {
    const updated = applyOnboardingAnswers(
      baseProfile,
      { interests: 'AI, robotics, ethics' },
      { collectInterests: true },
    );
    expect(updated.interests).toEqual(['AI', 'robotics', 'ethics']);
  });

  it('applies timezone answer', () => {
    const updated = applyOnboardingAnswers(
      baseProfile,
      { timezone: 'America/New_York' },
      { collectTimezone: true },
    );
    expect(updated.preferences.timezone).toBe('America/New_York');
  });

  it('applies style answer', () => {
    const updated = applyOnboardingAnswers(
      baseProfile,
      { style: 'technical and direct' },
      { collectStyle: true },
    );
    expect(updated.preferences.style).toBe('technical and direct');
  });

  it('applies relationshipContext answer', () => {
    const updated = applyOnboardingAnswers(
      baseProfile,
      { relationshipContext: 'Beta tester' },
      { collectRelationshipContext: true },
    );
    expect(updated.relationshipContext).toBe('Beta tester');
  });

  it('applies custom field answers', () => {
    const updated = applyOnboardingAnswers(
      baseProfile,
      { company: 'Acme', role: 'Engineer' },
      { customQuestions: [
        { fieldName: 'company', prompt: 'Company?' },
        { fieldName: 'role', prompt: 'Role?' },
      ] },
    );
    expect(updated.customFields).toEqual({ company: 'Acme', role: 'Engineer' });
  });

  it('CRITICAL: ignores custom fields not in config', () => {
    const updated = applyOnboardingAnswers(
      baseProfile,
      { company: 'Acme', ssn: '123-45-6789' },
      { customQuestions: [
        { fieldName: 'company', prompt: 'Company?' },
        // ssn is NOT configured — should be ignored
      ] },
    );
    expect(updated.customFields!.company).toBe('Acme');
    expect(updated.customFields!['ssn']).toBeUndefined();
  });

  it('ignores answers for disabled built-in fields', () => {
    const updated = applyOnboardingAnswers(
      baseProfile,
      { bio: 'Should be ignored' },
      { collectBio: false }, // Explicitly disabled
    );
    expect(updated.bio).toBeUndefined();
  });

  it('ignores answers for undefined built-in fields', () => {
    const updated = applyOnboardingAnswers(
      baseProfile,
      { bio: 'Should be ignored' },
      {}, // collectBio not set (treated as false)
    );
    expect(updated.bio).toBeUndefined();
  });

  it('does not mutate the original profile', () => {
    const original = buildUserProfile({ name: 'Alice' });
    const originalBio = original.bio;

    applyOnboardingAnswers(
      original,
      { bio: 'New bio' },
      { collectBio: true },
    );

    expect(original.bio).toBe(originalBio);
  });

  it('applies all fields at once', () => {
    const updated = applyOnboardingAnswers(
      baseProfile,
      {
        bio: 'Full profile',
        interests: 'AI, music',
        timezone: 'UTC',
        style: 'casual',
        relationshipContext: 'Contributor',
        department: 'Engineering',
      },
      makeFullConfig(),
    );

    expect(updated.bio).toBe('Full profile');
    expect(updated.interests).toEqual(['AI', 'music']);
    expect(updated.preferences.timezone).toBe('UTC');
    expect(updated.preferences.style).toBe('casual');
    expect(updated.relationshipContext).toBe('Contributor');
    // 'department' is not in customQuestions — it's ignored entirely
    // customFields may be undefined if no configured questions matched
    expect(updated.customFields?.['department']).toBeUndefined();
  });

  it('preserves existing profile data not touched by answers', () => {
    const profile = buildUserProfile({
      name: 'Alice',
      telegramUserId: 12345,
      consent: createConsentRecord('2.0'),
    });

    const updated = applyOnboardingAnswers(
      profile,
      { bio: 'New bio' },
      { collectBio: true },
    );

    expect(updated.name).toBe('Alice');
    expect(updated.telegramUserId).toBe(12345);
    expect(updated.consent!.consentGiven).toBe(true);
    expect(updated.bio).toBe('New bio');
  });

  it('merges custom fields with existing ones', () => {
    const profile = buildUserProfile({
      name: 'Alice',
      customFields: { existing: 'value' },
    });

    const updated = applyOnboardingAnswers(
      profile,
      { newField: 'new value' },
      { customQuestions: [
        { fieldName: 'newField', prompt: 'New?' },
      ] },
    );

    expect(updated.customFields!.existing).toBe('value');
    expect(updated.customFields!.newField).toBe('new value');
  });
});

// ── 5. buildConsentDisclosure with Custom Text ──────────────────

describe('buildConsentDisclosure', () => {
  it('default disclosure when no config provided', () => {
    const text = buildConsentDisclosure('TestAgent');
    expect(text).toContain('TestAgent');
    expect(text).toContain('stores about you');
    expect(text).toContain('name and communication preferences');
  });

  it('default disclosure when config has no custom text', () => {
    const text = buildConsentDisclosure('TestAgent', {});
    expect(text).toContain('TestAgent');
    expect(text).toContain('stores about you');
  });

  it('custom disclosure replaces default', () => {
    const text = buildConsentDisclosure('TestAgent', {
      consentDisclosure: 'Custom privacy policy for our service.',
    });
    expect(text).toBe('Custom privacy policy for our service.');
    expect(text).not.toContain('stores about you');
  });

  it('condensed disclosure is unchanged', () => {
    const text = buildCondensedConsentDisclosure('TestAgent');
    expect(text).toContain('TestAgent');
    expect(text).toContain('conversation history');
    expect(text).toContain('Reply "OK"');
  });
});

// ── 6. Backward Compatibility ──────────────────────────────────

describe('backward compatibility', () => {
  it('existing minimal buildUserProfile call works unchanged', () => {
    const profile = buildUserProfile({
      name: 'Bob',
      telegramTopicId: '99',
      telegramUserId: 54321,
      permissions: ['admin', 'user'],
      style: 'formal',
      autonomyLevel: 'full',
    });

    expect(profile.id).toBe('bob');
    expect(profile.name).toBe('Bob');
    expect(profile.channels).toEqual([{ type: 'telegram', identifier: '99' }]);
    expect(profile.permissions).toEqual(['admin', 'user']);
    expect(profile.preferences.style).toBe('formal');
    expect(profile.preferences.autonomyLevel).toBe('full');
    expect(profile.telegramUserId).toBe(54321);
    // New fields should not be present
    expect(profile.bio).toBeUndefined();
    expect(profile.interests).toBeUndefined();
    expect(profile.customFields).toBeUndefined();
  });

  it('buildConsentDisclosure without config matches old signature', () => {
    const text1 = buildConsentDisclosure('Agent');
    const text2 = buildConsentDisclosure('Agent', undefined);
    expect(text1).toBe(text2);
  });
});

// ── 7. Edge Cases ──────────────────────────────────────────────

describe('edge cases', () => {
  it('empty answers object changes nothing', () => {
    const profile = buildUserProfile({ name: 'Alice' });
    const updated = applyOnboardingAnswers(profile, {}, makeFullConfig());

    expect(updated.bio).toBeUndefined();
    expect(updated.interests).toBeUndefined();
  });

  it('very long bio is accepted', () => {
    const longBio = 'A'.repeat(10000);
    const profile = buildUserProfile({ name: 'Alice', bio: longBio });
    expect(profile.bio!.length).toBe(10000);
  });

  it('interests with special characters', () => {
    const interests = parseInterests('C++, C#, .NET, Node.js');
    expect(interests).toEqual(['C++', 'C#', '.NET', 'Node.js']);
  });

  it('timezone validation is not enforced (consumer responsibility)', () => {
    // The onboarding collects what the user provides — validation
    // is the consumer's job (e.g., scheduling system)
    const profile = buildUserProfile({
      name: 'Alice',
      timezone: 'invalid/timezone',
    });
    expect(profile.preferences.timezone).toBe('invalid/timezone');
  });

  it('custom questions with duplicate fieldNames — last answer wins', () => {
    const profile = buildUserProfile({ name: 'Alice' });
    const updated = applyOnboardingAnswers(
      profile,
      { field: 'second value' },
      { customQuestions: [
        { fieldName: 'field', prompt: 'First?' },
        { fieldName: 'field', prompt: 'Second?' },
      ] },
    );
    expect(updated.customFields!.field).toBe('second value');
  });
});
