/**
 * Unit tests for CustomReviewerLoader — Custom reviewer spec loading and validation.
 *
 * Tests cover:
 * - Loading valid spec files
 * - Rejecting invalid specs (missing fields, bad mode, bad name, etc.)
 * - Loading from empty directory
 * - Loading from non-existent directory
 * - Loading with a mix of valid and invalid files
 * - Loading a specific reviewer by name
 * - Rejecting script-based reviewers (v1)
 * - customContext file existence validation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CustomReviewerLoader } from '../../src/core/CustomReviewerLoader.js';
import type { CustomReviewerSpec } from '../../src/core/CustomReviewerLoader.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTmpStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-test-'));
  return dir;
}

function writeSpec(stateDir: string, filename: string, spec: unknown): void {
  const reviewersDir = path.join(stateDir, 'reviewers');
  if (!fs.existsSync(reviewersDir)) {
    fs.mkdirSync(reviewersDir, { recursive: true });
  }
  fs.writeFileSync(path.join(reviewersDir, filename), JSON.stringify(spec, null, 2));
}

function validSpec(overrides?: Partial<CustomReviewerSpec>): Record<string, unknown> {
  return {
    name: 'tone-check',
    description: 'Checks message tone before sending',
    mode: 'warn',
    prompt: 'Review the following message for tone. Is it appropriate?',
    contextRequirements: { message: true },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('CustomReviewerLoader', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTmpStateDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe('loadAll()', () => {
    it('loads valid spec files', () => {
      writeSpec(stateDir, 'tone-check.json', validSpec());
      writeSpec(stateDir, 'safety-gate.json', validSpec({
        name: 'safety-gate',
        description: 'Blocks unsafe content',
        mode: 'block',
        prompt: 'Check for safety issues.',
        priority: 'p0',
      }));

      const loader = new CustomReviewerLoader(stateDir);
      const specs = loader.loadAll();

      expect(specs).toHaveLength(2);
      expect(specs.map((s) => s.name).sort()).toEqual(['safety-gate', 'tone-check']);
    });

    it('returns empty array for empty directory', () => {
      fs.mkdirSync(path.join(stateDir, 'reviewers'), { recursive: true });

      const loader = new CustomReviewerLoader(stateDir);
      const specs = loader.loadAll();

      expect(specs).toEqual([]);
    });

    it('returns empty array for non-existent directory', () => {
      const loader = new CustomReviewerLoader(stateDir);
      const specs = loader.loadAll();

      expect(specs).toEqual([]);
    });

    it('skips non-JSON files', () => {
      const reviewersDir = path.join(stateDir, 'reviewers');
      fs.mkdirSync(reviewersDir, { recursive: true });
      fs.writeFileSync(path.join(reviewersDir, 'README.md'), '# Reviewers');
      writeSpec(stateDir, 'valid.json', validSpec({ name: 'valid' }));

      const loader = new CustomReviewerLoader(stateDir);
      const specs = loader.loadAll();

      expect(specs).toHaveLength(1);
      expect(specs[0].name).toBe('valid');
    });

    it('loads valid specs and skips invalid ones in mixed directory', () => {
      writeSpec(stateDir, 'good.json', validSpec({ name: 'good' }));
      writeSpec(stateDir, 'bad-mode.json', validSpec({ name: 'bad-mode', mode: 'invalid' as any }));
      writeSpec(stateDir, 'also-good.json', validSpec({ name: 'also-good', mode: 'observe' }));

      const loader = new CustomReviewerLoader(stateDir);
      const specs = loader.loadAll();

      expect(specs).toHaveLength(2);
      expect(specs.map((s) => s.name).sort()).toEqual(['also-good', 'good']);
    });

    it('skips malformed JSON files', () => {
      const reviewersDir = path.join(stateDir, 'reviewers');
      fs.mkdirSync(reviewersDir, { recursive: true });
      fs.writeFileSync(path.join(reviewersDir, 'broken.json'), '{ not valid json');
      writeSpec(stateDir, 'valid.json', validSpec({ name: 'valid' }));

      const loader = new CustomReviewerLoader(stateDir);
      const specs = loader.loadAll();

      expect(specs).toHaveLength(1);
    });
  });

  describe('load(name)', () => {
    it('loads a specific reviewer by name', () => {
      writeSpec(stateDir, 'my-reviewer.json', validSpec({ name: 'my-reviewer' }));

      const loader = new CustomReviewerLoader(stateDir);
      const spec = loader.load('my-reviewer');

      expect(spec).not.toBeNull();
      expect(spec!.name).toBe('my-reviewer');
    });

    it('returns null for non-existent reviewer', () => {
      const loader = new CustomReviewerLoader(stateDir);
      const spec = loader.load('does-not-exist');

      expect(spec).toBeNull();
    });

    it('returns null for invalid name pattern', () => {
      const loader = new CustomReviewerLoader(stateDir);

      expect(loader.load('UPPERCASE')).toBeNull();
      expect(loader.load('has spaces')).toBeNull();
      expect(loader.load('has_underscore')).toBeNull();
      expect(loader.load('../traversal')).toBeNull();
    });
  });

  describe('validation — name', () => {
    it('rejects missing name', () => {
      writeSpec(stateDir, 'bad.json', { ...validSpec(), name: undefined });

      const loader = new CustomReviewerLoader(stateDir);
      expect(loader.loadAll()).toHaveLength(0);
    });

    it('rejects empty name', () => {
      writeSpec(stateDir, 'bad.json', validSpec({ name: '' }));

      const loader = new CustomReviewerLoader(stateDir);
      expect(loader.loadAll()).toHaveLength(0);
    });

    it('rejects name with uppercase', () => {
      writeSpec(stateDir, 'bad.json', validSpec({ name: 'MyReviewer' }));

      const loader = new CustomReviewerLoader(stateDir);
      expect(loader.loadAll()).toHaveLength(0);
    });

    it('rejects name with underscores', () => {
      writeSpec(stateDir, 'bad.json', validSpec({ name: 'my_reviewer' }));

      const loader = new CustomReviewerLoader(stateDir);
      expect(loader.loadAll()).toHaveLength(0);
    });

    it('accepts name with hyphens and numbers', () => {
      writeSpec(stateDir, 'ok.json', validSpec({ name: 'my-reviewer-v2' }));

      const loader = new CustomReviewerLoader(stateDir);
      expect(loader.loadAll()).toHaveLength(1);
    });
  });

  describe('validation — mode', () => {
    it('accepts block mode', () => {
      writeSpec(stateDir, 'ok.json', validSpec({ name: 'ok', mode: 'block' }));
      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(1);
    });

    it('accepts warn mode', () => {
      writeSpec(stateDir, 'ok.json', validSpec({ name: 'ok', mode: 'warn' }));
      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(1);
    });

    it('accepts observe mode', () => {
      writeSpec(stateDir, 'ok.json', validSpec({ name: 'ok', mode: 'observe' }));
      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(1);
    });

    it('rejects invalid mode', () => {
      writeSpec(stateDir, 'bad.json', validSpec({ name: 'bad', mode: 'invalid' as any }));
      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(0);
    });
  });

  describe('validation — prompt', () => {
    it('rejects missing prompt', () => {
      const spec = validSpec();
      delete (spec as any).prompt;
      writeSpec(stateDir, 'bad.json', spec);

      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(0);
    });

    it('rejects empty prompt', () => {
      writeSpec(stateDir, 'bad.json', validSpec({ prompt: '' }));
      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(0);
    });
  });

  describe('validation — contextRequirements', () => {
    it('rejects missing contextRequirements', () => {
      const spec = validSpec();
      delete (spec as any).contextRequirements;
      writeSpec(stateDir, 'bad.json', spec);

      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(0);
    });

    it('rejects contextRequirements.message = false', () => {
      writeSpec(stateDir, 'bad.json', {
        ...validSpec(),
        contextRequirements: { message: false },
      });

      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(0);
    });

    it('accepts optional context fields', () => {
      writeSpec(stateDir, 'ok.json', validSpec({
        name: 'ok',
        contextRequirements: {
          message: true,
          toolOutput: true,
          valueDocuments: true,
          channel: true,
        },
      }));

      const specs = new CustomReviewerLoader(stateDir).loadAll();
      expect(specs).toHaveLength(1);
      expect(specs[0].contextRequirements.toolOutput).toBe(true);
      expect(specs[0].contextRequirements.valueDocuments).toBe(true);
      expect(specs[0].contextRequirements.channel).toBe(true);
    });

    it('rejects customContext pointing to non-existent file', () => {
      writeSpec(stateDir, 'bad.json', validSpec({
        name: 'bad',
        contextRequirements: {
          message: true,
          customContext: '/nonexistent/path/to/file.md',
        },
      }));

      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(0);
    });

    it('accepts customContext pointing to existing file', () => {
      const contextFile = path.join(stateDir, 'extra-context.md');
      fs.writeFileSync(contextFile, '# Extra context');

      writeSpec(stateDir, 'ok.json', validSpec({
        name: 'ok',
        contextRequirements: {
          message: true,
          customContext: 'extra-context.md',
        },
      }));

      const specs = new CustomReviewerLoader(stateDir).loadAll();
      expect(specs).toHaveLength(1);
      expect(specs[0].contextRequirements.customContext).toBe('extra-context.md');
    });
  });

  describe('validation — priority', () => {
    it('accepts valid priorities', () => {
      for (const p of ['p0', 'p1', 'p2'] as const) {
        const dir = createTmpStateDir();
        writeSpec(dir, 'ok.json', validSpec({ name: 'ok', priority: p }));
        const specs = new CustomReviewerLoader(dir).loadAll();
        expect(specs).toHaveLength(1);
        expect(specs[0].priority).toBe(p);
        // safe-git-allow: incremental-migration
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects invalid priority', () => {
      writeSpec(stateDir, 'bad.json', validSpec({ name: 'bad', priority: 'p3' as any }));
      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(0);
    });

    it('allows missing priority (optional)', () => {
      const spec = validSpec();
      delete (spec as any).priority;
      writeSpec(stateDir, 'ok.json', spec);

      const specs = new CustomReviewerLoader(stateDir).loadAll();
      expect(specs).toHaveLength(1);
      expect(specs[0].priority).toBeUndefined();
    });
  });

  describe('validation — v1 restrictions', () => {
    it('rejects specs with script field', () => {
      writeSpec(stateDir, 'bad.json', {
        ...validSpec(),
        script: './scripts/custom-check.sh',
      });

      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(0);
    });
  });

  describe('validation — description', () => {
    it('rejects missing description', () => {
      const spec = validSpec();
      delete (spec as any).description;
      writeSpec(stateDir, 'bad.json', spec);

      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(0);
    });

    it('rejects empty description', () => {
      writeSpec(stateDir, 'bad.json', validSpec({ description: '' }));
      expect(new CustomReviewerLoader(stateDir).loadAll()).toHaveLength(0);
    });
  });
});
