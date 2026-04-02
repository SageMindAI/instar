/**
 * OutboundRateLimiter — In-memory sliding-window rate limiter for outbound messages.
 *
 * Two independent limits:
 *   1. Per-contact: max messages per hour (sliding window)
 *   2. Global: max messages per day (rolling 24h window)
 *
 * Resets on server restart (in-memory only). This is acceptable because
 * limits are a safety net, not a billing mechanism.
 */

export interface RateLimiterConfig {
  /** Max outbound messages per contact per hour (default: 20) */
  maxPerHour: number;
  /** Max outbound messages globally per day (default: 100) */
  maxPerDay: number;
}

export interface RateLimitStatus {
  /** Per-contact counts for the current hour window */
  perContact: Map<string, number>;
  /** Global count for the current day window */
  globalToday: number;
}

export class OutboundRateLimiter {
  private readonly maxPerHour: number;
  private readonly maxPerDay: number;

  // Timestamps of sent messages per contact (for sliding window)
  private contactTimestamps = new Map<string, number[]>();
  // Global timestamps
  private globalTimestamps: number[] = [];

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.maxPerHour = config.maxPerHour ?? 20;
    this.maxPerDay = config.maxPerDay ?? 100;
  }

  /**
   * Check if a send to this recipient is allowed under rate limits.
   * Does NOT record the send — call record() after successful delivery.
   */
  check(recipient: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const hourAgo = now - 3_600_000;
    const dayAgo = now - 86_400_000;

    // Per-contact hourly check
    const contactTs = this.contactTimestamps.get(recipient) || [];
    const recentContact = contactTs.filter(t => t > hourAgo);
    if (recentContact.length >= this.maxPerHour) {
      return {
        allowed: false,
        reason: `per-contact hourly limit reached (${this.maxPerHour}/hr)`,
      };
    }

    // Global daily check
    const recentGlobal = this.globalTimestamps.filter(t => t > dayAgo);
    if (recentGlobal.length >= this.maxPerDay) {
      return {
        allowed: false,
        reason: `global daily limit reached (${this.maxPerDay}/day)`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a sent message for rate tracking.
   */
  record(recipient: string): void {
    const now = Date.now();

    // Contact timestamps
    if (!this.contactTimestamps.has(recipient)) {
      this.contactTimestamps.set(recipient, []);
    }
    this.contactTimestamps.get(recipient)!.push(now);

    // Global timestamps
    this.globalTimestamps.push(now);

    // Periodic cleanup — evict old entries to prevent memory growth
    this._cleanup();
  }

  /**
   * Get current rate limit status.
   */
  status(): RateLimitStatus {
    const now = Date.now();
    const hourAgo = now - 3_600_000;
    const dayAgo = now - 86_400_000;

    const perContact = new Map<string, number>();
    for (const [contact, timestamps] of this.contactTimestamps) {
      const count = timestamps.filter(t => t > hourAgo).length;
      if (count > 0) perContact.set(contact, count);
    }

    return {
      perContact,
      globalToday: this.globalTimestamps.filter(t => t > dayAgo).length,
    };
  }

  /**
   * Get counts for a specific contact (for audit log inclusion).
   */
  countsFor(recipient: string): { contactHour: number; globalDay: number } {
    const now = Date.now();
    const hourAgo = now - 3_600_000;
    const dayAgo = now - 86_400_000;

    const contactTs = this.contactTimestamps.get(recipient) || [];
    return {
      contactHour: contactTs.filter(t => t > hourAgo).length,
      globalDay: this.globalTimestamps.filter(t => t > dayAgo).length,
    };
  }

  private _cleanup(): void {
    const dayAgo = Date.now() - 86_400_000;

    // Clean global
    this.globalTimestamps = this.globalTimestamps.filter(t => t > dayAgo);

    // Clean per-contact
    for (const [contact, timestamps] of this.contactTimestamps) {
      const filtered = timestamps.filter(t => t > dayAgo);
      if (filtered.length === 0) {
        this.contactTimestamps.delete(contact);
      } else {
        this.contactTimestamps.set(contact, filtered);
      }
    }
  }
}
