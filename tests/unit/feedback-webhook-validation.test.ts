/**
 * Tests for FeedbackManager webhook URL validation and edge cases.
 *
 * Covers:
 * - validateWebhookUrl rejection of internal/insecure URLs (security-critical)
 * - MAX_FEEDBACK_ITEMS cap (1000 items)
 * - Webhook returning non-OK HTTP status (500, 403, etc.)
 * - Partial retry success (some items forward, others fail)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FeedbackManager } from '../../src/core/FeedbackManager.js';
import type { FeedbackConfig } from '../../src/core/types.js';

describe('FeedbackManager webhook URL validation', () => {
  it('rejects HTTP (non-HTTPS) webhook URLs', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      webhookUrl: 'http://example.com/feedback',
      feedbackFile: '/tmp/test-feedback.json',
    })).toThrow('webhook URL must use HTTPS');
  });

  it('rejects localhost', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://localhost/feedback',
      feedbackFile: '/tmp/test-feedback.json',
    })).toThrow('internal addresses');
  });

  it('rejects 127.0.0.1', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://127.0.0.1/feedback',
      feedbackFile: '/tmp/test-feedback.json',
    })).toThrow('internal addresses');
  });

  it('rejects ::1 (IPv6 loopback)', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://[::1]/feedback',
      feedbackFile: '/tmp/test-feedback.json',
    })).toThrow('internal addresses');
  });

  it('rejects 0.0.0.0', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://0.0.0.0/feedback',
      feedbackFile: '/tmp/test-feedback.json',
    })).toThrow('internal addresses');
  });

  it('rejects 10.x.x.x private range', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://10.0.0.1/feedback',
      feedbackFile: '/tmp/test-feedback.json',
    })).toThrow('internal addresses');
  });

  it('rejects 192.168.x.x private range', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://192.168.1.100/feedback',
      feedbackFile: '/tmp/test-feedback.json',
    })).toThrow('internal addresses');
  });

  it('rejects .local domains', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://myserver.local/feedback',
      feedbackFile: '/tmp/test-feedback.json',
    })).toThrow('internal addresses');
  });

  it('rejects 169.254.x.x link-local range', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://169.254.0.1/feedback',
      feedbackFile: '/tmp/test-feedback.json',
    })).toThrow('internal addresses');
  });

  it('rejects completely invalid URLs', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      webhookUrl: 'not a url at all',
      feedbackFile: '/tmp/test-feedback.json',
    })).toThrow('invalid webhook URL');
  });

  it('accepts valid HTTPS public URLs', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile: '/tmp/test-feedback.json',
    })).not.toThrow();
  });

  it('skips validation when no webhookUrl provided', () => {
    expect(() => new FeedbackManager({
      enabled: true,
      feedbackFile: '/tmp/test-feedback.json',
    })).not.toThrow();
  });
});

describe('FeedbackManager MAX_FEEDBACK_ITEMS cap', () => {
  let tmpDir: string;
  let feedbackFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feedback-cap-'));
    feedbackFile = path.join(tmpDir, 'feedback.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('caps stored feedback at 1000 items, keeping newest', async () => {
    const manager = new FeedbackManager({
      enabled: false, // No webhook — just local storage
      feedbackFile,
    });

    // Pre-populate with 999 items directly
    const existing = [];
    for (let i = 0; i < 999; i++) {
      existing.push({
        id: `fb-old-${i}`,
        type: 'bug',
        title: `Old Bug ${i}`,
        description: 'Old item',
        submittedAt: new Date(Date.now() - 100000 + i).toISOString(),
        forwarded: false,
        agentName: 'test',
        instarVersion: '0.1.0',
        nodeVersion: 'v20',
        os: 'test',
      });
    }
    fs.writeFileSync(feedbackFile, JSON.stringify(existing));

    // Submit 2 more (total 1001 → should cap at 1000)
    await manager.submit({
      type: 'feature',
      title: 'New Feature 1',
      description: 'First new',
      agentName: 'test',
      instarVersion: '0.1.0',
      nodeVersion: 'v20',
      os: 'test',
    });

    await manager.submit({
      type: 'feature',
      title: 'New Feature 2',
      description: 'Second new',
      agentName: 'test',
      instarVersion: '0.1.0',
      nodeVersion: 'v20',
      os: 'test',
    });

    const items = manager.list();
    expect(items.length).toBe(1000);

    // Oldest item should have been dropped (fb-old-0)
    expect(items.find(i => i.id === 'fb-old-0')).toBeUndefined();

    // Newest items should be present
    expect(items.find(i => i.title === 'New Feature 1')).toBeTruthy();
    expect(items.find(i => i.title === 'New Feature 2')).toBeTruthy();
  });
});

describe('FeedbackManager webhook HTTP error handling', () => {
  let tmpDir: string;
  let feedbackFile: string;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feedback-http-'));
    feedbackFile = path.join(tmpDir, 'feedback.json');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores locally with forwarded=false when webhook returns 500', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
    });

    const item = await manager.submit({
      type: 'bug',
      title: 'HTTP 500 test',
      description: 'Should store locally',
      agentName: 'test',
      instarVersion: '0.1.0',
      nodeVersion: 'v20',
      os: 'test',
    });

    // Should NOT throw — the local record is the receipt
    expect(item.forwarded).toBe(false);
    expect(item.id).toMatch(/^fb-/);

    // Should still be in local storage
    const stored = JSON.parse(fs.readFileSync(feedbackFile, 'utf-8'));
    expect(stored).toHaveLength(1);
  });

  it('stores locally with forwarded=false when webhook returns 403', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
    });

    const item = await manager.submit({
      type: 'bug',
      title: 'HTTP 403 test',
      description: 'Auth rejected',
      agentName: 'test',
      instarVersion: '0.1.0',
      nodeVersion: 'v20',
      os: 'test',
    });

    expect(item.forwarded).toBe(false);
  });

  it('does not include internal metadata in webhook payload', async () => {
    let capturedPayload: string | undefined;
    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedPayload = opts.body as string;
      return { ok: true };
    });

    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
    });

    await manager.submit({
      type: 'bug',
      title: 'Payload test',
      description: 'Check payload',
      agentName: 'test-agent',
      instarVersion: '0.1.0',
      nodeVersion: 'v20.0.0',
      os: 'darwin arm64',
    });

    expect(capturedPayload).toBeDefined();
    const parsed = JSON.parse(capturedPayload!);

    // Should include identification fields for endpoint auth
    expect(parsed.feedbackId).toBeTruthy();
    expect(parsed.type).toBe('bug');
    expect(parsed.title).toBe('Payload test');
    expect(parsed.description).toBe('Check payload');
    expect(parsed.submittedAt).toBeTruthy();
    expect(parsed.agentName).toBe('test-agent');
    expect(parsed.instarVersion).toBeTruthy();
    expect(parsed.nodeVersion).toBeTruthy();
    expect(parsed.os).toBe('darwin arm64');

    // Should NOT include internal-only state
    expect(parsed.forwarded).toBeUndefined();
  });
});

describe('FeedbackManager partial retry', () => {
  let tmpDir: string;
  let feedbackFile: string;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feedback-retry-'));
    feedbackFile = path.join(tmpDir, 'feedback.json');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles partial retry success (some succeed, some fail)', async () => {
    // Create manager with webhook disabled for initial submission
    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
    });

    // Submit 3 items that all fail
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

    await manager.submit({
      type: 'bug', title: 'Item 1', description: 'First',
      agentName: 'test', instarVersion: '0.1.0', nodeVersion: 'v20', os: 'test',
    });
    await manager.submit({
      type: 'bug', title: 'Item 2', description: 'Second',
      agentName: 'test', instarVersion: '0.1.0', nodeVersion: 'v20', os: 'test',
    });
    await manager.submit({
      type: 'bug', title: 'Item 3', description: 'Third',
      agentName: 'test', instarVersion: '0.1.0', nodeVersion: 'v20', os: 'test',
    });

    // All 3 should be unforwarded
    expect(manager.list().filter(i => !i.forwarded)).toHaveLength(3);

    // Mock: first and third succeed, second fails
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('still offline for this one');
      }
      return { ok: true };
    });

    const result = await manager.retryUnforwarded();

    expect(result.retried).toBe(3);
    expect(result.succeeded).toBe(2);

    // Verify: 2 forwarded, 1 still unforwarded
    const items = manager.list();
    const forwarded = items.filter(i => i.forwarded);
    const unforwarded = items.filter(i => !i.forwarded);
    expect(forwarded).toHaveLength(2);
    expect(unforwarded).toHaveLength(1);
  });
});
