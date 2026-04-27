/**
 * E2E test — Autonomous Evolution full lifecycle.
 *
 * Tests the complete autonomous evolution journey:
 *   Evaluate proposal → create sidecar → apply → notify →
 *   revert → verify state persistence
 *
 * Covers scope classification, sidecar file management,
 * notification contract, and conversational revert.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { AutonomousEvolution } from '../../src/core/AutonomousEvolution.js';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import { TrustElevationTracker } from '../../src/core/TrustElevationTracker.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createRoutes } from '../../src/server/routes.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('E2E: Autonomous Evolution Lifecycle', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-autoevo-e2e-'));
    stateDir = path.join(projectDir, '.instar');

    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      projectName: 'autoevo-e2e',
      autonomyProfile: 'autonomous',
    }));

    const config: InstarConfig = {
      projectDir,
      stateDir,
      projectName: 'autoevo-e2e',
      agentName: 'test-agent',
      autonomyProfile: 'autonomous',
    } as InstarConfig;

    const state = new StateManager(stateDir);
    const autonomyManager = new AutonomyProfileManager({ stateDir, config });
    const autonomousEvolution = new AutonomousEvolution({ stateDir, enabled: true });
    const trustElevationTracker = new TrustElevationTracker({ stateDir });

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
      workingMemory: null,
      quotaManager: null,
      systemReviewer: null,
      capabilityMapper: null,
      topicResumeMap: null,
      autonomyManager,
      trustElevationTracker,
      autonomousEvolution,
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

  // ── Phase 1: Evaluate Safe Proposal ────────────────────────────

  it('evaluates safe proposal for auto-implementation', async () => {
    const res = await fetch(`${baseUrl}/autonomy/evolution/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        review: {
          decision: 'approve',
          reason: 'Safe definedSteps change',
          affectedFields: ['definedSteps'],
          confidence: 0.92,
        },
      }),
    });

    const body = await res.json();
    expect(body.action).toBe('auto-implement');
    expect(body.scope).toBe('safe');
    expect(body.autonomousMode).toBe(true);
  });

  // ── Phase 2: Evaluate Unsafe Proposal ──────────────────────────

  it('blocks unsafe proposal even in autonomous mode', async () => {
    const res = await fetch(`${baseUrl}/autonomy/evolution/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        review: {
          decision: 'approve',
          reason: 'Schedule change',
          affectedFields: ['schedule', 'model'],
          confidence: 0.88,
        },
      }),
    });

    const body = await res.json();
    expect(body.action).toBe('queue-for-approval');
    expect(body.scope).toBe('unsafe');
  });

  // ── Phase 3: Create Sidecar ────────────────────────────────────

  it('creates sidecar file for job changes', async () => {
    const res = await fetch(`${baseUrl}/autonomy/evolution/sidecar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobSlug: 'health-check',
        proposalId: 'EVO-042',
        changes: { definedSteps: ['check-redis', 'check-db'] },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);

    // Verify sidecar file on disk
    const sidecarPath = path.join(stateDir, 'state', 'jobs', 'health-check.proposed-changes.json');
    expect(fs.existsSync(sidecarPath)).toBe(true);
    const sidecarData = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    expect(sidecarData.changes.definedSteps).toEqual(['check-redis', 'check-db']);
  });

  // ── Phase 4: Verify Dashboard Shows Pending ────────────────────

  it('dashboard shows pending sidecar', async () => {
    const res = await fetch(`${baseUrl}/autonomy/evolution`);
    const body = await res.json();

    expect(body.pendingSidecars).toHaveLength(1);
    expect(body.pendingSidecars[0].proposalId).toBe('EVO-042');
    expect(body.appliedSidecars).toHaveLength(0);
  });

  // ── Phase 5: Apply Sidecar ─────────────────────────────────────

  it('applies pending sidecar', async () => {
    const res = await fetch(`${baseUrl}/autonomy/evolution/sidecar/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: 'EVO-042' }),
    });

    const body = await res.json();
    expect(body.applied).toBe(true);

    // Dashboard should now show it as applied
    const dashRes = await fetch(`${baseUrl}/autonomy/evolution`);
    const dash = await dashRes.json();
    expect(dash.pendingSidecars).toHaveLength(0);
    expect(dash.appliedSidecars).toHaveLength(1);
  });

  // ── Phase 6: Revert Sidecar ────────────────────────────────────

  it('reverts applied sidecar', async () => {
    const res = await fetch(`${baseUrl}/autonomy/evolution/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: 'EVO-042' }),
    });

    const body = await res.json();
    expect(body.reverted).toBe(true);

    // Sidecar file should be removed
    const sidecarPath = path.join(stateDir, 'state', 'jobs', 'health-check.proposed-changes.json');
    expect(fs.existsSync(sidecarPath)).toBe(false);

    // Dashboard should show reverted
    const dashRes = await fetch(`${baseUrl}/autonomy/evolution`);
    const dash = await dashRes.json();
    expect(dash.appliedSidecars).toHaveLength(0);
    expect(dash.revertedSidecars).toHaveLength(1);
  });

  // ── Phase 7: Multiple Sidecars for Different Jobs ──────────────

  it('manages multiple sidecars across jobs', async () => {
    // Create sidecars for two different jobs
    await fetch(`${baseUrl}/autonomy/evolution/sidecar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobSlug: 'email-check',
        proposalId: 'EVO-043',
        changes: { definedSteps: ['parse-headers'] },
      }),
    });

    await fetch(`${baseUrl}/autonomy/evolution/sidecar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobSlug: 'health-check',
        proposalId: 'EVO-044',
        changes: { description: 'Updated health check' },
      }),
    });

    const dashRes = await fetch(`${baseUrl}/autonomy/evolution`);
    const dash = await dashRes.json();
    expect(dash.pendingSidecars).toHaveLength(2);

    // Apply one, verify the other is still pending
    await fetch(`${baseUrl}/autonomy/evolution/sidecar/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: 'EVO-043' }),
    });

    const dashRes2 = await fetch(`${baseUrl}/autonomy/evolution`);
    const dash2 = await dashRes2.json();
    expect(dash2.pendingSidecars).toHaveLength(1);
    expect(dash2.appliedSidecars).toHaveLength(1);
  });

  // ── Phase 8: Notification Drain ────────────────────────────────

  it('drains notification queue cleanly', async () => {
    // Drain whatever might be in the queue
    const drainRes = await fetch(`${baseUrl}/autonomy/evolution/notifications/drain`, {
      method: 'POST',
    });
    const drainBody = await drainRes.json();
    expect(typeof drainBody.drained).toBe('number');

    // Second drain should be empty
    const drain2Res = await fetch(`${baseUrl}/autonomy/evolution/notifications/drain`, {
      method: 'POST',
    });
    const drain2Body = await drain2Res.json();
    expect(drain2Body.drained).toBe(0);
  });

  // ── Phase 9: Mixed Scope Evaluation ────────────────────────────

  it('correctly evaluates mixed scope proposals', async () => {
    const res = await fetch(`${baseUrl}/autonomy/evolution/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        review: {
          decision: 'approve',
          reason: 'Mixed changes',
          affectedFields: ['definedSteps', 'schedule'],
          confidence: 0.85,
        },
      }),
    });

    const body = await res.json();
    expect(body.action).toBe('queue-for-approval');
    expect(body.scope).toBe('mixed');
  });

  // ── Phase 10: State Persistence ────────────────────────────────

  it('state persists to disk', () => {
    const stateFile = path.join(stateDir, 'state', 'autonomous-evolution.json');
    expect(fs.existsSync(stateFile)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(raw.appliedSidecars).toBeInstanceOf(Array);
    expect(raw.pendingSidecars).toBeInstanceOf(Array);
  });

  it('state survives manager recreation', () => {
    const newAE = new AutonomousEvolution({ stateDir, enabled: true });
    const dashboard = newAE.getDashboard();

    // Should still have the applied sidecar from Phase 7 (EVO-043)
    // and the pending one (EVO-044)
    expect(dashboard.appliedSidecars.length + dashboard.pendingSidecars.length).toBeGreaterThan(0);
  });
});
