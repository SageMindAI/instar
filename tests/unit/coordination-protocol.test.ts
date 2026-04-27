/**
 * Unit tests for CoordinationProtocol — work coordination primitives.
 *
 * Tests file avoidance (request, broadcast, check, expiration),
 * work announcements (started, completed, paused, resumed, abandoned),
 * leadership (claim, renew, relinquish, lease expiry),
 * and peer work tracking.
 *
 * Uses a real AgentBus in JSONL mode for the dependency.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentBus } from '../../src/core/AgentBus.js';
import { CoordinationProtocol } from '../../src/core/CoordinationProtocol.js';
import type {
  FileAvoidanceRequest,
  FileAvoidanceResponse,
  WorkAnnouncement,
  LeadershipState,
} from '../../src/core/CoordinationProtocol.js';

function makeCoordinator(
  tmpDir: string,
  machineId = 'machine-a',
  overrides: {
    leaseTtlMs?: number;
    statusQueryTimeoutMs?: number;
    onAvoidanceRequest?: (req: FileAvoidanceRequest, from: string) => FileAvoidanceResponse;
    onWorkAnnouncement?: (announcement: WorkAnnouncement, from: string) => void;
  } = {},
) {
  const stateDir = path.join(tmpDir, '.instar');
  const bus = new AgentBus({
    stateDir,
    machineId,
    transport: 'jsonl',
    defaultTtlMs: 60000,
    pollIntervalMs: 50,
  });
  const coord = new CoordinationProtocol({
    bus,
    machineId,
    stateDir,
    ...overrides,
  });
  return { bus, coord };
}

describe('CoordinationProtocol', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-protocol-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Construction ────────────────────────────────────────────────

  describe('construction', () => {
    it('creates coordination directory on init', () => {
      makeCoordinator(tmpDir);
      const coordDir = path.join(tmpDir, '.instar', 'state', 'coordination');
      expect(fs.existsSync(coordDir)).toBe(true);
    });

    it('exposes machineId', () => {
      const { coord } = makeCoordinator(tmpDir, 'test-machine');
      expect(coord.getMachineId()).toBe('test-machine');
    });
  });

  // ── File Avoidance ──────────────────────────────────────────────

  describe('file avoidance', () => {
    it('broadcastFileAvoidance sends to all machines', async () => {
      const { bus, coord } = makeCoordinator(tmpDir);

      await coord.broadcastFileAvoidance({
        files: ['src/auth.ts', 'src/routes.ts'],
        durationMs: 30000,
        reason: 'Refactoring auth module',
      });

      const outbox = bus.readOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].type).toBe('file-avoidance-request');
      expect(outbox[0].to).toBe('*');
      expect(outbox[0].payload).toEqual({
        files: ['src/auth.ts', 'src/routes.ts'],
        durationMs: 30000,
        reason: 'Refactoring auth module',
      });
    });

    it('records avoidance when receiving a request', () => {
      const { bus, coord } = makeCoordinator(tmpDir, 'machine-a');

      // Simulate receiving a file avoidance request from machine-b
      bus.processIncoming([
        {
          id: 'msg_avoid1',
          type: 'file-avoidance-request',
          from: 'machine-b',
          to: 'machine-a',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            files: ['src/config.ts'],
            durationMs: 10000,
            reason: 'Config migration',
          },
          status: 'pending',
        },
      ]);

      const avoidance = coord.isFileAvoided('src/config.ts');
      expect(avoidance).toBeDefined();
      expect(avoidance!.from).toBe('machine-b');
      expect(avoidance!.files).toContain('src/config.ts');
      expect(avoidance!.reason).toBe('Config migration');
    });

    it('isFileAvoided returns undefined for non-avoided files', () => {
      const { coord } = makeCoordinator(tmpDir);
      expect(coord.isFileAvoided('src/unrelated.ts')).toBeUndefined();
    });

    it('getActiveAvoidances returns all active avoidances', () => {
      const { bus, coord } = makeCoordinator(tmpDir, 'machine-a');

      // Two avoidance requests from different machines
      bus.processIncoming([
        {
          id: 'msg_avoid2',
          type: 'file-avoidance-request',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            files: ['src/a.ts'],
            durationMs: 30000,
            reason: 'Working on A',
          },
          status: 'pending',
        },
        {
          id: 'msg_avoid3',
          type: 'file-avoidance-request',
          from: 'machine-c',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            files: ['src/b.ts'],
            durationMs: 30000,
            reason: 'Working on B',
          },
          status: 'pending',
        },
      ]);

      const avoidances = coord.getActiveAvoidances();
      expect(avoidances).toHaveLength(2);
      expect(avoidances.map(a => a.from).sort()).toEqual(['machine-b', 'machine-c']);
    });

    it('expired avoidances are cleaned up', async () => {
      const { bus, coord } = makeCoordinator(tmpDir, 'machine-a');

      // Short-lived avoidance
      bus.processIncoming([
        {
          id: 'msg_avoid_exp',
          type: 'file-avoidance-request',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            files: ['src/temp.ts'],
            durationMs: 1, // 1ms duration — will expire almost immediately
            reason: 'Very brief',
          },
          status: 'pending',
        },
      ]);

      // Wait for expiration
      await new Promise(r => setTimeout(r, 10));

      expect(coord.isFileAvoided('src/temp.ts')).toBeUndefined();
      expect(coord.getActiveAvoidances()).toHaveLength(0);
    });

    it('invokes onAvoidanceRequest callback when configured', () => {
      const responses: { req: FileAvoidanceRequest; from: string }[] = [];

      const { bus, coord } = makeCoordinator(tmpDir, 'machine-a', {
        onAvoidanceRequest: (req, from) => {
          responses.push({ req, from });
          return {
            accepted: true,
            conflictingFiles: [],
          };
        },
      });

      bus.processIncoming([
        {
          id: 'msg_avoid_cb',
          type: 'file-avoidance-request',
          from: 'machine-b',
          to: 'machine-a',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            files: ['src/test.ts'],
            durationMs: 10000,
            reason: 'Testing callback',
          },
          status: 'pending',
        },
      ]);

      expect(responses).toHaveLength(1);
      expect(responses[0].from).toBe('machine-b');
      expect(responses[0].req.files).toEqual(['src/test.ts']);
    });

    it('requestFileAvoidance sends directed message and awaits response', async () => {
      const { bus, coord } = makeCoordinator(tmpDir, 'machine-a', {
        statusQueryTimeoutMs: 200,
      });

      const requestPromise = coord.requestFileAvoidance('machine-b', {
        files: ['src/api.ts'],
        durationMs: 15000,
        reason: 'API refactor',
      });

      // Simulate response from machine-b
      const outbox = bus.readOutbox();
      const requestMsg = outbox[outbox.length - 1];

      setTimeout(() => {
        bus.processIncoming([
          {
            id: 'msg_avoid_resp',
            type: 'file-avoidance-response',
            from: 'machine-b',
            to: 'machine-a',
            timestamp: new Date().toISOString(),
            ttlMs: 60000,
            payload: {
              accepted: true,
              conflictingFiles: [],
            },
            replyTo: requestMsg.id,
            status: 'pending',
          },
        ]);
      }, 50);

      const response = await requestPromise;
      expect(response).not.toBeNull();
      expect(response!.accepted).toBe(true);
      expect(response!.conflictingFiles).toEqual([]);
    });

    it('requestFileAvoidance returns null on timeout', async () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', {
        statusQueryTimeoutMs: 100,
      });

      const response = await coord.requestFileAvoidance('machine-b', {
        files: ['src/api.ts'],
        durationMs: 15000,
        reason: 'API refactor',
      });

      expect(response).toBeNull();
    });
  });

  // ── Work Announcements ──────────────────────────────────────────

  describe('work announcements', () => {
    it('announceWorkStarted broadcasts and returns workId', async () => {
      const { bus, coord } = makeCoordinator(tmpDir);

      const workId = await coord.announceWorkStarted({
        sessionId: 'AUT-100',
        task: 'Implementing OAuth',
        files: ['src/auth.ts'],
        branch: 'feature/oauth',
      });

      expect(workId).toMatch(/^work_[a-f0-9]{12}$/);

      const outbox = bus.readOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].type).toBe('work-announcement');
      expect(outbox[0].to).toBe('*');
      const payload = outbox[0].payload as WorkAnnouncement;
      expect(payload.action).toBe('started');
      expect(payload.sessionId).toBe('AUT-100');
      expect(payload.task).toBe('Implementing OAuth');
    });

    it('announceWorkCompleted broadcasts completion', async () => {
      const { bus, coord } = makeCoordinator(tmpDir);

      await coord.announceWorkCompleted('work_abc123', 'AUT-100', ['src/auth.ts']);

      const outbox = bus.readOutbox();
      expect(outbox).toHaveLength(1);
      const payload = outbox[0].payload as WorkAnnouncement;
      expect(payload.action).toBe('completed');
      expect(payload.workId).toBe('work_abc123');
    });

    it('tracks peer work when announcements are received', () => {
      const { bus, coord } = makeCoordinator(tmpDir, 'machine-a');

      // Machine B announces work started
      bus.processIncoming([
        {
          id: 'msg_wa1',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_b1',
            action: 'started',
            sessionId: 'AUT-200',
            task: 'Database migration',
            files: ['prisma/schema.prisma'],
          },
          status: 'pending',
        },
      ]);

      const peerWork = coord.getPeerWork('machine-b');
      expect(peerWork).toHaveLength(1);
      expect(peerWork[0].task).toBe('Database migration');
      expect(peerWork[0].action).toBe('started');
    });

    it('removes peer work when completed announcement received', () => {
      const { bus, coord } = makeCoordinator(tmpDir, 'machine-a');

      // Start work
      bus.processIncoming([
        {
          id: 'msg_wa_start',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_b1',
            action: 'started',
            sessionId: 'AUT-200',
            task: 'Migration',
            files: ['schema.prisma'],
          },
          status: 'pending',
        },
      ]);

      expect(coord.getPeerWork('machine-b')).toHaveLength(1);

      // Complete work
      bus.processIncoming([
        {
          id: 'msg_wa_complete',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_b1',
            action: 'completed',
            sessionId: 'AUT-200',
            task: '',
            files: ['schema.prisma'],
          },
          status: 'pending',
        },
      ]);

      expect(coord.getPeerWork('machine-b')).toHaveLength(0);
    });

    it('updates peer work status to paused', () => {
      const { bus, coord } = makeCoordinator(tmpDir, 'machine-a');

      // Start work
      bus.processIncoming([
        {
          id: 'msg_wa_p1',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_b2',
            action: 'started',
            sessionId: 'AUT-200',
            task: 'Work',
            files: ['file.ts'],
          },
          status: 'pending',
        },
      ]);

      // Pause work
      bus.processIncoming([
        {
          id: 'msg_wa_p2',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_b2',
            action: 'paused',
            sessionId: 'AUT-200',
            task: 'Work',
            files: ['file.ts'],
          },
          status: 'pending',
        },
      ]);

      const peerWork = coord.getPeerWork('machine-b');
      expect(peerWork).toHaveLength(1);
      expect(peerWork[0].action).toBe('paused');
    });

    it('resumes work by updating existing entry', () => {
      const { bus, coord } = makeCoordinator(tmpDir, 'machine-a');

      // Start then pause
      bus.processIncoming([
        {
          id: 'msg_r1',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_b3',
            action: 'started',
            sessionId: 'AUT-200',
            task: 'Work',
            files: ['file.ts'],
          },
          status: 'pending',
        },
      ]);

      // Resume
      bus.processIncoming([
        {
          id: 'msg_r2',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_b3',
            action: 'resumed',
            sessionId: 'AUT-200',
            task: 'Work resumed',
            files: ['file.ts'],
          },
          status: 'pending',
        },
      ]);

      const peerWork = coord.getPeerWork('machine-b');
      expect(peerWork).toHaveLength(1);
      expect(peerWork[0].action).toBe('resumed');
      expect(peerWork[0].task).toBe('Work resumed');
    });

    it('removes peer work on abandoned announcement', () => {
      const { bus, coord } = makeCoordinator(tmpDir, 'machine-a');

      bus.processIncoming([
        {
          id: 'msg_ab1',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_b4',
            action: 'started',
            sessionId: 'AUT-200',
            task: 'Doomed work',
            files: ['file.ts'],
          },
          status: 'pending',
        },
      ]);

      bus.processIncoming([
        {
          id: 'msg_ab2',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_b4',
            action: 'abandoned',
            sessionId: 'AUT-200',
            task: 'Doomed work',
            files: ['file.ts'],
          },
          status: 'pending',
        },
      ]);

      expect(coord.getPeerWork('machine-b')).toHaveLength(0);
    });

    it('getPeerWork returns all peer work when no machineId specified', () => {
      const { bus, coord } = makeCoordinator(tmpDir, 'machine-a');

      // Machine B and C both announce
      bus.processIncoming([
        {
          id: 'msg_all1',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_b5',
            action: 'started',
            sessionId: 'AUT-200',
            task: 'B task',
            files: ['b.ts'],
          },
          status: 'pending',
        },
        {
          id: 'msg_all2',
          type: 'work-announcement',
          from: 'machine-c',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_c1',
            action: 'started',
            sessionId: 'AUT-300',
            task: 'C task',
            files: ['c.ts'],
          },
          status: 'pending',
        },
      ]);

      const allWork = coord.getPeerWork();
      expect(allWork).toHaveLength(2);
      expect(allWork.map(w => w.task).sort()).toEqual(['B task', 'C task']);
    });

    it('getPeerWork returns empty for unknown machine', () => {
      const { coord } = makeCoordinator(tmpDir);
      expect(coord.getPeerWork('unknown-machine')).toEqual([]);
    });

    it('invokes onWorkAnnouncement callback', () => {
      const announcements: { announcement: WorkAnnouncement; from: string }[] = [];

      const { bus } = makeCoordinator(tmpDir, 'machine-a', {
        onWorkAnnouncement: (announcement, from) => {
          announcements.push({ announcement, from });
        },
      });

      bus.processIncoming([
        {
          id: 'msg_wa_cb',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            workId: 'work_cb1',
            action: 'started',
            sessionId: 'AUT-200',
            task: 'Callback test',
            files: ['test.ts'],
          },
          status: 'pending',
        },
      ]);

      expect(announcements).toHaveLength(1);
      expect(announcements[0].from).toBe('machine-b');
      expect(announcements[0].announcement.task).toBe('Callback test');
    });
  });

  // ── Leadership ──────────────────────────────────────────────────

  describe('leadership', () => {
    it('claimLeadership succeeds when no current leader', () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', { leaseTtlMs: 5000 });

      const state = coord.claimLeadership();
      expect(state).not.toBeNull();
      expect(state!.leaderId).toBe('machine-a');
      expect(state!.role).toBe('awake');
      expect(state!.fencingToken).toBe(1);
      expect(new Date(state!.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(state!.acquiredAt).toBeDefined();
    });

    it('claimLeadership increments fencing token', () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', { leaseTtlMs: 5000 });

      const first = coord.claimLeadership()!;
      expect(first.fencingToken).toBe(1);

      // Relinquish and reclaim
      coord.relinquishLeadership();
      const second = coord.claimLeadership()!;
      expect(second.fencingToken).toBe(2);
    });

    it('claimLeadership fails when another machine holds a valid lease', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const busA = new AgentBus({ stateDir, machineId: 'machine-a', transport: 'jsonl' });
      const coordA = new CoordinationProtocol({
        bus: busA, machineId: 'machine-a', stateDir, leaseTtlMs: 60000,
      });

      const busB = new AgentBus({ stateDir, machineId: 'machine-b', transport: 'jsonl' });
      const coordB = new CoordinationProtocol({
        bus: busB, machineId: 'machine-b', stateDir, leaseTtlMs: 60000,
      });

      // Machine A claims
      const stateA = coordA.claimLeadership();
      expect(stateA).not.toBeNull();

      // Machine B tries to claim — should fail
      const stateB = coordB.claimLeadership();
      expect(stateB).toBeNull();
    });

    it('claimLeadership succeeds after another machines lease expires', async () => {
      const stateDir = path.join(tmpDir, '.instar');
      const busA = new AgentBus({ stateDir, machineId: 'machine-a', transport: 'jsonl' });
      const coordA = new CoordinationProtocol({
        bus: busA, machineId: 'machine-a', stateDir, leaseTtlMs: 50, // 50ms lease
      });

      const busB = new AgentBus({ stateDir, machineId: 'machine-b', transport: 'jsonl' });
      const coordB = new CoordinationProtocol({
        bus: busB, machineId: 'machine-b', stateDir, leaseTtlMs: 60000,
      });

      // Machine A claims with short lease
      coordA.claimLeadership();

      // Wait for lease to expire
      await new Promise(r => setTimeout(r, 100));

      // Machine B should now be able to claim
      const stateB = coordB.claimLeadership();
      expect(stateB).not.toBeNull();
      expect(stateB!.leaderId).toBe('machine-b');
      expect(stateB!.fencingToken).toBe(2);
    });

    it('isLeader returns true for current leader with valid lease', () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', { leaseTtlMs: 60000 });
      coord.claimLeadership();
      expect(coord.isLeader()).toBe(true);
    });

    it('isLeader returns false when not leader', () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a');
      expect(coord.isLeader()).toBe(false);
    });

    it('isLeader returns false when lease has expired', async () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', { leaseTtlMs: 50 });
      coord.claimLeadership();
      expect(coord.isLeader()).toBe(true);

      await new Promise(r => setTimeout(r, 100));
      expect(coord.isLeader()).toBe(false);
    });

    it('isLeaseExpired returns true when no leader exists', () => {
      const { coord } = makeCoordinator(tmpDir);
      expect(coord.isLeaseExpired()).toBe(true);
    });

    it('isLeaseExpired returns false when lease is valid', () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', { leaseTtlMs: 60000 });
      coord.claimLeadership();
      expect(coord.isLeaseExpired()).toBe(false);
    });

    it('isLeaseExpired returns true after lease expires', async () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', { leaseTtlMs: 50 });
      coord.claimLeadership();

      await new Promise(r => setTimeout(r, 100));
      expect(coord.isLeaseExpired()).toBe(true);
    });

    it('renewLease extends the lease', () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', { leaseTtlMs: 60000 });
      const original = coord.claimLeadership()!;
      const originalExpiry = new Date(original.leaseExpiresAt).getTime();

      // Small delay to ensure renewal time is different
      const renewed = coord.renewLease()!;
      expect(renewed).not.toBeNull();
      const renewedExpiry = new Date(renewed.leaseExpiresAt).getTime();

      expect(renewedExpiry).toBeGreaterThanOrEqual(originalExpiry);
      expect(renewed.leaderId).toBe('machine-a');
    });

    it('renewLease returns null if not the leader', () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a');
      expect(coord.renewLease()).toBeNull();
    });

    it('renewLease returns null if different machine is leader', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const busA = new AgentBus({ stateDir, machineId: 'machine-a', transport: 'jsonl' });
      const coordA = new CoordinationProtocol({
        bus: busA, machineId: 'machine-a', stateDir, leaseTtlMs: 60000,
      });
      const busB = new AgentBus({ stateDir, machineId: 'machine-b', transport: 'jsonl' });
      const coordB = new CoordinationProtocol({
        bus: busB, machineId: 'machine-b', stateDir, leaseTtlMs: 60000,
      });

      coordA.claimLeadership();
      expect(coordB.renewLease()).toBeNull();
    });

    it('relinquishLeadership expires the lease immediately', () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', { leaseTtlMs: 60000 });
      coord.claimLeadership();
      expect(coord.isLeader()).toBe(true);

      coord.relinquishLeadership();
      expect(coord.isLeader()).toBe(false);
      expect(coord.isLeaseExpired()).toBe(true);
    });

    it('relinquishLeadership sets role to standby', () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', { leaseTtlMs: 60000 });
      coord.claimLeadership();
      coord.relinquishLeadership();

      const leadership = coord.getLeadership();
      expect(leadership).not.toBeNull();
      expect(leadership!.role).toBe('standby');
    });

    it('relinquishLeadership is safe when not leader', () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a');
      // Should not throw
      coord.relinquishLeadership();
    });

    it('getLeadership returns null when no leadership exists', () => {
      const { coord } = makeCoordinator(tmpDir);
      expect(coord.getLeadership()).toBeNull();
    });

    it('getLeadership returns current state', () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', { leaseTtlMs: 60000 });
      coord.claimLeadership();

      const state = coord.getLeadership();
      expect(state).not.toBeNull();
      expect(state!.leaderId).toBe('machine-a');
      expect(state!.role).toBe('awake');
    });

    it('leadership persists to disk', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const bus1 = new AgentBus({ stateDir, machineId: 'machine-a', transport: 'jsonl' });
      const coord1 = new CoordinationProtocol({
        bus: bus1, machineId: 'machine-a', stateDir, leaseTtlMs: 60000,
      });
      coord1.claimLeadership();

      // Read from a fresh instance
      const bus2 = new AgentBus({ stateDir, machineId: 'machine-a', transport: 'jsonl' });
      const coord2 = new CoordinationProtocol({
        bus: bus2, machineId: 'machine-a', stateDir,
      });

      const state = coord2.getLeadership();
      expect(state).not.toBeNull();
      expect(state!.leaderId).toBe('machine-a');
    });
  });

  // ── Status Queries ──────────────────────────────────────────────

  describe('status queries', () => {
    it('queryStatus returns null on timeout', async () => {
      const { coord } = makeCoordinator(tmpDir, 'machine-a', {
        statusQueryTimeoutMs: 100,
      });

      const response = await coord.queryStatus('machine-b');
      expect(response).toBeNull();
    });
  });
});
