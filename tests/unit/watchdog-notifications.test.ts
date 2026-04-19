/**
 * Tests for user-facing watchdog notifications.
 *
 * Principle: routine auto-recovery (Ctrl+C, SIGTERM) is internal diagnostics.
 * The user only hears about it when gentle recovery fails and we had to
 * force-kill. Messages that do go out are plain English — no "SIGKILL",
 * "escalation level", raw command paths, or "watchdog" jargon.
 */
import { describe, it, expect } from 'vitest';
import { formatWatchdogUserMessage } from '../../src/monitoring/watchdog-notifications.js';
import { EscalationLevel } from '../../src/monitoring/SessionWatchdog.js';

function event(level: EscalationLevel) {
  return {
    sessionName: 'test-session',
    level,
    action: 'raw action',
    stuckCommand: '/opt/homebrew/bin/uv tool uvx workspace-mcp --tool-tier complete',
    stuckPid: 1234,
    timestamp: Date.now(),
  };
}

describe('formatWatchdogUserMessage', () => {
  it('returns null for Monitoring level (no-op)', () => {
    expect(formatWatchdogUserMessage(event(EscalationLevel.Monitoring))).toBeNull();
  });

  it('returns null for Ctrl+C level (routine, silent to user)', () => {
    expect(formatWatchdogUserMessage(event(EscalationLevel.CtrlC))).toBeNull();
  });

  it('returns null for SIGTERM level (routine, silent to user)', () => {
    expect(formatWatchdogUserMessage(event(EscalationLevel.SigTerm))).toBeNull();
  });

  it('returns a plain-English message for SIGKILL level', () => {
    const msg = formatWatchdogUserMessage(event(EscalationLevel.SigKill));
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/stuck/i);
    expect(msg).toMatch(/force/i);
  });

  it('returns a plain-English message for KillSession level', () => {
    const msg = formatWatchdogUserMessage(event(EscalationLevel.KillSession));
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/stuck/i);
    expect(msg).toMatch(/fresh|new/i);
  });

  it('SIGKILL message contains no jargon', () => {
    const msg = formatWatchdogUserMessage(event(EscalationLevel.SigKill))!;
    expect(msg).not.toMatch(/SIGKILL|SIGTERM|Ctrl\+C|escalation|watchdog/i);
    // No raw command path
    expect(msg).not.toContain('workspace-mcp');
    expect(msg).not.toContain('/opt/homebrew');
    expect(msg).not.toContain('uvx');
  });

  it('KillSession message contains no jargon', () => {
    const msg = formatWatchdogUserMessage(event(EscalationLevel.KillSession))!;
    expect(msg).not.toMatch(/SIGKILL|SIGTERM|Ctrl\+C|escalation|watchdog/i);
    expect(msg).not.toContain('workspace-mcp');
    expect(msg).not.toContain('/opt/homebrew');
  });
});
