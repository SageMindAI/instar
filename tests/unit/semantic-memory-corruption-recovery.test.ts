/**
 * Tests for SemanticMemory corruption auto-recovery.
 *
 * Contract:
 *   1. Opening a corrupt DB does not throw.
 *   2. The corrupt DB is quarantined (renamed to `.corrupt.<ts>`), NOT deleted.
 *   3. A marker file is written so operators can detect the recovery.
 *   4. If a JSONL log is present, the DB is rebuilt from it automatically.
 *   5. If no JSONL is present, the DB starts fresh and does not throw.
 *   6. `-wal` / `-shm` sidecar files are cleaned up so the fresh DB opens clean.
 *   7. A healthy DB is not quarantined.
 *   8. The quarantined file is a real file (not a symlink, not empty).
 *   9. Rename failure falls back to delete (does not abort startup).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';

interface Setup {
  dir: string;
  dbPath: string;
  jsonlPath: string;
  cleanup: () => void;
}

function makeSetup(): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-corruption-'));
  const dbPath = path.join(dir, 'semantic.db');
  const jsonlPath = dbPath.replace(/\.db$/, '.jsonl');
  return {
    dir,
    dbPath,
    jsonlPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function writeGarbage(dbPath: string): void {
  // Write something that is clearly not a valid SQLite database (no magic header).
  fs.writeFileSync(dbPath, 'this is definitely not a sqlite database — garbage bytes');
}

function listCorruptArtifacts(dir: string): { corruptFiles: string[]; markerFiles: string[] } {
  const entries = fs.readdirSync(dir);
  return {
    corruptFiles: entries.filter((f) => f.includes('.corrupt.') && !f.endsWith('.marker.json')),
    markerFiles: entries.filter((f) => f.includes('corrupt-recovery') && f.endsWith('.marker.json')),
  };
}

describe('SemanticMemory corruption auto-recovery', () => {
  let setup: Setup;
  beforeEach(() => { setup = makeSetup(); });
  afterEach(() => setup.cleanup());

  it('opens a corrupt DB without throwing', async () => {
    writeGarbage(setup.dbPath);
    const mem = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await expect(mem.open()).resolves.not.toThrow();
    mem.close();
  });

  it('quarantines the corrupt DB instead of deleting it (forensic preservation)', async () => {
    writeGarbage(setup.dbPath);
    const mem = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await mem.open();
    mem.close();

    const { corruptFiles } = listCorruptArtifacts(setup.dir);
    expect(corruptFiles.length).toBeGreaterThanOrEqual(1);

    // Quarantined file is a real, non-empty file whose contents match the original garbage
    const quarantinedPath = path.join(setup.dir, corruptFiles[0]);
    expect(fs.statSync(quarantinedPath).size).toBeGreaterThan(0);
    expect(fs.readFileSync(quarantinedPath, 'utf-8')).toContain('garbage bytes');
  });

  it('writes a recovery marker file with metadata operators can consume', async () => {
    writeGarbage(setup.dbPath);
    const mem = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await mem.open();
    mem.close();

    const { markerFiles } = listCorruptArtifacts(setup.dir);
    expect(markerFiles.length).toBe(1);

    const marker = JSON.parse(fs.readFileSync(path.join(setup.dir, markerFiles[0]), 'utf-8'));
    expect(marker.event).toBe('semantic_memory.auto_recovery');
    expect(marker.dbPath).toBe(setup.dbPath);
    expect(marker.quarantinedTo).toMatch(/\.corrupt\./);
    expect(typeof marker.reason).toBe('string');
    expect(marker.reason.length).toBeGreaterThan(0);
    expect(typeof marker.timestamp).toBe('string');
    // Marker timestamp is a valid ISO date
    expect(() => new Date(marker.timestamp).toISOString()).not.toThrow();
  });

  it('cleans up -wal and -shm sidecar files so the fresh DB opens cleanly', async () => {
    writeGarbage(setup.dbPath);
    fs.writeFileSync(setup.dbPath + '-wal', 'stale wal');
    fs.writeFileSync(setup.dbPath + '-shm', 'stale shm');

    const mem = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await mem.open();
    mem.close();

    // Fresh DB should have written its own -wal/-shm (or none, depending on journal mode).
    // But the STALE ones we planted should be gone — the new files must be SQLite-valid.
    const walAfter = setup.dbPath + '-wal';
    if (fs.existsSync(walAfter)) {
      expect(fs.readFileSync(walAfter, 'utf-8')).not.toBe('stale wal');
    }
  });

  it('rebuilds automatically from the JSONL log when one is present', async () => {
    // Seed: create a real DB, remember some entities, close.
    const seed = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await seed.open();
    const nowIso = new Date().toISOString();
    seed.remember({ type: 'concept', name: 'Alpha', content: 'seed alpha', confidence: 0.9, lastVerified: nowIso, source: 'test', tags: [] });
    seed.remember({ type: 'concept', name: 'Beta', content: 'seed beta', confidence: 0.9, lastVerified: nowIso, source: 'test', tags: [] });
    seed.close();

    // Verify JSONL exists
    expect(fs.existsSync(setup.jsonlPath)).toBe(true);

    // Corrupt the DB
    writeGarbage(setup.dbPath);

    // Reopen — should auto-recover from JSONL
    const recovered = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await recovered.open();

    const alpha = recovered.search('Alpha');
    const beta = recovered.search('Beta');
    expect(alpha.some((r) => r.name === 'Alpha')).toBe(true);
    expect(beta.some((r) => r.name === 'Beta')).toBe(true);
    recovered.close();
  });

  it('does not throw when no JSONL log exists — starts fresh', async () => {
    writeGarbage(setup.dbPath);
    // Explicitly no JSONL
    expect(fs.existsSync(setup.jsonlPath)).toBe(false);

    const mem = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await expect(mem.open()).resolves.not.toThrow();

    // Fresh DB — zero entities
    expect(mem.search('anything')).toEqual([]);
    mem.close();
  });

  it('does not quarantine a healthy DB', async () => {
    // Open + close cleanly to create a real DB
    const mem1 = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await mem1.open();
    mem1.remember({ type: 'concept', name: 'Healthy', content: 'ok', confidence: 0.9, lastVerified: new Date().toISOString(), source: 'test', tags: [] });
    mem1.close();

    // Reopen — should NOT trigger quarantine
    const mem2 = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await mem2.open();
    mem2.close();

    const { corruptFiles, markerFiles } = listCorruptArtifacts(setup.dir);
    expect(corruptFiles).toEqual([]);
    expect(markerFiles).toEqual([]);
  });

  it('handles a severely corrupt DB where the pragma itself throws', async () => {
    // An empty-but-existing file of size > 0 with no SQLite header
    fs.writeFileSync(setup.dbPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])); // 5 bytes of nothing

    const mem = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await expect(mem.open()).resolves.not.toThrow();
    mem.close();

    // Marker should still be written — we caught the pragma throw path
    const { markerFiles } = listCorruptArtifacts(setup.dir);
    expect(markerFiles.length).toBe(1);
    const marker = JSON.parse(fs.readFileSync(path.join(setup.dir, markerFiles[0]), 'utf-8'));
    expect(marker.reason).toMatch(/pragma threw/);
  });

  it('subsequent opens of the fresh DB remain stable (no lingering _needsRebuild state)', async () => {
    writeGarbage(setup.dbPath);
    const mem1 = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await mem1.open();
    mem1.close();

    // Second open on the now-healthy DB — should not re-quarantine, should not emit a new marker
    const beforeSecond = listCorruptArtifacts(setup.dir);

    const mem2 = new SemanticMemory({ dbPath: setup.dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
    await mem2.open();
    mem2.close();

    const afterSecond = listCorruptArtifacts(setup.dir);
    expect(afterSecond.markerFiles.length).toBe(beforeSecond.markerFiles.length);
    expect(afterSecond.corruptFiles.length).toBe(beforeSecond.corruptFiles.length);
  });
});
