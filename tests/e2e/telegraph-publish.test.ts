/**
 * E2E test — Telegraph publishing flow.
 *
 * Makes REAL API calls to telegra.ph to verify the full pipeline:
 *   markdown → Node conversion → publish → verify URL → edit → verify
 *
 * These tests create real pages on Telegraph. Telegraph pages are
 * free, have no rate limits, and don't expire — so this is safe to run.
 *
 * Skip with: SKIP_E2E=1 npx vitest run --config vitest.e2e.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TelegraphService } from '../../src/publishing/TelegraphService.js';

const SKIP = process.env.SKIP_E2E === '1';

describe('Telegraph E2E publish flow', () => {
  let stateDir: string;
  let service: TelegraphService;

  beforeAll(() => {
    if (SKIP) return;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-telegraph-e2e-'));
    service = new TelegraphService({
      stateDir,
      shortName: 'instar-test',
      authorName: 'Instar E2E Test',
    });
  });

  afterAll(() => {
    if (SKIP) return;
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it.skipIf(SKIP)('creates a Telegraph account', async () => {
    const token = await service.ensureAccount();
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');

    // Subsequent calls return the same token
    const token2 = await service.ensureAccount();
    expect(token2).toBe(token);
  });

  it.skipIf(SKIP)('publishes a markdown page', async () => {
    const markdown = [
      '# E2E Test Page',
      '',
      'This page was automatically created by the Instar E2E test suite.',
      '',
      '## Features Tested',
      '',
      '- **Bold text** formatting',
      '- *Italic text* formatting',
      '- `Inline code` formatting',
      '- [Links](https://instar.sh) work correctly',
      '',
      '### Code Block',
      '',
      '```',
      'const greeting = "Hello from Instar!";',
      'console.log(greeting);',
      '```',
      '',
      '> This is a blockquote demonstrating all formatting options.',
      '',
      '---',
      '',
      '1. First ordered item',
      '2. Second ordered item',
      '3. Third ordered item',
      '',
      'Final paragraph with ~~strikethrough~~ text.',
    ].join('\n');

    const page = await service.publishPage('Instar E2E Test', markdown);

    expect(page.url).toMatch(/^https:\/\/telegra\.ph\//);
    expect(page.path).toBeTruthy();
    expect(page.title).toBe('Instar E2E Test');

    // Verify the page is accessible
    const response = await fetch(page.url);
    expect(response.ok).toBe(true);

    // Verify local tracking
    const pages = service.listPages();
    expect(pages.length).toBeGreaterThanOrEqual(1);
    const tracked = pages.find(p => p.path === page.path);
    expect(tracked).toBeDefined();
    expect(tracked!.title).toBe('Instar E2E Test');
  });

  it.skipIf(SKIP)('edits a published page', async () => {
    // Publish first
    const original = await service.publishPage('Edit Test', '# Original\n\nOriginal content.');

    // Edit it
    const updated = await service.editPage(
      original.path,
      'Edit Test (Updated)',
      '# Updated\n\nThis content has been updated by the E2E test.',
    );

    expect(updated.url).toMatch(/^https:\/\/telegra\.ph\//);
    expect(updated.title).toBe('Edit Test (Updated)');

    // Verify the edit was tracked
    const pages = service.listPages();
    const tracked = pages.find(p => p.path === original.path);
    expect(tracked).toBeDefined();
    expect(tracked!.title).toBe('Edit Test (Updated)');
    expect(tracked!.updatedAt).toBeTruthy();
  });

  it.skipIf(SKIP)('gets page views', async () => {
    // Use a page we just created
    const pages = service.listPages();
    expect(pages.length).toBeGreaterThan(0);

    const views = await service.getPageViews(pages[0].path);
    expect(typeof views).toBe('number');
    expect(views).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(SKIP)('persists state across service instances', async () => {
    const pages1 = service.listPages();
    expect(pages1.length).toBeGreaterThan(0);

    // Create a new service instance pointing to same state
    const service2 = new TelegraphService({
      stateDir,
      shortName: 'instar-test',
    });

    const pages2 = service2.listPages();
    expect(pages2.length).toBe(pages1.length);
    expect(pages2[0].path).toBe(pages1[0].path);

    // Token should be reused
    const state = service2.getState();
    expect(state.accessToken).toBeTruthy();
  });
});
