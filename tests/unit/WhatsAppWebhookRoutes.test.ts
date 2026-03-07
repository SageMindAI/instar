import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, Express } from 'express';
import { mountWhatsAppWebhooks } from '../../src/messaging/backends/WhatsAppWebhookRoutes.js';
import type { BusinessApiBackend, WebhookPayload } from '../../src/messaging/backends/BusinessApiBackend.js';

// ── Mock helpers ──────────────────────────────────────

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

function createMockApp() {
  const routes: Record<string, Record<string, RouteHandler>> = {};

  const app = {
    get: vi.fn((path: string, handler: RouteHandler) => {
      routes[`GET:${path}`] = routes[`GET:${path}`] || {};
      routes[`GET:${path}`].handler = handler;
    }),
    post: vi.fn((path: string, handler: RouteHandler) => {
      routes[`POST:${path}`] = routes[`POST:${path}`] || {};
      routes[`POST:${path}`].handler = handler;
    }),
  } as unknown as Express;

  return { app, routes };
}

function createMockBackend(overrides: Partial<BusinessApiBackend> = {}) {
  return {
    verifyWebhook: vi.fn().mockReturnValue(null),
    handleWebhook: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as BusinessApiBackend;
}

function createMockReq(query: Record<string, string> = {}, body: unknown = {}): Request {
  return { query, body } as unknown as Request;
}

function createMockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & typeof res;
}

// ── Tests ──────────────────────────────────────────────

describe('WhatsAppWebhookRoutes', () => {
  describe('mountWhatsAppWebhooks', () => {
    it('mounts GET and POST routes on default path', () => {
      const { app } = createMockApp();
      const backend = createMockBackend();

      mountWhatsAppWebhooks({ app, backend });

      expect(app.get).toHaveBeenCalledWith('/webhooks/whatsapp', expect.any(Function));
      expect(app.post).toHaveBeenCalledWith('/webhooks/whatsapp', expect.any(Function));
    });

    it('mounts routes on custom path', () => {
      const { app } = createMockApp();
      const backend = createMockBackend();

      mountWhatsAppWebhooks({ app, backend, path: '/api/webhooks/wa' });

      expect(app.get).toHaveBeenCalledWith('/api/webhooks/wa', expect.any(Function));
      expect(app.post).toHaveBeenCalledWith('/api/webhooks/wa', expect.any(Function));
    });
  });

  describe('GET verification endpoint', () => {
    let getHandler: RouteHandler;
    let backend: BusinessApiBackend;

    beforeEach(() => {
      const { app } = createMockApp();
      backend = createMockBackend();
      mountWhatsAppWebhooks({ app, backend });
      getHandler = (app.get as ReturnType<typeof vi.fn>).mock.calls[0][1];
    });

    it('returns 200 with challenge when verification succeeds', () => {
      (backend.verifyWebhook as ReturnType<typeof vi.fn>).mockReturnValue('challenge-abc');

      const req = createMockReq({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-token',
        'hub.challenge': 'challenge-abc',
      });
      const res = createMockRes();

      getHandler(req, res);

      expect(backend.verifyWebhook).toHaveBeenCalledWith('subscribe', 'test-token', 'challenge-abc');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith('challenge-abc');
    });

    it('returns 403 when verification fails', () => {
      (backend.verifyWebhook as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const req = createMockReq({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'challenge-abc',
      });
      const res = createMockRes();

      getHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Verification failed' });
    });

    it('returns 400 when mode is missing', () => {
      const req = createMockReq({
        'hub.verify_token': 'token',
        'hub.challenge': 'challenge',
      });
      const res = createMockRes();

      getHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing verification parameters' });
    });

    it('returns 400 when token is missing', () => {
      const req = createMockReq({
        'hub.mode': 'subscribe',
        'hub.challenge': 'challenge',
      });
      const res = createMockRes();

      getHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when challenge is missing', () => {
      const req = createMockReq({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'token',
      });
      const res = createMockRes();

      getHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when all params are missing', () => {
      const req = createMockReq({});
      const res = createMockRes();

      getHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(backend.verifyWebhook).not.toHaveBeenCalled();
    });
  });

  describe('POST message delivery endpoint', () => {
    let postHandler: RouteHandler;
    let backend: BusinessApiBackend;

    beforeEach(() => {
      const { app } = createMockApp();
      backend = createMockBackend();
      mountWhatsAppWebhooks({ app, backend });
      postHandler = (app.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
    });

    it('returns 200 EVENT_RECEIVED immediately', async () => {
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [],
      };
      const req = createMockReq({}, payload);
      const res = createMockRes();

      await postHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith('EVENT_RECEIVED');
    });

    it('calls backend.handleWebhook with payload', async () => {
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
                id: 'wamid.test',
                timestamp: '1700000000',
                type: 'text',
                text: { body: 'Hello' },
              }],
            },
            field: 'messages',
          }],
        }],
      };
      const req = createMockReq({}, payload);
      const res = createMockRes();

      await postHandler(req, res);

      expect(backend.handleWebhook).toHaveBeenCalledWith(payload);
    });

    it('does not call handleWebhook for null body', async () => {
      const req = createMockReq({}, null);
      const res = createMockRes();

      await postHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(backend.handleWebhook).not.toHaveBeenCalled();
    });

    it('does not call handleWebhook for body without object field', async () => {
      const req = createMockReq({}, { data: 'something' });
      const res = createMockRes();

      await postHandler(req, res);

      expect(backend.handleWebhook).not.toHaveBeenCalled();
    });

    it('catches and logs errors from handleWebhook', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (backend.handleWebhook as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Processing failed'));

      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [],
      };
      const req = createMockReq({}, payload);
      const res = createMockRes();

      await postHandler(req, res);

      // Should still return 200
      expect(res.status).toHaveBeenCalledWith(200);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error processing webhook'),
      );

      consoleSpy.mockRestore();
    });
  });
});
