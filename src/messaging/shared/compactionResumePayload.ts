/**
 * Compaction-resume payload builder.
 *
 * When a session's context window fills and Claude Code compresses the
 * conversation, the agent loses its working memory. The compaction-recovery
 * helpers in server.ts then inject a prompt telling the agent to re-orient
 * and continue — but the old prompt was a single sentence telling the agent
 * to "read the recent messages in this topic." In practice the agent
 * reconstructed a generic status summary instead of answering the actual
 * intent of the user's last message, because the context it needed was
 * never placed in front of it.
 *
 * This module builds a richer payload that matches the context the
 * session-spawn path already ships (summary + recent messages + a lookup
 * hint for searching deeper history). Ported into the compaction-resume
 * path, the agent has the same shape of context it had at first spawn —
 * no reason to fabricate a plausible-sounding status.
 *
 * Also handles the file-threshold pattern: payloads that exceed the tmux
 * bracketed-paste comfort zone get written to a temp file and replaced
 * with a "read this file" reference in the injection.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export const COMPACTION_RESUME_PREAMBLE =
  [
    'Your session just went through context compaction — your working memory was reset. The context below is what you had before the reset.',
    '',
    'How to respond:',
    '1. Your FIRST sentence must be a brief, calm statement that your session paused for context compaction and has now resumed. Do NOT say you "lost track," "got lost," "got confused," or "lost your place" — you did not. Compaction is a routine pause; narrate it as one.',
    '2. Then respond directly to the user\'s MOST RECENT message in the context below. If it was a question, answer it. If it was a directive or a decision the user handed back to you ("your call", "you decide", "proceed as you see fit"), make the decision and act on it — do NOT reconstruct a generic status summary, re-offer options the user already delegated, or hand the choice back to them.',
    '3. Assume full continuity. Any work-in-progress, open commitments, or next steps recorded in the context below are still yours to carry forward.',
  ].join('\n');

export interface HistoryEntryLike {
  text?: string;
  fromUser?: boolean;
  timestamp?: string;
  senderName?: string;
}

/**
 * Format a list of chronological messages as an inline block.
 * Used as a fallback when topicMemory isn't available (or for Slack,
 * where there's no SQLite-backed summarizer).
 */
export function formatInlineHistory(
  entries: HistoryEntryLike[],
  opts?: { label?: string; topicName?: string },
): string {
  if (entries.length === 0) return '';
  const label = opts?.label ?? 'THREAD HISTORY';
  const lines: string[] = [];
  lines.push(`--- ${label} (last ${entries.length} messages) ---`);
  if (opts?.topicName) lines.push(`Topic: ${opts.topicName}`);
  lines.push('');
  for (const m of entries) {
    const sender = m.fromUser ? (m.senderName || 'User') : 'Agent';
    const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
    const text = (m.text || '').slice(0, 2000);
    lines.push(`[${ts}] ${sender}: ${text}`);
  }
  lines.push('');
  lines.push(`--- END ${label} ---`);
  return lines.join('\n');
}

/**
 * Assemble the full compaction-resume payload: preamble + context block.
 */
export function buildCompactionResumePayload(contextBlock: string): string {
  const trimmed = contextBlock.trim();
  if (!trimmed) return COMPACTION_RESUME_PREAMBLE;
  return `${COMPACTION_RESUME_PREAMBLE}\n\n${trimmed}`;
}

/**
 * File-threshold: payloads over this get written to disk and replaced with
 * a file-reference stub. Matches the spawnSessionForTopic bootstrap pattern.
 * Bracketed paste in tmux handles larger content in principle, but keeping
 * the threshold small ensures parity with first-spawn behavior and avoids
 * edge cases where very large pastes are cut off mid-stream.
 */
export const COMPACTION_RESUME_FILE_THRESHOLD = 500;

/**
 * Produce the text that actually gets injected into the session. For small
 * payloads this is the payload itself; for large ones the payload is written
 * to /tmp and the returned text instructs the agent to read that file.
 */
export function prepareInjectionText(
  payload: string,
  triggerLabel: string,
  identifier: string | number,
  opts?: { tmpDir?: string; threshold?: number },
): string {
  const threshold = opts?.threshold ?? COMPACTION_RESUME_FILE_THRESHOLD;
  if (payload.length <= threshold) return payload;

  const tmpDir = opts?.tmpDir ?? path.join('/tmp', 'instar-compaction-resume');
  fs.mkdirSync(tmpDir, { recursive: true });
  const filename = `resume-${identifier}-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
  const filepath = path.join(tmpDir, filename);
  fs.writeFileSync(filepath, payload);
  console.log(
    `[CompactionResume] (${triggerLabel}) payload ${payload.length} chars > ${threshold}, wrote to ${filepath}`
  );

  return (
    `Your session just went through context compaction — your working memory was reset. ` +
    `Your prior context (summary, recent messages, and lookup hints) has been preserved at ${filepath}. ` +
    `Read that file IMMEDIATELY to re-orient, then respond to the user as follows:\n\n` +
    `1. Your FIRST sentence must be a brief, calm statement that your session paused for context compaction and has now resumed. Do NOT say you "lost track," "got lost," "got confused," or "lost your place" — you did not. Compaction is a routine pause; narrate it as one.\n` +
    `2. Then respond directly to the user's MOST RECENT message in the preserved context. If it was a question, answer it. If it was a directive or a decision the user handed back to you ("your call", "you decide", "proceed as you see fit"), make the decision and act on it — do NOT reconstruct a generic status summary, re-offer options the user already delegated, or hand the choice back to them.\n` +
    `3. Assume full continuity. Any work-in-progress, open commitments, or next steps recorded in the preserved context are still yours to carry forward.`
  );
}
