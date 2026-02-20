/**
 * Feedback Manager — handles the agent-to-origin feedback loop.
 *
 * Stores feedback locally and forwards it to a configured webhook URL.
 * This is the "phone home" mechanism: agents can report issues, request
 * features, and provide feedback that flows back to the Instar maintainers.
 *
 * Part of the "Rising Tide" system — every user's feedback improves
 * the platform for everyone.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FeedbackItem, FeedbackConfig } from './types.js';

export class FeedbackManager {
  private config: FeedbackConfig;
  private feedbackFile: string;

  constructor(config: FeedbackConfig) {
    this.config = config;
    this.feedbackFile = config.feedbackFile;
  }

  /**
   * Submit feedback — stores locally and forwards to webhook.
   */
  async submit(item: Omit<FeedbackItem, 'id' | 'submittedAt' | 'forwarded'>): Promise<FeedbackItem> {
    const feedback: FeedbackItem = {
      ...item,
      id: `fb-${randomUUID().slice(0, 12)}`,
      submittedAt: new Date().toISOString(),
      forwarded: false,
    };

    // Store locally first (receipt)
    this.appendFeedback(feedback);

    // Forward to webhook if enabled
    if (this.config.enabled && this.config.webhookUrl) {
      try {
        const response = await fetch(this.config.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(feedback),
          signal: AbortSignal.timeout(10000), // 10s timeout
        });

        if (response.ok) {
          feedback.forwarded = true;
          this.updateFeedback(feedback);
          console.log(`[feedback] Forwarded to ${this.config.webhookUrl}`);
        } else {
          console.error(`[feedback] Webhook returned ${response.status}: ${response.statusText}`);
        }
      } catch (err) {
        // Don't fail on webhook errors — the local record is the receipt
        console.error(`[feedback] Webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return feedback;
  }

  /**
   * List all stored feedback.
   */
  list(): FeedbackItem[] {
    return this.loadFeedback();
  }

  /**
   * Get a single feedback item by ID.
   */
  get(id: string): FeedbackItem | null {
    const items = this.loadFeedback();
    return items.find(f => f.id === id) ?? null;
  }

  /**
   * Retry forwarding any un-forwarded feedback.
   */
  async retryUnforwarded(): Promise<{ retried: number; succeeded: number }> {
    const items = this.loadFeedback();
    const unforwarded = items.filter(f => !f.forwarded);

    if (!this.config.enabled || !this.config.webhookUrl || unforwarded.length === 0) {
      return { retried: 0, succeeded: 0 };
    }

    let succeeded = 0;
    for (const item of unforwarded) {
      try {
        const response = await fetch(this.config.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item),
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          item.forwarded = true;
          succeeded++;
        }
      } catch {
        // Skip, will retry next time
      }
    }

    if (succeeded > 0) {
      this.saveFeedback(items);
    }

    return { retried: unforwarded.length, succeeded };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private loadFeedback(): FeedbackItem[] {
    if (!fs.existsSync(this.feedbackFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.feedbackFile, 'utf-8'));
    } catch {
      return [];
    }
  }

  private saveFeedback(items: FeedbackItem[]): void {
    const dir = path.dirname(this.feedbackFile);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to .tmp then rename
    const tmpPath = this.feedbackFile + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(items, null, 2));
    fs.renameSync(tmpPath, this.feedbackFile);
  }

  private appendFeedback(item: FeedbackItem): void {
    const items = this.loadFeedback();
    items.push(item);
    this.saveFeedback(items);
  }

  private updateFeedback(updated: FeedbackItem): void {
    const items = this.loadFeedback();
    const idx = items.findIndex(f => f.id === updated.id);
    if (idx >= 0) {
      items[idx] = updated;
      this.saveFeedback(items);
    }
  }
}
