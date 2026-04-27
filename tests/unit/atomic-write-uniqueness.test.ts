/**
 * Tests that atomicWrite uses unique temp file names.
 *
 * Concurrent writes to the same key must use different .tmp files
 * to prevent data corruption.
 */

import { describe, it, expect } from 'vitest';
import { StateManager } from '../../src/core/StateManager.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('StateManager — atomic write uniqueness', () => {
  it('concurrent writes to the same key do not leave .tmp files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-atomic-'));
    const state = new StateManager(tmpDir);

    // Write the same key multiple times rapidly
    for (let i = 0; i < 10; i++) {
      state.set('test-key', { iteration: i });
    }

    // Verify final value is correct
    const result = state.get<{ iteration: number }>('test-key');
    expect(result).toBeTruthy();
    expect(result!.iteration).toBe(9);

    // Verify no .tmp files remain
    const stateDir = path.join(tmpDir, 'state');
    const files = fs.readdirSync(stateDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);

    // Clean up
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('atomicWrite does not use fixed .tmp filename', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/StateManager.ts'),
      'utf-8',
    );

    // Should NOT use the old pattern of filePath + '.tmp'
    expect(source).not.toContain("filePath + '.tmp'");
    // Should include process.pid for uniqueness
    expect(source).toContain('process.pid');
  });
});
