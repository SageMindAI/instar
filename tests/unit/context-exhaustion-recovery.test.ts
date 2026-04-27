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
import { classifySessionDeath, detectContextExhaustion, matchPatterns } from '../../src/monitoring/QuotaExhaustionDetector.js';

/**
 * Context Exhaustion Recovery tests.
 *
 * Validates that the system detects "conversation too long" errors
 * (which masquerade as quota errors) and recovers by killing the
 * session and respawning fresh with telegram history context.
 */

function createMockDeps(overrides: Partial<SessionRecoveryDeps> = {}): SessionRecoveryDeps {
  return {
    isSessionAlive: vi.fn(() => true),
    killSession: vi.fn(),
    respawnSession: vi.fn(async () => {}),
    getPanePid: vi.fn(() => null),
    ...overrides,
  };
}

let tmpDir: string;

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-exhaustion-test-'));
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  return dir;
}

async function runWithTimers<T>(fn: () => Promise<T>): Promise<T> {
  const promise = fn();
  // Advance past the 7s grace window used by context-exhaustion recovery's
  // in-flight reply capture plus the 3s legacy fallback sleep.
  await vi.advanceTimersByTimeAsync(10000);
  return promise;
}

// ============================================================================
// QuotaExhaustionDetector — pattern detection
// ============================================================================

