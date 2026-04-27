/**
 * Route-level test for POST /health/degradations/mark-reported (PR0c —
 * context-death-pitfall-prevention spec). Mirrors the buildApp pattern
 * used elsewhere in tests/unit/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { Router } from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

function buildApp(): { server: Server; port: number } {
  const app = express();
  app.use(express.json());
  const router = Router();

  router.post('/health/degradations/mark-reported', (req, res) => {
    const reporter = DegradationReporter.getInstance();
    const { feature, featurePattern } = req.body ?? {};
    if (typeof feature === 'string' && feature.length > 0) {
      const flipped = reporter.markReported(feature);
      res.json({ flipped });
      return;
    }
    if (typeof featurePattern === 'string' && featurePattern.length > 0) {
      let re: RegExp;
      try {
        re = new RegExp(featurePattern);
      } catch (err) {
        res.status(400).json({
          error: 'invalid featurePattern',
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const flipped = reporter.markReported(re);
      res.json({ flipped });
      return;
    }
    res.status(400).json({ error: 'feature or featurePattern required' });
  });

  app.use(router);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

describe('POST /health/degradations/mark-reported', () => {
  let handle: { server: Server; port: number } | null = null;
  let tmpDir: string;

  beforeEach(() => {
    DegradationReporter.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-reported-route-'));
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 't', instarVersion: '0' });
    reporter.report({
      feature: 'unjustifiedStopGate.timeout',
      primary: 'p',
      fallback: 'f',
      reason: 'r',
      impact: 'i',
    });
    reporter.report({
      feature: 'unjustifiedStopGate.malformed',
      primary: 'p',
      fallback: 'f',
      reason: 'r',
      impact: 'i',
    });
  });

  afterEach(() => {
    if (handle) handle.server.close();
    handle = null;
    DegradationReporter.resetForTesting();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flips by exact feature name', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/health/degradations/mark-reported`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: 'unjustifiedStopGate.timeout' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ flipped: 1 });
  });

  it('flips multiple via featurePattern regex', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/health/degradations/mark-reported`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featurePattern: '^unjustifiedStopGate\\.' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).flipped).toBe(2);
  });

  it('returns 400 when neither feature nor featurePattern is provided', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/health/degradations/mark-reported`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid featurePattern regex', async () => {
    handle = buildApp();
    const res = await fetch(`http://127.0.0.1:${handle.port}/health/degradations/mark-reported`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featurePattern: '[unterminated' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid featurePattern/);
  });

  it('idempotent: re-flipping returns 0', async () => {
    handle = buildApp();
    const url = `http://127.0.0.1:${handle.port}/health/degradations/mark-reported`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: 'unjustifiedStopGate.timeout' }),
    });
    const second = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: 'unjustifiedStopGate.timeout' }),
    });
    expect((await second.json()).flipped).toBe(0);
  });
});
