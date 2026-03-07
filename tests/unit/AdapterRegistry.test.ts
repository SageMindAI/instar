import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerAdapter,
  createAdapter,
  hasAdapter,
  getRegisteredAdapters,
  unregisterAdapter,
  clearRegistry,
} from '../../src/messaging/AdapterRegistry.js';
import type { MessagingAdapter, Message, OutgoingMessage } from '../../src/core/types.js';

// Minimal mock adapter for testing
class MockAdapter implements MessagingAdapter {
  readonly platform: string;
  started = false;
  stopped = false;
  private handler: ((msg: Message) => Promise<void>) | null = null;

  constructor(config: Record<string, unknown>, _stateDir: string) {
    this.platform = (config.platform as string) ?? 'mock';
  }

  async start() { this.started = true; }
  async stop() { this.stopped = true; }
  async send(_msg: OutgoingMessage) {}
  onMessage(handler: (msg: Message) => Promise<void>) { this.handler = handler; }
  async resolveUser(_id: string) { return null; }
}

class AnotherAdapter implements MessagingAdapter {
  readonly platform = 'another';
  async start() {}
  async stop() {}
  async send(_msg: OutgoingMessage) {}
  onMessage(_handler: (msg: Message) => Promise<void>) {}
  async resolveUser(_id: string) { return null; }
}

describe('AdapterRegistry', () => {
  beforeEach(() => {
    clearRegistry();
  });

  describe('registerAdapter / createAdapter', () => {
    it('registers and creates an adapter', () => {
      registerAdapter('mock', MockAdapter);
      const adapter = createAdapter(
        { type: 'mock', enabled: true, config: { platform: 'test-mock' } },
        '/tmp/state',
      );
      expect(adapter.platform).toBe('test-mock');
    });

    it('creates adapter with correct config', async () => {
      registerAdapter('mock', MockAdapter);
      const adapter = createAdapter(
        { type: 'mock', enabled: true, config: { platform: 'custom' } },
        '/tmp/state',
      ) as MockAdapter;

      await adapter.start();
      expect(adapter.started).toBe(true);
    });

    it('throws for unregistered adapter type', () => {
      expect(() =>
        createAdapter({ type: 'unknown', enabled: true, config: {} }, '/tmp'),
      ).toThrow('Unknown messaging adapter: "unknown"');
    });

    it('includes available adapters in error message', () => {
      registerAdapter('telegram', MockAdapter);
      registerAdapter('whatsapp', AnotherAdapter);

      try {
        createAdapter({ type: 'slack', enabled: true, config: {} }, '/tmp');
      } catch (err: any) {
        expect(err.message).toContain('telegram');
        expect(err.message).toContain('whatsapp');
      }
    });
  });

  describe('hasAdapter', () => {
    it('returns true for registered adapters', () => {
      registerAdapter('mock', MockAdapter);
      expect(hasAdapter('mock')).toBe(true);
    });

    it('returns false for unregistered adapters', () => {
      expect(hasAdapter('nonexistent')).toBe(false);
    });
  });

  describe('getRegisteredAdapters', () => {
    it('returns empty array when none registered', () => {
      expect(getRegisteredAdapters()).toEqual([]);
    });

    it('returns all registered adapter names', () => {
      registerAdapter('telegram', MockAdapter);
      registerAdapter('whatsapp', AnotherAdapter);

      const names = getRegisteredAdapters();
      expect(names).toContain('telegram');
      expect(names).toContain('whatsapp');
      expect(names).toHaveLength(2);
    });
  });

  describe('unregisterAdapter', () => {
    it('removes a registered adapter', () => {
      registerAdapter('mock', MockAdapter);
      expect(hasAdapter('mock')).toBe(true);

      unregisterAdapter('mock');
      expect(hasAdapter('mock')).toBe(false);
    });

    it('returns false for non-existent adapter', () => {
      expect(unregisterAdapter('nonexistent')).toBe(false);
    });
  });

  describe('clearRegistry', () => {
    it('removes all registrations', () => {
      registerAdapter('a', MockAdapter);
      registerAdapter('b', AnotherAdapter);
      expect(getRegisteredAdapters()).toHaveLength(2);

      clearRegistry();
      expect(getRegisteredAdapters()).toHaveLength(0);
    });
  });
});
