/**
 * Unit tests for SessionSummarySentinel — session summaries and intelligent routing.
 *
 * Tests:
 * - Scan: captures output, generates summaries, hash-based dedup
 * - Keyword fallback: extracts files, topics, phase from output
 * - LLM integration: parses JSON, handles malformed responses
 * - Routing: scores sessions by topic/file/task overlap
 * - Staleness: marks old summaries stale
 * - Misroute tracking: fallback mode after threshold
 * - Lifecycle: start/stop idempotent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SessionSummarySentinel,
  type SessionSummary,
} from '../../src/messaging/SessionSummarySentinel.js';
import type { Session } from '../../src/core/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sentinel-test-'));
}

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'test-session',
    status: 'running',
    tmuxSession: 'test-tmux-session',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('SessionSummarySentinel', () => {
  let tmpDir: string;
  let sentinel: SessionSummarySentinel;
  let sessions: Session[];
  let capturedOutput: Map<string, string>;

  beforeEach(() => {
    tmpDir = createTempDir();
    sessions = [];
    capturedOutput = new Map();
    sentinel = new SessionSummarySentinel({
      stateDir: tmpDir,
      getActiveSessions: () => sessions,
      captureOutput: (tmux) => capturedOutput.get(tmux) ?? null,
    });
  });

  afterEach(() => {
    sentinel.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Keyword Summary Extraction ─────────────────────────────

  describe('keyword fallback extraction', () => {
    it('extracts files from terminal output', async () => {
      const session = makeSession({ tmuxSession: 'tmux-1' });
      sessions.push(session);
      capturedOutput.set('tmux-1', `
        Editing src/server/routes.ts
        Modified lib/ai/UnifiedChatHandler.ts
        Running tests on tests/unit/foo.test.ts
      `);

      await sentinel.scan();
      const summary = sentinel.getSummary(session.id);
      expect(summary).toBeDefined();
      expect(summary!.files).toContain('src/server/routes.ts');
      expect(summary!.files).toContain('lib/ai/UnifiedChatHandler.ts');
      expect(summary!.files).toContain('tests/unit/foo.test.ts');
    });

    it('extracts topics via keyword matching', async () => {
      const session = makeSession({ tmuxSession: 'tmux-2' });
      sessions.push(session);
      capturedOutput.set('tmux-2', `
        Running prisma migrate dev
        Updated database schema
        SELECT * FROM users WHERE auth_token = ?
      `);

      await sentinel.scan();
      const summary = sentinel.getSummary(session.id);
      expect(summary!.topics).toContain('database');
      expect(summary!.topics).toContain('security');
    });

    it('detects testing phase from output', async () => {
      const session = makeSession({ tmuxSession: 'tmux-3' });
      sessions.push(session);
      capturedOutput.set('tmux-3', `
        PASS tests/unit/message-store.test.ts
        Tests: 20 passed (20)
        expect(result).toBe(true)
      `);

      await sentinel.scan();
      const summary = sentinel.getSummary(session.id);
      expect(summary!.phase).toBe('testing');
    });

    it('detects debugging phase from output', async () => {
      const session = makeSession({ tmuxSession: 'tmux-4' });
      sessions.push(session);
      capturedOutput.set('tmux-4', `
        Error: Cannot read properties of undefined
        at Object.<anonymous> (src/server/routes.ts:123)
        TypeError: bug in middleware
      `);

      await sentinel.scan();
      const summary = sentinel.getSummary(session.id);
      expect(summary!.phase).toBe('debugging');
    });

    it('uses session prompt as task description', async () => {
      const session = makeSession({
        tmuxSession: 'tmux-5',
        prompt: 'Fix the authentication bug in the login flow',
      });
      sessions.push(session);
      capturedOutput.set('tmux-5', 'working...');

      await sentinel.scan();
      const summary = sentinel.getSummary(session.id);
      expect(summary!.task).toContain('Fix the authentication bug');
    });
  });

  // ── Hash-based Change Detection ────────────────────────────

  describe('change detection', () => {
    it('skips LLM call when output unchanged', async () => {
      const session = makeSession({ tmuxSession: 'tmux-6' });
      sessions.push(session);
      capturedOutput.set('tmux-6', 'hello world');

      const result1 = await sentinel.scan();
      expect(result1.updated).toBe(1);

      // Same output → should skip
      const result2 = await sentinel.scan();
      expect(result2.skipped).toBe(1);
      expect(result2.updated).toBe(0);
    });

    it('regenerates summary when output changes', async () => {
      const session = makeSession({ tmuxSession: 'tmux-7' });
      sessions.push(session);
      capturedOutput.set('tmux-7', 'output version 1');

      await sentinel.scan();
      const summary1 = sentinel.getSummary(session.id);

      capturedOutput.set('tmux-7', 'output version 2 with tests running');
      await sentinel.scan();
      const summary2 = sentinel.getSummary(session.id);

      expect(summary1!.outputHash).not.toBe(summary2!.outputHash);
    });

    it('skips sessions with empty output', async () => {
      const session = makeSession({ tmuxSession: 'tmux-8' });
      sessions.push(session);
      capturedOutput.set('tmux-8', '');

      const result = await sentinel.scan();
      expect(result.skipped).toBe(1);
    });

    it('skips sessions with no tmux output', async () => {
      const session = makeSession({ tmuxSession: 'tmux-9' });
      sessions.push(session);
      // No output set → captureOutput returns null

      const result = await sentinel.scan();
      expect(result.skipped).toBe(1);
    });
  });

  // ── LLM Response Parsing ───────────────────────────────────

  describe('LLM response parsing', () => {
    it('parses valid JSON response', async () => {
      const mockIntelligence = {
        evaluate: async () => JSON.stringify({
          task: 'Implementing message routing',
          phase: 'building',
          files: ['src/messaging/MessageRouter.ts'],
          topics: ['messaging', 'routing'],
          blockers: null,
        }),
      };

      const sentinelWithLlm = new SessionSummarySentinel({
        stateDir: tmpDir,
        intelligence: mockIntelligence as any,
        getActiveSessions: () => sessions,
        captureOutput: (tmux) => capturedOutput.get(tmux) ?? null,
      });

      const session = makeSession({ tmuxSession: 'tmux-llm-1' });
      sessions.push(session);
      capturedOutput.set('tmux-llm-1', 'editing MessageRouter.ts');

      await sentinelWithLlm.scan();
      const summary = sentinelWithLlm.getSummary(session.id);
      expect(summary!.task).toBe('Implementing message routing');
      expect(summary!.phase).toBe('building');
      expect(summary!.topics).toContain('messaging');
      sentinelWithLlm.stop();
    });

    it('handles markdown-wrapped JSON response', async () => {
      const mockIntelligence = {
        evaluate: async () => '```json\n{"task":"Test","phase":"testing","files":[],"topics":[],"blockers":null}\n```',
      };

      const sentinelWithLlm = new SessionSummarySentinel({
        stateDir: tmpDir,
        intelligence: mockIntelligence as any,
        getActiveSessions: () => sessions,
        captureOutput: (tmux) => capturedOutput.get(tmux) ?? null,
      });

      const session = makeSession({ tmuxSession: 'tmux-llm-2' });
      sessions.push(session);
      capturedOutput.set('tmux-llm-2', 'running vitest');

      await sentinelWithLlm.scan();
      const summary = sentinelWithLlm.getSummary(session.id);
      expect(summary!.task).toBe('Test');
      sentinelWithLlm.stop();
    });

    it('falls back to keyword extraction on LLM failure', async () => {
      const mockIntelligence = {
        evaluate: async () => { throw new Error('API unavailable'); },
      };

      const sentinelWithLlm = new SessionSummarySentinel({
        stateDir: tmpDir,
        intelligence: mockIntelligence as any,
        getActiveSessions: () => sessions,
        captureOutput: (tmux) => capturedOutput.get(tmux) ?? null,
      });

      const session = makeSession({ tmuxSession: 'tmux-llm-3' });
      sessions.push(session);
      capturedOutput.set('tmux-llm-3', 'editing src/server/routes.ts with prisma queries');

      await sentinelWithLlm.scan();
      const summary = sentinelWithLlm.getSummary(session.id);
      expect(summary).toBeDefined();
      expect(summary!.files).toContain('src/server/routes.ts');
      sentinelWithLlm.stop();
    });

    it('rejects invalid JSON and falls back', async () => {
      const mockIntelligence = {
        evaluate: async () => 'This is not JSON at all',
      };

      const sentinelWithLlm = new SessionSummarySentinel({
        stateDir: tmpDir,
        intelligence: mockIntelligence as any,
        getActiveSessions: () => sessions,
        captureOutput: (tmux) => capturedOutput.get(tmux) ?? null,
      });

      const session = makeSession({ tmuxSession: 'tmux-llm-4' });
      sessions.push(session);
      capturedOutput.set('tmux-llm-4', 'hello test world');

      await sentinelWithLlm.scan();
      const summary = sentinelWithLlm.getSummary(session.id);
      expect(summary).toBeDefined();
      // Should have used keyword fallback
      expect(summary!.phase).toBeDefined();
      sentinelWithLlm.stop();
    });
  });

  // ── Intelligent Routing ────────────────────────────────────

  describe('intelligent routing', () => {
    it('scores sessions by topic overlap', () => {
      const s1 = makeSession({ id: 'session-db', tmuxSession: 'tmux-db' });
      const s2 = makeSession({ id: 'session-fe', tmuxSession: 'tmux-fe' });
      sessions.push(s1, s2);

      // Write summaries directly
      const summaryDir1 = path.join(tmpDir, 'sessions', s1.id);
      const summaryDir2 = path.join(tmpDir, 'sessions', s2.id);
      fs.mkdirSync(summaryDir1, { recursive: true });
      fs.mkdirSync(summaryDir2, { recursive: true });

      const dbSummary: SessionSummary = {
        sessionId: s1.id,
        tmuxSession: s1.tmuxSession,
        task: 'Database migration',
        phase: 'building',
        files: ['prisma/schema.prisma'],
        topics: ['database', 'migration'],
        blockers: null,
        lastActivity: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stale: false,
        outputHash: 'hash1',
      };
      const feSummary: SessionSummary = {
        sessionId: s2.id,
        tmuxSession: s2.tmuxSession,
        task: 'Frontend redesign',
        phase: 'building',
        files: ['components/Layout.tsx'],
        topics: ['frontend', 'css', 'react'],
        blockers: null,
        lastActivity: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stale: false,
        outputHash: 'hash2',
      };

      fs.writeFileSync(path.join(summaryDir1, 'summary.json'), JSON.stringify(dbSummary));
      fs.writeFileSync(path.join(summaryDir2, 'summary.json'), JSON.stringify(feSummary));

      // Query about database should route to db session
      const scores = sentinel.findBestSession(
        'Database schema update',
        'Need to add a new column to the users table in the database',
        'test-agent',
      );

      expect(scores.length).toBeGreaterThan(0);
      expect(scores[0].sessionId).toBe(s1.id);
    });

    it('penalizes deploying sessions', () => {
      const s1 = makeSession({ id: 'session-deploy', tmuxSession: 'tmux-deploy' });
      const s2 = makeSession({ id: 'session-build', tmuxSession: 'tmux-build' });
      sessions.push(s1, s2);

      const summaryDir1 = path.join(tmpDir, 'sessions', s1.id);
      const summaryDir2 = path.join(tmpDir, 'sessions', s2.id);
      fs.mkdirSync(summaryDir1, { recursive: true });
      fs.mkdirSync(summaryDir2, { recursive: true });

      const deploySummary: SessionSummary = {
        sessionId: s1.id, tmuxSession: s1.tmuxSession,
        task: 'Deploying API changes', phase: 'deploying',
        files: ['src/api/routes.ts'], topics: ['api', 'deployment'],
        blockers: null, lastActivity: new Date().toISOString(),
        updatedAt: new Date().toISOString(), stale: false, outputHash: 'h1',
      };
      const buildSummary: SessionSummary = {
        sessionId: s2.id, tmuxSession: s2.tmuxSession,
        task: 'Building API endpoints', phase: 'building',
        files: ['src/api/routes.ts'], topics: ['api', 'backend'],
        blockers: null, lastActivity: new Date().toISOString(),
        updatedAt: new Date().toISOString(), stale: false, outputHash: 'h2',
      };

      fs.writeFileSync(path.join(summaryDir1, 'summary.json'), JSON.stringify(deploySummary));
      fs.writeFileSync(path.join(summaryDir2, 'summary.json'), JSON.stringify(buildSummary));

      const scores = sentinel.findBestSession(
        'API route question',
        'How does the api routes work?',
        'test-agent',
      );

      // Building session should rank higher than deploying
      if (scores.length >= 2) {
        const buildScore = scores.find(s => s.sessionId === s2.id);
        const deployScore = scores.find(s => s.sessionId === s1.id);
        if (buildScore && deployScore) {
          expect(buildScore.score).toBeGreaterThan(deployScore.score);
        }
      }
    });

    it('returns empty array when no sessions active', () => {
      const scores = sentinel.findBestSession('Test', 'Test message', 'test-agent');
      expect(scores).toEqual([]);
    });

    it('returns empty array when no sessions score above threshold', () => {
      const s1 = makeSession({ id: 'session-unrelated', tmuxSession: 'tmux-unrelated' });
      sessions.push(s1);

      const summaryDir = path.join(tmpDir, 'sessions', s1.id);
      fs.mkdirSync(summaryDir, { recursive: true });

      const summary: SessionSummary = {
        sessionId: s1.id, tmuxSession: s1.tmuxSession,
        task: 'Cooking recipes', phase: 'idle',
        files: [], topics: [],
        blockers: null, lastActivity: new Date().toISOString(),
        updatedAt: new Date().toISOString(), stale: false, outputHash: 'h',
      };
      fs.writeFileSync(path.join(summaryDir, 'summary.json'), JSON.stringify(summary));

      const scores = sentinel.findBestSession(
        'Database migration',
        'Need to update prisma schema',
        'test-agent',
      );
      expect(scores).toEqual([]);
    });

    it('excludes sender session from candidates', () => {
      // Two active sessions, both would score above threshold.
      // Without the exclusion, the sender's own session could win and
      // trip echo-prevention in MessageRouter.send when resolving
      // to.session === "best".
      const sSender = makeSession({ id: 'session-sender', tmuxSession: 'tmux-sender' });
      const sOther = makeSession({ id: 'session-other', tmuxSession: 'tmux-other' });
      sessions.push(sSender, sOther);

      const summaryDirSender = path.join(tmpDir, 'sessions', sSender.id);
      const summaryDirOther = path.join(tmpDir, 'sessions', sOther.id);
      fs.mkdirSync(summaryDirSender, { recursive: true });
      fs.mkdirSync(summaryDirOther, { recursive: true });

      const senderSummary: SessionSummary = {
        sessionId: sSender.id, tmuxSession: sSender.tmuxSession,
        task: 'Database migration work', phase: 'building',
        files: ['prisma/schema.prisma'], topics: ['database', 'migration'],
        blockers: null, lastActivity: new Date().toISOString(),
        updatedAt: new Date().toISOString(), stale: false, outputHash: 'hS',
      };
      const otherSummary: SessionSummary = {
        sessionId: sOther.id, tmuxSession: sOther.tmuxSession,
        task: 'Database schema review', phase: 'building',
        files: ['prisma/schema.prisma'], topics: ['database', 'schema'],
        blockers: null, lastActivity: new Date().toISOString(),
        updatedAt: new Date().toISOString(), stale: false, outputHash: 'hO',
      };

      fs.writeFileSync(path.join(summaryDirSender, 'summary.json'), JSON.stringify(senderSummary));
      fs.writeFileSync(path.join(summaryDirOther, 'summary.json'), JSON.stringify(otherSummary));

      // Without exclusion: sender's session is a valid candidate
      const withoutExclude = sentinel.findBestSession(
        'Database question',
        'Database schema migration question',
        'test-agent',
      );
      expect(withoutExclude.some(s => s.sessionId === sSender.id)).toBe(true);

      // With exclusion by sessionId: sender's session must be dropped
      const excludeById = sentinel.findBestSession(
        'Database question',
        'Database schema migration question',
        'test-agent',
        sSender.id,
      );
      expect(excludeById.some(s => s.sessionId === sSender.id)).toBe(false);
      expect(excludeById.some(s => s.sessionId === sOther.id)).toBe(true);

      // With exclusion by tmuxSession name: also dropped
      const excludeByTmux = sentinel.findBestSession(
        'Database question',
        'Database schema migration question',
        'test-agent',
        sSender.tmuxSession,
      );
      expect(excludeByTmux.some(s => s.sessionId === sSender.id)).toBe(false);
      expect(excludeByTmux.some(s => s.sessionId === sOther.id)).toBe(true);
    });

    it('returns empty when the only candidate is the excluded sender', () => {
      // Reproduction: sender's session is the ONLY active session. Without
      // the exclusion, MessageRouter.send would set to.session = from.session
      // and throw echo-prevention. With the exclusion, the resolver returns
      // no matches and MessageRouter keeps to.session = "best" for queueing.
      const sSender = makeSession({ id: 'session-only', tmuxSession: 'tmux-only' });
      sessions.push(sSender);

      const summaryDir = path.join(tmpDir, 'sessions', sSender.id);
      fs.mkdirSync(summaryDir, { recursive: true });

      const summary: SessionSummary = {
        sessionId: sSender.id, tmuxSession: sSender.tmuxSession,
        task: 'Database migration', phase: 'building',
        files: ['prisma/schema.prisma'], topics: ['database', 'migration'],
        blockers: null, lastActivity: new Date().toISOString(),
        updatedAt: new Date().toISOString(), stale: false, outputHash: 'h',
      };
      fs.writeFileSync(path.join(summaryDir, 'summary.json'), JSON.stringify(summary));

      const scores = sentinel.findBestSession(
        'Database question',
        'Database migration question',
        'test-agent',
        sSender.id,
      );
      expect(scores).toEqual([]);
    });
  });

  // ── Staleness ──────────────────────────────────────────────

  describe('staleness', () => {
    it('marks summaries older than threshold as stale', async () => {
      const session = makeSession({ tmuxSession: 'tmux-stale' });
      sessions.push(session);
      capturedOutput.set('tmux-stale', 'some output');

      await sentinel.scan();

      // Backdate the summary to trigger staleness
      const summary = sentinel.getSummary(session.id)!;
      summary.updatedAt = new Date(Date.now() - 15 * 60_000).toISOString(); // 15 min ago
      const filePath = path.join(tmpDir, 'sessions', session.id, 'summary.json');
      fs.writeFileSync(filePath, JSON.stringify(summary));

      // Re-scan (output same → skip but update staleness)
      await sentinel.scan();

      const updated = sentinel.getSummary(session.id);
      expect(updated!.stale).toBe(true);
    });
  });

  // ── Misroute Tracking ──────────────────────────────────────

  describe('misroute tracking', () => {
    it('enters fallback mode after threshold misroutes', () => {
      expect(sentinel.isInFallbackMode()).toBe(false);

      // Record 3 misroutes (default threshold)
      sentinel.recordMisroute();
      sentinel.recordMisroute();
      sentinel.recordMisroute();

      expect(sentinel.isInFallbackMode()).toBe(true);
    });

    it('reports status correctly', () => {
      const status = sentinel.getStatus();
      expect(status.summaryCount).toBe(0);
      expect(status.staleCount).toBe(0);
      expect(status.inFallback).toBe(false);
      expect(status.recentMisroutes).toBe(0);
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────

  describe('lifecycle', () => {
    it('start and stop are idempotent', () => {
      sentinel.start();
      sentinel.start(); // No error
      sentinel.stop();
      sentinel.stop(); // No error
    });

    it('handles empty session list gracefully', async () => {
      const result = await sentinel.scan();
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('getAllSummaries returns all stored summaries', async () => {
      const s1 = makeSession({ id: 'session-all-1', tmuxSession: 'tmux-all-1' });
      const s2 = makeSession({ id: 'session-all-2', tmuxSession: 'tmux-all-2' });
      sessions.push(s1, s2);
      capturedOutput.set('tmux-all-1', 'output 1');
      capturedOutput.set('tmux-all-2', 'output 2');

      await sentinel.scan();
      const all = sentinel.getAllSummaries();
      expect(all.length).toBe(2);
    });
  });
});
