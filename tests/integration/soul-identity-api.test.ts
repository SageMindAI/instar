/**
 * Integration tests for the /identity API routes.
 *
 * Tests the full HTTP contract: request validation, trust enforcement,
 * pending queue, drift analysis, and integrity checks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import { SoulManager } from '../../src/core/SoulManager.js';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { generateSoulMd } from '../../src/scaffold/templates.js';
import { createRoutes } from '../../src/server/routes.js';
import type { InstarConfig } from '../../src/core/types.js';

let projectDir: string;
let stateDir: string;
let server: Server;
let baseUrl: string;
let soulManager: SoulManager;
let autonomyManager: AutonomyProfileManager;

describe('Identity / Soul API Routes', () => {
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-soul-api-'));
    stateDir = path.join(projectDir, '.instar');

    // Create directory structure
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ projectName: 'soul-test', autonomyProfile: 'collaborative' }),
    );

    // Write AGENT.md
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# TestAgent\n\n## Who I Am\n\nTest agent.');

    // Initialize soul.md
    soulManager = new SoulManager({ stateDir });
    const soulContent = generateSoulMd('TestAgent', 'Thorough and direct.', '2026-03-14');
    soulManager.initialize(soulContent);

    const config: InstarConfig = {
      projectDir,
      stateDir,
      projectName: 'soul-test',
      agentName: 'TestAgent',
      autonomyProfile: 'collaborative',
    } as InstarConfig;

    const state = new StateManager(stateDir);
    autonomyManager = new AutonomyProfileManager({ stateDir, config });

    const app = express();
    app.use(express.json());

    const router = createRoutes({
      config,
      state,
      sessionManager: null as any,
      scheduler: null,
      telegram: null,
      relationships: null,
      feedback: null,
      dispatches: null,
      updateChecker: null,
      autoUpdater: null,
      autoDispatcher: null,
      quotaTracker: null,
      publisher: null,
      viewer: null,
      tunnel: null,
      evolution: null,
      watchdog: null,
      triageNurse: null,
      topicMemory: null,
      feedbackAnomalyDetector: null,
      projectMapper: null,
      coherenceGate: null,
      contextHierarchy: null,
      canonicalState: null,
      operationGate: null,
      sentinel: null,
      adaptiveTrust: null,
      memoryMonitor: null,
      orphanReaper: null,
      coherenceMonitor: null,
      commitmentTracker: null,
      semanticMemory: null,
      activitySentinel: null,
      messageRouter: null,
      summarySentinel: null,
      spawnManager: null,
      workingMemory: null,
      quotaManager: null,
      systemReviewer: null,
      capabilityMapper: null,
      selfKnowledgeTree: null,
      coverageAuditor: null,
      topicResumeMap: null,
      autonomyManager,
      trustElevationTracker: null,
      autonomousEvolution: null,
      whatsapp: null,
      messageBridge: null,
      hookEventReceiver: null,
      worktreeMonitor: null,
      subagentTracker: null,
      instructionsVerifier: null,
      threadlineRouter: null,
      handshakeManager: null,
      threadlineRelayClient: null,
      listenerManager: null,
      responseReviewGate: null,
      telemetryHeartbeat: null,
      pasteManager: null,
      wsManager: null,
      soulManager,
      discoveryEvaluator: null,
      startTime: new Date(),
    });

    app.use(router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe('GET /identity', () => {
    it('returns combined identity overview', async () => {
      const res = await fetch(`${baseUrl}/identity`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.agentName).toBe('soul-test');
      expect(body.soulEnabled).toBe(true);
      expect(body.soul).toContain('Personality Seed');
      expect(body.soul).toContain('Core Values');
      // Should NOT include sensitive sections
      expect(body.soul).not.toContain('Convictions');
      expect(body.soul).not.toContain('Open Questions');
    });
  });

  describe('GET /identity/soul', () => {
    it('returns full soul.md content', async () => {
      const res = await fetch(`${baseUrl}/identity/soul`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.content).toContain('# Soul');
      expect(body.content).toContain('Thorough and direct.');
      expect(body.content).toContain('Convictions');
    });
  });

  describe('PATCH /identity/soul', () => {
    it('applies valid write at collaborative trust', async () => {
      const res = await fetch(`${baseUrl}/identity/soul`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section: 'integrations',
          operation: 'append',
          content: '### 2026-03-14: API Test\nThis came from an API test.',
          source: 'inline',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('applied');
      expect(body.section).toBe('integrations');
    });

    it('rejects invalid section', async () => {
      const res = await fetch(`${baseUrl}/identity/soul`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section: 'invalid-section',
          operation: 'append',
          content: 'test',
          source: 'inline',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects empty content', async () => {
      const res = await fetch(`${baseUrl}/identity/soul`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section: 'core-values',
          operation: 'replace',
          content: '',
          source: 'inline',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects oversized content', async () => {
      const res = await fetch(`${baseUrl}/identity/soul`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section: 'core-values',
          operation: 'replace',
          content: 'x'.repeat(10001),
          source: 'inline',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects invalid operation', async () => {
      const res = await fetch(`${baseUrl}/identity/soul`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section: 'core-values',
          operation: 'destroy',
          content: 'test',
          source: 'inline',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /identity/soul/drift', () => {
    it('returns drift analysis', async () => {
      const res = await fetch(`${baseUrl}/identity/soul/drift`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.initSnapshotExists).toBe(true);
      expect(body.sections).toBeInstanceOf(Array);
      expect(body.sections.length).toBeGreaterThan(0);
    });
  });

  describe('GET /identity/soul/integrity', () => {
    it('returns integrity check result', async () => {
      const res = await fetch(`${baseUrl}/identity/soul/integrity`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.valid).toBe(true);
    });
  });

  describe('pending queue API', () => {
    it('lists pending changes', async () => {
      const res = await fetch(`${baseUrl}/identity/soul/pending`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveProperty('pending');
      expect(body).toHaveProperty('count');
    });

    it('returns 404 for non-existent pending ID', async () => {
      const res = await fetch(`${baseUrl}/identity/soul/pending/PND-999/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 for non-existent rejection ID', async () => {
      const res = await fetch(`${baseUrl}/identity/soul/pending/PND-999/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'test' }),
      });

      expect(res.status).toBe(404);
    });
  });
});
