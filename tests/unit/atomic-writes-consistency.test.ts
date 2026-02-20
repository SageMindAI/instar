/**
 * Atomic writes consistency test — verifies ALL state-writing modules
 * use the write-to-tmp-then-rename pattern to prevent corruption
 * from process crashes during writes.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.join(process.cwd(), 'src');

/** List of all modules that persist state and MUST use atomic writes */
const STATE_WRITING_MODULES = [
  { file: 'core/StateManager.ts', methods: ['saveState', 'saveSession', 'saveJobState', 'appendEvent'] },
  { file: 'core/RelationshipManager.ts', methods: ['save'] },
  { file: 'core/FeedbackManager.ts', methods: ['saveFeedback'] },
  { file: 'core/UpdateChecker.ts', methods: ['saveState'] },
  { file: 'users/UserManager.ts', methods: ['persistUsers'] },
  { file: 'monitoring/QuotaTracker.ts', methods: ['saveState'] },
  { file: 'messaging/TelegramAdapter.ts', methods: ['saveRegistry'] },
];

describe('Atomic writes consistency', () => {
  for (const mod of STATE_WRITING_MODULES) {
    describe(mod.file, () => {
      let source: string;

      try {
        source = fs.readFileSync(path.join(SRC_ROOT, mod.file), 'utf-8');
      } catch {
        source = ''; // File may not exist yet
      }

      if (!source) {
        it.skip(`${mod.file} not found`, () => {});
        return;
      }

      it('uses renameSync for atomic writes', () => {
        // Must import or destructure renameSync
        expect(
          source.includes('renameSync') || source.includes('fs.renameSync')
        ).toBe(true);
      });

      it('writes to .tmp before renaming', () => {
        // Pattern: write to tmpPath, then rename
        expect(source).toContain('.tmp');
      });

      it('does NOT have bare writeFileSync as the final write for state', () => {
        // Check that writeFileSync is always followed by renameSync in the same method
        // This is a structural check — we look for the atomic pattern
        const lines = source.split('\n');
        let inSaveMethod = false;
        let hasWriteFile = false;
        let hasRename = false;

        for (const line of lines) {
          // Check if we're entering a save method
          for (const method of mod.methods) {
            if (line.includes(`${method}(`)) {
              inSaveMethod = true;
              hasWriteFile = false;
              hasRename = false;
            }
          }

          if (inSaveMethod) {
            if (line.includes('writeFileSync')) hasWriteFile = true;
            if (line.includes('renameSync')) hasRename = true;
          }
        }

        // If there's a save method with writeFileSync, it should also have renameSync
        if (hasWriteFile) {
          expect(hasRename).toBe(true);
        }
      });
    });
  }
});
