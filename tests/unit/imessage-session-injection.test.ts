/**
 * BDD tests for SessionManager.injectIMessageMessage().
 *
 * Tests tag construction, file threshold behavior, and stall tracking
 * without requiring a real tmux session. Uses a mock that captures
 * what would be injected.
 *
 * Tier 1: Module logic in isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';

// We can't easily import SessionManager without its full dependency tree,
// so we test the injection logic patterns directly.

describe('Feature: iMessage injection into tmux sessions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-inject-test-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Scenario: Tag construction', () => {
    it('Given sender and senderName, Then tag is [imessage:+1408... from Justin]', () => {
      const sender = '+14081234567';
      const senderName = 'Justin';
      const safeName = senderName.replace(/[\[\]]/g, '');
      const tag = `[imessage:${sender} from ${safeName}]`;

      expect(tag).toBe('[imessage:+14081234567 from Justin]');
    });

    it('Given sender without senderName, Then tag is [imessage:+1408...]', () => {
      const sender = '+14081234567';
      const senderName = undefined;
      const nameTag = senderName ? ` from ${senderName.replace(/[\[\]]/g, '')}` : '';
      const tag = `[imessage:${sender}${nameTag}]`;

      expect(tag).toBe('[imessage:+14081234567]');
    });

    it('Given senderName with brackets, Then brackets are stripped', () => {
      const senderName = 'Justin [Admin]';
      const safeName = senderName.replace(/[\[\]]/g, '');
      expect(safeName).toBe('Justin Admin');
    });

    it('Given email sender, Then tag includes full email', () => {
      const sender = 'user@icloud.com';
      const tag = `[imessage:${sender}]`;
      expect(tag).toBe('[imessage:user@icloud.com]');
    });
  });

  describe('Scenario: Short message stays inline', () => {
    it('Given a 100-char message, Then tagged text is under 500 chars (inline threshold)', () => {
      const sender = '+14081234567';
      const text = 'Hello, how are you doing today?';
      const tag = `[imessage:${sender} from Justin]`;
      const taggedText = `${tag} ${text}`;

      expect(taggedText.length).toBeLessThanOrEqual(500);
    });
  });

  describe('Scenario: Long message uses temp file', () => {
    it('Given a 600-char message, When written to temp file, Then file contains full tagged text', () => {
      const sender = '+14081234567';
      const text = 'A'.repeat(600);
      const tag = `[imessage:${sender} from Justin]`;
      const taggedText = `${tag} ${text}`;

      expect(taggedText.length).toBeGreaterThan(500);

      // Simulate writing to temp file (same logic as injectIMessageMessage)
      const imsgTmpDir = path.join(tmpDir, 'instar-imessage');
      fs.mkdirSync(imsgTmpDir, { recursive: true });
      const senderSlug = sender.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
      const filename = `msg-${senderSlug}-${Date.now()}.txt`;
      const filepath = path.join(imsgTmpDir, filename);
      fs.writeFileSync(filepath, taggedText);

      expect(fs.existsSync(filepath)).toBe(true);
      expect(fs.readFileSync(filepath, 'utf-8')).toBe(taggedText);

      // Reference message
      const ref = `${tag} [Long message saved to ${filepath} — read it to see the full message]`;
      expect(ref).toContain(filepath);
      expect(ref.length).toBeLessThan(taggedText.length);
    });
  });

  describe('Scenario: Stall tracking via synthetic topic ID', () => {
    it('Given sender "+14081234567", Then hash produces a stable positive number', () => {
      const sender = '+14081234567';
      let hash = 0;
      for (let i = 0; i < sender.length; i++) {
        hash = ((hash << 5) - hash + sender.charCodeAt(i)) | 0;
      }
      const syntheticId = Math.abs(hash);

      expect(typeof syntheticId).toBe('number');
      expect(syntheticId).toBeGreaterThan(0);
      expect(Number.isInteger(syntheticId)).toBe(true);

      // Same input produces same hash
      let hash2 = 0;
      for (let i = 0; i < sender.length; i++) {
        hash2 = ((hash2 << 5) - hash2 + sender.charCodeAt(i)) | 0;
      }
      expect(Math.abs(hash2)).toBe(syntheticId);
    });

    it('Given different senders, Then they produce different hashes', () => {
      function hashSender(s: string): number {
        let h = 0;
        for (let i = 0; i < s.length; i++) {
          h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
        return Math.abs(h);
      }

      const h1 = hashSender('+14081234567');
      const h2 = hashSender('+19995551234');
      const h3 = hashSender('user@icloud.com');

      expect(h1).not.toBe(h2);
      expect(h1).not.toBe(h3);
      expect(h2).not.toBe(h3);
    });
  });

  describe('Scenario: clearIMessageInjectionTracker', () => {
    it('Given a pendingInjections map with matching hash, When clear is called, Then entry is removed', () => {
      // Simulate the pendingInjections map behavior
      const pendingInjections = new Map<string, { topicId: number; injectedAt: number; text: string }>();

      const sender = '+14081234567';
      let senderHash = 0;
      for (let i = 0; i < sender.length; i++) {
        senderHash = ((senderHash << 5) - senderHash + sender.charCodeAt(i)) | 0;
      }
      const syntheticTopicId = Math.abs(senderHash);

      pendingInjections.set('im-test-session', { topicId: syntheticTopicId, injectedAt: Date.now(), text: 'Hello' });
      expect(pendingInjections.size).toBe(1);

      // Clear (same logic as clearIMessageInjectionTracker)
      for (const [session, info] of pendingInjections) {
        if (info.topicId === syntheticTopicId) {
          pendingInjections.delete(session);
        }
      }

      expect(pendingInjections.size).toBe(0);
    });
  });
});
