/**
 * Route-level tests for the stop-gate endpoints (PR0a — context-death-
 * pitfall-prevention spec).
 *
 * Mirrors the buildApp pattern from routes-prGatePhaseGate.test.ts:
 * mounts a minimal Express app with the same route handlers as the
 * production server uses (importing from src/server/stopGate.js), so we
 * exercise the request/response shape without spinning up the full
 * AgentServer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { Router } from 'express';
import type { Server } from 'node:http';
import {
  GATE_ROUTE_VERSION,
  GATE_ROUTE_MINIMUM_VERSION,
  setMode,
  setKillSwitch,
  recordSessionStart,
  getKillSwitch,
  getHotPathState,
  _resetForTests,
} from '../../src/server/stopGate.js';

function buildApp(): { server: Server; port: number } {
  const app = express();
  app.use(express.json());
  const router = Router();

  router.get('/internal/stop-gate/hot-path', (req, res) => {
    const sessionId = typeof req.query.session === 'string' ? req.query.session : '';
    const state = getHotPathState({
      sessionId: sessionId || undefined,
      // Force a deterministic compactionInFlight=false in tests by
      // pointing at a path that doesn't exist.
      recoveryScriptPath: '/no/such/path/for/test',
      autonomousActiveOverride: false,
    });
    res.json(state);
  });

  router.get('/internal/stop-gate/kill-switch', (_req, res) => {
    res.json({ killSwitch: getKillSwitch() });
  });

  router.post('/internal/stop-gate/kill-switch', (req, res) => {
    const value = req.body?.value;
    if (typeof value !== 'boolean') {
      res.status(400).json({ error: 'value must be boolean' });
      return;
    }
    const prior = setKillSwitch(value);
    res.json({ killSwitch: value, prior, changed: prior !== value });
  });

  app.use(router);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

describe('routes-stopGate — /internal/stop-gate/hot-path', () => {
  let handle: { server: Server; port: number } | null = null;

  beforeEach(() => _resetForTests());
  afterEach(() => {
    if (handle) handle.server.close();
    handle = null;
  });

  it('returns the five-field shape plus routeVersion', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/hot-path?session=sess-x`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      mode: 'off',
      killSwitch: false,
      autonomousActive: false,
      compactionInFlight: false,
      sessionStartTs: null,
      routeVersion: GATE_ROUTE_VERSION,
    });
  });

  it('reflects mode and killSwitch from in-memory state', async () => {
    handle = buildApp();
    setMode('shadow');
    setKillSwitch(true);
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/hot-path?session=sess-x`);
    const body = await res.json();
    expect(body.mode).toBe('shadow');
    expect(body.killSwitch).toBe(true);
  });

  it('returns sessionStartTs when previously recorded for that session', async () => {
    handle = buildApp();
    recordSessionStart('sess-known', 1700123456789);
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/hot-path?session=sess-known`);
    const body = await res.json();
    expect(body.sessionStartTs).toBe(1700123456789);
  });

  it('returns null sessionStartTs for unknown session id', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/hot-path?session=ghost`);
    const body = await res.json();
    expect(body.sessionStartTs).toBeNull();
  });

  it('omitting ?session= still returns a valid hot-path response', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/hot-path`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('off');
    expect(body.sessionStartTs).toBeNull();
  });
});

describe('routes-stopGate — /internal/stop-gate/kill-switch', () => {
  let handle: { server: Server; port: number } | null = null;

  beforeEach(() => _resetForTests());
  afterEach(() => {
    if (handle) handle.server.close();
    handle = null;
  });

  it('GET returns current kill-switch value', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/kill-switch`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.killSwitch).toBe(false);
  });

  it('POST sets kill-switch and returns prior + changed flag', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/kill-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ killSwitch: true, prior: false, changed: true });

    const after = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/kill-switch`);
    expect((await after.json()).killSwitch).toBe(true);
  });

  it('POST returns changed:false on no-op flip', async () => {
    handle = buildApp();
    setKillSwitch(true);
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/kill-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: true }),
    });
    const body = await res.json();
    expect(body).toEqual({ killSwitch: true, prior: true, changed: false });
  });

  it('POST rejects non-boolean value with 400', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/kill-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'true' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/boolean/);
  });

  it('POST rejects missing body with 400', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/kill-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('routes-stopGate — version contract surface', () => {
  it('GATE_ROUTE_MINIMUM_VERSION ≤ GATE_ROUTE_VERSION (no impossible upgrades)', () => {
    expect(GATE_ROUTE_MINIMUM_VERSION).toBeLessThanOrEqual(GATE_ROUTE_VERSION);
  });
});
