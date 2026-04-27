import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { maybeRotateJsonl } from '../../src/utils/jsonl-rotation.js';

describe('maybeRotateJsonl', () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-rotation-'));
    testFile = path.join(tmpDir, 'test.jsonl');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper to write N lines of ~100 bytes each
  function writeLines(n: number): void {
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      lines.push(JSON.stringify({ i, data: 'x'.repeat(80) }));
    }
    fs.writeFileSync(testFile, lines.join('\n') + '\n');
  }

  it('does not rotate when file is under the limit', () => {
    writeLines(5);
    const result = maybeRotateJsonl(testFile, { maxBytes: 10 * 1024 * 1024 });
    expect(result).toBe(false);

    // File should be unchanged
    const lines = fs.readFileSync(testFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(5);
  });

  it('rotates when file exceeds the limit', () => {
    writeLines(100);
    const sizeBefore = fs.statSync(testFile).size;

    // Set a very small limit so the file is definitely over
    const result = maybeRotateJsonl(testFile, { maxBytes: 100, keepRatio: 0.5 });
    expect(result).toBe(true);

    const linesAfter = fs.readFileSync(testFile, 'utf-8').trim().split('\n');
    // Should keep ~50 lines (50% of 100)
    expect(linesAfter.length).toBe(50);

    // Should have kept the LAST 50 lines (most recent)
    const firstKept = JSON.parse(linesAfter[0]);
    expect(firstKept.i).toBe(50);

    const sizeAfter = fs.statSync(testFile).size;
    expect(sizeAfter).toBeLessThan(sizeBefore);
  });

  it('respects custom keepRatio', () => {
    writeLines(100);
    maybeRotateJsonl(testFile, { maxBytes: 100, keepRatio: 0.25 });

    const lines = fs.readFileSync(testFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(25);

    // Most recent lines preserved
    const firstKept = JSON.parse(lines[0]);
    expect(firstKept.i).toBe(75);
  });

  it('keeps at least 1 line even with keepRatio 0', () => {
    writeLines(10);
    maybeRotateJsonl(testFile, { maxBytes: 1, keepRatio: 0 });

    const lines = fs.readFileSync(testFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);

    const kept = JSON.parse(lines[0]);
    expect(kept.i).toBe(9); // Last line
  });

  it('uses atomic write (tmp + rename)', () => {
    writeLines(100);

    // After rotation, no tmp file should remain
    maybeRotateJsonl(testFile, { maxBytes: 100, keepRatio: 0.5 });

    const tmpPath = testFile + '.rotation-tmp';
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('returns false for missing file', () => {
    const result = maybeRotateJsonl(path.join(tmpDir, 'nonexistent.jsonl'));
    expect(result).toBe(false);
  });

  it('returns false for empty file', () => {
    fs.writeFileSync(testFile, '');
    const result = maybeRotateJsonl(testFile, { maxBytes: 1 });
    expect(result).toBe(false);
  });

  it('uses default options (10MB, 0.75)', () => {
    writeLines(5);
    // File is tiny, well under 10MB default — should not rotate
    const result = maybeRotateJsonl(testFile);
    expect(result).toBe(false);
  });

  it('handles file with only newlines gracefully', () => {
    fs.writeFileSync(testFile, '\n\n\n\n');
    const result = maybeRotateJsonl(testFile, { maxBytes: 1 });
    expect(result).toBe(false);
  });

  it('preserves valid JSONL format after rotation', () => {
    writeLines(50);
    maybeRotateJsonl(testFile, { maxBytes: 100, keepRatio: 0.5 });

    const content = fs.readFileSync(testFile, 'utf-8');
    // Should end with newline
    expect(content.endsWith('\n')).toBe(true);

    // Every line should be valid JSON
    const lines = content.trim().split('\n');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('clamps keepRatio to [0, 1]', () => {
    writeLines(100);

    // keepRatio > 1 should clamp to 1 (keep all)
    maybeRotateJsonl(testFile, { maxBytes: 100, keepRatio: 2.0 });
    let lines = fs.readFileSync(testFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(100);

    // keepRatio < 0 should clamp to 0 (keep 1 minimum)
    maybeRotateJsonl(testFile, { maxBytes: 100, keepRatio: -1 });
    lines = fs.readFileSync(testFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
  });
});
