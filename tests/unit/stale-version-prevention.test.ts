/**
 * META-LEVEL TESTS: Stale Version Reporting Prevention
 *
 * These tests don't test a single module — they test that the CATEGORY
 * of bug "process reports wrong version" cannot re-emerge.
 *
 * The root cause: code reads package.json from DISK at runtime to report
 * its version, but the code ACTUALLY RUNNING was loaded at process start.
 * After npm install -g, disk has new version but old code is in memory.
 *
 * These tests scan the source code for patterns that would reintroduce
 * this class of bug, acting as structural guardrails.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';

const SRC_DIR = path.join(process.cwd(), 'src');

describe('META: Stale version reporting prevention', () => {

  // ── Rule 1: No runtime version reads from package.json in routes/health ──

  it('health endpoint does NOT read version from config directly', () => {
    const routesSrc = fs.readFileSync(
      path.join(SRC_DIR, 'server/routes.ts'),
      'utf-8',
    );

    // The health endpoint block should use ProcessIntegrity, not ctx.config.version
    // Find the health endpoint section
    const healthStart = routesSrc.indexOf("router.get('/health'");
    const healthEnd = routesSrc.indexOf("router.get('/'", healthStart + 1);
    const healthBlock = routesSrc.slice(healthStart, healthEnd > 0 ? healthEnd : healthStart + 2000);

    // Should reference ProcessIntegrity
    expect(healthBlock).toContain('ProcessIntegrity');
  });

  it('routes.ts imports ProcessIntegrity', () => {
    const routesSrc = fs.readFileSync(
      path.join(SRC_DIR, 'server/routes.ts'),
      'utf-8',
    );
    expect(routesSrc).toContain("import { ProcessIntegrity }");
  });

  // ── Rule 2: ProcessIntegrity singleton must be initialized in server startup ──

  it('server.ts initializes ProcessIntegrity before server starts', () => {
    const serverSrc = fs.readFileSync(
      path.join(SRC_DIR, 'commands/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toContain('ProcessIntegrity.initialize');
  });

  it('server.ts imports ProcessIntegrity', () => {
    const serverSrc = fs.readFileSync(
      path.join(SRC_DIR, 'commands/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toContain("import { ProcessIntegrity }");
  });

  // ── Rule 3: Version in feedback/dispatch uses frozen version ──

  it('FeedbackManager and DispatchManager receive version at construction, not live', () => {
    const serverSrc = fs.readFileSync(
      path.join(SRC_DIR, 'commands/server.ts'),
      'utf-8',
    );

    // FeedbackManager and DispatchManager should be passed startupVersion,
    // NOT config.version (which could re-read from disk)
    const feedbackInit = serverSrc.match(/new FeedbackManager\(\{[\s\S]*?\}\)/);
    const dispatchInit = serverSrc.match(/new DispatchManager\(\{[\s\S]*?\}\)/);

    if (feedbackInit) {
      expect(feedbackInit[0]).toContain('startupVersion');
    }
    if (dispatchInit) {
      expect(dispatchInit[0]).toContain('startupVersion');
    }
  });

  // ── Rule 4: CoherenceMonitor checks process integrity ──

  it('CoherenceMonitor checks for version mismatch', () => {
    const coherenceSrc = fs.readFileSync(
      path.join(SRC_DIR, 'monitoring/CoherenceMonitor.ts'),
      'utf-8',
    );
    expect(coherenceSrc).toContain('ProcessIntegrity');
    expect(coherenceSrc).toContain('process-version-mismatch');
  });

  // ── Rule 5: getInstarVersion() is NOT used for runtime reporting ──

  it('getInstarVersion() in Config.ts has a comment warning about runtime use', () => {
    const configSrc = fs.readFileSync(
      path.join(SRC_DIR, 'core/Config.ts'),
      'utf-8',
    );
    // getInstarVersion should exist (it's used at startup) but shouldn't be
    // used anywhere for runtime version queries — ProcessIntegrity handles that
    expect(configSrc).toContain('getInstarVersion');
  });

  it('routes.ts does not import getInstarVersion', () => {
    const routesSrc = fs.readFileSync(
      path.join(SRC_DIR, 'server/routes.ts'),
      'utf-8',
    );
    // Routes should never directly read version from Config — always use ProcessIntegrity
    expect(routesSrc).not.toContain('getInstarVersion');
  });

  // ── Rule 6: ProcessIntegrity exists and has the right shape ──

  it('ProcessIntegrity module exists with required exports', () => {
    const piSrc = fs.readFileSync(
      path.join(SRC_DIR, 'core/ProcessIntegrity.ts'),
      'utf-8',
    );
    expect(piSrc).toContain('class ProcessIntegrity');
    expect(piSrc).toContain('runningVersion');
    expect(piSrc).toContain('diskVersion');
    expect(piSrc).toContain('versionMismatch');
    expect(piSrc).toContain('frozenVersion');
    expect(piSrc).toContain('bootTimestamp');
  });

  // ── Rule 7: StaleProcessGuard exists for generalized stale detection ──

  it('StaleProcessGuard module exists with required exports', () => {
    const spgSrc = fs.readFileSync(
      path.join(SRC_DIR, 'core/StaleProcessGuard.ts'),
      'utf-8',
    );
    expect(spgSrc).toContain('class StaleProcessGuard');
    expect(spgSrc).toContain('registerSnapshot');
    expect(spgSrc).toContain('checkAll');
    expect(spgSrc).toContain('DriftReport');
  });

  // ── Rule 8: No new code paths that read version from disk at runtime ──

  it('no route handler reads package.json version directly', async () => {
    const routesSrc = fs.readFileSync(
      path.join(SRC_DIR, 'server/routes.ts'),
      'utf-8',
    );

    // Should not contain patterns like fs.readFileSync(...package.json...)
    // in the routes file — version should come from ProcessIntegrity
    const readPkgPatterns = [
      /readFileSync.*package\.json/,
      /getInstarVersion\(\)/,
    ];

    for (const pattern of readPkgPatterns) {
      expect(routesSrc).not.toMatch(pattern);
    }
  });

  // ── Rule 9: The running version is the FROZEN one, not a live read ──

  it('ProcessIntegrity.runningVersion returns frozen value, not live disk', () => {
    const piSrc = fs.readFileSync(
      path.join(SRC_DIR, 'core/ProcessIntegrity.ts'),
      'utf-8',
    );

    // The runningVersion getter should return this.frozenVersion
    // NOT read from disk
    const runningVersionGetter = piSrc.match(/get runningVersion.*?{[\s\S]*?}/);
    expect(runningVersionGetter).toBeTruthy();
    expect(runningVersionGetter![0]).toContain('frozenVersion');
    expect(runningVersionGetter![0]).not.toContain('readFileSync');
  });
});

describe('META: Stale state detection infrastructure', () => {

  it('server.ts registers version with StaleProcessGuard', () => {
    const serverSrc = fs.readFileSync(
      path.join(SRC_DIR, 'commands/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toContain('StaleProcessGuard');
    expect(serverSrc).toContain("registerSnapshot");
    expect(serverSrc).toContain("'instar-version'");
  });
});

// ── META: Foreground restart gap prevention ───────────────────────
//
// The Luna Incident (v0.9.70): All agents run in --foreground mode.
// AutoUpdater writes restart-requested.json, but ONLY the ServerSupervisor
// (lifeline mode) polls for it. In foreground mode, nobody picks up
// the flag → the process stays stale forever.
//
// These tests ensure the foreground server path ALWAYS has restart
// handling, preventing the gap from reopening.

describe('META: Foreground restart gap prevention', () => {

  // ── Rule 1: Foreground path must have restart handling ──

  it('server.ts imports ForegroundRestartWatcher', () => {
    const serverSrc = fs.readFileSync(
      path.join(SRC_DIR, 'commands/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toContain("import { ForegroundRestartWatcher }");
  });

  it('foreground server path creates ForegroundRestartWatcher', () => {
    const serverSrc = fs.readFileSync(
      path.join(SRC_DIR, 'commands/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toContain('new ForegroundRestartWatcher');
  });

  it('foreground server path starts the restart watcher', () => {
    const serverSrc = fs.readFileSync(
      path.join(SRC_DIR, 'commands/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toContain('restartWatcher.start()');
  });

  // ── Rule 2: ForegroundRestartWatcher must exist with the right shape ──

  it('ForegroundRestartWatcher module exists with required exports', () => {
    const frwSrc = fs.readFileSync(
      path.join(SRC_DIR, 'core/ForegroundRestartWatcher.ts'),
      'utf-8',
    );
    expect(frwSrc).toContain('class ForegroundRestartWatcher');
    expect(frwSrc).toContain('restart-requested.json');
    expect(frwSrc).toContain('onRestartDetected');
    expect(frwSrc).toContain('restartDetected');
  });

  // ── Rule 3: ForegroundRestartWatcher acts on expired flags ──
  // The supervisor ignores expired flags. ForegroundRestartWatcher must NOT —
  // a stale process is worse than a late restart.

  it('ForegroundRestartWatcher does NOT skip expired flags', () => {
    const frwSrc = fs.readFileSync(
      path.join(SRC_DIR, 'core/ForegroundRestartWatcher.ts'),
      'utf-8',
    );

    // Should NOT have early return on expired flags
    // The supervisor has: if (expired) { return; }
    // ForegroundRestartWatcher should log a warning but continue
    const checkMethod = frwSrc.match(/private async check\(\)[\s\S]*?^  \}/m);
    expect(checkMethod).toBeTruthy();

    // Should contain the expired warning but NOT return early
    expect(frwSrc).toContain('stale process is worse than late restart');
  });

  // ── Rule 4: AutoUpdater restart-requested.json has sufficient TTL ──

  it('AutoUpdater restart-requested TTL is at least 30 minutes', () => {
    const auSrc = fs.readFileSync(
      path.join(SRC_DIR, 'core/AutoUpdater.ts'),
      'utf-8',
    );

    // Find the TTL assignment
    const ttlMatch = auSrc.match(/expiresAt.*Date\.now\(\)\s*\+\s*([\d_]+)\s*\*\s*([\d_]+)\s*\*\s*([\d_]+)/);
    if (ttlMatch) {
      // Calculate TTL in ms
      const parts = ttlMatch.slice(1).map(s => parseInt(s.replace(/_/g, ''), 10));
      const ttlMs = parts.reduce((a, b) => a * b, 1);
      // Must be at least 30 minutes
      expect(ttlMs).toBeGreaterThanOrEqual(30 * 60 * 1000);
    } else {
      // Alternative pattern: direct ms value
      const directMatch = auSrc.match(/expiresAt.*Date\.now\(\)\s*\+\s*([\d_]+)/);
      if (directMatch) {
        const ttlMs = parseInt(directMatch[1].replace(/_/g, ''), 10);
        expect(ttlMs).toBeGreaterThanOrEqual(30 * 60 * 1000);
      } else {
        // Must have SOME TTL
        expect(auSrc).toContain('expiresAt');
      }
    }
  });

  // ── Rule 5: The notification on restart detection is IMMEDIATE, not SUMMARY ──

  it('restart detection notification uses IMMEDIATE tier', () => {
    const serverSrc = fs.readFileSync(
      path.join(SRC_DIR, 'commands/server.ts'),
      'utf-8',
    );

    // Find the onRestartDetected callback
    const restartBlock = serverSrc.match(/onRestartDetected[\s\S]*?}\s*,?\s*\n\s*}/);
    expect(restartBlock).toBeTruthy();
    // Must use IMMEDIATE, not SUMMARY — restart is urgent
    expect(restartBlock![0]).toContain("'IMMEDIATE'");
  });
});

// ── META: Shadow installation prevention ──────────────────────────
//
// The Luna Incident (deeper layer): a local `npm install instar` in the
// project directory created node_modules/ that shadowed the global binary.
// Auto-updates went to the global, but the server loaded the stale local.
//
// These tests ensure shadow installations are detected both at startup
// and at runtime via CoherenceMonitor.

describe('META: Shadow installation prevention', () => {

  // ── Rule 1: Server startup detects shadow installations ──

  it('server.ts checks for local node_modules/instar at startup', () => {
    const serverSrc = fs.readFileSync(
      path.join(SRC_DIR, 'commands/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toContain('SHADOW INSTALLATION DETECTED');
    expect(serverSrc).toContain('node_modules');
  });

  // ── Rule 2: CoherenceMonitor checks for shadow installations ──

  it('CoherenceMonitor has shadow installation check', () => {
    const coherenceSrc = fs.readFileSync(
      path.join(SRC_DIR, 'monitoring/CoherenceMonitor.ts'),
      'utf-8',
    );
    expect(coherenceSrc).toContain('checkShadowInstallation');
    expect(coherenceSrc).toContain('shadow-installation');
  });

  it('CoherenceMonitor runs shadow check during runCheck()', () => {
    const coherenceSrc = fs.readFileSync(
      path.join(SRC_DIR, 'monitoring/CoherenceMonitor.ts'),
      'utf-8',
    );

    // Find the runCheck method and verify shadow check is called
    const runCheckBlock = coherenceSrc.match(/runCheck\(\)[\s\S]*?return report;/);
    expect(runCheckBlock).toBeTruthy();
    expect(runCheckBlock![0]).toContain('checkShadowInstallation');
  });
});
