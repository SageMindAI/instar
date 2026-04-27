/**
 * E2E test — Upgrade guide full production lifecycle.
 *
 * Tests the complete PRODUCTION path from guide creation through
 * delivery to the agent and user notification:
 *
 *   1. Versioned guide file exists in upgrades/ directory
 *   2. UpgradeGuideProcessor finds and delivers it to pending file
 *   3. Session-start hook detects pending guide (simulated)
 *   4. UpgradeNotifyManager spawns session with correct prompt
 *   5. Session acknowledges guide (simulated)
 *   6. Pending guide is cleared
 *   7. Subsequent startups find nothing new
 *   8. Multi-version upgrade delivers all intervening guides
 *   9. Failed notification preserves guide for retry
 *  10. Recovery: second startup successfully delivers after first failure
 *
 * This is the test that would have caught the "NEXT.md never renamed"
 * bug — it verifies that ONLY versioned files (not NEXT.md) are
 * delivered through the pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpgradeGuideProcessor } from '../../src/core/UpgradeGuideProcessor.js';
import {
  UpgradeNotifyManager,
  type UpgradeNotifyConfig,
} from '../../src/core/UpgradeNotifyManager.js';

describe('Upgrade guide lifecycle E2E', () => {
  let tmpDir: string;
  let stateDir: string;
  let upgradesDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    upgradesDir = path.join(tmpDir, 'upgrades');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(upgradesDir, { recursive: true });
  });

  afterAll(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProcessor(opts: {
    currentVersion: string;
    previousVersion?: string;
  }): UpgradeGuideProcessor {
    const proc = new UpgradeGuideProcessor({
      stateDir,
      currentVersion: opts.currentVersion,
      previousVersion: opts.previousVersion,
    });
    // @ts-expect-error — testing private method override
    proc.findUpgradesDir = () => upgradesDir;
    return proc;
  }

  function makeNotifyManager(pendingGuidePath: string, opts: {
    onSessionSpawn?: (model: string) => void;
    shouldAcknowledge?: boolean;
    shouldComplete?: boolean;
  } = {}): {
    manager: UpgradeNotifyManager;
    spawnedModels: string[];
    activityLog: Array<{ type: string; summary: string }>;
  } {
    const spawnedModels: string[] = [];
    const activityLog: Array<{ type: string; summary: string }> = [];
    const sessionsComplete = new Set<string>();
    let sessionCounter = 0;

    const config: UpgradeNotifyConfig = {
      pendingGuidePath,
      projectDir: tmpDir,
      stateDir,
      port: 3000,
      dashboardPin: 'test-pin',
      tunnelUrl: 'https://test.tunnel.dev',
      currentVersion: '0.9.86',
      replyScript: '/test/telegram-reply.sh',
      notifyTopicId: 100,
    };

    const manager = new UpgradeNotifyManager(
      config,
      async ({ name, prompt, model }) => {
        sessionCounter++;
        const id = `e2e-session-${sessionCounter}`;
        spawnedModels.push(model);
        opts.onSessionSpawn?.(model);

        if (opts.shouldComplete !== false) {
          sessionsComplete.add(id);
        }

        if (opts.shouldAcknowledge !== false) {
          // Simulate the session running `instar upgrade-ack`
          if (fs.existsSync(pendingGuidePath)) {
            // safe-git-allow: incremental-migration
            fs.unlinkSync(pendingGuidePath);
          }
        }

        return {
          id,
          name,
          status: 'running' as const,
          tmuxSession: `tmux-${id}`,
          startedAt: new Date().toISOString(),
          model,
          prompt,
        };
      },
      (sessionId) => sessionsComplete.has(sessionId),
      (event) => activityLog.push({ type: event.type, summary: event.summary }),
      { sessionTimeoutMs: 2000, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    return { manager, spawnedModels, activityLog };
  }

  const pendingPath = () => path.join(stateDir, 'state', 'pending-upgrade-guide.md');

  function writeVersionedGuide(version: string) {
    fs.writeFileSync(path.join(upgradesDir, `${version}.md`), `# Upgrade Guide — v${version}

## What Changed
Version ${version} adds exciting new features including improved search and better memory.

## What to Tell Your User
- **New in v${version}**: "This update brings improvements that make me smarter and more capable."

## Summary of New Capabilities
| Capability | How to Use |
|-----------|-----------|
| Feature ${version} | POST /api/v${version}/feature |
`);
  }

  function cleanState() {
    const processedFile = path.join(stateDir, 'state', 'processed-upgrades.json');
    // safe-git-allow: incremental-migration
    if (fs.existsSync(processedFile)) fs.unlinkSync(processedFile);
    // safe-git-allow: incremental-migration
    if (fs.existsSync(pendingPath())) fs.unlinkSync(pendingPath());
    // Clean guide files
    for (const f of fs.readdirSync(upgradesDir)) {
      // safe-git-allow: incremental-migration
      fs.unlinkSync(path.join(upgradesDir, f));
    }
  }

  // 1. Complete happy path: guide → processor → notify → acknowledged
  it('complete lifecycle: versioned guide delivered and acknowledged', async () => {
    cleanState();
    writeVersionedGuide('0.9.86');

    // Step 1: Processor finds and stages the guide
    const proc = makeProcessor({ currentVersion: '0.9.86', previousVersion: '0.9.85' });
    const procResult = proc.process();

    expect(procResult.pendingGuides).toEqual(['0.9.86']);
    expect(fs.existsSync(pendingPath())).toBe(true);

    // Step 2: UpgradeNotifyManager delivers it
    const { manager, spawnedModels, activityLog } = makeNotifyManager(pendingPath());
    const notifyResult = await manager.notify();

    expect(notifyResult.success).toBe(true);
    expect(notifyResult.model).toBe('haiku');
    expect(spawnedModels).toEqual(['haiku']);
    expect(activityLog.some(e => e.type === 'upgrade_notify_success')).toBe(true);

    // Step 3: Pending guide is gone
    expect(fs.existsSync(pendingPath())).toBe(false);
  });

  // 2. NEXT.md does NOT deliver — the exact bug we're testing
  it('NEXT.md is NOT delivered through the pipeline (regression test)', () => {
    cleanState();

    // Write ONLY NEXT.md (not a versioned file)
    fs.writeFileSync(path.join(upgradesDir, 'NEXT.md'), `# Guide
## What Changed
New stuff.
## What to Tell Your User
- New stuff.
## Summary of New Capabilities
| Cap | Use |
|-----|-----|
| X | Y |
`);

    const proc = makeProcessor({ currentVersion: '0.9.86', previousVersion: '0.9.85' });
    const result = proc.process();

    // NEXT.md should NOT be picked up
    expect(result.pendingGuides).toEqual([]);
    expect(fs.existsSync(pendingPath())).toBe(false);
  });

  // 3. Multi-version upgrade delivers all intervening guides
  it('multi-version jump delivers all guides between old and new', async () => {
    cleanState();
    writeVersionedGuide('0.9.83');
    writeVersionedGuide('0.9.84');
    writeVersionedGuide('0.9.85');
    writeVersionedGuide('0.9.86');

    // Agent jumping from 0.9.82 → 0.9.86
    const proc = makeProcessor({ currentVersion: '0.9.86', previousVersion: '0.9.82' });
    const result = proc.process();

    // Should deliver 0.9.83, 0.9.84, 0.9.85, 0.9.86
    expect(result.pendingGuides).toEqual(['0.9.83', '0.9.84', '0.9.85', '0.9.86']);

    // Pending guide should contain all 4
    const content = fs.readFileSync(pendingPath(), 'utf-8');
    expect(content).toContain('4 upgrade guides to process');
    expect(content).toContain('v0.9.83');
    expect(content).toContain('v0.9.86');
  });

  // 4. Failed notification preserves guide for retry
  it('failed notification preserves guide for next startup', async () => {
    cleanState();
    writeVersionedGuide('0.9.86');

    const proc = makeProcessor({ currentVersion: '0.9.86', previousVersion: '0.9.85' });
    proc.process();

    // Notification fails (sessions complete but don't acknowledge)
    const { manager } = makeNotifyManager(pendingPath(), {
      shouldAcknowledge: false,
    });
    const result = await manager.notify();

    expect(result.success).toBe(false);
    // Pending guide should STILL exist
    expect(fs.existsSync(pendingPath())).toBe(true);
  });

  // 5. Recovery after failure: next startup delivers successfully
  it('second startup successfully delivers after first failure', async () => {
    cleanState();
    writeVersionedGuide('0.9.86');

    // First startup: process and fail notification
    const proc1 = makeProcessor({ currentVersion: '0.9.86', previousVersion: '0.9.85' });
    proc1.process();

    const { manager: failManager } = makeNotifyManager(pendingPath(), {
      shouldAcknowledge: false,
    });
    await failManager.notify();
    expect(fs.existsSync(pendingPath())).toBe(true); // Still there

    // Second startup: notify again (pending file already exists from first run)
    // Note: processor.process() won't re-deliver since 0.9.86 is already marked processed,
    // but the pending file persists from the failed delivery — this is the recovery path.
    const { manager: successManager, activityLog } = makeNotifyManager(pendingPath(), {
      shouldAcknowledge: true,
    });
    const result = await successManager.notify();

    expect(result.success).toBe(true);
    expect(fs.existsSync(pendingPath())).toBe(false);
    expect(activityLog.some(e => e.type === 'upgrade_notify_success')).toBe(true);
  });

  // 6. Subsequent startup finds nothing new after successful delivery
  it('subsequent startup finds nothing new after successful delivery', async () => {
    cleanState();
    writeVersionedGuide('0.9.86');

    // First startup: deliver successfully
    const proc1 = makeProcessor({ currentVersion: '0.9.86', previousVersion: '0.9.85' });
    proc1.process();

    const { manager } = makeNotifyManager(pendingPath());
    await manager.notify();

    // Second startup: nothing to do
    const proc2 = makeProcessor({ currentVersion: '0.9.86', previousVersion: '0.9.85' });
    const result = proc2.process();

    expect(result.pendingGuides).toEqual([]);
    expect(result.alreadyProcessed).toContain('0.9.86');
    expect(fs.existsSync(pendingPath())).toBe(false);
  });

  // 7. Prompt contains all required elements for agent
  it('notification prompt contains guide content, steps, and concrete details', async () => {
    cleanState();
    writeVersionedGuide('0.9.86');

    const proc = makeProcessor({ currentVersion: '0.9.86', previousVersion: '0.9.85' });
    proc.process();

    let capturedPrompt = '';
    const { manager } = makeNotifyManager(pendingPath(), {
      onSessionSpawn: () => {
        // Read the pending guide to build the prompt
      },
    });

    // Build the prompt directly to inspect
    const guideContent = fs.readFileSync(pendingPath(), 'utf-8');
    const prompt = manager.buildPrompt(guideContent);

    // Guide content
    expect(prompt).toContain('v0.9.86');
    expect(prompt).toContain('improved search');

    // Three required steps
    expect(prompt).toContain('Step 1');
    expect(prompt).toContain('Step 2');
    expect(prompt).toContain('Step 3');
    expect(prompt).toContain('upgrade-ack');

    // Concrete details
    expect(prompt).toContain('test.tunnel.dev');
    expect(prompt).toContain('test-pin');
    expect(prompt).toContain('telegram-reply.sh');
  });

  // 8. Model escalation works end-to-end
  it('escalates from haiku to sonnet when haiku fails', async () => {
    cleanState();
    writeVersionedGuide('0.9.86');

    const proc = makeProcessor({ currentVersion: '0.9.86', previousVersion: '0.9.85' });
    proc.process();

    let attempt = 0;
    const spawnedModels: string[] = [];
    const sessionsComplete = new Set<string>();

    const config: UpgradeNotifyConfig = {
      pendingGuidePath: pendingPath(),
      projectDir: tmpDir,
      stateDir,
      port: 3000,
      dashboardPin: '',
      tunnelUrl: '',
      currentVersion: '0.9.86',
      replyScript: '',
      notifyTopicId: 0,
    };

    const manager = new UpgradeNotifyManager(
      config,
      async ({ name, model, prompt }) => {
        attempt++;
        const id = `escalation-${attempt}`;
        spawnedModels.push(model);
        sessionsComplete.add(id);

        // Only acknowledge on second attempt (sonnet)
        if (attempt >= 2 && fs.existsSync(pendingPath())) {
          // safe-git-allow: incremental-migration
          fs.unlinkSync(pendingPath());
        }

        return {
          id,
          name,
          status: 'running' as const,
          tmuxSession: `tmux-${id}`,
          startedAt: new Date().toISOString(),
          model,
          prompt,
        };
      },
      (sessionId) => sessionsComplete.has(sessionId),
      () => {},
      { sessionTimeoutMs: 1000, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    const result = await manager.notify();

    expect(result.success).toBe(true);
    expect(result.model).toBe('sonnet');
    expect(spawnedModels).toEqual(['haiku', 'sonnet']);
  });
});
