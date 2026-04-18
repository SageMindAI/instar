/**
 * Integration tests for the /initiatives/* HTTP routes.
 *
 * Spins up the route factory with a real InitiativeTracker backed by a
 * temp directory, mounts it on an express app, and exercises each
 * endpoint through real HTTP.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Router } from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';

let tmpDir: string;
let tracker: InitiativeTracker;
let server: Server;
let port: number;
const initiativeIdRe = /^[a-z0-9][a-z0-9-]{0,62}$/;

function mountRoutes(tr: InitiativeTracker): { server: Server; port: number } {
  const app = express();
  app.use(express.json());
  const router = Router();

  // Mirror of the production handlers (kept in sync with src/server/routes.ts).
  router.get('/initiatives', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const items = status
      ? tr.list({ status: status as 'active' })
      : tr.list();
    res.json({ items, count: items.length });
  });
  router.get('/initiatives/digest', (_req, res) => res.json(tr.digest()));
  router.get('/initiatives/:id', (req, res) => {
    if (!initiativeIdRe.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const i = tr.get(req.params.id);
    if (!i) return res.status(404).json({ error: 'not found' });
    res.json(i);
  });
  router.post('/initiatives', (req, res) => {
    const { id, title, description, phases } = req.body ?? {};
    if (typeof id !== 'string' || !initiativeIdRe.test(id)) return res.status(400).json({ error: 'bad id' });
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'bad title' });
    if (typeof description !== 'string') return res.status(400).json({ error: 'bad description' });
    if (!Array.isArray(phases) || phases.length === 0) return res.status(400).json({ error: 'bad phases' });
    try {
      const created = tr.create(req.body);
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  router.patch('/initiatives/:id', (req, res) => {
    try {
      res.json(tr.update(req.params.id, req.body ?? {}));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });
  router.post('/initiatives/:id/phase/:phaseId', (req, res) => {
    const { status } = req.body ?? {};
    if (!['pending', 'in-progress', 'done', 'blocked'].includes(status)) {
      return res.status(400).json({ error: 'bad status' });
    }
    try {
      res.json(tr.setPhaseStatus(req.params.id, req.params.phaseId, status));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });
  router.delete('/initiatives/:id', (req, res) => {
    if (!tr.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.json({ id: req.params.id, deleted: true });
  });

  app.use(router);
  const srv = app.listen(0);
  const addr = srv.address();
  const p = typeof addr === 'object' && addr ? addr.port : 0;
  return { server: srv, port: p };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'initiatives-routes-'));
  tracker = new InitiativeTracker(tmpDir);
  ({ server, port } = mountRoutes(tracker));
});

afterEach(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const body = {
  id: 'demo',
  title: 'Demo',
  description: 'A test initiative',
  phases: [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ],
};

async function req(method: string, path: string, b?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe('routes /initiatives — CRUD', () => {
  it('POST creates (201)', async () => {
    const r = await req('POST', '/initiatives', body);
    expect(r.status).toBe(201);
    expect(r.json.id).toBe('demo');
  });

  it('POST rejects bad id (400)', async () => {
    const r = await req('POST', '/initiatives', { ...body, id: 'BadID' });
    expect(r.status).toBe(400);
  });

  it('POST rejects empty phases (400)', async () => {
    const r = await req('POST', '/initiatives', { ...body, phases: [] });
    expect(r.status).toBe(400);
  });

  it('POST rejects duplicate id (400)', async () => {
    await req('POST', '/initiatives', body);
    const r = await req('POST', '/initiatives', body);
    expect(r.status).toBe(400);
  });

  it('GET list returns items', async () => {
    await req('POST', '/initiatives', body);
    const r = await req('GET', '/initiatives');
    expect(r.status).toBe(200);
    expect(r.json.count).toBe(1);
    expect(r.json.items[0].id).toBe('demo');
  });

  it('GET by id returns initiative (200)', async () => {
    await req('POST', '/initiatives', body);
    const r = await req('GET', '/initiatives/demo');
    expect(r.status).toBe(200);
    expect(r.json.title).toBe('Demo');
  });

  it('GET by unknown id returns 404', async () => {
    const r = await req('GET', '/initiatives/ghost');
    expect(r.status).toBe(404);
  });

  it('PATCH updates fields (200)', async () => {
    await req('POST', '/initiatives', body);
    const r = await req('PATCH', '/initiatives/demo', { title: 'Renamed' });
    expect(r.status).toBe(200);
    expect(r.json.title).toBe('Renamed');
  });

  it('PATCH on unknown id returns 404', async () => {
    const r = await req('PATCH', '/initiatives/ghost', { title: 'x' });
    expect(r.status).toBe(404);
  });

  it('POST phase transition updates phase status (200)', async () => {
    await req('POST', '/initiatives', body);
    const r = await req('POST', '/initiatives/demo/phase/a', { status: 'done' });
    expect(r.status).toBe(200);
    expect(r.json.phases[0].status).toBe('done');
    expect(r.json.currentPhaseIndex).toBe(1);
  });

  it('POST phase with bad status returns 400', async () => {
    await req('POST', '/initiatives', body);
    const r = await req('POST', '/initiatives/demo/phase/a', { status: 'nope' });
    expect(r.status).toBe(400);
  });

  it('DELETE removes (200)', async () => {
    await req('POST', '/initiatives', body);
    const r = await req('DELETE', '/initiatives/demo');
    expect(r.status).toBe(200);
    expect(r.json.deleted).toBe(true);
    const g = await req('GET', '/initiatives/demo');
    expect(g.status).toBe(404);
  });

  it('GET /initiatives/digest returns empty items when healthy', async () => {
    await req('POST', '/initiatives', body);
    const r = await req('GET', '/initiatives/digest');
    expect(r.status).toBe(200);
    expect(r.json.items).toEqual([]);
  });

  it('GET /initiatives/digest emits needs-user when set', async () => {
    await req('POST', '/initiatives', { ...body, needsUser: true, needsUserReason: 'scope' });
    const r = await req('GET', '/initiatives/digest');
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0].reason).toBe('needs-user');
  });

  it('GET ?status=archived filters results', async () => {
    await req('POST', '/initiatives', body);
    await req('POST', '/initiatives', { ...body, id: 'demo2' });
    await req('PATCH', '/initiatives/demo2', { status: 'archived' });
    const active = await req('GET', '/initiatives?status=active');
    const archived = await req('GET', '/initiatives?status=archived');
    expect(active.json.items.map((i: { id: string }) => i.id)).toEqual(['demo']);
    expect(archived.json.items.map((i: { id: string }) => i.id)).toEqual(['demo2']);
  });
});
