/**
 * Unit tests for FeedbackManager quality validation and pseudonymization.
 *
 * Tests cover:
 * - validateFeedbackQuality(): whitespace-only, min length, duplicate detection
 * - generatePseudonym(): stable output, prefix format, different secrets
 * - resolvePseudonym(): cache-based reverse lookup
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FeedbackManager } from '../../src/core/FeedbackManager.js';

describe('FeedbackManager quality validation', () => {
  let tmpDir: string;
  let feedbackFile: string;
  let manager: FeedbackManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-quality-test-'));
    feedbackFile = path.join(tmpDir, 'feedback.json');
    manager = new FeedbackManager({
      enabled: false,
      webhookUrl: '',
      feedbackFile,
      sharedSecret: 'test-secret-123',
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('validateFeedbackQuality()', () => {
    it('rejects whitespace-only title', () => {
      const result = manager.validateFeedbackQuality('   ', 'This is a valid description with enough content');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Title');
    });

    it('rejects empty title', () => {
      const result = manager.validateFeedbackQuality('', 'This is a valid description with enough content');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Title');
    });

    it('rejects short description (under 20 real chars)', () => {
      const result = manager.validateFeedbackQuality('Good title', 'Too short!');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('20 characters');
    });

    it('rejects description that is all punctuation/whitespace', () => {
      const result = manager.validateFeedbackQuality('Title', '.... !!! ??? --- ,,, ;;; ::: @@@ ### $$$');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('20 characters');
    });

    it('accepts valid title and description', () => {
      const result = manager.validateFeedbackQuality(
        'Session crash on startup',
        'The agent crashes when starting a new session with the default configuration settings applied',
      );
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('detects duplicate titles (case-insensitive)', () => {
      // Pre-seed feedback with an existing item
      fs.writeFileSync(feedbackFile, JSON.stringify([
        {
          id: 'fb-existing',
          type: 'bug',
          title: 'Session Crash Bug',
          description: 'Detailed description of the crash',
          agentName: 'test-agent',
          instarVersion: '0.9.9',
          nodeVersion: 'v20.0.0',
          os: 'darwin',
          submittedAt: '2026-02-25T10:00:00Z',
          forwarded: false,
        },
      ]));

      const result = manager.validateFeedbackQuality(
        'session crash bug', // same title, different case
        'Another description about crashes that is long enough to pass validation',
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('already exists');
    });

    it('allows non-duplicate titles', () => {
      fs.writeFileSync(feedbackFile, JSON.stringify([
        {
          id: 'fb-existing',
          type: 'bug',
          title: 'Session Crash Bug',
          description: 'Description',
          agentName: 'test-agent',
          instarVersion: '0.9.9',
          nodeVersion: 'v20.0.0',
          os: 'darwin',
          submittedAt: '2026-02-25T10:00:00Z',
          forwarded: false,
        },
      ]));

      const result = manager.validateFeedbackQuality(
        'Different Bug Report',
        'This is a completely different bug report with plenty of detail included',
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('generatePseudonym()', () => {
    it('returns agent- prefixed 12-char hex string', () => {
      const pseudonym = manager.generatePseudonym('my-agent');
      expect(pseudonym).toMatch(/^agent-[a-f0-9]{12}$/);
    });

    it('is stable — same input always produces same output', () => {
      const p1 = manager.generatePseudonym('stable-agent');
      const p2 = manager.generatePseudonym('stable-agent');
      expect(p1).toBe(p2);
    });

    it('produces different pseudonyms for different agents', () => {
      const p1 = manager.generatePseudonym('agent-alpha');
      const p2 = manager.generatePseudonym('agent-beta');
      expect(p1).not.toBe(p2);
    });

    it('produces different pseudonyms with different secrets', () => {
      const manager2 = new FeedbackManager({
        enabled: false,
        webhookUrl: '',
        feedbackFile,
        sharedSecret: 'different-secret',
      });

      const p1 = manager.generatePseudonym('same-agent');
      const p2 = manager2.generatePseudonym('same-agent');
      expect(p1).not.toBe(p2);
    });

    it('works without shared secret (uses default salt)', () => {
      const noSecretManager = new FeedbackManager({
        enabled: false,
        webhookUrl: '',
        feedbackFile,
      });

      const pseudonym = noSecretManager.generatePseudonym('no-secret-agent');
      expect(pseudonym).toMatch(/^agent-[a-f0-9]{12}$/);
    });
  });

  describe('resolvePseudonym()', () => {
    it('resolves from in-memory cache', () => {
      const pseudonym = manager.generatePseudonym('cached-agent');
      const resolved = manager.resolvePseudonym(pseudonym);
      expect(resolved).toBe('cached-agent');
    });

    it('resolves from stored feedback when cache is empty', () => {
      // Seed feedback with a known agent
      fs.writeFileSync(feedbackFile, JSON.stringify([
        {
          id: 'fb-1',
          type: 'bug',
          title: 'Test',
          description: 'Description',
          agentName: 'stored-agent',
          instarVersion: '0.9.9',
          nodeVersion: 'v20.0.0',
          os: 'darwin',
          submittedAt: '2026-02-25T10:00:00Z',
          forwarded: false,
        },
      ]));

      // New manager instance — empty cache
      const freshManager = new FeedbackManager({
        enabled: false,
        webhookUrl: '',
        feedbackFile,
        sharedSecret: 'test-secret-123',
      });

      // Generate the expected pseudonym to look up
      const expectedPseudonym = freshManager.generatePseudonym('stored-agent');
      const resolved = freshManager.resolvePseudonym(expectedPseudonym);
      expect(resolved).toBe('stored-agent');
    });

    it('returns null for unknown pseudonym', () => {
      const resolved = manager.resolvePseudonym('agent-000000000000');
      expect(resolved).toBeNull();
    });
  });
});
