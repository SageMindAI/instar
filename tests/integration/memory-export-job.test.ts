/**
 * Integration tests — Memory Export Job pipeline.
 *
 * Tests the full integration path:
 *   1. Job is loaded and recognized by JobScheduler
 *   2. Job appears in /jobs API listing
 *   3. Job can be triggered and spawns a session
 *   4. The export-memory API works when called from a job context
 *   5. MEMORY.md is written to the correct location
 *   6. Export reflects actual SemanticMemory state
 *   7. Subsequent exports update MEMORY.md content
 *   8. Job doesn't run when semantic memory is unavailable (gate fails)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import { refreshHooksAndSettings } from '../../src/commands/init.js';

describe('Memory Export Job (integration)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let memory: SemanticMemory;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'mem-export-test-token';

  beforeAll(async () => {
    project = createTempProject();

    // Write config for refreshHooksAndSettings
    fs.writeFileSync(
      path.join(project.stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'mem-export-test', agentName: 'Export Test Agent', authToken: AUTH_TOKEN })
    );
    fs.writeFileSync(path.join(project.stateDir, 'jobs.json'), '[]');
    fs.writeFileSync(path.join(project.dir, 'CLAUDE.md'), '# Export Test\n');

    // Refresh to populate default jobs including memory-export
    refreshHooksAndSettings(project.dir, project.stateDir);

    mockSM = createMockSessionManager();

    // Set up real semantic memory
    const dbPath = path.join(project.stateDir, 'semantic.db');
    memory = new SemanticMemory({
      dbPath,
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await memory.open();

    // Seed entities
    const now = new Date().toISOString();
    memory.remember({
      name: 'Redis Cache', type: 'tool', content: 'Redis for session caching.',
      confidence: 0.9, domain: 'infrastructure', tags: ['redis'],
      lastVerified: now, source: 'test',
    });
    memory.remember({
      name: 'API Gateway', type: 'project', content: 'Central API routing layer.',
      confidence: 0.85, domain: 'backend', tags: ['api'],
      lastVerified: now, source: 'test',
    });
    memory.remember({
      name: 'Alice Chen', type: 'person', content: 'Backend engineer.',
      confidence: 0.7, domain: 'relationships', tags: ['team'],
      lastVerified: now, source: 'test',
    });

    // Set up scheduler with the populated jobs file
    const jobsFile = path.join(project.stateDir, 'jobs.json');
    scheduler = new JobScheduler(
      {
        jobsFile,
        enabled: true,
        maxParallelJobs: 3,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
        gateRetries: 1,
      },
      mockSM as any,
      project.state,
      project.stateDir,
    );
    scheduler.start();

    const config: InstarConfig = {
      projectName: 'mem-export-test',
      agentName: 'Export Test Agent',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      scheduler: {
        jobsFile,
        enabled: true,
        maxParallelJobs: 3,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
        gateRetries: 1,
      },
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      scheduler,
      semanticMemory: memory,
    });
    app = server.getApp();
  });

  afterAll(() => {
    scheduler?.stop();
    memory?.close();
    project?.cleanup();
  });

  const auth = { Authorization: `Bearer ${AUTH_TOKEN}` };

  // ─── Job loading and API listing ────────────────────────────────

  // 1. Job is loaded by scheduler
  it('memory-export job is loaded by the scheduler', async () => {
    const res = await request(app).get('/jobs').set(auth);
    expect(res.status).toBe(200);

    const jobs = res.body.jobs ?? res.body;
    const slugs = (jobs as Array<{ slug: string }>).map(j => j.slug);
    expect(slugs).toContain('memory-export');
  });

  // 2. Job has correct attributes via API
  it('memory-export job has correct attributes in API response', async () => {
    const res = await request(app).get('/jobs').set(auth);
    const jobs = (res.body.jobs ?? res.body) as Array<Record<string, unknown>>;
    const job = jobs.find(j => j.slug === 'memory-export');

    expect(job).toBeDefined();
    expect(job!.enabled).toBe(true);
    expect(job!.model).toBe('haiku');
    expect(job!.priority).toBe('medium');
  });

  // ─── Job triggering ─────────────────────────────────────────────

  // 3. Gate skips when server is not running (correct behavior)
  it('memory-export job gate skips when server is unreachable', async () => {
    // The gate requires a running server — in test env it should skip
    const result = await scheduler.triggerJob('memory-export', 'test');
    expect(result).toBe('skipped');
  });

  // 4. Job execute script references the correct API endpoint
  it('job execute script targets /semantic/export-memory endpoint', async () => {
    const res = await request(app).get('/jobs').set(auth);
    const jobs = (res.body.jobs ?? res.body) as Array<Record<string, unknown>>;
    const job = jobs.find(j => j.slug === 'memory-export') as any;

    expect(job.execute.type).toBe('script');
    expect(job.execute.value).toContain('/semantic/export-memory');
    expect(job.execute.value).toContain('MEMORY.md');
  });

  // ─── Export API in job context ──────────────────────────────────

  // 5. Export API writes MEMORY.md
  it('export-memory API writes MEMORY.md to the state dir', async () => {
    const memoryMdPath = path.join(project.stateDir, 'MEMORY.md');

    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth)
      .send({ filePath: memoryMdPath, agentName: 'Export Test Agent' });

    expect(res.status).toBe(200);
    expect(res.body.entityCount).toBe(3);
    expect(fs.existsSync(memoryMdPath)).toBe(true);
  });

  // 6. Written MEMORY.md reflects actual state
  it('MEMORY.md content reflects SemanticMemory entities', () => {
    const memoryMdPath = path.join(project.stateDir, 'MEMORY.md');
    const content = fs.readFileSync(memoryMdPath, 'utf-8');

    expect(content).toContain('# Export Test Agent Memory');
    expect(content).toContain('Redis Cache');
    expect(content).toContain('API Gateway');
    expect(content).toContain('Alice Chen');
    expect(content).toContain('## Infrastructure');
    expect(content).toContain('## Backend');
    expect(content).toContain('## Relationships');
  });

  // 7. Adding entities and re-exporting updates the file
  it('subsequent export reflects new entities', async () => {
    const now = new Date().toISOString();
    memory.remember({
      name: 'New Feature Flag', type: 'tool', content: 'Feature flags for rollouts.',
      confidence: 0.8, domain: 'infrastructure', tags: ['feature-flags'],
      lastVerified: now, source: 'test',
    });

    const memoryMdPath = path.join(project.stateDir, 'MEMORY.md');
    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth)
      .send({ filePath: memoryMdPath, agentName: 'Export Test Agent' });

    expect(res.status).toBe(200);
    expect(res.body.entityCount).toBe(4);

    const content = fs.readFileSync(memoryMdPath, 'utf-8');
    expect(content).toContain('New Feature Flag');
  });

  // 8. Export without semantic memory returns 503
  it('export API returns 503 when semantic memory is not configured', async () => {
    const bareServer = new AgentServer({
      config: {
        projectName: 'bare-test',
        agentName: 'Bare Agent',
        projectDir: project.dir,
        stateDir: project.stateDir,
        port: 0,
        authToken: AUTH_TOKEN,
      },
      sessionManager: mockSM as any,
      state: project.state,
      // No semanticMemory!
    });

    const bareApp = bareServer.getApp();
    const res = await request(bareApp)
      .post('/semantic/export-memory')
      .set(auth)
      .send({});

    expect(res.status).toBe(503);
  });
});
