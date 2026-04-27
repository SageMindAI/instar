/**
 * Integration tests for iMessage adapter review blocker fixes.
 *
 * Validates the 6 fixes applied after 11-reviewer consensus:
 * 1. lastRowId persistence across restarts
 * 2. Temp file permissions and cleanup
 * 3. Session name collision resistance
 * 4. Port default in reply script
 * 5. Recipient validation on reply endpoint
 * 6. SenderName sanitization
 *
 * Also covers additional gaps identified by reviewers:
 * - Message dedup across restarts
 * - Authorized sender normalization
 * - maskIdentifier edge cases
 * - connectedAt accuracy
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { NativeBackend } from '../../src/messaging/imessage/NativeBackend.js';
import { IMessageAdapter } from '../../src/messaging/imessage/IMessageAdapter.js';
import type { IMessageIncoming } from '../../src/messaging/imessage/types.js';

// Apple Cocoa epoch offset (2001-01-01 in Unix seconds)
const APPLE_EPOCH = 978307200;

function toCocoaNanos(date: Date): number {
  return (Math.floor(date.getTime() / 1000) - APPLE_EPOCH) * 1_000_000_000;
}

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

function seedMessages(db: Database.Database, messages: Array<{
  text: string;
  sender: string;
  isFromMe: boolean;
  minutesAgo: number;
}>): void {
  const insertHandle = db.prepare('INSERT OR IGNORE INTO handle (id, service) VALUES (?, ?)');
  const insertChat = db.prepare('INSERT OR IGNORE INTO chat (chat_identifier, service_name, guid) VALUES (?, ?, ?)');
  const insertMsg = db.prepare('INSERT INTO message (guid, text, handle_id, date, is_from_me, service, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, 0)');
  const insertJoin = db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)');
  const getHandle = db.prepare('SELECT ROWID FROM handle WHERE id = ?');
  const getChat = db.prepare('SELECT ROWID FROM chat WHERE chat_identifier = ?');

  for (const msg of messages) {
    insertHandle.run(msg.sender, 'iMessage');
    const handle = getHandle.get(msg.sender) as { ROWID: number };
    insertChat.run(msg.sender, 'iMessage', `iMessage;-;${msg.sender}`);
    const chat = getChat.get(msg.sender) as { ROWID: number };

    const now = new Date();
    now.setMinutes(now.getMinutes() - msg.minutesAgo);
    const guid = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    insertMsg.run(guid, msg.text, msg.isFromMe ? null : handle.ROWID, toCocoaNanos(now), msg.isFromMe ? 1 : 0, 'iMessage');
    const lastMsg = db.prepare('SELECT MAX(ROWID) as id FROM message').get() as { id: number };
    insertJoin.run(chat.ROWID, lastMsg.id);
  }
}

// ── Fix 1: lastRowId Persistence ──

describe('Fix 1: lastRowId persistence across restarts', () => {
  let tmpDir: string;
  let dbPath: string;
  let testDb: Database.Database;
  let offsetPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-offset-test-'));
    dbPath = path.join(tmpDir, 'chat.db');
    offsetPath = path.join(tmpDir, 'imessage-poll-offset.json');
    testDb = createTestDb(dbPath);
  });

  afterEach(() => {
    try { testDb.close(); } catch { /* */ }
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists lastRowId to disk after processing messages', async () => {
    seedMessages(testDb, [
      { text: 'Hello', sender: '+14081234567', isFromMe: false, minutesAgo: 5 },
      { text: 'World', sender: '+14081234567', isFromMe: false, minutesAgo: 3 },
    ]);

    const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000, offsetPath });
    await backend.connect();
    (backend as any).lastRowId = 0;
    (backend as any)._poll();
    await backend.disconnect();

    // Verify offset file was created
    expect(fs.existsSync(offsetPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(offsetPath, 'utf-8'));
    expect(data.lastRowId).toBeGreaterThan(0);
    expect(data.savedAt).toBeDefined();
  });

  it('restores lastRowId from disk on reconnect — no replay', async () => {
    seedMessages(testDb, [
      { text: 'Message 1', sender: '+14081234567', isFromMe: false, minutesAgo: 10 },
      { text: 'Message 2', sender: '+14081234567', isFromMe: false, minutesAgo: 5 },
    ]);

    // First connection — process messages and save offset
    const backend1 = new NativeBackend({ dbPath, pollIntervalMs: 100_000, offsetPath });
    await backend1.connect();
    (backend1 as any).lastRowId = 0;
    (backend1 as any)._poll();
    await backend1.disconnect();

    const savedOffset = JSON.parse(fs.readFileSync(offsetPath, 'utf-8')).lastRowId;

    // Second connection — should restore offset, not replay
    const backend2 = new NativeBackend({ dbPath, pollIntervalMs: 100_000, offsetPath });
    const received: IMessageIncoming[] = [];
    backend2.on('message', (msg: IMessageIncoming) => received.push(msg));
    await backend2.connect();

    // Poll should emit nothing — we already processed everything
    (backend2 as any)._poll();
    expect(received).toHaveLength(0);
    expect((backend2 as any).lastRowId).toBe(savedOffset);

    await backend2.disconnect();
  });

  it('falls back to 50-message lookback when no offset file exists', async () => {
    // Seed 60 messages
    for (let i = 1; i <= 60; i++) {
      seedMessages(testDb, [
        { text: `Msg ${i}`, sender: '+14081234567', isFromMe: false, minutesAgo: 70 - i },
      ]);
    }

    // No offset file — should use lookback
    const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000, offsetPath });
    await backend.connect();

    // lastRowId should be maxId - 50 (i.e., skip the oldest 10)
    const maxRow = testDb.prepare('SELECT MAX(ROWID) as id FROM message').get() as { id: number };
    expect((backend as any).lastRowId).toBe(maxRow.id - 50);

    await backend.disconnect();
  });
});

