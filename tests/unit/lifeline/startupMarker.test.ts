import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeStartupMarker, readStartupMarker, markerPath } from '../../../src/lifeline/startupMarker.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-marker-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('startupMarker', () => {
  it('writes marker atomically with pid/version/timestamp', () => {
    const m = writeStartupMarker(tmp, '1.2.3');
    expect(m.pid).toBe(process.pid);
    expect(m.version).toBe('1.2.3');
    expect(m.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const raw = fs.readFileSync(markerPath(tmp), 'utf-8');
    expect(JSON.parse(raw)).toEqual(m);
  });

  it('read returns the same marker', () => {
    const w = writeStartupMarker(tmp, '0.28.66');
    const r = readStartupMarker(tmp);
    expect(r).toEqual(w);
  });

  it('read returns null if missing', () => {
    expect(readStartupMarker(tmp)).toBeNull();
  });

  it('read returns null if malformed', () => {
    fs.writeFileSync(markerPath(tmp), '{not json');
    expect(readStartupMarker(tmp)).toBeNull();
  });

  it('read returns null if fields missing', () => {
    fs.writeFileSync(markerPath(tmp), JSON.stringify({ startedAt: 'x' }));
    expect(readStartupMarker(tmp)).toBeNull();
  });
});
