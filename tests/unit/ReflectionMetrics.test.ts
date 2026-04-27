/**
 * Unit tests for ReflectionMetrics
 *
 * Tests the usage-based reflection trigger system:
 * tool call tracking, session counting, threshold checking,
 * reflection recording, and self-tuning.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ReflectionMetrics } from '../../src/monitoring/ReflectionMetrics.js';

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-metrics-test-'));
}

describe('ReflectionMetrics', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('starts with zero counters', () => {
      const metrics = new ReflectionMetrics(stateDir);
      const check = metrics.check();
      expect(check.metrics.toolCalls).toBe(0);
      expect(check.metrics.sessions).toBe(0);
      expect(check.suggested).toBe(false);
    });

    it('has default thresholds', () => {
      const metrics = new ReflectionMetrics(stateDir);
      const check = metrics.check();
      expect(check.thresholds.toolCalls).toBe(50);
      expect(check.thresholds.sessions).toBe(3);
      expect(check.thresholds.minutes).toBe(120);
    });
  });

  describe('tool call tracking', () => {
    it('increments tool call counter', () => {
      const metrics = new ReflectionMetrics(stateDir);
      metrics.recordToolCall();
      metrics.recordToolCall();
      metrics.recordToolCall();
      expect(metrics.check().metrics.toolCalls).toBe(3);
    });

    it('suggests reflection when threshold crossed', () => {
      const metrics = new ReflectionMetrics(stateDir);
      metrics.updateThresholds({ toolCalls: 3 });
      metrics.recordToolCall();
      metrics.recordToolCall();
      expect(metrics.check().suggested).toBe(false);
      metrics.recordToolCall();
      const check = metrics.check();
      expect(check.suggested).toBe(true);
      expect(check.exceededThresholds).toContain('toolCalls');
    });
  });

  describe('session tracking', () => {
    it('increments session counter', () => {
      const metrics = new ReflectionMetrics(stateDir);
      metrics.recordSessionStart();
      metrics.recordSessionStart();
      expect(metrics.check().metrics.sessions).toBe(2);
    });

    it('suggests reflection when session threshold crossed', () => {
      const metrics = new ReflectionMetrics(stateDir);
      metrics.updateThresholds({ sessions: 2 });
      metrics.recordSessionStart();
      expect(metrics.check().suggested).toBe(false);
      metrics.recordSessionStart();
      expect(metrics.check().suggested).toBe(true);
    });
  });

  describe('reflection recording', () => {
    it('resets counters when reflection is recorded', () => {
      const metrics = new ReflectionMetrics(stateDir);
      metrics.recordToolCall();
      metrics.recordToolCall();
      metrics.recordSessionStart();
      expect(metrics.check().metrics.toolCalls).toBe(2);

      metrics.recordReflection('quick');
      const check = metrics.check();
      expect(check.metrics.toolCalls).toBe(0);
      expect(check.metrics.sessions).toBe(0);
    });

    it('adds to history', () => {
      const metrics = new ReflectionMetrics(stateDir);
      metrics.recordToolCall();
      metrics.recordReflection('deep');

      const data = metrics.getData();
      expect(data.history).toHaveLength(1);
      expect(data.history[0].type).toBe('deep');
      expect(data.history[0].toolCallsAtReflection).toBe(1);
    });

    it('records last reflection type', () => {
      const metrics = new ReflectionMetrics(stateDir);
      metrics.recordReflection('grounding');
      expect(metrics.getData().lastReflectionType).toBe('grounding');
    });
  });

  describe('self-tuning thresholds', () => {
    it('updates specific thresholds', () => {
      const metrics = new ReflectionMetrics(stateDir);
      metrics.updateThresholds({ toolCalls: 100 });
      expect(metrics.check().thresholds.toolCalls).toBe(100);
      expect(metrics.check().thresholds.sessions).toBe(3); // unchanged
    });
  });

  describe('persistence', () => {
    it('survives reinstantiation', () => {
      const m1 = new ReflectionMetrics(stateDir);
      m1.recordToolCall();
      m1.recordToolCall();
      m1.recordSessionStart();

      const m2 = new ReflectionMetrics(stateDir);
      expect(m2.check().metrics.toolCalls).toBe(2);
      expect(m2.check().metrics.sessions).toBe(1);
    });

    it('preserves history across reinstantiation', () => {
      const m1 = new ReflectionMetrics(stateDir);
      m1.recordReflection('quick');

      const m2 = new ReflectionMetrics(stateDir);
      expect(m2.getData().history).toHaveLength(1);
    });

    it('handles corrupted file gracefully', () => {
      const metricsFile = path.join(stateDir, 'state', 'reflection-metrics.json');
      fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
      fs.writeFileSync(metricsFile, 'not valid json!!!');

      const metrics = new ReflectionMetrics(stateDir);
      // Should start fresh, not crash
      expect(metrics.check().metrics.toolCalls).toBe(0);
    });
  });
});
