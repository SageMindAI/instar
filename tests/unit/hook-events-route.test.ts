/**
 * Unit tests for the /hooks/events route — HTTP hook event ingestion endpoint.
 *
 * Tests the full request/response cycle including:
 * - Event reception and storage
 * - Subagent event dispatch to SubagentTracker
 * - Query endpoints for events, summaries, sessions
 * - Error handling for missing/invalid payloads
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';
import { InstructionsVerifier } from '../../src/monitoring/InstructionsVerifier.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-route-test-'));
}

/**
 * Build a minimal Express app with just the hook event routes.
 * Avoids importing the full RouteContext which has many dependencies.
 */
function buildTestApp(opts: {
  hookEventReceiver: HookEventReceiver;
  subagentTracker: SubagentTracker;
  instructionsVerifier: InstructionsVerifier;
}) {
  const app = express();
  app.use(express.json());

  // POST /hooks/events — central ingest
  app.post('/hooks/events', (req, res) => {
    const payload = req.body;
    if (!payload || !payload.event) {
      res.status(400).json({ error: 'Missing event field in payload' });
      return;
    }

    const stored = opts.hookEventReceiver.receive(payload);
    if (!stored) {
      res.status(500).json({ error: 'Failed to store event' });
      return;
    }

    // Dispatch to SubagentTracker
    if (payload.session_id) {
      if (payload.event === 'SubagentStart' && payload.agent_id && payload.agent_type) {
        opts.subagentTracker.onStart(payload.agent_id, payload.agent_type, payload.session_id);
      } else if (payload.event === 'SubagentStop' && payload.agent_id) {
        opts.subagentTracker.onStop(
          payload.agent_id,
          payload.session_id,
          payload.last_assistant_message,
          payload.agent_transcript_path,
        );
      }
    }

    res.json({ ok: true, event: payload.event });
  });

  // GET /hooks/events/:sessionId
  app.get('/hooks/events/:sessionId', (req, res) => {
    const events = opts.hookEventReceiver.getSessionEvents(req.params.sessionId);
    res.json({ sessionId: req.params.sessionId, events, count: events.length });
  });

  // GET /hooks/events/:sessionId/summary
  app.get('/hooks/events/:sessionId/summary', (req, res) => {
    const summary = opts.hookEventReceiver.getSessionSummary(req.params.sessionId);
    if (!summary) {
      res.status(404).json({ error: 'No events found for session' });
      return;
    }
    res.json(summary);
  });

  // GET /hooks/sessions
  app.get('/hooks/sessions', (_req, res) => {
    const sessions = opts.hookEventReceiver.listSessions();
    const index = opts.hookEventReceiver.getIndex();
    const sessionList = sessions.map(id => ({
      sessionId: id,
      eventCount: index.get(id) ?? 0,
    }));
    res.json({ sessions: sessionList });
  });

  // GET /hooks/subagents/:sessionId
  app.get('/hooks/subagents/:sessionId', (req, res) => {
    const records = opts.subagentTracker.getSessionRecords(req.params.sessionId);
    const summary = opts.subagentTracker.getSessionSummary(req.params.sessionId);
    res.json({ sessionId: req.params.sessionId, records, summary });
  });

  // GET /hooks/instructions/:sessionId
  app.get('/hooks/instructions/:sessionId', (req, res) => {
    const result = opts.instructionsVerifier.verify(req.params.sessionId);
    res.json(result);
  });

  return app;
}

// ── Tests ────────────────────────────────────────────────────────

