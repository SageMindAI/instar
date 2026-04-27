/**
 * E2E test — Adaptive Autonomy full lifecycle.
 *
 * Tests the complete autonomy journey:
 *   Initialize with default profile → query dashboard via API →
 *   progress through all profile levels → verify state persistence →
 *   configure notifications → verify natural language summaries →
 *   regress on trust loss → recover
 *
 * Uses real filesystem, real HTTP server, real AutonomyProfileManager.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createRoutes } from '../../src/server/routes.js';
import type { InstarConfig, AutonomyProfileLevel } from '../../src/core/types.js';

describe('E2E: Adaptive Autonomy Lifecycle', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let baseUrl: string;
  let autonomyManager: AutonomyProfileManager;

  beforeAll(async () => {
    // Create real project structure
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-autonomy-e2e-'));
    stateDir = path.join(projectDir, '.instar');

    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Write config.json (simulates instar init output)
    const configJson = {
      projectName: 'autonomy-e2e',
      agentName: 'test-agent',
      agentAutonomy: { level: 'collaborative' },
    };
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(configJson, null, 2));

    const config: InstarConfig = {
      projectDir,
      stateDir,
      projectName: 'autonomy-e2e',
      agentName: 'test-agent',
      agentAutonomy: { level: 'collaborative' },
    } as InstarConfig;

    const state = new StateManager(stateDir);

    autonomyManager = new AutonomyProfileManager({
      stateDir,
      config,
    });

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

  // ── Phase 1: Initial State ─────────────────────────────────────

  it('starts with collaborative profile (default)', async () => {
    const res = await fetch(`${baseUrl}/autonomy`);
    const body = await res.json();

    expect(body.profile).toBe('collaborative');
    expect(body.resolved.evolutionApprovalMode).toBe('ai-assisted');
    expect(body.resolved.autoApplyUpdates).toBe(true);
    expect(body.resolved.autoRestart).toBe(true);
    expect(body.resolved.trustAutoElevate).toBe(true);
  });

  // ── Phase 2: Full Profile Progression ──────────────────────────

  it('progresses cautious -> supervised -> collaborative -> autonomous', async () => {
    const progression: Array<{
      level: AutonomyProfileLevel;
      expectedEvolution: string;
      expectedSafety: number;
    }> = [
      { level: 'cautious', expectedEvolution: 'ai-assisted', expectedSafety: 1 },
      { level: 'supervised', expectedEvolution: 'ai-assisted', expectedSafety: 1 },
      { level: 'collaborative', expectedEvolution: 'ai-assisted', expectedSafety: 1 },
      { level: 'autonomous', expectedEvolution: 'autonomous', expectedSafety: 2 },
    ];

    for (const step of progression) {
      const setRes = await fetch(`${baseUrl}/autonomy/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: step.level, reason: `Progressing to ${step.level}` }),
      });
      expect(setRes.status).toBe(200);

      const setBody = await setRes.json();
      expect(setBody.profile).toBe(step.level);
      expect(setBody.resolved.evolutionApprovalMode).toBe(step.expectedEvolution);
      expect(setBody.resolved.safetyLevel).toBe(step.expectedSafety);

      // Verify via GET
      const getRes = await fetch(`${baseUrl}/autonomy`);
      const getBody = await getRes.json();
      expect(getBody.profile).toBe(step.level);
    }
  });

  // ── Phase 3: History Tracking ──────────────────────────────────

  it('records complete history of profile changes', async () => {
    const res = await fetch(`${baseUrl}/autonomy/history`);
    const body = await res.json();

    expect(body.history.length).toBeGreaterThanOrEqual(4); // At least the 4 progression changes
    // Verify last entry
    const last = body.history[body.history.length - 1];
    expect(last.to).toBe('autonomous');
    expect(last.reason).toContain('autonomous');
    expect(last.at).toBeTruthy();
  });

  // ── Phase 4: Trust Loss & Recovery ─────────────────────────────

  it('handles trust regression (autonomous -> cautious)', async () => {
    // Currently autonomous
    let dashRes = await fetch(`${baseUrl}/autonomy`);
    let dashBody = await dashRes.json();
    expect(dashBody.profile).toBe('autonomous');

    // Regress to cautious (simulating trust loss)
    const regRes = await fetch(`${baseUrl}/autonomy/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'cautious', reason: 'Incident: trust lost' }),
    });
    expect(regRes.status).toBe(200);

    // Verify regression applied
    dashRes = await fetch(`${baseUrl}/autonomy`);
    dashBody = await dashRes.json();
    expect(dashBody.profile).toBe('cautious');
    expect(dashBody.resolved.autoApplyUpdates).toBe(false);
    expect(dashBody.resolved.autoRestart).toBe(false);
    expect(dashBody.resolved.trustAutoElevate).toBe(false);
    // Config override (agentAutonomy.level: 'collaborative') takes precedence over
    // cautious profile default of 'supervised' — this is correct behavior
    expect(dashBody.resolved.agentAutonomyLevel).toBe('collaborative');
  });

  // ── Phase 5: Notification Configuration ────────────────────────

  it('configures and persists notification preferences', async () => {
    // Set digest mode
    const patchRes = await fetch(`${baseUrl}/autonomy/notifications`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evolutionDigest: 'daily',
        trustElevationSuggestions: false,
      }),
    });
    expect(patchRes.status).toBe(200);

    const patchBody = await patchRes.json();
    expect(patchBody.notifications.evolutionDigest).toBe('daily');
    expect(patchBody.notifications.trustElevationSuggestions).toBe(false);

    // Verify persisted via dashboard
    const dashRes = await fetch(`${baseUrl}/autonomy`);
    const dashBody = await dashRes.json();
    expect(dashBody.notifications.evolutionDigest).toBe('daily');
    expect(dashBody.notifications.trustElevationSuggestions).toBe(false);
  });

  // ── Phase 6: Natural Language Summary ──────────────────────────

  it('summary reflects current state accurately', async () => {
    // Set to supervised for a clear summary
    await fetch(`${baseUrl}/autonomy/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'supervised', reason: 'Summary test' }),
    });

    const res = await fetch(`${baseUrl}/autonomy/summary`);
    const body = await res.json();

    expect(body.summary).toContain('supervised');
    expect(body.summary).toContain('ai-assisted');
    expect(body.summary).toContain('auto-apply on');
    expect(body.summary).toContain('manual restart');
  });

  // ── Phase 7: Config.json Sync ──────────────────────────────────

  it('profile changes sync to config.json', async () => {
    await fetch(`${baseUrl}/autonomy/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'autonomous', reason: 'Config sync test' }),
    });

    const configPath = path.join(stateDir, 'config.json');
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.autonomyProfile).toBe('autonomous');
  });

  // ── Phase 8: State Persistence Across Manager Instances ────────

  it('state survives manager recreation (simulating server restart)', async () => {
    // Set a specific state
    await fetch(`${baseUrl}/autonomy/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'collaborative', reason: 'Restart test' }),
    });

    await fetch(`${baseUrl}/autonomy/notifications`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evolutionDigest: 'hourly' }),
    });

    // Create a new manager pointing to same state dir (simulates restart)
    const newManager = new AutonomyProfileManager({
      stateDir,
      config: {
        projectDir,
        stateDir,
        projectName: 'autonomy-e2e',
        agentName: 'test-agent',
      } as InstarConfig,
    });

    expect(newManager.getProfile()).toBe('collaborative');
    expect(newManager.getNotificationPreferences().evolutionDigest).toBe('hourly');
    expect(newManager.getHistory().length).toBeGreaterThan(0);
  });

  // ── Phase 9: Error Handling ────────────────────────────────────

  it('rejects all invalid inputs gracefully', async () => {
    // Invalid profile
    const r1 = await fetch(`${baseUrl}/autonomy/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'super-autonomous' }),
    });
    expect(r1.status).toBe(400);

    // Empty body
    const r2 = await fetch(`${baseUrl}/autonomy/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r2.status).toBe(400);
  });
});
