import { describe, it, expect } from 'vitest';
import { getReconnectDelay } from '../../src/messaging/backends/BaileysBackend.js';

describe('BaileysBackend', () => {
  describe('getReconnectDelay', () => {
    it('returns increasing delays for each attempt', () => {
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        // Run multiple times to account for jitter, take minimum
        const samples = Array.from({ length: 100 }, () => getReconnectDelay(i));
        delays.push(Math.min(...samples));
      }

      // Each minimum should be approximately the base delay (jitter adds, doesn't subtract)
      expect(delays[0]).toBeGreaterThanOrEqual(2000);
      expect(delays[1]).toBeGreaterThanOrEqual(5000);
      expect(delays[2]).toBeGreaterThanOrEqual(10000);
      expect(delays[3]).toBeGreaterThanOrEqual(30000);
      expect(delays[4]).toBeGreaterThanOrEqual(60000);
    });

    it('caps at the maximum delay for high attempt numbers', () => {
      const delay = getReconnectDelay(100);
      // Should use the last base delay (60000) + up to 30% jitter
      expect(delay).toBeGreaterThanOrEqual(60000);
      expect(delay).toBeLessThanOrEqual(78000); // 60000 + 30% jitter
    });

    it('adds jitter (delays are not identical)', () => {
      const delays = new Set<number>();
      for (let i = 0; i < 20; i++) {
        delays.add(getReconnectDelay(0));
      }
      // With 30% jitter on a 2000ms base, we should get various values
      expect(delays.size).toBeGreaterThan(1);
    });

    it('returns integer values', () => {
      for (let i = 0; i < 10; i++) {
        const delay = getReconnectDelay(i);
        expect(Number.isInteger(delay)).toBe(true);
      }
    });
  });
});