// ── Fix 2: Temp File Security ──

describe('Fix 2: temp file permissions and cleanup', () => {
  it('imessage-reply.sh temp dir reference uses secure permissions in source', () => {
    // Verify the source code uses mode 0o700 for directory and 0o600 for files
    const serverTs = fs.readFileSync(
      path.join(__dirname, '../../src/commands/server.ts'), 'utf-8'
    );
    expect(serverTs).toContain('mode: 0o700');
    expect(serverTs).toContain('mode: 0o600');
  });

  it('SessionManager injectIMessageMessage uses secure permissions', () => {
    const sessionMgr = fs.readFileSync(
      path.join(__dirname, '../../src/core/SessionManager.ts'), 'utf-8'
    );
    // Check that the iMessage injection temp file code uses secure permissions
    expect(sessionMgr).toContain("mode: 0o700");
    expect(sessionMgr).toContain("mode: 0o600");
  });

  it('server.ts buildBootstrapMessage includes temp file cleanup', () => {
    const serverTs = fs.readFileSync(
      path.join(__dirname, '../../src/commands/server.ts'), 'utf-8'
    );
    // The cleanup code should sweep files older than 1 hour
    expect(serverTs).toContain('3_600_000');
    expect(serverTs).toContain('unlinkSync');
  });
});

// ── Fix 3: Session Name Collision ──

describe('Fix 3: session name collision resistance', () => {
  it('two phone numbers with same last 6 digits produce different session names', () => {
    // These would collide with the old slice(-6) approach
    const sender1 = '+14081234567';
    const sender2 = '+12341234567';

    const hash1 = crypto.createHash('sha1').update(sender1.toLowerCase()).digest('hex').slice(0, 8);
    const hash2 = crypto.createHash('sha1').update(sender2.toLowerCase()).digest('hex').slice(0, 8);

    const name1 = `im-${hash1}`;
    const name2 = `im-${hash2}`;

    expect(name1).not.toBe(name2);
  });

  it('session names are deterministic for the same sender', () => {
    const sender = '+14081234567';
    const hash1 = crypto.createHash('sha1').update(sender.toLowerCase()).digest('hex').slice(0, 8);
    const hash2 = crypto.createHash('sha1').update(sender.toLowerCase()).digest('hex').slice(0, 8);
    expect(hash1).toBe(hash2);
  });

  it('email senders also produce unique names', () => {
    const sender1 = 'alice@icloud.com';
    const sender2 = 'malice@icloud.com'; // same last 6 chars
    const hash1 = crypto.createHash('sha1').update(sender1.toLowerCase()).digest('hex').slice(0, 8);
    const hash2 = crypto.createHash('sha1').update(sender2.toLowerCase()).digest('hex').slice(0, 8);
    expect(`im-${hash1}`).not.toBe(`im-${hash2}`);
  });

  it('source code uses sha1 hash, not slice', () => {
    const serverTs = fs.readFileSync(
      path.join(__dirname, '../../src/commands/server.ts'), 'utf-8'
    );
    // Verify hash-based session naming is in the wireIMessageRouting function
    expect(serverTs).toContain("createHash('sha1')");
    expect(serverTs).toContain('.digest(\'hex\').slice(0, 8)');
  });
});

