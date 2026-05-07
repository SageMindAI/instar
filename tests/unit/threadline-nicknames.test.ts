/**
 * Tests for threadline nickname infrastructure:
 *   - ThreadlineNicknames: persistence, source tracking, cache invalidation
 *   - ThreadlineNicknameSuggester: candidate selection, prompt sanitization,
 *     idempotency, and respect for user/registry overrides.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ThreadlineNicknames } from '../../src/threadline/ThreadlineNicknames.js';
import { ThreadlineNicknameSuggester } from '../../src/threadline/ThreadlineNicknameSuggester.js';
import { ThreadlineObservability } from '../../src/threadline/ThreadlineObservability.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-nick-test-'));
  return {
    dir,
    cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline-nicknames.test.ts' }),
  };
}

function writeInbox(stateDir: string, lines: object[]): void {
  const dir = path.join(stateDir, 'threadline');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'inbox.jsonl.active'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function writeOutbox(stateDir: string, lines: object[]): void {
  const dir = path.join(stateDir, 'threadline');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'outbox.jsonl.active'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

class StubIntelligence implements IntelligenceProvider {
  public calls: { prompt: string; options?: IntelligenceOptions }[] = [];
  constructor(private readonly responder: (prompt: string) => string | Promise<string>) {}
  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    this.calls.push({ prompt, options });
    return await this.responder(prompt);
  }
}

describe('ThreadlineNicknames', () => {
  let scratch: { dir: string; cleanup: () => void };
  beforeEach(() => { scratch = createTempDir(); });
  afterEach(() => scratch.cleanup());

  it('returns null for unknown fingerprints', () => {
    const store = new ThreadlineNicknames({ stateDir: scratch.dir });
    expect(store.get('deadbeef')).toBeNull();
  });

  it('persists a nickname and surfaces source + updatedAt', () => {
    const store = new ThreadlineNicknames({ stateDir: scratch.dir });
    const entry = store.set('fp123', 'Dawn', 'user');
    expect(entry).not.toBeNull();
    expect(entry!.nickname).toBe('Dawn');
    expect(entry!.source).toBe('user');
    expect(typeof entry!.updatedAt).toBe('string');

    const onDisk = JSON.parse(fs.readFileSync(path.join(scratch.dir, 'threadline', 'nicknames.json'), 'utf-8'));
    expect(onDisk.nicknames.fp123.nickname).toBe('Dawn');
    expect(onDisk.nicknames.fp123.source).toBe('user');
  });

  it('clears the nickname when set to whitespace', () => {
    const store = new ThreadlineNicknames({ stateDir: scratch.dir });
    store.set('fp', 'Dawn');
    expect(store.set('fp', '   ')).toBeNull();
    expect(store.get('fp')).toBeNull();
  });

  it('rejects nicknames longer than 64 chars', () => {
    const store = new ThreadlineNicknames({ stateDir: scratch.dir });
    expect(() => store.set('fp', 'x'.repeat(65))).toThrow(/too long/);
  });

  it('reads back what another instance wrote (no exclusive cache)', () => {
    const writer = new ThreadlineNicknames({ stateDir: scratch.dir });
    writer.set('fp', 'Sage', 'haiku');
    const reader = new ThreadlineNicknames({ stateDir: scratch.dir });
    const entry = reader.get('fp');
    expect(entry?.nickname).toBe('Sage');
    expect(entry?.source).toBe('haiku');
  });

  it('survives a corrupt file by starting empty', () => {
    fs.mkdirSync(path.join(scratch.dir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(scratch.dir, 'threadline', 'nicknames.json'), '{not json');
    const store = new ThreadlineNicknames({ stateDir: scratch.dir });
    expect(store.get('fp')).toBeNull();
    // Writes should still succeed (overwriting the corrupt file)
    store.set('fp', 'Sage');
    expect(store.get('fp')?.nickname).toBe('Sage');
  });

  it('invalidate() forces a re-read from disk after an external write', () => {
    const reader = new ThreadlineNicknames({ stateDir: scratch.dir });
    expect(reader.get('fp')).toBeNull(); // primes the empty cache
    // Simulate another process writing the file directly
    const file = path.join(scratch.dir, 'threadline', 'nicknames.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      nicknames: { fp: { nickname: 'X', source: 'user', updatedAt: new Date().toISOString() } },
    }));
    expect(reader.get('fp')).toBeNull(); // still cached
    reader.invalidate();
    expect(reader.get('fp')?.nickname).toBe('X');
  });
});

describe('ThreadlineNicknameSuggester', () => {
  let scratch: { dir: string; cleanup: () => void };
  let observability: ThreadlineObservability;
  let nicknames: ThreadlineNicknames;

  beforeEach(() => {
    scratch = createTempDir();
    nicknames = new ThreadlineNicknames({ stateDir: scratch.dir });
    observability = new ThreadlineObservability({ stateDir: scratch.dir, nicknames });
  });
  afterEach(() => scratch.cleanup());

  function seedConversation(fingerprint: string, transcript: { dir: 'in' | 'out'; text: string }[]): void {
    const inbox: object[] = [];
    const outbox: object[] = [];
    const threadId = `thread-${fingerprint.slice(0, 6)}`;
    let t = Date.parse('2026-05-01T00:00:00Z');
    for (const m of transcript) {
      const ts = new Date(t).toISOString();
      t += 60_000;
      if (m.dir === 'in') {
        inbox.push({ id: `i-${t}`, threadId, timestamp: ts, from: fingerprint, text: m.text, trustLevel: 'verified' });
      } else {
        outbox.push({ id: `o-${t}`, threadId, timestamp: ts, to: fingerprint, text: m.text, outcome: 'relay-sent' });
      }
    }
    writeInbox(scratch.dir, inbox);
    writeOutbox(scratch.dir, outbox);
  }

  it('returns no-op result when no intelligence provider is wired', async () => {
    const suggester = new ThreadlineNicknameSuggester({ observability, nicknames, intelligence: null });
    expect(suggester.isAvailable()).toBe(false);
    const r = await suggester.run();
    expect(r.applied).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/no intelligence/i);
  });

  it('skips agents that already have a nickname', async () => {
    const fp = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    seedConversation(fp, [{ dir: 'in', text: 'Hi from Dawn' }, { dir: 'out', text: 'Hey Dawn' }]);
    nicknames.set(fp, 'Dawn', 'user');
    const intel = new StubIntelligence(() => 'ShouldNotBeUsed');
    const suggester = new ThreadlineNicknameSuggester({ observability, nicknames, intelligence: intel });
    const r = await suggester.run();
    expect(r.applied).toEqual([]);
    expect(intel.calls).toHaveLength(0);
    expect(nicknames.get(fp)?.nickname).toBe('Dawn'); // unchanged
  });

  it('names a fingerprint-only agent based on Haiku response', async () => {
    const fp = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    seedConversation(fp, [
      { dir: 'in', text: 'Hi — I run the PR pipeline' },
      { dir: 'out', text: 'Thanks, can you re-run the latest one?' },
    ]);
    const intel = new StubIntelligence(() => 'PR Bot');
    const suggester = new ThreadlineNicknameSuggester({ observability, nicknames, intelligence: intel });
    const r = await suggester.run();
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0]!.nickname).toBe('PR Bot');
    expect(nicknames.get(fp)?.nickname).toBe('PR Bot');
    expect(nicknames.get(fp)?.source).toBe('haiku');
  });

  it('honors dryRun by not persisting', async () => {
    const fp = 'cccccccccccccccccccccccccccccccc';
    seedConversation(fp, [
      { dir: 'in', text: 'Let me research that' },
      { dir: 'out', text: 'thanks' },
    ]);
    const intel = new StubIntelligence(() => 'Sage');
    const suggester = new ThreadlineNicknameSuggester({ observability, nicknames, intelligence: intel });
    const r = await suggester.run({ dryRun: true });
    expect(r.applied[0]!.nickname).toBe('Sage');
    expect(nicknames.get(fp)).toBeNull();
  });

  it('sanitizes prefixed/quoted Haiku output', async () => {
    const fp = 'dddddddddddddddddddddddddddddddd';
    seedConversation(fp, [
      { dir: 'in', text: 'one' },
      { dir: 'out', text: 'two' },
    ]);
    const intel = new StubIntelligence(() => 'Display name: "Compass"\n\nThe agent helps navigate things.');
    const suggester = new ThreadlineNicknameSuggester({ observability, nicknames, intelligence: intel });
    const r = await suggester.run();
    expect(r.applied[0]!.nickname).toBe('Compass');
  });

  it('treats "Unnamed" response as unusable', async () => {
    const fp = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    seedConversation(fp, [
      { dir: 'in', text: 'one' },
      { dir: 'out', text: 'two' },
    ]);
    const intel = new StubIntelligence(() => 'Unnamed');
    const suggester = new ThreadlineNicknameSuggester({ observability, nicknames, intelligence: intel });
    const r = await suggester.run();
    expect(r.applied).toHaveLength(0);
    expect(r.skipped[0]?.reason).toMatch(/no usable name/);
  });

  it('caps how many agents it names per run', async () => {
    const fps = ['11111111111111111111111111111111', '22222222222222222222222222222222', '33333333333333333333333333333333'];
    // Seed all three threads in the same inbox/outbox files
    const inbox: object[] = [];
    const outbox: object[] = [];
    let t = Date.parse('2026-05-01T00:00:00Z');
    for (const fp of fps) {
      const tid = `thread-${fp.slice(0, 6)}`;
      inbox.push({ id: `i-${t}`, threadId: tid, timestamp: new Date(t).toISOString(), from: fp, text: 'hello', trustLevel: 'verified' });
      t += 60_000;
      outbox.push({ id: `o-${t}`, threadId: tid, timestamp: new Date(t).toISOString(), to: fp, text: 'hi', outcome: 'relay-sent' });
      t += 60_000;
    }
    writeInbox(scratch.dir, inbox);
    writeOutbox(scratch.dir, outbox);

    const intel = new StubIntelligence(() => 'Friend');
    const suggester = new ThreadlineNicknameSuggester({
      observability, nicknames, intelligence: intel,
      maxPerRun: 2,
    });
    const r = await suggester.run();
    expect(r.applied).toHaveLength(2);
    expect(r.skipped.some(s => s.reason.includes('cap reached'))).toBe(true);
  });

  it('skips threads with too few messages', async () => {
    const fp = 'ffffffffffffffffffffffffffffffff';
    seedConversation(fp, [{ dir: 'in', text: 'hello' }]);
    const intel = new StubIntelligence(() => 'NeverCalled');
    const suggester = new ThreadlineNicknameSuggester({
      observability, nicknames, intelligence: intel,
      minMessages: 3,
    });
    const r = await suggester.run();
    expect(r.applied).toHaveLength(0);
    expect(r.skipped[0]?.reason).toMatch(/< 3 messages/);
    expect(intel.calls).toHaveLength(0);
  });

  it('records intelligence failures as skips, not crashes', async () => {
    const fp = '99999999999999999999999999999999';
    seedConversation(fp, [
      { dir: 'in', text: 'one' },
      { dir: 'out', text: 'two' },
    ]);
    const intel = new StubIntelligence(() => { throw new Error('rate-limited'); });
    const suggester = new ThreadlineNicknameSuggester({ observability, nicknames, intelligence: intel });
    const r = await suggester.run();
    expect(r.applied).toHaveLength(0);
    expect(r.skipped[0]?.reason).toMatch(/rate-limited/);
  });
});
