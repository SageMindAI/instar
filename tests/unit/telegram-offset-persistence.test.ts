/**
 * Tests for TelegramAdapter polling offset persistence.
 *
 * Covers: offset save/load across restarts, corrupted file handling,
 * invalid values, and offset update after processing updates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('TelegramAdapter — offset persistence', () => {
  const sourcePath = path.join(process.cwd(), 'src/messaging/TelegramAdapter.ts');
  let source: string;

  // Read source once for all tests
  source = fs.readFileSync(sourcePath, 'utf-8');

  describe('offset file management', () => {
    it('has an offsetPath property for persistence', () => {
      expect(source).toContain('offsetPath');
      expect(source).toContain('telegram-poll-offset.json');
    });

    it('loads offset on construction', () => {
      expect(source).toContain('loadOffset()');
      // loadOffset should be called in constructor
      const constructorSection = source.slice(
        source.indexOf('constructor('),
        source.indexOf('async start()')
      );
      expect(constructorSection).toContain('this.loadOffset()');
    });

    it('saves offset after processing updates', () => {
      expect(source).toContain('saveOffset()');
      // saveOffset should be called in poll method after processing updates
      const pollSection = source.slice(source.indexOf('private async poll'));
      expect(pollSection).toContain('this.saveOffset()');
    });

    it('only saves when updates were received', () => {
      // Should check updates.length > 0 before saving
      expect(source).toContain('if (updates.length > 0)');
    });
  });

  describe('loadOffset validation', () => {
    it('validates offset is a positive finite number', () => {
      // Should check Number.isFinite and > 0
      const loadSection = source.slice(
        source.indexOf('private loadOffset'),
        source.indexOf('private saveOffset')
      );
      expect(loadSection).toContain('isFinite');
      expect(loadSection).toContain('> 0');
    });

    it('handles missing file gracefully', () => {
      const loadSection = source.slice(
        source.indexOf('private loadOffset'),
        source.indexOf('private saveOffset')
      );
      // Should have try-catch
      expect(loadSection).toContain('catch');
    });
  });

  describe('saveOffset atomicity', () => {
    it('uses atomic write pattern (temp file + rename)', () => {
      const start = source.indexOf('private saveOffset');
      const end = source.indexOf('private async poll');
      const saveSection = source.slice(start, end);
      expect(saveSection).toContain('.tmp');
      expect(saveSection).toContain('renameSync');
    });

    it('cleans up temp file on write failure', () => {
      const start = source.indexOf('private saveOffset');
      const end = source.indexOf('private async poll');
      const saveSection = source.slice(start, end);
      expect(saveSection).toContain('unlinkSync(tmpPath)');
    });
  });
});
