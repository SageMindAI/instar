/**
 * Tests for AgentServer EADDRINUSE handling.
 *
 * Verifies that starting the server on an occupied port
 * produces a clear error message — behavioral test.
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('AgentServer — EADDRINUSE handling', () => {
  let blocker: net.Server | null = null;
  let server: AgentServer | null = null;

  afterEach(async () => {
    if (server) {
      try { await server.stop(); } catch { /* ignore */ }
      server = null;
    }
    if (blocker) {
      await new Promise<void>((resolve) => blocker!.close(() => resolve()));
      blocker = null;
    }
  });

  it('start() rejects with clear message when port is occupied', async () => {
    // Block a random port
    blocker = net.createServer();
    await new Promise<void>((resolve) =>
      blocker!.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (blocker.address() as net.AddressInfo).port;

    // Create a minimal AgentServer targeting that port
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-eaddrinuse-'));
    const state = new StateManager(tmpDir);

    const config = {
      projectName: 'test',
      projectDir: tmpDir,
      stateDir: tmpDir,
      port,
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

    const sm = new SessionManager(config.sessions as any, state);

    server = new AgentServer({
      config: config as any,
      sessionManager: sm,
      state,
    });

    await expect(server.start()).rejects.toThrow(/already in use/i);

    // Clean up
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
