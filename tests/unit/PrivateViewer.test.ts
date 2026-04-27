import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrivateViewer } from '../../src/publishing/PrivateViewer.js';

describe('PrivateViewer', () => {
  let tmpDir: string;
  let viewer: PrivateViewer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-test-'));
    viewer = new PrivateViewer({ viewsDir: tmpDir });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a view without metadata', () => {
    const view = viewer.create('Test', '# Hello');
    expect(view.id).toBeTruthy();
    expect(view.title).toBe('Test');
    expect(view.markdown).toBe('# Hello');
    expect(view.metadata).toBeUndefined();
  });

  it('creates a view with job source metadata', () => {
    const view = viewer.create('Job Report', '# Report', undefined, {
      source: { type: 'job', id: 'health-check' },
    });
    expect(view.metadata).toBeDefined();
    expect(view.metadata!.source).toEqual({ type: 'job', id: 'health-check' });
  });

  it('persists metadata through save/load cycle', () => {
    const view = viewer.create('Persisted', '# Data', undefined, {
      source: { type: 'job', id: 'ci-monitor' },
    });
    const loaded = viewer.get(view.id);
    expect(loaded).toBeTruthy();
    expect(loaded!.metadata?.source).toEqual({ type: 'job', id: 'ci-monitor' });
  });

  it('lists views with metadata', () => {
    viewer.create('View A', '# A', undefined, { source: { type: 'job', id: 'job-a' } });
    viewer.create('View B', '# B');
    viewer.create('View C', '# C', undefined, { source: { type: 'job', id: 'job-c' } });

    const all = viewer.list();
    expect(all).toHaveLength(3);

    const withMeta = all.filter(v => v.metadata?.source);
    expect(withMeta).toHaveLength(2);
  });

  it('does not include metadata field when none provided', () => {
    const view = viewer.create('No Meta', '# None');
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, `${view.id}.json`), 'utf-8'));
    expect(raw.metadata).toBeUndefined();
  });

  it('does not include metadata field when empty object provided', () => {
    const view = viewer.create('Empty Meta', '# None', undefined, {});
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, `${view.id}.json`), 'utf-8'));
    expect(raw.metadata).toBeUndefined();
  });
});
