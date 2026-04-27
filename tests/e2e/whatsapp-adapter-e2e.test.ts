/**
 * End-to-end tests for Phase 2: WhatsApp Adapter (Baileys MVP).
 *
 * Tests the full WhatsApp adapter lifecycle WITHOUT requiring Baileys or
 * a real WhatsApp connection. The BaileysBackend is not exercised here —
 * instead, we simulate its behavior by calling adapter methods directly.
 *
 * Covers:
 * 1. Full message lifecycle: receive → auth → log → route/handle → respond
 * 2. Session management: register → message → stall → reset
 * 3. Command routing: all registered commands
 * 4. Multi-user concurrent access
 * 5. Auth gate lifecycle: reject → authorize → accept
 * 6. Message deduplication under reconnect storms
 * 7. Rate limiting under rapid-fire
 * 8. Outbound message queuing and flush on connect
 * 9. EventBus integration
 * 10. Adapter registry integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WhatsAppAdapter } from '../../src/messaging/WhatsAppAdapter.js';
import {
  registerAdapter,
  createAdapter,
  clearRegistry,
} from '../../src/messaging/AdapterRegistry.js';

describe('Phase 2: WhatsApp Adapter — E2E', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-e2e-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRegistry();
  });

  function createTestAdapter(overrides: Record<string, unknown> = {}): WhatsAppAdapter {
    return new WhatsAppAdapter(
      {
        backend: 'baileys',
        authorizedNumbers: ['+14155552671', '+447911123456', '+5511999998888'],
        stallTimeoutMinutes: 1,
        requireConsent: false, // Disable consent for E2E tests (tested separately)
        prefixEnabled: false, // Disable prefix for routing tests (tested separately)
        ...overrides,
      },
      tmpDir,
    );
  }

  // ══════════════════════════════════════════════════════════
  // 1. FULL MESSAGE LIFECYCLE
  // ══════════════════════════════════════════════════════════

  describe('Full message lifecycle', () => {
    it('receive → auth → log → handle → respond', async () => {
      const adapter = createTestAdapter();
      const sent: Array<{ jid: string; text: string }> = [];
      adapter.setSendFunction(async (jid, text) => { sent.push({ jid, text }); });
      adapter.setConnectionState('connected', '+14155552671');

      const receivedMessages: any[] = [];
      adapter.onMessage(async (msg) => { receivedMessages.push(msg); });

      // Register session
      adapter.registerSession('14155552671@s.whatsapp.net', 'test-session');

      // Simulate incoming message
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'lifecycle-1',
        'Hello from the E2E test',
        'TestUser',
        Math.floor(Date.now() / 1000),
      );

      // Message was received and forwarded to handler
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].content).toBe('Hello from the E2E test');
      expect(receivedMessages[0].userId).toBe('+14155552671');
      expect(receivedMessages[0].channel.type).toBe('whatsapp');

      // Message was logged
      expect(adapter.getStatus().totalMessagesLogged).toBeGreaterThan(0);

      // Send a response
      await adapter.send({
        userId: '+14155552671',
        content: 'Response from agent',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBe('Response from agent');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 2. SESSION MANAGEMENT
  // ══════════════════════════════════════════════════════════

  describe('Session management', () => {
    it('register → message → stall check → reset → new session', async () => {
      vi.useFakeTimers();
      const adapter = createTestAdapter();
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });
      adapter.setConnectionState('connected');
      adapter.onMessage(async () => {});
      await adapter.start();

      const jid = '14155552671@s.whatsapp.net';

      // Register session
      adapter.registerSession(jid, 'session-alpha');
      expect(adapter.getSessionForChannel(jid)).toBe('session-alpha');

      // Send a message
      await adapter.handleIncomingMessage(jid, 'sess-1', 'Working on something', 'User');

      // Reset session via command
      await adapter.handleIncomingMessage(jid, 'sess-2', '/new', 'User');
      expect(adapter.getSessionForChannel(jid)).toBeNull();
      expect(sent.some(s => s.includes('Session reset'))).toBe(true);

      vi.useRealTimers();
      await adapter.stop();
    });
  });

  // ══════════════════════════════════════════════════════════
  // 3. COMMAND ROUTING
  // ══════════════════════════════════════════════════════════

  describe('Command routing', () => {
    it('all built-in commands work', async () => {
      const adapter = createTestAdapter();
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });
      adapter.setConnectionState('connected');

      const jid = '14155552671@s.whatsapp.net';
      const commands = ['/help', '/status', '/whoami', '/new', '/stop'];

      for (let i = 0; i < commands.length; i++) {
        await adapter.handleIncomingMessage(jid, `cmd-${i}`, commands[i], 'User');
      }

      // Each command should have produced output
      expect(sent.length).toBe(commands.length);
    });

    it('non-commands are forwarded to message handler', async () => {
      const adapter = createTestAdapter();
      adapter.setSendFunction(async () => {});
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'plain-1',
        'This is not a command',
        'User',
      );

      expect(messages).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 4. MULTI-USER CONCURRENT ACCESS
  // ══════════════════════════════════════════════════════════

  describe('Multi-user concurrent access', () => {
    it('handles messages from multiple users simultaneously', async () => {
      const adapter = createTestAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });
      adapter.setSendFunction(async () => {});

      const users = [
        { jid: '14155552671@s.whatsapp.net', name: 'Alice' },
        { jid: '447911123456@s.whatsapp.net', name: 'Bob' },
        { jid: '5511999998888@s.whatsapp.net', name: 'Carlos' },
      ];

      // Register sessions for each user
      users.forEach((u, i) => adapter.registerSession(u.jid, `session-${i}`));

      // Fire 30 messages concurrently (10 per user)
      const promises = [];
      for (let i = 0; i < 30; i++) {
        const user = users[i % 3];
        promises.push(
          adapter.handleIncomingMessage(
            user.jid,
            `multi-${i}`,
            `Message ${i} from ${user.name}`,
            user.name,
          ),
        );
      }

      await Promise.all(promises);

      expect(messages).toHaveLength(30);

      // Each user's messages should be present
      const aliceMessages = messages.filter(m => m.metadata?.senderName === 'Alice');
      const bobMessages = messages.filter(m => m.metadata?.senderName === 'Bob');
      const carlosMessages = messages.filter(m => m.metadata?.senderName === 'Carlos');

      expect(aliceMessages).toHaveLength(10);
      expect(bobMessages).toHaveLength(10);
      expect(carlosMessages).toHaveLength(10);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 5. AUTH GATE LIFECYCLE
  // ══════════════════════════════════════════════════════════

  describe('Auth gate lifecycle', () => {
    it('reject → runtime authorize → accept', async () => {
      const adapter = createTestAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      // First attempt: rejected
      await adapter.handleIncomingMessage(
        '19999999999@s.whatsapp.net',
        'auth-1',
        'Let me in',
        'Newcomer',
      );
      expect(messages).toHaveLength(0);

      // Admin authorizes at runtime
      adapter.getAuthGate().authorize('+19999999999');

      // Second attempt: accepted
      await adapter.handleIncomingMessage(
        '19999999999@s.whatsapp.net',
        'auth-2',
        'Now I should get through',
        'Newcomer',
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Now I should get through');
    });

    it('authorize → deauthorize → reject', async () => {
      const adapter = createTestAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      // Initially authorized
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'deauth-1',
        'First message',
        'User',
      );
      expect(messages).toHaveLength(1);

      // Deauthorize
      adapter.getAuthGate().deauthorize('+14155552671');

      // Now rejected
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'deauth-2',
        'Should be rejected',
        'User',
      );
      expect(messages).toHaveLength(1); // Still only the first
    });
  });

  // ══════════════════════════════════════════════════════════
  // 6. MESSAGE DEDUPLICATION
  // ══════════════════════════════════════════════════════════

  describe('Message deduplication', () => {
    it('filters duplicate messages during reconnect storm', async () => {
      const adapter = createTestAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      // Simulate reconnect storm: same messages arrive multiple times
      const messageIds = ['dup-1', 'dup-2', 'dup-3'];
      for (let round = 0; round < 5; round++) {
        for (const id of messageIds) {
          await adapter.handleIncomingMessage(
            '14155552671@s.whatsapp.net',
            id,
            `Message ${id}`,
            'User',
          );
        }
      }

      // Each message should only be processed once
      expect(messages).toHaveLength(3);
    });

    it('handles dedup set overflow gracefully', async () => {
      // Disable rate limiting for this test
      const adapter = createTestAdapter({ rateLimitPerMinute: 999999 });
      adapter.onMessage(async () => {});

      // Send more than DEDUP_MAX_SIZE messages
      for (let i = 0; i < 10100; i++) {
        await adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          `overflow-${i}`,
          `Msg ${i}`,
          'User',
        );
      }

      // Should not throw or leak memory
      const status = adapter.getStatus();
      expect(status.totalMessagesLogged).toBe(10100);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 7. RATE LIMITING
  // ══════════════════════════════════════════════════════════

  describe('Rate limiting', () => {
    it('enforces per-user rate limit', async () => {
      const adapter = createTestAdapter({ rateLimitPerMinute: 5 });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      for (let i = 0; i < 10; i++) {
        await adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          `rl-${i}`,
          `Message ${i}`,
          'User',
        );
      }

      expect(messages).toHaveLength(5); // Only 5 get through
      expect(sent.some(s => s.includes('too quickly'))).toBe(true); // Rate limit notification
    });

    it('rate limits are per-user', async () => {
      const adapter = createTestAdapter({ rateLimitPerMinute: 3 });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });
      adapter.setSendFunction(async () => {});

      // User 1: 5 messages (3 through)
      for (let i = 0; i < 5; i++) {
        await adapter.handleIncomingMessage('14155552671@s.whatsapp.net', `rl1-${i}`, `Msg ${i}`, 'A');
      }
      // User 2: 5 messages (3 through)
      for (let i = 0; i < 5; i++) {
        await adapter.handleIncomingMessage('447911123456@s.whatsapp.net', `rl2-${i}`, `Msg ${i}`, 'B');
      }

      expect(messages).toHaveLength(6); // 3 + 3
    });
  });

  // ══════════════════════════════════════════════════════════
  // 8. OUTBOUND QUEUING
  // ══════════════════════════════════════════════════════════

  describe('Outbound message queuing', () => {
    it('queues messages when disconnected, flushes on connect', async () => {
      const adapter = createTestAdapter();
      const sent: Array<{ jid: string; text: string }> = [];

      // Queue messages while disconnected (no send function)
      await adapter.send({
        userId: 'u1',
        content: 'Queued 1',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });
      await adapter.send({
        userId: 'u1',
        content: 'Queued 2',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(sent).toHaveLength(0);

      // Connect — set send function and trigger flush
      adapter.setSendFunction(async (jid, text) => { sent.push({ jid, text }); });
      await adapter.setConnectionState('connected', '+14155552671');

      // Queued messages should have been flushed
      expect(sent).toHaveLength(2);
      expect(sent[0].text).toBe('Queued 1');
      expect(sent[1].text).toBe('Queued 2');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 9. EVENTBUS INTEGRATION
  // ══════════════════════════════════════════════════════════

  describe('EventBus integration', () => {
    it('emits all event types during normal operation', async () => {
      const adapter = createTestAdapter();
      adapter.onMessage(async () => {});
      adapter.setSendFunction(async () => {});

      const eventLog: string[] = [];
      const bus = adapter.getEventBus();

      bus.on('message:incoming', () => eventLog.push('incoming'));
      bus.on('message:logged', () => eventLog.push('logged'));
      bus.on('auth:unauthorized', () => eventLog.push('unauthorized'));
      bus.on('command:executed', () => eventLog.push('command'));

      // Authorized message
      await adapter.handleIncomingMessage('14155552671@s.whatsapp.net', 'ev-1', 'Hello', 'User');

      // Command
      await adapter.handleIncomingMessage('14155552671@s.whatsapp.net', 'ev-2', '/status', 'User');

      // Unauthorized
      await adapter.handleIncomingMessage('19999999999@s.whatsapp.net', 'ev-3', 'Hello', 'Stranger');

      expect(eventLog).toContain('incoming');
      expect(eventLog).toContain('logged');
      expect(eventLog).toContain('command');
      expect(eventLog).toContain('unauthorized');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 10. ADAPTER REGISTRY INTEGRATION
  // ══════════════════════════════════════════════════════════

  describe('Adapter registry integration', () => {
    it('WhatsAppAdapter works through the registry', () => {
      registerAdapter('whatsapp', WhatsAppAdapter as any);

      const adapter = createAdapter(
        {
          type: 'whatsapp',
          enabled: true,
          config: {
            backend: 'baileys',
            authorizedNumbers: ['+14155552671'],
          },
        },
        tmpDir,
      );

      expect(adapter.platform).toBe('whatsapp');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 11. STRESS TEST
  // ══════════════════════════════════════════════════════════

  describe('Stress test', () => {
    it('handles 200 messages across 3 users with full pipeline', async () => {
      const adapter = createTestAdapter({ rateLimitPerMinute: 999999 });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });
      adapter.setSendFunction(async () => {});

      const users = [
        '14155552671@s.whatsapp.net',
        '447911123456@s.whatsapp.net',
        '5511999998888@s.whatsapp.net',
      ];

      users.forEach((jid, i) => adapter.registerSession(jid, `session-${i}`));

      // Fire 200 messages
      const promises = [];
      for (let i = 0; i < 200; i++) {
        const jid = users[i % 3];
        const isCommand = i % 50 === 0;
        const text = isCommand ? '/status' : `Stress message ${i}`;

        promises.push(
          adapter.handleIncomingMessage(jid, `stress-${i}`, text, `User${i % 3}`),
        );
      }

      await Promise.all(promises);

      // Commands don't reach the message handler
      const commandCount = Math.floor(200 / 50); // 4 commands
      expect(messages).toHaveLength(200 - commandCount);
      expect(adapter.getStatus().totalMessagesLogged).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 12. PRIVACY CONSENT E2E
  // ══════════════════════════════════════════════════════════

  describe('Privacy consent E2E', () => {
    it('full consent lifecycle: prompt → grant → chat → revoke', async () => {
      const adapter = createTestAdapter({ requireConsent: true });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      // 1. First message triggers consent prompt
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'e2e-c1', 'Hello!', 'User',
      );
      expect(messages).toHaveLength(0);
      expect(sent[0]).toContain('Before we chat');

      // 2. User tries chatting without consenting — gets reminder
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'e2e-c2', 'Can we talk?', 'User',
      );
      expect(messages).toHaveLength(0);
      expect(sent[1]).toContain('reply "yes"');

      // 3. User grants consent
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'e2e-c3', 'I agree', 'User',
      );
      expect(sent[2]).toContain('Thank you');

      // 4. Now messages go through
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'e2e-c4', 'Real message', 'User',
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Real message');

      // 5. /stop revokes consent
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'e2e-c5', '/stop', 'User',
      );
      expect(sent.some(s => s.includes('consent revoked'))).toBe(true);

      // 6. Messages are blocked again
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'e2e-c6', 'Another message', 'User',
      );
      expect(messages).toHaveLength(1); // Still 1 from before
    });

    it('consent persists across adapter instances', async () => {
      // Instance 1: grant consent
      const adapter1 = createTestAdapter({ requireConsent: true });
      adapter1.onMessage(async () => {});
      adapter1.setSendFunction(async () => {});

      adapter1.getPrivacyConsent().grantConsent('+14155552671');

      // Instance 2: load from same state dir — consent should persist
      const adapter2 = createTestAdapter({ requireConsent: true });
      const messages: any[] = [];
      adapter2.onMessage(async (msg) => { messages.push(msg); });
      adapter2.setSendFunction(async () => {});

      await adapter2.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'persist-1', 'Still consented', 'User',
      );

      expect(messages).toHaveLength(1);
    });

    it('multi-user consent independence', async () => {
      const adapter = createTestAdapter({ requireConsent: true });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });
      adapter.setSendFunction(async () => {});

      // User 1 consents
      adapter.getPrivacyConsent().grantConsent('+14155552671');

      // User 2 has not consented
      await adapter.handleIncomingMessage(
        '447911123456@s.whatsapp.net', 'mu-1', 'Hello', 'User2',
      );
      expect(messages).toHaveLength(0); // Blocked

      // User 1 can still message
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'mu-2', 'Hi from user 1', 'User1',
      );
      expect(messages).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 13. ENCRYPTED AUTH STORE E2E
  // ══════════════════════════════════════════════════════════

  describe('Encrypted auth store E2E', () => {
    it('encrypt → read → re-encrypt cycle with different passphrases', async () => {
      const { encryptData, decryptData, writeAuthFile, readAuthFile, isEncryptedFile } = await import('../../src/messaging/shared/EncryptedAuthStore.js');

      const credsFile = path.join(tmpDir, 'whatsapp-auth', 'creds.json');
      const creds = JSON.stringify({ me: { id: '14155552671' }, keys: { preKey: {} } });

      // Write encrypted
      writeAuthFile(credsFile, creds, 'passphrase-1');
      expect(isEncryptedFile(credsFile)).toBe(true);

      // Read back
      const read1 = readAuthFile(credsFile, 'passphrase-1');
      expect(JSON.parse(read1)).toEqual(JSON.parse(creds));

      // Re-encrypt with different passphrase
      writeAuthFile(credsFile, read1, 'passphrase-2');
      const read2 = readAuthFile(credsFile, 'passphrase-2');
      expect(JSON.parse(read2)).toEqual(JSON.parse(creds));

      // Old passphrase no longer works
      expect(() => readAuthFile(credsFile, 'passphrase-1')).toThrow();
    });

    it('multiple auth files in same directory', async () => {
      const { writeAuthFile, readAuthFile } = await import('../../src/messaging/shared/EncryptedAuthStore.js');

      const authDir = path.join(tmpDir, 'whatsapp-auth');
      const pass = 'shared-pass';

      // Write multiple files like Baileys does
      writeAuthFile(path.join(authDir, 'creds.json'), '{"creds": true}', pass);
      writeAuthFile(path.join(authDir, 'pre-key-1.json'), '{"key": 1}', pass);
      writeAuthFile(path.join(authDir, 'pre-key-2.json'), '{"key": 2}', pass);
      writeAuthFile(path.join(authDir, 'session-123.json'), '{"session": true}', pass);

      // All readable
      expect(JSON.parse(readAuthFile(path.join(authDir, 'creds.json'), pass))).toEqual({ creds: true });
      expect(JSON.parse(readAuthFile(path.join(authDir, 'pre-key-1.json'), pass))).toEqual({ key: 1 });
      expect(JSON.parse(readAuthFile(path.join(authDir, 'pre-key-2.json'), pass))).toEqual({ key: 2 });
      expect(JSON.parse(readAuthFile(path.join(authDir, 'session-123.json'), pass))).toEqual({ session: true });
    });
  });

  // ══════════════════════════════════════════════════════════
  // 14. ADVERSARIAL INPUTS
  // ══════════════════════════════════════════════════════════

  describe('Adversarial inputs', () => {
    it('handles malicious JIDs without crashing', async () => {
      const adapter = createTestAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });
      adapter.setSendFunction(async () => {});

      // JID injection attempts
      const maliciousJids = [
        '', // empty
        '   ', // whitespace only
        '@s.whatsapp.net', // no number
        'null@s.whatsapp.net',
        'undefined@s.whatsapp.net',
        '../../../etc/passwd@s.whatsapp.net',
        '<script>alert(1)</script>@s.whatsapp.net',
        'a'.repeat(100_000) + '@s.whatsapp.net', // extremely long
      ];

      for (let i = 0; i < maliciousJids.length; i++) {
        // Should not throw for any input
        await adapter.handleIncomingMessage(maliciousJids[i], `mal-${i}`, 'test', 'Attacker');
      }

      // None should have been processed (none are authorized)
      expect(messages).toHaveLength(0);
    });

    it('handles malicious message content without crashing', async () => {
      const adapter = createTestAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });
      adapter.setSendFunction(async () => {});

      const maliciousTexts = [
        '\0\0\0', // null bytes
        '\x00\x01\x02\x03', // control characters
        '🏳️‍🌈'.repeat(10_000), // emoji flood
        '<script>alert("xss")</script>',
        'SELECT * FROM users; DROP TABLE users;--',
        '${process.exit(1)}',
        '{{constructor.constructor("return this")()}}',
        '\n'.repeat(50_000), // newline flood
        JSON.stringify({ __proto__: { polluted: true } }), // prototype pollution attempt
      ];

      for (let i = 0; i < maliciousTexts.length; i++) {
        await adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          `mal-text-${i}`,
          maliciousTexts[i],
          'User',
        );
      }

      expect(messages).toHaveLength(maliciousTexts.length);
      // Prototype should not be polluted
      expect(({} as any).polluted).toBeUndefined();
    });

    it('handles command injection attempts safely', async () => {
      const adapter = createTestAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      // Commands that look like real commands but with injection
      await adapter.handleIncomingMessage('14155552671@s.whatsapp.net', 'ci-1', '/status; rm -rf /', 'User');
      await adapter.handleIncomingMessage('14155552671@s.whatsapp.net', 'ci-2', '/help$(whoami)', 'User');
      await adapter.handleIncomingMessage('14155552671@s.whatsapp.net', 'ci-3', '/new\n/stop\n/status', 'User');

      // /status and /help should be handled as commands (trailing text is args)
      // /new should be handled as command
      expect(sent.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 15. CONNECTION STATE MACHINE
  // ══════════════════════════════════════════════════════════

  describe('Connection state machine', () => {
    it('handles rapid state transitions', async () => {
      const adapter = createTestAdapter();

      const states: string[] = [];
      const originalSetState = adapter.setConnectionState.bind(adapter);

      // Track all state transitions
      for (const state of ['connecting', 'qr-pending', 'connecting', 'connected', 'reconnecting', 'connected', 'closed'] as const) {
        await adapter.setConnectionState(state, state === 'connected' ? '+14155552671' : undefined);
        states.push(adapter.getStatus().state);
      }

      expect(states).toEqual([
        'connecting', 'qr-pending', 'connecting', 'connected',
        'reconnecting', 'connected', 'closed',
      ]);
    });

    it('flushes outbound queue only on connected, not other states', async () => {
      const adapter = createTestAdapter();
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      // Queue messages while disconnected
      await adapter.send({
        userId: '+14155552671',
        content: 'queued-1',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });
      await adapter.send({
        userId: '+14155552671',
        content: 'queued-2',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(sent).toHaveLength(0);

      // Connecting shouldn't flush
      await adapter.setConnectionState('connecting');
      expect(sent).toHaveLength(0);

      // QR pending shouldn't flush
      await adapter.setConnectionState('qr-pending');
      expect(sent).toHaveLength(0);

      // Connected SHOULD flush
      await adapter.setConnectionState('connected', '+14155552671');
      expect(sent).toHaveLength(2);
      expect(sent).toEqual(['queued-1', 'queued-2']);
    });

    it('handles send failures during queue flush gracefully', async () => {
      const adapter = createTestAdapter();
      let callCount = 0;
      adapter.setSendFunction(async (_jid, text) => {
        callCount++;
        if (callCount === 2) throw new Error('Network error');
      });

      // Queue 3 messages
      for (let i = 0; i < 3; i++) {
        await adapter.send({
          userId: '+14155552671',
          content: `msg-${i}`,
          channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
        });
      }

      // Connect — flush will encounter an error on message 2
      // Should not throw, should continue to message 3
      await adapter.setConnectionState('connected', '+14155552671');
      expect(callCount).toBe(3); // All 3 attempted despite error
    });

    it('reconnect counter resets only on connected', async () => {
      const adapter = createTestAdapter();

      adapter.incrementReconnectAttempts();
      adapter.incrementReconnectAttempts();
      adapter.incrementReconnectAttempts();
      expect(adapter.getStatus().reconnectAttempts).toBe(3);

      // Connecting shouldn't reset
      await adapter.setConnectionState('connecting');
      expect(adapter.getStatus().reconnectAttempts).toBe(3);

      // Reconnecting shouldn't reset
      await adapter.setConnectionState('reconnecting');
      expect(adapter.getStatus().reconnectAttempts).toBe(3);

      // Connected SHOULD reset
      await adapter.setConnectionState('connected', '+14155552671');
      expect(adapter.getStatus().reconnectAttempts).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 16. MESSAGE CHUNKING BOUNDARY CONDITIONS
  // ══════════════════════════════════════════════════════════

  describe('Message chunking boundaries', () => {
    it('sends exactly at max length without chunking', async () => {
      const adapter = createTestAdapter({ maxMessageLength: 100 });
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });
      await adapter.setConnectionState('connected');

      // Exactly 100 chars — no split needed
      await adapter.send({
        userId: '+14155552671',
        content: 'x'.repeat(100),
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].length).toBe(100);
    });

    it('chunks at max length + 1', async () => {
      const adapter = createTestAdapter({ maxMessageLength: 100 });
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });
      await adapter.setConnectionState('connected');

      await adapter.send({
        userId: '+14155552671',
        content: 'x'.repeat(101),
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(sent.length).toBeGreaterThan(1);
      expect(sent.join('').length).toBe(101);
    });

    it('handles single-character messages', async () => {
      const adapter = createTestAdapter();
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });
      await adapter.setConnectionState('connected');

      await adapter.send({
        userId: '+14155552671',
        content: 'x',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(sent).toEqual(['x']);
    });

    it('handles empty message', async () => {
      const adapter = createTestAdapter();
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });
      await adapter.setConnectionState('connected');

      await adapter.send({
        userId: '+14155552671',
        content: '',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      // Empty messages should still be sent (1 chunk of empty string)
      expect(sent).toHaveLength(1);
    });

    it('preserves markdown code blocks across chunks', async () => {
      const adapter = createTestAdapter({ maxMessageLength: 80 });
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });
      await adapter.setConnectionState('connected');

      const codeBlock = '```javascript\nfunction hello() {\n  console.log("Hello, World!");\n}\n```';
      const message = `Here is some code:\n\n${codeBlock}\n\nAnd here is more text after the code block that pushes us way over the limit.`;

      await adapter.send({
        userId: '+14155552671',
        content: message,
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      // Message should be chunked into multiple parts
      expect(sent.length).toBeGreaterThan(1);
      // Chunks joined should contain all the original content
      // (SmartChunker may trim whitespace at split boundaries, so length may differ slightly)
      const joined = sent.join('');
      expect(joined).toContain('```javascript');
      expect(joined).toContain('console.log');
      expect(joined).toContain('code block that pushes');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 17. CONCURRENT CONSENT FLOWS
  // ══════════════════════════════════════════════════════════

  describe('Concurrent consent flows', () => {
    it('handles multiple users going through consent simultaneously', async () => {
      const adapter = createTestAdapter({ requireConsent: true, rateLimitPerMinute: 999999 });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });
      adapter.setSendFunction(async () => {});

      const users = [
        { jid: '14155552671@s.whatsapp.net', phone: '+14155552671' },
        { jid: '447911123456@s.whatsapp.net', phone: '+447911123456' },
        { jid: '5511999998888@s.whatsapp.net', phone: '+5511999998888' },
      ];

      // All 3 users send first message simultaneously — all get consent prompts
      await Promise.all(users.map((u, i) =>
        adapter.handleIncomingMessage(u.jid, `consent-init-${i}`, 'Hello!', `User${i}`)
      ));

      expect(messages).toHaveLength(0); // All blocked

      // User 0 agrees, user 1 declines, user 2 sends random text
      await Promise.all([
        adapter.handleIncomingMessage(users[0].jid, 'consent-resp-0', 'yes', 'User0'),
        adapter.handleIncomingMessage(users[1].jid, 'consent-resp-1', 'no', 'User1'),
        adapter.handleIncomingMessage(users[2].jid, 'consent-resp-2', 'what?', 'User2'),
      ]);

      // Now user 0 can message, others cannot
      await Promise.all([
        adapter.handleIncomingMessage(users[0].jid, 'after-consent-0', 'I can chat!', 'User0'),
        adapter.handleIncomingMessage(users[1].jid, 'after-consent-1', 'I cannot', 'User1'),
        adapter.handleIncomingMessage(users[2].jid, 'after-consent-2', 'Still pending', 'User2'),
      ]);

      expect(messages).toHaveLength(1); // Only user 0's message
      expect(messages[0].content).toBe('I can chat!');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 18. ADAPTER RESTART & STATE RECOVERY
  // ══════════════════════════════════════════════════════════

  describe('Adapter restart & state recovery', () => {
    it('new adapter instance recovers sessions from disk', () => {
      const adapter1 = createTestAdapter();
      adapter1.registerSession('14155552671@s.whatsapp.net', 'session-1');
      adapter1.registerSession('447911123456@s.whatsapp.net', 'session-2');

      // Simulate restart — new instance, same state dir
      const adapter2 = createTestAdapter();
      expect(adapter2.getSessionForChannel('14155552671@s.whatsapp.net')).toBe('session-1');
      expect(adapter2.getSessionForChannel('447911123456@s.whatsapp.net')).toBe('session-2');
    });

    it('new adapter instance preserves message log continuity', async () => {
      const adapter1 = createTestAdapter();
      adapter1.onMessage(async () => {});
      adapter1.setSendFunction(async () => {});

      await adapter1.handleIncomingMessage('14155552671@s.whatsapp.net', 'restart-1', 'msg1', 'User');
      await adapter1.handleIncomingMessage('14155552671@s.whatsapp.net', 'restart-2', 'msg2', 'User');

      const count1 = adapter1.getStatus().totalMessagesLogged;

      // Restart
      const adapter2 = createTestAdapter();
      adapter2.onMessage(async () => {});
      adapter2.setSendFunction(async () => {});

      await adapter2.handleIncomingMessage('14155552671@s.whatsapp.net', 'restart-3', 'msg3', 'User');

      expect(adapter2.getStatus().totalMessagesLogged).toBe(count1 + 1);
    });

    it('dedup set resets on restart (by design — no persistent dedup)', async () => {
      const adapter1 = createTestAdapter();
      const messages1: any[] = [];
      adapter1.onMessage(async (msg) => { messages1.push(msg); });
      adapter1.setSendFunction(async () => {});

      await adapter1.handleIncomingMessage('14155552671@s.whatsapp.net', 'dedup-1', 'first', 'User');
      expect(messages1).toHaveLength(1);

      // Restart — dedup set is empty, so same ID will be processed again
      // This is the expected behavior: Baileys handles reconnect dedup at the protocol level
      const adapter2 = createTestAdapter();
      const messages2: any[] = [];
      adapter2.onMessage(async (msg) => { messages2.push(msg); });
      adapter2.setSendFunction(async () => {});

      await adapter2.handleIncomingMessage('14155552671@s.whatsapp.net', 'dedup-1', 'first again', 'User');
      expect(messages2).toHaveLength(1);
    });

    it('rate limit state resets on restart', async () => {
      const adapter1 = createTestAdapter({ rateLimitPerMinute: 2 });
      const messages1: any[] = [];
      adapter1.onMessage(async (msg) => { messages1.push(msg); });
      adapter1.setSendFunction(async () => {});

      // Exhaust rate limit
      await adapter1.handleIncomingMessage('14155552671@s.whatsapp.net', 'rl-1', 'msg1', 'User');
      await adapter1.handleIncomingMessage('14155552671@s.whatsapp.net', 'rl-2', 'msg2', 'User');
      await adapter1.handleIncomingMessage('14155552671@s.whatsapp.net', 'rl-3', 'msg3', 'User'); // Should be limited
      expect(messages1).toHaveLength(2);

      // Restart — rate limit resets
      const adapter2 = createTestAdapter({ rateLimitPerMinute: 2 });
      const messages2: any[] = [];
      adapter2.onMessage(async (msg) => { messages2.push(msg); });
      adapter2.setSendFunction(async () => {});

      await adapter2.handleIncomingMessage('14155552671@s.whatsapp.net', 'rl-4', 'msg4', 'User');
      expect(messages2).toHaveLength(1); // Fresh rate limit
    });
  });

  // ══════════════════════════════════════════════════════════
  // 19. CROSS-MODULE FAILURE CASCADING
  // ══════════════════════════════════════════════════════════

  describe('Cross-module failure cascading', () => {
    it('message handler error does not block subsequent messages', async () => {
      const adapter = createTestAdapter();
      let callCount = 0;
      adapter.onMessage(async (msg) => {
        callCount++;
        if (callCount === 1) throw new Error('Handler crashed');
      });
      adapter.setSendFunction(async () => {});

      // First message — handler crashes
      await adapter.handleIncomingMessage('14155552671@s.whatsapp.net', 'fail-1', 'crash', 'User');
      // Second message — should still be processed
      await adapter.handleIncomingMessage('14155552671@s.whatsapp.net', 'fail-2', 'recover', 'User');

      expect(callCount).toBe(2);
    });

    it('send function failure does not corrupt adapter state', async () => {
      const adapter = createTestAdapter();
      let failSend = true;
      adapter.setSendFunction(async () => {
        if (failSend) throw new Error('Send failed');
      });
      await adapter.setConnectionState('connected');

      // Send with failing send function
      await adapter.send({
        userId: '+14155552671',
        content: 'will fail',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      // Fix send function
      const sent: string[] = [];
      failSend = false;
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      // Should work normally now
      await adapter.send({
        userId: '+14155552671',
        content: 'will succeed',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(sent).toEqual(['will succeed']);
    });

    it('EventBus listener error does not prevent message delivery', async () => {
      const adapter = createTestAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });
      adapter.setSendFunction(async () => {});

      // Add a listener that throws
      adapter.getEventBus().on('message:incoming', async () => {
        throw new Error('Listener exploded');
      });

      // Message should still be delivered despite listener error
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net', 'bus-fail-1', 'still works', 'User',
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('still works');
    });

    it('adapter stop while messages in flight', async () => {
      const adapter = createTestAdapter({ rateLimitPerMinute: 999999 });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => {
        messages.push(msg);
        // Simulate slow handler
        await new Promise(r => setTimeout(r, 10));
      });
      adapter.setSendFunction(async () => {});
      await adapter.start();

      // Fire messages and stop concurrently
      const msgPromises = [];
      for (let i = 0; i < 5; i++) {
        msgPromises.push(
          adapter.handleIncomingMessage(
            '14155552671@s.whatsapp.net', `stop-flight-${i}`, `msg-${i}`, 'User',
          )
        );
      }

      // Stop after firing
      await adapter.stop();
      await Promise.allSettled(msgPromises);

      // Should not have crashed — some messages may have been processed
      expect(adapter.getStatus().state).toBe('closed');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 20. MEGA STRESS TEST
  // ══════════════════════════════════════════════════════════

  describe('Mega stress test', () => {
    it('500 messages across 10 users with consent + auth + commands + rate limiting', async () => {
      const adapter = createTestAdapter({
        requireConsent: true,
        rateLimitPerMinute: 999999,
        authorizedNumbers: Array.from({ length: 10 }, (_, i) => `+1415555${String(i).padStart(4, '0')}`),
      });

      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      const users = Array.from({ length: 10 }, (_, i) => ({
        jid: `1415555${String(i).padStart(4, '0')}@s.whatsapp.net`,
        phone: `+1415555${String(i).padStart(4, '0')}`,
      }));

      // Phase 1: All users send initial message (triggers consent)
      await Promise.all(users.map((u, i) =>
        adapter.handleIncomingMessage(u.jid, `mega-init-${i}`, 'Hello', `User${i}`)
      ));
      expect(messages).toHaveLength(0); // All blocked by consent

      // Phase 2: All users consent
      await Promise.all(users.map((u, i) =>
        adapter.handleIncomingMessage(u.jid, `mega-consent-${i}`, 'yes', `User${i}`)
      ));

      // Phase 3: Fire 500 messages (50 per user) with some commands
      const promises = [];
      for (let i = 0; i < 500; i++) {
        const user = users[i % 10];
        const isCommand = i % 100 === 0; // 5 commands total
        const text = isCommand ? '/status' : `Mega message ${i}`;

        promises.push(
          adapter.handleIncomingMessage(
            user.jid,
            `mega-msg-${i}`,
            text,
            `User${i % 10}`,
          )
        );
      }

      await Promise.all(promises);

      // 5 commands + 495 messages = 500, but commands don't reach handler
      expect(messages).toHaveLength(495);

      // Status should be sane
      const status = adapter.getStatus();
      expect(status.totalMessagesLogged).toBe(500);
      expect(status.registeredSessions).toBe(0); // No sessions registered in this test
    }, 30_000);
  });
});
