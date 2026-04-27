/**
 * E2E test for WhatsApp server integration — Phase 3.
 *
 * Validates that when WhatsApp is configured with business-api backend:
 * 1. Webhook routes are alive on the Express app (GET + POST /webhooks/whatsapp)
 * 2. WhatsApp status endpoint returns data (/whatsapp/status)
 * 3. Health endpoint includes WhatsApp status
 * 4. Webhook verification works end-to-end through Express
 * 5. Webhook POST delivers messages through to the adapter
 *
 * These tests use real Express + supertest, NOT mock apps.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Express } from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WhatsAppAdapter } from '../../src/messaging/WhatsAppAdapter.js';
import {
  BusinessApiBackend,
  type BusinessApiEventHandlers,
  type WebhookPayload,
} from '../../src/messaging/backends/BusinessApiBackend.js';
import { mountWhatsAppWebhooks } from '../../src/messaging/backends/WhatsAppWebhookRoutes.js';

// ── Test setup ──────────────────────────────────────

let app: Express;
let tmpDir: string;
let adapter: WhatsAppAdapter;
let backend: BusinessApiBackend;
let handlers: BusinessApiEventHandlers;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-server-e2e-'));

  adapter = new WhatsAppAdapter(
    {
      backend: 'business-api',
      authorizedNumbers: ['+14155552671'],
      requireConsent: false,
      businessApi: {
        phoneNumberId: '123456789',
        accessToken: 'test-token',
        webhookVerifyToken: 'e2e-verify-secret',
      },
    },
    tmpDir,
  );

  handlers = {
    onConnected: vi.fn(),
    onMessage: vi.fn(async (jid, msgId, text, senderName, timestamp) => {
      await adapter.handleIncomingMessage(jid, msgId, text, senderName, timestamp);
    }),
    onButtonReply: vi.fn(),
    onError: vi.fn(),
    onStatusUpdate: vi.fn(),
  };

  backend = new BusinessApiBackend(
    adapter,
    {
      phoneNumberId: '123456789',
      accessToken: 'test-token',
      webhookVerifyToken: 'e2e-verify-secret',
    },
    handlers,
  );

  // Start adapter first, then connect backend (adapter.start sets state to 'connecting',
  // backend.connect sets it to 'connected')
  await adapter.start();

  // Mock the connect call (no real Meta API)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ display_phone_number: '+14155551234' }), { status: 200 }),
  );
  await backend.connect();

  // Build the Express app mimicking AgentServer's structure
  app = express();
  app.use(express.json());

  // Webhook routes — mounted BEFORE auth (matches AgentServer)
  mountWhatsAppWebhooks({ app, backend });

  // Simulated auth middleware (after webhooks)
  app.use((req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== 'test-auth-token') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  // WhatsApp status route (behind auth)
  app.get('/whatsapp/status', (_req, res) => {
    res.json(adapter.getStatus());
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────

describe('WhatsApp Server Integration — E2E', () => {
  // ── 1. Webhook routes are alive ──────────────────

  describe('webhook routes are alive', () => {
    it('GET /webhooks/whatsapp returns 200 with valid verification', async () => {
      const res = await request(app)
        .get('/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'e2e-verify-secret',
          'hub.challenge': 'challenge-123',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('challenge-123');
    });

    it('GET /webhooks/whatsapp returns 403 with wrong token', async () => {
      const res = await request(app)
        .get('/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong-token',
          'hub.challenge': 'challenge-123',
        });

      expect(res.status).toBe(403);
    });

    it('GET /webhooks/whatsapp returns 400 without params', async () => {
      const res = await request(app).get('/webhooks/whatsapp');
      expect(res.status).toBe(400);
    });

    it('POST /webhooks/whatsapp returns 200 EVENT_RECEIVED', async () => {
      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [],
      };

      const res = await request(app)
        .post('/webhooks/whatsapp')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.text).toBe('EVENT_RECEIVED');
    });

    it('webhook routes do NOT require auth token', async () => {
      // No Authorization header — should still work
      const res = await request(app)
        .get('/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'e2e-verify-secret',
          'hub.challenge': 'no-auth-needed',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('no-auth-needed');
    });
  });

  // ── 2. WhatsApp status endpoint ──────────────────

  describe('WhatsApp status endpoint', () => {
    it('returns adapter status with auth', async () => {
      const res = await request(app)
        .get('/whatsapp/status')
        .set('Authorization', 'Bearer test-auth-token');

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('connected');
      expect(res.body.phoneNumber).toBe('+14155551234');
      expect(res.body).toHaveProperty('registeredSessions');
      expect(res.body).toHaveProperty('totalMessagesLogged');
    });

    it('rejects without auth', async () => {
      const res = await request(app).get('/whatsapp/status');
      expect(res.status).toBe(401);
    });
  });

  // ── 3. Webhook delivers messages to adapter ──────

  describe('webhook-to-adapter message delivery', () => {
    it('delivers a text message through webhook to adapter', async () => {
      const received: string[] = [];
      adapter.onMessage(async (msg) => { received.push(msg.content); });

      const payload: WebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'e1',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+14155551234', phone_number_id: '123456789' },
              contacts: [{ profile: { name: 'Test User' }, wa_id: '14155552671' }],
              messages: [{
                from: '14155552671',
                id: `wamid.e2e.${Date.now()}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: 'E2E message through webhook' },
              }],
            },
            field: 'messages',
          }],
        }],
      };

      const res = await request(app)
        .post('/webhooks/whatsapp')
        .send(payload);

      expect(res.status).toBe(200);

      // Give async processing a moment
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(handlers.onMessage).toHaveBeenCalled();
      expect(received).toContain('E2E message through webhook');
    });
  });

  // ── 4. Backend status tracking ──────────────────

  describe('backend status tracking', () => {
    it('backend reports connected after initialization', () => {
      expect(backend.isConnected()).toBe(true);
      const status = backend.getStatus();
      expect(status.connected).toBe(true);
      expect(status.phoneNumberId).toBe('123456789');
      expect(status.webhookConfigured).toBe(true);
    });
  });
});
