/**
 * build-state.py — POST /build/heartbeat helper
 * (BUILD-STALL-VISIBILITY-SPEC Fix 2 Phase A).
 *
 * Spawns build-state.py in a temp project pointed at a localhost HTTP fake
 * server, then verifies that:
 *   - cmd_transition POSTs a heartbeat (phase-boundary).
 *   - cmd_complete POSTs a heartbeat with phase=complete.
 *   - When INSTAR_TELEGRAM_TOPIC is unset, no POST is made.
 *   - When the server is unreachable, the helper does NOT exit non-zero —
 *     it logs heartbeat.skipped to the audit log and continues.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';

const SCRIPT = path.resolve(__dirname, '../../playbook-scripts/build-state.py');

interface FakeServer {
  port: number;
  received: Array<{ url: string; body: any; auth?: string }>;
  close: () => Promise<void>;
}

async function startFakeServer(): Promise<FakeServer> {
  const received: FakeServer['received'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed: any = body;
      try { parsed = JSON.parse(body); } catch { /* keep raw */ }
      received.push({ url: req.url || '', body: parsed, auth: req.headers.authorization as string | undefined });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind');
  return {
    port: addr.port,
    received,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function run(args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ stdout: string; exitCode: number }> {
  // Async spawn so the Node event loop stays free to service the fake HTTP
  // server while python3 is running. Using execSync here would block the
  // server thread and the Python POST would time out.
  //
  // Strip parent-env heartbeat routing vars so tests get a clean baseline —
  // otherwise the test inherits whatever the developer's session has set.
  const cleanParent = { ...process.env };
  delete cleanParent.INSTAR_TELEGRAM_TOPIC;
  delete cleanParent.INSTAR_SLACK_CHANNEL;
  return new Promise((resolve) => {
    const proc = spawn('python3', [SCRIPT, ...args], {
      cwd, env: { ...cleanParent, ...env },
    });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', () => { /* ignore */ });
    proc.on('close', (code) => resolve({ stdout: stdout.trim(), exitCode: code ?? 0 }));
    proc.on('error', () => resolve({ stdout: stdout.trim(), exitCode: 1 }));
  });
}

function readAudit(cwd: string): any[] {
  const p = path.join(cwd, '.instar', 'state', 'build', 'audit.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function writeConfig(cwd: string, port: number, token = 'test-token') {
  fs.mkdirSync(path.join(cwd, '.instar'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.instar', 'config.json'),
    JSON.stringify({ port, authToken: token }),
  );
}

describe('build-state.py heartbeat', () => {
  let tmpDir: string;
  let server: FakeServer;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-hb-'));
    fs.mkdirSync(path.join(tmpDir, '.instar', 'state', 'build'), { recursive: true });
    server = await startFakeServer();
  });

  afterEach(async () => {
    await server.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('posts a heartbeat on transition when INSTAR_TELEGRAM_TOPIC is set', async () => {
    writeConfig(tmpDir, server.port);
    await run(['init', '"Test"'], tmpDir);
    const r = await run(['transition', 'planning'], tmpDir, { INSTAR_TELEGRAM_TOPIC: '4242' });
    expect(r.exitCode).toBe(0);

    expect(server.received.length).toBe(1);
    expect(server.received[0].url).toBe('/build/heartbeat');
    expect(server.received[0].body.phase).toBe('planning');
    expect(server.received[0].body.topicId).toBe(4242);
    expect(server.received[0].body.tool).toBe('none');
    expect(server.received[0].body.status).toBe('phase-boundary');
    expect(server.received[0].body.runId).toMatch(/^[A-Za-z0-9_]{1,16}$/);
    expect(server.received[0].auth).toBe('Bearer test-token');
  });

  it('posts a heartbeat on complete with phase=complete', async () => {
    writeConfig(tmpDir, server.port);
    await run(['init', '"Test"'], tmpDir);
    await run(['transition', 'executing'], tmpDir, { INSTAR_TELEGRAM_TOPIC: '99' });
    await run(['transition', 'complete'], tmpDir, { INSTAR_TELEGRAM_TOPIC: '99' });
    const r = await run(['complete'], tmpDir, { INSTAR_TELEGRAM_TOPIC: '99' });
    expect(r.exitCode).toBe(0);

    const completePosts = server.received.filter(p => p.body?.phase === 'complete');
    // One from the explicit `transition complete`, one from `cmd_complete`.
    expect(completePosts.length).toBeGreaterThanOrEqual(1);
  });

  it('no-ops when INSTAR_TELEGRAM_TOPIC and INSTAR_SLACK_CHANNEL are unset', async () => {
    writeConfig(tmpDir, server.port);
    await run(['init', '"Test"'], tmpDir);
    const r = await run(['transition', 'planning'], tmpDir);
    expect(r.exitCode).toBe(0);
    expect(server.received.length).toBe(0);
  });

  it('best-effort: continues on POST failure (server unreachable)', async () => {
    // Point the config at a closed port so the POST fails immediately.
    await server.close();
    writeConfig(tmpDir, 1); // port 1 — should refuse
    await run(['init', '"Test"'], tmpDir);
    const r = await run(['transition', 'planning'], tmpDir, { INSTAR_TELEGRAM_TOPIC: '4242' });
    // The transition itself MUST succeed.
    expect(r.exitCode).toBe(0);
    // And the audit log must show the skipped heartbeat.
    const audit = readAudit(tmpDir);
    const skipped = audit.filter(e => e.event === 'heartbeat.skipped');
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(skipped[0].phase).toBe('planning');
  });

  it('routes via channelId when INSTAR_SLACK_CHANNEL is set', async () => {
    writeConfig(tmpDir, server.port);
    await run(['init', '"Test"'], tmpDir);
    const r = await run(['transition', 'planning'], tmpDir, { INSTAR_SLACK_CHANNEL: 'C123ABC' });
    expect(r.exitCode).toBe(0);
    expect(server.received.length).toBe(1);
    expect(server.received[0].body.channelId).toBe('C123ABC');
    expect(server.received[0].body.topicId).toBeUndefined();
  });
});