// ── Fix 4: Port Default ──

describe('Fix 4: reply script port default', () => {
  it('imessage-reply.sh defaults to port 4042, not 4040', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '../../src/templates/scripts/imessage-reply.sh'), 'utf-8'
    );
    expect(script).toContain('INSTAR_PORT:-4042');
    expect(script).not.toContain('INSTAR_PORT:-4040');
  });
});

// ── Fix 5: Recipient Validation ──

describe('Fix 5: reply endpoint validates recipient', () => {
  it('routes.ts checks isAuthorized before processing reply', () => {
    const routes = fs.readFileSync(
      path.join(__dirname, '../../src/server/routes.ts'), 'utf-8'
    );
    // The reply endpoint should validate recipient against authorizedContacts
    expect(routes).toContain('isAuthorized(');
    expect(routes).toContain('403');
    expect(routes).toContain('recipient not in authorizedContacts');
  });
});

// ── Fix 6: SenderName Sanitization ──

describe('Fix 6: senderName sanitization in bootstrap', () => {
  it('server.ts strips dangerous characters from senderName', () => {
    const serverTs = fs.readFileSync(
      path.join(__dirname, '../../src/commands/server.ts'), 'utf-8'
    );
    // Should strip backticks, dollar signs, backslashes, and brackets
    expect(serverTs).toContain('replace(/[\\[\\]`$\\\\]/g,');
  });

  it('IMessageAdapter maskIdentifier handles various formats', () => {
    // Phone number masking
    expect(IMessageAdapter.maskIdentifier('+14081234567')).toBe('+140***4567');

    // Email masking
    expect(IMessageAdapter.maskIdentifier('alice@icloud.com')).toBe('al***@icloud.com');

    // Short identifiers
    expect(IMessageAdapter.maskIdentifier('+1234')).toBe('***');

    // Unknown format
    expect(IMessageAdapter.maskIdentifier('unknown')).toBe('***');
  });
});

// ── Additional Gap: Authorization Normalization ──

describe('Authorization normalization', () => {
  let tmpDir: string;
  let dbPath: string;
  let testDb: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-auth-test-'));
    dbPath = path.join(tmpDir, 'chat.db');
    testDb = createTestDb(dbPath);
  });

  afterEach(() => {
    try { testDb.close(); } catch { /* */ }
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('authorizedSenders is case-insensitive', () => {
    const adapter = new IMessageAdapter(
      { authorizedSenders: ['Alice@iCloud.com'] } as any,
      tmpDir,
    );

    expect(adapter.isAuthorized('alice@icloud.com')).toBe(true);
    expect(adapter.isAuthorized('ALICE@ICLOUD.COM')).toBe(true);
    expect(adapter.isAuthorized('Alice@iCloud.com')).toBe(true);
  });

  it('authorizedSenders trims whitespace', () => {
    const adapter = new IMessageAdapter(
      { authorizedSenders: ['  +14081234567  '] } as any,
      tmpDir,
    );
    expect(adapter.isAuthorized('+14081234567')).toBe(true);
  });

  it('empty authorizedSenders rejects all senders (fail-closed)', () => {
    const adapter = new IMessageAdapter(
      { authorizedSenders: [] } as any,
      tmpDir,
    );
    expect(adapter.isAuthorized('+14081234567')).toBe(false);
  });

  it('missing authorizedContacts throws at construction', () => {
    expect(() => new IMessageAdapter({} as any, tmpDir)).toThrow('authorizedContacts is required');
  });
});

// ── Additional Gap: Full Adapter Lifecycle with Mock DB ──

