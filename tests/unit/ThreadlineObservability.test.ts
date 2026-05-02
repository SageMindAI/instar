/**
 * Unit tests for ThreadlineObservability — the read-only view layer over
 * canonical inbox + outbox + bridge bindings + thread-resume map. Powers
 * the dashboard "Threadline" tab.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ThreadlineObservability } from '../../src/threadline/ThreadlineObservability.js';

function setup(): { obs: ThreadlineObservability; stateDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-obs-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
  const obs = new ThreadlineObservability({ stateDir });
  return {
    obs,
    stateDir,
    cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ThreadlineObservability.test.ts' }),
  };
}

function writeJsonl(filePath: string, lines: unknown[]): void {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

describe('ThreadlineObservability', () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => { env = setup(); });
  afterEach(() => env.cleanup());

  // ── listThreads ─────────────────────────────────────────────────

  describe('listThreads', () => {
    it('returns [] when no inbox / outbox / bindings exist', () => {
      expect(env.obs.listThreads()).toEqual([]);
    });

    it('builds a thread summary from inbox entries', () => {
      writeJsonl(path.join(env.stateDir, 'threadline', 'inbox.jsonl.active'), [
        { id: 'm1', timestamp: '2026-05-01T10:00:00Z', from: 'fp-dawn', senderName: 'Dawn', trustLevel: 'trusted', threadId: 't1', text: 'hello' },
        { id: 'm2', timestamp: '2026-05-01T10:05:00Z', from: 'fp-dawn', senderName: 'Dawn', trustLevel: 'trusted', threadId: 't1', text: 'follow-up' },
      ]);

      const threads = env.obs.listThreads();
      expect(threads).toHaveLength(1);
      const t = threads[0]!;
      expect(t.threadId).toBe('t1');
      expect(t.messageCount).toBe(2);
      expect(t.inboundCount).toBe(2);
      expect(t.outboundCount).toBe(0);
      expect(t.firstSeen).toBe('2026-05-01T10:00:00Z');
      expect(t.lastSeen).toBe('2026-05-01T10:05:00Z');
      expect(t.remoteAgent).toBe('fp-dawn');
      expect(t.remoteAgentName).toBe('Dawn');
      expect(t.bridge).toBeNull();
      expect(t.hasSpawnedSession).toBe(false);
    });

    it('combines inbox + outbox into a single thread summary', () => {
      writeJsonl(path.join(env.stateDir, 'threadline', 'inbox.jsonl.active'), [
        { id: 'm1', timestamp: '2026-05-01T10:00:00Z', from: 'fp-dawn', senderName: 'Dawn', trustLevel: 'trusted', threadId: 't1', text: 'inbound' },
      ]);
      writeJsonl(path.join(env.stateDir, 'threadline', 'outbox.jsonl.active'), [
        { id: 'm2', timestamp: '2026-05-01T10:01:30Z', from: 'fp-echo', senderName: 'echo', to: 'fp-dawn', recipientName: 'Dawn', trustLevel: 'self', threadId: 't1', text: 'reply', outcome: 'accepted' },
      ]);

      const threads = env.obs.listThreads();
      expect(threads).toHaveLength(1);
      expect(threads[0]!.messageCount).toBe(2);
      expect(threads[0]!.inboundCount).toBe(1);
      expect(threads[0]!.outboundCount).toBe(1);
      expect(threads[0]!.avgResponseLatencyMs).toBe(90_000);
    });

    it('joins bridge bindings when present (bridge column populated)', () => {
      writeJsonl(path.join(env.stateDir, 'threadline', 'inbox.jsonl.active'), [
        { id: 'm1', timestamp: '2026-05-01T10:00:00Z', from: 'fp-dawn', senderName: 'Dawn', trustLevel: 'trusted', threadId: 't1', text: 'hello' },
      ]);
      fs.writeFileSync(path.join(env.stateDir, 'threadline', 'telegram-bridge-bindings.json'), JSON.stringify({
        version: 1,
        bindings: [{
          threadId: 't1',
          topicId: 9876,
          remoteAgent: 'fp-dawn',
          topicName: 'echo↔Dawn — hello',
          createdAt: '2026-05-01T10:00:01Z',
          lastMessageAt: '2026-05-01T10:00:02Z',
        }],
      }));

      const threads = env.obs.listThreads();
      expect(threads[0]!.bridge).not.toBeNull();
      expect(threads[0]!.bridge!.topicId).toBe(9876);
      expect(threads[0]!.bridge!.topicName).toBe('echo↔Dawn — hello');
    });

    it('marks hasSpawnedSession when thread-resume-map references the thread', () => {
      writeJsonl(path.join(env.stateDir, 'threadline', 'inbox.jsonl.active'), [
        { id: 'm1', timestamp: '2026-05-01T10:00:00Z', from: 'fp', senderName: 'X', trustLevel: 'trusted', threadId: 'tA', text: 'x' },
      ]);
      fs.writeFileSync(path.join(env.stateDir, 'threadline', 'thread-resume-map.json'), JSON.stringify({
        threads: { tA: { sessionName: 'sess-1' } },
      }));

      const threads = env.obs.listThreads();
      expect(threads[0]!.hasSpawnedSession).toBe(true);
    });

    it('sorts most-recent first (lastSeen desc)', () => {
      writeJsonl(path.join(env.stateDir, 'threadline', 'inbox.jsonl.active'), [
        { id: 'a', timestamp: '2026-05-01T10:00:00Z', from: 'fp-a', senderName: 'A', trustLevel: 'trusted', threadId: 'tA', text: 'old' },
        { id: 'b', timestamp: '2026-05-02T10:00:00Z', from: 'fp-b', senderName: 'B', trustLevel: 'trusted', threadId: 'tB', text: 'new' },
      ]);
      const threads = env.obs.listThreads();
      expect(threads.map(t => t.threadId)).toEqual(['tB', 'tA']);
    });

    it('filters by remoteAgent (substring, case-insensitive on name and id)', () => {
      writeJsonl(path.join(env.stateDir, 'threadline', 'inbox.jsonl.active'), [
        { id: 'a', timestamp: '2026-05-01T10:00:00Z', from: 'fp-dawn', senderName: 'Dawn', trustLevel: 'trusted', threadId: 'tA', text: 'x' },
        { id: 'b', timestamp: '2026-05-02T10:00:00Z', from: 'fp-ada', senderName: 'Ada', trustLevel: 'trusted', threadId: 'tB', text: 'y' },
      ]);
      const out = env.obs.listThreads({ remoteAgent: 'dawn' });
      expect(out.map(t => t.threadId)).toEqual(['tA']);
    });

    it('filters by hasTopic=yes / hasTopic=no', () => {
      writeJsonl(path.join(env.stateDir, 'threadline', 'inbox.jsonl.active'), [
        { id: 'a', timestamp: '2026-05-01T10:00:00Z', from: 'fp-a', senderName: 'A', trustLevel: 'trusted', threadId: 'tA', text: 'x' },
        { id: 'b', timestamp: '2026-05-02T10:00:00Z', from: 'fp-b', senderName: 'B', trustLevel: 'trusted', threadId: 'tB', text: 'y' },
      ]);
      fs.writeFileSync(path.join(env.stateDir, 'threadline', 'telegram-bridge-bindings.json'), JSON.stringify({
        version: 1,
        bindings: [{ threadId: 'tA', topicId: 1, remoteAgent: 'fp-a', topicName: 'echo↔A', createdAt: '2026-05-01T10:00:01Z', lastMessageAt: '2026-05-01T10:00:02Z' }],
      }));
      expect(env.obs.listThreads({ hasTopic: 'yes' }).map(t => t.threadId)).toEqual(['tA']);
      expect(env.obs.listThreads({ hasTopic: 'no' }).map(t => t.threadId)).toEqual(['tB']);
    });
  });

  // ── getThread ─────────────────────────────────────────────────

  describe('getThread', () => {
    it('returns null for an unknown threadId', () => {
      expect(env.obs.getThread('nope')).toBeNull();
    });

    it('returns the merged in/out message stream sorted chronologically', () => {
      writeJsonl(path.join(env.stateDir, 'threadline', 'inbox.jsonl.active'), [
        { id: 'i1', timestamp: '2026-05-01T10:00:00Z', from: 'fp-d', senderName: 'Dawn', trustLevel: 'trusted', threadId: 't1', text: 'hi from Dawn' },
        { id: 'i2', timestamp: '2026-05-01T10:05:00Z', from: 'fp-d', senderName: 'Dawn', trustLevel: 'trusted', threadId: 't1', text: 'follow-up' },
      ]);
      writeJsonl(path.join(env.stateDir, 'threadline', 'outbox.jsonl.active'), [
        { id: 'o1', timestamp: '2026-05-01T10:02:00Z', from: 'fp-echo', senderName: 'echo', to: 'fp-d', recipientName: 'Dawn', trustLevel: 'self', threadId: 't1', text: 'reply', outcome: 'accepted' },
      ]);

      const t = env.obs.getThread('t1');
      expect(t).not.toBeNull();
      expect(t!.messages.map(m => m.id)).toEqual(['i1', 'o1', 'i2']);
      expect(t!.messages.map(m => m.direction)).toEqual(['in', 'out', 'in']);
      expect(t!.messageCount).toBe(3);
    });
  });

  // ── searchMessages ─────────────────────────────────────────────

  describe('searchMessages', () => {
    beforeEach(() => {
      writeJsonl(path.join(env.stateDir, 'threadline', 'inbox.jsonl.active'), [
        { id: 'i1', timestamp: '2026-05-01T10:00:00Z', from: 'fp-d', senderName: 'Dawn', trustLevel: 'trusted', threadId: 't1', text: 'remember the GROUND-TRUTH-A1 round-trip' },
      ]);
      writeJsonl(path.join(env.stateDir, 'threadline', 'outbox.jsonl.active'), [
        { id: 'o1', timestamp: '2026-05-01T10:02:00Z', from: 'fp-echo', senderName: 'echo', to: 'fp-d', recipientName: 'Dawn', trustLevel: 'self', threadId: 't1', text: 'GROUND-TRUTH-B1 received', outcome: 'accepted' },
      ]);
    });

    it('returns [] for empty query', () => {
      expect(env.obs.searchMessages('')).toEqual([]);
    });

    it('finds matches across both inbox and outbox', () => {
      const hits = env.obs.searchMessages('GROUND-TRUTH');
      expect(hits).toHaveLength(2);
      expect(hits.every(h => h.snippet.includes('«GROUND-TRUTH»'))).toBe(true);
    });

    it('honors the limit', () => {
      const hits = env.obs.searchMessages('GROUND-TRUTH', 1);
      expect(hits).toHaveLength(1);
    });

    it('is case-insensitive', () => {
      expect(env.obs.searchMessages('ground-truth')).toHaveLength(2);
    });
  });

  // ── known-agents resolution ───────────────────────────────────

  describe('known-agents name resolution', () => {
    it('resolves remoteAgentName via known-agents.json when senderName is missing', () => {
      writeJsonl(path.join(env.stateDir, 'threadline', 'inbox.jsonl.active'), [
        { id: 'm1', timestamp: '2026-05-01T10:00:00Z', from: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', senderName: '', trustLevel: 'trusted', threadId: 't1', text: 'x' },
      ]);
      fs.writeFileSync(path.join(env.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({
        agents: [{ name: 'KnownDawn', publicKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
      }));
      const t = env.obs.listThreads()[0]!;
      expect(t.remoteAgentName).toBe('KnownDawn');
    });
  });
});
