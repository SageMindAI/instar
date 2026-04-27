/**
 * ResponseReviewHook — Tests for the stop hook integration (Phase 2).
 *
 * Tests hook template generation, settings template structure, and
 * hook behavior (stdin/stdout contract, server communication, error handling).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ── PostUpdateMigrator Hook Template Tests ──────────────────────────

describe('PostUpdateMigrator — response-review hook', () => {
  it('generates a valid response-review.js hook', async () => {
    // Dynamic import to handle ESM
    const { PostUpdateMigrator } = await import('../../src/core/PostUpdateMigrator.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-test-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      port: 4042,
      stateDir,
    }));

    const migrator = new PostUpdateMigrator({
      port: 4042,
      stateDir,
    } as any);

    const content = migrator.getHookContent('response-review');

    // Structure checks
    expect(content).toContain('#!/usr/bin/env node');
    expect(content).toContain('response-review');
    expect(content).toContain('/review/evaluate');
    expect(content).toContain('process.stdin');
    expect(content).toContain('process.exit');

    // Auth handling
    expect(content).toContain('authToken');
    expect(content).toContain('Authorization');
    expect(content).toContain('Bearer');

    // Port baking
    expect(content).toContain('4042');

    // Fail-open behavior
    expect(content).toContain('process.exit(0)');

    // Block behavior
    expect(content).toContain('process.exit(2)');
    expect(content).toContain("decision: 'block'");

    // Config check for enabled flag
    expect(content).toContain('responseReview');
    expect(content).toContain('reviewEnabled');

    // Channel detection from env
    expect(content).toContain('INSTAR_TELEGRAM_TOPIC');
    expect(content).toContain('INSTAR_SESSION_ID');

    // Does NOT skip on stop_hook_active (server handles retry logic)
    // Verify it does NOT contain the guard pattern used by other hooks
    expect(content).not.toContain('if (input.stop_hook_active) process.exit(0)');

    // Passes stopHookActive to server
    expect(content).toContain('stopHookActive');
    expect(content).toContain('input.stop_hook_active');

    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bakes the configured port into the hook template', async () => {
    const { PostUpdateMigrator } = await import('../../src/core/PostUpdateMigrator.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-test-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      port: 9999,
      stateDir,
    }));

    const migrator = new PostUpdateMigrator({
      port: 9999,
      stateDir,
    } as any);

    const content = migrator.getHookContent('response-review');
    expect(content).toContain('9999');
  });

  it('migrateHooks source includes response-review.js write', () => {
    // migrateHooks is private, so verify via source inspection that
    // the response-review.js hook is written during migration
    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    const migratorPath = path.resolve(sourceDir, '../../src/core/PostUpdateMigrator.ts');
    const source = fs.readFileSync(migratorPath, 'utf-8');

    // Check that migrateHooks writes response-review.js
    expect(source).toContain("'response-review.js'), this.getResponseReviewHook()");
    expect(source).toContain('coherence gate response review pipeline');
  });

  it('includes response-review.js in builtinHooks list', async () => {
    const { PostUpdateMigrator } = await import('../../src/core/PostUpdateMigrator.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-test-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      port: 4042,
      stateDir,
    }));

    // Read the source to verify the builtinHooks list includes response-review.js
    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    const migratorPath = path.resolve(sourceDir, '../../src/core/PostUpdateMigrator.ts');
    const source = fs.readFileSync(migratorPath, 'utf-8');
    expect(source).toContain("'response-review.js'");

    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── Settings Template Tests ─────────────────────────────────────────

describe('settings-template.json — Stop hook registration', () => {
  it('includes Stop hook section with response-review', () => {
    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    const templatePath = path.resolve(sourceDir, '../../src/templates/hooks/settings-template.json');
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));

    expect(template.hooks.Stop).toBeDefined();
    expect(Array.isArray(template.hooks.Stop)).toBe(true);

    // Find response-review hook
    const hasResponseReview = template.hooks.Stop.some((entry: any) =>
      entry.hooks?.some((h: any) => h.command?.includes('response-review.js')),
    );
    expect(hasResponseReview).toBe(true);
  });

  it('places response-review before claim-intercept-response and scope-coherence-checkpoint', () => {
    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    const templatePath = path.resolve(sourceDir, '../../src/templates/hooks/settings-template.json');
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));

    const stopHooks = template.hooks.Stop;
    const responseReviewIdx = stopHooks.findIndex((e: any) =>
      e.hooks?.some((h: any) => h.command?.includes('response-review.js')),
    );
    const claimInterceptIdx = stopHooks.findIndex((e: any) =>
      e.hooks?.some((h: any) => h.command?.includes('claim-intercept-response.js')),
    );
    const scopeCheckpointIdx = stopHooks.findIndex((e: any) =>
      e.hooks?.some((h: any) => h.command?.includes('scope-coherence-checkpoint.js')),
    );

    expect(responseReviewIdx).toBeLessThan(claimInterceptIdx);
    expect(responseReviewIdx).toBeLessThan(scopeCheckpointIdx);
  });

  it('all Stop hooks have reasonable timeouts', () => {
    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    const templatePath = path.resolve(sourceDir, '../../src/templates/hooks/settings-template.json');
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));

    for (const entry of template.hooks.Stop) {
      for (const hook of entry.hooks) {
        expect(hook.timeout).toBeGreaterThanOrEqual(5000);
        expect(hook.timeout).toBeLessThanOrEqual(15000);
      }
    }
  });
});

// ── Hook Script Behavior Tests ──────────────────────────────────────
// These test the hook's behavior by examining the generated script content

describe('response-review hook behavior', () => {
  let hookContent: string;

  beforeEach(async () => {
    const { PostUpdateMigrator } = await import('../../src/core/PostUpdateMigrator.js');
    const migrator = new PostUpdateMigrator({
      port: 4042,
      stateDir: '/tmp/test-instar',
    } as any);
    hookContent = migrator.getHookContent('response-review');
  });

  it('skips messages shorter than 20 characters', () => {
    expect(hookContent).toContain('message.length < 20');
  });

  it('reads config from CLAUDE_PROJECT_DIR or current directory', () => {
    expect(hookContent).toContain('CLAUDE_PROJECT_DIR');
    expect(hookContent).toContain("'.instar'");
  });

  it('exits early when responseReview is not enabled', () => {
    expect(hookContent).toContain('reviewEnabled');
    expect(hookContent).toContain('process.exit(0)');
  });

  it('sends proper JSON body to /review/evaluate', () => {
    expect(hookContent).toContain('message');
    expect(hookContent).toContain('sessionId');
    expect(hookContent).toContain('stopHookActive');
    expect(hookContent).toContain('channel');
    expect(hookContent).toContain('isExternalFacing');
    expect(hookContent).toContain('recipientType');
  });

  it('uses AbortController for request timeout', () => {
    expect(hookContent).toContain('AbortController');
    expect(hookContent).toContain('abort');
  });

  it('handles server errors with fail-open', () => {
    // On non-ok response, should exit 0 (approve)
    expect(hookContent).toContain('!res.ok');
    expect(hookContent).toContain('process.exit(0)');
  });

  it('outputs block decision as JSON on stdout with exit 2', () => {
    expect(hookContent).toContain("decision: 'block'");
    expect(hookContent).toContain('process.stdout.write');
    expect(hookContent).toContain('process.exit(2)');
  });

  it('writes warnings to stderr', () => {
    expect(hookContent).toContain('process.stderr.write');
    expect(hookContent).toContain('[response-review]');
  });

  it('determines channel from INSTAR_TELEGRAM_TOPIC env var', () => {
    expect(hookContent).toContain("INSTAR_TELEGRAM_TOPIC");
    expect(hookContent).toContain("'telegram'");
    expect(hookContent).toContain("'direct'");
  });

  it('passes through stop_hook_active to server (no local guard)', () => {
    // Should NOT have the guard pattern
    expect(hookContent).not.toContain('if (input.stop_hook_active) process.exit(0)');
    // Should pass it to the server
    expect(hookContent).toContain('stopHookActive: !!input.stop_hook_active');
  });
});

// ── Init.ts Registration Tests ──────────────────────────────────────

describe('init.ts — Stop hook registration', () => {
  it('init.ts source registers response-review hook', () => {
    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    const initPath = path.resolve(sourceDir, '../../src/commands/init.ts');
    const source = fs.readFileSync(initPath, 'utf-8');

    // Check hook definition
    expect(source).toContain('response-review.js');
    expect(source).toContain("migrator.getHookContent('response-review')");

    // Check Stop hook registration
    expect(source).toContain('responseReviewHook');
    expect(source).toContain('hasResponseReview');
  });

  it('init.ts registers response-review before claim-intercept and scope-checkpoint', () => {
    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    const initPath = path.resolve(sourceDir, '../../src/commands/init.ts');
    const source = fs.readFileSync(initPath, 'utf-8');

    // Response review registration should appear first (unshift)
    const responseReviewReg = source.indexOf("hasResponseReview");
    const claimInterceptReg = source.indexOf("hasClaimIntercept");
    const scopeCheckpointReg = source.indexOf("hasCheckpoint");

    expect(responseReviewReg).toBeGreaterThan(0);
    expect(responseReviewReg).toBeLessThan(claimInterceptReg);
    expect(responseReviewReg).toBeLessThan(scopeCheckpointReg);
  });
});
