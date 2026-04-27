/**
 * SlackAdapter attachment handling — verifies that message.attachments[]
 * (unfurled links, rich previews, integration content) are extracted
 * and inlined into the message content.
 *
 * Previously, only message.files[] was processed. Attachments from
 * link unfurling (e.g., Fathom meeting transcripts, GitHub PRs, etc.)
 * were silently ignored, causing agents to hallucinate content.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DIR = '/tmp/slack-attachments-test-' + Date.now();

afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createTestAdapter() {
  const messages: Array<{ content: string; channel: string }> = [];
  fs.mkdirSync(path.join(TEST_DIR, 'slack-files'), { recursive: true });

  const adapter = new SlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    authorizedUserIds: ['U_TEST'],
    workspaceMode: 'dedicated',
  } as any, TEST_DIR);

  adapter.onMessage(async (msg) => {
    messages.push({ content: msg.content, channel: msg.channel.identifier });
  });

  // Mock getUserInfo to avoid API calls
  (adapter as any).getUserInfo = vi.fn(async () => ({ name: 'testuser' }));

  return { adapter, messages };
}

describe('SlackAdapter attachment handling', () => {
  it('extracts text from unfurled link attachments', async () => {
    const { adapter, messages } = createTestAdapter();

    const handleMessage = (adapter as any)._handleMessage.bind(adapter);
    await handleMessage({
      user: 'U_TEST',
      text: '<@UBOT> check this out',
      channel: 'C_TEST',
      ts: '1700000001.000001',
      attachments: [
        {
          title: 'Board Meeting Transcript',
          text: 'Meeting notes from April 2nd. Discussed Q1 revenue...',
          fallback: 'Board Meeting Transcript - meeting notes',
        },
      ],
    });

    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('Board Meeting Transcript');
    expect(messages[0].content).toContain('Meeting notes from April 2nd');
  });

  it('handles attachments with only fallback text', async () => {
    const { adapter, messages } = createTestAdapter();

    const handleMessage = (adapter as any)._handleMessage.bind(adapter);
    await handleMessage({
      user: 'U_TEST',
      text: 'please review',
      channel: 'C_TEST',
      ts: '1700000002.000001',
      attachments: [
        {
          fallback: 'External service preview: Project status update',
        },
      ],
    });

    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('External service preview');
  });

  it('handles multiple attachments', async () => {
    const { adapter, messages } = createTestAdapter();

    const handleMessage = (adapter as any)._handleMessage.bind(adapter);
    await handleMessage({
      user: 'U_TEST',
      text: 'two links',
      channel: 'C_TEST',
      ts: '1700000003.000001',
      attachments: [
        { title: 'Link 1', text: 'First attachment content' },
        { title: 'Link 2', text: 'Second attachment content' },
      ],
    });

    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('Link 1');
    expect(messages[0].content).toContain('First attachment content');
    expect(messages[0].content).toContain('Link 2');
    expect(messages[0].content).toContain('Second attachment content');
  });

  it('skips empty attachments', async () => {
    const { adapter, messages } = createTestAdapter();

    const handleMessage = (adapter as any)._handleMessage.bind(adapter);
    await handleMessage({
      user: 'U_TEST',
      text: 'just text',
      channel: 'C_TEST',
      ts: '1700000004.000001',
      attachments: [
        { color: '#36a64f' }, // attachment with no text content
      ],
    });

    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('just text');
  });

  it('works when no attachments present', async () => {
    const { adapter, messages } = createTestAdapter();

    const handleMessage = (adapter as any)._handleMessage.bind(adapter);
    await handleMessage({
      user: 'U_TEST',
      text: 'plain message',
      channel: 'C_TEST',
      ts: '1700000005.000001',
    });

    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('plain message');
  });
});
