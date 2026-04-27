/**
 * Unit tests for DegradationReporter — the "loud fallback" standard.
 *
 * When a feature falls back to a secondary path, that's a bug. The reporter
 * ensures fallback activations are never silent: they log, file feedback,
 * alert via Telegram, and persist to disk.
 *
 * Born from the insight: "Fallbacks should only and always be associated
 * with a bug report back to Instar." — Justin, 2026-02-25
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

describe('DegradationReporter', () => {
  let tmpDir: string;

  beforeEach(() => {
    DegradationReporter.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'degradation-test-'));
  });

  afterEach(() => {
    DegradationReporter.resetForTesting();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is a singleton', () => {
    const a = DegradationReporter.getInstance();
    const b = DegradationReporter.getInstance();
    expect(a).toBe(b);
  });

  it('reports degradation events', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    reporter.report({
      feature: 'TestFeature',
      primary: 'Primary path description',
      fallback: 'Fallback path description',
      reason: 'Primary failed because of X',
      impact: 'User sees degraded experience',
    });

    expect(reporter.hasDegradations()).toBe(true);
    expect(reporter.getEvents()).toHaveLength(1);

    const event = reporter.getEvents()[0];
    expect(event.feature).toBe('TestFeature');
    expect(event.reason).toBe('Primary failed because of X');
    expect(event.timestamp).toBeDefined();
    expect(event.reported).toBe(false); // No downstream connected yet
    expect(event.alerted).toBe(false);
  });

  it('persists events to disk', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    reporter.report({
      feature: 'DiskTest',
      primary: 'Primary',
      fallback: 'Fallback',
      reason: 'Test persistence',
      impact: 'None',
    });

    const filePath = path.join(tmpDir, 'degradations.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].feature).toBe('DiskTest');
  });

  it('logs to console with [DEGRADATION] prefix', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    reporter.report({
      feature: 'ConsoleTest',
      primary: 'Primary',
      fallback: 'Fallback',
      reason: 'Test logging',
      impact: 'None',
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[DEGRADATION]');
    expect(warnSpy.mock.calls[0][0]).toContain('ConsoleTest');

    warnSpy.mockRestore();
  });

  it('drains queued events when downstream connects', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    // Suppress console output
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Report BEFORE downstream is connected
    reporter.report({
      feature: 'QueueTest',
      primary: 'Primary',
      fallback: 'Fallback',
      reason: 'Queued event',
      impact: 'Delayed reporting',
    });

    expect(reporter.getEvents()[0].reported).toBe(false);

    // Connect downstream
    const feedbackSubmitter = vi.fn().mockResolvedValue({});
    const telegramSender = vi.fn().mockResolvedValue({});

    reporter.connectDownstream({
      feedbackSubmitter,
      telegramSender,
      alertTopicId: 42,
    });

    // Wait for async drain — use vi.waitFor to handle CPU-loaded environments
    // where a fixed setTimeout may not be enough (the drain calls async reportEvent
    // which awaits feedbackSubmitter and telegramSender promises).
    await vi.waitFor(() => {
      expect(feedbackSubmitter).toHaveBeenCalledTimes(1);
      expect(telegramSender).toHaveBeenCalledTimes(1);
    }, { timeout: 2000, interval: 20 });

    // Verify the feedback submission
    const feedbackCall = feedbackSubmitter.mock.calls[0][0];
    expect(feedbackCall.type).toBe('bug');
    expect(feedbackCall.title).toContain('[DEGRADATION]');
    expect(feedbackCall.title).toContain('QueueTest');

    // Verify the Telegram alert
    expect(telegramSender.mock.calls[0][0]).toBe(42); // topicId
    expect(telegramSender.mock.calls[0][1]).toContain('Delayed reporting');

    // Event should now be marked as reported and alerted
    const event = reporter.getEvents()[0];
    expect(event.reported).toBe(true);
    expect(event.alerted).toBe(true);

    vi.restoreAllMocks();
  });

  it('tracks unreported events', () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    reporter.report({
      feature: 'A', primary: 'P', fallback: 'F',
      reason: 'R', impact: 'I',
    });
    reporter.report({
      feature: 'B', primary: 'P', fallback: 'F',
      reason: 'R', impact: 'I',
    });

    expect(reporter.getUnreportedEvents()).toHaveLength(2);

    vi.restoreAllMocks();
  });

  it('handles feedback submission failure gracefully', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 'test-agent', instarVersion: '0.9.17' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    reporter.report({
      feature: 'FailTest', primary: 'P', fallback: 'F',
      reason: 'R', impact: 'I',
    });

    const feedbackSubmitter = vi.fn().mockRejectedValue(new Error('webhook down'));
    reporter.connectDownstream({ feedbackSubmitter });

    // Wait for async drain — use vi.waitFor for robustness under CPU load
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    }, { timeout: 2000, interval: 20 });

    // Should not throw — failure is logged, not propagated
    // Event stays unreported
    expect(reporter.getEvents()[0].reported).toBe(false);

    vi.restoreAllMocks();
  });

  it('works without stateDir configured (no disk persistence)', () => {
    const reporter = DegradationReporter.getInstance();
    // Deliberately not calling configure()

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Should not throw
    reporter.report({
      feature: 'NoDisk', primary: 'P', fallback: 'F',
      reason: 'R', impact: 'I',
    });

    expect(reporter.hasDegradations()).toBe(true);
    const diskFile = path.join(tmpDir, 'degradations.json');
    expect(fs.existsSync(diskFile)).toBe(false); // No disk write without stateDir

    vi.restoreAllMocks();
  });
});
