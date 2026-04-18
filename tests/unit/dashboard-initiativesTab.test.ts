/**
 * Smoke tests for the Initiatives dashboard tab.
 *
 * These tests inspect the HTML/JS at rest (no browser execution).
 * They verify the XSS-safe invariants and the tab wiring match the
 * PR Pipeline pattern: textContent only, no innerHTML, tab registered,
 * panel present, loader function defined.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');

describe('dashboard: Initiatives tab', () => {
  it('has an Initiatives tab button wired to switchTab', () => {
    expect(HTML).toContain('data-tab="initiatives"');
    expect(HTML).toContain(`switchTab('initiatives')`);
  });

  it('has an initiativesPanel container', () => {
    expect(HTML).toContain('id="initiativesPanel"');
  });

  it('registers the initiatives tab in TAB_REGISTRY', () => {
    expect(HTML).toMatch(/id:\s*'initiatives'[\s\S]{0,120}panels:\s*\['initiativesPanel'\]/);
  });

  it('calls loadInitiatives on activation', () => {
    expect(HTML).toContain(`loadInitiatives === 'function'`);
    expect(HTML).toContain('loadInitiatives()');
  });

  it('defines async function loadInitiatives', () => {
    expect(HTML).toMatch(/async function loadInitiatives\(\)/);
  });

  it('fetches both /initiatives and /initiatives/digest', () => {
    const fn = HTML.slice(HTML.indexOf('async function loadInitiatives()'));
    expect(fn).toContain(`'/initiatives'`);
    expect(fn).toContain(`'/initiatives/digest'`);
  });

  it('does not use innerHTML inside loadInitiatives (XSS invariant)', () => {
    const start = HTML.indexOf('async function loadInitiatives()');
    // Find the end of the function — the next top-level function definition.
    const rest = HTML.slice(start + 1);
    const nextFn = rest.search(/\n\s*(async )?function \w+\(/);
    const body = rest.slice(0, nextFn);
    // Permitted usages: empty-state text set via textContent, DOM mutation.
    // Forbidden: any innerHTML assignment.
    expect(body).not.toMatch(/\.innerHTML\s*=/);
  });

  it('renders phase pills with known status values', () => {
    const start = HTML.indexOf('async function loadInitiatives()');
    const body = HTML.slice(start, start + 8000);
    expect(body).toContain('pending');
    expect(body).toContain('in-progress');
    expect(body).toContain('done');
    expect(body).toContain('blocked');
  });

  it('renders digest signals with known reason tags', () => {
    const start = HTML.indexOf('async function loadInitiatives()');
    const body = HTML.slice(start, start + 8000);
    expect(body).toContain(`'needs-user'`);
    expect(body).toContain(`'next-check-due'`);
    expect(body).toContain(`'ready-to-advance'`);
    expect(body).toContain(`'stale'`);
  });
});
