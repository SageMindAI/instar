/**
 * End-to-end tests for Phase 3: Business API Backend.
 *
 * Tests the full Business API lifecycle WITHOUT requiring a real Meta API.
 * Simulates webhook payloads and API responses to exercise the complete
 * flow from webhook receipt through message processing to outbound send.
 *
 * Covers:
 * 1. Full webhook lifecycle: receive → parse → route → handle → respond
 * 2. Template and interactive message sending
 * 3. Connection verification and status tracking
 * 4. Adapter integration: Business API → WhatsAppAdapter → message handler
 * 5. Webhook route integration with Express mock
 * 6. Adversarial payloads: malformed, oversized, injection attempts
 * 7. Concurrent webhook processing
 * 8. Status counter accuracy under load
 * 9. Connection lifecycle: connect → disconnect → reconnect
 * 10. Cross-backend consistency: same adapter, different backends
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WhatsAppAdapter } from '../../src/messaging/WhatsAppAdapter.js';
import {
  BusinessApiBackend,
  type WebhookPayload,
  type BusinessApiEventHandlers,
  type TemplateMessage,
  type InteractiveMessage,
} from '../../src/messaging/backends/BusinessApiBackend.js';
import { mountWhatsAppWebhooks } from '../../src/messaging/backends/WhatsAppWebhookRoutes.js';
import type { Express, Request, Response } from 'express';

// ── Test helpers ──────────────────────────────────────

function createTestAdapter(tmpDir: string, overrides: Record<string, unknown> = {}): WhatsAppAdapter {
  return new WhatsAppAdapter(
    {
      backend: 'business-api',
      authorizedNumbers: ['+14155552671', '+447911123456'],
      stallTimeoutMinutes: 1,
      requireConsent: false,
      prefixEnabled: false,
      businessApi: {
        phoneNumberId: '123456789',
        accessToken: 'test-token',
        webhookVerifyToken: 'verify-secret',
      },
      ...overrides,
    },
    tmpDir,
  );
}

function createBackendWithAdapter(tmpDir: string, overrides: Record<string, unknown> = {}) {
  const adapter = createTestAdapter(tmpDir, overrides);
  const handlers: BusinessApiEventHandlers = {
    onConnected: vi.fn(),
    onMessage: vi.fn(async (jid, msgId, text, senderName, timestamp) => {
      await adapter.handleIncomingMessage(jid, msgId, text, senderName, timestamp);
    }),
    onButtonReply: vi.fn(),
    onError: vi.fn(),
    onStatusUpdate: vi.fn(),
  };

  const backend = new BusinessApiBackend(
    adapter,
    {
      phoneNumberId: '123456789',
      accessToken: 'test-token',
      webhookVerifyToken: 'verify-secret',
    },
    handlers,
  );

  return { adapter, backend, handlers };
}

function makeTextPayload(from: string, text: string, msgId?: string): WebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'entry-1',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
          contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
          messages: [{
            from,
            id: msgId ?? `wamid.${Date.now()}.${Math.random().toString(36).slice(2)}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
        field: 'messages',
      }],
    }],
  };
}

function makeInteractivePayload(from: string, buttonId: string, buttonTitle: string): WebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'entry-1',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
          contacts: [{ profile: { name: 'Button User' }, wa_id: from }],
          messages: [{
            from,
            id: `wamid.int.${Date.now()}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: buttonId, title: buttonTitle },
            },
          }],
        },
        field: 'messages',
      }],
    }],
  };
}

function mockFetchSuccess(phoneNumber = '+14155551234') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify({ display_phone_number: phoneNumber }), { status: 200 });
  });
}

// ── Tests ──────────────────────────────────────────────

describe('Phase 3: Business API — E2E', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-e2e-'));
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Full webhook-to-adapter lifecycle ──────────────

  describe('full webhook-to-adapter lifecycle', () => {
    it('processes a text webhook through to the message handler', async () => {
      const { adapter, backend, handlers } = createBackendWithAdapter(tmpDir);
      const receivedMessages: Array<{ content: string; userId: string }> = [];

      // Track messages that reach the adapter's message handler
      const messagePromise = new Promise<void>((resolve) => {
        adapter.onMessage(async (msg) => {
          receivedMessages.push({ content: msg.content, userId: msg.userId! });
          resolve();
        });
      });

      // Simulate connect
      const fetchSpy = mockFetchSuccess();
      await backend.connect();

      // Process webhook
      const payload = makeTextPayload('14155552671', 'Hello from Business API');
      await backend.handleWebhook(payload);

      // handlers.onMessage fires synchronously, but the adapter handler is async
      // Wait for it to complete
      await messagePromise;

      expect(handlers.onMessage).toHaveBeenCalledTimes(1);
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].content).toBe('Hello from Business API');
      expect(receivedMessages[0].userId).toBe('+14155552671');

      fetchSpy.mockRestore();
    });

    it('routes commands from webhook payloads', async () => {
      const { adapter, backend } = createBackendWithAdapter(tmpDir);
      const fetchSpy = mockFetchSuccess();
      await backend.connect();

      // Send /status command from authorized user
      const sentMessages: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sentMessages.push(text); });

      await backend.handleWebhook(makeTextPayload('14155552671', '/status'));

      expect(sentMessages.some(m => m.includes('WhatsApp Adapter Status'))).toBe(true);
      fetchSpy.mockRestore();
    });

    it('blocks unauthorized users through auth gate', async () => {
      const { adapter, backend, handlers } = createBackendWithAdapter(tmpDir);
      const receivedMessages: string[] = [];

      adapter.onMessage(async (msg) => { receivedMessages.push(msg.content); });

      const fetchSpy = mockFetchSuccess();
      await backend.connect();

      // Send from unauthorized number
      await backend.handleWebhook(makeTextPayload('19999999999', 'I am unauthorized'));

      // onMessage is called by handler, but adapter's auth gate should block
      expect(handlers.onMessage).toHaveBeenCalledTimes(1);
      expect(receivedMessages).toHaveLength(0); // blocked by auth

      fetchSpy.mockRestore();
    });
  });

  // ── 2. Template and interactive message sending ──────

  describe('template and interactive messages', () => {
    it('sends template messages with components', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ display_phone_number: '+1' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'wamid.tmpl' }] }), { status: 200 }));

      const { backend } = createBackendWithAdapter(tmpDir);
      await backend.connect();

      const template: TemplateMessage = {
        name: 'attention_alert',
        language: 'en_US',
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: 'Your agent needs attention' },
            { type: 'text', text: 'Session: test-session' },
          ],
        }],
      };

      const result = await backend.sendTemplateMessage('14155552671', template);
      expect(result).toBe('wamid.tmpl');

      const lastCall = fetchSpy.mock.calls[1];
      const body = JSON.parse((lastCall[1] as RequestInit).body as string);
      expect(body.type).toBe('template');
      expect(body.template.name).toBe('attention_alert');

      fetchSpy.mockRestore();
    });

    it('sends interactive button messages for attention items', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ display_phone_number: '+1' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'wamid.btn' }] }), { status: 200 }));

      const { backend } = createBackendWithAdapter(tmpDir);
      await backend.connect();

      const message: InteractiveMessage = {
        type: 'button',
        header: { type: 'text', text: 'Agent Alert' },
        body: { text: 'Session "dev" is stalled. What would you like to do?' },
        footer: { text: 'Instar Agent' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'restart', title: 'Restart Session' } },
            { type: 'reply', reply: { id: 'ignore', title: 'Ignore' } },
            { type: 'reply', reply: { id: 'details', title: 'Show Details' } },
          ],
        },
      };

      const result = await backend.sendInteractiveMessage('14155552671', message);
      expect(result).toBe('wamid.btn');

      fetchSpy.mockRestore();
    });

    it('processes interactive button replies back through adapter', async () => {
      const { adapter, backend, handlers } = createBackendWithAdapter(tmpDir);
      const receivedMessages: string[] = [];

      adapter.onMessage(async (msg) => { receivedMessages.push(msg.content); });

      const fetchSpy = mockFetchSuccess();
      await backend.connect();

      const payload = makeInteractivePayload('14155552671', 'restart', 'Restart Session');
      await backend.handleWebhook(payload);

      expect(handlers.onButtonReply).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        expect.stringContaining('wamid.int'),
        'restart',
        'Restart Session',
      );

      fetchSpy.mockRestore();
    });
  });

  // ── 3. Connection lifecycle ──────────────────────────

  describe('connection lifecycle', () => {
    it('tracks connection state through connect-disconnect-reconnect', async () => {
      const { adapter, backend } = createBackendWithAdapter(tmpDir);

      expect(adapter.getStatus().state).toBe('disconnected');

      // Connect
      const fetchSpy = mockFetchSuccess();
      await backend.connect();
      expect(backend.isConnected()).toBe(true);

      // Disconnect
      await backend.disconnect();
      expect(backend.isConnected()).toBe(false);

      // Reconnect
      await backend.connect();
      expect(backend.isConnected()).toBe(true);

      fetchSpy.mockRestore();
    });

    it('handles connection failure then successful retry', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ display_phone_number: '+1' }), { status: 200 }));

      const { backend, handlers } = createBackendWithAdapter(tmpDir);

      // First attempt fails
      await backend.connect();
      expect(backend.isConnected()).toBe(false);
      expect(handlers.onError).toHaveBeenCalledTimes(1);

      // Second attempt succeeds
      await backend.connect();
      expect(backend.isConnected()).toBe(true);
      expect(handlers.onConnected).toHaveBeenCalledTimes(1);

      fetchSpy.mockRestore();
    });
  });

  // ── 4. Status counter accuracy ──────────────────────

  describe('status counter accuracy under load', () => {
    it('accurately tracks message counts across many webhooks', async () => {
      const { backend } = createBackendWithAdapter(tmpDir);
      const messageCount = 100;

      for (let i = 0; i < messageCount; i++) {
        await backend.handleWebhook(makeTextPayload('14155552671', `Message ${i}`));
      }

      const status = backend.getStatus();
      expect(status.messagesReceived).toBe(messageCount);
    });

    it('tracks sent messages accurately', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      // First call is connect, rest are sends
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ display_phone_number: '+1' }), { status: 200 }));

      const sendCount = 20;
      for (let i = 0; i < sendCount; i++) {
        fetchSpy.mockResolvedValueOnce(
          new Response(JSON.stringify({ messages: [{ id: `wamid.${i}` }] }), { status: 200 }),
        );
      }

      const { backend } = createBackendWithAdapter(tmpDir);
      await backend.connect();

      for (let i = 0; i < sendCount; i++) {
        await backend.sendTextMessage('14155552671', `Send ${i}`);
      }

      expect(backend.getStatus().messagesSent).toBe(sendCount);
      fetchSpy.mockRestore();
    });
  });

  // ── 5. Webhook route integration ──────────────────────

  describe('webhook route integration', () => {
    it('full GET verification flow through routes', () => {
      const { backend } = createBackendWithAdapter(tmpDir);

      let getHandler: (req: Request, res: Response) => void;
      const app = {
        get: vi.fn((_path: string, handler: (req: Request, res: Response) => void) => {
          getHandler = handler;
        }),
        post: vi.fn(),
      } as unknown as Express;

      mountWhatsAppWebhooks({ app, backend });

      const res = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response;

      const req = {
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'verify-secret',
          'hub.challenge': 'test-challenge-xyz',
        },
      } as unknown as Request;

      getHandler!(req, res);

      expect((res as any).status).toHaveBeenCalledWith(200);
      expect((res as any).send).toHaveBeenCalledWith('test-challenge-xyz');
    });

    it('full POST webhook flow through routes to adapter', async () => {
      const { adapter, backend } = createBackendWithAdapter(tmpDir);
      const receivedMessages: string[] = [];

      const messagePromise = new Promise<void>((resolve) => {
        adapter.onMessage(async (msg) => {
          receivedMessages.push(msg.content);
          resolve();
        });
      });

      const fetchSpy = mockFetchSuccess();
      await backend.connect();

      let postHandler: (req: Request, res: Response) => Promise<void>;
      const app = {
        get: vi.fn(),
        post: vi.fn((_path: string, handler: (req: Request, res: Response) => Promise<void>) => {
          postHandler = handler;
        }),
      } as unknown as Express;

      mountWhatsAppWebhooks({ app, backend });

      const res = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as unknown as Response;

      const payload = makeTextPayload('14155552671', 'Through the routes');
      const req = { body: payload } as unknown as Request;

      await postHandler!(req, res);
      await messagePromise;

      expect((res as any).status).toHaveBeenCalledWith(200);
      expect((res as any).send).toHaveBeenCalledWith('EVENT_RECEIVED');
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toBe('Through the routes');

      fetchSpy.mockRestore();
    });
  });

  // ── 6. Adversarial webhook payloads ──────────────────

  describe('adversarial webhook payloads', () => {
    it('handles payload with null bytes in message text', async () => {
      const { backend, handlers } = createBackendWithAdapter(tmpDir);
      const payload = makeTextPayload('14155552671', 'Hello\x00World\x00!');
      await backend.handleWebhook(payload);
      expect(handlers.onMessage).toHaveBeenCalledTimes(1);
    });

    it('handles payload with extremely long phone numbers', async () => {
      const { backend, handlers } = createBackendWithAdapter(tmpDir);
      const longPhone = '1'.repeat(50);
      const payload = makeTextPayload(longPhone, 'Long phone');
      await backend.handleWebhook(payload);
      expect(handlers.onMessage).toHaveBeenCalledTimes(1);
    });

    it('handles payload with unicode in sender name', async () => {
      const { backend, handlers } = createBackendWithAdapter(tmpDir);
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'e1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
              contacts: [{ profile: { name: '测试用户 🚀 إختبار' }, wa_id: '14155552671' }],
              messages: [{
                from: '14155552671',
                id: 'wamid.unicode',
                timestamp: '1700000000',
                type: 'text',
                text: { body: 'Unicode test' },
              }],
            },
            field: 'messages',
          }],
        }],
      };

      await backend.handleWebhook(payload);
      expect(handlers.onMessage).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'wamid.unicode',
        'Unicode test',
        '测试用户 🚀 إختبار',
        1700000000,
      );
    });

    it('handles payload with JSON injection in text', async () => {
      const { backend, handlers } = createBackendWithAdapter(tmpDir);
      const maliciousText = '{"__proto__":{"isAdmin":true}}';
      const payload = makeTextPayload('14155552671', maliciousText);
      await backend.handleWebhook(payload);
      expect(handlers.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        maliciousText,
        expect.any(String),
        expect.any(Number),
      );
    });

    it('handles rapid sequential webhooks without data corruption', async () => {
      const { backend, handlers } = createBackendWithAdapter(tmpDir);
      const promises = [];
      const count = 50;

      for (let i = 0; i < count; i++) {
        promises.push(backend.handleWebhook(
          makeTextPayload('14155552671', `Rapid message ${i}`),
        ));
      }

      await Promise.all(promises);
      expect(handlers.onMessage).toHaveBeenCalledTimes(count);
      expect(backend.getStatus().messagesReceived).toBe(count);
    });

    it('skips messages with empty text body (falsy check)', async () => {
      const { backend, handlers } = createBackendWithAdapter(tmpDir);
      const payload = makeTextPayload('14155552671', '');
      await backend.handleWebhook(payload);
      // Empty string is falsy → msg.text?.body check skips it
      expect(handlers.onMessage).not.toHaveBeenCalled();
      // But message is still counted as received
      expect(backend.getStatus().messagesReceived).toBe(1);
    });

    it('survives malformed object field', async () => {
      const { backend, handlers } = createBackendWithAdapter(tmpDir);
      await backend.handleWebhook({
        object: 'page',
        entry: [{
          id: 'e1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
            },
            field: 'messages',
          }],
        }],
      });
      expect(handlers.onMessage).not.toHaveBeenCalled();
    });

    it('handles mixed messages and statuses in single payload', async () => {
      const { backend, handlers } = createBackendWithAdapter(tmpDir);
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'e1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
              contacts: [{ profile: { name: 'User' }, wa_id: '14155552671' }],
              messages: [
                { from: '14155552671', id: 'msg-1', timestamp: '1700000001', type: 'text', text: { body: 'Hello' } },
              ],
              statuses: [
                { id: 'wamid.old', status: 'delivered', timestamp: '1700000000' },
                { id: 'wamid.old2', status: 'read', timestamp: '1700000001' },
              ],
            },
            field: 'messages',
          }],
        }],
      };

      await backend.handleWebhook(payload);
      expect(handlers.onMessage).toHaveBeenCalledTimes(1);
      expect(handlers.onStatusUpdate).toHaveBeenCalledTimes(2);
    });
  });

  // ── 7. Concurrent webhook processing ──────────────────

  describe('concurrent webhook processing', () => {
    it('handles webhooks from multiple users simultaneously', async () => {
      const { adapter, backend, handlers } = createBackendWithAdapter(tmpDir, {
        authorizedNumbers: ['+14155552671', '+447911123456', '+5511999998888'],
      });

      const receivedByUser = new Map<string, string[]>();
      adapter.onMessage(async (msg) => {
        const existing = receivedByUser.get(msg.userId!) ?? [];
        existing.push(msg.content);
        receivedByUser.set(msg.userId!, existing);
      });

      const fetchSpy = mockFetchSuccess();
      await backend.connect();

      const users = ['14155552671', '447911123456', '5511999998888'];
      const messagesPerUser = 10;
      const promises = [];

      for (const user of users) {
        for (let i = 0; i < messagesPerUser; i++) {
          promises.push(backend.handleWebhook(
            makeTextPayload(user, `User ${user} msg ${i}`),
          ));
        }
      }

      await Promise.all(promises);
      expect(handlers.onMessage).toHaveBeenCalledTimes(users.length * messagesPerUser);

      fetchSpy.mockRestore();
    });
  });

  // ── 8. Send failure resilience ──────────────────────

  describe('send failure resilience', () => {
    it('throws on API errors without corrupting state', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ display_phone_number: '+1' }), { status: 200 }))
        .mockResolvedValueOnce(new Response('Rate limited', { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'ok' }] }), { status: 200 }));

      const { backend } = createBackendWithAdapter(tmpDir);
      await backend.connect();

      // First send fails
      await expect(backend.sendTextMessage('14155552671', 'fail')).rejects.toThrow();
      expect(backend.getStatus().messagesSent).toBe(0); // not incremented on failure

      // Second send succeeds
      const result = await backend.sendTextMessage('14155552671', 'succeed');
      expect(result).toBe('ok');
      expect(backend.getStatus().messagesSent).toBe(1);

      fetchSpy.mockRestore();
    });

    it('interactive message enforces 3-button max before API call', async () => {
      const { backend } = createBackendWithAdapter(tmpDir);

      const message: InteractiveMessage = {
        type: 'button',
        body: { text: 'Too many' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: '1', title: 'A' } },
            { type: 'reply', reply: { id: '2', title: 'B' } },
            { type: 'reply', reply: { id: '3', title: 'C' } },
            { type: 'reply', reply: { id: '4', title: 'D' } },
          ],
        },
      };

      // Should throw locally, never calling fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(backend.sendInteractiveMessage('14155552671', message)).rejects.toThrow('maximum of 3 buttons');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  // ── 9. Cross-backend adapter consistency ──────────────

  describe('cross-backend adapter consistency', () => {
    it('adapter works identically whether backend is baileys or business-api', async () => {
      // Create adapter configured for business-api
      const adapter = createTestAdapter(tmpDir);

      const messages: string[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg.content); });

      // Simulate what BusinessApiBackend does: inject send function and set state
      const sentMessages: Array<{ jid: string; text: string }> = [];
      adapter.setSendFunction(async (jid, text) => { sentMessages.push({ jid, text }); });
      await adapter.setConnectionState('connected', '+14155551234');

      // Process a message (same as Baileys would call)
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-cross-1',
        'Cross-backend test',
        'Test User',
        Math.floor(Date.now() / 1000),
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe('Cross-backend test');

      // Send a message through adapter
      await adapter.send({
        content: 'Reply from adapter',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe('Reply from adapter');
    });

    it('adapter queues messages when business API disconnects', async () => {
      const adapter = createTestAdapter(tmpDir);
      const sentJids: string[] = [];

      // Start disconnected (no send function yet)
      await adapter.send({
        content: 'Queued while offline',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      // Now connect — queue should flush
      adapter.setSendFunction(async (jid, _text) => { sentJids.push(jid); });
      await adapter.setConnectionState('connected', '+1');

      expect(sentJids).toHaveLength(1);
      expect(sentJids[0]).toBe('14155552671@s.whatsapp.net');
    });
  });

  // ── 10. Mega stress test ──────────────────────────────

  describe('mega stress test', () => {
    it('handles 200 webhooks with mixed types, counters stay accurate', async () => {
      const { backend, handlers } = createBackendWithAdapter(tmpDir);
      const textCount = 150;
      const statusCount = 30;
      const interactiveCount = 20;

      const promises: Promise<void>[] = [];

      // Text messages
      for (let i = 0; i < textCount; i++) {
        promises.push(backend.handleWebhook(makeTextPayload('14155552671', `Stress ${i}`)));
      }

      // Status updates
      for (let i = 0; i < statusCount; i++) {
        promises.push(backend.handleWebhook({
          object: 'whatsapp_business_account',
          entry: [{
            id: `se-${i}`,
            changes: [{
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
                statuses: [{ id: `wamid.s${i}`, status: 'delivered', timestamp: '1700000000' }],
              },
              field: 'messages',
            }],
          }],
        }));
      }

      // Interactive messages
      for (let i = 0; i < interactiveCount; i++) {
        promises.push(backend.handleWebhook(
          makeInteractivePayload('14155552671', `btn-${i}`, `Button ${i}`),
        ));
      }

      await Promise.all(promises);

      const status = backend.getStatus();
      // Text + interactive = total received (each interactive counts as 1 message)
      expect(status.messagesReceived).toBe(textCount + interactiveCount);

      expect(handlers.onMessage).toHaveBeenCalledTimes(textCount + interactiveCount);
      expect(handlers.onButtonReply).toHaveBeenCalledTimes(interactiveCount);
      expect(handlers.onStatusUpdate).toHaveBeenCalledTimes(statusCount);
    });
  });
});
