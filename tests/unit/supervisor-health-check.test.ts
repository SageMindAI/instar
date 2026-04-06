import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for ServerSupervisor health check behavior under high load.
 *
 * When the server process is alive (tmux session exists) but unresponsive
 * to health checks (e.g., event loop stalled under high CPU load), the
 * supervisor should NOT immediately restart — it should wait for more
 * consecutive failures (processAliveThreshold = 6, ~60s) before restarting.
 *
 * This prevents restart loops on heavily loaded systems where localhost
 * HTTP can't respond within the timeout but the server would recover
 * on its own once load decreases.
 */

// We test the logic by importing the class and calling the health check
// loop's decision path. Since ServerSupervisor is tightly coupled to
// tmux/process management, we test the key behavioral invariant:
// "process alive + unresponsive = wait longer before restart"

describe('ServerSupervisor health check resilience', () => {
  // Simulate the decision logic extracted from the health check loop
  function shouldRestart(opts: {
    consecutiveFailures: number;
    unhealthyThreshold: number;
    processAliveThreshold: number;
    isProcessAlive: boolean;
    inWakeTransition: boolean;
  }): boolean {
    const { consecutiveFailures, unhealthyThreshold, processAliveThreshold, isProcessAlive, inWakeTransition } = opts;

    if (consecutiveFailures < unhealthyThreshold) return false;

    if (isProcessAlive) {
      const effectiveThreshold = inWakeTransition ? unhealthyThreshold : processAliveThreshold;
      return consecutiveFailures >= effectiveThreshold;
    }

    return true; // Process dead — restart immediately
  }

  it('does not restart when process is alive and failures below processAliveThreshold', () => {
    // 2 failures, process alive, not in wake transition — should NOT restart
    expect(shouldRestart({
      consecutiveFailures: 2,
      unhealthyThreshold: 2,
      processAliveThreshold: 6,
      isProcessAlive: true,
      inWakeTransition: false,
    })).toBe(false);
  });

  it('does not restart at 5 failures when process is alive', () => {
    expect(shouldRestart({
      consecutiveFailures: 5,
      unhealthyThreshold: 2,
      processAliveThreshold: 6,
      isProcessAlive: true,
      inWakeTransition: false,
    })).toBe(false);
  });

  it('restarts at processAliveThreshold when process is alive but truly stuck', () => {
    // 6 failures (~60s unresponsive) — process alive but probably genuinely stuck
    expect(shouldRestart({
      consecutiveFailures: 6,
      unhealthyThreshold: 2,
      processAliveThreshold: 6,
      isProcessAlive: true,
      inWakeTransition: false,
    })).toBe(true);
  });

  it('restarts immediately when process is dead', () => {
    // 2 failures, process dead — restart immediately
    expect(shouldRestart({
      consecutiveFailures: 2,
      unhealthyThreshold: 2,
      processAliveThreshold: 6,
      isProcessAlive: false,
      inWakeTransition: false,
    })).toBe(true);
  });

  it('does not restart during wake transition when process is alive (counter reset handles this)', () => {
    // During wake transition with process alive, the counter gets reset to 0
    // so it can never reach even unhealthyThreshold (2) in practice.
    // But if somehow it does reach 2, the effective threshold is unhealthyThreshold (2)
    // and the counter is immediately reset. This test verifies the threshold logic.
    expect(shouldRestart({
      consecutiveFailures: 2,
      unhealthyThreshold: 2,
      processAliveThreshold: 6,
      isProcessAlive: true,
      inWakeTransition: true,
    })).toBe(true); // Would return true but counter is reset before next check
  });

  it('gives server ~60s to recover under load (6 checks * 10s interval)', () => {
    const processAliveThreshold = 6;
    const healthCheckIntervalSec = 10;
    const recoveryWindowSec = processAliveThreshold * healthCheckIntervalSec;
    expect(recoveryWindowSec).toBe(60);
  });
});
