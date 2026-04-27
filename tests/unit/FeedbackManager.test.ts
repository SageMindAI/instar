import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FeedbackManager } from '../../src/core/FeedbackManager.js';
import type { FeedbackConfig } from '../../src/core/types.js';

describe('FeedbackManager', () => {
  let tmpDir: string;
  let feedbackFile: string;
  let config: FeedbackConfig;
  let manager: FeedbackManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feedback-test-'));
    feedbackFile = path.join(tmpDir, 'feedback.json');
    config = {
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
    };
    manager = new FeedbackManager(config);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('submit', () => {
    it('stores feedback locally', async () => {
      // Mock fetch to simulate webhook failure (so we test local storage)
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('network error'));

      const item = await manager.submit({
        type: 'bug',
        title: 'Server crashes on startup',
        description: 'When I run instar server start, it crashes immediately.',
        agentName: 'test-agent',
        instarVersion: '0.1.8',
        nodeVersion: 'v20.0.0',
        os: 'darwin arm64',
      });

      expect(item.id).toMatch(/^fb-/);
      expect(item.title).toBe('Server crashes on startup');
      expect(item.type).toBe('bug');
      expect(item.forwarded).toBe(false);
      expect(item.submittedAt).toBeTruthy();

      // Verify local storage
      const stored = JSON.parse(fs.readFileSync(feedbackFile, 'utf-8'));
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(item.id);

      global.fetch = originalFetch;
    });

    it('marks as forwarded when webhook succeeds', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({ ok: true });

      const item = await manager.submit({
        type: 'feature',
        title: 'Add Discord support',
        description: 'Would love Discord integration.',
        agentName: 'test-agent',
        instarVersion: '0.1.8',
        nodeVersion: 'v20.0.0',
        os: 'darwin arm64',
      });

      expect(item.forwarded).toBe(true);

      global.fetch = originalFetch;
    });

    it('stores multiple feedback items', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      await manager.submit({
        type: 'bug',
        title: 'Bug 1',
        description: 'First bug',
        agentName: 'test',
        instarVersion: '0.1.8',
        nodeVersion: 'v20.0.0',
        os: 'linux x64',
      });

      await manager.submit({
        type: 'feature',
        title: 'Feature 1',
        description: 'First feature',
        agentName: 'test',
        instarVersion: '0.1.8',
        nodeVersion: 'v20.0.0',
        os: 'linux x64',
      });

      const items = manager.list();
      expect(items).toHaveLength(2);

      global.fetch = originalFetch;
    });
  });

  describe('list', () => {
    it('returns empty array when no feedback file', () => {
      expect(manager.list()).toEqual([]);
    });

    it('returns stored feedback', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      await manager.submit({
        type: 'bug',
        title: 'Test',
        description: 'Test desc',
        agentName: 'test',
        instarVersion: '0.1.0',
        nodeVersion: 'v20.0.0',
        os: 'darwin arm64',
      });

      const items = manager.list();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Test');

      global.fetch = originalFetch;
    });
  });

  describe('get', () => {
    it('returns null for non-existent ID', () => {
      expect(manager.get('nonexistent')).toBeNull();
    });

    it('returns specific feedback item', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      const item = await manager.submit({
        type: 'question',
        title: 'How do jobs work?',
        description: 'I need help.',
        agentName: 'test',
        instarVersion: '0.1.0',
        nodeVersion: 'v20.0.0',
        os: 'darwin arm64',
      });

      const retrieved = manager.get(item.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.title).toBe('How do jobs work?');

      global.fetch = originalFetch;
    });
  });

  describe('retryUnforwarded', () => {
    it('returns zero counts when nothing to retry', async () => {
      const result = await manager.retryUnforwarded();
      expect(result).toEqual({ retried: 0, succeeded: 0 });
    });

    it('retries and marks forwarded on success', async () => {
      const originalFetch = global.fetch;

      // First submit fails
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));
      await manager.submit({
        type: 'bug',
        title: 'Retry test',
        description: 'Should be retried',
        agentName: 'test',
        instarVersion: '0.1.0',
        nodeVersion: 'v20.0.0',
        os: 'darwin arm64',
      });

      expect(manager.list()[0].forwarded).toBe(false);

      // Retry succeeds
      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      const result = await manager.retryUnforwarded();

      expect(result.retried).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(manager.list()[0].forwarded).toBe(true);

      global.fetch = originalFetch;
    });

    it('does not retry when feedback is disabled', async () => {
      const disabledConfig: FeedbackConfig = {
        enabled: false,
        webhookUrl: 'https://example.com/feedback',
        feedbackFile,
      };
      const disabledManager = new FeedbackManager(disabledConfig);

      const result = await disabledManager.retryUnforwarded();
      expect(result).toEqual({ retried: 0, succeeded: 0 });
    });
  });
});
