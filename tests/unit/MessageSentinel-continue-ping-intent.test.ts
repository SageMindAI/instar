/**
 * Tests for the three-way continue-ping intent classifier (PR0b —
 * context-death-pitfall-prevention spec § P0.4).
 *
 * Covers the standalone `classifyContinuePingIntent()` function and its
 * integration into `MessageSentinel.classify()` (the `continuePingIntent`
 * field on every classification result).
 */

import { describe, it, expect } from 'vitest';
import {
  MessageSentinel,
  classifyContinuePingIntent,
} from '../../src/core/MessageSentinel.js';

describe('classifyContinuePingIntent — non-continue-ping shapes return null', () => {
  it.each([
    'hello',
    'how is the weather today',
    'please fix the bug in the login flow',
    'I think we should refactor this',
    'STOP',
    '/pause',
    '',
    '   ',
  ])('returns null for %j', (input) => {
    expect(classifyContinuePingIntent(input)).toBeNull();
  });

  it('returns null for messages over the 50-word ceiling even with continue token', () => {
    const long = ('continue ' + 'word '.repeat(60)).trim();
    expect(classifyContinuePingIntent(long)).toBeNull();
  });
});

describe('classifyContinuePingIntent — intent_a (pure resume)', () => {
  it.each([
    'continue',
    'please continue',
    'go ahead',
    'yes go ahead',
    'yes',
    'yes please',
    'yep continue',
    'yeah keep going',
    'ok continue',
    'okay proceed',
    'do it',
    'keep going',
    'carry on',
    'continue please',
    'resume',
    'proceed',
    'yes proceed with the deployment',
  ])('classifies %j as intent_a', (input) => {
    expect(classifyContinuePingIntent(input)).toBe('intent_a');
  });
});

describe('classifyContinuePingIntent — intent_b (additive, new requirement)', () => {
  it.each([
    'yes continue and also add the CI checks',
    'go ahead but also fix the typo',
    'continue, additionally please tighten the validation',
    'proceed and now also restart the worker',
    'keep going and don\'t forget to update the docs',
    'yes continue, while you\'re at it bump the version',
    'go ahead — on top of that bump version too',
  ])('classifies additive %j as intent_b', (input) => {
    expect(classifyContinuePingIntent(input)).toBe('intent_b');
  });
});

describe('classifyContinuePingIntent — intent_c (verify / clarify)', () => {
  it.each([
    'yes continue, but why did you choose option X?',
    'go ahead, can you explain the trade-off?',
    'continue but how does this interact with the gate?',
    'proceed — what is the rollback plan?',
    'keep going. did you handle the timeout case?',
    'yes — please clarify the side-effects review',
    'continue but verify the migration script first',
    'go ahead, double-check the diff',
    'yes proceed, can you confirm the version was bumped?',
  ])('classifies question/clarify %j as intent_c', (input) => {
    expect(classifyContinuePingIntent(input)).toBe('intent_c');
  });
});

describe('classifyContinuePingIntent — priority: question (c) wins over additive (b)', () => {
  it('classifies "continue and also bump version, but why?" as intent_c', () => {
    // Both additive ("and also") AND question ("?") signals present.
    // Spec says question wins — operator is fundamentally seeking info.
    expect(
      classifyContinuePingIntent('continue and also bump the version, but why?')
    ).toBe('intent_c');
  });

  it('classifies "go ahead and also restart, can you explain?" as intent_c', () => {
    expect(
      classifyContinuePingIntent('go ahead and also restart, can you explain?')
    ).toBe('intent_c');
  });
});

describe('MessageSentinel.classify — continuePingIntent field on results', () => {
  it('attaches intent_a on a pure continue ping (passthrough)', async () => {
    const sentinel = new MessageSentinel();
    const result = await sentinel.classify('continue');
    expect(result.category).toBe('normal');
    expect(result.continuePingIntent).toBe('intent_a');
  });

  it('attaches intent_b on an additive continue ping', async () => {
    const sentinel = new MessageSentinel();
    const result = await sentinel.classify('yes continue and also add CI checks');
    expect(result.continuePingIntent).toBe('intent_b');
  });

  it('attaches intent_c on a clarifying continue ping', async () => {
    const sentinel = new MessageSentinel();
    const result = await sentinel.classify('yes go ahead, but why did you do that?');
    expect(result.continuePingIntent).toBe('intent_c');
  });

  it('attaches null on non-continue-ping messages', async () => {
    const sentinel = new MessageSentinel();
    const result = await sentinel.classify('hello there');
    expect(result.continuePingIntent).toBeNull();
  });

  it('still attaches continuePingIntent when fast-path emergency-stop fires', async () => {
    // Exotic case — a slash-stop message that also happens to contain a
    // continue token shouldn't blow up. Slash-stop wins for category;
    // intent classifier independently runs and returns null because no
    // continue-shape matches the slash command alone.
    const sentinel = new MessageSentinel();
    const result = await sentinel.classify('/stop');
    expect(result.category).toBe('emergency-stop');
    expect(result.continuePingIntent).toBeNull();
  });

  it('attaches null when sentinel is disabled', async () => {
    const sentinel = new MessageSentinel({ enabled: false });
    const result = await sentinel.classify('continue');
    expect(result.continuePingIntent).toBeNull();
  });
});
