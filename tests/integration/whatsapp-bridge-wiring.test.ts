/**
 * WhatsApp Bridge Wiring Integration Test
 *
 * Verifies the MessageBridge is correctly wired in the server.ts startup path.
 * Tests the full wiring chain: adapter event buses -> bridge -> cross-platform forwarding.
 *
 * Uses REAL instances of WhatsAppAdapter, MessageBridge, and MessagingEventBus.
 * Only mocks the actual network send functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WhatsAppAdapter } from '../../src/messaging/WhatsAppAdapter.js';
import { MessageBridge } from '../../src/messaging/shared/MessageBridge.js';
import { MessagingEventBus } from '../../src/messaging/shared/MessagingEventBus.js';

// ── Helpers ──────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-bridge-wiring-'));
}

function makeWhatsAppAdapter(tmpDir: string): WhatsAppAdapter {
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  return new WhatsAppAdapter(
    {
      authorizedNumbers: ['+14155551234'],
      requireConsent: false,
      stallTimeoutMinutes: 60, // disable stall detection noise
    },
    stateDir,
  );
}

/** Create a JID from a phone number */
function phoneJid(phone: string): string {
  return `${phone.replace('+', '')}@s.whatsapp.net`;
}

const TEST_JID_A = phoneJid('+14155551234');
const TEST_JID_B = phoneJid('+14155559999');
const TEST_JID_C = phoneJid('+14155550000');
const TELEGRAM_TOPIC_1 = 1001;
const TELEGRAM_TOPIC_2 = 1002;

// ── Tests ──────────────────────────────────────────────────

