/**
 * E2E test — MemoryExporter full production lifecycle.
 *
 * Tests the complete PRODUCTION path for MEMORY.md generation:
 *   1. SemanticMemory populated with entities across multiple domains
 *   2. POST /semantic/export-memory generates correct markdown
 *   3. Export with filePath writes to disk
 *   4. Generated markdown groups by domain and type correctly
 *   5. Confidence filtering works through the full stack
 *   6. Entity changes are reflected in subsequent exports
 *   7. Custom agent name flows through to output
 *   8. Footer includes entity count and domain count
 *   9. Round-trip: entities → export → verify structure
 *  10. Empty export after forget-all produces minimal output
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('MemoryExporter E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let semanticMemory: SemanticMemory;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-e2e-exporter';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exporter-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    semanticMemory = new SemanticMemory({
      dbPath: path.join(stateDir, 'semantic.db'),
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await semanticMemory.open();

    const config: InstarConfig = {
      projectName: 'exporter-e2e',
      agentName: 'E2E Agent',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
    };

    const mockSM = createMockSessionManager();
    const state = new StateManager(stateDir);

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
      semanticMemory,
    });

    app = server.getApp();
  });

  afterAll(() => {
    semanticMemory?.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // Helper to seed via API (auto-fills source)
  async function seedEntity(data: Record<string, unknown>): Promise<string> {
    const res = await request(app)
      .post('/semantic/remember')
      .set(auth())
      .send({ source: 'e2e-test', ...data });
    expect(res.status).toBe(200);
    return res.body.id;
  }

  // 1. Populate entities across domains
  it('seeds entities across multiple domains', async () => {
    await seedEntity({
      name: 'Vercel Deploy', type: 'tool',
      content: 'Vercel for production deployments.',
      confidence: 0.9, domain: 'infrastructure', tags: ['vercel', 'deploy'],
    });
    await seedEntity({
      name: 'Prisma ORM', type: 'tool',
      content: 'Prisma for database access.',
      confidence: 0.85, domain: 'backend', tags: ['prisma', 'database'],
    });
    await seedEntity({
      name: 'Justin Headley', type: 'person',
      content: 'Founder and primary collaborator.',
      confidence: 0.99, domain: 'relationships', tags: ['founder'],
    });
    await seedEntity({
      name: 'Portal Project', type: 'project',
      content: 'AI chatbot platform with consciousness features.',
      confidence: 0.95, domain: 'development', tags: ['portal', 'ai'],
    });
    await seedEntity({
      name: 'DRY Principle', type: 'pattern',
      content: 'Do not repeat yourself.',
      confidence: 0.7, domain: 'development', tags: ['best-practice'],
    });
    await seedEntity({
      name: 'General Knowledge', type: 'fact',
      content: 'A general fact without domain.',
      confidence: 0.6, tags: ['general'],
    });
    await seedEntity({
      name: 'Almost Forgotten', type: 'fact',
      content: 'Very low confidence.',
      confidence: 0.15, domain: 'development', tags: [],
    });
  });

  // 2. Export generates correct markdown
  it('export generates valid markdown with all included entities', async () => {
    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain('# Agent Memory');
    expect(res.body.entityCount).toBe(6); // 7 seeded, 1 below 0.2 threshold
    expect(res.body.excludedCount).toBe(1);
  });

  // 3. Write to disk
  it('writes MEMORY.md to disk via API', async () => {
    const outPath = path.join(tmpDir, 'output', 'MEMORY.md');

    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth())
      .send({ filePath: outPath });

    expect(res.status).toBe(200);
    expect(fs.existsSync(outPath)).toBe(true);

    const content = fs.readFileSync(outPath, 'utf-8');
    expect(content).toContain('## Infrastructure');
    expect(content).toContain('## Development');
    expect(content).toContain('## Relationships');
  });

  // 4. Domain and type grouping
  it('groups entities by domain and type in correct order', async () => {
    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth())
      .send({});

    const md = res.body.markdown as string;

    // Domain ordering: infrastructure < development < backend < relationships < general
    const infraIdx = md.indexOf('## Infrastructure');
    const devIdx = md.indexOf('## Development');
    const backendIdx = md.indexOf('## Backend');
    const relIdx = md.indexOf('## Relationships');
    const genIdx = md.indexOf('## General Knowledge');

    expect(infraIdx).toBeLessThan(devIdx);
    expect(devIdx).toBeLessThan(backendIdx);
    expect(backendIdx).toBeLessThan(relIdx);
    expect(relIdx).toBeLessThan(genIdx);
  });

  // 5. Confidence filtering
  it('filters low-confidence entities', async () => {
    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth())
      .send({ minConfidence: 0.8 });

    expect(res.status).toBe(200);
    expect(res.body.markdown).not.toContain('Almost Forgotten');
    expect(res.body.markdown).not.toContain('DRY Principle'); // 0.7
    expect(res.body.markdown).toContain('Vercel Deploy'); // 0.9
  });

  // 6. Changes reflected in subsequent exports
  it('reflects new entities in subsequent exports', async () => {
    await seedEntity({
      name: 'New Discovery', type: 'lesson',
      content: 'Learned something new.',
      confidence: 0.88, domain: 'development', tags: ['learning'],
    });

    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth())
      .send({});

    expect(res.body.markdown).toContain('New Discovery');
    expect(res.body.entityCount).toBe(7); // 6 + 1 new
  });

  // 7. Custom agent name
  it('custom agentName flows through to output', async () => {
    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth())
      .send({ agentName: 'Dawn' });

    expect(res.body.markdown).toContain('# Dawn Memory');
    expect(res.body.markdown).not.toContain('# Agent Memory');
  });

  // 8. Footer includes counts
  it('footer includes entity count and domain count', async () => {
    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth())
      .send({});

    const md = res.body.markdown as string;
    expect(md).toContain('entities across');
    expect(md).toContain('domains');
    expect(md).toContain('Last generated:');
  });

  // 9. Round-trip structure verification
  it('exported markdown has correct heading hierarchy', async () => {
    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth())
      .send({});

    const md = res.body.markdown as string;
    const lines = md.split('\n');

    // Should start with H1
    expect(lines[0]).toMatch(/^# /);

    // Should have H2 for domains
    const h2Lines = lines.filter(l => l.startsWith('## '));
    expect(h2Lines.length).toBeGreaterThanOrEqual(4); // infrastructure, development, backend, relationships, general

    // Should have H3 or H4 for entity names
    const h3Lines = lines.filter(l => l.startsWith('### '));
    const h4Lines = lines.filter(l => l.startsWith('#### '));
    expect(h3Lines.length + h4Lines.length).toBeGreaterThan(0);
  });

  // 10. Empty export after forget
  it('produces minimal output when all entities are forgotten', async () => {
    // Get all entity IDs
    const statsRes = await request(app)
      .get('/semantic/stats')
      .set(auth());

    const exportData = semanticMemory.export();
    for (const entity of exportData.entities) {
      await request(app)
        .delete(`/semantic/forget/${entity.id}`)
        .set(auth());
    }

    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.entityCount).toBe(0);
    expect(res.body.markdown).toContain('# Agent Memory');
    expect(res.body.markdown).not.toContain('## Infrastructure');
  });
});
