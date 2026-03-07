import { describe, it, expect, vi } from 'vitest';
import { MessagingEventBus } from '../../../src/messaging/shared/MessagingEventBus.js';

describe('MessagingEventBus', () => {
  function createBus(platform = 'telegram') {
    return new MessagingEventBus(platform);
  }

  // ── Basic subscription ──────────────────────────────────────

  describe('on / emit', () => {
    it('delivers events to registered listeners', async () => {
      const bus = createBus();
      const received: string[] = [];

      bus.on('message:incoming', (event) => {
        received.push(event.text);
      });

      await bus.emit('message:incoming', {
        channelId: '100',
        userId: 'user-1',
        text: 'hello',
        timestamp: new Date().toISOString(),
      });

      expect(received).toEqual(['hello']);
    });

    it('supports multiple listeners on the same event', async () => {
      const bus = createBus();
      const order: number[] = [];

      bus.on('message:incoming', () => { order.push(1); });
      bus.on('message:incoming', () => { order.push(2); });
      bus.on('message:incoming', () => { order.push(3); });

      await bus.emit('message:incoming', {
        channelId: '100', userId: 'u', text: 'hi', timestamp: '',
      });

      expect(order).toEqual([1, 2, 3]);
    });

    it('supports async listeners', async () => {
      const bus = createBus();
      const results: string[] = [];

      bus.on('message:logged', async (event) => {
        await Promise.resolve();
        results.push(event.text);
      });

      await bus.emit('message:logged', {
        messageId: 1, channelId: '100', text: 'async test',
        fromUser: true, timestamp: '', sessionName: null,
      });

      expect(results).toEqual(['async test']);
    });

    it('does nothing when emitting with no listeners', async () => {
      const bus = createBus();
      // Should not throw
      await bus.emit('message:incoming', {
        channelId: '100', userId: 'u', text: 'hi', timestamp: '',
      });
    });

    it('isolates listener errors — one failing does not block others', async () => {
      const bus = createBus();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const results: number[] = [];

      bus.on('stall:detected', () => { results.push(1); });
      bus.on('stall:detected', () => { throw new Error('listener boom'); });
      bus.on('stall:detected', () => { results.push(3); });

      await bus.emit('stall:detected', {
        channelId: '100', sessionName: 's', messageText: 'msg',
        injectedAt: Date.now(), minutesElapsed: 5, alive: true,
      });

      expect(results).toEqual([1, 3]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Listener error on "stall:detected"'),
      );

      consoleSpy.mockRestore();
    });
  });

  // ── once ──────────────────────────────────────────────────

  describe('once', () => {
    it('fires listener only once then removes it', async () => {
      const bus = createBus();
      let count = 0;

      bus.once('request:flush', () => { count++; });

      await bus.emit('request:flush', { channelId: '100' });
      await bus.emit('request:flush', { channelId: '200' });

      expect(count).toBe(1);
    });

    it('once listener alongside regular listeners', async () => {
      const bus = createBus();
      const results: string[] = [];

      bus.on('request:flush', () => { results.push('always'); });
      bus.once('request:flush', () => { results.push('once'); });

      await bus.emit('request:flush', { channelId: '100' });
      await bus.emit('request:flush', { channelId: '200' });

      expect(results).toEqual(['always', 'once', 'always']);
    });
  });

  // ── Unsubscribe ──────────────────────────────────────────

  describe('unsubscribe', () => {
    it('on() returns an unsubscribe function', async () => {
      const bus = createBus();
      let count = 0;

      const unsub = bus.on('request:quota', () => { count++; });

      await bus.emit('request:quota', { channelId: '100' });
      expect(count).toBe(1);

      unsub();

      await bus.emit('request:quota', { channelId: '200' });
      expect(count).toBe(1); // Not called after unsubscribe
    });

    it('once() returns an unsubscribe function', async () => {
      const bus = createBus();
      let called = false;

      const unsub = bus.once('request:flush', () => { called = true; });
      unsub();

      await bus.emit('request:flush', { channelId: '100' });
      expect(called).toBe(false);
    });

    it('unsubscribing one listener does not affect others', async () => {
      const bus = createBus();
      const results: number[] = [];

      const unsub1 = bus.on('request:flush', () => { results.push(1); });
      bus.on('request:flush', () => { results.push(2); });

      unsub1();
      await bus.emit('request:flush', { channelId: '100' });

      expect(results).toEqual([2]);
    });
  });

  // ── off (bulk remove) ──────────────────────────────────────

  describe('off', () => {
    it('removes all listeners for a specific event', async () => {
      const bus = createBus();
      let flushed = 0;
      let quota = 0;

      bus.on('request:flush', () => { flushed++; });
      bus.on('request:quota', () => { quota++; });

      bus.off('request:flush');

      await bus.emit('request:flush', { channelId: '100' });
      await bus.emit('request:quota', { channelId: '100' });

      expect(flushed).toBe(0);
      expect(quota).toBe(1);
    });

    it('removes all listeners when called without arguments', async () => {
      const bus = createBus();
      let count = 0;

      bus.on('request:flush', () => { count++; });
      bus.on('request:quota', () => { count++; });
      bus.on('stall:detected', () => { count++; });

      bus.off();

      await bus.emit('request:flush', { channelId: '100' });
      await bus.emit('request:quota', { channelId: '100' });

      expect(count).toBe(0);
    });
  });

  // ── listenerCount ──────────────────────────────────────────

  describe('listenerCount', () => {
    it('returns 0 for events with no listeners', () => {
      const bus = createBus();
      expect(bus.listenerCount('message:incoming')).toBe(0);
    });

    it('tracks listener count accurately', () => {
      const bus = createBus();
      bus.on('message:incoming', () => {});
      bus.on('message:incoming', () => {});
      bus.once('message:incoming', () => {});

      expect(bus.listenerCount('message:incoming')).toBe(3);
    });

    it('decrements after unsubscribe', () => {
      const bus = createBus();
      const unsub = bus.on('request:flush', () => {});
      bus.on('request:flush', () => {});

      expect(bus.listenerCount('request:flush')).toBe(2);

      unsub();
      expect(bus.listenerCount('request:flush')).toBe(1);
    });

    it('decrements after once listener fires', async () => {
      const bus = createBus();
      bus.once('request:flush', () => {});

      expect(bus.listenerCount('request:flush')).toBe(1);

      await bus.emit('request:flush', { channelId: '100' });
      expect(bus.listenerCount('request:flush')).toBe(0);
    });
  });

  // ── eventNames ──────────────────────────────────────────

  describe('eventNames', () => {
    it('returns empty array with no listeners', () => {
      const bus = createBus();
      expect(bus.eventNames()).toEqual([]);
    });

    it('returns names of events with active listeners', () => {
      const bus = createBus();
      bus.on('message:incoming', () => {});
      bus.on('stall:detected', () => {});

      const names = bus.eventNames();
      expect(names).toContain('message:incoming');
      expect(names).toContain('stall:detected');
      expect(names).toHaveLength(2);
    });
  });

  // ── getPlatform ──────────────────────────────────────────

  describe('getPlatform', () => {
    it('returns the platform name', () => {
      expect(createBus('telegram').getPlatform()).toBe('telegram');
      expect(createBus('whatsapp').getPlatform()).toBe('whatsapp');
    });
  });

  // ── Typed event payloads ──────────────────────────────────

  describe('typed event payloads', () => {
    it('correctly types stall:detected events', async () => {
      const bus = createBus();
      let received: { alive: boolean; minutesElapsed: number } | null = null;

      bus.on('stall:detected', (event) => {
        received = { alive: event.alive, minutesElapsed: event.minutesElapsed };
      });

      await bus.emit('stall:detected', {
        channelId: '100', sessionName: 'sess-1', messageText: 'hello',
        injectedAt: Date.now(), minutesElapsed: 5, alive: false,
      });

      expect(received).toEqual({ alive: false, minutesElapsed: 5 });
    });

    it('correctly types session:interrupt events', async () => {
      const bus = createBus();
      let received: { sessionName: string; channelId: string } | null = null;

      bus.on('session:interrupt', (event) => {
        received = { sessionName: event.sessionName, channelId: event.channelId };
      });

      await bus.emit('session:interrupt', {
        sessionName: 'my-session', channelId: '42',
      });

      expect(received).toEqual({ sessionName: 'my-session', channelId: '42' });
    });

    it('correctly types auth:unauthorized events', async () => {
      const bus = createBus();
      let received: { userId: string; displayName: string } | null = null;

      bus.on('auth:unauthorized', (event) => {
        received = { userId: event.userId, displayName: event.displayName };
      });

      await bus.emit('auth:unauthorized', {
        userId: '999', displayName: 'Stranger', channelId: '100',
      });

      expect(received).toEqual({ userId: '999', displayName: 'Stranger' });
    });

    it('correctly types command:executed events', async () => {
      const bus = createBus();
      let received: { command: string; handled: boolean } | null = null;

      bus.on('command:executed', (event) => {
        received = { command: event.command, handled: event.handled };
      });

      await bus.emit('command:executed', {
        command: 'status', args: '', channelId: '100', userId: 'u1', handled: true,
      });

      expect(received).toEqual({ command: 'status', handled: true });
    });
  });

  // ── Concurrent emit ──────────────────────────────────────

  describe('concurrent operations', () => {
    it('handles concurrent emits correctly', async () => {
      const bus = createBus();
      let count = 0;

      bus.on('request:flush', async () => {
        await Promise.resolve();
        count++;
      });

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          bus.emit('request:flush', { channelId: `ch-${i}` })
        ),
      );

      expect(count).toBe(20);
    });

    it('handles subscribe/unsubscribe during emit', async () => {
      const bus = createBus();
      const results: number[] = [];

      bus.on('request:flush', () => {
        results.push(1);
        // Subscribe a new listener during emit — should not affect current emit
        bus.on('request:flush', () => { results.push(99); });
      });
      bus.on('request:flush', () => { results.push(2); });

      await bus.emit('request:flush', { channelId: '100' });

      // First emit: 1 and 2 (the 99 listener was added during iteration of a snapshot)
      expect(results).toEqual([1, 2]);
    });
  });

  // ── Edge cases ──────────────────────────────────────────

  describe('edge cases', () => {
    it('double unsubscribe is safe', () => {
      const bus = createBus();
      const unsub = bus.on('request:flush', () => {});
      unsub();
      unsub(); // Should not throw
    });

    it('off on non-existent event is safe', () => {
      const bus = createBus();
      bus.off('message:incoming'); // No listeners registered — should not throw
    });

    it('emitting after off is safe', async () => {
      const bus = createBus();
      bus.on('request:flush', () => {});
      bus.off('request:flush');
      await bus.emit('request:flush', { channelId: '100' }); // Should not throw
    });
  });
});
