import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

// Test the /internal/telegram-forward version handshake logic by wiring
// up a tiny router that mirrors the real server's handler structure.
// We don't need the whole createRoutes() entrypoint here — we verify the
// handshake policy in isolation.

import { parseVersion, compareVersions } from '../../../src/lifeline/versionHandshake.js';

function buildHandler(serverVersion: string, authToken: string) {
  const parsed = parseVersion(serverVersion);
  return (req: express.Request, res: express.Response) => {
    if (!parsed) {
      res.status(503).json({ ok: false, reason: 'server-boot-incomplete', retryAfterMs: 1000 });
      return;
    }
    const { lifelineVersion } = req.body;
    if (lifelineVersion !== undefined && authToken) {
      const clientVersion = parseVersion(lifelineVersion);
      if (!clientVersion) {
        res.status(400).json({ ok: false, error: 'invalid lifelineVersion' });
        return;
      }
      const decision = compareVersions(parsed, clientVersion);
      if (decision.kind === 'upgrade-required') {
        res.status(426).json({
          ok: false,
          upgradeRequired: true,
          serverVersion: decision.serverVersionString,
          action: 'restart',
          reason: 'major-minor-mismatch',
        });
        return;
      }
    }
    res.json({ ok: true, forwarded: true });
  };
}

async function postBody(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

describe('/internal/telegram-forward — version handshake', () => {
  let server: import('node:http').Server;
  let port = 0;

  async function startServer(serverVersion: string, authToken = 'test-token') {
    const app = express();
    app.use(express.json());
    app.post('/internal/telegram-forward', buildHandler(serverVersion, authToken));
    return new Promise<void>(resolve => {
      server = app.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  beforeEach(() => {
    if (server) server.close();
  });

  it('accepts forward when lifelineVersion matches server', async () => {
    await startServer('1.2.3');
    const url = `http://127.0.0.1:${port}/internal/telegram-forward`;
    const r = await postBody(url, { lifelineVersion: '1.2.3', topicId: 1, text: 'hi' });
    expect(r.status).toBe(200);
  });

  it('returns 426 on MAJOR mismatch with reconstructed serverVersion', async () => {
    await startServer('2.0.5');
    const url = `http://127.0.0.1:${port}/internal/telegram-forward`;
    const r = await postBody(url, { lifelineVersion: '1.0.5', topicId: 1, text: 'hi' });
    expect(r.status).toBe(426);
    expect(r.body.upgradeRequired).toBe(true);
    expect(r.body.serverVersion).toBe('2.0.5');
    expect(r.body.action).toBe('restart');
  });

  it('returns 426 on MINOR mismatch', async () => {
    await startServer('1.3.0');
    const url = `http://127.0.0.1:${port}/internal/telegram-forward`;
    const r = await postBody(url, { lifelineVersion: '1.2.99', topicId: 1, text: 'hi' });
    expect(r.status).toBe(426);
  });

  it('returns 400 on malformed lifelineVersion', async () => {
    await startServer('1.2.3');
    const url = `http://127.0.0.1:${port}/internal/telegram-forward`;
    const r = await postBody(url, { lifelineVersion: 'not-semver', topicId: 1, text: 'hi' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid lifelineVersion');
  });

  it('returns 400 on over-long lifelineVersion (never reflects raw input)', async () => {
    await startServer('1.2.3');
    const url = `http://127.0.0.1:${port}/internal/telegram-forward`;
    const huge = '1.2.3-' + 'a'.repeat(200);
    const r = await postBody(url, { lifelineVersion: huge, topicId: 1, text: 'hi' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('aaa'); // no echo
  });

  it('accepts forward when lifelineVersion absent (backward compat)', async () => {
    await startServer('1.2.3');
    const url = `http://127.0.0.1:${port}/internal/telegram-forward`;
    const r = await postBody(url, { topicId: 1, text: 'hi' });
    expect(r.status).toBe(200);
  });

  it('accepts forward when authToken is empty (dev-mode — no version leak)', async () => {
    await startServer('1.2.3', '');
    const url = `http://127.0.0.1:${port}/internal/telegram-forward`;
    const r = await postBody(url, { lifelineVersion: '2.0.0', topicId: 1, text: 'hi' });
    // In dev-mode, handshake is skipped — no 426 leak of serverVersion.
    expect(r.status).toBe(200);
  });

  it('heterogeneous rollout (AC25): old server that ignores unknown field accepts cleanly', async () => {
    // Model: a pre-Stage-B server. Its handler has no knowledge of
    // `lifelineVersion` and JSON-parses it into an unused field.
    const app = express();
    app.use(express.json());
    app.post('/internal/telegram-forward', (req, res) => {
      const { topicId, text } = req.body;
      if (!topicId || !text) return void res.status(400).json({ error: 'topicId and text required' });
      // Pre-Stage-B: no handshake, just accept.
      res.json({ ok: true, forwarded: true });
    });
    const s = await new Promise<import('node:http').Server>(resolve => {
      const srv = app.listen(0, () => resolve(srv));
    });
    const p = (s.address() as AddressInfo).port;
    const r = await postBody(`http://127.0.0.1:${p}/internal/telegram-forward`, {
      lifelineVersion: '0.28.66',
      topicId: 1,
      text: 'hi',
    });
    expect(r.status).toBe(200);
    s.close();
  });

  it('returns 503 when serverVersion fails to parse', async () => {
    await startServer('not-a-version');
    const url = `http://127.0.0.1:${port}/internal/telegram-forward`;
    const r = await postBody(url, { lifelineVersion: '1.2.3', topicId: 1, text: 'hi' });
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe('server-boot-incomplete');
    expect(r.body.retryAfterMs).toBeGreaterThan(0);
  });
});
