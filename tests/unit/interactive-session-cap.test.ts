/**
 * Tests that spawnInteractiveSession enforces maxSessions.
 *
 * Previously, spawnInteractiveSession bypassed the session cap check
 * that spawnSession has. This test verifies both methods respect the cap.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('SessionManager — interactive session cap', () => {
  it('spawnInteractiveSession checks maxSessions', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8',
    );

    // Extract the spawnInteractiveSession method
    const methodStart = source.indexOf('async spawnInteractiveSession(');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    // Should check maxSessions
    expect(method).toContain('maxSessions');
    expect(method).toContain('listRunningSessions');
  });

  it('spawnInteractiveSession includes --dangerously-skip-permissions', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8',
    );

    // Extract the spawnInteractiveSession method
    const methodStart = source.indexOf('async spawnInteractiveSession(');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    // Must include --dangerously-skip-permissions
    expect(method).toContain('--dangerously-skip-permissions');
  });

  it('spawnInteractiveSession does NOT use bash -c (shell injection risk)', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8',
    );

    // Extract the spawnInteractiveSession method
    const methodStart = source.indexOf('async spawnInteractiveSession(');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    // Must NOT use bash -c (claudePath with spaces would break --dangerously-skip-permissions)
    expect(method).not.toContain("'bash', '-c'");
    expect(method).not.toContain('"bash", "-c"');
  });

  it('spawnSession includes --dangerously-skip-permissions', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8',
    );

    // Extract the spawnSession method
    const methodStart = source.indexOf('async spawnSession(');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    // Must include --dangerously-skip-permissions
    expect(method).toContain('--dangerously-skip-permissions');
  });

  it('waitForClaudeReady has .catch() handler', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8',
    );

    // The promise chain should have a .catch() to prevent unhandled rejection
    expect(source).toContain('waitForClaudeReady(tmuxSession).then');
    expect(source).toContain('.catch(');
  });
});
