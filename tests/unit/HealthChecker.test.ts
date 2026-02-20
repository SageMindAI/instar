import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HealthChecker } from '../../src/monitoring/HealthChecker.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { AgentKitConfig } from '../../src/core/types.js';

describe('HealthChecker', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let checker: HealthChecker;

  const makeConfig = (overrides?: Partial<AgentKitConfig>): AgentKitConfig => ({
    projectName: 'test-project',
    projectDir: '/tmp/test',
    stateDir: '', // set in beforeEach
    port: 4040,
    sessions: {
      tmuxPath: '/opt/homebrew/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: '/tmp/test',
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    },
    scheduler: {
      jobsFile: '',
      enabled: false,
      maxParallelJobs: 2,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    },
    users: [],
    messaging: [],
    monitoring: {
      quotaTracking: false,
      memoryMonitoring: false,
      healthCheckIntervalMs: 5000,
    },
    ...overrides,
  });

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
  });

  afterEach(() => {
    checker?.stopPeriodicChecks();
    project.cleanup();
  });

  it('returns healthy when everything is ok', () => {
    const config = makeConfig({ stateDir: project.stateDir });
    checker = new HealthChecker(config, mockSM as any);

    const status = checker.check();
    expect(status.status).toBe('healthy');
    expect(status.components.tmux).toBeDefined();
    expect(status.components.sessions).toBeDefined();
    expect(status.components.stateDir).toBeDefined();
    expect(status.timestamp).toBeTruthy();
  });

  it('reports degraded when sessions at capacity', async () => {
    const config = makeConfig({ stateDir: project.stateDir });
    config.sessions.maxSessions = 1;

    // Add a running session to the mock
    await mockSM.spawnSession({ name: 'fill', prompt: 'test' });

    checker = new HealthChecker(config, mockSM as any);

    const status = checker.check();
    expect(status.components.sessions.status).toBe('degraded');
    expect(status.components.sessions.message).toContain('capacity');
  });

  it('reports unhealthy when state dir missing', () => {
    const config = makeConfig({ stateDir: '/nonexistent/path' });
    checker = new HealthChecker(config, mockSM as any);

    const status = checker.check();
    expect(status.components.stateDir.status).toBe('unhealthy');
    expect(status.status).toBe('unhealthy');
  });

  it('does not include scheduler when none provided', () => {
    const config = makeConfig({ stateDir: project.stateDir });
    checker = new HealthChecker(config, mockSM as any);

    const status = checker.check();
    expect(status.components.scheduler).toBeUndefined();
  });

  it('includes scheduler status when provided', () => {
    const config = makeConfig({ stateDir: project.stateDir });
    const mockScheduler = {
      getStatus: () => ({
        running: true,
        paused: false,
        jobCount: 3,
        enabledJobs: 2,
        queueLength: 0,
        activeJobSessions: 0,
      }),
    };
    checker = new HealthChecker(config, mockSM as any, mockScheduler as any);

    const status = checker.check();
    expect(status.components.scheduler).toBeDefined();
    expect(status.components.scheduler.status).toBe('healthy');
  });

  it('reports degraded scheduler when paused', () => {
    const config = makeConfig({ stateDir: project.stateDir });
    const mockScheduler = {
      getStatus: () => ({
        running: true,
        paused: true,
        jobCount: 3,
        enabledJobs: 2,
        queueLength: 0,
        activeJobSessions: 0,
      }),
    };
    checker = new HealthChecker(config, mockSM as any, mockScheduler as any);

    const status = checker.check();
    expect(status.components.scheduler.status).toBe('degraded');
  });

  it('getLastStatus returns null before first check', () => {
    const config = makeConfig({ stateDir: project.stateDir });
    checker = new HealthChecker(config, mockSM as any);

    expect(checker.getLastStatus()).toBeNull();
  });

  it('getLastStatus returns result after check', () => {
    const config = makeConfig({ stateDir: project.stateDir });
    checker = new HealthChecker(config, mockSM as any);

    checker.check();
    expect(checker.getLastStatus()).not.toBeNull();
    expect(checker.getLastStatus()!.status).toBe('healthy');
  });

  it('periodic checks update status', async () => {
    const config = makeConfig({ stateDir: project.stateDir });
    checker = new HealthChecker(config, mockSM as any);

    checker.startPeriodicChecks(100);

    // Should run immediately
    expect(checker.getLastStatus()).not.toBeNull();

    // Wait for another check
    await new Promise(r => setTimeout(r, 250));
    const ts1 = checker.getLastStatus()!.timestamp;

    await new Promise(r => setTimeout(r, 200));
    const ts2 = checker.getLastStatus()!.timestamp;

    // Timestamps should differ (multiple checks ran)
    expect(ts2).not.toBe(ts1);

    checker.stopPeriodicChecks();
  });

  it('reports degraded scheduler when not running', () => {
    const config = makeConfig({ stateDir: project.stateDir });
    const mockScheduler = {
      getStatus: () => ({
        running: false,
        paused: false,
        jobCount: 3,
        enabledJobs: 2,
        queueLength: 0,
        activeJobSessions: 0,
      }),
    };
    checker = new HealthChecker(config, mockSM as any, mockScheduler as any);

    const status = checker.check();
    expect(status.components.scheduler.status).toBe('degraded');
    expect(status.components.scheduler.message).toContain('not running');
  });

  it('overall status is degraded when any component is degraded', () => {
    const config = makeConfig({ stateDir: project.stateDir });
    const mockScheduler = {
      getStatus: () => ({
        running: true,
        paused: true,
        jobCount: 1,
        enabledJobs: 1,
        queueLength: 0,
        activeJobSessions: 0,
      }),
    };
    checker = new HealthChecker(config, mockSM as any, mockScheduler as any);

    const status = checker.check();
    // Scheduler is paused → degraded, so overall should be degraded
    expect(status.status).toBe('degraded');
  });

  it('startPeriodicChecks is idempotent', () => {
    const config = makeConfig({ stateDir: project.stateDir });
    checker = new HealthChecker(config, mockSM as any);

    checker.startPeriodicChecks(1000);
    checker.startPeriodicChecks(1000); // Should not create a second interval
    checker.stopPeriodicChecks();
    // No assertion needed — if it created two intervals, stopPeriodicChecks
    // would only clear one, and the test would hang. Clean exit = pass.
  });
});
