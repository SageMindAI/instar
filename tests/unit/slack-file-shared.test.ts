/**
 * SlackAdapter file_shared event handling — verifies that standalone files
 * (drag-and-drop without accompanying text) are downloaded and routed
 * to the message handler via files.info API lookup.
 *
 * Previously, file_shared events were silently ignored because they only
 * contain a file_id (no URL). The fix calls files.info to get the download URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import fs from 'node:fs';
import path from 'node:path';

const TEST_STATE_DIR = '/tmp/slack-file-shared-test-' + Date.now();

function createTestAdapter() {
  const messages: Array<{ content: string; channel: string }> = [];

  // Ensure state dir exists
  fs.mkdirSync(path.join(TEST_STATE_DIR, 'slack-files'), { recursive: true });

  const adapter = new SlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    authorizedUserIds: ['U_TEST'],
    workspaceMode: 'dedicated',
  } as any, TEST_STATE_DIR);

  // Wire a message handler that records received messages
  adapter.onMessage(async (msg) => {
    messages.push({ content: msg.content, channel: msg.channel.identifier });
  });

  // Access the private apiClient to mock files.info
  const apiClient = (adapter as any).apiClient;

  return { adapter, messages, apiClient };
}

afterEach(() => {
  // Clean up test state directory
  // safe-git-allow: incremental-migration
  fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

describe('SlackAdapter file_shared handling', () => {
  it('fetches file info and routes standalone file to message handler', async () => {
    const { adapter, messages, apiClient } = createTestAdapter();

    // Mock files.info API response
    const originalCall = apiClient.call.bind(apiClient);
    apiClient.call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'files.info') {
        return {
          ok: true,
          file: {
            id: 'F_TEST_PDF',
            name: 'report.pdf',
            mimetype: 'application/pdf',
            url_private: 'https://files.slack.com/files-pri/T_TEST/report.pdf',
            size: 5000,
          },
        };
      }
      // Fall through for other calls (users.info etc.)
      return { ok: true, user: { id: 'U_TEST', name: 'testuser', real_name: 'Test User' } };
    });

    // Mock the file download (we don't want real HTTP calls)
    const fileHandler = (adapter as any).fileHandler;
    fileHandler.downloadFile = vi.fn(async (_url: string, destPath: string) => {
      // Create a fake file at the destination
      const resolvedPath = path.resolve(fileHandler.downloadDir, destPath);
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(resolvedPath, 'fake-pdf-content');
      return resolvedPath;
    });

    // Invoke _handleFileShared directly
    const handleFileShared = (adapter as any)._handleFileShared.bind(adapter);
    await handleFileShared({
      file_id: 'F_TEST_PDF',
      user_id: 'U_TEST',
      channel_id: 'C_TEST_CHAN',
    });

    // Verify files.info was called with the right file_id
    expect(apiClient.call).toHaveBeenCalledWith('files.info', { file: 'F_TEST_PDF' });

    // Verify message was routed to handler
    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('[document:');
    expect(messages[0].content).toContain('.pdf');
    expect(messages[0].channel).toBe('C_TEST_CHAN');
  });

  it('routes image files with proper [image:] tag', async () => {
    const { adapter, messages, apiClient } = createTestAdapter();

    apiClient.call = vi.fn(async (method: string) => {
      if (method === 'files.info') {
        return {
          ok: true,
          file: {
            id: 'F_TEST_IMG',
            name: 'screenshot.png',
            mimetype: 'image/png',
            url_private: 'https://files.slack.com/files-pri/T_TEST/screenshot.png',
            size: 10000,
          },
        };
      }
      return { ok: true, user: { id: 'U_TEST', name: 'testuser', real_name: 'Test User' } };
    });

    // Mock download to create a valid PNG file (with magic bytes)
    const fileHandler = (adapter as any).fileHandler;
    fileHandler.downloadFile = vi.fn(async (_url: string, destPath: string) => {
      const resolvedPath = path.resolve(fileHandler.downloadDir, destPath);
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      // Write PNG magic bytes + padding to pass validation
      const pngHeader = Buffer.alloc(200);
      pngHeader[0] = 0x89; pngHeader[1] = 0x50; pngHeader[2] = 0x4E; pngHeader[3] = 0x47;
      fs.writeFileSync(resolvedPath, pngHeader);
      return resolvedPath;
    });

    const handleFileShared = (adapter as any)._handleFileShared.bind(adapter);
    await handleFileShared({
      file_id: 'F_TEST_IMG',
      user_id: 'U_TEST',
      channel_id: 'C_TEST_CHAN',
    });

    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('[image:');
  });

  it('rejects files from unauthorized users', async () => {
    const { adapter, messages, apiClient } = createTestAdapter();

    apiClient.call = vi.fn();

    const handleFileShared = (adapter as any)._handleFileShared.bind(adapter);
    await handleFileShared({
      file_id: 'F_TEST',
      user_id: 'U_UNAUTHORIZED',
      channel_id: 'C_TEST_CHAN',
    });

    // Should NOT call files.info or route a message
    expect(apiClient.call).not.toHaveBeenCalled();
    expect(messages.length).toBe(0);
  });

  it('handles files.info API failure gracefully', async () => {
    const { adapter, messages, apiClient } = createTestAdapter();

    apiClient.call = vi.fn(async (method: string) => {
      if (method === 'files.info') {
        throw new Error('channel_not_found');
      }
      return { ok: true };
    });

    const handleFileShared = (adapter as any)._handleFileShared.bind(adapter);
    await handleFileShared({
      file_id: 'F_TEST',
      user_id: 'U_TEST',
      channel_id: 'C_TEST_CHAN',
    });

    // Should fail gracefully — no message routed
    expect(messages.length).toBe(0);
  });

  it('logs actionable message when files:read scope is missing', async () => {
    const { adapter, messages, apiClient } = createTestAdapter();

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    apiClient.call = vi.fn(async (method: string) => {
      if (method === 'files.info') {
        throw new Error('missing_scope');
      }
      return { ok: true };
    });

    const handleFileShared = (adapter as any)._handleFileShared.bind(adapter);
    await handleFileShared({
      file_id: 'F_TEST',
      user_id: 'U_TEST',
      channel_id: 'C_TEST_CHAN',
    });

    // Should fail gracefully with actionable scope message
    expect(messages.length).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("files:read"),
    );

    consoleSpy.mockRestore();
  });

  it('handles missing file_id or channel_id', async () => {
    const { adapter, messages, apiClient } = createTestAdapter();
    apiClient.call = vi.fn();

    const handleFileShared = (adapter as any)._handleFileShared.bind(adapter);

    // Missing file_id
    await handleFileShared({ user_id: 'U_TEST', channel_id: 'C_TEST' });
    expect(messages.length).toBe(0);

    // Missing channel_id
    await handleFileShared({ user_id: 'U_TEST', file_id: 'F_TEST' });
    expect(messages.length).toBe(0);
  });
});
