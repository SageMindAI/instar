/**
 * Tests for the /internal/* bearer-auth + X-Forwarded-For rejection
 * added in PR3 (context-death-pitfall-prevention spec § P0.5).
 *
 * Prior behavior: /internal/* routes accepted any localhost request
 * without a bearer token. That left a gap where any local process could
 * flip the stop-gate kill-switch or POST to evaluate. PR3 closes it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import type { Server } from 'node:http';
import { authMiddleware } from '../../src/server/middleware.js';

const TOKEN = 'test-token-pr3';

function buildApp(): { app: Application; server: Server; port: number } {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(TOKEN));
  app.get('/internal/stop-gate/hot-path', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { app, server, port };
}

describe('authMiddleware — /internal/* bearer-auth (PR3)', () => {
  let handle: { server: Server; port: number } | null = null;

  afterEach(() => {
    if (handle) handle.server.close();
    handle = null;
  });

  it('rejects /internal/* without Authorization header', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/hot-path`);
    expect(res.status).toBe(401);
  });

  it('rejects /internal/* with wrong token (403 — invalid token, per existing middleware convention)', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/hot-path`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(403);
  });

  it('accepts /internal/* with correct bearer token', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/hot-path`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('rejects /internal/* with X-Forwarded-For header set (tunnel defense)', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/hot-path`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Forwarded-For': '1.2.3.4',
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/X-Forwarded-For/);
  });

  it('/health remains public (no bearer required)', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
  });
});
