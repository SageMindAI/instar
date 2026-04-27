/**
 * Autonomous skill deployment — validates that the autonomous skill
 * is fully installed with its stop hook, which is the structural enforcement
 * mechanism for long-running autonomous sessions.
 *
 * Root cause: Sessions were entering "autonomous mode" but the stop hook
 * was never deployed, so there was no structural enforcement. Sessions would
 * do some work, finish a response, and just stop. The zombie detector then
 * killed them after 15 minutes of idle-at-prompt.
 *
 * These tests ensure the autonomous skill is always fully deployed with
 * all three critical components: skill.md, hooks, and scripts.
 */

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../src/commands/init.js';

describe('Autonomous skill deployment', () => {
  const testBase = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-autonomous-'));
  const projectName = 'test-autonomous';
  const projectDir = path.join(testBase, projectName);

  afterAll(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(testBase, { recursive: true, force: true });
  });

  it('creates project with autonomous skill', async () => {
    const originalCwd = process.cwd();
    process.chdir(testBase);
    try {
      await initProject({ name: projectName, port: 4555, skipPrereqs: true });
    } finally {
      process.chdir(originalCwd);
    }
    expect(fs.existsSync(projectDir)).toBe(true);
  });

  describe('autonomous skill directory structure', () => {
    it('installs SKILL.md', () => {
      const skillFile = path.join(projectDir, '.claude', 'skills', 'autonomous', 'SKILL.md');
      expect(fs.existsSync(skillFile)).toBe(true);

      const content = fs.readFileSync(skillFile, 'utf-8');
      expect(content).toContain('autonomous');
      expect(content).toContain('stop hook');
    });

    it('installs hooks directory with hooks.json', () => {
      const hooksJson = path.join(projectDir, '.claude', 'skills', 'autonomous', 'hooks', 'hooks.json');
      expect(fs.existsSync(hooksJson)).toBe(true);

      const config = JSON.parse(fs.readFileSync(hooksJson, 'utf-8'));
      expect(config.hooks).toBeDefined();
      expect(config.hooks.Stop).toBeDefined();
      expect(config.hooks.Stop.length).toBeGreaterThan(0);
    });

    it('installs autonomous-stop-hook.sh', () => {
      const hookScript = path.join(projectDir, '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
      expect(fs.existsSync(hookScript)).toBe(true);

      // Must be executable
      const stats = fs.statSync(hookScript);
      expect(stats.mode & 0o111).toBeGreaterThan(0);

      const content = fs.readFileSync(hookScript, 'utf-8');
      // Core behavioral assertions — the hook must:
      expect(content).toContain('autonomous-state.local.md'); // Read state file
      expect(content).toContain('session_id'); // Session isolation
      expect(content).toContain('"decision": "block"'); // Block exit
      expect(content).toContain('completion_promise'); // Check for completion
      expect(content).toContain('emergency-stop'); // Respect emergency stop
    });

    it('installs setup-autonomous.sh', () => {
      const setupScript = path.join(projectDir, '.claude', 'skills', 'autonomous', 'scripts', 'setup-autonomous.sh');
      expect(fs.existsSync(setupScript)).toBe(true);

      const content = fs.readFileSync(setupScript, 'utf-8');
      expect(content).toContain('autonomous-state.local.md'); // Creates state file
      expect(content).toContain('CLAUDE_CODE_SESSION_ID'); // Session scoping
    });
  });

  describe('settings.json hook registration', () => {
    it('registers autonomous stop hook in Stop hooks', () => {
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

      expect(settings.hooks?.Stop).toBeDefined();
      const stopHooks = settings.hooks.Stop as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;

      // The autonomous stop hook must be registered
      const hasAutonomousHook = stopHooks.some(entry =>
        entry.hooks?.some(h => h.command?.includes('autonomous-stop-hook')),
      );
      expect(hasAutonomousHook).toBe(true);
    });

    it('places autonomous stop hook FIRST in the Stop chain', () => {
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

      const stopHooks = settings.hooks.Stop as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      const firstHook = stopHooks[0];

      // Must be first so it blocks before other hooks run
      expect(firstHook.hooks?.[0]?.command).toContain('autonomous-stop-hook');
    });
  });
});

describe('Autonomous stop hook source analysis', () => {
  const hookPath = path.join(process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');

  it('stop hook source file exists', () => {
    expect(fs.existsSync(hookPath)).toBe(true);
  });

  it('uses session isolation to avoid trapping other sessions', () => {
    const content = fs.readFileSync(hookPath, 'utf-8');
    // Must check session_id from hook input against state file
    expect(content).toContain('STATE_SESSION');
    expect(content).toContain('HOOK_SESSION');
    // Must fail-open for non-matching sessions
    expect(content).toContain('exit 0');
  });

  it('checks for duration expiry', () => {
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('duration_seconds');
    expect(content).toContain('ELAPSED');
    // Must remove state file on expiry
    expect(content).toContain('rm "$STATE_FILE"');
  });

  it('checks for completion promise', () => {
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('COMPLETION_PROMISE');
    expect(content).toContain('<promise>');
  });

  it('increments iteration counter', () => {
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('NEXT_ITERATION');
    expect(content).toContain('iteration:');
  });

  it('handles progress reporting', () => {
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('REPORT_DUE');
    expect(content).toContain('report_interval');
    expect(content).toContain('PROGRESS REPORT DUE');
  });

  it('outputs valid JSON block decision', () => {
    const content = fs.readFileSync(hookPath, 'utf-8');
    // Must use jq to output structured JSON
    expect(content).toContain('jq -n');
    expect(content).toContain('"decision": "block"');
    expect(content).toContain('"reason"');
    expect(content).toContain('"systemMessage"');
  });
});
