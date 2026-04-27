import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TelemetryHeartbeat } from '../../src/monitoring/TelemetryHeartbeat.js';
import type { TelemetryConfig } from '../../src/core/types.js';

describe('TelemetryHeartbeat', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createHeartbeat(overrides: Partial<TelemetryConfig> = {}): TelemetryHeartbeat {
    const config: TelemetryConfig = {
      enabled: true,
      level: 'basic',
      ...overrides,
    };
    return new TelemetryHeartbeat(config, tmpDir, '/tmp/test-project', '0.14.0-test');
  }

  describe('buildPayload()', () => {
    it('should build a valid basic-level payload', () => {
      const hb = createHeartbeat({ level: 'basic' });
      const payload = hb.buildPayload();

      expect(payload.v).toBe(1);
      expect(payload.id).toMatch(/^[a-f0-9]{16}$/);
      expect(payload.instar).toBe('0.14.0-test');
      expect(payload.node).toBeTruthy();
      expect(payload.os).toBe(os.platform());
      expect(payload.arch).toBe(os.arch());
      expect(payload.agents).toBe(0);
      expect(payload.uptime_hours).toBeGreaterThanOrEqual(0);
      // Basic level should NOT include usage metrics
      expect(payload.jobs_run_24h).toBeUndefined();
      expect(payload.sessions_spawned_24h).toBeUndefined();
      expect(payload.skills_invoked_24h).toBeUndefined();
    });

    it('should include usage metrics at usage level', () => {
      const hb = createHeartbeat({ level: 'usage' });
      hb.recordJobRun();
      hb.recordJobRun();
      hb.recordSessionSpawned();
      hb.recordSkillInvoked();
      hb.recordSkillInvoked();
      hb.recordSkillInvoked();

      const payload = hb.buildPayload();
      expect(payload.jobs_run_24h).toBe(2);
      expect(payload.sessions_spawned_24h).toBe(1);
      expect(payload.skills_invoked_24h).toBe(3);
    });

    it('should use stable install ID across calls', () => {
      const hb = createHeartbeat();
      const p1 = hb.buildPayload();
      const p2 = hb.buildPayload();
      expect(p1.id).toBe(p2.id);
    });
  });

  describe('agent count provider', () => {
    it('should use registered agent count provider', () => {
      const hb = createHeartbeat();
      hb.setAgentCountProvider(() => 5);
      const payload = hb.buildPayload();
      expect(payload.agents).toBe(5);
    });
  });

  describe('recording methods', () => {
    it('should increment counters', () => {
      const hb = createHeartbeat({ level: 'usage' });

      for (let i = 0; i < 10; i++) hb.recordJobRun();
      for (let i = 0; i < 3; i++) hb.recordSessionSpawned();
      for (let i = 0; i < 7; i++) hb.recordSkillInvoked();

      const payload = hb.buildPayload();
      expect(payload.jobs_run_24h).toBe(10);
      expect(payload.sessions_spawned_24h).toBe(3);
      expect(payload.skills_invoked_24h).toBe(7);
    });
  });

  describe('sendHeartbeat()', () => {
    it('should not send when disabled', async () => {
      const hb = createHeartbeat({ enabled: false });
      const result = await hb.sendHeartbeat();
      expect(result).toBe(false);
    });

    it('should handle network failure gracefully', async () => {
      const hb = createHeartbeat({
        enabled: true,
        endpoint: 'http://localhost:1/nonexistent',
      });
      // Should not throw — fire-and-forget
      const result = await hb.sendHeartbeat();
      expect(result).toBe(false);
    });

    it('should log heartbeat locally', async () => {
      const hb = createHeartbeat({
        enabled: true,
        endpoint: 'http://localhost:1/nonexistent',
      });
      await hb.sendHeartbeat();

      const logFile = path.join(tmpDir, 'telemetry', 'heartbeats.jsonl');
      expect(fs.existsSync(logFile)).toBe(true);
      const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0]);
      expect(entry._sent).toBe(false); // Failed to send (no server)
      expect(entry.instar).toBe('0.14.0-test');
    });
  });

  describe('getStatus()', () => {
    it('should return current status', () => {
      const hb = createHeartbeat({ level: 'usage' });
      const status = hb.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.level).toBe('usage');
      expect(status.installId).toMatch(/^[a-f0-9]{16}$/);
      expect(status.counters.jobsRun).toBe(0);
    });
  });

  describe('start/stop', () => {
    it('should not start when disabled', () => {
      const hb = createHeartbeat({ enabled: false });
      hb.start(); // Should be a no-op
      hb.stop();  // Should not error
    });
  });
});
