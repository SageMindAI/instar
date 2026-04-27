/**
 * End-to-end tests for iMessage Adapter.
 *
 * Tests the full adapter lifecycle WITHOUT requiring the real `imsg` CLI
 * or macOS Messages.app. The RPC process is not spawned — instead, we
 * exercise the adapter's logic directly via internal method calls.
 *
 * Tier 3: Production initialization path mirroring server.ts.
 *
 * Covers:
 * 1. Phase 1 "feature is alive" — adapter + routes return 200, not 503
 * 2. Full message lifecycle: receive → auth → log → handle
 * 3. Auth gate: reject unauthorized → accept authorized
 * 4. Message deduplication under repeated notifications
 * 5. Outbound echo prevention (isFromMe + sentMessageIds)
 * 6. EventBus integration
 * 7. Adapter registry integration
 * 8. Message logging persistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import request from 'supertest';
import { IMessageAdapter } from '../../src/messaging/imessage/IMessageAdapter.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import {
  registerAdapter,
  createAdapter,
  hasAdapter,
  clearRegistry,
} from '../../src/messaging/AdapterRegistry.js';

describe('iMessage Adapter — E2E lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-e2e-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRegistry();
  });

  function createTestAdapter(overrides: Record<string, unknown> = {}): IMessageAdapter {
    return new IMessageAdapter(
      {
        authorizedSenders: ['+14081234567', '+447911123456', 'user@icloud.com'],
        autoReconnect: false, // Don't try to reconnect in tests
        ...overrides,
      },
      tmpDir,
    );
  }

  // ══════════════════════════════════════════════════════════
  // 1. PHASE 1 — FEATURE IS ALIVE (Critical: 200, not 503)
  // ══════════════════════════════════════════════════════════

  describe('Phase 1: Feature is alive', () => {
    it('returns 200 for /imessage/status — not 503 (dead on arrival check)', async () => {
      const project = createTempProject();
      const mockSM = createMockSessionManager();
      const adapter = createTestAdapter();

      const config: InstarConfig = {
        projectName: 'imsg-alive-test',
        projectDir: project.dir,
        stateDir: project.stateDir,
        port: 0,
        authToken: 'test-token',
        sessions: {
          tmuxPath: '/usr/bin/tmux',
          claudePath: '/usr/bin/claude',
          projectDir: project.dir,
          maxSessions: 5,
          protectedSessions: [],
          completionPatterns: [],
        },
        users: [],
        messaging: [{ type: 'imessage', enabled: true, config: { authorizedSenders: ['+14081234567'] } }],
        monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
        scheduler: { enabled: false, timezone: 'UTC' },
      };

      const server = new AgentServer({
        config,
        sessionManager: mockSM as any,
        state: project.state,
        imessage: adapter,
      });
      const app = server.getApp();

      const res = await request(app)
        .get('/imessage/status')
        .set('Authorization', 'Bearer test-token');

      // THE critical assertion: 200, NOT 503
      expect(res.status).toBe(200);
      expect(res.body.state).toBeDefined();

      project.cleanup();
    });

    it('returns 200 for /imessage/log-stats — not 503', async () => {
      const project = createTempProject();
      const mockSM = createMockSessionManager();
      const adapter = createTestAdapter();

      const config: InstarConfig = {
        projectName: 'imsg-alive-test-2',
        projectDir: project.dir,
        stateDir: project.stateDir,
        port: 0,
        authToken: 'test-token',
        sessions: {
          tmuxPath: '/usr/bin/tmux',
          claudePath: '/usr/bin/claude',
          projectDir: project.dir,
          maxSessions: 5,
          protectedSessions: [],
          completionPatterns: [],
        },
        users: [],
        messaging: [{ type: 'imessage', enabled: true, config: { authorizedSenders: ['+14081234567'] } }],
        monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
        scheduler: { enabled: false, timezone: 'UTC' },
      };

      const server = new AgentServer({
        config,
        sessionManager: mockSM as any,
        state: project.state,
        imessage: adapter,
      });
      const app = server.getApp();

      const res = await request(app)
        .get('/imessage/log-stats')
        .set('Authorization', 'Bearer test-token');

      expect(res.status).toBe(200);
      expect(res.body.totalMessages).toBeDefined();

      project.cleanup();
    });

    it('capabilities endpoint includes iMessage when wired', async () => {
      const project = createTempProject();
      const mockSM = createMockSessionManager();
      const adapter = createTestAdapter();

      const config: InstarConfig = {
        projectName: 'imsg-alive-cap',
        projectDir: project.dir,
        stateDir: project.stateDir,
        port: 0,
        authToken: 'test-token',
        sessions: {
          tmuxPath: '/usr/bin/tmux',
          claudePath: '/usr/bin/claude',
          projectDir: project.dir,
          maxSessions: 5,
          protectedSessions: [],
          completionPatterns: [],
        },
        users: [],
        messaging: [{ type: 'imessage', enabled: true, config: { authorizedSenders: ['+14081234567'] } }],
        monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
        scheduler: { enabled: false, timezone: 'UTC' },
      };

      const server = new AgentServer({
        config,
        sessionManager: mockSM as any,
        state: project.state,
        imessage: adapter,
      });
      const app = server.getApp();

      const res = await request(app)
        .get('/capabilities')
        .set('Authorization', 'Bearer test-token');

      expect(res.status).toBe(200);
      expect(res.body.imessage).toBeDefined();
      expect(res.body.imessage.adapter).toBe(true);
      expect(res.body.imessage.configured).toBe(true);

      project.cleanup();
    });
  });

  // ══════════════════════════════════════════════════════════
  // 2. FULL MESSAGE LIFECYCLE
  // ══════════════════════════════════════════════════════════

  describe('Full message lifecycle', () => {
    it('receive → auth → log → handle', async () => {
      const adapter = createTestAdapter();
      const receivedMessages: any[] = [];
      adapter.onMessage(async (msg) => { receivedMessages.push(msg); });

      // Simulate incoming message from authorized sender
      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;+14081234567',
        messageId: 'lifecycle-1',
        sender: '+14081234567',
        senderName: 'Adrian',
        text: 'E2E test message',
        timestamp: Math.floor(Date.now() / 1000),
        isFromMe: false,
      });

      // Message was received and forwarded to handler
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].content).toBe('E2E test message');
      expect(receivedMessages[0].userId).toBe('+14081234567');
      expect(receivedMessages[0].channel.type).toBe('imessage');
      expect(receivedMessages[0].channel.identifier).toBe('+14081234567');
      expect(receivedMessages[0].metadata?.senderName).toBe('Adrian');

      // Message was logged to JSONL
      const logPath = path.join(tmpDir, 'imessage-messages.jsonl');
      expect(fs.existsSync(logPath)).toBe(true);
      const logContent = fs.readFileSync(logPath, 'utf-8');
      const logEntries = logContent.trim().split('\n').map(l => JSON.parse(l));
      expect(logEntries.some(e => e.messageId === 'lifecycle-1')).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 3. AUTH GATE
  // ══════════════════════════════════════════════════════════

  describe('Auth gate lifecycle', () => {
    it('rejects unauthorized → accepts authorized', async () => {
      const adapter = createTestAdapter();
      const receivedMessages: any[] = [];
      adapter.onMessage(async (msg) => { receivedMessages.push(msg); });

      // Unauthorized sender
      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;+19995550000',
        messageId: 'auth-reject-1',
        sender: '+19995550000',
        text: 'Should be rejected',
        timestamp: Math.floor(Date.now() / 1000),
        isFromMe: false,
      });

      expect(receivedMessages).toHaveLength(0);

      // Authorized sender
      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;+14081234567',
        messageId: 'auth-accept-1',
        sender: '+14081234567',
        text: 'Should be accepted',
        timestamp: Math.floor(Date.now() / 1000),
        isFromMe: false,
      });

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].content).toBe('Should be accepted');
    });

    it('authorizes email-based senders', async () => {
      const adapter = createTestAdapter();
      const receivedMessages: any[] = [];
      adapter.onMessage(async (msg) => { receivedMessages.push(msg); });

      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;user@icloud.com',
        messageId: 'email-auth-1',
        sender: 'user@icloud.com',
        text: 'Email-based sender',
        timestamp: Math.floor(Date.now() / 1000),
        isFromMe: false,
      });

      expect(receivedMessages).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 4. MESSAGE DEDUPLICATION
  // ══════════════════════════════════════════════════════════

  describe('Message deduplication', () => {
    it('deduplicates repeated notifications', async () => {
      const adapter = createTestAdapter();
      const receivedMessages: any[] = [];
      adapter.onMessage(async (msg) => { receivedMessages.push(msg); });

      const msg = {
        chatId: 'iMessage;-;+14081234567',
        messageId: 'dedup-1',
        sender: '+14081234567',
        text: 'Duplicate test',
        timestamp: Math.floor(Date.now() / 1000),
        isFromMe: false,
      };

      // Send same message 5 times
      for (let i = 0; i < 5; i++) {
        await (adapter as any)._handleIncomingMessage(msg);
      }

      // Only processed once
      expect(receivedMessages).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 5. OUTBOUND ECHO PREVENTION
  // ══════════════════════════════════════════════════════════

  describe('Outbound echo prevention', () => {
    it('skips messages with isFromMe flag', async () => {
      const adapter = createTestAdapter();
      const receivedMessages: any[] = [];
      adapter.onMessage(async (msg) => { receivedMessages.push(msg); });

      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;+14081234567',
        messageId: 'echo-1',
        sender: '+14081234567',
        text: 'My own outbound',
        timestamp: Math.floor(Date.now() / 1000),
        isFromMe: true,
      });

      expect(receivedMessages).toHaveLength(0);
    });

    it('send() throws explaining LaunchAgent limitation', async () => {
      const adapter = createTestAdapter();
      await expect(adapter.send({ userId: '+1408', content: 'test' }))
        .rejects.toThrow('Cannot send from server process');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 6. EVENTBUS INTEGRATION
  // ══════════════════════════════════════════════════════════

  describe('EventBus integration', () => {
    it('emits message:incoming events', async () => {
      const adapter = createTestAdapter();
      adapter.onMessage(async () => {}); // Need handler to avoid early return

      const events: any[] = [];
      adapter.eventBus.on('message:incoming', (data) => {
        events.push(data);
      });

      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;+14081234567',
        messageId: 'event-1',
        sender: '+14081234567',
        text: 'EventBus test',
        timestamp: Math.floor(Date.now() / 1000),
        isFromMe: false,
      });

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('EventBus test');
      expect(events[0].userId).toBe('+14081234567');
      expect(events[0].channelId).toBe('iMessage;-;+14081234567');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 7. ADAPTER REGISTRY INTEGRATION
  // ══════════════════════════════════════════════════════════

  describe('Adapter registry integration', () => {
    it('registers imessage adapter type via registerAdapter', () => {
      // Manually register (same as what index.ts does at module load)
      registerAdapter('imessage', IMessageAdapter as any);
      expect(hasAdapter('imessage')).toBe(true);
    });

    it('creates adapter via registry factory', () => {
      registerAdapter('imessage', IMessageAdapter as any);
      const adapter = createAdapter(
        { type: 'imessage', enabled: true, config: { authorizedSenders: ['+14081234567'] } },
        tmpDir,
      );
      expect(adapter.platform).toBe('imessage');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 8. MESSAGE LOGGING PERSISTENCE
  // ══════════════════════════════════════════════════════════

  describe('Message logging persistence', () => {
    it('logs inbound messages to JSONL file', async () => {
      const adapter = createTestAdapter();
      adapter.onMessage(async () => {});

      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;+14081234567',
        messageId: 'log-1',
        sender: '+14081234567',
        senderName: 'TestUser',
        text: 'Logging test',
        timestamp: 1711584000,
        isFromMe: false,
      });

      const logPath = path.join(tmpDir, 'imessage-messages.jsonl');
      expect(fs.existsSync(logPath)).toBe(true);

      const entries = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      const entry = entries.find((e: any) => e.messageId === 'log-1');
      expect(entry).toBeDefined();
      expect(entry.text).toBe('Logging test');
      expect(entry.fromUser).toBe(true);
      expect(entry.platform).toBe('imessage');
      expect(entry.senderName).toBe('TestUser');
    });

    it('fires onMessageLogged callback', async () => {
      const adapter = createTestAdapter();
      adapter.onMessage(async () => {});

      const loggedEntries: any[] = [];
      adapter.onMessageLogged = (entry) => { loggedEntries.push(entry); };

      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;+14081234567',
        messageId: 'callback-1',
        sender: '+14081234567',
        text: 'Callback test',
        timestamp: Math.floor(Date.now() / 1000),
        isFromMe: false,
      });

      expect(loggedEntries).toHaveLength(1);
      expect(loggedEntries[0].messageId).toBe('callback-1');
    });
  });
});
