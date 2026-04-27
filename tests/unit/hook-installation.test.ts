/**
 * Unit test — Hook installation for external operation safety.
 *
 * Verifies that `instar init` installs:
 * - external-operation-gate.js hook in .instar/hooks/
 * - MCP matcher in .claude/settings.json PreToolUse hooks
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../../src/commands/init.js';

describe('Hook installation for external operation safety', () => {
  let tmpDir: string;
  let projectDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hook-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    const projectName = 'test-hooks-project';
    await initProject({
      name: projectName,
      skipPrereqs: true,
    });
    projectDir = path.join(tmpDir, projectName);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('installs external-operation-gate.js hook', () => {
    const hookPath = path.join(projectDir, '.instar', 'hooks', 'instar', 'external-operation-gate.js');
    expect(fs.existsSync(hookPath)).toBe(true);

    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('mcp__');
    expect(content).toContain('/operations/evaluate');
    expect(content).toContain('mutability');
    expect(content).toContain('BLOCKED');
  });

  it('hook is executable', () => {
    const hookPath = path.join(projectDir, '.instar', 'hooks', 'instar', 'external-operation-gate.js');
    const stats = fs.statSync(hookPath);
    // Check execute bit (0o100 for owner)
    expect(stats.mode & 0o100).toBeTruthy();
  });

  it('hook classifies delete operations correctly in its logic', () => {
    const hookPath = path.join(projectDir, '.instar', 'hooks', 'instar', 'external-operation-gate.js');
    const content = fs.readFileSync(hookPath, 'utf-8');

    // Verify the regex patterns exist for each mutability category
    expect(content).toContain('delete|remove|trash|purge|destroy|drop|clear');
    expect(content).toContain('send|create|post|write|add|insert|new|compose|publish');
    expect(content).toContain('update|modify|edit|patch|rename|move|change|set|toggle|enable|disable');
  });

  it('adds MCP matcher to .claude/settings.json', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();

    // Find MCP matcher
    const preToolUse = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: unknown[] }>;
    const mcpEntry = preToolUse.find(e => e.matcher === 'mcp__.*');
    expect(mcpEntry).toBeDefined();
    expect(mcpEntry!.hooks.length).toBeGreaterThan(0);

    // Check that the hook command is correct
    const hookCommand = (mcpEntry!.hooks[0] as { command: string }).command;
    expect(hookCommand).toContain('external-operation-gate.js');
  });

  it('preserves Bash hooks alongside MCP hooks', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const preToolUse = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: unknown[] }>;

    // Both Bash and MCP matchers should exist
    const bashEntry = preToolUse.find(e => e.matcher === 'Bash');
    const mcpEntry = preToolUse.find(e => e.matcher === 'mcp__.*');
    expect(bashEntry).toBeDefined();
    expect(mcpEntry).toBeDefined();
  });

  it('MCP hook is blocking', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const preToolUse = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ blocking?: boolean }> }>;
    const mcpEntry = preToolUse.find(e => e.matcher === 'mcp__.*');

    expect(mcpEntry!.hooks[0].blocking).toBe(true);
  });

  it('MCP hook has timeout', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const preToolUse = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ timeout?: number }> }>;
    const mcpEntry = preToolUse.find(e => e.matcher === 'mcp__.*');

    expect(mcpEntry!.hooks[0].timeout).toBe(5000);
  });

  // ── Hook Event Reporter (session resume support) ──────────────

  it('installs hook-event-reporter.js script', () => {
    const hookPath = path.join(projectDir, '.instar', 'hooks', 'instar', 'hook-event-reporter.js');
    expect(fs.existsSync(hookPath)).toBe(true);

    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('/hooks/events');
    expect(content).toContain('session_id');
    expect(content).toContain('INSTAR_SESSION_ID');
    expect(content).toContain('INSTAR_AUTH_TOKEN');
  });

  it('hook-event-reporter.js is executable', () => {
    const hookPath = path.join(projectDir, '.instar', 'hooks', 'instar', 'hook-event-reporter.js');
    const stats = fs.statSync(hookPath);
    expect(stats.mode & 0o100).toBeTruthy();
  });

  it('settings.json has command hooks for event reporting (not HTTP hooks)', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    // PostToolUse should have a catch-all command hook for event reporting
    const postToolUse = settings.hooks.PostToolUse as Array<{ matcher: string; hooks: Array<{ type: string; command?: string }> }>;
    const catchAll = postToolUse.find(e => e.matcher === '' && e.hooks.some(h => h.command?.includes('hook-event-reporter')));
    expect(catchAll).toBeDefined();
    expect(catchAll!.hooks[0].type).toBe('command');

    // No HTTP hooks should exist in the settings
    const json = JSON.stringify(settings);
    expect(json).not.toContain('"type":"http"');
    expect(json).not.toContain('"type": "http"');
  });

  // Regression: the script must run cleanly when the host package.json has
  // `"type": "module"` (ESM). The previous template used `require('http')` which
  // throws `ReferenceError: require is not defined in ES module scope` in that
  // context — and the instar repo itself has `"type": "module"`, so its own
  // Stop hook crashed. The fix is to load `http` via dynamic import.
  //
  // Earlier tests only checked the file existed and was +x; they never executed
  // it, which is why the bug shipped. This test actually runs it.
  it('hook-event-reporter.js runs cleanly in an ESM host', () => {
    const scriptSrc = path.join(projectDir, '.instar', 'hooks', 'instar', 'hook-event-reporter.js');
    expect(fs.existsSync(scriptSrc)).toBe(true);

    // Copy script into an isolated ESM host to isolate the module-type test
    // from whatever package.json the test project happens to create.
    const esmHost = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-esm-host-'));
    try {
      fs.writeFileSync(path.join(esmHost, 'package.json'), JSON.stringify({ type: 'module' }));
      const scriptDst = path.join(esmHost, 'hook-event-reporter.js');
      fs.copyFileSync(scriptSrc, scriptDst);

      // Run with auth envs set so the script takes the full code path
      // (otherwise it early-exits before reaching the `http` import).
      const result = spawnSync(process.execPath, [scriptDst], {
        cwd: esmHost,
        env: {
          ...process.env,
          INSTAR_AUTH_TOKEN: 'test-token',
          INSTAR_SESSION_ID: 'test-sid',
          INSTAR_SERVER_URL: 'http://127.0.0.1:1', // unreachable; script is fire-and-forget
        },
        input: JSON.stringify({ hook_event: 'Stop', session_id: 's', tool_name: '' }),
        timeout: 5000,
        encoding: 'utf-8',
      });

      // The specific bug we're guarding against: CJS `require` in ESM scope
      expect(result.stderr).not.toContain('require is not defined');
      expect(result.stderr).not.toContain('ReferenceError');

      // Script must exit cleanly (it ignores network failures by design)
      expect(result.status).toBe(0);
    } finally {
      // safe-git-allow: incremental-migration
      fs.rmSync(esmHost, { recursive: true, force: true });
    }
  });

  it('event reporter hooks exist for all required events', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    const requiredEvents = [
      'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop',
      'WorktreeCreate', 'WorktreeRemove', 'TaskCompleted',
      'SessionEnd', 'PreCompact',
    ];

    for (const event of requiredEvents) {
      const entries = settings.hooks[event] as Array<{ matcher: string; hooks: Array<{ command?: string }> }> | undefined;
      expect(entries, `Missing hook entries for event "${event}"`).toBeDefined();

      const hasReporter = entries!.some(e =>
        e.hooks?.some(h => h.command?.includes('hook-event-reporter')),
      );
      expect(hasReporter, `No hook-event-reporter found for event "${event}"`).toBe(true);
    }
  });
});
