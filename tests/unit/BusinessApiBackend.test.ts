import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BusinessApiBackend,
  type WebhookPayload,
  type BusinessApiEventHandlers,
  type TemplateMessage,
  type InteractiveMessage,
} from '../../src/messaging/backends/BusinessApiBackend.js';
import type { WhatsAppAdapter, BusinessApiConfig } from '../../src/messaging/WhatsAppAdapter.js';

// ── Test helpers ──────────────────────────────────────────

function createMockAdapter(): WhatsAppAdapter {
  return {
    setConnectionState: vi.fn().mockResolvedValue(undefined),
    setSendFunction: vi.fn(),
  } as unknown as WhatsAppAdapter;
}

function createMockHandlers(): BusinessApiEventHandlers {
  return {
    onConnected: vi.fn(),
    onMessage: vi.fn(),
    onButtonReply: vi.fn(),
    onError: vi.fn(),
    onStatusUpdate: vi.fn(),
  };
}

function createConfig(overrides: Partial<BusinessApiConfig> = {}): BusinessApiConfig {
  return {
    phoneNumberId: '123456789',
    accessToken: 'test-access-token',
    webhookVerifyToken: 'test-verify-token',
    ...overrides,
  };
}

function createBackend(
  configOverrides: Partial<BusinessApiConfig> = {},
  adapter?: WhatsAppAdapter,
  handlers?: BusinessApiEventHandlers,
) {
  const a = adapter ?? createMockAdapter();
  const h = handlers ?? createMockHandlers();
  const c = createConfig(configOverrides);
  return { backend: new BusinessApiBackend(a, c, h), adapter: a, handlers: h, config: c };
}

function makeTextWebhookPayload(from: string, text: string, messageId = 'wamid.test123'): WebhookPayload {
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
            id: messageId,
            timestamp: '1700000000',
            type: 'text',
            text: { body: text },
          }],
        },
        field: 'messages',
      }],
    }],
  };
}

function makeStatusWebhookPayload(messageId: string, status: string): WebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'entry-1',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
          statuses: [{ id: messageId, status, timestamp: '1700000000' }],
        },
        field: 'messages',
      }],
    }],
  };
}

