/**
 * Unit tests for the GET /delivery-queue route.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3i.
 *
 * The route returns queue depth + oldest age for the current agent's
 * pending-relay SQLite. This is read-only; never mutates queue rows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { PendingRelayStore, resolvePendingRelayPath } from '../../src/messaging/pending-relay-store.js';
import Database from 'better-sqlite3';

// Standalone /delivery-queue handler factored out of routes.ts logic.
// We reproduce the same query shape rather than wiring full createRoutes;
// the integration tests exercise the full stack.
function buildHandler(stateDir: string, agentId: string) {
  return (_req: express.Request, res: express.Response): void => {
    const dbPath = resolvePendingRelayPath(stateDir, agentId);
    let db: import('better-sqlite3').Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const totalRow = db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
      const total = totalRow?.n ?? 0;
      const byState = db.prepare(
        'SELECT state, COUNT(*) AS n FROM entries GROUP BY state',
      ).all() as Array<{ state: string; n: number }>;
      const oldestRow = db.prepare(
        "SELECT MIN(attempted_at) AS oldest FROM entries WHERE state IN ('queued','claimed')",
      ).get() as { oldest: string | null };
      const oldestAgeSeconds = oldestRow?.oldest
        ? Math.max(0, Math.floor((Date.now() - Date.parse(oldestRow.oldest)) / 1000))
        : 0;
      res.json({
        depth: total,
        oldest_age_seconds: oldestAgeSeconds,
        by_state: Object.fromEntries(byState.map((r) => [r.state, r.n])),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unable to open|no such file|does not exist|cannot open/i.test(msg)) {
        res.json({ depth: 0, oldest_age_seconds: 0, by_state: {} });
        return;
      }
      res.status(500).json({ error: msg });
    } finally {
      if (db) {
        try { db.close(); } catch { /* best-effort */ }
      }
    }
  };
}

let stateDir: string;
const agentId = 'echo';

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-queue-route-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/delivery-queue-route.test.ts:cleanup' });
});

describe('GET /delivery-queue', () => {
  it('returns zeros when no DB exists yet', async () => {
    const app = express();
    app.get('/delivery-queue', buildHandler(stateDir, agentId));
    const res = await request(app).get('/delivery-queue');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ depth: 0, oldest_age_seconds: 0, by_state: {} });
  });

  it('returns depth and per-state counts after enqueue', async () => {
    const store = PendingRelayStore.open(agentId, stateDir);
    store.enqueue({
      delivery_id: '11111111-1111-4111-8111-111111111111',
      topic_id: 1,
      text_hash: 'a'.repeat(64),
      text: Buffer.from('hello', 'utf-8'),
      http_code: 503,
      attempted_port: 4042,
    });
    store.enqueue({
      delivery_id: '22222222-2222-4222-8222-222222222222',
      topic_id: 2,
      text_hash: 'b'.repeat(64),
      text: Buffer.from('world', 'utf-8'),
      http_code: 503,
      attempted_port: 4042,
    });
    store.transition('22222222-2222-4222-8222-222222222222', 'delivered-recovered');
    store.close();

    const app = express();
    app.get('/delivery-queue', buildHandler(stateDir, agentId));
    const res = await request(app).get('/delivery-queue');
    expect(res.status).toBe(200);
    expect(res.body.depth).toBe(2);
    expect(res.body.by_state).toEqual({
      queued: 1,
      'delivered-recovered': 1,
    });
    expect(typeof res.body.oldest_age_seconds).toBe('number');
  });
});
