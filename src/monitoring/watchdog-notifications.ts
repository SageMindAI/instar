/**
 * Decide whether and how to surface a watchdog intervention to the user.
 *
 * Principle: routine auto-recovery (Ctrl+C, SIGTERM) is internal diagnostics.
 * The user only hears about it when the gentle path fails and we had to
 * force-kill — that is the "actual issue" boundary. Messages that do go out
 * are in plain English, no jargon, no raw commands.
 */
import { EscalationLevel, type InterventionEvent } from './SessionWatchdog.js';

/**
 * Returns the user-facing message for an intervention, or `null` when the
 * intervention is routine and should not be surfaced to the user.
 */
export function formatWatchdogUserMessage(event: InterventionEvent): string | null {
  if (event.level === EscalationLevel.SigKill) {
    return "A task I was running got stuck and wouldn't stop on its own. I had to force it to close. I'm picking back up now.";
  }
  if (event.level === EscalationLevel.KillSession) {
    return "A session of mine got stuck and wouldn't respond. I had to close it and start a fresh one. I'll pick back up from where I was.";
  }
  // Monitoring, Ctrl+C, SIGTERM — routine, silent to the user.
  return null;
}
