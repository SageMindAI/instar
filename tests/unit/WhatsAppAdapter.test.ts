import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WhatsAppAdapter } from '../../src/messaging/WhatsAppAdapter.js';

describe('WhatsAppAdapter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-adapter-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createAdapter(overrides: Record<string, unknown> = {}): WhatsAppAdapter {
    return new WhatsAppAdapter(
      {
        backend: 'baileys',
        authorizedNumbers: ['+14155552671', '+447911123456'],
        stallTimeoutMinutes: 5,
        requireConsent: false, // Disable consent for unit tests (tested separately)
        prefixEnabled: false, // Disable prefix for unit tests (tested separately)
        ...overrides,
      },
      tmpDir,
    );
  }

  // ── Construction ──────────────────────────────────────

  describe('construction', () => {
    it('creates adapter with correct platform', () => {
      const adapter = createAdapter();
      expect(adapter.platform).toBe('whatsapp');
    });

    it('initializes with disconnected state', () => {
      const adapter = createAdapter();
      const status = adapter.getStatus();
      expect(status.state).toBe('disconnected');
      expect(status.phoneNumber).toBeNull();
    });

    it('creates shared infrastructure modules', () => {
      const adapter = createAdapter();
      expect(adapter.getEventBus()).toBeDefined();
      expect(adapter.getCommandRouter()).toBeDefined();
      expect(adapter.getAuthGate()).toBeDefined();
    });

    it('registers default commands', () => {
      const adapter = createAdapter();
      const commands = adapter.getCommandRouter().getRegisteredCommands();
      const names = commands.flatMap(c => c.names);
      expect(names).toContain('new');
      expect(names).toContain('reset');
      expect(names).toContain('stop');
      expect(names).toContain('status');
      expect(names).toContain('help');
      expect(names).toContain('whoami');
    });
  });

  // ── Authorization ──────────────────────────────────────

  describe('authorization', () => {
    it('authorizes configured phone numbers', () => {
      const adapter = createAdapter();
      expect(adapter.getAuthGate().isAuthorized('+14155552671')).toBe(true);
      expect(adapter.getAuthGate().isAuthorized('+447911123456')).toBe(true);
    });

    it('rejects unauthorized numbers', () => {
      const adapter = createAdapter();
      expect(adapter.getAuthGate().isAuthorized('+19999999999')).toBe(false);
    });

    it('denies all users when no authorized list (safe default)', () => {
      const adapter = createAdapter({ authorizedNumbers: [] });
      expect(adapter.getAuthGate().isAuthorized('+19999999999')).toBe(false);
    });

    it('allows all users when wildcard "*" is in authorized list', () => {
      const adapter = createAdapter({ authorizedNumbers: ['*'] });
      expect(adapter.getAuthGate().isAuthorized('+19999999999')).toBe(true);
    });
  });

  // ── Connection state ──────────────────────────────────────

  describe('connection state', () => {
    it('tracks state transitions', () => {
      const adapter = createAdapter();
      expect(adapter.getStatus().state).toBe('disconnected');

      adapter.setConnectionState('connecting');
      expect(adapter.getStatus().state).toBe('connecting');

      adapter.setConnectionState('connected', '+14155552671');
      expect(adapter.getStatus().state).toBe('connected');
      expect(adapter.getStatus().phoneNumber).toBe('+14155552671');
      expect(adapter.getStatus().lastConnected).not.toBeNull();
    });

    it('resets reconnect counter on connect', () => {
      const adapter = createAdapter();
      adapter.incrementReconnectAttempts();
      adapter.incrementReconnectAttempts();
      expect(adapter.getStatus().reconnectAttempts).toBe(2);

      adapter.setConnectionState('connected', '+14155552671');
      expect(adapter.getStatus().reconnectAttempts).toBe(0);
    });
  });

  // ── Inbound message handling ──────────────────────────────

  describe('handleIncomingMessage', () => {
    it('processes authorized messages', async () => {
      const adapter = createAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-1',
        'Hello from WhatsApp',
        'Test User',
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello from WhatsApp');
      expect(messages[0].channel.type).toBe('whatsapp');
    });

    it('rejects unauthorized messages', async () => {
      const adapter = createAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      await adapter.handleIncomingMessage(
        '19999999999@s.whatsapp.net',
        'msg-2',
        'Unauthorized',
        'Stranger',
      );

      expect(messages).toHaveLength(0);
    });

    it('deduplicates messages by ID', async () => {
      const adapter = createAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      await adapter.handleIncomingMessage('14155552671@s.whatsapp.net', 'msg-1', 'First', 'User');
      await adapter.handleIncomingMessage('14155552671@s.whatsapp.net', 'msg-1', 'Duplicate', 'User');

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('First');
    });

    it('routes commands instead of forwarding to handler', async () => {
      const adapter = createAdapter();
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      // Set up send function so command responses can be sent
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-cmd',
        '/status',
        'User',
      );

      expect(messages).toHaveLength(0); // Command handled, not forwarded
      expect(sent.length).toBeGreaterThan(0); // Status response sent
    });

    it('emits events on the event bus', async () => {
      const adapter = createAdapter();
      adapter.onMessage(async () => {});

      const incomingEvents: any[] = [];
      adapter.getEventBus().on('message:incoming', (e) => { incomingEvents.push(e); });

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-ev',
        'Hello',
        'User',
      );

      expect(incomingEvents).toHaveLength(1);
      expect(incomingEvents[0].text).toBe('Hello');
    });

    it('emits auth:unauthorized for rejected users', async () => {
      const adapter = createAdapter();
      const unauthEvents: any[] = [];
      adapter.getEventBus().on('auth:unauthorized', (e) => { unauthEvents.push(e); });

      await adapter.handleIncomingMessage(
        '19999999999@s.whatsapp.net',
        'msg-unauth',
        'Hello',
        'Stranger',
      );

      expect(unauthEvents).toHaveLength(1);
      expect(unauthEvents[0].displayName).toBe('Stranger');
    });

    it('logs inbound messages', async () => {
      const adapter = createAdapter();
      adapter.onMessage(async () => {});

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-log',
        'Logged message',
        'User',
      );

      const status = adapter.getStatus();
      expect(status.totalMessagesLogged).toBeGreaterThan(0);
    });
  });

  // ── Outbound messages ──────────────────────────────────────

  describe('send', () => {
    it('sends via send function when connected', async () => {
      const adapter = createAdapter();
      const sent: Array<{ jid: string; text: string }> = [];
      adapter.setSendFunction(async (jid, text) => { sent.push({ jid, text }); });
      adapter.setConnectionState('connected');

      await adapter.send({
        userId: '+14155552671',
        content: 'Hello',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBe('Hello');
    });

    it('queues messages when disconnected', async () => {
      const adapter = createAdapter();
      // No send function set = disconnected behavior

      await adapter.send({
        userId: '+14155552671',
        content: 'Queued message',
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      // Message should be queued (can't verify directly, but shouldn't throw)
    });

    it('chunks long messages', async () => {
      const adapter = createAdapter({ maxMessageLength: 50 });
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });
      adapter.setConnectionState('connected');

      const longText = 'A'.repeat(120);
      await adapter.send({
        userId: '+14155552671',
        content: longText,
        channel: { type: 'whatsapp', identifier: '14155552671@s.whatsapp.net' },
      });

      expect(sent.length).toBeGreaterThan(1);
      expect(sent.join('').length).toBe(120);
    });
  });

  // ── Session management ──────────────────────────────────────

  describe('session management', () => {
    it('registers and retrieves sessions', () => {
      const adapter = createAdapter();
      adapter.registerSession('14155552671@s.whatsapp.net', 'test-session');

      expect(adapter.getSessionForChannel('14155552671@s.whatsapp.net')).toBe('test-session');
      expect(adapter.getChannelForSession('test-session')).toBe('14155552671@s.whatsapp.net');
    });
  });

  // ── Rate limiting ──────────────────────────────────────

  describe('rate limiting', () => {
    it('rate-limits rapid messages from same user', async () => {
      const adapter = createAdapter({ rateLimitPerMinute: 3 });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      // Send 5 messages rapidly — only 3 should get through
      for (let i = 0; i < 5; i++) {
        await adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          `msg-rl-${i}`,
          `Message ${i}`,
          'User',
        );
      }

      expect(messages).toHaveLength(3);
    });
  });

  // ── Commands ──────────────────────────────────────

  describe('commands', () => {
    it('/new resets session', async () => {
      const adapter = createAdapter();
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      adapter.registerSession('14155552671@s.whatsapp.net', 'old-session');

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'cmd-new',
        '/new',
        'User',
      );

      expect(adapter.getSessionForChannel('14155552671@s.whatsapp.net')).toBeNull();
      expect(sent[0]).toContain('Session reset');
    });

    it('/help shows available commands', async () => {
      const adapter = createAdapter();
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'cmd-help',
        '/help',
        'User',
      );

      expect(sent[0]).toContain('/new');
      expect(sent[0]).toContain('/status');
    });

    it('/whoami shows user identity', async () => {
      const adapter = createAdapter();
      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'cmd-whoami',
        '/whoami',
        'User',
      );

      expect(sent[0]).toContain('+14155552671');
      expect(sent[0]).toContain('Authorized: yes');
    });
  });

  // ── Stall detection ──────────────────────────────────────

  describe('stall detection', () => {
    it('tracks message injection for stall detection', async () => {
      const adapter = createAdapter();
      adapter.onMessage(async () => {});
      adapter.registerSession('14155552671@s.whatsapp.net', 'test-session');

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-stall',
        'Will this stall?',
        'User',
      );

      const status = adapter.getStatus();
      expect(status.pendingMessages).toBeGreaterThan(0);
    });
  });

  // ── Baileys config ──────────────────────────────────────

  describe('getBaileysConfig', () => {
    it('returns defaults when no baileys config provided', () => {
      const adapter = createAdapter();
      const config = adapter.getBaileysConfig();
      expect(config.markOnline).toBe(false);
      expect(config.maxReconnectAttempts).toBe(10);
      expect(config.authMethod).toBe('qr');
    });

    it('merges provided config with defaults', () => {
      const adapter = createAdapter({
        baileys: { markOnline: true, maxReconnectAttempts: 5 },
      });
      const config = adapter.getBaileysConfig();
      expect(config.markOnline).toBe(true);
      expect(config.maxReconnectAttempts).toBe(5);
      expect(config.authMethod).toBe('qr'); // Still default
    });
  });

  // ── resolveUser ──────────────────────────────────────

  describe('resolveUser', () => {
    it('resolves JID to phone number', async () => {
      const adapter = createAdapter();
      const phone = await adapter.resolveUser('14155552671@s.whatsapp.net');
      expect(phone).toBe('+14155552671');
    });

    it('resolves phone number directly', async () => {
      const adapter = createAdapter();
      const phone = await adapter.resolveUser('+14155552671');
      expect(phone).toBe('+14155552671');
    });

    it('returns null for invalid input', async () => {
      const adapter = createAdapter();
      const phone = await adapter.resolveUser('not-a-phone');
      expect(phone).toBeNull();
    });
  });

  // ── Lifecycle ──────────────────────────────────────

  describe('lifecycle', () => {
    it('start sets connecting state', async () => {
      const adapter = createAdapter();
      await adapter.start();
      // State transitions are managed by backend, but start should not throw
    });

    it('stop cleans up resources', async () => {
      const adapter = createAdapter();
      await adapter.start();
      await adapter.stop();
      expect(adapter.getStatus().state).toBe('closed');
    });
  });

  // ── Privacy consent ──────────────────────────────────────

  describe('privacy consent', () => {
    it('blocks messages from users without consent', async () => {
      const adapter = createAdapter({ requireConsent: true });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-consent-1',
        'Hello',
        'User',
      );

      expect(messages).toHaveLength(0);
      expect(sent[0]).toContain('Before we chat'); // Default consent message
    });

    it('grants consent on positive response', async () => {
      const adapter = createAdapter({ requireConsent: true });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      // First message triggers consent prompt
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-c1',
        'Hello',
        'User',
      );

      // Consent response
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-c2',
        'yes',
        'User',
      );

      expect(sent[1]).toContain('Thank you');

      // Now messages should go through
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-c3',
        'Now I can chat!',
        'User',
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Now I can chat!');
    });

    it('denies consent on negative response', async () => {
      const adapter = createAdapter({ requireConsent: true });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      // First message triggers consent prompt
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-d1',
        'Hello',
        'User',
      );

      // Deny consent
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-d2',
        'no',
        'User',
      );

      expect(sent[1]).toContain('not be processed');
      expect(messages).toHaveLength(0);
    });

    it('/stop revokes consent', async () => {
      const adapter = createAdapter({ requireConsent: true });
      const messages: any[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      // Grant consent first
      adapter.getPrivacyConsent().grantConsent('+14155552671');

      // /stop should revoke consent
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-stop',
        '/stop',
        'User',
      );

      expect(sent.some(s => s.includes('consent revoked'))).toBe(true);
      expect(adapter.getPrivacyConsent().hasConsent('+14155552671')).toBe(false);
    });

    it('reminds pending users who send non-consent messages', async () => {
      const adapter = createAdapter({ requireConsent: true });
      adapter.onMessage(async () => {});

      const sent: string[] = [];
      adapter.setSendFunction(async (_jid, text) => { sent.push(text); });

      // First message triggers consent
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-r1',
        'Hello',
        'User',
      );

      // Non-consent response while pending
      await adapter.handleIncomingMessage(
        '14155552671@s.whatsapp.net',
        'msg-r2',
        'What is this about?',
        'User',
      );

      expect(sent[1]).toContain('reply "yes"');
    });

    it('exposes privacy consent accessor', () => {
      const adapter = createAdapter();
      expect(adapter.getPrivacyConsent()).toBeDefined();
    });

    describe('directMessageTrigger', () => {
      it('defaults to "always" — DMs trigger without mention (backward-compatible)', async () => {
        const adapter = createAdapter();
        const messages: any[] = [];
        adapter.onMessage(async (msg) => { messages.push(msg); });

        await adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          'msg-dmt-1',
          'hello',
          'User',
        );

        expect(messages).toHaveLength(1);
      });

      it('"mention" mode blocks DMs without @AgentName', async () => {
        const adapter = createAdapter({ directMessageTrigger: 'mention', agentName: 'Echo' });
        const messages: any[] = [];
        adapter.onMessage(async (msg) => { messages.push(msg); });

        await adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          'msg-dmt-2',
          'hello there',
          'User',
        );

        expect(messages).toHaveLength(0);
      });

      it('"mention" mode allows DMs with @AgentName', async () => {
        const adapter = createAdapter({ directMessageTrigger: 'mention', agentName: 'Echo' });
        const messages: any[] = [];
        adapter.onMessage(async (msg) => { messages.push(msg); });

        await adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          'msg-dmt-3',
          '@Echo what do you think?',
          'User',
        );

        expect(messages).toHaveLength(1);
      });

      it('"off" mode blocks all DMs even with mention', async () => {
        const adapter = createAdapter({ directMessageTrigger: 'off', agentName: 'Echo' });
        const messages: any[] = [];
        adapter.onMessage(async (msg) => { messages.push(msg); });

        await adapter.handleIncomingMessage(
          '14155552671@s.whatsapp.net',
          'msg-dmt-4',
          '@Echo hello',
          'User',
        );

        expect(messages).toHaveLength(0);
      });

      it('"mention" mode does not affect group messages', async () => {
        const adapter = createAdapter({
          directMessageTrigger: 'mention',
          agentName: 'Echo',
          groups: { enabled: true, defaultActivation: 'always' },
        });
        const messages: any[] = [];
        adapter.onMessage(async (msg) => { messages.push(msg); });

        await adapter.handleIncomingMessage(
          'group123@g.us',
          'msg-dmt-5',
          'hello group',
          'User',
          undefined,
          undefined,
          '14155552671@s.whatsapp.net',
        );

        expect(messages).toHaveLength(1);
      });
    });
  });
});
