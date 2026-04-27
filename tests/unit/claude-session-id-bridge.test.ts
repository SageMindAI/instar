/**
 * Tests for claudeSessionId population via hook events.
 *
 * The /hooks/events endpoint bridges two ID spaces:
 * - instar_sid (query param): the instar SessionManager's internal session ID
 * - session_id (payload field): Claude Code's session UUID
 *
 * When a hook event arrives with both IDs, the server populates
 * claudeSessionId on the Session record. This is critical for:
 * - Session resume: beforeSessionKill uses claudeSessionId to save the correct UUID
 * - Cross-contamination prevention: without claudeSessionId, the mtime heuristic
 *   guesses wrong when multiple sessions are active
 *
 * Previously, HTTP hooks (type: "http") were supposed to do this, but they silently
 * failed to fire in Claude Code <=2.1.78. Now command hooks (hook-event-reporter.js)
 * POST to the same endpoint reliably.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';

// ── Minimal Session Manager Mock ─────────────────────────────────

interface MockSession {
  id: string;
  name: string;
  claudeSessionId?: string;
}

class MockSessionManager {
  private sessions: Map<string, MockSession> = new Map();

  addSession(id: string, name: string): void {
    this.sessions.set(id, { id, name });
  }

  getSessionById(id: string): MockSession | undefined {
    return this.sessions.get(id);
  }

  setClaudeSessionId(instarSid: string, claudeSessionId: string): void {
    const session = this.sessions.get(instarSid);
    if (session) {
      session.claudeSessionId = claudeSessionId;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-csid-test-'));
}

function buildTestApp(opts: {
  hookEventReceiver: HookEventReceiver;
  sessionManager: MockSessionManager;
}) {
  const app = express();
  app.use(express.json());

  app.post('/hooks/events', (req, res) => {
    const payload = req.body;
    if (!payload || !payload.event) {
      res.status(400).json({ error: 'Missing event field' });
      return;
    }

    opts.hookEventReceiver.receive(payload);

    // Bridge instar session ID ↔ Claude Code session ID
    // (mirrors the logic in routes.ts)
    const instarSid = typeof req.query.instar_sid === 'string' ? req.query.instar_sid : '';
    if (instarSid && payload.session_id) {
      const session = opts.sessionManager.getSessionById(instarSid);
      if (session && !session.claudeSessionId) {
        opts.sessionManager.setClaudeSessionId(instarSid, payload.session_id);
      }
    }

    res.json({ ok: true, event: payload.event });
  });

  return app;
}

// ── Tests ────────────────────────────────────────────────────────

describe('claudeSessionId bridge via /hooks/events', () => {
  let tmpDir: string;
  let hookReceiver: HookEventReceiver;
  let sessionManager: MockSessionManager;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = createTempDir();
    hookReceiver = new HookEventReceiver({ stateDir: tmpDir });
    sessionManager = new MockSessionManager();
    app = buildTestApp({ hookEventReceiver: hookReceiver, sessionManager });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Core bridging ───────────────────────────────────────────────

  it('populates claudeSessionId on first hook event', async () => {
    sessionManager.addSession('instar-abc', 'test-session');

    await request(app)
      .post('/hooks/events?instar_sid=instar-abc')
      .send({ event: 'PostToolUse', session_id: 'claude-uuid-123', tool_name: 'Bash' });

    const session = sessionManager.getSessionById('instar-abc');
    expect(session?.claudeSessionId).toBe('claude-uuid-123');
  });

  it('does not overwrite claudeSessionId on subsequent events', async () => {
    sessionManager.addSession('instar-abc', 'test-session');

    // First event sets it
    await request(app)
      .post('/hooks/events?instar_sid=instar-abc')
      .send({ event: 'PostToolUse', session_id: 'first-uuid', tool_name: 'Bash' });

    // Second event should NOT overwrite
    await request(app)
      .post('/hooks/events?instar_sid=instar-abc')
      .send({ event: 'PostToolUse', session_id: 'second-uuid', tool_name: 'Read' });

    const session = sessionManager.getSessionById('instar-abc');
    expect(session?.claudeSessionId).toBe('first-uuid');
  });

  it('does not set claudeSessionId when instar_sid is missing', async () => {
    sessionManager.addSession('instar-abc', 'test-session');

    await request(app)
      .post('/hooks/events')
      .send({ event: 'PostToolUse', session_id: 'claude-uuid-123', tool_name: 'Bash' });

    const session = sessionManager.getSessionById('instar-abc');
    expect(session?.claudeSessionId).toBeUndefined();
  });

  it('does not set claudeSessionId when session_id is missing from payload', async () => {
    sessionManager.addSession('instar-abc', 'test-session');

    await request(app)
      .post('/hooks/events?instar_sid=instar-abc')
      .send({ event: 'PostToolUse', tool_name: 'Bash' });

    const session = sessionManager.getSessionById('instar-abc');
    expect(session?.claudeSessionId).toBeUndefined();
  });

  it('does not crash when instar_sid references unknown session', async () => {
    const res = await request(app)
      .post('/hooks/events?instar_sid=nonexistent')
      .send({ event: 'PostToolUse', session_id: 'claude-uuid-123', tool_name: 'Bash' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ── Multi-session isolation ─────────────────────────────────────

  it('maps different Claude UUIDs to different instar sessions', async () => {
    sessionManager.addSession('instar-1', 'session-topic-a');
    sessionManager.addSession('instar-2', 'session-topic-b');

    await request(app)
      .post('/hooks/events?instar_sid=instar-1')
      .send({ event: 'PostToolUse', session_id: 'claude-aaa', tool_name: 'Bash' });

    await request(app)
      .post('/hooks/events?instar_sid=instar-2')
      .send({ event: 'PostToolUse', session_id: 'claude-bbb', tool_name: 'Read' });

    expect(sessionManager.getSessionById('instar-1')?.claudeSessionId).toBe('claude-aaa');
    expect(sessionManager.getSessionById('instar-2')?.claudeSessionId).toBe('claude-bbb');
  });

  it('does not cross-contaminate sessions (same Claude UUID cannot map to two sessions)', async () => {
    sessionManager.addSession('instar-1', 'session-topic-a');
    sessionManager.addSession('instar-2', 'session-topic-b');

    // Both sessions report the same Claude UUID (shouldn't happen, but test defense)
    await request(app)
      .post('/hooks/events?instar_sid=instar-1')
      .send({ event: 'PostToolUse', session_id: 'shared-uuid', tool_name: 'Bash' });

    await request(app)
      .post('/hooks/events?instar_sid=instar-2')
      .send({ event: 'PostToolUse', session_id: 'shared-uuid', tool_name: 'Read' });

    // Each session gets its own mapping
    expect(sessionManager.getSessionById('instar-1')?.claudeSessionId).toBe('shared-uuid');
    expect(sessionManager.getSessionById('instar-2')?.claudeSessionId).toBe('shared-uuid');
  });

  // ── Event types that carry session_id ──────────────────────────

  it('works with PostToolUse events', async () => {
    sessionManager.addSession('s1', 'test');

    await request(app)
      .post('/hooks/events?instar_sid=s1')
      .send({ event: 'PostToolUse', session_id: 'uuid-1', tool_name: 'Bash' });

    expect(sessionManager.getSessionById('s1')?.claudeSessionId).toBe('uuid-1');
  });

  it('works with Stop events', async () => {
    sessionManager.addSession('s1', 'test');

    await request(app)
      .post('/hooks/events?instar_sid=s1')
      .send({ event: 'Stop', session_id: 'uuid-2', last_assistant_message: 'Done' });

    expect(sessionManager.getSessionById('s1')?.claudeSessionId).toBe('uuid-2');
  });

  it('works with SubagentStart events', async () => {
    sessionManager.addSession('s1', 'test');

    await request(app)
      .post('/hooks/events?instar_sid=s1')
      .send({ event: 'SubagentStart', session_id: 'uuid-3', agent_id: 'a1', agent_type: 'Explore' });

    expect(sessionManager.getSessionById('s1')?.claudeSessionId).toBe('uuid-3');
  });

  it('works with SessionEnd events', async () => {
    sessionManager.addSession('s1', 'test');

    await request(app)
      .post('/hooks/events?instar_sid=s1')
      .send({ event: 'SessionEnd', session_id: 'uuid-4', reason: 'clear' });

    expect(sessionManager.getSessionById('s1')?.claudeSessionId).toBe('uuid-4');
  });

  // ── Regression: hook-event-reporter.js payload format ──────────

  it('handles payload format from hook-event-reporter.js', async () => {
    // hook-event-reporter.js sends: { event, session_id, tool_name }
    sessionManager.addSession('s1', 'test');

    await request(app)
      .post('/hooks/events?instar_sid=s1')
      .send({
        event: 'PostToolUse',
        session_id: 'reporter-uuid',
        tool_name: 'Bash',
      });

    expect(sessionManager.getSessionById('s1')?.claudeSessionId).toBe('reporter-uuid');
  });

  it('handles empty session_id gracefully', async () => {
    sessionManager.addSession('s1', 'test');

    await request(app)
      .post('/hooks/events?instar_sid=s1')
      .send({ event: 'PostToolUse', session_id: '', tool_name: 'Bash' });

    // Empty string is falsy, should not be set
    expect(sessionManager.getSessionById('s1')?.claudeSessionId).toBeUndefined();
  });
});
