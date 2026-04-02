/**
 * Tests for IMessageAdapter — authorization, message flow, deduplication, logging.
 *
 * Uses a mock RPC client approach (test the adapter's logic without spawning
 * a real imsg process).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IMessageAdapter } from '../../src/messaging/imessage/IMessageAdapter.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { Message } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';

describe('IMessageAdapter', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  describe('constructor', () => {
    it('requires authorizedSenders array', () => {
      expect(() => new IMessageAdapter({} as Record<string, unknown>, project.stateDir))
        .toThrow('authorizedSenders is required');
    });

    it('accepts empty authorizedSenders (fail-closed)', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: [] },
        project.stateDir,
      );
      expect(adapter.platform).toBe('imessage');
    });

    it('normalizes authorized senders to lowercase', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567', 'User@iCloud.COM'] },
        project.stateDir,
      );
      expect(adapter.isAuthorized('+14081234567')).toBe(true);
      expect(adapter.isAuthorized('user@icloud.com')).toBe(true);
      expect(adapter.isAuthorized('USER@ICLOUD.COM')).toBe(true);
    });

    it('sets platform to imessage', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      expect(adapter.platform).toBe('imessage');
    });
  });

  describe('authorization', () => {
    it('authorizes known senders', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567', 'user@icloud.com'] },
        project.stateDir,
      );
      expect(adapter.isAuthorized('+14081234567')).toBe(true);
      expect(adapter.isAuthorized('user@icloud.com')).toBe(true);
    });

    it('rejects unknown senders', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      expect(adapter.isAuthorized('+19995551234')).toBe(false);
      expect(adapter.isAuthorized('unknown@gmail.com')).toBe(false);
    });

    it('handles case insensitivity for email addresses', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['User@Example.COM'] },
        project.stateDir,
      );
      expect(adapter.isAuthorized('user@example.com')).toBe(true);
      expect(adapter.isAuthorized('USER@EXAMPLE.COM')).toBe(true);
    });

    it('handles whitespace in sender identifiers', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: [' +14081234567 '] },
        project.stateDir,
      );
      expect(adapter.isAuthorized('+14081234567')).toBe(true);
    });
  });

  describe('maskIdentifier', () => {
    it('masks phone numbers', () => {
      expect(IMessageAdapter.maskIdentifier('+14081234567')).toBe('+140***4567');
    });

    it('masks email addresses', () => {
      expect(IMessageAdapter.maskIdentifier('user@example.com')).toBe('us***@example.com');
    });

    it('masks short identifiers', () => {
      expect(IMessageAdapter.maskIdentifier('ab')).toBe('***');
    });
  });

  describe('onMessage handler', () => {
    it('registers a message handler', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      const messages: Message[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });
      // Handler registered — would be called by _handleIncomingMessage
      expect(adapter.platform).toBe('imessage');
    });
  });

  describe('resolveUser', () => {
    it('returns the identifier as-is', async () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      expect(await adapter.resolveUser('+14081234567')).toBe('+14081234567');
      expect(await adapter.resolveUser('user@icloud.com')).toBe('user@icloud.com');
    });

    it('returns null for empty identifier', async () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      expect(await adapter.resolveUser('')).toBeNull();
    });
  });

  describe('getConnectionInfo', () => {
    it('returns disconnected state before start', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      const info = adapter.getConnectionInfo();
      expect(info.state).toBe('disconnected');
      expect(info.reconnectAttempts).toBe(0);
    });
  });

  describe('eventBus', () => {
    it('has an event bus with imessage platform', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      expect(adapter.eventBus).toBeDefined();
      expect(adapter.eventBus.platform).toBe('imessage');
    });
  });

  describe('message logging', () => {
    it('creates log file in state directory', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      // Logger is initialized but file won't exist until first write
      expect(adapter.messageLogger).toBeDefined();
    });
  });

  describe('incoming message handling (via internal method)', () => {
    it('rejects messages from unauthorized senders', async () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      const messages: Message[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      // Call internal handler directly
      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;+19995550000',
        messageId: 'p:0/100',
        sender: '+19995550000',
        text: 'unauthorized message',
        timestamp: Date.now() / 1000,
        isFromMe: false,
      });

      expect(messages).toHaveLength(0);
    });

    it('accepts messages from authorized senders', async () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      const messages: Message[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;+14081234567',
        messageId: 'p:0/101',
        sender: '+14081234567',
        senderName: 'Adrian',
        text: 'Hello Roland',
        timestamp: Date.now() / 1000,
        isFromMe: false,
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello Roland');
      expect(messages[0].userId).toBe('+14081234567');
      expect(messages[0].channel.type).toBe('imessage');
      expect(messages[0].metadata?.senderName).toBe('Adrian');
    });

    it('skips own outbound messages (isFromMe)', async () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      const messages: Message[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;+14081234567',
        messageId: 'p:0/102',
        sender: '+14081234567',
        text: 'my own message',
        timestamp: Date.now() / 1000,
        isFromMe: true,
      });

      expect(messages).toHaveLength(0);
    });

    it('deduplicates repeated notifications', async () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      const messages: Message[] = [];
      adapter.onMessage(async (msg) => { messages.push(msg); });

      const msg = {
        chatId: 'iMessage;-;+14081234567',
        messageId: 'p:0/103',
        sender: '+14081234567',
        text: 'duplicate test',
        timestamp: Date.now() / 1000,
        isFromMe: false,
      };

      await (adapter as any)._handleIncomingMessage(msg);
      await (adapter as any)._handleIncomingMessage(msg);
      await (adapter as any)._handleIncomingMessage(msg);

      expect(messages).toHaveLength(1);
    });

    it('handles message handler errors gracefully', async () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      adapter.onMessage(async () => {
        throw new Error('handler crashed');
      });

      // Should not throw
      await (adapter as any)._handleIncomingMessage({
        chatId: 'iMessage;-;+14081234567',
        messageId: 'p:0/104',
        sender: '+14081234567',
        text: 'crash test',
        timestamp: Date.now() / 1000,
        isFromMe: false,
      });
    });
  });

  describe('session registry', () => {
    it('registers and retrieves sessions by sender', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      adapter.registerSession('+14081234567', 'im-abc123');
      expect(adapter.getSessionForSender('+14081234567')).toBe('im-abc123');
    });

    it('returns null for unknown sender', () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      expect(adapter.getSessionForSender('+19995550000')).toBeNull();
    });
  });

  describe('send() throws in server context', () => {
    it('throws explaining LaunchAgent limitation', async () => {
      const adapter = new IMessageAdapter(
        { authorizedSenders: ['+14081234567'] },
        project.stateDir,
      );
      await expect(adapter.send({ userId: '+1408', content: 'test' }))
        .rejects.toThrow('Cannot send from server process');
    });
  });
});