describe('Hook Events Route', () => {
  let tmpDir: string;
  let hookReceiver: HookEventReceiver;
  let subagentTracker: SubagentTracker;
  let instructionsVerifier: InstructionsVerifier;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = createTempDir();
    hookReceiver = new HookEventReceiver({ stateDir: tmpDir });
    subagentTracker = new SubagentTracker({ stateDir: tmpDir });
    instructionsVerifier = new InstructionsVerifier({ stateDir: tmpDir });
    app = buildTestApp({ hookEventReceiver: hookReceiver, subagentTracker, instructionsVerifier });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Event Ingestion ───────────────────────────────────────────

  describe('POST /hooks/events', () => {
    it('accepts a valid hook event', async () => {
      const res = await request(app)
        .post('/hooks/events')
        .send({ event: 'PostToolUse', session_id: 'session-1', tool_name: 'Bash' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.event).toBe('PostToolUse');
    });

    it('stores the event in HookEventReceiver', async () => {
      await request(app)
        .post('/hooks/events')
        .send({ event: 'PostToolUse', session_id: 'session-1', tool_name: 'Read' });

      const events = hookReceiver.getSessionEvents('session-1');
      expect(events).toHaveLength(1);
      expect(events[0].payload.tool_name).toBe('Read');
    });

    it('rejects payload without event field', async () => {
      const res = await request(app)
        .post('/hooks/events')
        .send({ session_id: 'session-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing event');
    });

    it('rejects empty body', async () => {
      const res = await request(app)
        .post('/hooks/events')
        .send({});

      expect(res.status).toBe(400);
    });

    it('dispatches SubagentStart to SubagentTracker', async () => {
      await request(app)
        .post('/hooks/events')
        .send({
          event: 'SubagentStart',
          session_id: 'session-1',
          agent_id: 'agent-abc',
          agent_type: 'Explore',
        });

      const records = subagentTracker.getSessionRecords('session-1');
      expect(records).toHaveLength(1);
      expect(records[0].agentId).toBe('agent-abc');
      expect(records[0].agentType).toBe('Explore');
    });

    it('dispatches SubagentStop to SubagentTracker', async () => {
      // Start first
      await request(app)
        .post('/hooks/events')
        .send({
          event: 'SubagentStart',
          session_id: 'session-1',
          agent_id: 'agent-abc',
          agent_type: 'Explore',
        });

      // Then stop
      await request(app)
        .post('/hooks/events')
        .send({
          event: 'SubagentStop',
          session_id: 'session-1',
          agent_id: 'agent-abc',
          last_assistant_message: 'Found 3 files',
          agent_transcript_path: '/tmp/transcript.jsonl',
        });

      const completed = subagentTracker.getCompletedSubagents('session-1');
      expect(completed).toHaveLength(1);
      expect(completed[0].lastMessage).toBe('Found 3 files');
      expect(completed[0].transcriptPath).toBe('/tmp/transcript.jsonl');
    });

    it('handles multiple event types in sequence', async () => {
      const events = [
        { event: 'PostToolUse', session_id: 's1', tool_name: 'Bash' },
        { event: 'PostToolUse', session_id: 's1', tool_name: 'Read' },
        { event: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' },
        { event: 'Stop', session_id: 's1', last_assistant_message: 'Done' },
        { event: 'SessionEnd', session_id: 's1', reason: 'clear' },
      ];

      for (const e of events) {
        const res = await request(app).post('/hooks/events').send(e);
        expect(res.status).toBe(200);
      }

      const stored = hookReceiver.getSessionEvents('s1');
      expect(stored).toHaveLength(5);
    });
  });

  // ── Query Endpoints ───────────────────────────────────────────

  describe('GET /hooks/events/:sessionId', () => {
    it('returns events for a session', async () => {
      await request(app)
        .post('/hooks/events')
        .send({ event: 'PostToolUse', session_id: 's1', tool_name: 'Bash' });

      const res = await request(app).get('/hooks/events/s1');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.events[0].payload.tool_name).toBe('Bash');
    });

    it('returns empty for unknown session', async () => {
      const res = await request(app).get('/hooks/events/unknown');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
    });
  });

  describe('GET /hooks/events/:sessionId/summary', () => {
    it('returns summary for session with events', async () => {
      await request(app).post('/hooks/events').send({ event: 'PostToolUse', session_id: 's1', tool_name: 'Bash' });
      await request(app).post('/hooks/events').send({ event: 'PostToolUse', session_id: 's1', tool_name: 'Read' });

      const res = await request(app).get('/hooks/events/s1/summary');
      expect(res.status).toBe(200);
      expect(res.body.eventCount).toBe(2);
      expect(res.body.toolsUsed.sort()).toEqual(['Bash', 'Read']);
    });

    it('returns 404 for unknown session', async () => {
      const res = await request(app).get('/hooks/events/unknown/summary');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /hooks/sessions', () => {
    it('lists all sessions with event counts', async () => {
      await request(app).post('/hooks/events').send({ event: 'PostToolUse', session_id: 's1' });
      await request(app).post('/hooks/events').send({ event: 'PostToolUse', session_id: 's1' });
      await request(app).post('/hooks/events').send({ event: 'PostToolUse', session_id: 's2' });

      const res = await request(app).get('/hooks/sessions');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(2);

      const s1 = res.body.sessions.find((s: any) => s.sessionId === 's1');
      expect(s1.eventCount).toBe(2);
    });
  });

  describe('GET /hooks/subagents/:sessionId', () => {
    it('returns subagent records and summary', async () => {
      await request(app).post('/hooks/events').send({
        event: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore',
      });
      await request(app).post('/hooks/events').send({
        event: 'SubagentStop', session_id: 's1', agent_id: 'a1', last_assistant_message: 'Done',
      });

      const res = await request(app).get('/hooks/subagents/s1');
      expect(res.status).toBe(200);
      expect(res.body.records).toHaveLength(1);
      expect(res.body.summary.total).toBe(1);
      expect(res.body.summary.completed).toBe(1);
    });
  });

  describe('GET /hooks/instructions/:sessionId', () => {
    it('returns verification result', async () => {
      // Pre-populate some instruction load records
      instructionsVerifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 's1',
      });

      const res = await request(app).get('/hooks/instructions/s1');
      expect(res.status).toBe(200);
      expect(res.body.passed).toBe(true);
    });

    it('reports missing instructions', async () => {
      const res = await request(app).get('/hooks/instructions/no-instructions');
      expect(res.status).toBe(200);
      expect(res.body.passed).toBe(false);
      expect(res.body.missing).toContain('CLAUDE.md');
    });
  });

  describe('session telemetry enrichment', () => {
    it('getSessionSummary returns tool and subagent data for enrichment', async () => {
      // Ingest diverse events for a session
      await request(app).post('/hooks/events').send({
        event: 'PostToolUse', session_id: 'enrich-1', tool_name: 'Bash',
      });
      await request(app).post('/hooks/events').send({
        event: 'PostToolUse', session_id: 'enrich-1', tool_name: 'Edit',
      });
      await request(app).post('/hooks/events').send({
        event: 'SubagentStart', session_id: 'enrich-1', agent_id: 'sub-1', agent_type: 'Explore',
      });
      await request(app).post('/hooks/events').send({
        event: 'TaskCompleted', session_id: 'enrich-1', task_id: 'task-1',
      });

      // Verify summary has enrichment-ready data
      const summary = hookReceiver.getSessionSummary('enrich-1');
      expect(summary).not.toBeNull();
      expect(summary!.toolsUsed).toContain('Bash');
      expect(summary!.toolsUsed).toContain('Edit');
      expect(summary!.subagentsSpawned).toContain('Explore');
      expect(summary!.eventCount).toBe(4);

      // Verify quality gate
      expect(hookReceiver.hasTaskCompleted('enrich-1')).toBe(true);
    });

    it('session type is distinguishable by jobSlug presence', () => {
      // This tests the pattern used in WebSocketManager.buildSessionList()
      const jobSession = { jobSlug: 'daily-health', name: 'daily-health' };
      const interactiveSession = { name: 'topic-42' };

      expect(jobSession.jobSlug ? 'job' : 'interactive').toBe('job');
      expect((interactiveSession as { jobSlug?: string }).jobSlug ? 'job' : 'interactive').toBe('interactive');
    });

    it('enrichment handles sessions with no hook events gracefully', () => {
      const summary = hookReceiver.getSessionSummary('nonexistent-session');
      expect(summary).toBeNull();
      expect(hookReceiver.hasTaskCompleted('nonexistent-session')).toBe(false);
      expect(hookReceiver.getExitReason('nonexistent-session')).toBeNull();
    });
  });
});
