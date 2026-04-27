/**
 * End-to-end tests for Phase 4: UX Signals, QR Code Lifecycle, and Message Bridge.
 *
 * Tests the full Phase 4 feature set with REAL adapter instances (no mocks
 * except for network-level send calls). Exercises:
 *
 * 1. UX signals lifecycle: read receipts, ack reactions, typing indicators
 * 2. QR code lifecycle: set, access, auto-clear on connect, reconnect
 * 3. Message bridge with real event buses: cross-platform forwarding, loop detection
 * 4. Config variants: disabled signals, custom emoji
 * 5. Concurrent message processing: race conditions, dedup, signal ordering
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WhatsAppAdapter, type BackendCapabilities } from '../../src/messaging/WhatsAppAdapter.js';
import { MessageBridge } from '../../src/messaging/shared/MessageBridge.js';
import { MessagingEventBus } from '../../src/messaging/shared/MessagingEventBus.js';

describe('Phase 4: UX Signals, QR Code, Message Bridge — E2E', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-phase4-e2e-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTestAdapter(overrides: Record<string, unknown> = {}): WhatsAppAdapter {
    return new WhatsAppAdapter(
      {
        backend: 'baileys',
        authorizedNumbers: ['+14155552671', '+447911123456'],
        requireConsent: false,
        ...overrides,
      },
      tmpDir,
    );
  }

  function createRealCapabilities(): BackendCapabilities & Record<string, ReturnType<typeof vi.fn>> {
    return {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      stopTyping: vi.fn().mockResolvedValue(undefined),
      sendReadReceipt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
    };
  }

  // ══════════════════════════════════════════════════════════
  // 1. UX SIGNALS LIFECYCLE
  // ══════════════════════════════════════════════════════════

  describe('UX Signals Lifecycle', () => {
    it('fires all UX signals in correct order for an authorized user', async () => {
      const adapter = createTestAdapter();
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected', '+14155552671');

      const callOrder: string[] = [];
      caps.sendReadReceipt.mockImplementation(async () => { callOrder.push('readReceipt'); });
      caps.sendReaction.mockImplementation(async () => { callOrder.push('ackReaction'); });
      caps.sendTyping.mockImplementation(async () => { callOrder.push('typing'); });

      const handlerCalled = vi.fn().mockImplementation(async () => { callOrder.push('handler'); });
      adapter.onMessage(handlerCalled);

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'ux-signal-1',
        'Hello Phase 4',
        'TestUser',
        Math.floor(Date.now() / 1000),
      );

      // Read receipt fires first (before auth check completes)
      expect(caps.sendReadReceipt).toHaveBeenCalledTimes(1);
      expect(caps.sendReadReceipt).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'ux-signal-1',
        undefined,
      );

      // Ack reaction fires after auth
      expect(caps.sendReaction).toHaveBeenCalledTimes(1);
      expect(caps.sendReaction).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'ux-signal-1',
        expect.any(String), // default emoji
        undefined,
      );

      // Typing indicator fires after auth
      expect(caps.sendTyping).toHaveBeenCalledTimes(1);
      expect(caps.sendTyping).toHaveBeenCalledWith('14155552671@s.whatsapp.net');

      // Handler fires last
      expect(handlerCalled).toHaveBeenCalledTimes(1);

      // Verify ordering: readReceipt before ack/typing before handler
      expect(callOrder.indexOf('readReceipt')).toBeLessThan(callOrder.indexOf('ackReaction'));
      expect(callOrder.indexOf('readReceipt')).toBeLessThan(callOrder.indexOf('typing'));
      expect(callOrder.indexOf('ackReaction')).toBeLessThan(callOrder.indexOf('handler'));
      expect(callOrder.indexOf('typing')).toBeLessThan(callOrder.indexOf('handler'));
    });

    it('fires read receipt even for unauthorized users', async () => {
      const adapter = createTestAdapter();
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected');

      adapter.onMessage(vi.fn());

      await adapter.handleIncomingMessage(
        '19995550000@s.whatsapp.net',
        'ux-unauth-1',
        'Unauthorized message',
        'Stranger',
        Math.floor(Date.now() / 1000),
      );

      // Read receipt fires before auth check — should still fire
      expect(caps.sendReadReceipt).toHaveBeenCalledTimes(1);

      // But ack reaction and typing should NOT fire (auth gate rejects)
      expect(caps.sendReaction).not.toHaveBeenCalled();
      expect(caps.sendTyping).not.toHaveBeenCalled();
    });

    it('does not suppress UX signals on new messages (dedup only blocks reprocessing)', async () => {
      const adapter = createTestAdapter();
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected', '+14155552671');

      adapter.onMessage(vi.fn());

      // First message
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'fresh-msg-1',
        'First message',
        'TestUser',
      );

      // Second message (different ID)
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'fresh-msg-2',
        'Second message',
        'TestUser',
      );

      expect(caps.sendReadReceipt).toHaveBeenCalledTimes(2);
      expect(caps.sendReaction).toHaveBeenCalledTimes(2);
      expect(caps.sendTyping).toHaveBeenCalledTimes(2);
    });

    it('dedup blocks all signals and processing on duplicate message IDs', async () => {
      const adapter = createTestAdapter();
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected', '+14155552671');

      const handler = vi.fn();
      adapter.onMessage(handler);

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'dedup-msg-1',
        'Hello once',
        'TestUser',
      );

      // Same message ID again (reconnect storm)
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'dedup-msg-1',
        'Hello once',
        'TestUser',
      );

      // Only one set of signals + processing
      expect(caps.sendReadReceipt).toHaveBeenCalledTimes(1);
      expect(caps.sendReaction).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('uses default ack emoji (eye emoji) when not configured', async () => {
      const adapter = createTestAdapter();
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected', '+14155552671');
      adapter.onMessage(vi.fn());

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'emoji-default-1',
        'Check the emoji',
        'TestUser',
      );

      // Should use the default emoji
      expect(caps.sendReaction).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'emoji-default-1',
        expect.stringContaining(''),
        undefined,
      );
    });
  });

  // ══════════════════════════════════════════════════════════
  // 2. QR CODE LIFECYCLE
  // ══════════════════════════════════════════════════════════

  describe('QR Code Lifecycle', () => {
    it('starts with null QR code', () => {
      const adapter = createTestAdapter();
      expect(adapter.getQrCode()).toBeNull();
    });

    it('stores and retrieves QR code', () => {
      const adapter = createTestAdapter();
      adapter.setQrCode('data:image/png;base64,AAAA');
      expect(adapter.getQrCode()).toBe('data:image/png;base64,AAAA');
    });

    it('auto-clears QR code on connection', async () => {
      const adapter = createTestAdapter();
      adapter.setQrCode('qr-code-data-1234');
      expect(adapter.getQrCode()).toBe('qr-code-data-1234');

      await adapter.setConnectionState('connected', '+14155552671');
      expect(adapter.getQrCode()).toBeNull();
    });

    it('handles reconnect scenario: new QR after previous connection', async () => {
      const adapter = createTestAdapter();

      // Initial QR → connect → QR clears
      adapter.setQrCode('qr-first');
      await adapter.setConnectionState('connected', '+14155552671');
      expect(adapter.getQrCode()).toBeNull();

      // Disconnect and new QR for reconnect
      await adapter.setConnectionState('reconnecting');
      adapter.setQrCode('qr-reconnect');
      expect(adapter.getQrCode()).toBe('qr-reconnect');

      // Reconnect succeeds — QR clears again
      await adapter.setConnectionState('connected', '+14155552671');
      expect(adapter.getQrCode()).toBeNull();
    });

    it('emits qr-update event on QR code changes', async () => {
      const adapter = createTestAdapter();
      const bus = adapter.getEventBus();

      const qrEvents: Array<{ qr: string | null }> = [];
      bus.on('whatsapp:qr-update', (event) => {
        qrEvents.push({ qr: event.qr });
      });

      adapter.setQrCode('qr-event-test');
      // Give the async emit a moment
      await new Promise(resolve => setTimeout(resolve, 10));

      adapter.setQrCode(null);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(qrEvents).toHaveLength(2);
      expect(qrEvents[0].qr).toBe('qr-event-test');
      expect(qrEvents[1].qr).toBeNull();
    });

    it('replaces QR code when set multiple times', () => {
      const adapter = createTestAdapter();
      adapter.setQrCode('qr-v1');
      adapter.setQrCode('qr-v2');
      adapter.setQrCode('qr-v3');
      expect(adapter.getQrCode()).toBe('qr-v3');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 3. MESSAGE BRIDGE LIFECYCLE WITH REAL EVENT BUSES
  // ══════════════════════════════════════════════════════════

  describe('Message Bridge Lifecycle', () => {
    it('forwards WhatsApp message to Telegram via event bus', async () => {
      const adapter = createTestAdapter();
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected', '+14155552671');
      adapter.onMessage(vi.fn());

      const sendToTelegram = vi.fn().mockResolvedValue(undefined);
      const sendToWhatsApp = vi.fn().mockResolvedValue(undefined);

      const bridgeDir = path.join(tmpDir, 'bridge');
      fs.mkdirSync(bridgeDir, { recursive: true });

      const bridge = new MessageBridge({
        registryPath: path.join(bridgeDir, 'bridge-registry.json'),
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: new MessagingEventBus('telegram'),
        sendToTelegram,
        sendToWhatsApp,
      });

      bridge.addLink('14155552671@s.whatsapp.net', 12345, 'test-admin');
      bridge.start();

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'bridge-wa-1',
        'Hello from WhatsApp',
        'Alice',
      );

      // Bridge should forward to Telegram
      expect(sendToTelegram).toHaveBeenCalledTimes(1);
      expect(sendToTelegram).toHaveBeenCalledWith(
        12345,
        expect.stringContaining('[via WhatsApp]'),
      );
      expect(sendToTelegram).toHaveBeenCalledWith(
        12345,
        expect.stringContaining('Alice'),
      );

      bridge.stop();
    });

    it('forwards Telegram message to WhatsApp via event bus', async () => {
      const telegramBus = new MessagingEventBus('telegram');
      const whatsappBus = new MessagingEventBus('whatsapp');

      const sendToTelegram = vi.fn().mockResolvedValue(undefined);
      const sendToWhatsApp = vi.fn().mockResolvedValue(undefined);

      const bridgeDir = path.join(tmpDir, 'bridge-tg');
      fs.mkdirSync(bridgeDir, { recursive: true });

      const bridge = new MessageBridge({
        registryPath: path.join(bridgeDir, 'bridge-registry.json'),
        whatsappEventBus: whatsappBus,
        telegramEventBus: telegramBus,
        sendToTelegram,
        sendToWhatsApp,
      });

      bridge.addLink('447911123456@s.whatsapp.net', 67890, 'test-admin');
      bridge.start();

      // Simulate Telegram message:logged event
      await telegramBus.emit('message:logged', {
        messageId: Date.now(),
        channelId: '67890', // topic ID as string
        text: 'Hello from Telegram',
        fromUser: true,
        timestamp: new Date().toISOString(),
        sessionName: null,
        senderName: 'Bob',
        senderUsername: 'bob_t',
      });

      expect(sendToWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendToWhatsApp).toHaveBeenCalledWith(
        '447911123456@s.whatsapp.net',
        expect.stringContaining('[via Telegram]'),
      );
      expect(sendToWhatsApp).toHaveBeenCalledWith(
        '447911123456@s.whatsapp.net',
        expect.stringContaining('Bob'),
      );

      bridge.stop();
    });

    it('detects and prevents forwarding loops', async () => {
      const whatsappBus = new MessagingEventBus('whatsapp');
      const telegramBus = new MessagingEventBus('telegram');

      const sendToTelegram = vi.fn().mockResolvedValue(undefined);
      const sendToWhatsApp = vi.fn().mockResolvedValue(undefined);

      const bridgeDir = path.join(tmpDir, 'bridge-loop');
      fs.mkdirSync(bridgeDir, { recursive: true });

      const bridge = new MessageBridge({
        registryPath: path.join(bridgeDir, 'bridge-registry.json'),
        whatsappEventBus: whatsappBus,
        telegramEventBus: telegramBus,
        sendToTelegram,
        sendToWhatsApp,
      });

      bridge.addLink('14155552671@s.whatsapp.net', 12345, 'admin');
      bridge.start();

      // Simulate a message that already has the bridge prefix (would cause loop)
      await whatsappBus.emit('message:logged', {
        messageId: Date.now(),
        channelId: '14155552671@s.whatsapp.net',
        text: '[via Telegram] Bob: Hello from Telegram',
        fromUser: true,
        timestamp: new Date().toISOString(),
        sessionName: null,
        senderName: 'WhatsApp echo',
      });

      // Should NOT forward — loop detected
      expect(sendToTelegram).not.toHaveBeenCalled();

      // Same for the other direction
      await telegramBus.emit('message:logged', {
        messageId: Date.now(),
        channelId: '12345',
        text: '[via WhatsApp] Alice: Hello from WhatsApp',
        fromUser: true,
        timestamp: new Date().toISOString(),
        sessionName: null,
        senderName: 'Telegram echo',
      });

      expect(sendToWhatsApp).not.toHaveBeenCalled();

      bridge.stop();
    });

    it('does not forward bot responses (fromUser: false)', async () => {
      const whatsappBus = new MessagingEventBus('whatsapp');

      const sendToTelegram = vi.fn().mockResolvedValue(undefined);

      const bridgeDir = path.join(tmpDir, 'bridge-bot');
      fs.mkdirSync(bridgeDir, { recursive: true });

      const bridge = new MessageBridge({
        registryPath: path.join(bridgeDir, 'bridge-registry.json'),
        whatsappEventBus: whatsappBus,
        telegramEventBus: new MessagingEventBus('telegram'),
        sendToTelegram,
      });

      bridge.addLink('14155552671@s.whatsapp.net', 12345, 'admin');
      bridge.start();

      await whatsappBus.emit('message:logged', {
        messageId: Date.now(),
        channelId: '14155552671@s.whatsapp.net',
        text: 'This is a bot response',
        fromUser: false,
        timestamp: new Date().toISOString(),
        sessionName: null,
      });

      expect(sendToTelegram).not.toHaveBeenCalled();

      bridge.stop();
    });

    it('does not forward messages for unlinked channels', async () => {
      const whatsappBus = new MessagingEventBus('whatsapp');

      const sendToTelegram = vi.fn().mockResolvedValue(undefined);

      const bridgeDir = path.join(tmpDir, 'bridge-unlinked');
      fs.mkdirSync(bridgeDir, { recursive: true });

      const bridge = new MessageBridge({
        registryPath: path.join(bridgeDir, 'bridge-registry.json'),
        whatsappEventBus: whatsappBus,
        telegramEventBus: new MessagingEventBus('telegram'),
        sendToTelegram,
      });

      // Link one JID
      bridge.addLink('14155552671@s.whatsapp.net', 12345, 'admin');
      bridge.start();

      // Send from a DIFFERENT JID — no link exists
      await whatsappBus.emit('message:logged', {
        messageId: Date.now(),
        channelId: '99999999999@s.whatsapp.net',
        text: 'Message from unlinked user',
        fromUser: true,
        timestamp: new Date().toISOString(),
        sessionName: null,
        senderName: 'Unknown',
      });

      expect(sendToTelegram).not.toHaveBeenCalled();

      bridge.stop();
    });

    it('tracks bridge status correctly', async () => {
      const whatsappBus = new MessagingEventBus('whatsapp');
      const telegramBus = new MessagingEventBus('telegram');

      const sendToTelegram = vi.fn().mockResolvedValue(undefined);
      const sendToWhatsApp = vi.fn().mockResolvedValue(undefined);

      const bridgeDir = path.join(tmpDir, 'bridge-status');
      fs.mkdirSync(bridgeDir, { recursive: true });

      const bridge = new MessageBridge({
        registryPath: path.join(bridgeDir, 'bridge-registry.json'),
        whatsappEventBus: whatsappBus,
        telegramEventBus: telegramBus,
        sendToTelegram,
        sendToWhatsApp,
      });

      expect(bridge.getStatus().started).toBe(false);
      expect(bridge.getStatus().messagesBridged).toBe(0);

      bridge.addLink('14155552671@s.whatsapp.net', 12345, 'admin');
      bridge.start();

      expect(bridge.getStatus().started).toBe(true);
      expect(bridge.getStatus().linkCount).toBe(1);

      // Forward a message
      await whatsappBus.emit('message:logged', {
        messageId: Date.now(),
        channelId: '14155552671@s.whatsapp.net',
        text: 'Count me',
        fromUser: true,
        timestamp: new Date().toISOString(),
        sessionName: null,
        senderName: 'Alice',
      });

      expect(bridge.getStatus().messagesBridged).toBe(1);
      expect(bridge.getStatus().lastBridgedAt).not.toBeNull();

      bridge.stop();
      expect(bridge.getStatus().started).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 4. CONFIG VARIANTS
  // ══════════════════════════════════════════════════════════

  describe('Config Variants', () => {
    it('suppresses all UX signals when disabled in config', async () => {
      const adapter = createTestAdapter({
        sendReadReceipts: false,
        ackReactionEmoji: false,
        sendTypingIndicators: false,
      });
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected', '+14155552671');
      adapter.onMessage(vi.fn());

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'no-signals-1',
        'Silent message',
        'TestUser',
      );

      expect(caps.sendReadReceipt).not.toHaveBeenCalled();
      expect(caps.sendReaction).not.toHaveBeenCalled();
      expect(caps.sendTyping).not.toHaveBeenCalled();
    });

    it('uses custom ack emoji when configured', async () => {
      const adapter = createTestAdapter({
        ackReactionEmoji: '✅',
      });
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected', '+14155552671');
      adapter.onMessage(vi.fn());

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'custom-emoji-1',
        'Custom emoji test',
        'TestUser',
      );

      expect(caps.sendReaction).toHaveBeenCalledWith(
        '14155552671@s.whatsapp.net',
        'custom-emoji-1',
        '✅',
        undefined,
      );
    });

    it('sends read receipts but no reaction when ackReactionEmoji is false', async () => {
      const adapter = createTestAdapter({
        sendReadReceipts: true,
        ackReactionEmoji: false,
        sendTypingIndicators: true,
      });
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected', '+14155552671');
      adapter.onMessage(vi.fn());

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'partial-signals-1',
        'Partial signals',
        'TestUser',
      );

      expect(caps.sendReadReceipt).toHaveBeenCalledTimes(1);
      expect(caps.sendReaction).not.toHaveBeenCalled();
      expect(caps.sendTyping).toHaveBeenCalledTimes(1);
    });

    it('works without backend capabilities set (no crash on missing signals)', async () => {
      const adapter = createTestAdapter();
      // Do NOT set capabilities — adapter should handle gracefully
      await adapter.setConnectionState('connected', '+14155552671');
      adapter.onMessage(vi.fn());

      // Should not throw
      await expect(
        adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          'no-caps-1',
          'No capabilities set',
          'TestUser',
        ),
      ).resolves.not.toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════
  // 5. CONCURRENT MESSAGE PROCESSING
  // ══════════════════════════════════════════════════════════

  describe('Concurrent Message Processing', () => {
    it('processes 5 concurrent messages without race conditions', async () => {
      const adapter = createTestAdapter();
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected', '+14155552671');

      const receivedMessages: string[] = [];
      adapter.onMessage(async (msg) => {
        receivedMessages.push(msg.content);
      });

      // Fire 5 messages concurrently
      const promises = Array.from({ length: 5 }, (_, i) =>
        adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          `concurrent-msg-${i}`,
          `Message ${i}`,
          'TestUser',
        ),
      );

      await Promise.all(promises);

      // All 5 processed
      expect(receivedMessages).toHaveLength(5);
      expect(caps.sendReadReceipt).toHaveBeenCalledTimes(5);
      expect(caps.sendReaction).toHaveBeenCalledTimes(5);
      expect(caps.sendTyping).toHaveBeenCalledTimes(5);
    });

    it('correctly deduplicates concurrent duplicate messages', async () => {
      const adapter = createTestAdapter();
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected', '+14155552671');

      const handler = vi.fn();
      adapter.onMessage(handler);

      // Fire the same message ID 5 times concurrently (simulates reconnect storm)
      const promises = Array.from({ length: 5 }, () =>
        adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          'storm-dedup-1',
          'Storm message',
          'TestUser',
        ),
      );

      await Promise.all(promises);

      // Only one should have been processed (dedup catches the rest)
      expect(handler).toHaveBeenCalledTimes(1);
      expect(caps.sendReadReceipt).toHaveBeenCalledTimes(1);
    });

    it('handles messages from multiple users concurrently', async () => {
      const adapter = createTestAdapter();
      const caps = createRealCapabilities();
      adapter.setBackendCapabilities(caps);
      await adapter.setConnectionState('connected');

      const receivedUsers: string[] = [];
      adapter.onMessage(async (msg) => {
        receivedUsers.push(msg.userId);
      });

      // Two authorized users sending simultaneously
      await Promise.all([
        adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          'multi-user-1',
          'From user 1',
          'Alice',
        ),
        adapter.handleIncomingMessage(
          '447911123456@s.whatsapp.net',
          'multi-user-2',
          'From user 2',
          'Bob',
        ),
      ]);

      expect(receivedUsers).toHaveLength(2);
      expect(receivedUsers).toContain('+14155552671');
      expect(receivedUsers).toContain('+447911123456');
    });
  });
});
