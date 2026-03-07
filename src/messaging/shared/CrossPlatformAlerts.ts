/**
 * CrossPlatformAlerts — Bridges messaging adapters for disconnect alerts
 * and cross-platform attention routing.
 *
 * When WhatsApp disconnects, alerts on Telegram (and vice versa).
 * Surfaces attention items on WhatsApp with interactive buttons.
 */

import type { TelegramAdapter } from '../TelegramAdapter.js';
import type { WhatsAppAdapter } from '../WhatsAppAdapter.js';
import type { BusinessApiBackend, InteractiveMessage } from '../backends/BusinessApiBackend.js';

export interface CrossPlatformAlertsConfig {
  telegram?: TelegramAdapter;
  whatsapp?: WhatsAppAdapter;
  /** BusinessApiBackend instance (only when using business-api backend) */
  businessApiBackend?: BusinessApiBackend;
  /** State manager for reading alert topic IDs */
  getAlertTopicId?: () => number | null;
  /** Owner's WhatsApp JID for attention items */
  ownerWhatsAppJid?: string;
}

export interface AttentionItem {
  id: string;
  title: string;
  body: string;
  actions: Array<{ id: string; title: string }>;
  priority: 'low' | 'medium' | 'high';
  source: string; // e.g., 'stall-detector', 'session-watchdog'
}

export class CrossPlatformAlerts {
  private config: CrossPlatformAlertsConfig;
  private unsubscribers: Array<() => void> = [];
  private started = false;
  private alertHistory: Array<{ timestamp: string; platform: string; message: string }> = [];
  private static readonly MAX_HISTORY = 100;

  constructor(config: CrossPlatformAlertsConfig) {
    this.config = config;
  }

  /** Wire up event listeners across adapters. */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Listen for WhatsApp connection state changes via its event bus
    if (this.config.whatsapp && this.config.telegram) {
      const waBus = this.config.whatsapp.getEventBus();
      // WhatsApp stalls → alert on Telegram
      this.unsubscribers.push(
        waBus.on('stall:detected', async (event) => {
          await this.alertOnTelegram(
            `WhatsApp session "${event.sessionName}" stalled (${event.minutesElapsed}m, ${event.alive ? 'process alive' : 'process dead'})`,
          );
        }),
      );
    }

    // Listen for Telegram stalls → alert on WhatsApp
    // TelegramAdapter doesn't expose event bus the same way, so we skip this for now.
    // Cross-platform Telegram→WhatsApp alerts will be wired when TelegramAdapter gets an event bus.
  }

  /** Stop and clean up all listeners. */
  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.started = false;
  }

  /** Send an alert message on Telegram (used when WhatsApp has issues). */
  async alertOnTelegram(message: string): Promise<void> {
    if (!this.config.telegram) return;

    const topicId = this.config.getAlertTopicId?.();
    if (!topicId) return;

    try {
      await this.config.telegram.sendToTopic(topicId, `[WhatsApp] ${message}`);
      this.recordAlert('telegram', message);
    } catch (err) {
      console.error(`[cross-platform] Failed to alert on Telegram: ${err}`);
    }
  }

  /** Send an alert message on WhatsApp (used when Telegram has issues). */
  async alertOnWhatsApp(message: string): Promise<void> {
    if (!this.config.whatsapp || !this.config.ownerWhatsAppJid) return;

    try {
      await this.config.whatsapp.send({
        userId: this.config.ownerWhatsAppJid,
        content: `[Telegram] ${message}`,
        channel: { type: 'whatsapp', identifier: this.config.ownerWhatsAppJid },
      });
      this.recordAlert('whatsapp', message);
    } catch (err) {
      console.error(`[cross-platform] Failed to alert on WhatsApp: ${err}`);
    }
  }

  /**
   * Send an attention item on WhatsApp with interactive buttons.
   * Falls back to plain text if BusinessApiBackend is not available.
   */
  async sendAttentionItem(item: AttentionItem): Promise<void> {
    if (!this.config.ownerWhatsAppJid) return;

    // Try interactive buttons first (Business API only)
    if (this.config.businessApiBackend) {
      try {
        const buttons = item.actions.slice(0, 3).map(action => ({
          type: 'reply' as const,
          reply: { id: action.id, title: action.title },
        }));

        const message: InteractiveMessage = {
          type: 'button',
          header: { type: 'text', text: `${item.priority === 'high' ? '!' : ''} ${item.title}`.trim() },
          body: { text: item.body },
          footer: { text: `Source: ${item.source}` },
          action: { buttons },
        };

        await this.config.businessApiBackend.sendInteractiveMessage(
          this.config.ownerWhatsAppJid,
          message,
        );
        this.recordAlert('whatsapp', `Attention: ${item.title}`);
        return;
      } catch (err) {
        console.error(`[cross-platform] Interactive message failed, falling back to text: ${err}`);
      }
    }

    // Fallback: plain text with action labels
    if (this.config.whatsapp) {
      const actionLabels = item.actions.map(a => `  - ${a.title}`).join('\n');
      const text = `*${item.title}*\n\n${item.body}\n\nActions:\n${actionLabels}`;
      await this.config.whatsapp.send({
        userId: this.config.ownerWhatsAppJid!,
        content: text,
        channel: { type: 'whatsapp', identifier: this.config.ownerWhatsAppJid! },
      });
      this.recordAlert('whatsapp', `Attention: ${item.title}`);
    }
  }

  /** Get recent alert history. */
  getAlertHistory(): Array<{ timestamp: string; platform: string; message: string }> {
    return [...this.alertHistory];
  }

  /** Check if the module is started and has any adapters configured. */
  getStatus(): { started: boolean; telegramAvailable: boolean; whatsappAvailable: boolean; alertsSent: number } {
    return {
      started: this.started,
      telegramAvailable: !!this.config.telegram,
      whatsappAvailable: !!this.config.whatsapp,
      alertsSent: this.alertHistory.length,
    };
  }

  private recordAlert(platform: string, message: string): void {
    this.alertHistory.push({ timestamp: new Date().toISOString(), platform, message });
    if (this.alertHistory.length > CrossPlatformAlerts.MAX_HISTORY) {
      this.alertHistory.shift();
    }
  }
}
