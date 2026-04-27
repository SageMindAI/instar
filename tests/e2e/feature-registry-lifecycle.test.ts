/**
 * E2E test — Feature Registry (Consent & Discovery Framework, Phase 1).
 *
 * Tests the complete Phase 1 lifecycle:
 *   Feature registration → Bootstrap from config → API endpoints →
 *   State queries → Filtering by state → Per-user isolation →
 *   Config sync → Summary endpoint → /capabilities integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createRoutes } from '../../src/server/routes.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('E2E: Feature Registry Lifecycle', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let baseUrl: string;
  let registry: FeatureRegistry;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feature-reg-e2e-'));
    stateDir = path.join(projectDir, '.instar');

    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Config with some features enabled
    const rawConfig = {
      projectName: 'feature-reg-e2e',
      threadline: { enabled: true },
      tunnel: { enabled: true, type: 'quick' },
      gitBackup: { enabled: true },
      externalOperations: { enabled: true },
      feedback: { enabled: true },
    };
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(rawConfig));

    const config: InstarConfig = {
      projectDir,
      stateDir,
      projectName: 'feature-reg-e2e',
      agentName: 'test-agent',
      port: 0,
      sessions: { maxConcurrent: 2, defaultModel: 'sonnet' },
      scheduler: { enabled: false },
      users: [],
      messaging: [],
      monitoring: { healthCheck: { enabled: false } },
    } as InstarConfig;

    const state = new StateManager(stateDir);

    // Initialize feature registry
    registry = new FeatureRegistry(stateDir);
    await registry.open();
    for (const def of BUILTIN_FEATURES) {
      registry.register(def);
    }
    registry.bootstrap(rawConfig);

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

  // ── Phase 1a: Registration & Bootstrap ──────────────────────────

  it('registers all builtin feature definitions', () => {
    const defs = registry.getAllDefinitions();
    expect(defs.length).toBe(BUILTIN_FEATURES.length);
    for (const builtin of BUILTIN_FEATURES) {
      expect(registry.getDefinition(builtin.id)).toBeDefined();
    }
  });

  it('bootstraps enabled features from config', () => {
    const enabledIds = ['threadline-relay', 'cloudflare-tunnel', 'git-backup', 'external-operation-gate', 'feedback-system'];
    for (const id of enabledIds) {
      const state = registry.getState(id);
      expect(state?.enabled, `${id} should be enabled`).toBe(true);
      expect(state?.discoveryState, `${id} should have discoveryState 'enabled'`).toBe('enabled');
    }
  });

  it('leaves non-configured features as undiscovered', () => {
    const undiscoveredIds = ['publishing-telegraph', 'dashboard-file-viewer', 'evolution-system', 'autonomous-evolution', 'response-review', 'input-guard', 'dispatches'];
    for (const id of undiscoveredIds) {
      const state = registry.getState(id);
      expect(state?.enabled, `${id} should not be enabled`).toBe(false);
      expect(state?.discoveryState, `${id} should be undiscovered`).toBe('undiscovered');
    }
  });

  it('returns null for nonexistent feature definitions', () => {
    expect(registry.getDefinition('nonexistent')).toBeUndefined();
    expect(registry.getState('nonexistent')).toBeNull();
    expect(registry.getFeatureInfo('nonexistent')).toBeNull();
  });

  // ── Phase 1b: State Management ──────────────────────────────────

  it('creates default undiscovered state for untracked features (lazy creation)', () => {
    const state = registry.getState('publishing-telegraph');
    expect(state).not.toBeNull();
    expect(state!.userId).toBe('default');
    expect(state!.featureId).toBe('publishing-telegraph');
    expect(state!.enabled).toBe(false);
    expect(state!.discoveryState).toBe('undiscovered');
    expect(state!.surfaceCount).toBe(0);
    expect(state!.lastSurfacedAt).toBeNull();
    expect(state!.lastDeclinedAt).toBeNull();
    expect(state!.consentRecordId).toBeNull();
  });

  it('persists state updates via setState', () => {
    registry.setState('publishing-telegraph', 'default', {
      discoveryState: 'aware',
      lastSurfacedAt: '2026-03-22T00:00:00Z',
      surfaceCount: 1,
    });

    const state = registry.getState('publishing-telegraph');
    expect(state!.discoveryState).toBe('aware');
    expect(state!.lastSurfacedAt).toBe('2026-03-22T00:00:00Z');
    expect(state!.surfaceCount).toBe(1);
  });

  it('supports per-user state isolation', () => {
    // Set state for user-a
    registry.setState('evolution-system', 'user-a', {
      discoveryState: 'enabled',
      enabled: true,
    });

    // Set state for user-b
    registry.setState('evolution-system', 'user-b', {
      discoveryState: 'declined',
      lastDeclinedAt: '2026-03-22T00:00:00Z',
    });

    const stateA = registry.getState('evolution-system', 'user-a');
    const stateB = registry.getState('evolution-system', 'user-b');
    const stateDefault = registry.getState('evolution-system', 'default');

    expect(stateA!.discoveryState).toBe('enabled');
    expect(stateA!.enabled).toBe(true);

    expect(stateB!.discoveryState).toBe('declined');
    expect(stateB!.enabled).toBe(false);

    expect(stateDefault!.discoveryState).toBe('undiscovered');
  });

  it('upserts state without clobbering unrelated fields', () => {
    // Set initial state with surface info
    registry.setState('dispatches', 'default', {
      discoveryState: 'aware',
      lastSurfacedAt: '2026-03-22T01:00:00Z',
      surfaceCount: 2,
    });

    // Update only discoveryState — surfaceCount should persist
    registry.setState('dispatches', 'default', {
      discoveryState: 'declined',
      lastDeclinedAt: '2026-03-22T02:00:00Z',
    });

    const state = registry.getState('dispatches');
    expect(state!.discoveryState).toBe('declined');
    expect(state!.surfaceCount).toBe(2);
    expect(state!.lastSurfacedAt).toBe('2026-03-22T01:00:00Z');
    expect(state!.lastDeclinedAt).toBe('2026-03-22T02:00:00Z');
  });

  // ── Phase 1c: Valid Transitions ─────────────────────────────────

  it('returns correct valid transitions for each state', () => {
    // undiscovered → aware
    expect(registry.getValidTransitions('dispatches', 'default')).toEqual(['aware']); // declined → aware

    // Reset to test other states
    registry.setState('dashboard-file-viewer', 'default', { discoveryState: 'aware' });
    expect(registry.getValidTransitions('dashboard-file-viewer')).toEqual(['interested', 'deferred', 'declined']);

    registry.setState('dashboard-file-viewer', 'default', { discoveryState: 'interested' });
    expect(registry.getValidTransitions('dashboard-file-viewer')).toEqual(['enabled']);

    registry.setState('dashboard-file-viewer', 'default', { discoveryState: 'deferred' });
    expect(registry.getValidTransitions('dashboard-file-viewer')).toEqual(['aware']);

    registry.setState('dashboard-file-viewer', 'default', { discoveryState: 'enabled', enabled: true });
    expect(registry.getValidTransitions('dashboard-file-viewer')).toEqual(['disabled']);

    registry.setState('dashboard-file-viewer', 'default', { discoveryState: 'disabled', enabled: false });
    expect(registry.getValidTransitions('dashboard-file-viewer')).toEqual(['enabled']);
  });

  it('returns empty transitions for nonexistent features', () => {
    expect(registry.getValidTransitions('nonexistent')).toEqual([]);
  });

  // ── Phase 1d: Filtering & Queries ──────────────────────────────

  it('filters features by discovery state', () => {
    const enabled = registry.getFeaturesByState(['enabled']);
    const enabledIds = enabled.map(f => f.state.featureId);
    expect(enabledIds).toContain('threadline-relay');
    expect(enabledIds).toContain('cloudflare-tunnel');
    expect(enabledIds).not.toContain('publishing-telegraph'); // was set to 'aware' earlier
  });

  it('filters by multiple states', () => {
    const mixed = registry.getFeaturesByState(['enabled', 'aware']);
    const ids = mixed.map(f => f.state.featureId);
    expect(ids).toContain('threadline-relay');     // enabled
    expect(ids).toContain('publishing-telegraph'); // aware (from earlier test)
  });

  it('returns summaries with correct shape', () => {
    const summaries = registry.getSummaries();
    expect(summaries.length).toBe(BUILTIN_FEATURES.length);

    for (const s of summaries) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('category');
      expect(s).toHaveProperty('consentTier');
      expect(typeof s.enabled).toBe('boolean');
      expect(s).toHaveProperty('discoveryState');
    }
  });

  it('getFeatureInfo returns combined definition + state', () => {
    const info = registry.getFeatureInfo('threadline-relay');
    expect(info).not.toBeNull();
    expect(info!.definition.id).toBe('threadline-relay');
    expect(info!.definition.name).toBe('Agent Network (Threadline)');
    expect(info!.definition.consentTier).toBe('network');
    expect(info!.state.enabled).toBe(true);
    expect(info!.state.discoveryState).toBe('enabled');
  });

  // ── Phase 1e: Bootstrap Edge Cases ──────────────────────────────

  it('bootstrap syncs config-enabled features that are undiscovered', () => {
    // Start fresh: set a feature to undiscovered
    registry.setState('threadline-relay', 'default', {
      discoveryState: 'undiscovered',
      enabled: false,
    });

    // Re-bootstrap with threadline enabled in config
    registry.bootstrap({
      threadline: { enabled: true },
      tunnel: { enabled: true, type: 'quick' },
      gitBackup: { enabled: true },
      externalOperations: { enabled: true },
      feedback: { enabled: true },
    });

    const state = registry.getState('threadline-relay');
    expect(state!.discoveryState).toBe('enabled');
    expect(state!.enabled).toBe(true);
  });

  it('bootstrap marks config-disabled features as disabled', () => {
    // First ensure the feature is enabled
    registry.setState('git-backup', 'default', {
      discoveryState: 'enabled',
      enabled: true,
    });

    // Overwrite config.json without gitBackup so bootstrap reads it as disabled
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ projectName: 'feature-reg-e2e', threadline: { enabled: true }, tunnel: { enabled: true, type: 'quick' } }),
    );

    // Re-bootstrap without gitBackup
    registry.bootstrap({
      threadline: { enabled: true },
      tunnel: { enabled: true, type: 'quick' },
    });

    const state = registry.getState('git-backup');
    expect(state!.discoveryState).toBe('disabled');
    expect(state!.enabled).toBe(false);

    // Restore original config for subsequent tests
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({
        projectName: 'feature-reg-e2e',
        threadline: { enabled: true },
        tunnel: { enabled: true, type: 'quick' },
        gitBackup: { enabled: true },
        externalOperations: { enabled: true },
        feedback: { enabled: true },
      }),
    );
  });

  it('bootstrap does not overwrite manually-progressed states', () => {
    // Set a feature to "declined" — bootstrap should NOT reset this to undiscovered
    registry.setState('evolution-system', 'default', {
      discoveryState: 'declined',
      lastDeclinedAt: '2026-03-22T00:00:00Z',
    });

    // Re-bootstrap without evolution enabled
    registry.bootstrap({});

    const state = registry.getState('evolution-system', 'default');
    // Should still be declined — bootstrap only touches undiscovered → enabled and enabled → disabled
    expect(state!.discoveryState).toBe('declined');
  });

  // ── Phase 1f: Feature Definition Integrity ──────────────────────

  it('every feature definition has required fields', () => {
    for (const def of BUILTIN_FEATURES) {
      expect(def.id, `${def.id}: missing id`).toBeTruthy();
      expect(def.name, `${def.id}: missing name`).toBeTruthy();
      expect(def.category, `${def.id}: missing category`).toBeTruthy();
      expect(def.featureVersion, `${def.id}: missing featureVersion`).toBeTruthy();
      expect(def.configPath, `${def.id}: missing configPath`).toBeTruthy();
      expect(def.enableAction, `${def.id}: missing enableAction`).toBeDefined();
      expect(def.disableAction, `${def.id}: missing disableAction`).toBeDefined();
      expect(def.oneLiner, `${def.id}: missing oneLiner`).toBeTruthy();
      expect(def.fullDescription, `${def.id}: missing fullDescription`).toBeTruthy();
      expect(def.consentTier, `${def.id}: missing consentTier`).toBeTruthy();
      expect(def.dataImplications, `${def.id}: missing dataImplications`).toBeDefined();
      expect(def.dataImplications.length, `${def.id}: empty dataImplications`).toBeGreaterThan(0);
      expect(def.reversibilityNote, `${def.id}: missing reversibilityNote`).toBeTruthy();
      expect(def.discoveryTriggers, `${def.id}: missing discoveryTriggers`).toBeDefined();
      expect(def.discoveryTriggers.length, `${def.id}: no discovery triggers`).toBeGreaterThan(0);
    }
  });

  it('feature IDs are unique', () => {
    const ids = BUILTIN_FEATURES.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prerequisiteFeatures reference valid feature IDs', () => {
    const allIds = new Set(BUILTIN_FEATURES.map(f => f.id));
    for (const def of BUILTIN_FEATURES) {
      if (def.prerequisiteFeatures) {
        for (const prereq of def.prerequisiteFeatures) {
          expect(allIds.has(prereq), `${def.id} references unknown prerequisite '${prereq}'`).toBe(true);
        }
      }
    }
  });

  it('consent tiers are valid enum values', () => {
    const validTiers = new Set(['informational', 'local', 'network', 'self-governing']);
    for (const def of BUILTIN_FEATURES) {
      expect(validTiers.has(def.consentTier), `${def.id} has invalid consentTier '${def.consentTier}'`).toBe(true);
    }
  });

  it('categories are valid enum values', () => {
    const validCats = new Set(['communication', 'safety', 'intelligence', 'infrastructure']);
    for (const def of BUILTIN_FEATURES) {
      expect(validCats.has(def.category), `${def.id} has invalid category '${def.category}'`).toBe(true);
    }
  });

  // ── Phase 1g: API Endpoints (HTTP) ──────────────────────────────

  it('GET /features returns all features with definition + state', async () => {
    const res = await fetch(`${baseUrl}/features`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.features).toBeDefined();
    expect(body.features.length).toBe(BUILTIN_FEATURES.length);

    // Verify each has both definition and state
    for (const f of body.features) {
      expect(f.definition).toBeDefined();
      expect(f.state).toBeDefined();
      expect(f.definition.id).toBeTruthy();
      expect(f.state.featureId).toBe(f.definition.id);
    }
  });

  it('GET /features?state=enabled returns only enabled features', async () => {
    const res = await fetch(`${baseUrl}/features?state=enabled`);
    expect(res.status).toBe(200);
    const body = await res.json();

    for (const f of body.features) {
      expect(f.state.discoveryState).toBe('enabled');
    }
    // Should have at least some enabled features
    expect(body.features.length).toBeGreaterThan(0);
  });

  it('GET /features?state=undiscovered,aware returns multiple states', async () => {
    const res = await fetch(`${baseUrl}/features?state=undiscovered,aware`);
    expect(res.status).toBe(200);
    const body = await res.json();

    for (const f of body.features) {
      expect(['undiscovered', 'aware']).toContain(f.state.discoveryState);
    }
  });

  it('GET /features?userId=user-a returns per-user state', async () => {
    const res = await fetch(`${baseUrl}/features?userId=user-a`);
    expect(res.status).toBe(200);
    const body = await res.json();

    // user-a had evolution-system set to enabled earlier
    const evo = body.features.find((f: any) => f.definition.id === 'evolution-system');
    expect(evo).toBeDefined();
    expect(evo.state.discoveryState).toBe('enabled');
    expect(evo.state.enabled).toBe(true);
  });

  it('GET /features/summary returns lightweight summaries', async () => {
    const res = await fetch(`${baseUrl}/features/summary`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.features.length).toBe(BUILTIN_FEATURES.length);

    // Summaries should have fewer fields than full features
    for (const s of body.features) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('category');
      expect(s).toHaveProperty('consentTier');
      expect(typeof s.enabled).toBe('boolean');
      expect(s).toHaveProperty('discoveryState');
      // Should NOT have full definition/state objects
      expect(s).not.toHaveProperty('definition');
      expect(s).not.toHaveProperty('fullDescription');
    }
  });

  it('GET /features/:id returns single feature with valid transitions', async () => {
    const res = await fetch(`${baseUrl}/features/threadline-relay`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.definition.id).toBe('threadline-relay');
    expect(body.definition.name).toBe('Agent Network (Threadline)');
    expect(body.state).toBeDefined();
    expect(body.validTransitions).toBeDefined();
    expect(Array.isArray(body.validTransitions)).toBe(true);
  });

  it('GET /features/:id returns 404 for unknown features', async () => {
    const res = await fetch(`${baseUrl}/features/nonexistent-feature`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('FEATURE_NOT_FOUND');
  });

  it('GET /features/:id valid transitions match current state', async () => {
    // threadline-relay is enabled → should only transition to disabled
    const res = await fetch(`${baseUrl}/features/threadline-relay`);
    const body = await res.json();
    expect(body.state.discoveryState).toBe('enabled');
    expect(body.validTransitions).toEqual(['disabled']);
  });

  // ── Phase 1h: /capabilities Integration ─────────────────────────

  it('GET /capabilities includes discovery section with feature summaries', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.discovery).toBeDefined();
    expect(body.discovery.enabled).toBe(true);
    expect(body.discovery.featureCount).toBe(BUILTIN_FEATURES.length);
    expect(body.discovery.summaries).toBeDefined();
    expect(body.discovery.summaries.length).toBe(BUILTIN_FEATURES.length);
    expect(body.discovery.endpoints).toBeDefined();
    expect(body.discovery.endpoints.length).toBeGreaterThan(0);
  });

  // ── Phase 1i: Database Persistence ──────────────────────────────

  it('state survives registry recreation (database persistence)', async () => {
    // Set a distinctive state
    registry.setState('input-guard', 'default', {
      discoveryState: 'interested',
      surfaceCount: 5,
      lastSurfacedAt: '2026-03-22T12:00:00Z',
    });

    // Close and reopen
    registry.close();
    const registry2 = new FeatureRegistry(stateDir);
    await registry2.open();
    for (const def of BUILTIN_FEATURES) {
      registry2.register(def);
    }

    const state = registry2.getState('input-guard');
    expect(state!.discoveryState).toBe('interested');
    expect(state!.surfaceCount).toBe(5);
    expect(state!.lastSurfacedAt).toBe('2026-03-22T12:00:00Z');

    // Restore original registry for remaining tests
    registry2.close();
    registry = new FeatureRegistry(stateDir);
    await registry.open();
    for (const def of BUILTIN_FEATURES) {
      registry.register(def);
    }
  });

  // ── Phase 1j: resolveConfigValue Edge Cases ─────────────────────

  it('bootstrap handles nested config paths', () => {
    // autonomous-evolution uses 'evolution.autoImplement' — a nested boolean
    registry.setState('autonomous-evolution', 'default', {
      discoveryState: 'undiscovered',
      enabled: false,
    });

    registry.bootstrap({
      evolution: { enabled: true, autoImplement: true },
    });

    const state = registry.getState('autonomous-evolution');
    expect(state!.discoveryState).toBe('enabled');
    expect(state!.enabled).toBe(true);
  });

  it('bootstrap handles deeply nested config with enabled field', () => {
    // dashboard-file-viewer uses 'dashboard.fileViewer'
    registry.setState('dashboard-file-viewer', 'default', {
      discoveryState: 'undiscovered',
      enabled: false,
    });

    registry.bootstrap({
      dashboard: { fileViewer: { enabled: true } },
    });

    const state = registry.getState('dashboard-file-viewer');
    expect(state!.discoveryState).toBe('enabled');
    expect(state!.enabled).toBe(true);
  });

  it('bootstrap treats missing config paths as disabled', () => {
    registry.setState('response-review', 'default', {
      discoveryState: 'undiscovered',
      enabled: false,
    });

    // Empty config — responseReview not present
    registry.bootstrap({});

    const state = registry.getState('response-review');
    expect(state!.enabled).toBe(false);
    expect(state!.discoveryState).toBe('undiscovered');
  });
});
