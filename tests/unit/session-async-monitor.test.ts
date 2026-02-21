import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Validates async monitoring implementation in SessionManager.
 */
describe('SessionManager async monitoring', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/core/SessionManager.ts'),
    'utf-8'
  );

  it('uses async monitoring to avoid blocking the event loop', () => {
    // Monitor tick should be async
    expect(source).toContain('async monitorTick()');
    // Uses execFileAsync instead of execFileSync in monitoring
    expect(source).toContain('await execFileAsync');
  });

  it('imports promisify and execFile for async exec', () => {
    expect(source).toContain("import { execFileSync, execFile } from 'node:child_process'");
    expect(source).toContain("import { promisify } from 'node:util'");
    expect(source).toContain('const execFileAsync = promisify(execFile)');
  });

  it('has isSessionAliveAsync for non-blocking checks', () => {
    expect(source).toContain('async isSessionAliveAsync');
    expect(source).toContain('await execFileAsync');
  });

  it('prevents overlapping monitor ticks', () => {
    expect(source).toContain('monitoringInProgress');
    expect(source).toContain('if (this.monitoringInProgress) return');
    // Must be reset in finally block
    expect(source).toContain('} finally {');
    expect(source).toContain('this.monitoringInProgress = false');
  });

  it('still has sync isSessionAlive for immediate callers', () => {
    // listRunningSessions and other sync callers need the sync version
    expect(source).toContain('isSessionAlive(tmuxSession: string): boolean');
    // Checks tmux session exists AND verifies Claude process is running
    expect(source).toContain('if (!this.tmuxSessionExists(tmuxSession)) return false');
    expect(source).toContain('pane_current_command');
  });

  it('catches and logs monitor tick errors', () => {
    expect(source).toContain('.catch(err =>');
    expect(source).toContain('Monitor tick error');
  });
});
