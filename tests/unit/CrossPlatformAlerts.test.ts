/**
 * Unit tests for CrossPlatformAlerts — cross-platform disconnect alerts
 * and attention item routing between Telegram and WhatsApp.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CrossPlatformAlerts,
  type CrossPlatformAlertsConfig,
  type AttentionItem,
} from '../../src/messaging/shared/CrossPlatformAlerts.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { WhatsAppAdapter } from '../../src/messaging/WhatsAppAdapter.js';
import type { BusinessApiBackend, InteractiveMessage } from '../../src/messaging/backends/BusinessApiBackend.js';
import { MessagingEventBus } from '../../src/messaging/shared/MessagingEventBus.js';

// ── Test helpers ──────────────────────────────────────

function createMockTelegram(): TelegramAdapter {
  return {
    sendToTopic: vi.fn().mockResolvedValue({ messageId: 1 }),
    platform: 'telegram',
  } as unknown as TelegramAdapter;
}

function createMockWhatsApp(eventBus?: MessagingEventBus): WhatsAppAdapter {
  const bus = eventBus ?? new MessagingEventBus('whatsapp');
  return {
    send: vi.fn().mockResolvedValue(undefined),
    getEventBus: () => bus,
    platform: 'whatsapp',
  } as unknown as WhatsAppAdapter;
}

function createMockBusinessBackend(): BusinessApiBackend {
  return {
    sendInteractiveMessage: vi.fn().mockResolvedValue('wamid.interactive-123'),
    sendTextMessage: vi.fn().mockResolvedValue('wamid.text-123'),
  } as unknown as BusinessApiBackend;
}

function createAttentionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'attn-1',
    title: 'Session Stalled',
    body: 'Session "dev" has not responded in 5 minutes.',
    actions: [
      { id: 'restart', title: 'Restart Session' },
      { id: 'ignore', title: 'Ignore' },
    ],
    priority: 'high',
    source: 'stall-detector',
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────

describe('CrossPlatformAlerts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Construction and lifecycle ──────────────────────

  describe('lifecycle', () => {
    it('starts and stops cleanly', () => {
      const alerts = new CrossPlatformAlerts({});

      alerts.start();
      expect(alerts.getStatus().started).toBe(true);

      alerts.stop();
      expect(alerts.getStatus().started).toBe(false);
    });

    it('start is idempotent', () => {
      const alerts = new CrossPlatformAlerts({});
      alerts.start();
      alerts.start(); // should not throw or double-subscribe
      expect(alerts.getStatus().started).toBe(true);
    });

    it('reports adapter availability', () => {
      const telegram = createMockTelegram();
      const whatsapp = createMockWhatsApp();
      const alerts = new CrossPlatformAlerts({ telegram, whatsapp });

      const status = alerts.getStatus();
      expect(status.telegramAvailable).toBe(true);
      expect(status.whatsappAvailable).toBe(true);
      expect(status.alertsSent).toBe(0);
    });

    it('reports no adapters when none configured', () => {
      const alerts = new CrossPlatformAlerts({});
      const status = alerts.getStatus();
      expect(status.telegramAvailable).toBe(false);
      expect(status.whatsappAvailable).toBe(false);
    });
  });

  // ── alertOnTelegram ──────────────────────────────────

  describe('alertOnTelegram', () => {
    it('sends alert to Telegram when topic ID is available', async () => {
      const telegram = createMockTelegram();
      const alerts = new CrossPlatformAlerts({
        telegram,
        getAlertTopicId: () => 42,
      });

      await alerts.alertOnTelegram('WhatsApp disconnected');

      expect(telegram.sendToTopic).toHaveBeenCalledWith(
        42,
        '[WhatsApp] WhatsApp disconnected',
      );
    });

    it('does nothing without Telegram adapter', async () => {
      const alerts = new CrossPlatformAlerts({ getAlertTopicId: () => 42 });
      await alerts.alertOnTelegram('test');
      // Should not throw
    });

    it('does nothing without alert topic ID', async () => {
      const telegram = createMockTelegram();
      const alerts = new CrossPlatformAlerts({
        telegram,
        getAlertTopicId: () => null,
      });

      await alerts.alertOnTelegram('test');
      expect(telegram.sendToTopic).not.toHaveBeenCalled();
    });

    it('records alert in history', async () => {
      const telegram = createMockTelegram();
      const alerts = new CrossPlatformAlerts({
        telegram,
        getAlertTopicId: () => 42,
      });

      await alerts.alertOnTelegram('Connection lost');

      const history = alerts.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].platform).toBe('telegram');
      expect(history[0].message).toBe('Connection lost');
    });

    it('handles Telegram send failure gracefully', async () => {
      const telegram = createMockTelegram();
      (telegram.sendToTopic as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const alerts = new CrossPlatformAlerts({
        telegram,
        getAlertTopicId: () => 42,
      });

      await alerts.alertOnTelegram('test');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to alert on Telegram'));
      consoleSpy.mockRestore();
    });
  });

  // ── alertOnWhatsApp ──────────────────────────────────

  describe('alertOnWhatsApp', () => {
    it('sends alert to WhatsApp owner', async () => {
      const whatsapp = createMockWhatsApp();
      const alerts = new CrossPlatformAlerts({
        whatsapp,
        ownerWhatsAppJid: '14155551234@s.whatsapp.net',
      });

      await alerts.alertOnWhatsApp('Telegram disconnected');

      expect(whatsapp.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '[Telegram] Telegram disconnected',
          channel: { type: 'whatsapp', identifier: '14155551234@s.whatsapp.net' },
        }),
      );
    });

    it('does nothing without WhatsApp adapter', async () => {
      const alerts = new CrossPlatformAlerts({
        ownerWhatsAppJid: '14155551234@s.whatsapp.net',
      });
      await alerts.alertOnWhatsApp('test');
      // Should not throw
    });

    it('does nothing without owner JID', async () => {
      const whatsapp = createMockWhatsApp();
      const alerts = new CrossPlatformAlerts({ whatsapp });

      await alerts.alertOnWhatsApp('test');
      expect(whatsapp.send).not.toHaveBeenCalled();
    });

    it('records alert in history', async () => {
      const whatsapp = createMockWhatsApp();
      const alerts = new CrossPlatformAlerts({
        whatsapp,
        ownerWhatsAppJid: '14155551234@s.whatsapp.net',
      });

      await alerts.alertOnWhatsApp('Connection lost');

      const history = alerts.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].platform).toBe('whatsapp');
    });
  });

  // ── sendAttentionItem ──────────────────────────────

  describe('sendAttentionItem', () => {
    it('sends interactive button message via Business API', async () => {
      const backend = createMockBusinessBackend();
      const alerts = new CrossPlatformAlerts({
        businessApiBackend: backend,
        ownerWhatsAppJid: '14155551234@s.whatsapp.net',
      });

      const item = createAttentionItem();
      await alerts.sendAttentionItem(item);

      expect(backend.sendInteractiveMessage).toHaveBeenCalledWith(
        '14155551234@s.whatsapp.net',
        expect.objectContaining({
          type: 'button',
          header: { type: 'text', text: '! Session Stalled' },
          body: { text: 'Session "dev" has not responded in 5 minutes.' },
          footer: { text: 'Source: stall-detector' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'restart', title: 'Restart Session' } },
              { type: 'reply', reply: { id: 'ignore', title: 'Ignore' } },
            ],
          },
        }),
      );
    });

    it('truncates to max 3 buttons', async () => {
      const backend = createMockBusinessBackend();
      const alerts = new CrossPlatformAlerts({
        businessApiBackend: backend,
        ownerWhatsAppJid: '14155551234@s.whatsapp.net',
      });

      const item = createAttentionItem({
        actions: [
          { id: '1', title: 'A' },
          { id: '2', title: 'B' },
          { id: '3', title: 'C' },
          { id: '4', title: 'D' },
        ],
      });

      await alerts.sendAttentionItem(item);

      const call = (backend.sendInteractiveMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const message = call[1] as InteractiveMessage;
      expect(message.action.buttons).toHaveLength(3);
    });

    it('falls back to plain text without Business API', async () => {
      const whatsapp = createMockWhatsApp();
      const alerts = new CrossPlatformAlerts({
        whatsapp,
        ownerWhatsAppJid: '14155551234@s.whatsapp.net',
      });

      const item = createAttentionItem();
      await alerts.sendAttentionItem(item);

      expect(whatsapp.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('*Session Stalled*'),
        }),
      );
    });

    it('falls back to text when interactive send fails', async () => {
      const backend = createMockBusinessBackend();
      (backend.sendInteractiveMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));
      const whatsapp = createMockWhatsApp();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const alerts = new CrossPlatformAlerts({
        whatsapp,
        businessApiBackend: backend,
        ownerWhatsAppJid: '14155551234@s.whatsapp.net',
      });

      await alerts.sendAttentionItem(createAttentionItem());

      // Should have tried interactive first
      expect(backend.sendInteractiveMessage).toHaveBeenCalled();
      // Then fallen back to text
      expect(whatsapp.send).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('does nothing without owner JID', async () => {
      const backend = createMockBusinessBackend();
      const whatsapp = createMockWhatsApp();
      const alerts = new CrossPlatformAlerts({
        whatsapp,
        businessApiBackend: backend,
      });

      await alerts.sendAttentionItem(createAttentionItem());
      expect(backend.sendInteractiveMessage).not.toHaveBeenCalled();
      expect(whatsapp.send).not.toHaveBeenCalled();
    });

    it('omits ! prefix for non-high priority items', async () => {
      const backend = createMockBusinessBackend();
      const alerts = new CrossPlatformAlerts({
        businessApiBackend: backend,
        ownerWhatsAppJid: '14155551234@s.whatsapp.net',
      });

      await alerts.sendAttentionItem(createAttentionItem({ priority: 'medium' }));

      const call = (backend.sendInteractiveMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const message = call[1] as InteractiveMessage;
      expect(message.header?.text).toBe('Session Stalled');
    });

    it('records attention item in alert history', async () => {
      const backend = createMockBusinessBackend();
      const alerts = new CrossPlatformAlerts({
        businessApiBackend: backend,
        ownerWhatsAppJid: '14155551234@s.whatsapp.net',
      });

      await alerts.sendAttentionItem(createAttentionItem());

      const history = alerts.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].message).toContain('Attention: Session Stalled');
    });
  });

  // ── Cross-platform event wiring ──────────────────────

  describe('cross-platform event wiring', () => {
    it('alerts on Telegram when WhatsApp stall is detected', async () => {
      const eventBus = new MessagingEventBus('whatsapp');
      const telegram = createMockTelegram();
      const whatsapp = createMockWhatsApp(eventBus);

      const alerts = new CrossPlatformAlerts({
        telegram,
        whatsapp,
        getAlertTopicId: () => 42,
      });

      alerts.start();

      // Simulate a stall event from WhatsApp
      await eventBus.emit('stall:detected', {
        channelId: '14155551234@s.whatsapp.net',
        sessionName: 'dev',
        messageText: 'Hello',
        injectedAt: Date.now() - 300000,
        minutesElapsed: 5,
        alive: true,
      });

      expect(telegram.sendToTopic).toHaveBeenCalledWith(
        42,
        expect.stringContaining('WhatsApp session "dev" stalled (5m, process alive)'),
      );
    });

    it('does not wire events when only one adapter is available', async () => {
      const telegram = createMockTelegram();
      const alerts = new CrossPlatformAlerts({
        telegram,
        getAlertTopicId: () => 42,
      });

      alerts.start();
      // No WhatsApp = no event listeners to wire
      // No crash = success
      expect(alerts.getStatus().started).toBe(true);
    });

    it('cleans up event listeners on stop', async () => {
      const eventBus = new MessagingEventBus('whatsapp');
      const telegram = createMockTelegram();
      const whatsapp = createMockWhatsApp(eventBus);

      const alerts = new CrossPlatformAlerts({
        telegram,
        whatsapp,
        getAlertTopicId: () => 42,
      });

      alerts.start();
      alerts.stop();

      // Event after stop should not trigger alert
      await eventBus.emit('stall:detected', {
        channelId: '14155551234@s.whatsapp.net',
        sessionName: 'dev',
        messageText: 'Hello',
        injectedAt: Date.now(),
        minutesElapsed: 5,
        alive: true,
      });

      expect(telegram.sendToTopic).not.toHaveBeenCalled();
    });
  });

  // ── Alert history management ──────────────────────

  describe('alert history', () => {
    it('caps history at MAX_HISTORY entries', async () => {
      const telegram = createMockTelegram();
      const alerts = new CrossPlatformAlerts({
        telegram,
        getAlertTopicId: () => 42,
      });

      // Send 110 alerts (max is 100)
      for (let i = 0; i < 110; i++) {
        await alerts.alertOnTelegram(`Alert ${i}`);
      }

      const history = alerts.getAlertHistory();
      expect(history.length).toBeLessThanOrEqual(100);
      // Oldest should be trimmed
      expect(history[0].message).toBe('Alert 10');
    });

    it('returns a copy of history (not mutable reference)', async () => {
      const telegram = createMockTelegram();
      const alerts = new CrossPlatformAlerts({
        telegram,
        getAlertTopicId: () => 42,
      });

      await alerts.alertOnTelegram('test');
      const history1 = alerts.getAlertHistory();
      history1.push({ timestamp: 'fake', platform: 'fake', message: 'fake' });

      const history2 = alerts.getAlertHistory();
      expect(history2).toHaveLength(1); // Original unmodified
    });
  });
});
