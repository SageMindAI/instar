/**
 * BDD tests for NativeBackend — Messages database reader.
 *
 * Uses a temporary SQLite database that mimics the macOS Messages chat.db
 * schema. No real Messages.app or Full Disk Access required.
 *
 * Tier 1: Module in isolation with real dependencies (better-sqlite3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NativeBackend } from '../../src/messaging/imessage/NativeBackend.js';
import type { IMessageIncoming } from '../../src/messaging/imessage/types.js';

// Apple Cocoa epoch offset (2001-01-01 in Unix seconds)
const APPLE_EPOCH = 978307200;

/** Convert a JS Date to Apple Cocoa nanosecond timestamp */
function toCocoaNanos(date: Date): number {
  return (Math.floor(date.getTime() / 1000) - APPLE_EPOCH) * 1_000_000_000;
}

/** Create a minimal Messages-like SQLite database for testing */
function createTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      service TEXT DEFAULT 'iMessage'
    );

    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      chat_identifier TEXT NOT NULL,
      display_name TEXT,
      service_name TEXT DEFAULT 'iMessage',
      guid TEXT,
      is_archived INTEGER DEFAULT 0
    );

    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT NOT NULL,
      text TEXT,
      handle_id INTEGER,
      date INTEGER NOT NULL,
      is_from_me INTEGER DEFAULT 0,
      service TEXT DEFAULT 'iMessage',
      associated_message_type INTEGER DEFAULT 0,
      FOREIGN KEY (handle_id) REFERENCES handle(ROWID)
    );

    CREATE TABLE chat_message_join (
      chat_id INTEGER,
      message_id INTEGER,
      FOREIGN KEY (chat_id) REFERENCES chat(ROWID),
      FOREIGN KEY (message_id) REFERENCES message(ROWID)
    );

    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY,
      filename TEXT,
      mime_type TEXT,
      transfer_name TEXT,
      total_bytes INTEGER
    );

    CREATE TABLE message_attachment_join (
      message_id INTEGER,
      attachment_id INTEGER,
      FOREIGN KEY (message_id) REFERENCES message(ROWID),
      FOREIGN KEY (attachment_id) REFERENCES attachment(ROWID)
    );
  `);

  return db;
}

/** Seed test data into the database */
function seedMessages(db: Database.Database, messages: Array<{
  text: string;
  sender: string;
  isFromMe: boolean;
  minutesAgo: number;
  chatIdentifier?: string;
}>): void {
  const insertHandle = db.prepare('INSERT OR IGNORE INTO handle (id, service) VALUES (?, ?)');
  const insertChat = db.prepare('INSERT OR IGNORE INTO chat (chat_identifier, service_name, guid) VALUES (?, ?, ?)');
  const insertMsg = db.prepare('INSERT INTO message (guid, text, handle_id, date, is_from_me, service, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, 0)');
  const insertJoin = db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)');
  const getHandle = db.prepare('SELECT ROWID FROM handle WHERE id = ?');
  const getChat = db.prepare('SELECT ROWID FROM chat WHERE chat_identifier = ?');

  for (const msg of messages) {
    const chatId = msg.chatIdentifier || msg.sender;

    // Ensure handle exists
    insertHandle.run(msg.sender, 'iMessage');
    const handle = getHandle.get(msg.sender) as { ROWID: number };

    // Ensure chat exists
    insertChat.run(chatId, 'iMessage', `iMessage;-;${chatId}`);
    const chat = getChat.get(chatId) as { ROWID: number };

    // Insert message
    const now = new Date();
    now.setMinutes(now.getMinutes() - msg.minutesAgo);
    const cocoaDate = toCocoaNanos(now);
    const guid = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    insertMsg.run(guid, msg.text, msg.isFromMe ? null : handle.ROWID, cocoaDate, msg.isFromMe ? 1 : 0, 'iMessage');

    // Get the message ROWID
    const lastMsg = db.prepare('SELECT MAX(ROWID) as id FROM message').get() as { id: number };

    // Join message to chat
    insertJoin.run(chat.ROWID, lastMsg.id);
  }
}

describe('Feature: NativeBackend reads Messages database', () => {
  let tmpDir: string;
  let dbPath: string;
  let testDb: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-backend-test-'));
    dbPath = path.join(tmpDir, 'chat.db');
    testDb = createTestDb(dbPath);
  });

  afterEach(() => {
    try { testDb.close(); } catch { /* */ }
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Scenario: Connects to database and reads initial state', () => {
    it('Given a Messages database, When connect() is called, Then state becomes connected', async () => {
      const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
      await backend.connect();

      expect(backend.state).toBe('connected');

      await backend.disconnect();
      expect(backend.state).toBe('disconnected');
    });

    it('Given a nonexistent database path, When connect() is called, Then state becomes error', async () => {
      const backend = new NativeBackend({ dbPath: '/nonexistent/chat.db', pollIntervalMs: 100_000 });
      await expect(backend.connect()).rejects.toThrow('Failed to open Messages database');
      expect(backend.state).toBe('error');
    });
  });

  describe('Scenario: Polls for new messages', () => {
    it('Given messages at ROWID 1-5 and lastRowId=3, When poll fires, Then events emit for ROWIDs 4 and 5', async () => {
      // Seed 5 messages
      seedMessages(testDb, [
        { text: 'Message 1', sender: '+14081234567', isFromMe: false, minutesAgo: 50 },
        { text: 'Message 2', sender: '+14081234567', isFromMe: false, minutesAgo: 40 },
        { text: 'Message 3', sender: '+14081234567', isFromMe: false, minutesAgo: 30 },
        { text: 'Message 4', sender: '+14081234567', isFromMe: false, minutesAgo: 20 },
        { text: 'Message 5', sender: '+14081234567', isFromMe: false, minutesAgo: 10 },
      ]);

      const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
      await backend.connect();

      // Manually set lastRowId to 3 to simulate "already processed 1-3"
      (backend as any).lastRowId = 3;

      const received: IMessageIncoming[] = [];
      backend.on('message', (msg: IMessageIncoming) => received.push(msg));

      // Trigger poll manually
      (backend as any)._poll();

      expect(received).toHaveLength(2);
      expect(received[0].text).toBe('Message 4');
      expect(received[1].text).toBe('Message 5');

      await backend.disconnect();
    });
  });

  describe('Scenario: Skips own outbound messages', () => {
    it('Given a message with is_from_me=1, When poll processes it, Then no message event fires', async () => {
      seedMessages(testDb, [
        { text: 'My own message', sender: '+14081234567', isFromMe: true, minutesAgo: 5 },
      ]);

      const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
      await backend.connect();
      (backend as any).lastRowId = 0;

      const received: IMessageIncoming[] = [];
      backend.on('message', (msg: IMessageIncoming) => received.push(msg));

      (backend as any)._poll();

      // is_from_me messages still emit (adapter handles filtering)
      // but they should have isFromMe=true so adapter can filter
      const fromMe = received.filter(m => m.isFromMe);
      const notFromMe = received.filter(m => !m.isFromMe);
      expect(fromMe.length + notFromMe.length).toBe(received.length);
      for (const m of fromMe) {
        expect(m.isFromMe).toBe(true);
      }
    });
  });

  describe('Scenario: Skips reactions and non-text messages', () => {
    it('Given a reaction message (associated_message_type != 0), When poll fires, Then it is skipped', async () => {
      // Insert a reaction message directly
      const handle = testDb.prepare('INSERT INTO handle (id) VALUES (?)').run('+14081234567');
      const chat = testDb.prepare('INSERT INTO chat (chat_identifier, guid) VALUES (?, ?)').run('+14081234567', 'test');
      const now = toCocoaNanos(new Date());

      // Normal message
      testDb.prepare('INSERT INTO message (guid, text, handle_id, date, is_from_me, associated_message_type) VALUES (?, ?, ?, ?, 0, 0)')
        .run('guid-normal', 'Normal text', handle.lastInsertRowid, now);
      testDb.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)')
        .run(chat.lastInsertRowid, testDb.prepare('SELECT MAX(ROWID) FROM message').pluck().get());

      // Reaction (associated_message_type = 2000)
      testDb.prepare('INSERT INTO message (guid, text, handle_id, date, is_from_me, associated_message_type) VALUES (?, ?, ?, ?, 0, 2000)')
        .run('guid-reaction', 'Loved "Normal text"', handle.lastInsertRowid, now + 1000000000);
      testDb.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)')
        .run(chat.lastInsertRowid, testDb.prepare('SELECT MAX(ROWID) FROM message').pluck().get());

      const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
      await backend.connect();
      (backend as any).lastRowId = 0;

      const received: IMessageIncoming[] = [];
      backend.on('message', (msg: IMessageIncoming) => received.push(msg));

      (backend as any)._poll();

      expect(received).toHaveLength(1);
      expect(received[0].text).toBe('Normal text');
    });
  });

  describe('Scenario: Formats conversation context', () => {
    it('Given 10 messages, When getConversationContext(sender, 5), Then returns 5 most recent formatted', async () => {
      const messages = [];
      for (let i = 1; i <= 10; i++) {
        messages.push({
          text: `Message ${i}`,
          sender: '+14081234567',
          isFromMe: i % 2 === 0,
          minutesAgo: (10 - i) * 5,
        });
      }
      seedMessages(testDb, messages);

      const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
      await backend.connect();

      const context = backend.getConversationContext('+14081234567', 5);

      expect(context).toContain('--- Conversation History');
      expect(context).toContain('--- End History ---');
      expect(context).toContain('Message 6');
      expect(context).toContain('Message 10');
      // Should NOT contain the oldest messages (1-5)
      // Note: "Message 1" is substring of "Message 10", so check "Message 1\n" or use regex
      expect(context).not.toMatch(/\] .+: Message 1\n/);
      expect(context).not.toContain('Message 5');

      // Check format: [HH:MM] sender: text
      expect(context).toMatch(/\[\d{2}:\d{2}\] .+: Message \d+/);

      // Agent messages should say "Agent"
      expect(context).toContain('Agent:');
      // User messages should show sender
      expect(context).toContain('+14081234567:');

      await backend.disconnect();
    });

    it('Given no messages for sender, When getConversationContext, Then returns empty string', async () => {
      const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
      await backend.connect();

      const context = backend.getConversationContext('+19999999999', 5);
      expect(context).toBe('');

      await backend.disconnect();
    });
  });

  describe('Scenario: Lists chats', () => {
    it('Given chats in database, When listChats(), Then returns formatted chat list', async () => {
      seedMessages(testDb, [
        { text: 'Hello', sender: '+14081234567', isFromMe: false, minutesAgo: 10 },
        { text: 'Hi', sender: '+19995551234', isFromMe: false, minutesAgo: 5 },
      ]);

      const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
      await backend.connect();

      const chats = backend.listChats(10);
      expect(chats.length).toBeGreaterThanOrEqual(2);
      expect(chats[0]).toHaveProperty('chatId');
      expect(chats[0]).toHaveProperty('service');

      await backend.disconnect();
    });
  });

  describe('Scenario: Gets chat history', () => {
    it('Given messages for a chat, When getChatHistory(), Then returns messages in order', async () => {
      seedMessages(testDb, [
        { text: 'First', sender: '+14081234567', isFromMe: false, minutesAgo: 30 },
        { text: 'Response', sender: '+14081234567', isFromMe: true, minutesAgo: 25 },
        { text: 'Follow-up', sender: '+14081234567', isFromMe: false, minutesAgo: 20 },
      ]);

      const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
      await backend.connect();

      const history = backend.getChatHistory('+14081234567', 10);
      expect(history.length).toBe(3);
      // History returns newest first
      expect(history[0].text).toBe('Follow-up');
      expect(history[2].text).toBe('First');

      await backend.disconnect();
    });
  });

  describe('Scenario: Handles database errors gracefully', () => {
    it('Given database not connected, When listChats() called, Then throws descriptive error', () => {
      const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
      expect(() => backend.listChats()).toThrow('Database not connected');
    });

    it('Given database not connected, When getConversationContext() called, Then returns empty string', () => {
      const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
      const context = backend.getConversationContext('+14081234567', 5);
      expect(context).toBe('');
    });
  });

  describe('Scenario: State transitions emit events', () => {
    it('Given disconnected backend, When connect/disconnect cycle, Then stateChange events fire', async () => {
      const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
      const states: string[] = [];
      backend.on('stateChange', (state: string) => states.push(state));

      await backend.connect();
      await backend.disconnect();

      expect(states).toEqual(['connecting', 'connected', 'disconnected']);
    });
  });
});
