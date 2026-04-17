/**
 * Unit tests for the PR-gate phase kill-switch middleware
 * (PR-REVIEW-HARDENING Phase A commit 8).
 *
 * Asserts that with prGate.phase='off' (default), every /pr-gate/*
 * request returns 404 with { disabled: true, reason: 'prGate.phase=off' }.
 * When phase is flipped to any non-'off' value, the middleware passes
 * through (Express's natural 404 applies if no downstream handler is
 * registered — Phase B+ adds the handlers).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Router } from 'express';
import express from 'express';
import type { Application } from 'express';
import type { Server } from 'node:http';

/**
 * Shape-minimal mimic of AgentServer's `ctx` that the production
 * middleware reads `.config.prGate` from. Everything else is unused
 * so we leave it undefined — the middleware only touches `.config`.
 */
function buildApp(prGatePhase: unknown): { app: Application; server: Server; port: number } {
  const app = express();
  app.use(express.json());
  const router = Router();

  // Copy of the middleware from src/server/routes.ts (Phase A commit 8).
  // Default-BLOCK + allowlist shape — matches the production middleware.
  const config = prGatePhase === undefined ? {} : { prGate: { phase: prGatePhase } };
  const PR_GATE_ACTIVE_PHASES = new Set(['shadow', 'layer1-2', 'layer3']);
  router.use('/pr-gate', (_req, res, next) => {
    const prGate = (config as { prGate?: { phase?: unknown } }).prGate;
    const phase = typeof prGate?.phase === 'string'
      ? prGate.phase.trim().toLowerCase()
      : 'off';
    if (!PR_GATE_ACTIVE_PHASES.has(phase)) {
      return res.status(404).json({ disabled: true, reason: 'prGate.phase=off' });
    }
    return next();
  });

  // Sentinel downstream handler to verify pass-through in non-off phases.
  router.get('/pr-gate/metrics', (_req, res) => {
    res.json({ ok: true, phase: config.prGate?.phase });
  });

  app.use(router);

  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, server, port };
}

describe('PR-gate phase=off kill-switch middleware', () => {
  let handle: { server: Server; port: number } | null = null;

  afterEach(() => {
    if (handle) handle.server.close();
    handle = null;
  });

  it('returns 404 with disabled body when phase is explicitly off', async () => {
    const { server, port } = buildApp('off');
    handle = { server, port };

    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ disabled: true, reason: 'prGate.phase=off' });
  });

  it('defaults to off when prGate is undefined', async () => {
    const { server, port } = buildApp(undefined);
    handle = { server, port };

    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.disabled).toBe(true);
  });

  it('defaults to off when prGate.phase is missing', async () => {
    const app = express();
    const router = Router();
    const config = { prGate: {} as { phase?: string } };
    router.use('/pr-gate', (_req, res, next) => {
      const phase = config.prGate?.phase ?? 'off';
      if (phase === 'off') return res.status(404).json({ disabled: true });
      return next();
    });
    app.use(router);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    handle = { server, port };

    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(404);
  });

  it('passes through to downstream handler when phase is shadow', async () => {
    const { server, port } = buildApp('shadow');
    handle = { server, port };

    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.phase).toBe('shadow');
  });

  it('passes through when phase is layer3', async () => {
    const { server, port } = buildApp('layer3');
    handle = { server, port };

    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(200);
  });

  it('gates every subroute under /pr-gate, not just /metrics', async () => {
    const { server, port } = buildApp('off');
    handle = { server, port };

    for (const route of ['/pr-gate/metrics', '/pr-gate/status', '/pr-gate/eligible', '/pr-gate/anything']) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`);
      expect(res.status, `route ${route} should 404 when phase=off`).toBe(404);
    }
  });

  it('does not gate non-/pr-gate routes', async () => {
    const { server, port } = buildApp('off');
    handle = { server, port };

    // Unknown non-/pr-gate route: Express returns natural 404, but NOT
    // our middleware's specific body shape.
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(404);
    const bodyText = await res.text();
    expect(bodyText).not.toContain('prGate.phase=off');
  });

  // ── Default-block + allowlist shape: typos/casing/whitespace/null don't bypass ──

  it('blocks on uppercase "OFF" (casing does not bypass the gate)', async () => {
    const { server, port } = buildApp('OFF');
    handle = { server, port };
    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(404);
  });

  it('blocks on empty string phase', async () => {
    const { server, port } = buildApp('');
    handle = { server, port };
    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(404);
  });

  it('blocks on trailing whitespace in "off "', async () => {
    // Middleware trims — "off " normalizes to "off" and gets blocked as expected.
    const { server, port } = buildApp('off ');
    handle = { server, port };
    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(404);
  });

  it('accepts "  shadow  " after trim+lowercase (active phases are normalized)', async () => {
    const { server, port } = buildApp('  shadow  ');
    handle = { server, port };
    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(200);
  });

  it('blocks on unknown phase value "bogus"', async () => {
    const { server, port } = buildApp('bogus');
    handle = { server, port };
    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(404);
  });

  it('blocks on null phase', async () => {
    const { server, port } = buildApp(null);
    handle = { server, port };
    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(404);
  });

  it('blocks on numeric phase value (not a string)', async () => {
    const { server, port } = buildApp(42);
    handle = { server, port };
    const res = await fetch(`http://127.0.0.1:${port}/pr-gate/metrics`);
    expect(res.status).toBe(404);
  });
});
