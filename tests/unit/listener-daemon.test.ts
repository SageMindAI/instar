/**
 * Tests for the Persistent Listener Daemon infrastructure (Phases 1-4).
 *
 * Covers:
 * - WakeSocketServer (Unix socket IPC)
 * - PipeSessionSpawner (intent classification, prompt building, eligibility)
 * - ThreadResumeMap extensions (migration, spawn mode)
 * - ListenerDaemon (HMAC signing, health reporting)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

// ── WakeSocketServer Tests ──────────────────────────────────────────

describe('WakeSocketServer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-test-wake-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates socket file on start', async () => {
    const { WakeSocketServer } = await import('../../src/threadline/WakeSocketServer.js');
    const server = new WakeSocketServer(tmpDir);
    server.start();

    // Wait for socket creation
    await new Promise(r => setTimeout(r, 100));

    const socketPath = path.join(tmpDir, 'listener.sock');
    expect(fs.existsSync(socketPath)).toBe(true);

    server.stop();
  });

  it('emits wake event on 0x01 byte', async () => {
    const { WakeSocketServer } = await import('../../src/threadline/WakeSocketServer.js');
    const server = new WakeSocketServer(tmpDir);
    server.start();
    await new Promise(r => setTimeout(r, 100));

    const socketPath = path.join(tmpDir, 'listener.sock');
    let wakeReceived = false;
    server.on('wake', () => { wakeReceived = true; });

    // Connect and send wake signal
    const client = net.createConnection(socketPath);
    await new Promise(r => client.on('connect', r));
    client.write(Buffer.from([0x01]));
    await new Promise(r => setTimeout(r, 100));

    expect(wakeReceived).toBe(true);
    expect(server.totalWakes).toBe(1);

    client.destroy();
    server.stop();
  });

  it('emits failover-trigger event on 0x02 byte', async () => {
    const { WakeSocketServer } = await import('../../src/threadline/WakeSocketServer.js');
    const server = new WakeSocketServer(tmpDir);
    server.start();
    await new Promise(r => setTimeout(r, 100));

    const socketPath = path.join(tmpDir, 'listener.sock');
    let failoverReceived = false;
    server.on('failover-trigger', () => { failoverReceived = true; });

    const client = net.createConnection(socketPath);
    await new Promise(r => client.on('connect', r));
    client.write(Buffer.from([0x02]));
    await new Promise(r => setTimeout(r, 100));

    expect(failoverReceived).toBe(true);

    client.destroy();
    server.stop();
  });

  it('handles multiple clients', async () => {
    const { WakeSocketServer } = await import('../../src/threadline/WakeSocketServer.js');
    const server = new WakeSocketServer(tmpDir);
    server.start();
    await new Promise(r => setTimeout(r, 100));

    const socketPath = path.join(tmpDir, 'listener.sock');
    let wakeCount = 0;
    server.on('wake', () => { wakeCount++; });

    const client1 = net.createConnection(socketPath);
    const client2 = net.createConnection(socketPath);
    await new Promise(r => setTimeout(r, 100));

    expect(server.isDaemonConnected).toBe(true);

    client1.write(Buffer.from([0x01]));
    client2.write(Buffer.from([0x01]));
    await new Promise(r => setTimeout(r, 100));

    expect(wakeCount).toBe(2);

    client1.destroy();
    client2.destroy();
    server.stop();
  });

  it('cleans up socket file on stop', async () => {
    const { WakeSocketServer } = await import('../../src/threadline/WakeSocketServer.js');
    const server = new WakeSocketServer(tmpDir);
    server.start();
    await new Promise(r => setTimeout(r, 100));

    const socketPath = path.join(tmpDir, 'listener.sock');
    expect(fs.existsSync(socketPath)).toBe(true);

    server.stop();
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});

// ── PipeSessionSpawner Tests ────────────────────────────────────────

describe('PipeSessionSpawner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-test-pipe-'));
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'tmp'), { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('shouldUsePipeMode', () => {
    it('returns eligible for trusted agent with short message', async () => {
      const { PipeSessionSpawner } = await import('../../src/threadline/PipeSessionSpawner.js');
      const spawner = new PipeSessionSpawner({ stateDir: tmpDir });

      const result = spawner.shouldUsePipeMode({
        threadId: 'test-thread',
        messageText: 'What is the status?',
        fromFingerprint: 'abc123',
        fromName: 'test-agent',
        trustLevel: 'trusted',
        iqsBand: 80,
      });

      expect(result.eligible).toBe(true);
    });

    it('rejects untrusted agents', async () => {
      const { PipeSessionSpawner } = await import('../../src/threadline/PipeSessionSpawner.js');
      const spawner = new PipeSessionSpawner({ stateDir: tmpDir });

      const result = spawner.shouldUsePipeMode({
        threadId: 'test-thread',
        messageText: 'What is the status?',
        fromFingerprint: 'abc123',
        fromName: 'test-agent',
        trustLevel: 'untrusted',
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('trust');
    });

    it('rejects low IQS band', async () => {
      const { PipeSessionSpawner } = await import('../../src/threadline/PipeSessionSpawner.js');
      const spawner = new PipeSessionSpawner({ stateDir: tmpDir });

      const result = spawner.shouldUsePipeMode({
        threadId: 'test-thread',
        messageText: 'What is the status?',
        fromFingerprint: 'abc123',
        fromName: 'test-agent',
        trustLevel: 'trusted',
        iqsBand: 50,
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('IQS');
    });

    it('rejects long messages', async () => {
      const { PipeSessionSpawner } = await import('../../src/threadline/PipeSessionSpawner.js');
      const spawner = new PipeSessionSpawner({ stateDir: tmpDir });

      const result = spawner.shouldUsePipeMode({
        threadId: 'test-thread',
        messageText: 'x'.repeat(3000),
        fromFingerprint: 'abc123',
        fromName: 'test-agent',
        trustLevel: 'trusted',
        iqsBand: 80,
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('too long');
    });
  });

  describe('buildPipePrompt', () => {
    it('wraps message in untrusted-message tags', async () => {
      const { buildPipePrompt } = await import('../../src/threadline/PipeSessionSpawner.js');

      const prompt = buildPipePrompt({
        threadId: 'thread-123',
        messageText: 'Hello there',
        fromFingerprint: 'abc123def456',
        fromName: 'test-agent',
        trustLevel: 'trusted',
      });

      expect(prompt).toContain('<untrusted-message>');
      expect(prompt).toContain('Hello there');
      expect(prompt).toContain('</untrusted-message>');
      expect(prompt).toContain('thread-123');
      expect(prompt).toContain('test-agent');
      expect(prompt).toContain('CONSTRAINTS');
    });

    it('includes thread summary with skepticism warning', async () => {
      const { buildPipePrompt } = await import('../../src/threadline/PipeSessionSpawner.js');

      const prompt = buildPipePrompt(
        {
          threadId: 'thread-123',
          messageText: 'Follow up question',
          fromFingerprint: 'abc123',
          fromName: 'agent',
          trustLevel: 'trusted',
        },
        'Previous discussion about deployment.',
      );

      expect(prompt).toContain('<thread-summary>');
      expect(prompt).toContain('skepticism');
      expect(prompt).toContain('Previous discussion about deployment.');
      expect(prompt).toContain('</thread-summary>');
    });

    it('omits thread summary when not provided', async () => {
      const { buildPipePrompt } = await import('../../src/threadline/PipeSessionSpawner.js');

      const prompt = buildPipePrompt({
        threadId: 'thread-123',
        messageText: 'Hello',
        fromFingerprint: 'abc',
        fromName: 'agent',
        trustLevel: 'trusted',
      });

      expect(prompt).not.toContain('<thread-summary>');
    });
  });

  describe('metrics', () => {
    it('returns initial metrics', async () => {
      const { PipeSessionSpawner } = await import('../../src/threadline/PipeSessionSpawner.js');
      const spawner = new PipeSessionSpawner({ stateDir: tmpDir });

      const metrics = spawner.getMetrics();
      expect(metrics.active).toBe(0);
      expect(metrics.spawned).toBe(0);
      expect(metrics.completed).toBe(0);
      expect(metrics.timedOut).toBe(0);
      expect(metrics.sessions).toEqual([]);
    });
  });
});

// ── ThreadResumeMap Migration Tests ─────────────────────────────────

describe('ThreadResumeMap cross-machine migration', () => {
  let tmpDir: string;
  let projectDir: string;

  // Create mock JSONL files so ThreadResumeMap.get() doesn't return null
  let mockProjectDir: string | null = null;
  function createMockJsonl(uuid: string): void {
    const homeDir = os.homedir();
    const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

    // Find an existing project dir, or create a temporary one (e.g. on CI)
    let targetDir: string;
    if (fs.existsSync(claudeProjectsDir)) {
      const dirs = fs.readdirSync(claudeProjectsDir).filter(d =>
        fs.statSync(path.join(claudeProjectsDir, d)).isDirectory()
      );
      if (dirs.length > 0) {
        targetDir = path.join(claudeProjectsDir, dirs[0]);
      } else {
        targetDir = path.join(claudeProjectsDir, '_instar-test-mock');
        fs.mkdirSync(targetDir, { recursive: true });
        mockProjectDir = targetDir;
      }
    } else {
      targetDir = path.join(claudeProjectsDir, '_instar-test-mock');
      fs.mkdirSync(targetDir, { recursive: true });
      mockProjectDir = targetDir;
    }

    const mockPath = path.join(targetDir, `${uuid}.jsonl`);
    if (!fs.existsSync(mockPath)) {
      fs.writeFileSync(mockPath, '{"mock": true}\n');
      // safe-git-allow: incremental-migration
      afterEach(() => { try { fs.unlinkSync(mockPath); } catch { /* ignore */ } });
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-test-resume-'));
    projectDir = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'threadline'), { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (mockProjectDir && fs.existsSync(mockProjectDir)) {
      // safe-git-allow: incremental-migration
      fs.rmSync(mockProjectDir, { recursive: true, force: true });
      mockProjectDir = null;
    }
  });

  it('supports machineOrigin and migratedTo fields', async () => {
    const { ThreadResumeMap } = await import('../../src/threadline/ThreadResumeMap.js');
    const map = new ThreadResumeMap(tmpDir, projectDir);

    createMockJsonl('uuid-machine-1');
    map.save('thread-1', {
      uuid: 'uuid-machine-1',
      sessionName: 'session-1',
      createdAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      remoteAgent: 'agent-b',
      subject: 'Test thread',
      state: 'active',
      pinned: false,
      messageCount: 1,
      machineOrigin: 'machine-a',
    });

    const entry = map.get('thread-1');
    expect(entry).not.toBeNull();
    expect(entry!.machineOrigin).toBe('machine-a');
  });

  it('migrates active entries from source to target machine', async () => {
    const { ThreadResumeMap } = await import('../../src/threadline/ThreadResumeMap.js');
    const map = new ThreadResumeMap(tmpDir, projectDir);

    // Create entries from machine-a
    map.save('thread-1', {
      uuid: 'uuid-1',
      sessionName: 'session-1',
      createdAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      remoteAgent: 'agent-b',
      subject: 'Active thread',
      state: 'active',
      pinned: false,
      messageCount: 3,
      machineOrigin: 'machine-a',
    });

    map.save('thread-2', {
      uuid: 'uuid-2',
      sessionName: 'session-2',
      createdAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      remoteAgent: 'agent-c',
      subject: 'Resolved thread',
      state: 'resolved',
      pinned: false,
      messageCount: 5,
      machineOrigin: 'machine-a',
    });

    const result = map.migrateFrom('machine-a', 'machine-b');
    expect(result.migrated).toBe(1); // Only active threads
    expect(result.skipped).toBe(1); // Resolved thread skipped

    const migrated = map.getMigratedEntries('machine-b');
    expect(migrated).toHaveLength(1);
    expect(migrated[0].threadId).toBe('thread-1');
    expect(migrated[0].entry.state).toBe('idle');
    expect(migrated[0].entry.migratedTo).toBe('machine-b');
  });

  it('supports spawnMode field', async () => {
    const { ThreadResumeMap } = await import('../../src/threadline/ThreadResumeMap.js');
    const map = new ThreadResumeMap(tmpDir, projectDir);

    createMockJsonl('uuid-pipe-mode');
    map.save('thread-pipe', {
      uuid: 'uuid-pipe-mode',
      sessionName: 'pipe-thread',
      createdAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      remoteAgent: 'agent-b',
      subject: 'Pipe session',
      state: 'active',
      pinned: false,
      messageCount: 1,
      spawnMode: 'pipe',
    });

    const entry = map.get('thread-pipe');
    expect(entry!.spawnMode).toBe('pipe');
  });
});

