/**
 * NotificationBatcher - Batches non-critical Telegram notifications into periodic digests.
 *
 * Classifies notifications into three tiers:
 * - IMMEDIATE: Sent instantly (stall alerts, triage, quota warnings)
 * - SUMMARY: Batched every 30 min (job completions, attention items, session lifecycle)
 * - DIGEST: Batched every 2 hours (routine system notices)
 *
 * Born from: Matthew Berman OpenClaw analysis (2026-02-25)
 */

export type NotificationTier = 'IMMEDIATE' | 'SUMMARY' | 'DIGEST';

export interface BatchedNotification {
  tier: NotificationTier;
  category: string;
  message: string;
  timestamp: Date;
  topicId: number;
}

export interface BatcherConfig {
  enabled: boolean;
  summaryIntervalMinutes: number;
  digestIntervalMinutes: number;
  quietHours?: {
    enabled: boolean;
    start: string;   // "HH:MM"
    end: string;     // "HH:MM"
  };
}

interface QueuedNotification {
  category: string;
  message: string;
  timestamp: Date;
  topicId: number;
  dedupKey: string;
  count: number;
}

export interface BatcherStats {
  summaryQueueSize: number;
  digestQueueSize: number;
  totalFlushed: number;
  lastSummaryFlush: Date | null;
  lastDigestFlush: Date | null;
}

export type SendFunction = (topicId: number, text: string) => Promise<{ messageId: number }>;

const CATEGORY_HEADERS: Record<string, string> = {
  'job-complete': 'JOBS',
  'attention-update': 'ATTENTION',
  'session-lifecycle': 'SESSIONS',
  'quota': 'QUOTA',
  'system': 'SYSTEM',
};

const DEFAULT_CONFIG: BatcherConfig = {
  enabled: true,
  summaryIntervalMinutes: 30,
  digestIntervalMinutes: 120,
};

export class NotificationBatcher {
  private summaryQueue: QueuedNotification[] = [];
  private digestQueue: QueuedNotification[] = [];
  private sendFn: SendFunction | null = null;
  private config: BatcherConfig;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastSummaryFlush: Date | null = null;
  private lastDigestFlush: Date | null = null;
  private totalFlushed = 0;

