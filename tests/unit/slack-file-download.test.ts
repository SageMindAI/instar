/**
 * FileHandler download — verifies that redirects are followed with auth header preserved,
 * preventing Slack CDN from returning HTML login pages.
 *
 * Regression test for: snippet downloads returning HTML instead of actual content
 * because Node.js fetch strips Authorization headers on cross-origin redirects.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { FileHandler } from '../../src/messaging/slack/FileHandler.js';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DIR = '/tmp/slack-file-download-test-' + Date.now();

afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createHandler() {
  fs.mkdirSync(path.join(TEST_DIR, 'slack-files'), { recursive: true });
  const apiClient = { call: vi.fn() } as any;
  return new FileHandler(apiClient, 'xoxb-test-token', TEST_DIR);
}

describe('FileHandler download', () => {
  it('follows redirects with Authorization header preserved', async () => {
    const handler = createHandler();
    const fetchCalls: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = [];

    // Mock fetch: first call returns 302, second returns content
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        status: 302,
        ok: false,
        headers: new Headers({ location: 'https://cdn.slack.com/files/actual-content' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers(),
        arrayBuffer: async () => new TextEncoder().encode('actual snippet content').buffer,
      });

    vi.stubGlobal('fetch', (...args: any[]) => {
      const [url, opts] = args;
      fetchCalls.push({ url, headers: opts?.headers, redirect: opts?.redirect });
      return mockFetch(...args);
    });

    const result = await handler.downloadFile(
      'https://files.slack.com/files-pri/T123/snippet.txt',
      'snippet.txt',
    );

    // Should have made 2 fetch calls (original + redirect)
    expect(fetchCalls.length).toBe(2);

    // Both calls should include Authorization header
    expect(fetchCalls[0].headers?.Authorization).toBe('Bearer xoxb-test-token');
    expect(fetchCalls[1].headers?.Authorization).toBe('Bearer xoxb-test-token');

    // Both calls should use manual redirect mode
    expect(fetchCalls[0].redirect).toBe('manual');
    expect(fetchCalls[1].redirect).toBe('manual');

    // Redirect URL should be followed
    expect(fetchCalls[1].url).toBe('https://cdn.slack.com/files/actual-content');

    // File should contain actual content
    const content = fs.readFileSync(result, 'utf-8');
    expect(content).toBe('actual snippet content');
  });

  it('handles direct (non-redirect) downloads', async () => {
    const handler = createHandler();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode('direct content').buffer,
    }));

    const result = await handler.downloadFile(
      'https://files.slack.com/files-pri/T123/file.txt',
      'file.txt',
    );

    const content = fs.readFileSync(result, 'utf-8');
    expect(content).toBe('direct content');
  });

  it('limits redirect following to 5 hops', async () => {
    const handler = createHandler();
    let callCount = 0;

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        status: 302,
        ok: false,
        headers: new Headers({ location: `https://cdn.slack.com/hop-${callCount}` }),
      };
    }));

    // Should throw after 5 redirects (6 total fetches: 1 original + 5 redirects)
    await expect(handler.downloadFile(
      'https://files.slack.com/files-pri/T123/file.txt',
      'file.txt',
    )).rejects.toThrow('Download failed');
  });

  it('blocks path traversal in destPath', async () => {
    const handler = createHandler();

    await expect(handler.downloadFile(
      'https://files.slack.com/test',
      '../../etc/passwd',
    )).rejects.toThrow('Path traversal blocked');
  });
});