describe('QuotaExhaustionDetector — context exhaustion patterns', () => {
  it('detects "conversation too long" in tmux output', () => {
    const result = detectContextExhaustion(
      'Error during compaction: Error: Conversation too long. Press esc twice to go up a few messages and try again.'
    );
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('detects "conversation is too long"', () => {
    const result = detectContextExhaustion(
      'conversation is too long'
    );
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('detects "error during compaction.*too long"', () => {
    const result = detectContextExhaustion(
      'Error during compaction: Error: Conversation too long'
    );
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('detects "press esc twice to go up a few messages"', () => {
    const result = detectContextExhaustion(
      'Press esc twice to go up a few messages and try again.'
    );
    expect(result.matched).toBe(true);
    // This pattern alone is medium confidence (not a strong signal by itself)
    expect(result.confidence).toBe('medium');
  });

  it('detects context limit patterns', () => {
    const result = detectContextExhaustion('context limit exceeded');
    expect(result.matched).toBe(true);
  });

  it('returns false for normal output', () => {
    const result = detectContextExhaustion('Session ended. Goodbye!');
    expect(result.matched).toBe(false);
  });

  it('returns false for empty output', () => {
    const result = detectContextExhaustion('');
    expect(result.matched).toBe(false);
  });

  it('returns false for quota-related output', () => {
    const result = detectContextExhaustion('rate_limit_error: too many requests');
    expect(result.matched).toBe(false);
  });
});

describe('classifySessionDeath — context exhaustion vs quota', () => {
  it('classifies "conversation too long" as context_exhausted, not quota', () => {
    const result = classifySessionDeath(
      'Error during compaction: Error: Conversation too long. Press esc twice to go up a few messages and try again.\n' +
      "You're out of extra usage - resets 10pm (America/Los_Angeles)"
    );
    // Even though quota patterns might also be present, context_exhausted
    // should not be confused with quota_exhaustion
    // Note: "out of extra usage" doesn't match quota patterns, so context wins
    expect(result.cause).toBe('context_exhausted');
    expect(result.confidence).toBe('high');
  });

  it('classifies pure quota output as quota_exhaustion', () => {
    const result = classifySessionDeath(
      'overloaded_error: rate limit exceeded'
    );
    expect(result.cause).toBe('quota_exhaustion');
  });

  it('classifies pure context output with high confidence', () => {
    const result = classifySessionDeath(
      'Error during compaction: Error: Conversation too long'
    );
    expect(result.cause).toBe('context_exhausted');
    expect(result.confidence).toBe('high');
  });
});

// ============================================================================
// SessionRecovery — context exhaustion recovery
// ============================================================================

describe('SessionRecovery — context exhaustion', () => {
  let recovery: SessionRecovery;
  let deps: SessionRecoveryDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      // safe-git-allow: incremental-migration
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  });

  it('detects context exhaustion from tmux output and recovers', async () => {
    const captureSessionOutput = vi.fn(() =>
      'Error during compaction: Error: Conversation too long. Press esc twice to go up a few messages and try again.'
    );
    const respawnSessionFresh = vi.fn(async () => {});

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      captureSessionOutput,
      respawnSessionFresh,
    });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

    const events: any[] = [];
    recovery.on('recovery:context_exhaustion', (data) => events.push(data));

    const result = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));

    expect(result.recovered).toBe(true);
    expect(result.failureType).toBe('context_exhaustion');
    expect(result.message).toContain('context exhaustion');
    expect(result.message).toContain('fresh session spawned');
    expect(deps.killSession).toHaveBeenCalledWith('stuck-session');
    expect(respawnSessionFresh).toHaveBeenCalledWith(
      1,
      'stuck-session',
      expect.stringContaining('context window limit'),
    );
    expect(events).toHaveLength(1);
    expect(events[0].topicId).toBe(1);
  });

  it('falls back to normal respawnSession when respawnSessionFresh is not provided', async () => {
    const captureSessionOutput = vi.fn(() => 'conversation too long');

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      captureSessionOutput,
      // No respawnSessionFresh — should use respawnSession
    });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

    const result = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));

    expect(result.recovered).toBe(true);
    expect(result.failureType).toBe('context_exhaustion');
    expect(deps.respawnSession).toHaveBeenCalled();
  });

  it('does not detect context exhaustion for dead sessions', async () => {
    const captureSessionOutput = vi.fn(() => 'conversation too long');

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => false), // Session is dead
      captureSessionOutput,
    });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

    const result = await recovery.checkAndRecover(1, 'dead-session');

    // Context exhaustion detection only runs for alive sessions
    expect(result.failureType).not.toBe('context_exhaustion');
  });

  it('does not detect context exhaustion without captureSessionOutput dep', async () => {
    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      // No captureSessionOutput
    });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

    const result = await recovery.checkAndRecover(1, 'stuck-session');

    // Should fall through to no-JSONL path
    expect(result.failureType).not.toBe('context_exhaustion');
    expect(result.message).toBe('No JSONL found');
  });

  it('respects cooldown between context exhaustion recovery attempts', async () => {
    const captureSessionOutput = vi.fn(() => 'conversation too long');
    const respawnSessionFresh = vi.fn(async () => {});

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      captureSessionOutput,
      respawnSessionFresh,
    });
    // 15-minute cooldown
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir, cooldownMs: 15 * 60 * 1000 }, deps);

    // First attempt should succeed
    const result1 = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));
    expect(result1.recovered).toBe(true);

    // Second attempt should be blocked by cooldown
    const result2 = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));
    expect(result2.recovered).toBe(false);
    expect(result2.message).toContain('cooldown');
  });

  it('respects maxAttempts for context exhaustion recovery', async () => {
    const captureSessionOutput = vi.fn(() => 'conversation too long');
    const respawnSessionFresh = vi.fn(async () => {});

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      captureSessionOutput,
      respawnSessionFresh,
    });
    // No cooldown, max 2 attempts
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir, cooldownMs: 0, maxAttempts: 2 }, deps);

    const result1 = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));
    expect(result1.recovered).toBe(true);
    expect(result1.attemptNumber).toBe(1);

    const result2 = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));
    expect(result2.recovered).toBe(true);
    expect(result2.attemptNumber).toBe(2);

    // Third attempt should be blocked
    const result3 = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));
    expect(result3.recovered).toBe(false);
    expect(result3.failureType).toBe('context_exhaustion');
  });

  it('runs context exhaustion check before JSONL-based checks', async () => {
    // When both context exhaustion AND stall are present, context exhaustion wins
    // because it runs first and the session should be respawned fresh, not resumed
    const captureSessionOutput = vi.fn(() => 'conversation too long');
    const respawnSessionFresh = vi.fn(async () => {});

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      captureSessionOutput,
      respawnSessionFresh,
    });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

    const result = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));

    // Context exhaustion should win even if stall detector would also fire
    expect(result.failureType).toBe('context_exhaustion');
    expect(respawnSessionFresh).toHaveBeenCalled();
  });

  it('logs context exhaustion recovery events', async () => {
    const captureSessionOutput = vi.fn(() => 'conversation too long');

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      captureSessionOutput,
    });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

    await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));

    // Check event log
    const eventLogPath = path.join(tmpDir, '.instar', 'recovery-events.jsonl');
    expect(fs.existsSync(eventLogPath)).toBe(true);

    const entries = fs.readFileSync(eventLogPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].failureType).toBe('context_exhaustion');
    expect(entries[0].recovered).toBe(true);
    expect(entries[0].topicId).toBe(1);
  });

  it('getStats includes context exhaustion counts', async () => {
    const captureSessionOutput = vi.fn(() => 'conversation too long');

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      captureSessionOutput,
    });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir, cooldownMs: 0 }, deps);

    await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));

    const stats = recovery.getStats(0);
    expect(stats.attempts.contextExhaustion).toBe(1);
    expect(stats.successes.contextExhaustion).toBe(1);
  });

  // ==========================================================================
  // In-flight reply capture — prevents the fresh session from duplicating
  // a reply that the dying session had already sent but hadn't yet committed
  // to topic history at respawn time.
  //
  // Reproduction of the 2026-04-15 bug where new me re-answered an "older
  // path" question because the snapshot taken at T+3s didn't include the old
  // me's reply that landed at T+5s.
  // ==========================================================================

  it('captures an in-flight reply that lands during the grace window and puts it in the recovery prompt', async () => {
    const captureSessionOutput = vi.fn(() => 'conversation too long');
    const respawnSessionFresh = vi.fn(async () => {});

    // Simulate the dying session's reply landing in topic history at T+4s
    // (after kill, during grace window, before respawn).
    const detectedAt = Date.now();
    let callCount = 0;
    const getRecentTopicMessages = vi.fn((_topicId: number, _limit: number) => {
      callCount++;
      // First 3 polls return only user messages (reply hasn't committed yet)
      // After that, the in-flight reply appears
      if (callCount < 3) {
        return [
          { text: 'user asked a question', fromUser: true, timestamp: detectedAt - 1000 },
        ];
      }
      return [
        { text: 'user asked a question', fromUser: true, timestamp: detectedAt - 1000 },
        {
          text: 'in-flight agent reply that was mid-generation when context exhausted',
          fromUser: false,
          timestamp: detectedAt + 4000,
        },
      ];
    });

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      captureSessionOutput,
      respawnSessionFresh,
      getRecentTopicMessages,
    });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

    const result = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));

    expect(result.recovered).toBe(true);
    expect(result.message).toContain('in-flight reply captured');

    // The recovery prompt passed to respawn must contain the captured reply
    expect(respawnSessionFresh).toHaveBeenCalled();
    const promptArg = (respawnSessionFresh.mock.calls[0] as any[])[2] as string;
    expect(promptArg).toContain('in-flight agent reply that was mid-generation');
    expect(promptArg).toContain('ALREADY SENT');
    expect(promptArg).toContain('do NOT repeat');
  });

  it('recovers normally when no in-flight reply lands during grace window', async () => {
    const captureSessionOutput = vi.fn(() => 'conversation too long');
    const respawnSessionFresh = vi.fn(async () => {});

    // getRecentTopicMessages always returns only an old user message — no new agent reply
    const detectedAt = Date.now();
    const getRecentTopicMessages = vi.fn(() => [
      { text: 'user question', fromUser: true, timestamp: detectedAt - 2000 },
    ]);

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      captureSessionOutput,
      respawnSessionFresh,
      getRecentTopicMessages,
    });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

    const result = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));

    expect(result.recovered).toBe(true);
    expect(result.message).not.toContain('in-flight reply captured');

    const promptArg = (respawnSessionFresh.mock.calls[0] as any[])[2] as string;
    expect(promptArg).not.toContain('ALREADY SENT');
    expect(promptArg).toContain('context window limit');
  });

  it('ignores agent messages older than the detection timestamp (pre-existing replies)', async () => {
    // Regression guard: we must only capture replies that land AFTER the
    // exhaustion was detected. A reply the user sees in history from 10
    // seconds before the failure is not "in-flight."
    const captureSessionOutput = vi.fn(() => 'conversation too long');
    const respawnSessionFresh = vi.fn(async () => {});

    const detectedAt = Date.now();
    const getRecentTopicMessages = vi.fn(() => [
      { text: 'old agent reply from before the failure', fromUser: false, timestamp: detectedAt - 10000 },
    ]);

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      captureSessionOutput,
      respawnSessionFresh,
      getRecentTopicMessages,
    });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

    const result = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));

    expect(result.recovered).toBe(true);
    expect(result.message).not.toContain('in-flight reply captured');

    const promptArg = (respawnSessionFresh.mock.calls[0] as any[])[2] as string;
    expect(promptArg).not.toContain('old agent reply');
  });

  it('falls back to a 3s static delay when getRecentTopicMessages is not wired', async () => {
    // Preserves prior behavior when the dep is absent (e.g., pre-wire servers).
    const captureSessionOutput = vi.fn(() => 'conversation too long');
    const respawnSessionFresh = vi.fn(async () => {});

    deps = createMockDeps({
      isSessionAlive: vi.fn(() => true),
      captureSessionOutput,
      respawnSessionFresh,
      // getRecentTopicMessages intentionally omitted
    });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

    const result = await runWithTimers(() => recovery.checkAndRecover(1, 'stuck-session'));

    expect(result.recovered).toBe(true);
    // Without the dep, it still works — just no in-flight capture
    expect(result.message).not.toContain('in-flight reply captured');
  });
});

// ============================================================================
// matchPatterns — exported utility
// ============================================================================

describe('matchPatterns', () => {
  it('matches regex patterns', () => {
    expect(matchPatterns('context limit exceeded', ['context.*limit'])).toBe('context.*limit');
  });

  it('returns null when no patterns match', () => {
    expect(matchPatterns('hello world', ['context.*limit', 'conversation too long'])).toBeNull();
  });

  it('falls back to string matching for invalid regex', () => {
    // A pattern with unbalanced brackets would fail as regex
    expect(matchPatterns('test [broken', ['[broken'])).toBe('[broken');
  });
});
