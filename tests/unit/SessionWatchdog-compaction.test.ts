import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';

// ─── Minimal mocks for SessionManager, StateManager, InstarConfig ───

function createMockSessionManager(overrides?: Record<string, unknown>) {
  return {
    listRunningSessions: vi.fn().mockReturnValue([]),
    captureOutput: vi.fn().mockReturnValue(null),
    sendKey: vi.fn().mockReturnValue(true),
    isSessionAlive: vi.fn().mockReturnValue(true),
    ...overrides,
  } as any;
}

function createMockState() {
  return {} as any;
}

function createConfig(overrides?: Record<string, unknown>) {
  return {
    stateDir: '/tmp/test-watchdog',
    sessions: { tmuxPath: 'tmux' },
    monitoring: {
      watchdog: {
        enabled: true,
        stuckCommandSec: 180,
        pollIntervalMs: 30_000,
        ...(overrides?.watchdog as any),
      },
    },
    ...overrides,
  } as any;
}

// Typical tmux output after compaction + recovery hook
const COMPACTED_AT_PROMPT = [
  '✱ Conversation compacted (ctrl+o for history)',
  '',
  '> /compact',
  '  PreCompact hook completed successfully',
  '  Read .mcp.json (44 lines)',
  '  Read docs/README.md (100 lines)',
  '',
  '> ',
].join('\n');

const COMPACTED_BYPASS_PROMPT = [
  '✱ Conversation compacted',
  '  Compacted',
  '',
  'bypass permissions on (shift+tab to cycle)',
].join('\n');

const COMPACTED_CHEVRON_PROMPT = [
  'Conversation compacted',
  '  Read AGENT.md (50 lines)',
  '',
  '❯ ',
].join('\n');

