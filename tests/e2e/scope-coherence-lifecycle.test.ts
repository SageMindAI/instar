/**
 * E2E test — Scope Coherence full lifecycle.
 *
 * Tests the complete PRODUCTION path:
 *   Phase 1: Feature is alive (not 503) — routes return 200
 *   Phase 2: Record actions via API, verify depth increases
 *   Phase 3: Scope doc read resets depth
 *   Phase 4: Checkpoint triggers with job context enrichment
 *   Phase 5: Reset returns to clean state
 *   Phase 6: Hook installation verification
 *
 * Initializes the same way server.ts does — no special wiring.
 * ScopeCoherenceTracker is a pure function of StateManager,
 * so if StateManager is wired, scope coherence works.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('Scope Coherence E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let state: StateManager;
  const AUTH_TOKEN = 'test-e2e-scope';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    state = new StateManager(stateDir);
    const mockSM = createMockSessionManager();

    const config: InstarConfig = {
      projectName: 'test-scope-e2e',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 5000,
      version: '0.9.11',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
      users: [],
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ── Phase 1: Feature is alive ────────────────────────────────────

  describe('Phase 1: Feature is alive (not 503)', () => {
    it('GET /scope-coherence returns 200', async () => {
      const res = await request(app).get('/scope-coherence').set(auth());
      expect(res.status).toBe(200);
    });

    it('POST /scope-coherence/record returns 200', async () => {
      const res = await request(app)
        .post('/scope-coherence/record')
        .set(auth())
        .send({ toolName: 'Edit', toolInput: {} });
      expect(res.status).toBe(200);
    });

    it('GET /scope-coherence/check returns 200', async () => {
      const res = await request(app).get('/scope-coherence/check').set(auth());
      expect(res.status).toBe(200);
    });

    it('POST /scope-coherence/reset returns 200', async () => {
      const res = await request(app).post('/scope-coherence/reset').set(auth());
      expect(res.status).toBe(200);
    });

    it('GET /context/active-job returns 200', async () => {
      const res = await request(app).get('/context/active-job').set(auth());
      expect(res.status).toBe(200);
    });
  });

  // ── Phase 2: Implementation depth tracking ───────────────────────

  describe('Phase 2: Implementation depth accumulates', () => {
    it('tracks depth across multiple Edit/Write/Bash actions', async () => {
      await request(app).post('/scope-coherence/reset').set(auth());

      // Simulate a coding session: edit, write, build
      await request(app).post('/scope-coherence/record').set(auth())
        .send({ toolName: 'Edit', toolInput: { file_path: 'src/router.ts' } });
      await request(app).post('/scope-coherence/record').set(auth())
        .send({ toolName: 'Write', toolInput: { file_path: 'src/handler.ts' } });
      await request(app).post('/scope-coherence/record').set(auth())
        .send({ toolName: 'Bash', toolInput: { command: 'pnpm build && pnpm test' } });
      await request(app).post('/scope-coherence/record').set(auth())
        .send({ toolName: 'Edit', toolInput: { file_path: 'src/router.ts' } });

      const res = await request(app).get('/scope-coherence').set(auth());
      expect(res.body.implementationDepth).toBe(4);
      expect(res.body.lastImplementationTool).toMatch(/^Edit:/);
    });
  });

  // ── Phase 3: Scope doc read reduces depth ────────────────────────

  describe('Phase 3: Scope document reads reduce depth', () => {
    it('reading a spec reduces depth and tracks the doc', async () => {
      await request(app).post('/scope-coherence/reset').set(auth());

      // Build up depth
      for (let i = 0; i < 12; i++) {
        await request(app).post('/scope-coherence/record').set(auth())
          .send({ toolName: 'Edit', toolInput: { file_path: `src/file${i}.ts` } });
      }

      // Read a spec
      await request(app).post('/scope-coherence/record').set(auth())
        .send({ toolName: 'Read', toolInput: { file_path: 'docs/specs/MESSAGING_SPEC.md' } });

      const res = await request(app).get('/scope-coherence').set(auth());
      expect(res.body.implementationDepth).toBe(2); // 12 - 10
      expect(res.body.sessionDocsRead).toContain('docs/specs/MESSAGING_SPEC.md');
      expect(res.body.lastScopeCheck).not.toBeNull();
    });
  });

  // ── Phase 4: Checkpoint trigger with job context ─────────────────

  describe('Phase 4: Checkpoint triggers with active job context', () => {
    it('checkpoint triggers when depth exceeds threshold', async () => {
      await request(app).post('/scope-coherence/reset').set(auth());

      // Build up depth past threshold (default 20)
      for (let i = 0; i < 22; i++) {
        await request(app).post('/scope-coherence/record').set(auth())
          .send({ toolName: 'Edit', toolInput: { file_path: `src/f${i}.ts` } });
      }

      // Set session start to past (avoid min age check)
      const stateData = state.get<Record<string, unknown>>('scope-coherence');
      if (stateData) {
        stateData.sessionStart = new Date(Date.now() - 600000).toISOString(); // 10 min ago
        state.set('scope-coherence', stateData);
      }

      const res = await request(app).get('/scope-coherence/check').set(auth());
      expect(res.body.trigger).toBe(true);
      expect(res.body.depth).toBe(22);
      expect(res.body.jobContext).toBeNull(); // No active job
    });

    it('enriches checkpoint with active job context', async () => {
      await request(app).post('/scope-coherence/reset').set(auth());

      // Set up an active job
      state.set('active-job', {
        slug: 'git-sync',
        name: 'Git Sync',
        description: 'Sync git repos across machines',
        priority: 'medium',
        sessionName: 'job-git-sync-abc',
        triggeredBy: 'cron',
        startedAt: new Date().toISOString(),
      });

      // Build up depth
      for (let i = 0; i < 22; i++) {
        await request(app).post('/scope-coherence/record').set(auth())
          .send({ toolName: 'Edit', toolInput: { file_path: `src/f${i}.ts` } });
      }

      // Set session start to past
      const stateData = state.get<Record<string, unknown>>('scope-coherence');
      if (stateData) {
        stateData.sessionStart = new Date(Date.now() - 600000).toISOString();
        state.set('scope-coherence', stateData);
      }

      const res = await request(app).get('/scope-coherence/check').set(auth());
      expect(res.body.trigger).toBe(true);
      expect(res.body.jobContext).not.toBeNull();
      expect(res.body.jobContext.slug).toBe('git-sync');
      expect(res.body.jobContext.name).toBe('Git Sync');
      expect(res.body.jobContext.description).toBe('Sync git repos across machines');

      // Clean up
      state.delete('active-job');
    });
  });

  // ── Phase 5: Reset returns to clean state ────────────────────────

  describe('Phase 5: Full reset cycle', () => {
    it('reset after deep session returns to zero', async () => {
      // Build up a complex state
      for (let i = 0; i < 10; i++) {
        await request(app).post('/scope-coherence/record').set(auth())
          .send({ toolName: 'Edit', toolInput: { file_path: `src/f${i}.ts` } });
      }
      await request(app).post('/scope-coherence/record').set(auth())
        .send({ toolName: 'Read', toolInput: { file_path: 'docs/ARCHITECTURE.md' } });

      // Reset
      await request(app).post('/scope-coherence/reset').set(auth());

      const res = await request(app).get('/scope-coherence').set(auth());
      expect(res.body.implementationDepth).toBe(0);
      expect(res.body.sessionDocsRead).toEqual([]);
      expect(res.body.checkpointsDismissed).toBe(0);
    });
  });

  // ── Phase 6: Hook installation ───────────────────────────────────

  describe('Phase 6: Hook templates are installable', () => {
    it('PostUpdateMigrator generates scope-coherence-collector.js', () => {
      const migrator = new PostUpdateMigrator({
        projectDir: tmpDir,
        stateDir,
        port: 4040,
        hasTelegram: false,
        projectName: 'test-scope-e2e',
      });

      const content = migrator.getHookContent('scope-coherence-collector');
      expect(content).toContain('Scope Coherence Collector');
      expect(content).toContain('implementationDepth');
      expect(content).toContain('decision');
    });

    it('PostUpdateMigrator generates scope-coherence-checkpoint.js', () => {
      const migrator = new PostUpdateMigrator({
        projectDir: tmpDir,
        stateDir,
        port: 4040,
        hasTelegram: false,
        projectName: 'test-scope-e2e',
      });

      const content = migrator.getHookContent('scope-coherence-checkpoint');
      expect(content).toContain('Scope Coherence Checkpoint');
      expect(content).toContain('SCOPE COHERENCE CHECK');
      expect(content).toContain('active-job');
    });

    it('migrate() installs both scope coherence hook files', () => {
      const migrator = new PostUpdateMigrator({
        projectDir: tmpDir,
        stateDir,
        port: 4040,
        hasTelegram: false,
        projectName: 'test-scope-e2e',
      });

      const result = migrator.migrate();
      expect(result.upgraded).toContain('hooks/instar/scope-coherence-collector.js (implementation depth tracking)');
      expect(result.upgraded).toContain('hooks/instar/scope-coherence-checkpoint.js (scope zoom-out checkpoint)');

      // Verify files exist
      expect(fs.existsSync(path.join(stateDir, 'hooks', 'instar', 'scope-coherence-collector.js'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'hooks', 'instar', 'scope-coherence-checkpoint.js'))).toBe(true);
    });
  });
});