function makeInteractiveWebhookPayload(
  from: string,
  buttonId: string,
  buttonTitle: string,
  messageId = 'wamid.interactive123',
): WebhookPayload {
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
            id: messageId,
            timestamp: '1700000000',
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

// ── Tests ──────────────────────────────────────────────

describe('BusinessApiBackend', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Connection ──────────────────────────────────────

  describe('connect', () => {
    it('verifies access token by calling Meta API', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ display_phone_number: '+14155551234' }), { status: 200 }),
      );

      const { backend, adapter, handlers } = createBackend();
      await backend.connect();

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://graph.facebook.com/v21.0/123456789',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-access-token' },
        }),
      );
      expect(adapter.setConnectionState).toHaveBeenCalledWith('connected', '+14155551234');
      expect(adapter.setSendFunction).toHaveBeenCalled();
      expect(handlers.onConnected).toHaveBeenCalledWith('+14155551234');
    });

    it('handles auth failure gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401 }),
      );

      const { backend, adapter, handlers } = createBackend();
      await backend.connect();

      expect(handlers.onError).toHaveBeenCalledWith(expect.any(Error));
      expect(adapter.setConnectionState).toHaveBeenCalledWith('disconnected');
    });

    it('handles network failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const { backend, adapter, handlers } = createBackend();
      await backend.connect();

      expect(handlers.onError).toHaveBeenCalledWith(expect.any(Error));
      expect(adapter.setConnectionState).toHaveBeenCalledWith('disconnected');
    });

    it('uses "unknown" when display_phone_number is missing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      const { backend, adapter, handlers } = createBackend();
      await backend.connect();

      expect(adapter.setConnectionState).toHaveBeenCalledWith('connected', 'unknown');
      expect(handlers.onConnected).toHaveBeenCalledWith('unknown');
    });
  });

  // ── Disconnect ──────────────────────────────────────

  describe('disconnect', () => {
    it('sets state to closed', async () => {
      const { backend, adapter } = createBackend();
      await backend.disconnect();

      expect(adapter.setConnectionState).toHaveBeenCalledWith('closed');
      expect(backend.isConnected()).toBe(false);
    });
  });

  // ── Webhook verification ──────────────────────────────

  describe('verifyWebhook', () => {
    it('returns challenge when mode and token match', () => {
      const { backend } = createBackend();
      const result = backend.verifyWebhook('subscribe', 'test-verify-token', 'challenge123');
      expect(result).toBe('challenge123');
    });

    it('returns null for wrong verify token', () => {
      const { backend } = createBackend();
      const result = backend.verifyWebhook('subscribe', 'wrong-token', 'challenge123');
      expect(result).toBeNull();
    });

    it('returns null for wrong mode', () => {
      const { backend } = createBackend();
      const result = backend.verifyWebhook('unsubscribe', 'test-verify-token', 'challenge123');
      expect(result).toBeNull();
    });

    it('returns null for empty token', () => {
      const { backend } = createBackend();
      const result = backend.verifyWebhook('subscribe', '', 'challenge123');
      expect(result).toBeNull();
    });
  });

  // ── Webhook message handling ──────────────────────────

  describe('handleWebhook', () => {
    it('processes text messages', async () => {
      const { backend, handlers } = createBackend();
      const payload = makeTextWebhookPayload('14155552671', 'Hello world');

      await backend.handleWebhook(payload);

      expect(handlers.onMessage).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'wamid.test123',
        'Hello world',
        'Test User',
        1700000000,
      );
    });

    it('processes interactive button replies', async () => {
      const { backend, handlers } = createBackend();
      const payload = makeInteractiveWebhookPayload('14155552671', 'btn-1', 'Approve');

      await backend.handleWebhook(payload);

      expect(handlers.onButtonReply).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'wamid.interactive123',
        'btn-1',
        'Approve',
      );
      // Also forwarded as text
      expect(handlers.onMessage).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'wamid.interactive123',
        'Approve',
        'Test User',
        1700000000,
      );
    });

    it('processes status updates', async () => {
      const { backend, handlers } = createBackend();
      const payload = makeStatusWebhookPayload('wamid.sent123', 'delivered');

      await backend.handleWebhook(payload);

      expect(handlers.onStatusUpdate).toHaveBeenCalledWith('wamid.sent123', 'delivered');
    });

    it('ignores non-whatsapp_business_account payloads', async () => {
      const { backend, handlers } = createBackend();
      const payload = { object: 'instagram', entry: [] } as unknown as WebhookPayload;

      await backend.handleWebhook(payload);

      expect(handlers.onMessage).not.toHaveBeenCalled();
    });

    it('ignores changes with non-messages field', async () => {
      const { backend, handlers } = createBackend();
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'entry-1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
            },
            field: 'account_update',
          }],
        }],
      };

      await backend.handleWebhook(payload);
      expect(handlers.onMessage).not.toHaveBeenCalled();
    });

    it('processes image messages with captions', async () => {
      const { backend, handlers } = createBackend();
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'entry-1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
              contacts: [{ profile: { name: 'Photo User' }, wa_id: '14155552671' }],
              messages: [{
                from: '14155552671',
                id: 'wamid.img123',
                timestamp: '1700000000',
                type: 'image',
                image: { id: 'img-id', mime_type: 'image/jpeg', caption: 'Check this out' },
              }],
            },
            field: 'messages',
          }],
        }],
      };

      await backend.handleWebhook(payload);

      expect(handlers.onMessage).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'wamid.img123',
        'Check this out',
        'Photo User',
        1700000000,
      );
    });

    it('ignores image messages without captions', async () => {
      const { backend, handlers } = createBackend();
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'entry-1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
              messages: [{
                from: '14155552671',
                id: 'wamid.img-nocap',
                timestamp: '1700000000',
                type: 'image',
                image: { id: 'img-id', mime_type: 'image/jpeg' },
              }],
            },
            field: 'messages',
          }],
        }],
      };

      await backend.handleWebhook(payload);
      expect(handlers.onMessage).not.toHaveBeenCalled();
    });

    it('handles multiple messages in one payload', async () => {
      const { backend, handlers } = createBackend();
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'entry-1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
              contacts: [{ profile: { name: 'User' }, wa_id: '14155552671' }],
              messages: [
                { from: '14155552671', id: 'msg-1', timestamp: '1700000001', type: 'text', text: { body: 'First' } },
                { from: '14155552671', id: 'msg-2', timestamp: '1700000002', type: 'text', text: { body: 'Second' } },
                { from: '14155552671', id: 'msg-3', timestamp: '1700000003', type: 'text', text: { body: 'Third' } },
              ],
            },
            field: 'messages',
          }],
        }],
      };

      await backend.handleWebhook(payload);
      expect(handlers.onMessage).toHaveBeenCalledTimes(3);
    });

    it('handles multiple entries in one payload', async () => {
      const { backend, handlers } = createBackend();
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'entry-1',
            changes: [{
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
                contacts: [{ profile: { name: 'User A' }, wa_id: '14155552671' }],
                messages: [{ from: '14155552671', id: 'msg-a', timestamp: '1700000001', type: 'text', text: { body: 'From A' } }],
              },
              field: 'messages',
            }],
          },
          {
            id: 'entry-2',
            changes: [{
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
                contacts: [{ profile: { name: 'User B' }, wa_id: '447911123456' }],
                messages: [{ from: '447911123456', id: 'msg-b', timestamp: '1700000002', type: 'text', text: { body: 'From B' } }],
              },
              field: 'messages',
            }],
          },
        ],
      };

      await backend.handleWebhook(payload);
      expect(handlers.onMessage).toHaveBeenCalledTimes(2);
    });

    it('updates lastWebhookReceived timestamp', async () => {
      const { backend } = createBackend();
      const statusBefore = backend.getStatus();
      expect(statusBefore.lastWebhookReceived).toBeNull();

      await backend.handleWebhook(makeTextWebhookPayload('14155552671', 'hi'));

      const statusAfter = backend.getStatus();
      expect(statusAfter.lastWebhookReceived).not.toBeNull();
    });

    it('increments messagesReceived counter', async () => {
      const { backend } = createBackend();
      expect(backend.getStatus().messagesReceived).toBe(0);

      await backend.handleWebhook(makeTextWebhookPayload('14155552671', 'hello'));
      expect(backend.getStatus().messagesReceived).toBe(1);

      await backend.handleWebhook(makeTextWebhookPayload('14155552671', 'world', 'wamid.2'));
      expect(backend.getStatus().messagesReceived).toBe(2);
    });

    it('handles list_reply interactive messages', async () => {
      const { backend, handlers } = createBackend();
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'entry-1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
              contacts: [{ profile: { name: 'User' }, wa_id: '14155552671' }],
              messages: [{
                from: '14155552671',
                id: 'wamid.list',
                timestamp: '1700000000',
                type: 'interactive',
                interactive: {
                  type: 'list_reply',
                  list_reply: { id: 'list-1', title: 'Option A', description: 'First option' },
                },
              }],
            },
            field: 'messages',
          }],
        }],
      };

      await backend.handleWebhook(payload);

      expect(handlers.onButtonReply).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'wamid.list',
        'list-1',
        'Option A',
      );
    });
  });

  // ── Sending messages ──────────────────────────────────

  describe('sendTextMessage', () => {
    it('sends a text message via Meta API', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.sent1' }] }), { status: 200 }),
      );

      const { backend } = createBackend();
      const result = await backend.sendTextMessage('14155552671@s.whatsapp.net', 'Hello!');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://graph.facebook.com/v21.0/123456789/messages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: '14155552671',
            type: 'text',
            text: { body: 'Hello!' },
          }),
        }),
      );
      expect(result).toBe('wamid.sent1');
    });

    it('strips @s.whatsapp.net suffix from phone number', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.sent2' }] }), { status: 200 }),
      );

      const { backend } = createBackend();
      await backend.sendTextMessage('447911123456@s.whatsapp.net', 'Test');

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.to).toBe('447911123456');
    });

    it('works with plain phone number (no JID suffix)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.sent3' }] }), { status: 200 }),
      );

      const { backend } = createBackend();
      const result = await backend.sendTextMessage('14155552671', 'Direct');
      expect(result).toBe('wamid.sent3');
    });

    it('throws on API failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Rate limited', { status: 429 }),
      );

      const { backend } = createBackend();
      await expect(backend.sendTextMessage('14155552671', 'Hi')).rejects.toThrow('Business API send failed (429)');
    });

    it('increments messagesSent counter', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'wamid.x1' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'wamid.x2' }] }), { status: 200 }));

      const { backend } = createBackend();
      expect(backend.getStatus().messagesSent).toBe(0);

      await backend.sendTextMessage('14155552671', 'One');
      expect(backend.getStatus().messagesSent).toBe(1);

      await backend.sendTextMessage('14155552671', 'Two');
      expect(backend.getStatus().messagesSent).toBe(2);
    });

    it('returns null when API response has no messages array', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      const { backend } = createBackend();
      const result = await backend.sendTextMessage('14155552671', 'Test');
      expect(result).toBeNull();
    });
  });

  describe('sendTemplateMessage', () => {
    it('sends a template message via Meta API', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.tmpl1' }] }), { status: 200 }),
      );

      const { backend } = createBackend();
      const template: TemplateMessage = {
        name: 'hello_world',
        language: 'en_US',
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'John' }] }],
      };

      const result = await backend.sendTemplateMessage('14155552671', template);

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.type).toBe('template');
      expect(body.template.name).toBe('hello_world');
      expect(body.template.language.code).toBe('en_US');
      expect(body.template.components).toEqual(template.components);
      expect(result).toBe('wamid.tmpl1');
    });

    it('strips JID suffix from recipient', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.tmpl2' }] }), { status: 200 }),
      );

      const { backend } = createBackend();
      await backend.sendTemplateMessage('14155552671@s.whatsapp.net', {
        name: 'test',
        language: 'en_US',
      });

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.to).toBe('14155552671');
    });

    it('throws on API failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Bad template', { status: 400 }),
      );

      const { backend } = createBackend();
      await expect(
        backend.sendTemplateMessage('14155552671', { name: 'bad', language: 'en_US' }),
      ).rejects.toThrow('Template send failed (400)');
    });
  });

  describe('sendInteractiveMessage', () => {
    it('sends an interactive button message', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.int1' }] }), { status: 200 }),
      );

      const { backend } = createBackend();
      const message: InteractiveMessage = {
        type: 'button',
        body: { text: 'Choose an option:' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'btn-1', title: 'Yes' } },
            { type: 'reply', reply: { id: 'btn-2', title: 'No' } },
          ],
        },
      };

      const result = await backend.sendInteractiveMessage('14155552671', message);

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.type).toBe('interactive');
      expect(body.interactive.type).toBe('button');
      expect(body.interactive.action.buttons).toHaveLength(2);
      expect(result).toBe('wamid.int1');
    });

    it('throws when more than 3 buttons are provided', async () => {
      const { backend } = createBackend();
      const message: InteractiveMessage = {
        type: 'button',
        body: { text: 'Too many buttons:' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: '1', title: 'A' } },
            { type: 'reply', reply: { id: '2', title: 'B' } },
            { type: 'reply', reply: { id: '3', title: 'C' } },
            { type: 'reply', reply: { id: '4', title: 'D' } },
          ],
        },
      };

      await expect(
        backend.sendInteractiveMessage('14155552671', message),
      ).rejects.toThrow('maximum of 3 buttons');
    });

    it('includes header and footer when provided', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.int2' }] }), { status: 200 }),
      );

      const { backend } = createBackend();
      const message: InteractiveMessage = {
        type: 'button',
        header: { type: 'text', text: 'Important' },
        body: { text: 'Choose:' },
        footer: { text: 'Reply within 24h' },
        action: {
          buttons: [{ type: 'reply', reply: { id: 'ok', title: 'OK' } }],
        },
      };

      await backend.sendInteractiveMessage('14155552671', message);

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.interactive.header.text).toBe('Important');
      expect(body.interactive.footer.text).toBe('Reply within 24h');
    });

    it('throws on API failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Server error', { status: 500 }),
      );

      const { backend } = createBackend();
      const message: InteractiveMessage = {
        type: 'button',
        body: { text: 'Test' },
        action: { buttons: [{ type: 'reply', reply: { id: '1', title: 'OK' } }] },
      };

      await expect(
        backend.sendInteractiveMessage('14155552671', message),
      ).rejects.toThrow('Interactive send failed (500)');
    });
  });

  // ── Status ──────────────────────────────────────────

  describe('getStatus', () => {
    it('returns initial status', () => {
      const { backend } = createBackend();
      const status = backend.getStatus();

      expect(status).toEqual({
        connected: false,
        phoneNumberId: '123456789',
        webhookConfigured: true,
        lastWebhookReceived: null,
        messagesSent: 0,
        messagesReceived: 0,
      });
    });

    it('reflects webhookConfigured based on verify token', () => {
      const { backend } = createBackend({ webhookVerifyToken: '' });
      expect(backend.getStatus().webhookConfigured).toBe(false);
    });

    it('tracks connected state after successful connect', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ display_phone_number: '+14155551234' }), { status: 200 }),
      );

      const { backend } = createBackend();
      await backend.connect();

      expect(backend.isConnected()).toBe(true);
      expect(backend.getStatus().connected).toBe(true);
    });
  });

  // ── Adversarial inputs ──────────────────────────────

  describe('adversarial inputs', () => {
    it('handles empty entry array', async () => {
      const { backend, handlers } = createBackend();
      await backend.handleWebhook({
        object: 'whatsapp_business_account',
        entry: [],
      });
      expect(handlers.onMessage).not.toHaveBeenCalled();
    });

    it('handles empty changes array', async () => {
      const { backend, handlers } = createBackend();
      await backend.handleWebhook({
        object: 'whatsapp_business_account',
        entry: [{ id: 'e1', changes: [] }],
      });
      expect(handlers.onMessage).not.toHaveBeenCalled();
    });

    it('handles missing messages and statuses', async () => {
      const { backend, handlers } = createBackend();
      await backend.handleWebhook({
        object: 'whatsapp_business_account',
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
      expect(handlers.onStatusUpdate).not.toHaveBeenCalled();
    });

    it('handles missing contacts (no sender name)', async () => {
      const { backend, handlers } = createBackend();
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'e1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
              messages: [{
                from: '14155552671',
                id: 'wamid.nocontact',
                timestamp: '1700000000',
                type: 'text',
                text: { body: 'No contact info' },
              }],
            },
            field: 'messages',
          }],
        }],
      };

      await backend.handleWebhook(payload);

      expect(handlers.onMessage).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'wamid.nocontact',
        'No contact info',
        undefined,
        1700000000,
      );
    });

    it('handles unsupported message types (audio, video, document)', async () => {
      const { backend, handlers } = createBackend();
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'e1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
              messages: [{
                from: '14155552671',
                id: 'wamid.audio',
                timestamp: '1700000000',
                type: 'audio',
                audio: { id: 'audio-id', mime_type: 'audio/ogg' },
              }],
            },
            field: 'messages',
          }],
        }],
      };

      await backend.handleWebhook(payload);
      // Audio without text should not trigger onMessage
      expect(handlers.onMessage).not.toHaveBeenCalled();
    });

    it('handles very long text messages', async () => {
      const { backend, handlers } = createBackend();
      const longText = 'A'.repeat(100_000);
      const payload = makeTextWebhookPayload('14155552671', longText, 'wamid.long');

      await backend.handleWebhook(payload);

      expect(handlers.onMessage).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'wamid.long',
        longText,
        'Test User',
        1700000000,
      );
    });

    it('handles interactive message with no reply data', async () => {
      const { backend, handlers } = createBackend();
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'e1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
              messages: [{
                from: '14155552671',
                id: 'wamid.noreply',
                timestamp: '1700000000',
                type: 'interactive',
                interactive: { type: 'button_reply' },
              }],
            },
            field: 'messages',
          }],
        }],
      };

      await backend.handleWebhook(payload);
      // No button_reply or list_reply data → no callback
      expect(handlers.onButtonReply).not.toHaveBeenCalled();
      expect(handlers.onMessage).not.toHaveBeenCalled();
    });
  });

  // ── Send function injection ──────────────────────────

  describe('send function injection', () => {
    it('injects send function into adapter on connect', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ display_phone_number: '+14155551234' }), { status: 200 }),
      );

      const adapter = createMockAdapter();
      const { backend } = createBackend({}, adapter);
      await backend.connect();

      expect(adapter.setSendFunction).toHaveBeenCalledWith(expect.any(Function));

      // The injected function should call sendTextMessage
      const injectedFn = (adapter.setSendFunction as ReturnType<typeof vi.fn>).mock.calls[0][0];

      const fetchSpy2 = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.injected' }] }), { status: 200 }),
      );

      await injectedFn('14155552671@s.whatsapp.net', 'Via injected fn');
      expect(fetchSpy2).toHaveBeenCalled();
    });
  });
});
