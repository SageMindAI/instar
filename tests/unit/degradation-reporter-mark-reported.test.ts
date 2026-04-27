/**
 * Tests for DegradationReporter.markReported() — PR0c (context-death-
 * pitfall-prevention spec). Used by the guardian-pulse daily digest
 * consumer to close the loop after surfacing events to the attention
 * queue.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

describe('DegradationReporter.markReported', () => {
  let tmpDir: string;

  beforeEach(() => {
    DegradationReporter.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'degradation-mark-'));
  });

  afterEach(() => {
    DegradationReporter.resetForTesting();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(reporter: DegradationReporter, feature: string) {
    reporter.report({
      feature,
      primary: 'p',
      fallback: 'f',
      reason: 'r',
      impact: 'i',
    });
  }

  it('flips an unreported event to reported on exact-string match', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 't', instarVersion: '0' });
    seed(reporter, 'unjustifiedStopGate');

    expect(reporter.getUnreportedEvents()).toHaveLength(1);
    const flipped = reporter.markReported('unjustifiedStopGate');
    expect(flipped).toBe(1);
    expect(reporter.getUnreportedEvents()).toHaveLength(0);
  });

  it('returns 0 when no events match', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 't', instarVersion: '0' });
    seed(reporter, 'unjustifiedStopGate');
    const flipped = reporter.markReported('SomeOtherFeature');
    expect(flipped).toBe(0);
    expect(reporter.getUnreportedEvents()).toHaveLength(1);
  });

  it('is idempotent — re-marking already-reported events returns 0', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 't', instarVersion: '0' });
    seed(reporter, 'X');
    expect(reporter.markReported('X')).toBe(1);
    expect(reporter.markReported('X')).toBe(0);
  });

  it('matches multiple events with a regex pattern', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 't', instarVersion: '0' });
    seed(reporter, 'unjustifiedStopGate.timeout');
    seed(reporter, 'unjustifiedStopGate.malformed');
    seed(reporter, 'someOtherFeature');

    const flipped = reporter.markReported(/^unjustifiedStopGate\./);
    expect(flipped).toBe(2);
    expect(reporter.getUnreportedEvents().map(e => e.feature)).toEqual(['someOtherFeature']);
  });

  it('regex pattern that matches none returns 0', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 't', instarVersion: '0' });
    seed(reporter, 'X');
    const flipped = reporter.markReported(/^Y/);
    expect(flipped).toBe(0);
  });

  it('does not flip events that were already reported by the auto-pipeline', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 't', instarVersion: '0' });
    seed(reporter, 'AutoX');
    // simulate the auto-pipeline having already flipped one
    reporter.getEvents()[0].reported = true;
    const flipped = reporter.markReported('AutoX');
    expect(flipped).toBe(0);
  });
});
