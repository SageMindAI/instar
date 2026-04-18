/**
 * Route-level test for POST /internal/stop-gate/mode (PR4 —
 * context-death-pitfall-prevention spec rollout).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { Router } from 'express';
import type { Server } from 'node:http';
import { getMode, setMode, _resetForTests } from '../../src/server/stopGate.js';

function buildApp(): { server: Server; port: number } {
  const app = express();
  app.use(express.json());
  const router = Router();

  router.post('/internal/stop-gate/mode', (req, res) => {
    const mode = req.body?.mode;
    if (mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
      res.status(400).json({ error: 'mode must be off | shadow | enforce' });
      return;
    }
    const prior = getMode();
    setMode(mode);
    res.json({ mode, prior, changed: prior !== mode });
  });

  app.use(router);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

describe('POST /internal/stop-gate/mode — PR4 mode flip', () => {
  let handle: { server: Server; port: number } | null = null;

  beforeEach(() => _resetForTests());
  afterEach(() => {
    if (handle) handle.server.close();
    handle = null;
  });

  it('flips off → shadow', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'shadow' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ mode: 'shadow', prior: 'off', changed: true });
    expect(getMode()).toBe('shadow');
  });

  it('flips shadow → enforce', async () => {
    handle = buildApp();
    setMode('shadow');
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'enforce' }),
    });
    const body = await res.json();
    expect(body).toEqual({ mode: 'enforce', prior: 'shadow', changed: true });
  });

  it('reports changed:false on no-op flip', async () => {
    handle = buildApp();
    setMode('shadow');
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'shadow' }),
    });
    const body = await res.json();
    expect(body.changed).toBe(false);
  });

  it('rejects invalid mode with 400', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'paranoid' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/off \| shadow \| enforce/);
  });

  it('rejects missing mode with 400', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
