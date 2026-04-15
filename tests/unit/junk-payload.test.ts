import { describe, it, expect } from 'vitest';
import { isJunkPayload } from '../../src/core/junk-payload.js';

describe('isJunkPayload', () => {
  describe('debug tokens', () => {
    it.each([
      'test', 'TEST', 'Test', 'testing', 'Testing',
      'asdf', 'asdfasdf', 'qwerty',
      'foo', 'foobar', 'bar', 'baz',
      'ping', 'pong', 'debug',
      'hi', 'hello', 'hey', 'yo',
      'abc', '123', 'xxx', 'zzz',
    ])('flags "%s" as junk', (word) => {
      expect(isJunkPayload(word).junk).toBe(true);
    });

    it('flags "test" with trailing punctuation', () => {
      expect(isJunkPayload('test!').junk).toBe(true);
      expect(isJunkPayload('test?').junk).toBe(true);
      expect(isJunkPayload('test.').junk).toBe(true);
    });
  });

  describe('empty/whitespace', () => {
    it('flags empty string', () => {
      expect(isJunkPayload('').junk).toBe(true);
    });

    it('flags whitespace-only string', () => {
      expect(isJunkPayload('   \n\t').junk).toBe(true);
    });
  });

  describe('legitimate short messages', () => {
    it('allows multi-word short messages', () => {
      expect(isJunkPayload('On it.').junk).toBe(false);
      expect(isJunkPayload('Got it, looking now.').junk).toBe(false);
    });

    it('allows legitimate single words that are not debug tokens', () => {
      expect(isJunkPayload('Done').junk).toBe(false);
      expect(isJunkPayload('Yes').junk).toBe(false);
      expect(isJunkPayload('Shipping').junk).toBe(false);
    });

    it('allows a long single-word message (16+ chars)', () => {
      expect(isJunkPayload('ThisIsSomeLongerUnusualWord').junk).toBe(false);
    });

    it('allows emoji reactions', () => {
      expect(isJunkPayload('👍').junk).toBe(false);
      expect(isJunkPayload('🎉').junk).toBe(false);
    });
  });

  describe('reproduction', () => {
    it('flags the bare "test" message that leaked in the 04:44 incident', () => {
      // Exact text that leaked to the user on 2026-04-15.
      expect(isJunkPayload('test').junk).toBe(true);
    });
  });
});
