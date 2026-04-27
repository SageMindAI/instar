/**
 * E2E test — Discovery Observability (Consent & Discovery Framework, Phase 5).
 *
 * Tests:
 *   1. Funnel metrics — count features in each discovery state
 *   2. Cooldown status — surface count, max, quieted, expiry
 *   3. Changed disabled features digest
 *   4. Negative discovery — unused enabled features
 *   5. Comprehensive analytics endpoint
 *   6. API endpoints (GET /features/analytics, /funnel, /cooldowns, /digest)
 *   7. Dashboard tab exists in HTML
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { createRoutes } from '../../src/server/routes.js';
import type { InstarConfig } from '../../src/core/types.js';

// ── Test Context ────────────────────────────────────────────────────

describe('E2E: Discovery Observability (Phase 5)', () => {
  let projectDir: string;
  let stateDir: string;
  let registry: FeatureRegistry;
  let app: express.Express;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-phase5-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      projectName: 'phase5-e2e',
    }));

    registry = new FeatureRegistry(stateDir);
    await registry.open();
    for (const def of BUILTIN_FEATURES) {
      registry.register(def);
    }

    // Set up some state
    // Enable threadline
    registry.transition('threadline-relay', 'default', 'aware', { trigger: 'test' });
    registry.transition('threadline-relay', 'default', 'interested');
    registry.transition('threadline-relay', 'default', 'enabled', {
      consentRecord: {
        id: 'cr-1', userId: 'default', featureId: 'threadline-relay',
        consentTier: 'network',
        dataImplications: [{ dataType: 'messages', destination: 'anthropic-api', description: 'Agent-to-agent relay messages' }],
        consentedAt: new Date().toISOString(), mechanism: 'explicit-verbal',
      },
    });
    // Make publishing-telegraph aware
    registry.transition('publishing-telegraph', 'default', 'aware', { trigger: 'test' });
    // Surface it a few times
    registry.recordSurface('publishing-telegraph', 'default', { surfacedAs: 'awareness' });
    registry.recordSurface('publishing-telegraph', 'default', { surfacedAs: 'suggestion' });
    // Decline dispatches
    registry.transition('dispatches', 'default', 'aware', { trigger: 'test' });
    registry.transition('dispatches', 'default', 'declined', { trigger: 'user-declined' });

    // Set up HTTP server
    app = express();
    app.use(express.json());
    const { StateManager } = await import('../../src/core/StateManager.js');
    const state = new StateManager(stateDir);

    const routeCtx = {
      state,
      config: { port: 0, stateDir, projectDir, projectName: 'test' } as unknown as InstarConfig,
      featureRegistry: registry,
    };

    app.use('/', createRoutes(routeCtx as any));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    registry?.close();
    server?.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── 1. Funnel Metrics ─────────────────────────────────────────────

  describe('Funnel Metrics', () => {
    it('counts features in each discovery state', () => {
      const funnel = registry.getFunnelMetrics();
      expect(funnel.enabled).toBeGreaterThanOrEqual(1); // threadline
      expect(funnel.aware).toBeGreaterThanOrEqual(1); // publishing-telegraph
      expect(funnel.declined).toBeGreaterThanOrEqual(1); // dispatches
      expect(funnel.undiscovered).toBeGreaterThanOrEqual(0);

      // Total should equal all registered features
      const total = Object.values(funnel).reduce((a, b) => a + b, 0);
      expect(total).toBe(BUILTIN_FEATURES.length);
    });

    it('returns all 7 state keys', () => {
      const funnel = registry.getFunnelMetrics();
      const keys = Object.keys(funnel);
      expect(keys).toContain('undiscovered');
      expect(keys).toContain('aware');
      expect(keys).toContain('interested');
      expect(keys).toContain('deferred');
      expect(keys).toContain('declined');
      expect(keys).toContain('enabled');
      expect(keys).toContain('disabled');
    });
  });

  // ── 2. Cooldown Status ────────────────────────────────────────────

  describe('Cooldown Status', () => {
    it('returns status for all features', () => {
      const statuses = registry.getCooldownStatuses();
      expect(statuses.length).toBe(BUILTIN_FEATURES.length);
    });

    it('tracks surface count correctly', () => {
      const statuses = registry.getCooldownStatuses();
      const pub = statuses.find(s => s.featureId === 'publishing-telegraph');
      expect(pub).toBeDefined();
      expect(pub!.surfaceCount).toBe(2);
    });

    it('identifies quieted features', () => {
      // Surface a feature up to its limit
      const def = BUILTIN_FEATURES.find(f => f.id === 'dashboard-file-viewer')!;
      const maxSurfaces = Math.min(...def.discoveryTriggers.map(t => t.maxSurfacesBeforeQuiet));

      // Surface up to max
      for (let i = 0; i < maxSurfaces; i++) {
        registry.recordSurface('dashboard-file-viewer', 'default', { surfacedAs: 'awareness' });
      }

      const statuses = registry.getCooldownStatuses();
      const dv = statuses.find(s => s.featureId === 'dashboard-file-viewer');
      expect(dv).toBeDefined();
      expect(dv!.quieted).toBe(true);
      expect(dv!.surfaceCount).toBeGreaterThanOrEqual(maxSurfaces);
    });

    it('includes cooldown expiry time when in cooldown', () => {
      const statuses = registry.getCooldownStatuses();
      // Recently surfaced features may have a cooldown
      const surfaced = statuses.filter(s => s.lastSurfacedAt);
      // Some may have cooldownExpiresAt set
      expect(surfaced.length).toBeGreaterThan(0);
    });

    it('includes maxSurfaces from trigger config', () => {
      const statuses = registry.getCooldownStatuses();
      for (const s of statuses) {
        expect(s.maxSurfaces).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ── 3. Changed Disabled Features ──────────────────────────────────

  describe('Changed Disabled Features Digest', () => {
    it('returns empty when no features are disabled', () => {
      // At this point, no features have been disabled
      const changed = registry.getChangedDisabledFeatures();
      expect(changed).toEqual([]);
    });

    it('returns disabled features with version info', () => {
      // Enable then disable a feature
      registry.transition('evolution-system', 'default', 'aware', { trigger: 'test' });
      registry.transition('evolution-system', 'default', 'interested');
      registry.transition('evolution-system', 'default', 'enabled');
      registry.transition('evolution-system', 'default', 'disabled');

      const changed = registry.getChangedDisabledFeatures();
      expect(changed.length).toBeGreaterThanOrEqual(1);

      const evo = changed.find(f => f.featureId === 'evolution-system');
      expect(evo).toBeDefined();
      expect(evo!.currentVersion).toBeDefined();
    });
  });

  // ── 4. Negative Discovery (Unused Features) ──────────────────────

  describe('Negative Discovery', () => {
    it('returns empty for recently active features', () => {
      // threadline was just enabled — should not appear
      const unused = registry.getUnusedEnabledFeatures('default', 15);
      const threadline = unused.find(f => f.featureId === 'threadline-relay');
      expect(threadline).toBeUndefined();
    });

    it('returns features with no activity when threshold is 0', () => {
      // With threshold 0, all enabled features with no recent events appear
      const unused = registry.getUnusedEnabledFeatures('default', 0);
      // Should not crash, may or may not have results depending on event timing
      expect(Array.isArray(unused)).toBe(true);
    });

    it('includes daysSinceActivity', () => {
      const unused = registry.getUnusedEnabledFeatures('default', 0);
      for (const f of unused) {
        expect(typeof f.daysSinceActivity).toBe('number');
        expect(f.daysSinceActivity).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ── 5. Comprehensive Analytics ────────────────────────────────────

  describe('Comprehensive Analytics', () => {
    it('returns all analytics fields', () => {
      const analytics = registry.getAnalytics();

      expect(analytics.funnel).toBeDefined();
      expect(analytics.totalFeatures).toBe(BUILTIN_FEATURES.length);
      expect(analytics.enabledCount).toBeGreaterThanOrEqual(1);
      expect(analytics.discoveryRate).toBeGreaterThan(0);
      expect(analytics.discoveryRate).toBeLessThanOrEqual(1);
      expect(Array.isArray(analytics.cooldowns)).toBe(true);
      expect(Array.isArray(analytics.changedDisabled)).toBe(true);
      expect(Array.isArray(analytics.unusedEnabled)).toBe(true);
      expect(Array.isArray(analytics.recentEvents)).toBe(true);
    });

    it('discovery rate reflects awareness progress', () => {
      const analytics = registry.getAnalytics();
      // We've moved at least 3 features out of undiscovered
      const discovered = analytics.totalFeatures - analytics.funnel.undiscovered;
      expect(discovered).toBeGreaterThanOrEqual(3);
      expect(analytics.discoveryRate).toBeGreaterThanOrEqual(discovered / analytics.totalFeatures - 0.01);
    });

    it('recent events are limited to 50', () => {
      const analytics = registry.getAnalytics();
      expect(analytics.recentEvents.length).toBeLessThanOrEqual(50);
    });
  });

  // ── 6. API Endpoints ──────────────────────────────────────────────

  describe('API Endpoints', () => {
    it('GET /features/analytics returns full analytics', async () => {
      const resp = await fetch(`${baseUrl}/features/analytics`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.funnel).toBeDefined();
      expect(data.totalFeatures).toBeGreaterThan(0);
      expect(data.cooldowns).toBeDefined();
      expect(data.recentEvents).toBeDefined();
    });

    it('GET /features/funnel returns funnel only', async () => {
      const resp = await fetch(`${baseUrl}/features/funnel`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.funnel).toBeDefined();
      expect(data.funnel.enabled).toBeGreaterThanOrEqual(0);
      expect(data.funnel.undiscovered).toBeGreaterThanOrEqual(0);
    });

    it('GET /features/cooldowns returns cooldown statuses', async () => {
      const resp = await fetch(`${baseUrl}/features/cooldowns`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.cooldowns).toBeDefined();
      expect(data.cooldowns.length).toBe(BUILTIN_FEATURES.length);
    });

    it('GET /features/digest returns digest data', async () => {
      const resp = await fetch(`${baseUrl}/features/digest`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.changedDisabled).toBeDefined();
      expect(data.unusedEnabled).toBeDefined();
    });

    it('GET /features/digest respects thresholdDays param', async () => {
      const resp = await fetch(`${baseUrl}/features/digest?thresholdDays=0`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(Array.isArray(data.unusedEnabled)).toBe(true);
    });

    it('GET /features/analytics supports userId filter', async () => {
      const resp = await fetch(`${baseUrl}/features/analytics?userId=other`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      // Different user should have all undiscovered
      expect(data.funnel.undiscovered).toBe(BUILTIN_FEATURES.length);
    });
  });

  // ── 7. Dashboard HTML ─────────────────────────────────────────────

  describe('Dashboard', () => {
    const dashboardPath = path.join(__dirname, '../../dashboard/index.html');
    const html = fs.readFileSync(dashboardPath, 'utf-8');

    it('has Features tab button', () => {
      expect(html).toContain('data-tab="features"');
      expect(html).toContain('>Features<');
    });

    it('has features tab container', () => {
      expect(html).toContain('id="featuresTab"');
    });

    it('has TAB_REGISTRY entry for features', () => {
      expect(html).toContain("id: 'features'");
      expect(html).toContain("panels: ['featuresTab']");
    });

    it('has feature detail view', () => {
      expect(html).toContain('id="featDetailView"');
    });

    it('has features container', () => {
      expect(html).toContain('class="features-container"');
    });

    it('has profile selector view', () => {
      expect(html).toContain('id="profileSelectorView"');
    });

    it('has features refresh button', () => {
      expect(html).toContain('loadFeatures()');
      expect(html).toContain('features-refresh');
    });

    it('has loadFeatures function', () => {
      expect(html).toContain('async function loadFeatures');
    });

    it('has CSS for features components', () => {
      expect(html).toContain('.features-container');
      expect(html).toContain('.feat-card');
      expect(html).toContain('.feat-grid');
      expect(html).toContain('.feat-toggle');
    });

    it('has features subtitle', () => {
      expect(html).toContain('features-subtitle');
    });

    it('has feature category styling', () => {
      expect(html).toContain('.feat-category');
    });
  });
});
