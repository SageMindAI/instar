import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock the detector modules before importing SessionRecovery
vi.mock('../../src/monitoring/stall-detector.js', () => ({
  detectToolCallStall: vi.fn(() => null),
  DEFAULT_TOOL_THRESHOLDS: {},
}));

vi.mock('../../src/monitoring/crash-detector.js', () => ({
  detectCrashedSession: vi.fn(() => null),
  detectErrorLoop: vi.fn(() => null),
}));

vi.mock('../../src/monitoring/jsonl-truncator.js', () => ({
  truncateJsonlToSafePoint: vi.fn(),
}));

import { SessionRecovery, type SessionRecoveryDeps } from '../../src/monitoring/SessionRecovery.js';
import { detectToolCallStall } from '../../src/monitoring/stall-detector.js';
import { detectCrashedSession, detectErrorLoop } from '../../src/monitoring/crash-detector.js';
import { truncateJsonlToSafePoint } from '../../src/monitoring/jsonl-truncator.js';

/**
 * SessionRecovery tests — mechanical session crash/stall recovery.
 *
 * Tests the deterministic recovery layer that runs before LLM triage:
 * stall detection, crash detection, truncation strategy escalation,
 * cooldowns, maxAttempts, and event logging.
 */

function createMockDeps(overrides: Partial<SessionRecoveryDeps> = {}): SessionRecoveryDeps {
  return {
    isSessionAlive: vi.fn(() => true),
    killSession: vi.fn(),
    respawnSession: vi.fn(async () => {}),
    getPanePid: vi.fn(() => null), // force findJsonlForSession to return null
    ...overrides,
  };
}

let tmpDir: string;

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-recovery-test-'));
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  return dir;
}

/**
 * Helper to run an async function while advancing fake timers,
 * so internal setTimeout calls resolve properly.
 */
async function runWithTimers<T>(fn: () => Promise<T>): Promise<T> {
  const promise = fn();
  // Advance timers enough for the 3000ms setTimeout inside recovery methods
  await vi.advanceTimersByTimeAsync(5000);
  return promise;
}

