/**
 * Unit tests for MessageBridge — cross-platform message forwarding.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageBridge, type BridgeLink } from '../../src/messaging/shared/MessageBridge.js';
import { MessagingEventBus } from '../../src/messaging/shared/MessagingEventBus.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Test helpers ──────────────────────────────────────────

let tmpDir: string;

function createBridge(overrides: Record<string, unknown> = {}): {
  bridge: MessageBridge;
  whatsappBus: MessagingEventBus;
  telegramBus: MessagingEventBus;
  sendToTelegram: ReturnType<typeof vi.fn>;
  sendToWhatsApp: ReturnType<typeof vi.fn>;
} {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const whatsappBus = new MessagingEventBus('whatsapp');
  const telegramBus = new MessagingEventBus('telegram');
  const sendToTelegram = vi.fn().mockResolvedValue(undefined);
  const sendToWhatsApp = vi.fn().mockResolvedValue(undefined);

  const bridge = new MessageBridge({
    registryPath: path.join(tmpDir, 'bridge-registry.json'),
    whatsappEventBus: whatsappBus,
    telegramEventBus: telegramBus,
    sendToTelegram,
    sendToWhatsApp,
    ...overrides,
  });

  return { bridge, whatsappBus, telegramBus, sendToTelegram, sendToWhatsApp };
}

// ── Tests ──────────────────────────────────────────────

describe('MessageBridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      // safe-git-allow: incremental-migration
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Lifecycle ──────────────────────────────────────────

  describe('lifecycle', () => {
    it('starts and stops cleanly', () => {
      const { bridge } = createBridge();
      bridge.start();
      expect(bridge.getStatus().started).toBe(true);

      bridge.stop();
      expect(bridge.getStatus().started).toBe(false);
    });

    it('start is idempotent', () => {
      const { bridge } = createBridge();
      bridge.start();
      bridge.start();
      expect(bridge.getStatus().started).toBe(true);
    });
  });

  // ── Link management ──────────────────────────────────────

  describe('link management', () => {
    it('adds a bridge link', () => {
      const { bridge } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');

      const links = bridge.getLinks();
      expect(links).toHaveLength(1);
      expect(links[0].whatsappChannelId).toBe('14155552671@s.whatsapp.net');
      expect(links[0].telegramTopicId).toBe(42);
    });

    it('replaces existing link for same WhatsApp channel', () => {
      const { bridge } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.addLink('14155552671@s.whatsapp.net', 99, 'admin');

      const links = bridge.getLinks();
      expect(links).toHaveLength(1);
      expect(links[0].telegramTopicId).toBe(99);
    });

    it('replaces existing link for same Telegram topic', () => {
      const { bridge } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.addLink('14155559999@s.whatsapp.net', 42, 'admin');

      const links = bridge.getLinks();
      expect(links).toHaveLength(1);
      expect(links[0].whatsappChannelId).toBe('14155559999@s.whatsapp.net');
    });

    it('removes link by WhatsApp channel', () => {
      const { bridge } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');

      const removed = bridge.removeLinkByWhatsApp('14155552671@s.whatsapp.net');
      expect(removed).toBe(true);
      expect(bridge.getLinks()).toHaveLength(0);
    });

    it('removes link by Telegram topic', () => {
      const { bridge } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');

      const removed = bridge.removeLinkByTelegram(42);
      expect(removed).toBe(true);
      expect(bridge.getLinks()).toHaveLength(0);
    });

    it('returns false when removing nonexistent link', () => {
      const { bridge } = createBridge();
      expect(bridge.removeLinkByWhatsApp('nonexistent@s.whatsapp.net')).toBe(false);
      expect(bridge.removeLinkByTelegram(999)).toBe(false);
    });

    it('looks up Telegram for WhatsApp', () => {
      const { bridge } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');

      expect(bridge.getTelegramForWhatsApp('14155552671@s.whatsapp.net')).toBe(42);
      expect(bridge.getTelegramForWhatsApp('nonexistent@s.whatsapp.net')).toBeNull();
    });

    it('looks up WhatsApp for Telegram', () => {
      const { bridge } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');

      expect(bridge.getWhatsAppForTelegram(42)).toBe('14155552671@s.whatsapp.net');
      expect(bridge.getWhatsAppForTelegram(999)).toBeNull();
    });

    it('returns a copy of links (not mutable reference)', () => {
      const { bridge } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');

      const links1 = bridge.getLinks();
      links1.push({ whatsappChannelId: 'fake', telegramTopicId: 0, createdAt: '', createdBy: '' });

      expect(bridge.getLinks()).toHaveLength(1);
    });
  });

  // ── Persistence ──────────────────────────────────────────

  describe('persistence', () => {
    it('persists links to disk', () => {
      const registryPath = path.join(tmpDir, 'persist-test', 'bridge.json');
      const bridge1 = new MessageBridge({ registryPath });
      bridge1.addLink('14155552671@s.whatsapp.net', 42, 'admin');

      const bridge2 = new MessageBridge({ registryPath });
      expect(bridge2.getLinks()).toHaveLength(1);
      expect(bridge2.getTelegramForWhatsApp('14155552671@s.whatsapp.net')).toBe(42);
    });

    it('handles missing registry file gracefully', () => {
      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'nonexistent', 'bridge.json'),
      });
      expect(bridge.getLinks()).toHaveLength(0);
    });
  });

  // ── WhatsApp → Telegram forwarding ──────────────────────

  describe('WhatsApp → Telegram', () => {
    it('forwards user message from WhatsApp to linked Telegram topic', async () => {
      const { bridge, whatsappBus, sendToTelegram } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.start();

      await whatsappBus.emit('message:logged', {
        messageId: 1,
        channelId: '14155552671@s.whatsapp.net',
        text: 'Hello from WhatsApp',
        fromUser: true,
        timestamp: new Date().toISOString(),
        senderName: 'Justin',
      });

      expect(sendToTelegram).toHaveBeenCalledWith(
        42,
        '[via WhatsApp] Justin: Hello from WhatsApp',
      );
    });

    it('does not forward bot messages', async () => {
      const { bridge, whatsappBus, sendToTelegram } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.start();

      await whatsappBus.emit('message:logged', {
        messageId: 1,
        channelId: '14155552671@s.whatsapp.net',
        text: 'Bot response',
        fromUser: false,
        timestamp: new Date().toISOString(),
      });

      expect(sendToTelegram).not.toHaveBeenCalled();
    });

    it('does not forward if no link exists', async () => {
      const { bridge, whatsappBus, sendToTelegram } = createBridge();
      bridge.start();

      await whatsappBus.emit('message:logged', {
        messageId: 1,
        channelId: '14155552671@s.whatsapp.net',
        text: 'No link',
        fromUser: true,
        timestamp: new Date().toISOString(),
      });

      expect(sendToTelegram).not.toHaveBeenCalled();
    });

    it('prevents loop: does not re-bridge Telegram-originated messages', async () => {
      const { bridge, whatsappBus, sendToTelegram } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.start();

      await whatsappBus.emit('message:logged', {
        messageId: 1,
        channelId: '14155552671@s.whatsapp.net',
        text: '[via Telegram] Justin: Already bridged',
        fromUser: true,
        timestamp: new Date().toISOString(),
      });

      expect(sendToTelegram).not.toHaveBeenCalled();
    });

    it('uses platformUserId as fallback sender label', async () => {
      const { bridge, whatsappBus, sendToTelegram } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.start();

      await whatsappBus.emit('message:logged', {
        messageId: 1,
        channelId: '14155552671@s.whatsapp.net',
        text: 'Hello',
        fromUser: true,
        timestamp: new Date().toISOString(),
        platformUserId: '+14155552671',
      });

      expect(sendToTelegram).toHaveBeenCalledWith(
        42,
        '[via WhatsApp] +14155552671: Hello',
      );
    });
  });

  // ── Telegram → WhatsApp forwarding ──────────────────────

  describe('Telegram → WhatsApp', () => {
    it('forwards user message from Telegram to linked WhatsApp JID', async () => {
      const { bridge, telegramBus, sendToWhatsApp } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.start();

      await telegramBus.emit('message:logged', {
        messageId: 1,
        channelId: '42', // Telegram topic ID as string
        text: 'Hello from Telegram',
        fromUser: true,
        timestamp: new Date().toISOString(),
        senderName: 'Justin',
      });

      expect(sendToWhatsApp).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        '[via Telegram] Justin: Hello from Telegram',
      );
    });

    it('prevents loop: does not re-bridge WhatsApp-originated messages', async () => {
      const { bridge, telegramBus, sendToWhatsApp } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.start();

      await telegramBus.emit('message:logged', {
        messageId: 1,
        channelId: '42',
        text: '[via WhatsApp] Justin: Already bridged',
        fromUser: true,
        timestamp: new Date().toISOString(),
      });

      expect(sendToWhatsApp).not.toHaveBeenCalled();
    });

    it('uses senderUsername as fallback', async () => {
      const { bridge, telegramBus, sendToWhatsApp } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.start();

      await telegramBus.emit('message:logged', {
        messageId: 1,
        channelId: '42',
        text: 'Hello',
        fromUser: true,
        timestamp: new Date().toISOString(),
        senderUsername: 'justindev',
      });

      expect(sendToWhatsApp).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        '[via Telegram] justindev: Hello',
      );
    });
  });

  // ── Status tracking ──────────────────────────────────────

  describe('status', () => {
    it('tracks bridged message count', async () => {
      const { bridge, whatsappBus } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.start();

      await whatsappBus.emit('message:logged', {
        messageId: 1,
        channelId: '14155552671@s.whatsapp.net',
        text: 'msg 1',
        fromUser: true,
        timestamp: new Date().toISOString(),
        senderName: 'User',
      });

      await whatsappBus.emit('message:logged', {
        messageId: 2,
        channelId: '14155552671@s.whatsapp.net',
        text: 'msg 2',
        fromUser: true,
        timestamp: new Date().toISOString(),
        senderName: 'User',
      });

      const status = bridge.getStatus();
      expect(status.messagesBridged).toBe(2);
      expect(status.lastBridgedAt).toBeTruthy();
    });

    it('does not bridge after stop', async () => {
      const { bridge, whatsappBus, sendToTelegram } = createBridge();
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.start();
      bridge.stop();

      await whatsappBus.emit('message:logged', {
        messageId: 1,
        channelId: '14155552671@s.whatsapp.net',
        text: 'After stop',
        fromUser: true,
        timestamp: new Date().toISOString(),
        senderName: 'User',
      });

      expect(sendToTelegram).not.toHaveBeenCalled();
    });

    it('handles send failure gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { bridge, whatsappBus, sendToTelegram } = createBridge();
      sendToTelegram.mockRejectedValue(new Error('Send failed'));
      bridge.addLink('14155552671@s.whatsapp.net', 42, 'admin');
      bridge.start();

      await whatsappBus.emit('message:logged', {
        messageId: 1,
        channelId: '14155552671@s.whatsapp.net',
        text: 'Will fail',
        fromUser: true,
        timestamp: new Date().toISOString(),
        senderName: 'User',
      });

      // Should log error but not crash
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('WhatsApp'));
      consoleSpy.mockRestore();
    });
  });
});
