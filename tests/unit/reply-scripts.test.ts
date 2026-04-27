/**
 * Tests for the messaging reply scripts that ship with every instar agent:
 *   src/templates/scripts/telegram-reply.sh
 *   src/templates/scripts/slack-reply.sh
 *   src/templates/scripts/whatsapp-reply.sh
 *
 * These scripts are the agent's transport to the outbound messaging routes.
 * Their HTTP-code handling defines what the agent "sees" and drives whether
 * it retries. Getting it wrong causes the duplicate-send cascade:
 *   server times out at 30s (408) while tone gate + Telegram API complete
 *   → agent sees non-zero exit + "Failed" message → agent regenerates and retries
 *   → message ships twice.
 *
 * The rule: HTTP 408 on an outbound messaging route means "ambiguous" — the
 * send may have completed server-side. The script must NOT report this as a
 * hard failure (exit 1) or the agent will retry blindly. Instead it exits 0
 * with a loud stderr warning instructing the agent to verify before retrying.
 *
 * HTTP 422 (tone gate block) remains a hard client error — the message truly
 * was not sent. HTTP 5xx and connection failures likewise remain hard errors.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const SCRIPT_DIR = path.join(process.cwd(), 'src/templates/scripts');

interface MockServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
  setResponse: (status: number, body: unknown) => void;
  requestCount: () => number;
}

async function startMockServer(): Promise<MockServer> {
  let currentStatus = 200;
  let currentBody: unknown = { ok: true };
  let requests = 0;

  const server = createServer((req, res) => {
    requests += 1;
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.statusCode = currentStatus;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(currentBody));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Unexpected server address shape');
  const port = addr.port;

  return {
    server,
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    setResponse(status: number, body: unknown) {
      currentStatus = status;
      currentBody = body;
    },
    requestCount() {
      return requests;
    },
  };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Async spawn so the mock server on the same event loop can respond.
// spawnSync would block the loop and cause the in-process server to hang.
async function runScript(script: string, args: string[], port: number, stdin?: string): Promise<RunResult> {
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-script-test-'));
  try {
    return await new Promise<RunResult>((resolve, reject) => {
      const proc = spawn('bash', [path.join(SCRIPT_DIR, script), ...args], {
        cwd: tmpCwd,
        env: { ...process.env, INSTAR_PORT: String(port), PATH: process.env.PATH },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', status => resolve({ status, stdout, stderr }));

      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Script ${script} hung for >10s`));
      }, 10_000);
      proc.on('close', () => clearTimeout(killTimer));

      if (stdin !== undefined) {
        proc.stdin.write(stdin);
      }
      proc.stdin.end();
    });
  } finally {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
}

describe('reply scripts — HTTP 408 handling (ambiguous-outcome)', () => {
  let mock: MockServer;

  beforeAll(async () => { mock = await startMockServer(); });
  afterAll(async () => { await mock.close(); });

  for (const script of ['telegram-reply.sh', 'slack-reply.sh', 'whatsapp-reply.sh']) {
    describe(script, () => {
      it('exits 0 when the server returns 408 (ambiguous outcome — do NOT retry blindly)', async () => {
        mock.setResponse(408, { error: 'Request timeout', timeoutMs: 30000 });
        const target = script.startsWith('whatsapp') ? '12345@s.whatsapp.net' : '42';
        const result = await runScript(script, [target], mock.port, 'hello from test\n');

        expect(result.status).toBe(0);
        // stderr must loudly warn — the agent reads this to decide whether to retry.
        expect(result.stderr.toLowerCase()).toMatch(/ambiguous|timeout|do not retry|verify/);
      });

      it('emits stdout marker distinct from the success "Sent X chars" message', async () => {
        mock.setResponse(408, { error: 'Request timeout', timeoutMs: 30000 });
        const target = script.startsWith('whatsapp') ? '12345@s.whatsapp.net' : '42';
        const result = await runScript(script, [target], mock.port, 'hello from test\n');

        // The success path prints "Sent N chars …". The 408 path must NOT
        // print that — otherwise a shell pipeline that greps for "Sent" would
        // misclassify the ambiguous outcome as success.
        expect(result.stdout.toLowerCase()).not.toMatch(/^sent \d+ chars/m);
        // It must still produce *some* stdout marker so the agent's tool-use
        // path doesn't see "empty output" and retry.
        expect(result.stdout.length).toBeGreaterThan(0);
      });
    });
  }
});

describe('reply scripts — existing contract preserved (200, 422, 5xx)', () => {
  let mock: MockServer;

  beforeAll(async () => { mock = await startMockServer(); });
  afterAll(async () => { await mock.close(); });

  for (const script of ['telegram-reply.sh', 'slack-reply.sh', 'whatsapp-reply.sh']) {
    describe(script, () => {
      it('exits 0 and prints "Sent" on HTTP 200', async () => {
        mock.setResponse(200, { ok: true });
        const target = script.startsWith('whatsapp') ? '12345@s.whatsapp.net' : '42';
        const result = await runScript(script, [target], mock.port, 'hello from test\n');

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Sent \d+ chars/);
      });

      it('exits 1 on HTTP 422 with BLOCKED stderr (tone gate still blocks hard)', async () => {
        mock.setResponse(422, {
          error: 'tone-gate-blocked',
          rule: 'B2_FILE_PATH',
          issue: "Literal file paths: 'server.ts'",
          suggestion: 'Describe the location conceptually.',
        });
        const target = script.startsWith('whatsapp') ? '12345@s.whatsapp.net' : '42';
        const result = await runScript(script, [target], mock.port, 'hello from test\n');

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/BLOCKED/);
      });

      it('exits 1 on HTTP 500 (genuine server failure remains a hard failure)', async () => {
        mock.setResponse(500, { error: 'boom' });
        const target = script.startsWith('whatsapp') ? '12345@s.whatsapp.net' : '42';
        const result = await runScript(script, [target], mock.port, 'hello from test\n');

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/HTTP 500|Failed/);
      });
    });
  }
});
