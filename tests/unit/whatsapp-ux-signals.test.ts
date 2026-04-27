/**
 * Unit tests for WhatsApp UX signals — Phase 4.
 *
 * Tests typing indicators, read receipts, and ack reactions
 * across both Baileys and Business API backends.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WhatsAppAdapter, type BackendCapabilities } from '../../src/messaging/WhatsAppAdapter.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Test helpers ──────────────────────────────────────────

let tmpDir: string;

function createAdapter(configOverrides: Record<string, unknown> = {}): WhatsAppAdapter {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ux-'));
  return new WhatsAppAdapter(
    {
      backend: 'baileys',
      authorizedNumbers: ['+14155552671'],
      requireConsent: false,
      prefixEnabled: false,
      ...configOverrides,
    },
    tmpDir,
  );
}

function createMockCapabilities(): BackendCapabilities & { [K in keyof BackendCapabilities]: ReturnType<typeof vi.fn> } {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    stopTyping: vi.fn().mockResolvedValue(undefined),
    sendReadReceipt: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn().mockResolvedValue(undefined),
  };
}

async function connectAdapter(adapter: WhatsAppAdapter, caps: BackendCapabilities): Promise<void> {
  await adapter.start();
  adapter.setBackendCapabilities(caps);
  await adapter.setConnectionState('connected', '+14155551234');
}

// ── Tests ──────────────────────────────────────────────

describe('WhatsApp UX Signals', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      // safe-git-allow: incremental-migration
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── BackendCapabilities ──────────────────────────────

  describe('BackendCapabilities', () => {
    it('setBackendCapabilities replaces sendFunction', async () => {
      const adapter = createAdapter();
      const caps = createMockCapabilities();
      await connectAdapter(adapter, caps);

      await adapter.send({
        content: 'test',
        userId: '+14155552671',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(caps.sendText).toHaveBeenCalledWith('14155552671@s.whatsapp.net', 'test');
    });

    it('setSendFunction still works (backward compat)', async () => {
      const adapter = createAdapter();
      const sendFn = vi.fn().mockResolvedValue(undefined);
      await adapter.start();
      adapter.setSendFunction(sendFn);
      await adapter.setConnectionState('connected', '+14155551234');

      await adapter.send({
        content: 'compat test',
        userId: '+14155552671',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(sendFn).toHaveBeenCalledWith('14155552671@s.whatsapp.net', 'compat test');
    });
  });

  // ── Read Receipts ──────────────────────────────────────

  describe('read receipts', () => {
    it('sends read receipt on message receive (default enabled)', async () => {
      const adapter = createAdapter();
      const caps = createMockCapabilities();
      await connectAdapter(adapter, caps);

      adapter.onMessage(async () => {});
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-1',
        'Hello',
        'Test User',
        Math.floor(Date.now() / 1000),
        { remoteJid: '14155552671@s.whatsapp.net', id: 'msg-1' },
      );

      expect(caps.sendReadReceipt).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'msg-1',
        { remoteJid: '14155552671@s.whatsapp.net', id: 'msg-1' },
      );
    });

    it('skips read receipt when disabled', async () => {
      const adapter = createAdapter({ sendReadReceipts: false });
      const caps = createMockCapabilities();
      await connectAdapter(adapter, caps);

      adapter.onMessage(async () => {});
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'msg-2', 'Hello', 'User', undefined,
      );

      expect(caps.sendReadReceipt).not.toHaveBeenCalled();
    });

    it('read receipt failure does not block message processing', async () => {
      const adapter = createAdapter();
      const caps = createMockCapabilities();
      caps.sendReadReceipt.mockRejectedValue(new Error('Read receipt failed'));
      await connectAdapter(adapter, caps);

      const received: string[] = [];
      adapter.onMessage(async (msg) => { received.push(msg.content); });
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'msg-3', 'Still works', 'User',
      );

      expect(received).toContain('Still works');
    });
  });

  // ── Ack Reactions ──────────────────────────────────────

  describe('ack reactions', () => {
    it('sends default eyes emoji reaction on message receive', async () => {
      const adapter = createAdapter();
      const caps = createMockCapabilities();
      await connectAdapter(adapter, caps);

      adapter.onMessage(async () => {});
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'msg-ack-1', 'Hello', 'User', undefined,
        { remoteJid: '14155552671@s.whatsapp.net', id: 'msg-ack-1' },
      );

      expect(caps.sendReaction).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'msg-ack-1',
        '\u{1F440}', // eyes emoji
        { remoteJid: '14155552671@s.whatsapp.net', id: 'msg-ack-1' },
      );
    });

    it('uses custom ack emoji from config', async () => {
      const adapter = createAdapter({ ackReactionEmoji: '\u{1F44D}' }); // thumbs up
      const caps = createMockCapabilities();
      await connectAdapter(adapter, caps);

      adapter.onMessage(async () => {});
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'msg-ack-2', 'Hello', 'User',
      );

      expect(caps.sendReaction).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'msg-ack-2',
        '\u{1F44D}',
        undefined,
      );
    });

    it('skips reaction when ackReactionEmoji is false', async () => {
      const adapter = createAdapter({ ackReactionEmoji: false });
      const caps = createMockCapabilities();
      await connectAdapter(adapter, caps);

      adapter.onMessage(async () => {});
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'msg-ack-3', 'Hello', 'User',
      );

      expect(caps.sendReaction).not.toHaveBeenCalled();
    });

    it('reaction failure does not block message processing', async () => {
      const adapter = createAdapter();
      const caps = createMockCapabilities();
      caps.sendReaction.mockRejectedValue(new Error('Reaction failed'));
      await connectAdapter(adapter, caps);

      const received: string[] = [];
      adapter.onMessage(async (msg) => { received.push(msg.content); });
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'msg-ack-4', 'Keeps going', 'User',
      );

      expect(received).toContain('Keeps going');
    });
  });

  // ── Typing Indicators ──────────────────────────────────

  describe('typing indicators', () => {
    it('sends typing indicator on message receive (default enabled)', async () => {
      const adapter = createAdapter();
      const caps = createMockCapabilities();
      await connectAdapter(adapter, caps);

      adapter.onMessage(async () => {});
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'msg-type-1', 'Hello', 'User',
      );

      expect(caps.sendTyping).toHaveBeenCalledWith('14155552671@s.whatsapp.net');
    });

    it('skips typing when disabled', async () => {
      const adapter = createAdapter({ sendTypingIndicators: false });
      const caps = createMockCapabilities();
      await connectAdapter(adapter, caps);

      adapter.onMessage(async () => {});
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'msg-type-2', 'Hello', 'User',
      );

      expect(caps.sendTyping).not.toHaveBeenCalled();
    });

    it('typing failure does not block message processing', async () => {
      const adapter = createAdapter();
      const caps = createMockCapabilities();
      caps.sendTyping.mockRejectedValue(new Error('Typing failed'));
      await connectAdapter(adapter, caps);

      const received: string[] = [];
      adapter.onMessage(async (msg) => { received.push(msg.content); });
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'msg-type-3', 'Still processes', 'User',
      );

      expect(received).toContain('Still processes');
    });

    it('does nothing when capability not available (e.g., Business API)', async () => {
      const adapter = createAdapter();
      const caps: BackendCapabilities = {
        sendText: vi.fn().mockResolvedValue(undefined),
        // No sendTyping — simulates Business API
      };
      await connectAdapter(adapter, caps);

      adapter.onMessage(async () => {});
      // Should not throw
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'msg-type-4', 'Hello', 'User',
      );
    });
  });

  // ── QR Code State ──────────────────────────────────────

  describe('QR code state', () => {
    it('stores and retrieves QR code', () => {
      const adapter = createAdapter();
      expect(adapter.getQrCode()).toBeNull();

      adapter.setQrCode('qr-data-here');
      expect(adapter.getQrCode()).toBe('qr-data-here');
    });

    it('clears QR code on connection', async () => {
      const adapter = createAdapter();
      adapter.setQrCode('qr-data');

      await adapter.start();
      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      expect(adapter.getQrCode()).toBeNull();
    });

    it('setQrCode(null) clears the QR', () => {
      const adapter = createAdapter();
      adapter.setQrCode('qr-data');
      adapter.setQrCode(null);
      expect(adapter.getQrCode()).toBeNull();
    });
  });

  // ── Signal ordering ──────────────────────────────────────

  describe('signal ordering', () => {
    it('fires read receipt before ack reaction before typing', async () => {
      const adapter = createAdapter();
      const callOrder: string[] = [];
      const caps: BackendCapabilities = {
        sendText: vi.fn().mockResolvedValue(undefined),
        sendReadReceipt: vi.fn().mockImplementation(async () => { callOrder.push('readReceipt'); }),
        sendReaction: vi.fn().mockImplementation(async () => { callOrder.push('reaction'); }),
        sendTyping: vi.fn().mockImplementation(async () => { callOrder.push('typing'); }),
      };
      await connectAdapter(adapter, caps);

      adapter.onMessage(async () => { callOrder.push('handler'); });
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'msg-order', 'Hello', 'User',
        undefined, { id: 'msg-order' },
      );

      // Read receipt fires first (before auth), then ack + typing (after auth), then handler
      // Note: read receipt and reaction/typing are fire-and-forget so ordering is by call position
      expect(callOrder).toEqual(['readReceipt', 'reaction', 'typing', 'handler']);
    });
  });
});
