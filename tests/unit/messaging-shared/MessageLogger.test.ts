import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageLogger, type LogEntry } from '../../../src/messaging/shared/MessageLogger.js';

describe('MessageLogger', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-msglogger-'));
    logPath = path.join(tmpDir, 'messages.jsonl');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createLogger(overrides?: Partial<Parameters<typeof MessageLogger.prototype.append>[0]>) {
    return new MessageLogger({ logPath });
  }

  function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
    return {
      messageId: 1,
      channelId: '100',
      text: 'hello world',
      fromUser: true,
      timestamp: new Date().toISOString(),
      sessionName: 'test-session',
      ...overrides,
    };
  }

  // ── Core append/read ──────────────────────────────────────

  it('appends entries to JSONL file', () => {
    const logger = createLogger();
    logger.append(makeEntry({ text: 'first' }));
    logger.append(makeEntry({ text: 'second' }));

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).text).toBe('first');
    expect(JSON.parse(lines[1]).text).toBe('second');
  });

  it('creates parent directory if missing', () => {
    const deepPath = path.join(tmpDir, 'nested', 'deep', 'messages.jsonl');
    const logger = new MessageLogger({ logPath: deepPath });
    logger.append(makeEntry());
    expect(fs.existsSync(deepPath)).toBe(true);
  });

  // ── Search ──────────────────────────────────────────────

  it('searches by text query', () => {
    const logger = createLogger();
    logger.append(makeEntry({ text: 'hello world' }));
    logger.append(makeEntry({ text: 'goodbye world' }));
    logger.append(makeEntry({ text: 'hello again' }));

    const results = logger.search({ query: 'hello' });
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('hello world');
    expect(results[1].text).toBe('hello again');
  });

  it('searches by channelId', () => {
    const logger = createLogger();
    logger.append(makeEntry({ channelId: '100', text: 'in 100' }));
    logger.append(makeEntry({ channelId: '200', text: 'in 200' }));
    logger.append(makeEntry({ channelId: '100', text: 'also in 100' }));

    const results = logger.search({ channelId: '100' });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.channelId === '100')).toBe(true);
  });

  it('searches by date range', () => {
    const logger = createLogger();
    const old = new Date('2026-01-01').toISOString();
    const recent = new Date('2026-03-01').toISOString();

    logger.append(makeEntry({ text: 'old', timestamp: old }));
    logger.append(makeEntry({ text: 'recent', timestamp: recent }));

    const results = logger.search({ since: new Date('2026-02-01') });
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('recent');
  });

  it('respects search limit', () => {
    const logger = createLogger();
    for (let i = 0; i < 10; i++) {
      logger.append(makeEntry({ text: `msg-${i}` }));
    }

    const results = logger.search({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('returns results in chronological order', () => {
    const logger = createLogger();
    logger.append(makeEntry({ text: 'first', timestamp: '2026-01-01T00:00:00Z' }));
    logger.append(makeEntry({ text: 'second', timestamp: '2026-01-02T00:00:00Z' }));
    logger.append(makeEntry({ text: 'third', timestamp: '2026-01-03T00:00:00Z' }));

    const results = logger.search({});
    expect(results[0].text).toBe('first');
    expect(results[2].text).toBe('third');
  });

  it('returns empty array when log file does not exist', () => {
    const logger = new MessageLogger({ logPath: path.join(tmpDir, 'nonexistent.jsonl') });
    expect(logger.search({})).toEqual([]);
    expect(logger.getChannelHistory('100')).toEqual([]);
    expect(logger.getRecent()).toEqual([]);
  });

  // ── Channel history ──────────────────────────────────────

  it('returns channel-specific history', () => {
    const logger = createLogger();
    logger.append(makeEntry({ channelId: '100', text: 'a' }));
    logger.append(makeEntry({ channelId: '200', text: 'b' }));
    logger.append(makeEntry({ channelId: '100', text: 'c' }));

    const history = logger.getChannelHistory('100');
    expect(history).toHaveLength(2);
    expect(history[0].text).toBe('a');
    expect(history[1].text).toBe('c');
  });

  it('respects channel history limit', () => {
    const logger = createLogger();
    for (let i = 0; i < 30; i++) {
      logger.append(makeEntry({ channelId: '100', text: `msg-${i}` }));
    }

    const history = logger.getChannelHistory('100', 5);
    expect(history).toHaveLength(5);
    // Should be the most recent 5
    expect(history[4].text).toBe('msg-29');
  });

  // ── Recent entries ──────────────────────────────────────

  it('returns recent entries', () => {
    const logger = createLogger();
    for (let i = 0; i < 5; i++) {
      logger.append(makeEntry({ text: `msg-${i}` }));
    }

    const recent = logger.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].text).toBe('msg-2');
    expect(recent[2].text).toBe('msg-4');
  });

  // ── Stats ──────────────────────────────────────────────

  it('returns correct stats', () => {
    const logger = createLogger();
    logger.append(makeEntry({ text: 'one' }));
    logger.append(makeEntry({ text: 'two' }));

    const stats = logger.getStats();
    expect(stats.totalMessages).toBe(2);
    expect(stats.logSizeBytes).toBeGreaterThan(0);
    expect(stats.logPath).toBe(logPath);
  });

  it('returns zero stats when log does not exist', () => {
    const logger = new MessageLogger({ logPath: path.join(tmpDir, 'nope.jsonl') });
    const stats = logger.getStats();
    expect(stats.totalMessages).toBe(0);
    expect(stats.logSizeBytes).toBe(0);
  });

  // ── Log rotation ──────────────────────────────────────

  it('rotates log when exceeding maxLines and size threshold', () => {
    const logger = new MessageLogger({
      logPath,
      maxLines: 10,
      keepLines: 5,
      rotationSizeThreshold: 0, // Always check line count
    });

    // Write 11 entries to trigger rotation (> maxLines)
    for (let i = 0; i < 11; i++) {
      logger.append(makeEntry({ text: `msg-${i}` }));
    }

    // After rotation at entry 11, we keep last 5 (msg-6..msg-10)
    const stats = logger.getStats();
    expect(stats.totalMessages).toBe(5);

    const recent = logger.getRecent(10);
    expect(recent).toHaveLength(5);
    expect(recent[0].text).toBe('msg-6');
    expect(recent[4].text).toBe('msg-10');
  });

  // ── Callback ──────────────────────────────────────────

  it('fires onMessageLogged callback', () => {
    const logger = createLogger();
    const entries: LogEntry[] = [];
    logger.setOnMessageLogged(entry => entries.push(entry));

    logger.append(makeEntry({ text: 'hello' }));
    logger.append(makeEntry({ text: 'world' }));

    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('hello');
  });

  it('handles callback errors gracefully', () => {
    const logger = createLogger();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.setOnMessageLogged(() => { throw new Error('callback boom'); });
    logger.append(makeEntry({ text: 'hello' }));

    // Should not throw, entry still written
    const stats = logger.getStats();
    expect(stats.totalMessages).toBe(1);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  // ── Legacy compatibility ──────────────────────────────────

  it('reads legacy topicId entries during search', () => {
    const logger = createLogger();
    // Write a legacy-format entry directly
    fs.writeFileSync(logPath, JSON.stringify({
      messageId: 1,
      topicId: 42,  // legacy field
      text: 'legacy message',
      fromUser: true,
      timestamp: new Date().toISOString(),
      sessionName: null,
    }) + '\n');

    const results = logger.search({ channelId: 42 });
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('legacy message');
  });

  it('returns legacy entries in channel history', () => {
    const logger = createLogger();
    fs.writeFileSync(logPath, JSON.stringify({
      messageId: 1,
      topicId: 42,
      text: 'legacy topic message',
      fromUser: true,
      timestamp: new Date().toISOString(),
      sessionName: null,
    }) + '\n');

    const history = logger.getChannelHistory('42');
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe('legacy topic message');
  });
});