describe('SessionRecovery', () => {
  let recovery: SessionRecovery;
  let deps: SessionRecoveryDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = makeTmpDir();
    vi.mocked(detectToolCallStall).mockReturnValue(null);
    vi.mocked(detectCrashedSession).mockReturnValue(null);
    vi.mocked(detectErrorLoop).mockReturnValue(null);
    vi.mocked(truncateJsonlToSafePoint).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      // safe-git-allow: incremental-migration
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  });

  describe('checkAndRecover returns recovered:false when disabled', () => {
    it('returns recovered:false immediately', async () => {
      deps = createMockDeps();
      recovery = new SessionRecovery({ enabled: false, projectDir: tmpDir }, deps);

      const result = await recovery.checkAndRecover(1, 'test-session');

      expect(result.recovered).toBe(false);
      expect(result.failureType).toBeNull();
      expect(result.message).toBe('Recovery disabled');
    });
  });

  describe('checkAndRecover returns recovered:false when no JSONL found', () => {
    it('returns recovered:false with "No JSONL found"', async () => {
      deps = createMockDeps();
      recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

      const result = await recovery.checkAndRecover(1, 'test-session');

      expect(result.recovered).toBe(false);
      expect(result.failureType).toBeNull();
      expect(result.message).toBe('No JSONL found');
    });
  });

  describe('recoverFromStall kills and respawns', () => {
    it('kills session and respawns when stall is detected', async () => {
      deps = createMockDeps({ isSessionAlive: vi.fn(() => true) });
      recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

      // We need findJsonlForSession to return a path. Since getPanePid returns null,
      // findJsonlForSession always returns null. We must spy on the private method.
      // Instead, test by making the stall detector return a stall when called.
      // But findJsonlForSession needs to return non-null first.
      // The cleanest approach: mock the private method via prototype.
      const fakeJsonlPath = path.join(tmpDir, 'fake.jsonl');
      fs.writeFileSync(fakeJsonlPath, '');

      vi.spyOn(recovery as any, 'findJsonlForSession').mockReturnValue(fakeJsonlPath);

      vi.mocked(detectToolCallStall).mockReturnValue({
        jsonlPath: fakeJsonlPath,
        sessionUuid: 'uuid-1',
        stalledAt: new Date().toISOString(),
        stallDurationMs: 120000,
        lastToolName: 'Bash',
        lastToolInput: { command: 'npm test' },
        lastToolUseId: 'tool-1',
      });

      const events: string[] = [];
      recovery.on('recovery:stall', () => events.push('stall'));

      const result = await runWithTimers(() => recovery.checkAndRecover(1, 'test-session'));

      expect(result.recovered).toBe(true);
      expect(result.failureType).toBe('stall');
      expect(deps.killSession).toHaveBeenCalledWith('test-session');
      expect(deps.respawnSession).toHaveBeenCalledWith(1, 'test-session', expect.stringContaining('RECOVERY'));
      expect(events).toContain('stall');
    });
  });

  describe('recoverFromCrash truncates JSONL and respawns', () => {
    it('uses last_exchange strategy on attempt 1', async () => {
      deps = createMockDeps({ isSessionAlive: vi.fn(() => false) });
      recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

      const fakeJsonlPath = path.join(tmpDir, 'fake.jsonl');
      fs.writeFileSync(fakeJsonlPath, '');
      vi.spyOn(recovery as any, 'findJsonlForSession').mockReturnValue(fakeJsonlPath);

      vi.mocked(detectCrashedSession).mockReturnValue({
        type: 'crash',
        jsonlPath: fakeJsonlPath,
        sessionUuid: 'uuid-2',
        detectedAt: new Date().toISOString(),
        errorType: 'tool_use_incomplete',
        lastToolName: 'Bash',
      });

      const result = await runWithTimers(() => recovery.checkAndRecover(2, 'crash-session'));

      expect(result.recovered).toBe(true);
      expect(result.failureType).toBe('crash');
      expect(result.strategy).toBe('last_exchange');
      expect(result.attemptNumber).toBe(1);
      expect(truncateJsonlToSafePoint).toHaveBeenCalledWith(fakeJsonlPath, 'last_exchange', undefined);
      expect(deps.killSession).toHaveBeenCalledWith('crash-session');
      expect(deps.respawnSession).toHaveBeenCalled();
    });

    it('escalates to last_successful_tool on attempt 2', async () => {
      deps = createMockDeps({ isSessionAlive: vi.fn(() => false) });
      recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir, cooldownMs: 0 }, deps);

      const fakeJsonlPath = path.join(tmpDir, 'fake.jsonl');
      fs.writeFileSync(fakeJsonlPath, '');
      vi.spyOn(recovery as any, 'findJsonlForSession').mockReturnValue(fakeJsonlPath);

      vi.mocked(detectCrashedSession).mockReturnValue({
        type: 'crash',
        jsonlPath: fakeJsonlPath,
        sessionUuid: 'uuid-3',
        detectedAt: new Date().toISOString(),
        errorType: 'api',
      });

      // First attempt
      await runWithTimers(() => recovery.checkAndRecover(3, 'crash-session-2'));

      // Advance past cooldown
      vi.advanceTimersByTime(1);

      // Second attempt
      const result = await runWithTimers(() => recovery.checkAndRecover(3, 'crash-session-2'));

      expect(result.recovered).toBe(true);
      expect(result.strategy).toBe('last_successful_tool');
      expect(result.attemptNumber).toBe(2);
    });
  });

  describe('cooldown prevents rapid recovery', () => {
    it('returns recovered:false within cooldown period', async () => {
      deps = createMockDeps({ isSessionAlive: vi.fn(() => true) });
      recovery = new SessionRecovery({
        enabled: true,
        projectDir: tmpDir,
        cooldownMs: 60000,
      }, deps);

      const fakeJsonlPath = path.join(tmpDir, 'fake.jsonl');
      fs.writeFileSync(fakeJsonlPath, '');
      vi.spyOn(recovery as any, 'findJsonlForSession').mockReturnValue(fakeJsonlPath);

      vi.mocked(detectToolCallStall).mockReturnValue({
        jsonlPath: fakeJsonlPath,
        sessionUuid: 'uuid-cooldown',
        stalledAt: new Date().toISOString(),
        stallDurationMs: 120000,
        lastToolName: 'Bash',
        lastToolInput: {},
        lastToolUseId: 'tool-cd',
      });

      // First attempt succeeds
      const result1 = await runWithTimers(() => recovery.checkAndRecover(10, 'cooldown-session'));
      expect(result1.recovered).toBe(true);

      // Advance less than cooldown
      vi.advanceTimersByTime(30000);

      // Second attempt should be blocked by cooldown (returns early, no setTimeout)
      const result2 = await recovery.checkAndRecover(10, 'cooldown-session');
      expect(result2.recovered).toBe(false);
      expect(result2.message).toContain('cooldown');
    });
  });

  describe('maxAttempts prevents infinite loops', () => {
    it('stops recovery after maxAttempts is reached', async () => {
      deps = createMockDeps({ isSessionAlive: vi.fn(() => true) });
      recovery = new SessionRecovery({
        enabled: true,
        projectDir: tmpDir,
        maxAttempts: 2,
        cooldownMs: 0,
      }, deps);

      const fakeJsonlPath = path.join(tmpDir, 'fake.jsonl');
      fs.writeFileSync(fakeJsonlPath, '');
      vi.spyOn(recovery as any, 'findJsonlForSession').mockReturnValue(fakeJsonlPath);

      vi.mocked(detectToolCallStall).mockReturnValue({
        jsonlPath: fakeJsonlPath,
        sessionUuid: 'uuid-max',
        stalledAt: new Date().toISOString(),
        stallDurationMs: 120000,
        lastToolName: 'Read',
        lastToolInput: {},
        lastToolUseId: 'tool-max',
      });

      // Attempt 1 succeeds
      const r1 = await runWithTimers(() => recovery.checkAndRecover(20, 'max-session'));
      expect(r1.recovered).toBe(true);
      expect(r1.attemptNumber).toBe(1);

      // Advance past cooldown (0ms)
      vi.advanceTimersByTime(1);

      // Attempt 2 succeeds
      const r2 = await runWithTimers(() => recovery.checkAndRecover(20, 'max-session'));
      expect(r2.recovered).toBe(true);
      expect(r2.attemptNumber).toBe(2);

      // Advance past cooldown
      vi.advanceTimersByTime(1);

      // Attempt 3 should be blocked (returns early, no setTimeout)
      const r3 = await recovery.checkAndRecover(20, 'max-session');
      expect(r3.recovered).toBe(false);
      expect(r3.message).toContain('exhausted');
    });
  });

  describe('logEvent writes to JSONL', () => {
    it('writes recovery events to recovery-events.jsonl', async () => {
      deps = createMockDeps({ isSessionAlive: vi.fn(() => true) });
      recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

      const fakeJsonlPath = path.join(tmpDir, 'fake.jsonl');
      fs.writeFileSync(fakeJsonlPath, '');
      vi.spyOn(recovery as any, 'findJsonlForSession').mockReturnValue(fakeJsonlPath);

      vi.mocked(detectToolCallStall).mockReturnValue({
        jsonlPath: fakeJsonlPath,
        sessionUuid: 'uuid-log',
        stalledAt: new Date().toISOString(),
        stallDurationMs: 60000,
        lastToolName: 'Grep',
        lastToolInput: {},
        lastToolUseId: 'tool-log',
      });

      await runWithTimers(() => recovery.checkAndRecover(30, 'log-session'));

      const eventLogPath = path.join(tmpDir, '.instar', 'recovery-events.jsonl');
      expect(fs.existsSync(eventLogPath)).toBe(true);

      const content = fs.readFileSync(eventLogPath, 'utf-8').trim();
      const entry = JSON.parse(content);
      expect(entry.failureType).toBe('stall');
      expect(entry.recovered).toBe(true);
      expect(entry.topicId).toBe(30);
      expect(entry.sessionName).toBe('log-session');
    });
  });

  describe('getStats aggregates from event log', () => {
    it('counts events by type and success', async () => {
      deps = createMockDeps();
      recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

      // Write some events directly to the event log
      const eventLogPath = path.join(tmpDir, '.instar', 'recovery-events.jsonl');
      const now = new Date().toISOString();
      const events = [
        { timestamp: now, failureType: 'stall', recovered: true, topicId: 1, sessionName: 's1', attempt: 1 },
        { timestamp: now, failureType: 'stall', recovered: false, topicId: 2, sessionName: 's2', attempt: 1 },
        { timestamp: now, failureType: 'crash', recovered: true, topicId: 3, sessionName: 's3', attempt: 1 },
        { timestamp: now, failureType: 'error_loop', recovered: true, topicId: 4, sessionName: 's4', attempt: 1 },
        { timestamp: now, failureType: 'error_loop', recovered: true, topicId: 5, sessionName: 's5', attempt: 1 },
      ];
      fs.writeFileSync(eventLogPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

      const stats = recovery.getStats(0); // since epoch

      expect(stats.attempts.stall).toBe(2);
      expect(stats.successes.stall).toBe(1);
      expect(stats.attempts.crash).toBe(1);
      expect(stats.successes.crash).toBe(1);
      expect(stats.attempts.errorLoop).toBe(2);
      expect(stats.successes.errorLoop).toBe(2);
    });
  });
});
