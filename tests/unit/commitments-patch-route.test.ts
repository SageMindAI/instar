/**
 * Server-side tests for PATCH /commitments/:id and GET /commitments/active-context.
 *
 * Stands up an express app with the real router and a minimal RouteContext
 * (only commitmentTracker + auth-bypass wiring) to exercise the validators
 * end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { createRoutes } from '../../src/server/routes.js';

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-patch-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ authToken: 'test' }));
  // safe-git-allow: incremental-migration
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => srv.close(() => r())),
      });
    });
  });
}

function buildApp(tracker: CommitmentTracker): express.Express {
  const app = express();
  app.use(express.json());
  // Minimal ctx — the routes we exercise only touch commitmentTracker and
  // config.authToken. We provide a stub config object for middleware expectations.
  const ctx: any = {
    commitmentTracker: tracker,
    config: { authToken: 'test', stateDir: '/tmp', port: 0 },
    stateDir: '/tmp',
    // Route modules access various optional subsystems via `ctx` — leave them
    // undefined; the commitments routes we test don't touch them.
  };
  const router = createRoutes(ctx);
  app.use(router);
  return app;
}

describe('PATCH /commitments/:id + active-context', () => {
  let dir: string; let cleanup: () => void;
  let tracker: CommitmentTracker;
  let server: Server;

  beforeEach(async () => {
    ({ dir, cleanup } = tmpState());
    tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
    server = await listen(buildApp(tracker));
  });
  afterEach(async () => { await server.close(); cleanup(); });

  async function api(path: string, init?: RequestInit) {
    const res = await fetch(server.url + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  it('PATCH updates nextUpdateDueAt via mutate surface', async () => {
    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y',
      topicId: 1, beaconEnabled: true,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    const r = await api(`/commitments/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ nextUpdateDueAt: '2099-06-01T00:00:00Z', cadenceMs: 90_000 }),
    });
    expect(r.status).toBe(200);
    expect(r.body.nextUpdateDueAt).toBe('2099-06-01T00:00:00Z');
    expect(r.body.cadenceMs).toBe(90_000);
    // Version must have bumped (CAS invariant).
    expect(typeof r.body.version).toBe('number');
    expect(r.body.version).toBeGreaterThan(0);
  });

  it('PATCH rejects unknown fields with 400', async () => {
    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y',
      topicId: 1, beaconEnabled: true, nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    const r = await api(`/commitments/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'violated' }),
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/Unknown field/);
  });

  it('PATCH rejects clearing all deadline markers when beaconEnabled stays true', async () => {
    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y',
      topicId: 1, beaconEnabled: true, nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    const r = await api(`/commitments/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ nextUpdateDueAt: null }),
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/at least one of nextUpdateDueAt/);
  });

  it('PATCH on terminal commitment returns 409', async () => {
    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y',
      topicId: 1, beaconEnabled: true, nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    tracker.deliver(c.id, 'msg-1');
    const r = await api(`/commitments/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ cadenceMs: 60_000 }),
    });
    expect(r.status).toBe(409);
  });

  it('PATCH rejects non-numeric cadenceMs', async () => {
    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y',
      topicId: 1, beaconEnabled: true, nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    const r = await api(`/commitments/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ cadenceMs: 'fast' }),
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/cadenceMs/);
  });

  it('GET /commitments/active-context emits a bounded <active_commitments> snippet', async () => {
    for (let i = 0; i < 23; i++) {
      tracker.record({
        type: 'one-time-action', userRequest: `r${i}`, agentResponse: `a${i}`,
        topicId: 100 + i, beaconEnabled: true,
        nextUpdateDueAt: '2099-01-01T00:00:00Z',
      });
    }
    const r = await api('/commitments/active-context');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(23);
    expect(r.body.shown).toBe(20);
    expect(r.body.snippet).toContain('<active_commitments>');
    expect(r.body.snippet).toContain('+ 3 more');
    expect(r.body.snippet).toContain('</active_commitments>');
    // The JSON body should include 20 entries.
    const match = r.body.snippet.match(/\[.*\]/s);
    expect(match).toBeTruthy();
    const arr = JSON.parse(match![0]);
    expect(arr.length).toBe(20);
    // Shape check.
    expect(arr[0]).toHaveProperty('id');
    expect(arr[0]).toHaveProperty('promiseText');
    expect(arr[0]).toHaveProperty('nextUpdateDueAt');
    expect(arr[0]).toHaveProperty('atRisk');
  });
});
