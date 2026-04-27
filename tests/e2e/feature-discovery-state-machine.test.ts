/**
 * E2E test — Feature Discovery State Machine (Consent & Discovery Framework, Phase 2).
 *
 * Tests the complete Phase 2 lifecycle:
 *   State transitions with server-side validation → Consent records →
 *   Surface tracking → Discovery event logging → Right to erasure →
 *   Cooldown tracking → Per-user isolation → API endpoints
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import type { ConsentRecord, DiscoveryEvent, TransitionResult } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createRoutes } from '../../src/server/routes.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('E2E: Feature Discovery State Machine', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let baseUrl: string;
  let registry: FeatureRegistry;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feature-sm-e2e-'));
    stateDir = path.join(projectDir, '.instar');

    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'sm-e2e' }));

    const config: InstarConfig = {
      projectDir,
      stateDir,
      projectName: 'sm-e2e',
      agentName: 'test-agent',
      port: 0,
      sessions: { maxConcurrent: 2, defaultModel: 'sonnet' },
      scheduler: { enabled: false },
      users: [],
      messaging: [],
      monitoring: { healthCheck: { enabled: false } },
    } as InstarConfig;

    const state = new StateManager(stateDir);

    registry = new FeatureRegistry(stateDir);
    await registry.open();
    for (const def of BUILTIN_FEATURES) {
      registry.register(def);
    }
    // Don't bootstrap — start from clean state for controlled testing

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
      autonomyManager: null,
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
      soulManager: null,
      featureRegistry: registry,
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
    registry?.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── Phase 2a: Valid Transitions (Direct API) ────────────────────

  it('transitions undiscovered → aware', () => {
    const result = registry.transition('evolution-system', 'default', 'aware', { trigger: 'test' });
    expect(result.success).toBe(true);
    expect(result.previousState).toBe('undiscovered');
    expect(result.newState).toBe('aware');
    expect(result.timestamp).toBeTruthy();
  });

  it('transitions aware → interested', () => {
    const result = registry.transition('evolution-system', 'default', 'interested');
    expect(result.success).toBe(true);
    expect(result.previousState).toBe('aware');
    expect(result.newState).toBe('interested');
  });

  it('transitions interested → enabled (local tier, no consent needed)', () => {
    const result = registry.transition('evolution-system', 'default', 'enabled');
    expect(result.success).toBe(true);
    expect(result.newState).toBe('enabled');

    const state = registry.getState('evolution-system');
    expect(state!.enabled).toBe(true);
  });

  it('transitions enabled → disabled', () => {
    const result = registry.transition('evolution-system', 'default', 'disabled');
    expect(result.success).toBe(true);
    expect(result.newState).toBe('disabled');

    const state = registry.getState('evolution-system');
    expect(state!.enabled).toBe(false);
  });

  it('transitions disabled → enabled (re-enable)', () => {
    const result = registry.transition('evolution-system', 'default', 'enabled');
    expect(result.success).toBe(true);
    expect(result.newState).toBe('enabled');

    const state = registry.getState('evolution-system');
    expect(state!.enabled).toBe(true);
  });

  it('transitions aware → deferred', () => {
    registry.transition('input-guard', 'default', 'aware', { trigger: 'test' });
    const result = registry.transition('input-guard', 'default', 'deferred');
    expect(result.success).toBe(true);
    expect(result.newState).toBe('deferred');
  });

  it('transitions deferred → aware', () => {
    const result = registry.transition('input-guard', 'default', 'aware');
    expect(result.success).toBe(true);
    expect(result.newState).toBe('aware');
  });

  it('transitions aware → declined', () => {
    const result = registry.transition('input-guard', 'default', 'declined');
    expect(result.success).toBe(true);
    expect(result.newState).toBe('declined');

    const state = registry.getState('input-guard');
    expect(state!.lastDeclinedAt).toBeTruthy();
  });

  it('transitions declined → aware (re-surface)', () => {
    const result = registry.transition('input-guard', 'default', 'aware');
    expect(result.success).toBe(true);
    expect(result.newState).toBe('aware');
  });

  // ── Phase 2b: Invalid Transitions ──────────────────────────────

  it('rejects invalid transition undiscovered → enabled', () => {
    const result = registry.transition('publishing-telegraph', 'default', 'enabled');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_TRANSITION');
    expect(result.error?.details?.currentState).toBe('undiscovered');
    expect(result.error?.details?.validTransitions).toEqual(['aware']);
  });

  it('rejects invalid transition undiscovered → declined', () => {
    const result = registry.transition('response-review', 'default', 'declined');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_TRANSITION');
  });

  it('rejects invalid transition aware → enabled (must go through interested)', () => {
    registry.transition('publishing-telegraph', 'default', 'aware', { trigger: 'test' });
    const result = registry.transition('publishing-telegraph', 'default', 'enabled');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_TRANSITION');
    expect(result.error?.details?.validTransitions).toEqual(['interested', 'deferred', 'declined']);
  });

  it('rejects transition for nonexistent feature', () => {
    const result = registry.transition('nonexistent', 'default', 'aware');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FEATURE_NOT_FOUND');
  });

  // ── Phase 2c: Consent Records ──────────────────────────────────

  it('requires consent record for network-tier feature activation', () => {
    // threadline-relay is network tier
    registry.transition('threadline-relay', 'default', 'aware', { trigger: 'test' });
    registry.transition('threadline-relay', 'default', 'interested');

    // Try to enable without consent
    const result = registry.transition('threadline-relay', 'default', 'enabled');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CONSENT_REQUIRED');
  });

  it('succeeds with consent record for network-tier feature', () => {
    const consentRecord: ConsentRecord = {
      id: 'test-consent-1',
      userId: 'default',
      featureId: 'threadline-relay',
      consentTier: 'network',
      dataImplications: [
        { dataType: 'agent identity', destination: 'custom', description: 'Shared with relay' },
      ],
      consentedAt: new Date().toISOString(),
      mechanism: 'explicit-verbal',
    };

    const result = registry.transition('threadline-relay', 'default', 'enabled', { consentRecord });
    expect(result.success).toBe(true);
    expect(result.newState).toBe('enabled');

    // Verify consent record was stored
    const state = registry.getState('threadline-relay');
    expect(state!.consentRecordId).toBeTruthy();
  });

  it('stores and retrieves consent records', () => {
    const records = registry.getConsentRecordsForFeature('threadline-relay', 'default');
    expect(records.length).toBeGreaterThanOrEqual(1);

    const record = records[0];
    expect(record.id).toBe('test-consent-1');
    expect(record.featureId).toBe('threadline-relay');
    expect(record.consentTier).toBe('network');
    expect(record.mechanism).toBe('explicit-verbal');
    expect(record.dataImplications.length).toBeGreaterThan(0);
  });

  it('requires consent record for self-governing tier feature', () => {
    // autonomous-evolution is self-governing tier
    registry.transition('autonomous-evolution', 'default', 'aware', { trigger: 'test' });
    registry.transition('autonomous-evolution', 'default', 'interested');

    const result = registry.transition('autonomous-evolution', 'default', 'enabled');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CONSENT_REQUIRED');
  });

  it('does not require consent for informational tier feature', () => {
    // dashboard-file-viewer is informational tier
    registry.transition('dashboard-file-viewer', 'default', 'aware', { trigger: 'test' });
    registry.transition('dashboard-file-viewer', 'default', 'interested');

    const result = registry.transition('dashboard-file-viewer', 'default', 'enabled');
    expect(result.success).toBe(true);
  });

  it('does not require consent for local tier feature', () => {
    // external-operation-gate is local tier
    registry.transition('external-operation-gate', 'default', 'aware', { trigger: 'test' });
    registry.transition('external-operation-gate', 'default', 'interested');

    const result = registry.transition('external-operation-gate', 'default', 'enabled');
    expect(result.success).toBe(true);
  });

  it('requires new consent record when re-enabling a disabled network feature', () => {
    // Disable threadline-relay
    registry.transition('threadline-relay', 'default', 'disabled');

    // Try to re-enable without consent
    const result = registry.transition('threadline-relay', 'default', 'enabled');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CONSENT_REQUIRED');

    // Re-enable with consent
    const result2 = registry.transition('threadline-relay', 'default', 'enabled', {
      consentRecord: {
        id: 'test-consent-2',
        userId: 'default',
        featureId: 'threadline-relay',
        consentTier: 'network',
        dataImplications: [{ dataType: 'agent identity', destination: 'custom', description: 'Shared with relay' }],
        consentedAt: new Date().toISOString(),
        mechanism: 'explicit-verbal',
      },
    });
    expect(result2.success).toBe(true);
  });

  // ── Phase 2d: Surface Tracking ─────────────────────────────────

  it('records surface events and increments count', () => {
    const result1 = registry.recordSurface('dispatches', 'default', { surfacedAs: 'awareness', trigger: 'test' });
    expect(result1.success).toBe(true);

    const state1 = registry.getState('dispatches');
    expect(state1!.surfaceCount).toBe(1);
    expect(state1!.lastSurfacedAt).toBeTruthy();

    const result2 = registry.recordSurface('dispatches', 'default', { surfacedAs: 'suggestion' });
    expect(result2.success).toBe(true);

    const state2 = registry.getState('dispatches');
    expect(state2!.surfaceCount).toBe(2);
  });

  it('rejects surface for nonexistent feature', () => {
    const result = registry.recordSurface('nonexistent', 'default');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FEATURE_NOT_FOUND');
  });

  // ── Phase 2e: Discovery Event Log ──────────────────────────────

  it('logs transition events to JSONL', () => {
    const events = registry.getDiscoveryEvents({ featureId: 'evolution-system' });
    expect(events.length).toBeGreaterThan(0);

    // Most recent first — last transition was enabled
    const latest = events[0];
    expect(latest.featureId).toBe('evolution-system');
    expect(latest.timestamp).toBeTruthy();
    expect(latest.userId).toBe('default');
  });

  it('logs surface events', () => {
    const events = registry.getDiscoveryEvents({ featureId: 'dispatches' });
    const surfaceEvents = events.filter(e => e.context === 'surfaced');
    expect(surfaceEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('filters events by userId', () => {
    // Create some events for a different user
    registry.transition('feedback-system', 'user-x', 'aware', { trigger: 'test' });

    const userXEvents = registry.getDiscoveryEvents({ userId: 'user-x' });
    expect(userXEvents.length).toBeGreaterThan(0);
    for (const e of userXEvents) {
      expect(e.userId).toBe('user-x');
    }
  });

  it('respects limit parameter', () => {
    const events = registry.getDiscoveryEvents({ limit: 3 });
    expect(events.length).toBeLessThanOrEqual(3);
  });

  // ── Phase 2f: Per-User State Isolation ──────────────────────────

  it('transitions are isolated per user', () => {
    // user-a enables evolution
    registry.transition('response-review', 'user-a', 'aware', { trigger: 'test' });
    registry.transition('response-review', 'user-a', 'interested');
    registry.transition('response-review', 'user-a', 'enabled', {
      consentRecord: {
        id: 'ua-consent',
        userId: 'user-a',
        featureId: 'response-review',
        consentTier: 'network',
        dataImplications: [{ dataType: 'responses', destination: 'anthropic-api', description: 'Sent for review' }],
        consentedAt: new Date().toISOString(),
        mechanism: 'explicit-written',
      },
    });

    // user-b should still be undiscovered
    const stateB = registry.getState('response-review', 'user-b');
    expect(stateB!.discoveryState).toBe('undiscovered');

    // default user should still be undiscovered
    const stateDefault = registry.getState('response-review');
    expect(stateDefault!.discoveryState).toBe('undiscovered');
  });

  it('consent records are per-user', () => {
    const recordsA = registry.getConsentRecords('user-a');
    expect(recordsA.length).toBeGreaterThan(0);
    expect(recordsA[0].userId).toBe('user-a');

    const recordsB = registry.getConsentRecords('user-b');
    expect(recordsB.length).toBe(0);
  });

  // ── Phase 2g: Right to Erasure ─────────────────────────────────

  it('erases discovery data for a user while preserving consent records', () => {
    // First verify user-a has state
    const stateBefore = registry.getState('response-review', 'user-a');
    expect(stateBefore!.discoveryState).toBe('enabled');

    const result = registry.eraseDiscoveryData('user-a');
    expect(result.deleted).toBeGreaterThan(0);
    expect(result.consentRecordsAnonymized).toBeGreaterThan(0);

    // State should be gone (defaults to undiscovered)
    const stateAfter = registry.getState('response-review', 'user-a');
    expect(stateAfter!.discoveryState).toBe('undiscovered');

    // Consent records are anonymized — not findable by original userId but still in DB
    const records = registry.getConsentRecords('user-a');
    expect(records.length).toBe(0);
  });

  it('erases consent records when forceDeleteConsent is true', () => {
    // Create user-c with consent
    registry.transition('cloudflare-tunnel', 'user-c', 'aware', { trigger: 'test' });
    registry.transition('cloudflare-tunnel', 'user-c', 'interested');
    registry.transition('cloudflare-tunnel', 'user-c', 'enabled', {
      consentRecord: {
        id: 'uc-consent',
        userId: 'user-c',
        featureId: 'cloudflare-tunnel',
        consentTier: 'network',
        dataImplications: [{ dataType: 'HTTP traffic', destination: 'cloudflare', description: 'Proxied' }],
        consentedAt: new Date().toISOString(),
        mechanism: 'explicit-verbal',
      },
    });

    const result = registry.eraseDiscoveryData('user-c', { forceDeleteConsent: true });
    expect(result.deleted).toBeGreaterThan(0);
    expect(result.consentRecordsPreserved).toBe(0);

    // Consent records should be gone
    const records = registry.getConsentRecords('user-c');
    expect(records.length).toBe(0);
  });

  it('erasure cleans event log entries for that user', () => {
    // user-x had events from earlier
    registry.eraseDiscoveryData('user-x');
    const events = registry.getDiscoveryEvents({ userId: 'user-x' });
    expect(events.length).toBe(0);
  });

  it('erasure does not affect other users', () => {
    // default user should still have state
    const state = registry.getState('evolution-system');
    expect(state!.discoveryState).toBe('enabled');

    const events = registry.getDiscoveryEvents({ userId: 'default' });
    expect(events.length).toBeGreaterThan(0);
  });

  // ── Phase 2h: API Endpoints (HTTP) ─────────────────────────────

  it('POST /features/:id/transition validates transitions via HTTP', async () => {
    // Start fresh: git-backup should be undiscovered
    const transRes = await fetch(`${baseUrl}/features/git-backup/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'aware', trigger: 'http-test' }),
    });
    expect(transRes.status).toBe(200);
    const body = await transRes.json();
    expect(body.success).toBe(true);
    expect(body.previousState).toBe('undiscovered');
    expect(body.newState).toBe('aware');
  });

  it('POST /features/:id/transition returns 422 for invalid transitions', async () => {
    const res = await fetch(`${baseUrl}/features/git-backup/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'enabled' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_TRANSITION');
    expect(body.error.details.validTransitions).toEqual(['interested', 'deferred', 'declined']);
  });

  it('POST /features/:id/transition returns 404 for unknown feature', async () => {
    const res = await fetch(`${baseUrl}/features/nonexistent/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'aware' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /features/:id/transition returns 400 when missing "to"', async () => {
    const res = await fetch(`${baseUrl}/features/git-backup/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('MISSING_TARGET');
  });

  it('POST /features/:id/transition with consent record via HTTP', async () => {
    // Move feedback-system through the pipeline
    await fetch(`${baseUrl}/features/feedback-system/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'aware', trigger: 'http-test' }),
    });
    await fetch(`${baseUrl}/features/feedback-system/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'interested' }),
    });

    // feedback-system is network tier — needs consent
    const res = await fetch(`${baseUrl}/features/feedback-system/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'enabled',
        consentRecord: {
          id: 'http-consent-1',
          userId: 'default',
          featureId: 'feedback-system',
          consentTier: 'network',
          dataImplications: [{ dataType: 'feedback', destination: 'custom', description: 'Sent to maintainer' }],
          consentedAt: new Date().toISOString(),
          mechanism: 'explicit-verbal',
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.newState).toBe('enabled');
  });

  it('POST /features/:id/surface tracks surfacing via HTTP', async () => {
    const res = await fetch(`${baseUrl}/features/dispatches/surface`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surfacedAs: 'awareness', trigger: 'http-test' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify surface count increased
    const state = registry.getState('dispatches');
    expect(state!.surfaceCount).toBeGreaterThanOrEqual(3); // 2 from direct API + 1 from HTTP
  });

  it('POST /features/:id/surface returns 404 for unknown feature', async () => {
    const res = await fetch(`${baseUrl}/features/nonexistent/surface`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it('GET /features/events returns event log', async () => {
    const res = await fetch(`${baseUrl}/features/events`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toBeDefined();
    expect(body.events.length).toBeGreaterThan(0);

    // Events should have required fields
    const event = body.events[0];
    expect(event.timestamp).toBeTruthy();
    expect(event.userId).toBeTruthy();
    expect(event.featureId).toBeTruthy();
    expect(event).toHaveProperty('previousState');
    expect(event).toHaveProperty('newState');
  });

  it('GET /features/events filters by featureId', async () => {
    const res = await fetch(`${baseUrl}/features/events?featureId=evolution-system`);
    const body = await res.json();
    for (const event of body.events) {
      expect(event.featureId).toBe('evolution-system');
    }
  });

  it('GET /features/events respects limit', async () => {
    const res = await fetch(`${baseUrl}/features/events?limit=2`);
    const body = await res.json();
    expect(body.events.length).toBeLessThanOrEqual(2);
  });

  it('GET /features/:id/consent-records returns records via HTTP', async () => {
    const res = await fetch(`${baseUrl}/features/threadline-relay/consent-records`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records).toBeDefined();
    expect(body.records.length).toBeGreaterThanOrEqual(1);
    expect(body.records[0].featureId).toBe('threadline-relay');
  });

  it('DELETE /features/discovery-data erases user data via HTTP', async () => {
    // Create state for user-http
    registry.transition('dispatches', 'user-http', 'aware', { trigger: 'test' });

    const res = await fetch(`${baseUrl}/features/discovery-data?userId=user-http`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.erased).toBe(true);
    expect(body.userId).toBe('user-http');
    expect(body.stateRowsDeleted).toBeGreaterThan(0);

    // Verify state is gone
    const state = registry.getState('dispatches', 'user-http');
    expect(state!.discoveryState).toBe('undiscovered');
  });

  // ── Phase 2i: Full Lifecycle Journey ────────────────────────────

  it('completes a full discovery journey for a network-tier feature', async () => {
    const featureId = 'cloudflare-tunnel';
    const userId = 'journey-user';

    // Step 1: Feature is undiscovered
    let state = registry.getState(featureId, userId);
    expect(state!.discoveryState).toBe('undiscovered');

    // Step 2: Surface it (awareness)
    registry.recordSurface(featureId, userId, { surfacedAs: 'awareness', trigger: 'remote-access-mention' });
    state = registry.getState(featureId, userId);
    expect(state!.surfaceCount).toBe(1);

    // Step 3: Transition to aware
    let result = registry.transition(featureId, userId, 'aware', { trigger: 'remote-access-mention' });
    expect(result.success).toBe(true);

    // Step 4: User defers
    result = registry.transition(featureId, userId, 'deferred');
    expect(result.success).toBe(true);

    // Step 5: Cooldown expires, back to aware
    result = registry.transition(featureId, userId, 'aware');
    expect(result.success).toBe(true);

    // Step 6: User shows interest
    result = registry.transition(featureId, userId, 'interested');
    expect(result.success).toBe(true);

    // Step 7: User consents and enables
    result = registry.transition(featureId, userId, 'enabled', {
      consentRecord: {
        id: 'journey-consent',
        userId,
        featureId,
        consentTier: 'network',
        dataImplications: [{ dataType: 'HTTP traffic', destination: 'cloudflare', description: 'Proxied through Cloudflare' }],
        consentedAt: new Date().toISOString(),
        mechanism: 'explicit-verbal',
      },
    });
    expect(result.success).toBe(true);

    // Step 8: Verify final state
    state = registry.getState(featureId, userId);
    expect(state!.discoveryState).toBe('enabled');
    expect(state!.enabled).toBe(true);
    expect(state!.consentRecordId).toBeTruthy();

    // Step 9: Verify consent record
    const records = registry.getConsentRecordsForFeature(featureId, userId);
    expect(records.length).toBe(1);
    expect(records[0].mechanism).toBe('explicit-verbal');

    // Step 10: Verify event trail
    const events = registry.getDiscoveryEvents({ userId, featureId });
    expect(events.length).toBeGreaterThanOrEqual(5); // surface + aware + deferred + aware + interested + enabled
  });

  it('completes decline → re-engage journey', () => {
    const featureId = 'response-review';
    const userId = 'decline-user';

    // Discover and decline
    registry.transition(featureId, userId, 'aware', { trigger: 'safety-concern' });
    registry.transition(featureId, userId, 'declined');

    let state = registry.getState(featureId, userId);
    expect(state!.discoveryState).toBe('declined');
    expect(state!.lastDeclinedAt).toBeTruthy();

    // Later: context changes, re-surface
    registry.transition(featureId, userId, 'aware', { trigger: 'context-changed' });
    registry.transition(featureId, userId, 'interested');

    // Enable with consent (network tier)
    const result = registry.transition(featureId, userId, 'enabled', {
      consentRecord: {
        id: 'decline-reconsider-consent',
        userId,
        featureId,
        consentTier: 'network',
        dataImplications: [{ dataType: 'responses', destination: 'anthropic-api', description: 'Sent for review' }],
        consentedAt: new Date().toISOString(),
        mechanism: 'explicit-written',
      },
    });
    expect(result.success).toBe(true);

    state = registry.getState(featureId, userId);
    expect(state!.discoveryState).toBe('enabled');
    expect(state!.enabled).toBe(true);
  });
});
