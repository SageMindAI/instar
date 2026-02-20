import { describe, it, expect } from 'vitest';
import { formatUptime } from '../../src/server/routes.js';

/**
 * Tests for the formatUptime helper — now exported and tested directly.
 */
describe('formatUptime', () => {
  it('formats seconds only', () => {
    expect(formatUptime(5000)).toBe('5s');
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(59_999)).toBe('59s');
  });

  it('formats minutes and seconds', () => {
    expect(formatUptime(60_000)).toBe('1m 0s');
    expect(formatUptime(90_000)).toBe('1m 30s');
    expect(formatUptime(3_599_999)).toBe('59m 59s');
  });

  it('formats hours and minutes', () => {
    expect(formatUptime(3_600_000)).toBe('1h 0m');
    expect(formatUptime(7_200_000)).toBe('2h 0m');
    expect(formatUptime(5_400_000)).toBe('1h 30m');
  });

  it('formats days and hours', () => {
    expect(formatUptime(86_400_000)).toBe('1d 0h');
    expect(formatUptime(90_000_000)).toBe('1d 1h');
    expect(formatUptime(172_800_000)).toBe('2d 0h');
    expect(formatUptime(180_000_000)).toBe('2d 2h');
  });

  it('prioritizes largest unit (days > hours > minutes > seconds)', () => {
    // 1 day, 2 hours, 3 minutes, 4 seconds → should show "1d 2h"
    const ms = 86_400_000 + 7_200_000 + 180_000 + 4000;
    expect(formatUptime(ms)).toBe('1d 2h');
  });
});