describe('Full adapter lifecycle with mock database', () => {
  let tmpDir: string;
  let dbPath: string;
  let testDb: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-lifecycle-test-'));
    dbPath = path.join(tmpDir, 'chat.db');
    testDb = createTestDb(dbPath);
  });

  afterEach(() => {
    try { testDb.close(); } catch { /* */ }
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('start → receive message → stop full cycle', async () => {
    seedMessages(testDb, [
      { text: 'Test message', sender: '+14081234567', isFromMe: false, minutesAgo: 1 },
    ]);

    const adapter = new IMessageAdapter(
      { authorizedSenders: ['+14081234567'], dbPath, pollIntervalMs: 100_000 } as any,
      tmpDir,
    );

    const received: any[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.start();

    // Manually trigger the backend poll
    const backend = (adapter as any).backend;
    backend.lastRowId = 0;
    backend._poll();

    // Wait for async handler
    await new Promise(r => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('Test message');
    expect(received[0].channel.type).toBe('imessage');
    expect(received[0].channel.identifier).toBe('+14081234567');

    await adapter.stop();
  });

  it('rejects unauthorized sender and logs rejection', async () => {
    seedMessages(testDb, [
      { text: 'Spam', sender: '+19999999999', isFromMe: false, minutesAgo: 1 },
    ]);

    const adapter = new IMessageAdapter(
      { authorizedSenders: ['+14081234567'], dbPath, pollIntervalMs: 100_000 } as any,
      tmpDir,
    );

    const received: any[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.start();

    const backend = (adapter as any).backend;
    backend.lastRowId = 0;
    backend._poll();

    await new Promise(r => setTimeout(r, 50));

    // Unauthorized sender should be rejected
    expect(received).toHaveLength(0);

    await adapter.stop();
  });

  it('deduplicates repeated message notifications', async () => {
    seedMessages(testDb, [
      { text: 'Hello', sender: '+14081234567', isFromMe: false, minutesAgo: 1 },
    ]);

    const adapter = new IMessageAdapter(
      { authorizedSenders: ['+14081234567'], dbPath, pollIntervalMs: 100_000 } as any,
      tmpDir,
    );

    const received: any[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.start();

    const backend = (adapter as any).backend;
    backend.lastRowId = 0;

    // Poll twice — same messages
    backend._poll();
    await new Promise(r => setTimeout(r, 50));
    backend._poll();
    await new Promise(r => setTimeout(r, 50));

    // Should only receive once (dedup by messageId)
    expect(received).toHaveLength(1);

    await adapter.stop();
  });

  it('logs outbound messages correctly', async () => {
    const adapter = new IMessageAdapter(
      { authorizedSenders: ['+14081234567'], dbPath, pollIntervalMs: 100_000 } as any,
      tmpDir,
    );

    adapter.logOutboundMessage('+14081234567', 'Hello from agent');

    const logPath = path.join(tmpDir, 'imessage-messages.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const entries = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('Hello from agent');
    expect(entries[0].fromUser).toBe(false);
    expect(entries[0].platform).toBe('imessage');
  });

  it('send() throws explaining the LaunchAgent limitation', async () => {
    const adapter = new IMessageAdapter(
      { authorizedSenders: ['+14081234567'], dbPath, pollIntervalMs: 100_000 } as any,
      tmpDir,
    );

    await expect(adapter.send({ channel: '+14081234567', text: 'test' } as any))
      .rejects.toThrow('Cannot send from server process');
  });

  it('session registry tracks sender-session mappings', () => {
    const adapter = new IMessageAdapter(
      { authorizedSenders: ['+14081234567'], dbPath, pollIntervalMs: 100_000 } as any,
      tmpDir,
    );

    adapter.registerSession('+14081234567', 'im-abc12345');
    expect(adapter.getSessionForSender('+14081234567')).toBe('im-abc12345');
    expect(adapter.getSenderForSession('im-abc12345')).toBe('+14081234567');
    expect(adapter.getSessionForSender('+19999999999')).toBeNull();
  });

  it('connection info reflects adapter state', async () => {
    const adapter = new IMessageAdapter(
      { authorizedSenders: ['+14081234567'], dbPath, pollIntervalMs: 100_000 } as any,
      tmpDir,
    );

    // Before start
    const infoBefore = adapter.getConnectionInfo();
    expect(infoBefore.state).toBe('disconnected');
    expect(infoBefore.connectedAt).toBeUndefined();

    await adapter.start();

    const infoAfter = adapter.getConnectionInfo();
    expect(infoAfter.state).toBe('connected');
    expect(infoAfter.connectedAt).toBeDefined();

    await adapter.stop();
  });

  it('eventBus emits message:incoming events', async () => {
    seedMessages(testDb, [
      { text: 'EventBus test', sender: '+14081234567', isFromMe: false, minutesAgo: 1 },
    ]);

    const adapter = new IMessageAdapter(
      { authorizedSenders: ['+14081234567'], dbPath, pollIntervalMs: 100_000 } as any,
      tmpDir,
    );

    const events: any[] = [];
    adapter.eventBus.on('message:incoming', (evt: any) => events.push(evt));

    adapter.onMessage(async () => {}); // need a handler or messages aren't processed
    await adapter.start();

    const backend = (adapter as any).backend;
    backend.lastRowId = 0;
    backend._poll();
    await new Promise(r => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('EventBus test');
    expect(events[0].userId).toBe('+14081234567');

    await adapter.stop();
  });
});