// ── HMAC Signing Round-Trip Test ────────────────────────────────────

describe('HMAC inbox signing round-trip', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-test-hmac-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('signs and verifies inbox entries', async () => {
    const { ListenerSessionManager } = await import('../../src/threadline/ListenerSessionManager.js');
    const manager = new ListenerSessionManager(tmpDir, 'test-auth-token-123');

    // Write an entry
    const entryId = manager.writeToInbox({
      from: 'sender-fingerprint',
      senderName: 'sender',
      trustLevel: 'trusted',
      threadId: 'thread-test',
      text: 'Hello world',
    });

    expect(entryId).toBeTruthy();

    // Read and verify
    const entries = manager.getUnprocessedEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].text).toBe('Hello world');
    expect(entries[0].hmac).toBeTruthy();

    // Verify HMAC
    const isValid = manager.verifyEntry(entries[0]);
    expect(isValid).toBe(true);
  });

  it('rejects tampered entries', async () => {
    const { ListenerSessionManager } = await import('../../src/threadline/ListenerSessionManager.js');
    const manager = new ListenerSessionManager(tmpDir, 'test-auth-token-123');

    manager.writeToInbox({
      from: 'sender',
      senderName: 'sender',
      trustLevel: 'trusted',
      threadId: 'thread-test',
      text: 'Original message',
    });

    const entries = manager.getUnprocessedEntries();
    const entry = { ...entries[0], text: 'Tampered message' };

    const isValid = manager.verifyEntry(entry);
    expect(isValid).toBe(false);
  });
});
