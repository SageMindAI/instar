/**
 * MessagingAdapterConformance — verifies any adapter implementing
 * MessagingAdapter emits the required events in the correct order.
 *
 * Phase 1 conformance suite per the WhatsApp spec Round 6.
 * TelegramAdapter must pass before Phase 2 begins.
 * WhatsAppAdapter must pass the same suite.
 */

import { describe, it, expect } from 'vitest';
import type { MessagingAdapter, Message, OutgoingMessage } from '../../../src/core/types.js';

/**
 * Run conformance checks against any MessagingAdapter implementation.
 * Call this from platform-specific test files with a factory function.
 */
export function runAdapterConformanceTests(
  name: string,
  createAdapter: () => {
    adapter: MessagingAdapter;
    /** Simulate an incoming message from a user */
    simulateIncoming: (message: Message) => Promise<void>;
    /** Get messages sent by the adapter (for verifying outbound) */
    getSentMessages: () => OutgoingMessage[];
    /** Cleanup resources */
    teardown: () => Promise<void>;
  },
) {
  describe(`MessagingAdapterConformance: ${name}`, () => {
    it('has a platform identifier', async () => {
      const { adapter, teardown } = createAdapter();
      expect(adapter.platform).toBeTruthy();
      expect(typeof adapter.platform).toBe('string');
      await teardown();
    });

    it('accepts a message handler via onMessage', async () => {
      const { adapter, teardown } = createAdapter();
      const messages: Message[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });
      // Should not throw
      await teardown();
    });

    it('routes incoming messages to registered handler', async () => {
      const { adapter, simulateIncoming, teardown } = createAdapter();
      const received: Message[] = [];

      adapter.onMessage(async (msg) => { received.push(msg); });

      const testMessage: Message = {
        id: 'test-1',
        userId: 'user-1',
        content: 'hello',
        channel: { type: adapter.platform, identifier: 'channel-1' },
        receivedAt: new Date().toISOString(),
      };

      await simulateIncoming(testMessage);
      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('hello');
      expect(received[0].channel.type).toBe(adapter.platform);
      await teardown();
    });

    it('sends outbound messages via send()', async () => {
      const { adapter, getSentMessages, teardown } = createAdapter();

      const outgoing: OutgoingMessage = {
        userId: 'user-1',
        content: 'response text',
        channel: { type: adapter.platform, identifier: 'channel-1' },
      };

      await adapter.send(outgoing);
      const sent = getSentMessages();
      expect(sent).toHaveLength(1);
      expect(sent[0].content).toBe('response text');
      await teardown();
    });

    it('start() and stop() complete without error', async () => {
      const { adapter, teardown } = createAdapter();
      await adapter.start();
      await adapter.stop();
      await teardown();
    });

    it('resolveUser returns string or null', async () => {
      const { adapter, teardown } = createAdapter();
      const result = await adapter.resolveUser('unknown');
      expect(result === null || typeof result === 'string').toBe(true);
      await teardown();
    });

    it('message has required fields', async () => {
      const { adapter, simulateIncoming, teardown } = createAdapter();
      const received: Message[] = [];
      adapter.onMessage(async (msg) => { received.push(msg); });

      await simulateIncoming({
        id: 'conformance-msg',
        userId: 'user-42',
        content: 'test content',
        channel: { type: adapter.platform, identifier: 'ch-1' },
        receivedAt: new Date().toISOString(),
      });

      expect(received).toHaveLength(1);
      const msg = received[0];
      expect(msg.id).toBeTruthy();
      expect(msg.userId).toBeTruthy();
      expect(typeof msg.content).toBe('string');
      expect(msg.channel).toBeDefined();
      expect(msg.channel.type).toBeTruthy();
      expect(msg.channel.identifier).toBeTruthy();
      expect(msg.receivedAt).toBeTruthy();
      await teardown();
    });
  });
}

// ── Stub adapter for testing the conformance suite itself ──────────

class StubAdapter implements MessagingAdapter {
  readonly platform = 'stub';
  private handler: ((message: Message) => Promise<void>) | null = null;
  private sent: OutgoingMessage[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
  }

  onMessage(handler: (message: Message) => Promise<void>): void {
    this.handler = handler;
  }

  async resolveUser(_channelIdentifier: string): Promise<string | null> {
    return null;
  }

  async simulateIncoming(message: Message): Promise<void> {
    if (this.handler) await this.handler(message);
  }

  getSent(): OutgoingMessage[] {
    return this.sent;
  }
}

// Run conformance tests against the stub to verify the suite itself works
runAdapterConformanceTests('StubAdapter', () => {
  const adapter = new StubAdapter();
  return {
    adapter,
    simulateIncoming: (msg) => adapter.simulateIncoming(msg),
    getSentMessages: () => adapter.getSent(),
    teardown: async () => {},
  };
});
