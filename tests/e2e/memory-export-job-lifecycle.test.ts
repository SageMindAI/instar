/**
 * E2E tests — Memory Export Job full lifecycle.
 *
 * Tests the complete production lifecycle:
 *   1. Fresh install includes memory-export job in jobs.json
 *   2. Export produces valid MEMORY.md with correct structure
 *   3. Multiple domains produce correct heading hierarchy
 *   4. Export with custom agent name personalizes the output
 *   5. Forgetting entities produces updated export
 *   6. File is overwritten on re-export (not appended)
 *   7. Export metadata (entityCount, domainCount, tokens) is accurate
 *   8. Empty SemanticMemory produces valid minimal export
 *   9. Low-confidence entities are excluded
 *  10. Export file is usable as context (correct markdown structure)
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
import { refreshHooksAndSettings } from '../../src/commands/init.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('Memory Export Job lifecycle (E2E)', () => {
  let tmpDir: string;
  let stateDir: string;
  let semanticMemory: SemanticMemory;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'e2e-mem-export';
  let memoryMdPath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-export-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    memoryMdPath = path.join(stateDir, 'MEMORY.md');

    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Write config and initial files
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'e2e-export', agentName: 'E2E Agent', authToken: AUTH_TOKEN })
    );
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), '[]');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# E2E Export Test\n');

    // Refresh to populate defaults
    refreshHooksAndSettings(tmpDir, stateDir);

    semanticMemory = new SemanticMemory({
      dbPath: path.join(stateDir, 'semantic.db'),
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await semanticMemory.open();

    const config: InstarConfig = {
      projectName: 'e2e-export',
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

  async function seedEntity(data: Record<string, unknown>): Promise<string> {
    const res = await request(app)
      .post('/semantic/remember')
      .set(auth())
      .send({ source: 'e2e-test', ...data });
    expect(res.status).toBe(200);
    return res.body.id;
  }

  async function exportMemory(opts: Record<string, unknown> = {}) {
    return request(app)
      .post('/semantic/export-memory')
      .set(auth())
      .send({ filePath: memoryMdPath, agentName: 'E2E Agent', ...opts });
  }

  // 1. Fresh install includes the job
  it('jobs.json includes memory-export after refresh', () => {
    const jobsPath = path.join(stateDir, 'jobs.json');
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    const slugs = jobs.map((j: any) => j.slug);
    expect(slugs).toContain('memory-export');
  });

  // 2. Seed entities and export
  it('seeds entities and exports valid MEMORY.md', async () => {
    await seedEntity({
      name: 'Docker Compose', type: 'tool',
      content: 'Multi-container orchestration for dev environments.',
      confidence: 0.92, domain: 'infrastructure', tags: ['docker', 'dev'],
    });
    await seedEntity({
      name: 'Portal Backend', type: 'project',
      content: 'Express API with Prisma ORM for Portal.',
      confidence: 0.88, domain: 'backend', tags: ['portal', 'api'],
    });
    await seedEntity({
      name: 'Justin', type: 'person',
      content: 'Founder and primary collaborator. Sets direction.',
      confidence: 0.99, domain: 'relationships', tags: ['founder'],
    });
    await seedEntity({
      name: 'Always Verify', type: 'lesson',
      content: 'Never trust cached data without verification.',
      confidence: 0.85, domain: 'development', tags: ['best-practice'],
    });

    const res = await exportMemory();
    expect(res.status).toBe(200);
    expect(res.body.entityCount).toBe(4);
    expect(fs.existsSync(memoryMdPath)).toBe(true);
  });

  // 3. Correct heading hierarchy across domains
  it('produces correct domain heading hierarchy', () => {
    const content = fs.readFileSync(memoryMdPath, 'utf-8');

    // H1 for agent name
    expect(content).toMatch(/^# E2E Agent Memory/);

    // H2 for each domain
    expect(content).toContain('## Infrastructure');
    expect(content).toContain('## Development');
    expect(content).toContain('## Backend');
    expect(content).toContain('## Relationships');

    // Domain ordering: infrastructure < development < backend < relationships
    const infraIdx = content.indexOf('## Infrastructure');
    const devIdx = content.indexOf('## Development');
    const backendIdx = content.indexOf('## Backend');
    const relIdx = content.indexOf('## Relationships');

    expect(infraIdx).toBeLessThan(devIdx);
    expect(devIdx).toBeLessThan(backendIdx);
    expect(backendIdx).toBeLessThan(relIdx);
  });

  // 4. Custom agent name
  it('custom agent name personalizes the export', async () => {
    const customPath = path.join(tmpDir, 'custom-memory.md');
    const res = await request(app)
      .post('/semantic/export-memory')
      .set(auth())
      .send({ filePath: customPath, agentName: 'Dawn' });

    expect(res.status).toBe(200);
    const content = fs.readFileSync(customPath, 'utf-8');
    expect(content).toContain('# Dawn Memory');
    expect(content).not.toContain('# E2E Agent Memory');
  });

  // 5. Forgetting entities updates export
  it('export reflects entity removal', async () => {
    // Add then remove an entity
    const id = await seedEntity({
      name: 'Temporary Tool', type: 'tool',
      content: 'Will be removed.',
      confidence: 0.7, domain: 'infrastructure', tags: [],
    });

    // Export should include it
    let res = await exportMemory();
    expect(res.body.entityCount).toBe(5);
    expect(res.body.markdown).toContain('Temporary Tool');

    // Forget it
    await request(app)
      .delete(`/semantic/forget/${id}`)
      .set(auth());

    // Re-export should not include it
    res = await exportMemory();
    expect(res.body.entityCount).toBe(4);
    expect(res.body.markdown).not.toContain('Temporary Tool');
  });

  // 6. File is overwritten, not appended
  it('re-export overwrites the file completely', async () => {
    const res1 = await exportMemory();
    const size1 = fs.statSync(memoryMdPath).size;

    // Add more entities
    await seedEntity({
      name: 'Extra Entity', type: 'fact',
      content: 'An additional fact for testing.',
      confidence: 0.6, domain: 'development', tags: [],
    });

    const res2 = await exportMemory();
    const content = fs.readFileSync(memoryMdPath, 'utf-8');

    // Should have exactly ONE H1 header (not two from append)
    const h1Count = (content.match(/^# /gm) || []).length;
    expect(h1Count).toBe(1);

    // Entity count should be 5 (not 4 + 5 from append)
    expect(res2.body.entityCount).toBe(5);
  });

  // 7. Metadata accuracy
  it('export metadata is accurate', async () => {
    const res = await exportMemory();

    expect(res.body.entityCount).toBe(5);
    expect(res.body.domainCount).toBeGreaterThanOrEqual(3);
    expect(res.body.estimatedTokens).toBe(Math.ceil(res.body.markdown.length / 4));
    expect(res.body.filePath).toBe(memoryMdPath);
    expect(res.body.fileSizeBytes).toBeGreaterThan(0);
  });

  // 8. Empty memory produces minimal valid export
  it('empty SemanticMemory produces valid minimal export', async () => {
    // Forget all entities
    const exportData = semanticMemory.export();
    for (const entity of exportData.entities) {
      await request(app)
        .delete(`/semantic/forget/${entity.id}`)
        .set(auth());
    }

    const res = await exportMemory();
    expect(res.status).toBe(200);
    expect(res.body.entityCount).toBe(0);
    expect(res.body.markdown).toContain('# E2E Agent Memory');

    const content = fs.readFileSync(memoryMdPath, 'utf-8');
    // Should still be valid markdown
    expect(content.startsWith('#')).toBe(true);
  });

  // 9. Low-confidence entities excluded
  it('excludes entities below confidence threshold', async () => {
    // Re-seed with mixed confidence
    await seedEntity({
      name: 'High Confidence', type: 'fact',
      content: 'Very sure about this.',
      confidence: 0.95, domain: 'development', tags: [],
    });
    await seedEntity({
      name: 'Very Low Confidence', type: 'fact',
      content: 'Barely remember this.',
      confidence: 0.1, domain: 'development', tags: [],
    });

    const res = await exportMemory({ minConfidence: 0.5 });
    expect(res.body.markdown).toContain('High Confidence');
    expect(res.body.markdown).not.toContain('Very Low Confidence');
    expect(res.body.excludedCount).toBeGreaterThan(0);
  });

  // 10. File structure is valid for context injection
  it('exported file has proper markdown structure for context injection', async () => {
    // Use default confidence
    const res = await exportMemory({ minConfidence: 0.2 });
    const content = res.body.markdown as string;
    const lines = content.split('\n');

    // Starts with H1
    expect(lines[0]).toMatch(/^# /);

    // Has H2 sections
    const h2Lines = lines.filter(l => l.startsWith('## '));
    expect(h2Lines.length).toBeGreaterThan(0);

    // Has entity content (H3 or H4)
    const h34Lines = lines.filter(l => l.startsWith('### ') || l.startsWith('#### '));
    expect(h34Lines.length).toBeGreaterThan(0);

    // Has footer
    expect(content).toContain('Auto-generated from SemanticMemory');
    expect(content).toContain('Last generated:');
  });
});
