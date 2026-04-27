import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  appendDroppedMessage,
  readDroppedMessages,
  type DroppedMessageRecord,
} from '../../../src/lifeline/droppedMessages.js';

describe('droppedMessages', () => {
  let stateDir: string;
  let targetPath: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropped-msg-test-'));
    targetPath = path.join(stateDir, 'state', 'dropped-messages.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const sample = (overrides: Partial<DroppedMessageRecord> = {}): Omit<DroppedMessageRecord, 'timestamp'> => ({
    topicId: 123,
    messageId: 'tg-456',
    senderName: 'Justin',
    textPreview: 'hi bob',
    retryCount: 3,
    reason: 'server returned 500',
    ...overrides,
  });

  it('creates the file and writes a record on first append', () => {
    appendDroppedMessage(stateDir, sample());
    const records = readDroppedMessages(stateDir);
    expect(records).toHaveLength(1);
    expect(records[0].messageId).toBe('tg-456');
    expect(records[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves prior records when appending', () => {
    appendDroppedMessage(stateDir, sample({ messageId: 'tg-1' }));
    appendDroppedMessage(stateDir, sample({ messageId: 'tg-2' }));
    appendDroppedMessage(stateDir, sample({ messageId: 'tg-3' }));
    const records = readDroppedMessages(stateDir);
    expect(records.map(r => r.messageId)).toEqual(['tg-1', 'tg-2', 'tg-3']);
  });

  it('writes atomically via tmp + rename', () => {
    appendDroppedMessage(stateDir, sample());
    // No leftover tmp files in the state dir
    const stateSub = path.join(stateDir, 'state');
    const entries = fs.readdirSync(stateSub);
    expect(entries.filter(e => e.endsWith('.tmp') || e.includes('.tmp.'))).toHaveLength(0);
  });

  it('leaves the main file unchanged when rename fails mid-write', () => {
    appendDroppedMessage(stateDir, sample({ messageId: 'tg-original' }));
    const before = fs.readFileSync(targetPath, 'utf-8');

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated rename failure');
    });

    expect(() => appendDroppedMessage(stateDir, sample({ messageId: 'tg-should-not-appear' }))).toThrow('simulated rename failure');

    renameSpy.mockRestore();

    const after = fs.readFileSync(targetPath, 'utf-8');
    expect(after).toBe(before);
    const records = readDroppedMessages(stateDir);
    expect(records).toHaveLength(1);
    expect(records[0].messageId).toBe('tg-original');
  });

  it('readDroppedMessages returns [] when the file does not exist', () => {
    expect(readDroppedMessages(stateDir)).toEqual([]);
  });

  it('readDroppedMessages returns [] when the file is corrupt (does not throw)', () => {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(targetPath, '{{not valid json');
    expect(readDroppedMessages(stateDir)).toEqual([]);
  });

  it('truncates preview text to 200 chars', () => {
    const longText = 'x'.repeat(500);
    appendDroppedMessage(stateDir, sample({ textPreview: longText }));
    const records = readDroppedMessages(stateDir);
    expect(records[0].textPreview.length).toBeLessThanOrEqual(200);
  });

  it('caps stored history at 500 records (ring buffer)', () => {
    for (let i = 0; i < 550; i++) {
      appendDroppedMessage(stateDir, sample({ messageId: `tg-${i}` }));
    }
    const records = readDroppedMessages(stateDir);
    expect(records.length).toBeLessThanOrEqual(500);
    // Oldest were dropped; newest preserved
    expect(records[records.length - 1].messageId).toBe('tg-549');
  });
});
