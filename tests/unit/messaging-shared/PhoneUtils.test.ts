import { describe, it, expect } from 'vitest';
import {
  normalizePhoneNumber,
  phoneToJid,
  jidToPhone,
  isJid,
  isGroupJid,
} from '../../../src/messaging/shared/PhoneUtils.js';

describe('PhoneUtils', () => {
  // ── normalizePhoneNumber ──────────────────────────────

  describe('normalizePhoneNumber', () => {
    it('passes through valid E.164 numbers', () => {
      expect(normalizePhoneNumber('+14155552671')).toBe('+14155552671');
      expect(normalizePhoneNumber('+447911123456')).toBe('+447911123456');
      expect(normalizePhoneNumber('+5511999998888')).toBe('+5511999998888');
    });

    it('strips whitespace and formatting characters', () => {
      expect(normalizePhoneNumber('+1 (415) 555-2671')).toBe('+14155552671');
      expect(normalizePhoneNumber('+44 7911 123456')).toBe('+447911123456');
      expect(normalizePhoneNumber('+1-415-555-2671')).toBe('+14155552671');
      expect(normalizePhoneNumber('+1.415.555.2671')).toBe('+14155552671');
    });

    it('handles 10-digit US numbers (adds +1)', () => {
      expect(normalizePhoneNumber('4155552671')).toBe('+14155552671');
      expect(normalizePhoneNumber('2125551234')).toBe('+12125551234');
    });

    it('handles numbers without + prefix', () => {
      expect(normalizePhoneNumber('14155552671')).toBe('+14155552671');
      expect(normalizePhoneNumber('447911123456')).toBe('+447911123456');
    });

    it('strips international dialing prefix (00)', () => {
      expect(normalizePhoneNumber('004415552671234')).toBe('+4415552671234');
    });

    it('strips US international prefix (011)', () => {
      expect(normalizePhoneNumber('01144791112345')).toBe('+44791112345');
    });

    it('extracts number from WhatsApp JID', () => {
      expect(normalizePhoneNumber('5511999998888@s.whatsapp.net')).toBe('+5511999998888');
      expect(normalizePhoneNumber('14155552671@s.whatsapp.net')).toBe('+14155552671');
    });

    it('throws on empty input', () => {
      expect(() => normalizePhoneNumber('')).toThrow('Phone number is required');
      expect(() => normalizePhoneNumber(null as any)).toThrow('Phone number is required');
      expect(() => normalizePhoneNumber(undefined as any)).toThrow('Phone number is required');
    });

    it('throws on invalid format', () => {
      expect(() => normalizePhoneNumber('abc')).toThrow('Invalid phone number format');
      expect(() => normalizePhoneNumber('+1')).toThrow('Invalid phone number format');
      expect(() => normalizePhoneNumber('12345')).toThrow('Invalid phone number format');
    });
  });

  // ── phoneToJid ──────────────────────────────────────

  describe('phoneToJid', () => {
    it('converts E.164 to JID', () => {
      expect(phoneToJid('+14155552671')).toBe('14155552671@s.whatsapp.net');
      expect(phoneToJid('+5511999998888')).toBe('5511999998888@s.whatsapp.net');
    });

    it('normalizes before converting', () => {
      expect(phoneToJid('(415) 555-2671')).toBe('14155552671@s.whatsapp.net');
      expect(phoneToJid('+44 7911 123456')).toBe('447911123456@s.whatsapp.net');
    });
  });

  // ── jidToPhone ──────────────────────────────────────

  describe('jidToPhone', () => {
    it('extracts phone from JID', () => {
      expect(jidToPhone('14155552671@s.whatsapp.net')).toBe('+14155552671');
      expect(jidToPhone('5511999998888@s.whatsapp.net')).toBe('+5511999998888');
    });

    it('handles group JIDs', () => {
      // Group JIDs have a different format but still start with digits
      expect(jidToPhone('120363123456789012@g.us')).toBe('+120363123456789012');
    });

    it('handles plain phone numbers', () => {
      expect(jidToPhone('+14155552671')).toBe('+14155552671');
      expect(jidToPhone('4155552671')).toBe('+14155552671');
    });

    it('returns null for invalid input', () => {
      expect(jidToPhone('')).toBeNull();
      expect(jidToPhone('not-a-phone')).toBeNull();
    });
  });

  // ── isJid / isGroupJid ──────────────────────────────

  describe('isJid', () => {
    it('identifies WhatsApp JIDs', () => {
      expect(isJid('14155552671@s.whatsapp.net')).toBe(true);
      expect(isJid('120363123456@g.us')).toBe(true);
    });

    it('rejects non-JIDs', () => {
      expect(isJid('+14155552671')).toBe(false);
      expect(isJid('hello')).toBe(false);
    });
  });

  describe('isGroupJid', () => {
    it('identifies group JIDs', () => {
      expect(isGroupJid('120363123456@g.us')).toBe(true);
    });

    it('rejects individual JIDs', () => {
      expect(isGroupJid('14155552671@s.whatsapp.net')).toBe(false);
    });
  });
});
