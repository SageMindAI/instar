/**
 * Unit tests for BackupManager — snapshot and restore agent state.
 *
 * Tests:
 * - Snapshot creation with files and directories
 * - Snapshot listing sorted by date
 * - Snapshot restore with file recovery
 * - Config.json exclusion (security)
 * - Secrets directory exclusion (security)
 * - Manifest integrity hash validation
 * - Session guard prevents restore during active sessions
 * - Auto-snapshot debouncing (30 min)
 * - Auto-snapshot disabled when config.enabled = false
 * - Pruning old snapshots beyond maxSnapshots
 * - Snapshot ID validation (format + path traversal)
 * - getSnapshotPath throws on invalid ID
 * - Restore creates pre-restore backup
 * - Restore skips missing source files gracefully
 * - Restore throws on tampered manifest
 * - Restore throws on missing snapshot
 * - Empty state dir produces empty snapshot
 * - Directory entries in includeFiles
 * - Custom config overrides defaults
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BackupManager } from '../../src/core/BackupManager.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-backup-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('BackupManager', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempDir();
    // Create some state files
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent Identity\nI am a test agent.');
    fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), '# Memory\nSome memories here.');
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify({ jobs: [] }));
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify({ users: [] }));
    // Create relationships directory
    fs.mkdirSync(path.join(stateDir, 'relationships'));
    fs.writeFileSync(path.join(stateDir, 'relationships', 'alice.json'), JSON.stringify({ name: 'alice' }));
    fs.writeFileSync(path.join(stateDir, 'relationships', 'bob.json'), JSON.stringify({ name: 'bob' }));
  });

  afterEach(() => {
    cleanup(stateDir);
    vi.restoreAllMocks();
  });

  describe('createSnapshot', () => {
    it('creates a snapshot with all included files', () => {
      const manager = new BackupManager(stateDir);
      const snapshot = manager.createSnapshot('manual');

      expect(snapshot.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}Z(-\d+)?$/);
      expect(snapshot.trigger).toBe('manual');
      expect(snapshot.files).toContain('AGENT.md');
      expect(snapshot.files).toContain('MEMORY.md');
      expect(snapshot.files).toContain('jobs.json');
      expect(snapshot.files).toContain('users.json');
      expect(snapshot.files).toContain('relationships/alice.json');
      expect(snapshot.files).toContain('relationships/bob.json');
      expect(snapshot.totalBytes).toBeGreaterThan(0);
      expect(snapshot.integrityHash).toBeDefined();
      expect(snapshot.createdAt).toBeDefined();
    });

    it('writes manifest.json to snapshot directory', () => {
      const manager = new BackupManager(stateDir);
      const snapshot = manager.createSnapshot('manual');

      const manifestPath = path.join(stateDir, 'backups', snapshot.id, 'manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(manifest.id).toBe(snapshot.id);
      expect(manifest.files).toEqual(snapshot.files);
    });

    it('copies actual file contents to snapshot', () => {
      const manager = new BackupManager(stateDir);
      const snapshot = manager.createSnapshot('manual');

      const snapshotAgentMd = path.join(stateDir, 'backups', snapshot.id, 'AGENT.md');
      expect(fs.readFileSync(snapshotAgentMd, 'utf-8')).toBe('# Agent Identity\nI am a test agent.');

      const snapshotRelAlice = path.join(stateDir, 'backups', snapshot.id, 'relationships', 'alice.json');
      expect(JSON.parse(fs.readFileSync(snapshotRelAlice, 'utf-8'))).toEqual({ name: 'alice' });
    });

    it('skips files that do not exist', () => {
      // USER.md doesn't exist in our setup
      const manager = new BackupManager(stateDir);
      const snapshot = manager.createSnapshot('manual');

      expect(snapshot.files).not.toContain('USER.md');
    });

    it('creates backups directory if it does not exist', () => {
      const manager = new BackupManager(stateDir);
      expect(fs.existsSync(path.join(stateDir, 'backups'))).toBe(false);

      manager.createSnapshot('manual');
      expect(fs.existsSync(path.join(stateDir, 'backups'))).toBe(true);
    });
  });

  describe('security: blocked files', () => {
    it('never backs up config.json even if in includeFiles', () => {
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ secret: 'key123' }));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = new BackupManager(stateDir, {
        includeFiles: ['AGENT.md', 'config.json'],
      });
      const snapshot = manager.createSnapshot('manual');

      expect(snapshot.files).not.toContain('config.json');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping blocked file: config.json'));
    });

    it('never backs up secrets directory even if in includeFiles', () => {
      fs.mkdirSync(path.join(stateDir, 'secrets'));
      fs.writeFileSync(path.join(stateDir, 'secrets', 'key.pem'), 'secret-key');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = new BackupManager(stateDir, {
        includeFiles: ['AGENT.md', 'secrets/'],
      });
      const snapshot = manager.createSnapshot('manual');

      expect(snapshot.files.some(f => f.startsWith('secrets/'))).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping blocked file: secrets/'));
    });

    it('never backs up machine directory even if in includeFiles', () => {
      fs.mkdirSync(path.join(stateDir, 'machine'));
      fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), '{}');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = new BackupManager(stateDir, {
        includeFiles: ['AGENT.md', 'machine/'],
      });
      const snapshot = manager.createSnapshot('manual');

      expect(snapshot.files.some(f => f.startsWith('machine/'))).toBe(false);
    });

    // ── BLOCKED_PATH_PREFIXES ─────────────────────────────────────
    //
    // The equality-semantic BLOCKED_FILES set cannot catch arbitrary paths
    // under .instar/secrets/ — it only blocks on literal matches like
    // 'secrets' or 'config.json'. A user or migrator adding an entry like
    // '.instar/secrets/pr-gate/tokens.json' would slip past. The
    // BLOCKED_PATH_PREFIXES set closes that hole with startsWith semantics.
    it('never backs up paths under .instar/secrets/ prefix even if in includeFiles', () => {
      fs.mkdirSync(path.join(stateDir, '.instar', 'secrets', 'pr-gate'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, '.instar', 'secrets', 'pr-gate', 'tokens.json'), '{"t": "sekrit"}');
      fs.writeFileSync(path.join(stateDir, '.instar', 'secrets', 'canary-keys.json'), '{"k": "x"}');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = new BackupManager(stateDir, {
        includeFiles: ['AGENT.md', '.instar/secrets/pr-gate/tokens.json', '.instar/secrets/canary-keys.json'],
      });
      const snapshot = manager.createSnapshot('manual');

      expect(snapshot.files).toContain('AGENT.md');
      expect(snapshot.files.some(f => f.includes('.instar/secrets/'))).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping blocked-prefix path: .instar/secrets/pr-gate/tokens.json'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping blocked-prefix path: .instar/secrets/canary-keys.json'));
    });

    it('prefix blocklist handles redundant path segments via path.normalize', () => {
      fs.mkdirSync(path.join(stateDir, '.instar', 'secrets', 'pr-gate'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, '.instar', 'secrets', 'pr-gate', 'server-secrets.json'), '{}');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = new BackupManager(stateDir, {
        includeFiles: ['AGENT.md', '.instar/./secrets/pr-gate/server-secrets.json'],
      });
      const snapshot = manager.createSnapshot('manual');

      expect(snapshot.files.some(f => f.includes('.instar/secrets/'))).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('DEFAULT_CONFIG.includeFiles contains no entries under .instar/secrets/', () => {
      // Defense in depth: even if a bug adds a secrets-path entry to the
      // defaults, this test catches it before any agent snapshots secrets.
      const manager = new BackupManager(stateDir);
      // Access the effective defaults via a snapshot of an empty stateDir —
      // we don't care what files are there, we care that no default path
      // is under .instar/secrets/.
      const defaults = (manager as unknown as { config: { includeFiles: string[] } }).config.includeFiles;
      for (const entry of defaults) {
        expect(path.normalize(entry).startsWith('.instar/secrets/')).toBe(false);
      }
    });
  });

  describe('listSnapshots', () => {
    it('returns empty array when no backups exist', () => {
      const manager = new BackupManager(stateDir);
      expect(manager.listSnapshots()).toEqual([]);
    });

    it('lists snapshots sorted by date (newest first)', () => {
      const manager = new BackupManager(stateDir);

      // Create multiple snapshots with slight delay
      const snap1 = manager.createSnapshot('manual');
      // Manually adjust the createdAt for ordering
      const snap1Dir = path.join(stateDir, 'backups', snap1.id);
      const manifest1 = JSON.parse(fs.readFileSync(path.join(snap1Dir, 'manifest.json'), 'utf-8'));
      manifest1.createdAt = '2025-01-01T00:00:00.000Z';
      fs.writeFileSync(path.join(snap1Dir, 'manifest.json'), JSON.stringify(manifest1));

      const snap2 = manager.createSnapshot('auto-session');
      const snap2Dir = path.join(stateDir, 'backups', snap2.id);
      const manifest2 = JSON.parse(fs.readFileSync(path.join(snap2Dir, 'manifest.json'), 'utf-8'));
      manifest2.createdAt = '2025-06-01T00:00:00.000Z';
      fs.writeFileSync(path.join(snap2Dir, 'manifest.json'), JSON.stringify(manifest2));

      const list = manager.listSnapshots();
      expect(list.length).toBe(2);
      // Newest first
      expect(new Date(list[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(list[1].createdAt).getTime());
    });

    it('skips directories without valid manifest', () => {
      const manager = new BackupManager(stateDir);
      manager.createSnapshot('manual');

      // Create a bogus directory in backups
      fs.mkdirSync(path.join(stateDir, 'backups', '2025-01-01T000000Z'), { recursive: true });
      // No manifest.json inside

      const list = manager.listSnapshots();
      expect(list.length).toBe(1); // Only the real one
    });

    it('skips directories with invalid name format', () => {
      const manager = new BackupManager(stateDir);
      manager.createSnapshot('manual');

      // Create directory with bad name
      const badDir = path.join(stateDir, 'backups', 'not-a-snapshot');
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(path.join(badDir, 'manifest.json'), '{}');

      const list = manager.listSnapshots();
      expect(list.length).toBe(1);
    });

    it('skips corrupted manifest JSON', () => {
      const manager = new BackupManager(stateDir);
      const snap = manager.createSnapshot('manual');

      // Corrupt the manifest
      const manifestPath = path.join(stateDir, 'backups', snap.id, 'manifest.json');
      fs.writeFileSync(manifestPath, 'not valid json{{{');

      const list = manager.listSnapshots();
      expect(list.length).toBe(0);
    });
  });

  describe('restoreSnapshot', () => {
    it('restores files from a snapshot', () => {
      const manager = new BackupManager(stateDir);
      const snapshot = manager.createSnapshot('manual');

      // Modify the original file
      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Modified Agent');
      expect(fs.readFileSync(path.join(stateDir, 'AGENT.md'), 'utf-8')).toBe('# Modified Agent');

      // Restore
      manager.restoreSnapshot(snapshot.id);

      // Original content should be back
      expect(fs.readFileSync(path.join(stateDir, 'AGENT.md'), 'utf-8')).toBe('# Agent Identity\nI am a test agent.');
    });

    it('creates a pre-restore backup before restoring', () => {
      const manager = new BackupManager(stateDir);
      const snapshot = manager.createSnapshot('manual');

      const beforeCount = manager.listSnapshots().length;
      manager.restoreSnapshot(snapshot.id);
      const afterCount = manager.listSnapshots().length;

      // Should have one more snapshot (the pre-restore backup)
      expect(afterCount).toBe(beforeCount + 1);
    });

    it('throws when session is active', () => {
      const manager = new BackupManager(stateDir, {}, () => true);
      const snapshot = manager.createSnapshot('manual');

      expect(() => manager.restoreSnapshot(snapshot.id)).toThrow(
        'Cannot restore while sessions are active'
      );
    });

    it('allows restore when session is not active', () => {
      const manager = new BackupManager(stateDir, {}, () => false);
      const snapshot = manager.createSnapshot('manual');

      // Modify a file
      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Changed');

      // Should not throw
      manager.restoreSnapshot(snapshot.id);
      expect(fs.readFileSync(path.join(stateDir, 'AGENT.md'), 'utf-8')).toBe('# Agent Identity\nI am a test agent.');
    });

    it('throws on invalid snapshot ID', () => {
      const manager = new BackupManager(stateDir);

      expect(() => manager.restoreSnapshot('../../etc/passwd')).toThrow('Invalid snapshot ID');
      expect(() => manager.restoreSnapshot('bad-id')).toThrow('Invalid snapshot ID');
    });

    it('throws when snapshot does not exist', () => {
      const manager = new BackupManager(stateDir);

      expect(() => manager.restoreSnapshot('2025-01-01T000000Z')).toThrow('Snapshot not found');
    });

    it('throws on tampered manifest (integrity check)', () => {
      const manager = new BackupManager(stateDir);
      const snapshot = manager.createSnapshot('manual');

      // Tamper with the manifest
      const manifestPath = path.join(stateDir, 'backups', snapshot.id, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.files.push('fake-file.txt'); // Add non-existent file to manifest
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      expect(() => manager.restoreSnapshot(snapshot.id)).toThrow('Integrity check failed');
    });

    it('skips missing source files gracefully during restore', () => {
      const manager = new BackupManager(stateDir);
      const snapshot = manager.createSnapshot('manual');

      // Delete a file from the snapshot
      const snapshotMemory = path.join(stateDir, 'backups', snapshot.id, 'MEMORY.md');
      // safe-git-allow: incremental-migration
      fs.unlinkSync(snapshotMemory);

      // Update manifest to remove integrity hash so it doesn't fail on that
      const manifestPath = path.join(stateDir, 'backups', snapshot.id, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      delete manifest.integrityHash;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      // Should not throw — just skips the missing file
      expect(() => manager.restoreSnapshot(snapshot.id)).not.toThrow();
    });

    it('restores directory entries (relationships/)', () => {
      const manager = new BackupManager(stateDir);
      const snapshot = manager.createSnapshot('manual');

      // Delete relationships
      // safe-git-allow: incremental-migration
      fs.rmSync(path.join(stateDir, 'relationships'), { recursive: true });
      expect(fs.existsSync(path.join(stateDir, 'relationships'))).toBe(false);

      manager.restoreSnapshot(snapshot.id);

      // Relationships should be back
      expect(fs.existsSync(path.join(stateDir, 'relationships', 'alice.json'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'relationships', 'alice.json'), 'utf-8'))).toEqual({ name: 'alice' });
    });
  });

  describe('validateSnapshotId', () => {
    it('accepts valid snapshot IDs', () => {
      const manager = new BackupManager(stateDir);
      expect(manager.validateSnapshotId('2025-01-15T143022Z')).toBe(true);
      expect(manager.validateSnapshotId('2026-12-31T235959Z')).toBe(true);
      expect(manager.validateSnapshotId('2025-01-15T143022Z-1')).toBe(true);
      expect(manager.validateSnapshotId('2025-01-15T143022Z-42')).toBe(true);
    });

    it('rejects invalid formats', () => {
      const manager = new BackupManager(stateDir);
      expect(manager.validateSnapshotId('')).toBe(false);
      expect(manager.validateSnapshotId('not-a-date')).toBe(false);
      expect(manager.validateSnapshotId('2025-01-15')).toBe(false);
      expect(manager.validateSnapshotId('20250115T143022Z')).toBe(false);
    });

    it('rejects path traversal attempts', () => {
      const manager = new BackupManager(stateDir);
      expect(manager.validateSnapshotId('../../etc')).toBe(false);
      expect(manager.validateSnapshotId('../..')).toBe(false);
    });
  });

  describe('getSnapshotPath', () => {
    it('returns path for valid ID', () => {
      const manager = new BackupManager(stateDir);
      const expected = path.resolve(stateDir, 'backups', '2025-06-15T120000Z');
      expect(manager.getSnapshotPath('2025-06-15T120000Z')).toBe(expected);
    });

    it('throws on invalid ID', () => {
      const manager = new BackupManager(stateDir);
      expect(() => manager.getSnapshotPath('bad-id')).toThrow('Invalid snapshot ID');
    });
  });

  describe('autoSnapshot', () => {
    it('creates a snapshot on first call', () => {
      const manager = new BackupManager(stateDir);
      const result = manager.autoSnapshot();

      expect(result).not.toBeNull();
      expect(result!.trigger).toBe('auto-session');
    });

    it('returns null on second call within 30 minutes', () => {
      const manager = new BackupManager(stateDir);
      const first = manager.autoSnapshot();
      expect(first).not.toBeNull();

      const second = manager.autoSnapshot();
      expect(second).toBeNull();
    });

    it('allows another snapshot after 30+ minutes', () => {
      const manager = new BackupManager(stateDir);

      // First call
      const first = manager.autoSnapshot();
      expect(first).not.toBeNull();

      // Advance time by 31 minutes
      const realDateNow = Date.now;
      vi.spyOn(Date, 'now').mockReturnValue(realDateNow() + 31 * 60 * 1000);

      const second = manager.autoSnapshot();
      expect(second).not.toBeNull();

      vi.restoreAllMocks();
    });

    it('returns null when config.enabled is false', () => {
      const manager = new BackupManager(stateDir, { enabled: false });
      const result = manager.autoSnapshot();
      expect(result).toBeNull();
    });
  });

  describe('pruneSnapshots', () => {
    it('does not prune when under maxSnapshots', () => {
      const manager = new BackupManager(stateDir, { maxSnapshots: 5 });
      manager.createSnapshot('manual');
      manager.createSnapshot('manual');

      const removed = manager.pruneSnapshots();
      expect(removed).toBe(0);
      expect(manager.listSnapshots().length).toBe(2);
    });

    it('prunes oldest snapshots when exceeding maxSnapshots', () => {
      const manager = new BackupManager(stateDir, { maxSnapshots: 2 });

      // Create 4 snapshots (each createSnapshot also calls pruneSnapshots internally)
      // We need unique timestamps, so use Date mock
      const baseTime = new Date('2025-01-01T00:00:00Z').getTime();
      const originalDate = globalThis.Date;

      for (let i = 0; i < 4; i++) {
        // Each snapshot needs a unique timestamp
        const mockDate = new originalDate(baseTime + i * 60000);
        vi.spyOn(globalThis, 'Date').mockImplementation(function(this: Date, ...args: any[]) {
          if (args.length === 0) return mockDate;
          // @ts-ignore
          return new originalDate(...args);
        } as any);
        // Also mock toISOString on the result
        (globalThis.Date as any).now = originalDate.now;
        (globalThis.Date as any).parse = originalDate.parse;
        (globalThis.Date as any).UTC = originalDate.UTC;

        manager.createSnapshot('manual');
        vi.restoreAllMocks();
      }

      // After 4 creates with maxSnapshots=2, should be pruned to 2
      const remaining = manager.listSnapshots();
      expect(remaining.length).toBeLessThanOrEqual(2);
    });

    it('returns count of removed snapshots', () => {
      // Create snapshots manually to avoid auto-pruning
      const manager = new BackupManager(stateDir, { maxSnapshots: 20 });

      // Create 3 snapshots
      manager.createSnapshot('manual');
      manager.createSnapshot('manual');
      manager.createSnapshot('manual');

      // Now create a strict manager and prune
      const strictManager = new BackupManager(stateDir, { maxSnapshots: 1 });
      const removed = strictManager.pruneSnapshots();
      expect(removed).toBe(2);
      expect(strictManager.listSnapshots().length).toBe(1);
    });
  });

  describe('custom config', () => {
    it('unions custom includeFiles with defaults (never replaces)', () => {
      // User-supplied includeFiles are ADDED to the defaults; migrators and
      // user config extend the backup set without risk of stripping
      // identity/memory defaults. Pre-change semantics were replace — that
      // footgun is what this commit closes.
      fs.writeFileSync(path.join(stateDir, 'custom-state.json'), '{"x": 1}');
      const manager = new BackupManager(stateDir, {
        includeFiles: ['custom-state.json'],
      });
      const snapshot = manager.createSnapshot('manual');

      expect(snapshot.files).toContain('custom-state.json');
      expect(snapshot.files).toContain('AGENT.md');
      expect(snapshot.files).toContain('MEMORY.md');
      expect(snapshot.files).toContain('jobs.json');
    });

    it('missing config.backup does not crash (defaults only)', () => {
      // ctx.config.backup is optional; routes pass it straight through.
      // Constructor must tolerate undefined.
      const manager = new BackupManager(stateDir, undefined);
      const snapshot = manager.createSnapshot('manual');

      expect(snapshot.files).toContain('AGENT.md');
      expect(snapshot.files).toContain('MEMORY.md');
    });

    it('dedupes entries present in both defaults and user config', () => {
      // If a user or migrator re-specifies a default path, it appears once,
      // not twice, in the snapshot.
      const manager = new BackupManager(stateDir, {
        includeFiles: ['AGENT.md', 'MEMORY.md'],
      });
      const snapshot = manager.createSnapshot('manual');

      const agentCount = snapshot.files.filter((f) => f === 'AGENT.md').length;
      const memoryCount = snapshot.files.filter((f) => f === 'MEMORY.md').length;
      expect(agentCount).toBe(1);
      expect(memoryCount).toBe(1);
    });

    it('uses custom maxSnapshots', () => {
      const manager = new BackupManager(stateDir, { maxSnapshots: 1 });
      manager.createSnapshot('manual');
      manager.createSnapshot('manual');

      expect(manager.listSnapshots().length).toBeLessThanOrEqual(1);
    });
  });

  describe('empty state', () => {
    it('produces snapshot with no files when state dir is empty', () => {
      const emptyDir = createTempDir();
      try {
        const manager = new BackupManager(emptyDir);
        const snapshot = manager.createSnapshot('manual');

        expect(snapshot.files).toEqual([]);
        expect(snapshot.totalBytes).toBe(0);
        expect(snapshot.integrityHash).toBeDefined();
      } finally {
        cleanup(emptyDir);
      }
    });
  });

  describe('integrity hash', () => {
    it('produces consistent hash for same files and bytes', () => {
      const manager = new BackupManager(stateDir);
      const snap1 = manager.createSnapshot('manual');
      const snap2 = manager.createSnapshot('manual');

      // Same files should produce same hash (assuming file contents haven't changed)
      expect(snap1.integrityHash).toBe(snap2.integrityHash);
    });

    it('produces different hash when files change', () => {
      const manager = new BackupManager(stateDir);
      const snap1 = manager.createSnapshot('manual');

      // Modify a file
      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent Identity\nI am a MODIFIED test agent with more content.');
      const snap2 = manager.createSnapshot('manual');

      // Different content = different bytes = different hash
      expect(snap1.integrityHash).not.toBe(snap2.integrityHash);
    });
  });
});
