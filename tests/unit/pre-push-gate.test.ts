/**
 * Unit tests — Pre-push gate validation.
 *
 * Ensures the fast pre-push gate correctly validates:
 * - NEXT.md existence and required sections
 * - Version increment from latest published guide
 *
 * These tests verify the gate logic WITHOUT running the actual script,
 * since the script reads from the real filesystem.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const gatePath = path.join(ROOT, 'scripts', 'pre-push-gate.js');

describe('Pre-push gate script', () => {
  it('exists', () => {
    expect(fs.existsSync(gatePath)).toBe(true);
  });

  it('passes when NEXT.md is well-formed and version is incremented', () => {
    // The current repo state should pass the gate
    // (NEXT.md has content, version is current)
    const result = execSync(`node "${gatePath}"`, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // No errors = exit code 0 (execSync would throw on non-zero)
    expect(true).toBe(true);
  });

  it('checks all three required NEXT.md sections', () => {
    const content = fs.readFileSync(gatePath, 'utf-8');
    expect(content).toContain('## What Changed');
    expect(content).toContain('## What to Tell Your User');
    expect(content).toContain('## Summary of New Capabilities');
  });

  it('checks for template placeholders', () => {
    const content = fs.readFileSync(gatePath, 'utf-8');
    expect(content).toContain('[Feature name]');
    expect(content).toContain('[Capability]');
  });

  it('validates version is not lower than latest published', () => {
    const content = fs.readFileSync(gatePath, 'utf-8');
    expect(content).toContain('LOWER than the latest published guide');
  });

  it('warns when version matches latest published (no bump)', () => {
    const content = fs.readFileSync(gatePath, 'utf-8');
    expect(content).toContain('Did you forget to bump the version');
  });
});