  constructor(config?: Partial<BatcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setSendFunction(sendFn: SendFunction): void {
    this.sendFn = sendFn;
  }

  start(): void {
    if (this.flushTimer) return;

    const now = new Date();
    this.lastSummaryFlush = now;
    this.lastDigestFlush = now;

    this.flushTimer = setInterval(() => this.checkFlush(), 60_000);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async enqueue(notification: BatchedNotification): Promise<void> {
    let effectiveTier = notification.tier;

    // Quiet hours: demote SUMMARY to DIGEST
    if (effectiveTier === 'SUMMARY' && this.isQuietHours()) {
      effectiveTier = 'DIGEST';
    }

    if (effectiveTier === 'IMMEDIATE') {
      await this.sendDirect(notification.topicId, notification.message);
      return;
    }

    const dedupKey = this.generateDedupKey(notification.category, notification.message);
    const queue = effectiveTier === 'SUMMARY' ? this.summaryQueue : this.digestQueue;

    // Dedup: if an identical notification shape already exists in this batch window, collapse it
    const existing = queue.find(q => q.dedupKey === dedupKey && q.topicId === notification.topicId);
    if (existing) {
      existing.count++;
      existing.timestamp = notification.timestamp; // Update to latest
      return;
    }

    queue.push({
      category: notification.category,
      message: notification.message,
      timestamp: notification.timestamp,
      topicId: notification.topicId,
      dedupKey,
      count: 1,
    });
  }

  async flushAll(): Promise<number> {
    let flushed = 0;
    flushed += await this.flush('SUMMARY');
    flushed += await this.flush('DIGEST');
    return flushed;
  }

  async flush(tier: 'SUMMARY' | 'DIGEST'): Promise<number> {
    const queue = tier === 'SUMMARY' ? this.summaryQueue : this.digestQueue;
    if (queue.length === 0) return 0;

    const items = queue.splice(0, queue.length);
    const tierLabel = tier === 'SUMMARY' ? 'Summary' : 'Digest';

    // Group by topicId
    const byTopic = new Map<number, QueuedNotification[]>();
    for (const item of items) {
      const existing = byTopic.get(item.topicId) || [];
      existing.push(item);
      byTopic.set(item.topicId, existing);
    }

    for (const [topicId, topicItems] of byTopic) {
      const digestMessage = this.formatDigest(tierLabel, topicItems);
      await this.sendDirect(topicId, digestMessage);
    }

    const count = items.length;
    this.totalFlushed += count;

    if (tier === 'SUMMARY') {
      this.lastSummaryFlush = new Date();
    } else {
      this.lastDigestFlush = new Date();
    }

    return count;
  }

  getQueueSize(): { summary: number; digest: number } {
    return {
      summary: this.summaryQueue.length,
      digest: this.digestQueue.length,
    };
  }

  getStats(): BatcherStats {
    return {
      summaryQueueSize: this.summaryQueue.length,
      digestQueueSize: this.digestQueue.length,
      totalFlushed: this.totalFlushed,
      lastSummaryFlush: this.lastSummaryFlush,
      lastDigestFlush: this.lastDigestFlush,
    };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  formatDigest(tierLabel: string, items: QueuedNotification[]): string {
    const lines: string[] = [];
    lines.push(`--- ${tierLabel} (${items.length} item${items.length === 1 ? '' : 's'}) ---`);
    lines.push('');

    // Group by category
    const byCategory = new Map<string, QueuedNotification[]>();
    for (const item of items) {
      const existing = byCategory.get(item.category) || [];
      existing.push(item);
      byCategory.set(item.category, existing);
    }

    const sortedCategories = [...byCategory.entries()].sort(
      (a, b) => a[1][0].timestamp.getTime() - b[1][0].timestamp.getTime()
    );

    for (const [category, categoryItems] of sortedCategories) {
      const header = CATEGORY_HEADERS[category] || category.toUpperCase().replace(/-/g, ' ');
      lines.push(`${header}:`);

      categoryItems.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      for (const item of categoryItems) {
        const cleanMessage = item.message.replace(/<[^>]+>/g, '').trim();
        const firstLine = cleanMessage.split('\n').find(l => l.trim().length > 0) || cleanMessage;
        const suffix = item.count > 1 ? ` (×${item.count})` : '';
        lines.push(`  - ${firstLine.slice(0, 115)}${suffix}`);
      }

      lines.push('');
    }

    return lines.join('\n').trimEnd();
  }

  isQuietHours(): boolean {
    if (!this.config.quietHours?.enabled) return false;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = this.config.quietHours.start.split(':').map(Number);
    const [endH, endM] = this.config.quietHours.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  /**
   * Generate a stable dedup key from category + message content.
   * Strips variable parts (PIDs, memory values, timestamps, durations)
   * so structurally identical notifications collapse.
   */
  private generateDedupKey(category: string, message: string): string {
    const firstLine = message.split('\n').find(l => l.trim().length > 0) || message;
    const normalized = firstLine
      .replace(/PID \d+/g, 'PID _')
      .replace(/\d+MB/g, '_MB')
      .replace(/\d+KB/g, '_KB')
      .replace(/\d+h \d+m/g, '_dur')
      .replace(/\d+m/g, '_dur')
      .replace(/\d+d \d+h/g, '_dur')
      .replace(/v[\d.]+/g, 'v_')
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/g, '_ts')
      .replace(/\d+/g, '_')
      .toLowerCase()
      .trim();
    return `${category}:${normalized}`;
  }

  private async sendDirect(topicId: number, message: string): Promise<void> {
    if (!this.sendFn) {
      return;
    }

    try {
      await this.sendFn(topicId, message);
    } catch (err) {
      // Log but don't throw — batching should never crash the caller
      console.error('[NotificationBatcher] Failed to send:', err);
    }
  }

  private async checkFlush(): Promise<void> {
    const now = new Date();

    if (this.lastSummaryFlush) {
      const elapsed = now.getTime() - this.lastSummaryFlush.getTime();
      if (elapsed >= this.config.summaryIntervalMinutes * 60_000 && this.summaryQueue.length > 0) {
        await this.flush('SUMMARY');
      }
    }

    if (this.lastDigestFlush) {
      const elapsed = now.getTime() - this.lastDigestFlush.getTime();
      if (elapsed >= this.config.digestIntervalMinutes * 60_000 && this.digestQueue.length > 0) {
        await this.flush('DIGEST');
      }
    }
  }
}
