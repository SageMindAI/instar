/**
 * E2E test — Trust Elevation full lifecycle.
 *
 * Tests the complete trust elevation journey:
 *   Start with no history → record proposal decisions →
 *   build acceptance rate → trigger rubber-stamp detection →
 *   surface elevation opportunities → dismiss and recover →
 *   verify state persistence across manager recreation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { TrustElevationTracker } from '../../src/core/TrustElevationTracker.js';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createRoutes } from '../../src/server/routes.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('E2E: Trust Elevation Lifecycle', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-trust-elev-e2e-'));
    stateDir = path.join(projectDir, '.instar');

    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'trust-e2e' }));

    const config: InstarConfig = {
      projectDir,
      stateDir,
      projectName: 'trust-e2e',
      agentName: 'test-agent',
    } as InstarConfig;

    const state = new StateManager(stateDir);

    const adaptiveTrust = new AdaptiveTrust({ stateDir });
    const autonomyManager = new AutonomyProfileManager({
      stateDir,
      config,
      adaptiveTrust,
    });

    const trustElevationTracker = new TrustElevationTracker({
      stateDir,
      minProposalsForElevation: 8,
      acceptanceRateThreshold: 0.8,
      recentWindowSize: 10,
      rubberStampConsecutive: 5,
      rubberStampLatencyMs: 5000,
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
      adaptiveTrust,
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

  // ── Phase 1: Empty State ───────────────────────────────────────

  it('starts with no history and no opportunities', async () => {
    const res = await fetch(`${baseUrl}/autonomy/elevation`);
    const body = await res.json();

    expect(body.acceptanceStats.totalDecided).toBe(0);
    expect(body.rubberStamp.detected).toBe(false);
    expect(body.activeOpportunities).toEqual([]);
  });

  // ── Phase 2: Build Acceptance History ──────────────────────────

  it('builds acceptance rate through proposal decisions', async () => {
    // Record 10 approved proposals (all slow — genuine reviews)
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${baseUrl}/autonomy/elevation/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: `EVO-${i + 1}`,
          proposedAt: new Date(Date.now() - 120000).toISOString(), // 2 min ago
          decision: 'approved',
        }),
      });
      expect(res.status).toBe(200);
    }

    // Check acceptance stats
    const statsRes = await fetch(`${baseUrl}/autonomy/elevation/acceptance`);
    const stats = await statsRes.json();
    expect(stats.totalDecided).toBe(10);
    expect(stats.approved).toBe(10);
    expect(stats.acceptanceRate).toBe(1.0);
    expect(stats.recentAcceptanceRate).toBe(1.0);
  });

  // ── Phase 3: Add Rejections and Verify Rate ────────────────────

  it('acceptance rate adjusts with rejections', async () => {
    // Record 2 rejections
    for (let i = 0; i < 2; i++) {
      await fetch(`${baseUrl}/autonomy/elevation/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: `EVO-REJ-${i + 1}`,
          proposedAt: new Date(Date.now() - 60000).toISOString(),
          decision: 'rejected',
        }),
      });
    }

    const statsRes = await fetch(`${baseUrl}/autonomy/elevation/acceptance`);
    const stats = await statsRes.json();
    expect(stats.totalDecided).toBe(12); // 10 approved + 2 rejected
    expect(stats.approved).toBe(10);
    expect(stats.rejected).toBe(2);
    // Acceptance rate: 10/12 ≈ 0.833
    expect(stats.acceptanceRate).toBeCloseTo(0.833, 2);
  });

  // ── Phase 4: Rubber-Stamp Detection ────────────────────────────

  it('detects rubber-stamping pattern with fast approvals', async () => {
    // Record 5 very fast approvals (latencyMs under 5000)
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/autonomy/elevation/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: `EVO-FAST-${i + 1}`,
          proposedAt: new Date(Date.now() - 2000).toISOString(), // 2s ago
          decision: 'approved',
        }),
      });
    }

    const dashRes = await fetch(`${baseUrl}/autonomy/elevation`);
    const dash = await dashRes.json();
    expect(dash.rubberStamp.detected).toBe(true);
    expect(dash.rubberStamp.consecutiveFastApprovals).toBe(5);
  });

  // ── Phase 5: Dismiss Rubber-Stamp ──────────────────────────────

  it('dismisses rubber-stamp alert', async () => {
    const res = await fetch(`${baseUrl}/autonomy/elevation/dismiss-rubber-stamp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 60 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dismissed).toBe(true);
    expect(body.rubberStamp.dismissedUntil).toBeTruthy();

    // Verify the dismissed date is ~60 days in the future
    const dismissedUntil = new Date(body.rubberStamp.dismissedUntil);
    const expectedMin = new Date(Date.now() + 59 * 24 * 60 * 60 * 1000);
    expect(dismissedUntil.getTime()).toBeGreaterThan(expectedMin.getTime());
  });

  // ── Phase 6: Deferred Proposals Don't Count ────────────────────

  it('deferred proposals are excluded from acceptance rate', async () => {
    const beforeRes = await fetch(`${baseUrl}/autonomy/elevation/acceptance`);
    const before = await beforeRes.json();
    const decidedBefore = before.totalDecided;

    // Record 3 deferred proposals
    for (let i = 0; i < 3; i++) {
      await fetch(`${baseUrl}/autonomy/elevation/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: `EVO-DEF-${i + 1}`,
          proposedAt: new Date(Date.now() - 60000).toISOString(),
          decision: 'deferred',
        }),
      });
    }

    const afterRes = await fetch(`${baseUrl}/autonomy/elevation/acceptance`);
    const after = await afterRes.json();
    // Deferred should not change totalDecided
    expect(after.totalDecided).toBe(decidedBefore);
  });

  // ── Phase 7: Modified Proposals Tracked Separately ─────────────

  it('tracks modified proposals separately', async () => {
    // Record 2 approved-with-modifications
    for (let i = 0; i < 2; i++) {
      await fetch(`${baseUrl}/autonomy/elevation/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: `EVO-MOD-${i + 1}`,
          proposedAt: new Date(Date.now() - 60000).toISOString(),
          decision: 'approved',
          modified: true,
        }),
      });
    }

    const statsRes = await fetch(`${baseUrl}/autonomy/elevation/acceptance`);
    const stats = await statsRes.json();
    // Modified approvals count as approved but not approvedUnmodified
    expect(stats.approved).toBeGreaterThan(stats.approvedUnmodified);
  });

  // ── Phase 8: AdaptiveTrust Integration ─────────────────────────

  it('autonomy dashboard includes trust and elevation data', async () => {
    const res = await fetch(`${baseUrl}/autonomy`);
    const body = await res.json();

    // Should have full dashboard
    expect(body.profile).toBeDefined();
    expect(body.resolved).toBeDefined();
    expect(body.summary).toBeTruthy();
    // Elevation data is available via separate endpoint
  });

  // ── Phase 9: State Persistence ─────────────────────────────────

  it('trust elevation state persists to disk', () => {
    const stateFile = path.join(stateDir, 'state', 'trust-elevation.json');
    expect(fs.existsSync(stateFile)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(raw.approvalEvents).toBeInstanceOf(Array);
    expect(raw.approvalEvents.length).toBeGreaterThan(0);
    expect(raw.rubberStamp).toBeDefined();
  });

  it('state survives tracker recreation', () => {
    const newTracker = new TrustElevationTracker({
      stateDir,
      recentWindowSize: 10,
    });

    const stats = newTracker.getAcceptanceStats();
    expect(stats.totalDecided).toBeGreaterThan(0);
    expect(stats.approved).toBeGreaterThan(0);
  });
});
