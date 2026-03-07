/**
 * WhatsApp Business API Webhook Routes — Express middleware for Meta webhooks.
 *
 * Mounts two routes on the Express app:
 * - GET  /webhooks/whatsapp — Verification endpoint (Meta sends challenge)
 * - POST /webhooks/whatsapp — Message/status delivery from Meta
 *
 * These routes are only mounted when the WhatsApp adapter uses the
 * 'business-api' backend. Baileys doesn't need webhooks.
 */

import type { Express, Request, Response } from 'express';
import type { BusinessApiBackend, WebhookPayload } from './BusinessApiBackend.js';

export interface WhatsAppWebhookRoutesOptions {
  /** The Express app to mount routes on */
  app: Express;
  /** The BusinessApiBackend that will process webhooks */
  backend: BusinessApiBackend;
  /** Optional path prefix (default: '/webhooks/whatsapp') */
  path?: string;
}

/**
 * Mount WhatsApp webhook routes on an Express app.
 * Returns a cleanup function to unmount the routes (for testing).
 */
export function mountWhatsAppWebhooks(options: WhatsAppWebhookRoutesOptions): void {
  const webhookPath = options.path ?? '/webhooks/whatsapp';
  const { app, backend } = options;

  // GET — Webhook verification
  app.get(webhookPath, (req: Request, res: Response) => {
    const mode = req.query['hub.mode'] as string;
    const token = req.query['hub.verify_token'] as string;
    const challenge = req.query['hub.challenge'] as string;

    if (!mode || !token || !challenge) {
      res.status(400).json({ error: 'Missing verification parameters' });
      return;
    }

    const result = backend.verifyWebhook(mode, token, challenge);
    if (result !== null) {
      res.status(200).send(result);
    } else {
      res.status(403).json({ error: 'Verification failed' });
    }
  });

  // POST — Message/status delivery
  app.post(webhookPath, async (req: Request, res: Response) => {
    // Meta expects a 200 response within 5 seconds — process async
    res.status(200).send('EVENT_RECEIVED');

    try {
      const payload = req.body as WebhookPayload;
      if (payload && payload.object) {
        await backend.handleWebhook(payload);
      }
    } catch (err) {
      console.error(`[whatsapp-webhook] Error processing webhook: ${err}`);
    }
  });
}