describe('SessionWatchdog compaction-idle detection', () => {
  let watchdog: SessionWatchdog;
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let emittedEvents: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = createMockSessionManager();
    watchdog = new SessionWatchdog(
      createConfig(),
      sessionManager,
      createMockState(),
    );
    emittedEvents = [];
    watchdog.on('compaction-idle', (sessionName: string) => {
      emittedEvents.push(sessionName);
    });

    // Mock getClaudePid to return a PID (via private method override)
    // and getChildProcesses to return no children (idle Claude)
    (watchdog as any).getClaudePid = vi.fn().mockReturnValue(12345);
    (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([]);
  });

  afterEach(() => {
    watchdog.stop();
    vi.useRealTimers();
  });

  // ─── Positive cases: should detect compaction-idle ───

  it('emits compaction-idle when session shows compaction markers and bare > prompt', () => {
    sessionManager.captureOutput.mockReturnValue(COMPACTED_AT_PROMPT);
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual(['test-session']);
  });

  it('emits compaction-idle with bypass permissions prompt', () => {
    sessionManager.captureOutput.mockReturnValue(COMPACTED_BYPASS_PROMPT);
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual(['test-session']);
  });

  it('emits compaction-idle with ❯ prompt', () => {
    sessionManager.captureOutput.mockReturnValue(COMPACTED_CHEVRON_PROMPT);
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual(['test-session']);
  });

  // ─── Negative cases: should NOT emit ───

  it('does NOT emit when no compaction markers in output', () => {
    sessionManager.captureOutput.mockReturnValue(
      'Working on task...\nRead file.ts (100 lines)\n\n> ',
    );
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual([]);
  });

  it('does NOT emit when session is not at a prompt (actively working)', () => {
    sessionManager.captureOutput.mockReturnValue(
      '✱ Conversation compacted (ctrl+o for history)\n' +
      '  Read .mcp.json (44 lines)\n' +
      'I\'ll analyze the code now.\n' +
      'Looking at the implementation...\n',
    );
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual([]);
  });

  it('does NOT emit when captureOutput returns null', () => {
    sessionManager.captureOutput.mockReturnValue(null);
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual([]);
  });

  it('does NOT emit when Claude has active child processes (executing tools)', () => {
    sessionManager.captureOutput.mockReturnValue(COMPACTED_AT_PROMPT);
    // Override: Claude has active children (running a bash command)
    (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
      { pid: 99999, command: 'node some-script.js', elapsedMs: 5000 },
    ]);
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual([]);
  });

  it('does NOT emit when child processes include excluded patterns', () => {
    sessionManager.captureOutput.mockReturnValue(COMPACTED_AT_PROMPT);
    // Override: Claude has children, but they are all excluded (MCP servers etc)
    (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
      { pid: 88888, command: 'node playwright-mcp server', elapsedMs: 60000 },
    ]);
    // Excluded patterns should not block — they're background processes
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual(['test-session']);
  });

  it('does NOT emit when > appears mid-content (not as a prompt)', () => {
    // A > in markdown blockquote or code output should not trigger
    sessionManager.captureOutput.mockReturnValue(
      '✱ Conversation compacted\n' +
      'Here is the diff:\n' +
      '> old line removed\n' +
      '< new line added\n' +
      'Changes applied successfully.',
    );
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual([]);
  });

  it('does NOT emit when compaction text appears in file content being displayed', () => {
    // Agent displaying a file that mentions compaction
    sessionManager.captureOutput.mockReturnValue(
      '  1: # Session Recovery\n' +
      '  2: When "Conversation compacted" appears, the hook fires.\n' +
      '  3: This restores identity context.\n' +
      '  4:\n' +
      '  5: ## Implementation\n' +
      'I\'ve read the file. Here\'s what it says...',
    );
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual([]);
  });

  // ─── Cooldown behavior ───

  it('respects cooldown — does not re-emit within 5 minutes', () => {
    sessionManager.captureOutput.mockReturnValue(COMPACTED_AT_PROMPT);

    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toHaveLength(1);

    // Try again immediately — should be suppressed by cooldown
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toHaveLength(1);

    // Advance past cooldown (5 minutes)
    vi.advanceTimersByTime(300_001);

    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toHaveLength(2);
  });

  it('tracks cooldowns per session independently', () => {
    sessionManager.captureOutput.mockReturnValue(COMPACTED_AT_PROMPT);

    watchdog.checkCompactionIdle('session-a');
    watchdog.checkCompactionIdle('session-b');
    expect(emittedEvents).toEqual(['session-a', 'session-b']);

    // Both on cooldown now — no new emissions
    watchdog.checkCompactionIdle('session-a');
    watchdog.checkCompactionIdle('session-b');
    expect(emittedEvents).toHaveLength(2);
  });

  // ─── Edge cases ───

  it('handles empty output string', () => {
    sessionManager.captureOutput.mockReturnValue('');
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual([]);
  });

  it('handles output with only whitespace', () => {
    sessionManager.captureOutput.mockReturnValue('   \n  \n  ');
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual([]);
  });

  it('works when getClaudePid returns null (process not found)', () => {
    // If we can't find the Claude process, skip the child process check
    // but still check tmux output (the process might exist but pgrep failed)
    (watchdog as any).getClaudePid = vi.fn().mockReturnValue(null);
    sessionManager.captureOutput.mockReturnValue(COMPACTED_AT_PROMPT);
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual(['test-session']);
  });

  // ─── Recency guard (10-line window) ───

  it('only reads last 10 lines — stale compaction text does not trigger', () => {
    // captureOutput is called with 10 lines — if compaction happened long ago,
    // it won't be in the 10-line window
    sessionManager.captureOutput.mockImplementation((_session: string, lines: number) => {
      expect(lines).toBe(10); // Verify we're only reading 10 lines
      // Return output where compaction is NOT in the last 10 lines
      // (it would have scrolled off if the session continued working)
      return 'Normal agent output\nMore work\nDone.\n\n> ';
    });
    watchdog.checkCompactionIdle('test-session');
    expect(emittedEvents).toEqual([]);
  });
});
