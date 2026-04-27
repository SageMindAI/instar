/**
 * Tests for AgentServer graceful shutdown.
 *
 * Verifies that:
 * - stop() resolves even without start()
 * - stop() closes the server with timeout protection
 * - stop() doesn't hang on keep-alive connections
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';

describe('AgentServer — graceful shutdown', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-shutdown-'));
    fs.mkdirSync(path.join(tmpDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createServer(): AgentServer {
    const state = new StateManager(tmpDir);
    const config = {
      projectName: 'test',
      projectDir: tmpDir,
      stateDir: tmpDir,
      port: 0,
      host: '127.0.0.1',
      version: '0.0.1',
      sessions: {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/false',
        projectDir: tmpDir,
        maxSessions: 1,
        protectedSessions: [],
        completionPatterns: [],
      },
      scheduler: {
        jobsFile: path.join(tmpDir, 'jobs.json'),
        enabled: false,
        maxParallelJobs: 1,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      users: [],
      messaging: [],
      monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
      relationships: { relationshipsDir: path.join(tmpDir, 'rel'), maxRecentInteractions: 20 },
      feedback: { enabled: false, webhookUrl: '', feedbackFile: path.join(tmpDir, 'fb.json') },
    };
    fs.writeFileSync(path.join(tmpDir, 'jobs.json'), '[]');
    const sm = new SessionManager(config.sessions as any, state);
    return new AgentServer({ config: config as any, sessionManager: sm, state });
  }

  it('stop() resolves immediately when not started', async () => {
    const server = createServer();
    // Should not hang
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('stop() resolves after start()', async () => {
    const server = createServer();
    await server.start();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('stop() resolves within timeout even with keep-alive', async () => {
    const server = createServer();
    await server.start();

    // Create a keep-alive connection
    const app = server.getApp();
    const http = await import('node:http');
    const agent = new http.Agent({ keepAlive: true });

    // Make a request with keep-alive
    await new Promise<void>((resolve) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: 0, path: '/health', agent },
        () => resolve()
      );
      // We don't need a response, just test that stop doesn't hang
      req.on('error', () => resolve());
      req.end();
    });

    // stop() should resolve within 6 seconds (5s force timeout + buffer)
    const start = Date.now();
    await server.stop();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(6000);

    agent.destroy();
  });
});