describe('WhatsApp Bridge Wiring Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ════════════════════════════════════════════════════════════
  // 1. Bridge Wiring with Real Adapters
  // ════════════════════════════════════════════════════════════

  describe('Bridge wiring with real adapters', () => {
    it('forwards WhatsApp messages to Telegram with [via WhatsApp] prefix', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      // Wire a no-op send function so the adapter doesn't queue outbound
      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.start();

      await adapter.handleIncomingMessage(
        TEST_JID_A,
        'msg-001',
        'Hello from WhatsApp',
        'Alice',
      );

      expect(sendToTelegram).toHaveBeenCalledTimes(1);
      const [topicId, text] = sendToTelegram.mock.calls[0];
      expect(topicId).toBe(TELEGRAM_TOPIC_1);
      expect(text).toContain('[via WhatsApp]');
      expect(text).toContain('Alice');
      expect(text).toContain('Hello from WhatsApp');

      bridge.stop();
      await adapter.stop();
    });

    it('includes sender name in the bridged message', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.start();

      await adapter.handleIncomingMessage(
        TEST_JID_A,
        'msg-002',
        'Test message',
        'Bob',
      );

      expect(sendToTelegram).toHaveBeenCalledOnce();
      expect(sendToTelegram.mock.calls[0][1]).toBe('[via WhatsApp] Bob: Test message');

      bridge.stop();
      await adapter.stop();
    });

    it('does not forward messages from unlinked channels', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      // Authorize the unlinked number too
      adapter.getAuthGate().authorize('+14155559999');

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: telegramBus,
      });

      // Only link JID_A, not JID_B
      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.start();

      // Message from an unlinked channel — should NOT forward
      await adapter.handleIncomingMessage(
        TEST_JID_B,
        'msg-003',
        'Should not bridge',
        'Eve',
      );

      expect(sendToTelegram).not.toHaveBeenCalled();

      bridge.stop();
      await adapter.stop();
    });
  });

  // ════════════════════════════════════════════════════════════
  // 2. Bridge + Adapter Stop/Start Lifecycle
  // ════════════════════════════════════════════════════════════

  describe('Bridge + adapter stop/start lifecycle', () => {
    it('does not forward messages after bridge is stopped', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.start();
      bridge.stop();

      await adapter.handleIncomingMessage(
        TEST_JID_A,
        'msg-010',
        'After stop',
        'Alice',
      );

      expect(sendToTelegram).not.toHaveBeenCalled();
      await adapter.stop();
    });

    it('resumes forwarding after bridge restart', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.start();
      bridge.stop();

      // Message while stopped — should not forward
      await adapter.handleIncomingMessage(
        TEST_JID_A,
        'msg-011',
        'While stopped',
        'Alice',
      );
      expect(sendToTelegram).not.toHaveBeenCalled();

      // Restart bridge
      bridge.start();

      await adapter.handleIncomingMessage(
        TEST_JID_A,
        'msg-012',
        'After restart',
        'Alice',
      );

      expect(sendToTelegram).toHaveBeenCalledOnce();
      expect(sendToTelegram.mock.calls[0][1]).toContain('After restart');

      bridge.stop();
      await adapter.stop();
    });

    it('bridge status reflects started/stopped state', async () => {
      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
      });

      expect(bridge.getStatus().started).toBe(false);
      bridge.start();
      expect(bridge.getStatus().started).toBe(true);
      bridge.stop();
      expect(bridge.getStatus().started).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 3. Bridge Persistence Across Restarts
  // ════════════════════════════════════════════════════════════

  describe('Bridge persistence across restarts', () => {
    it('persists links to disk and reloads them on new instance', async () => {
      const registryPath = path.join(tmpDir, 'bridge', 'registry.json');

      // Instance 1: add links and save
      const bridge1 = new MessageBridge({ registryPath });
      bridge1.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'user-a');
      bridge1.addLink(TEST_JID_B, TELEGRAM_TOPIC_2, 'user-b');

      expect(bridge1.getLinks()).toHaveLength(2);

      // Verify file exists on disk
      expect(fs.existsSync(registryPath)).toBe(true);

      // Destroy instance 1 — no explicit destroy method, just stop and discard
      bridge1.stop();

      // Instance 2: should load persisted links
      const bridge2 = new MessageBridge({ registryPath });
      const links = bridge2.getLinks();

      expect(links).toHaveLength(2);
      expect(links.find(l => l.whatsappChannelId === TEST_JID_A)?.telegramTopicId).toBe(TELEGRAM_TOPIC_1);
      expect(links.find(l => l.whatsappChannelId === TEST_JID_B)?.telegramTopicId).toBe(TELEGRAM_TOPIC_2);
      expect(links[0].createdBy).toBe('user-a');
      expect(links[1].createdBy).toBe('user-b');
    });

    it('persisted links enable forwarding on new bridge instance', async () => {
      const registryPath = path.join(tmpDir, 'bridge', 'registry.json');

      // Instance 1: create links
      const bridge1 = new MessageBridge({ registryPath });
      bridge1.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge1.stop();

      // Instance 2: wire up with real adapter and verify forwarding works
      const adapter = makeWhatsAppAdapter(tmpDir);
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      const bridge2 = new MessageBridge({
        registryPath,
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: new MessagingEventBus('telegram'),
      });

      bridge2.start();

      await adapter.handleIncomingMessage(
        TEST_JID_A,
        'msg-020',
        'Persisted link test',
        'Alice',
      );

      expect(sendToTelegram).toHaveBeenCalledOnce();
      expect(sendToTelegram.mock.calls[0][1]).toContain('Persisted link test');

      bridge2.stop();
      await adapter.stop();
    });
  });

  // ════════════════════════════════════════════════════════════
  // 4. Event Bus Integration
  // ════════════════════════════════════════════════════════════

  describe('Event bus integration', () => {
    it('WhatsApp adapter getEventBus() returns a real MessagingEventBus', () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const bus = adapter.getEventBus();

      expect(bus).toBeInstanceOf(MessagingEventBus);
      expect(bus.getPlatform()).toBe('whatsapp');
    });

    it('handleIncomingMessage emits message:logged on the event bus', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      const bus = adapter.getEventBus();
      const events: unknown[] = [];
      bus.on('message:logged', (event) => {
        events.push(event);
      });

      await adapter.handleIncomingMessage(
        TEST_JID_A,
        'msg-030',
        'Event bus test',
        'Alice',
      );

      // Should have emitted at least one message:logged event
      expect(events.length).toBeGreaterThanOrEqual(1);
      const logged = events.find(
        (e: any) => e.fromUser === true && e.text === 'Event bus test',
      );
      expect(logged).toBeDefined();

      await adapter.stop();
    });

    it('bridge receives message:logged events from the WhatsApp event bus', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.start();

      // Verify bridge is subscribed to the event bus
      expect(adapter.getEventBus().listenerCount('message:logged')).toBeGreaterThanOrEqual(1);

      await adapter.handleIncomingMessage(
        TEST_JID_A,
        'msg-031',
        'Bridge event test',
        'Alice',
      );

      // Bridge should have received the event and forwarded
      expect(sendToTelegram).toHaveBeenCalledOnce();
      expect(bridge.getStatus().messagesBridged).toBe(1);

      bridge.stop();
      await adapter.stop();
    });

    it('Telegram event bus message:logged events trigger WhatsApp forwarding', async () => {
      const telegramBus = new MessagingEventBus('telegram');
      const sendToWhatsApp = vi.fn<[string, string], Promise<void>>().mockResolvedValue(undefined);

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToWhatsApp,
        telegramEventBus: telegramBus,
        whatsappEventBus: new MessagingEventBus('whatsapp'),
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.start();

      // Simulate Telegram message:logged event
      await telegramBus.emit('message:logged', {
        messageId: 12345,
        channelId: String(TELEGRAM_TOPIC_1),
        text: 'Hello from Telegram',
        fromUser: true,
        timestamp: new Date().toISOString(),
        sessionName: null,
        senderName: 'TelegramUser',
      });

      expect(sendToWhatsApp).toHaveBeenCalledOnce();
      const [jid, text] = sendToWhatsApp.mock.calls[0];
      expect(jid).toBe(TEST_JID_A);
      expect(text).toContain('[via Telegram]');
      expect(text).toContain('TelegramUser');
      expect(text).toContain('Hello from Telegram');

      bridge.stop();
    });
  });

  // ════════════════════════════════════════════════════════════
  // 5. Multi-Link Forwarding
  // ════════════════════════════════════════════════════════════

  describe('Multi-link forwarding', () => {
    it('routes WhatsApp A to Telegram 1 only', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      // Authorize both numbers
      adapter.getAuthGate().authorize('+14155559999');

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.addLink(TEST_JID_B, TELEGRAM_TOPIC_2, 'test');
      bridge.start();

      await adapter.handleIncomingMessage(
        TEST_JID_A,
        'msg-050',
        'From A',
        'Alice',
      );

      expect(sendToTelegram).toHaveBeenCalledOnce();
      expect(sendToTelegram.mock.calls[0][0]).toBe(TELEGRAM_TOPIC_1);
      expect(sendToTelegram.mock.calls[0][1]).toContain('From A');

      bridge.stop();
      await adapter.stop();
    });

    it('routes WhatsApp B to Telegram 2 only', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      // Authorize B
      adapter.getAuthGate().authorize('+14155559999');

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.addLink(TEST_JID_B, TELEGRAM_TOPIC_2, 'test');
      bridge.start();

      await adapter.handleIncomingMessage(
        TEST_JID_B,
        'msg-051',
        'From B',
        'Bob',
      );

      expect(sendToTelegram).toHaveBeenCalledOnce();
      expect(sendToTelegram.mock.calls[0][0]).toBe(TELEGRAM_TOPIC_2);
      expect(sendToTelegram.mock.calls[0][1]).toContain('From B');

      bridge.stop();
      await adapter.stop();
    });

    it('does not forward messages from unlinked channel C', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      // Authorize C
      adapter.getAuthGate().authorize('+14155550000');

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.addLink(TEST_JID_B, TELEGRAM_TOPIC_2, 'test');
      bridge.start();

      // C is not linked
      await adapter.handleIncomingMessage(
        TEST_JID_C,
        'msg-052',
        'From C',
        'Charlie',
      );

      expect(sendToTelegram).not.toHaveBeenCalled();

      bridge.stop();
      await adapter.stop();
    });

    it('bridge status tracks messagesBridged count correctly', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      adapter.getAuthGate().authorize('+14155559999');

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.addLink(TEST_JID_B, TELEGRAM_TOPIC_2, 'test');
      bridge.start();

      expect(bridge.getStatus().messagesBridged).toBe(0);

      await adapter.handleIncomingMessage(TEST_JID_A, 'msg-060', 'First', 'Alice');
      expect(bridge.getStatus().messagesBridged).toBe(1);

      await adapter.handleIncomingMessage(TEST_JID_B, 'msg-061', 'Second', 'Bob');
      expect(bridge.getStatus().messagesBridged).toBe(2);

      // Unlinked — should not increment
      await adapter.handleIncomingMessage(TEST_JID_C, 'msg-062', 'Third', 'Charlie');
      expect(bridge.getStatus().messagesBridged).toBe(2);

      bridge.stop();
      await adapter.stop();
    });
  });

  // ════════════════════════════════════════════════════════════
  // Additional edge cases
  // ════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('does not bridge bot-outbound messages (fromUser=false)', async () => {
      const telegramBus = new MessagingEventBus('telegram');
      const whatsappBus = new MessagingEventBus('whatsapp');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: whatsappBus,
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.start();

      // Emit a bot-outbound message (fromUser: false)
      await whatsappBus.emit('message:logged', {
        messageId: 99999,
        channelId: TEST_JID_A,
        text: 'Bot response',
        fromUser: false,
        timestamp: new Date().toISOString(),
        sessionName: null,
      });

      expect(sendToTelegram).not.toHaveBeenCalled();

      bridge.stop();
    });

    it('loop detection: does not re-bridge messages with [via Telegram] prefix', async () => {
      const whatsappBus = new MessagingEventBus('whatsapp');
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: whatsappBus,
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.start();

      // Emit a message that was already bridged from Telegram
      await whatsappBus.emit('message:logged', {
        messageId: 88888,
        channelId: TEST_JID_A,
        text: '[via Telegram] SomeUser: already bridged',
        fromUser: true,
        timestamp: new Date().toISOString(),
        sessionName: null,
      });

      expect(sendToTelegram).not.toHaveBeenCalled();

      bridge.stop();
    });

    it('removing a link stops forwarding for that channel', async () => {
      const adapter = makeWhatsAppAdapter(tmpDir);
      const telegramBus = new MessagingEventBus('telegram');
      const sendToTelegram = vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined);

      adapter.setSendFunction(vi.fn().mockResolvedValue(undefined));
      await adapter.setConnectionState('connected', '+14155551234');

      const bridge = new MessageBridge({
        registryPath: path.join(tmpDir, 'bridge-registry.json'),
        sendToTelegram,
        whatsappEventBus: adapter.getEventBus(),
        telegramEventBus: telegramBus,
      });

      bridge.addLink(TEST_JID_A, TELEGRAM_TOPIC_1, 'test');
      bridge.start();

      // First message — should forward
      await adapter.handleIncomingMessage(TEST_JID_A, 'msg-070', 'Before unlink', 'Alice');
      expect(sendToTelegram).toHaveBeenCalledOnce();

      // Remove the link
      bridge.removeLinkByWhatsApp(TEST_JID_A);

      // Second message — should NOT forward
      await adapter.handleIncomingMessage(TEST_JID_A, 'msg-071', 'After unlink', 'Alice');
      expect(sendToTelegram).toHaveBeenCalledOnce(); // still 1, not 2

      bridge.stop();
      await adapter.stop();
    });
  });
});
