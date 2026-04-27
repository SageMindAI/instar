// Unit tests for the compaction-resume payload builder.
//
// Regression anchor: screenshot on topic 6795 (2026-04-17). After the
// mechanical re-inject fix (0.28.51) the recovery path fires correctly —
// but the injected prompt was a single sentence telling the agent to
// "read recent messages in this topic." With no actual context in front
// of it, the recovered agent reconstructs a generic status summary
// ("Re-oriented: v2 shipped. Awaiting your cadence call — flip, defer,
// or park. No autonomous next step until you decide.") instead of
// answering the user's actual last message ("you really need to hand
// hold me through whatever I need to do here"). These tests pin down
// the payload shape so that regression stays gone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  COMPACTION_RESUME_PREAMBLE,
  COMPACTION_RESUME_FILE_THRESHOLD,
  buildCompactionResumePayload,
  formatInlineHistory,
  prepareInjectionText,
  type HistoryEntryLike,
} from '../../src/messaging/shared/compactionResumePayload.js';

describe('buildCompactionResumePayload', () => {
  it('emits preamble-only when the context block is empty', () => {
    expect(buildCompactionResumePayload('')).toBe(COMPACTION_RESUME_PREAMBLE);
    expect(buildCompactionResumePayload('   \n\n  ')).toBe(COMPACTION_RESUME_PREAMBLE);
  });

  it('concatenates preamble + trimmed context with a blank-line separator', () => {
    const block = '--- TOPIC CONTEXT ---\nhello\n--- END ---';
    const payload = buildCompactionResumePayload(block);
    expect(payload).toBe(`${COMPACTION_RESUME_PREAMBLE}\n\n${block}`);
  });

  it('tells the agent compaction occurred', () => {
    expect(COMPACTION_RESUME_PREAMBLE).toMatch(/compaction/i);
  });

  // Regression: screenshots on topic 6795 (2026-04-20) showed two failure
  // modes on the 0.28.52 preamble. Pin them down so they can't come back.
  describe('preamble guardrails', () => {
    it('prescribes calm acknowledgment phrasing (not open-ended "let the user know")', () => {
      // The open-ended phrasing produced alarming self-narration like
      // "I lost track of what we were working on" on active sessions.
      expect(COMPACTION_RESUME_PREAMBLE).toMatch(/paused for context compaction/i);
      expect(COMPACTION_RESUME_PREAMBLE).toMatch(/resumed/i);
    });

    it('explicitly forbids "lost track" / "got lost" / "got confused" self-narration', () => {
      expect(COMPACTION_RESUME_PREAMBLE).toMatch(/lost track/i);
      expect(COMPACTION_RESUME_PREAMBLE).toMatch(/got lost/i);
      expect(COMPACTION_RESUME_PREAMBLE).toMatch(/got confused/i);
      // Verify they appear as prohibitions, not descriptions.
      expect(COMPACTION_RESUME_PREAMBLE).toMatch(/do not|don't/i);
    });

    it('directs the agent to respond to the user\'s most recent message', () => {
      // Without this, the recovered agent defaults to status-summary reflex.
      // Topic 6795 / Bob thread showed the user say "Your call" and the agent
      // re-offer the same two choices and hand "Your call" back — ping-pong.
      expect(COMPACTION_RESUME_PREAMBLE).toMatch(/most recent message/i);
      expect(COMPACTION_RESUME_PREAMBLE).toMatch(/your call|you decide|delegated/i);
      // Must explicitly forbid the status-summary + re-offer reflex.
      expect(COMPACTION_RESUME_PREAMBLE).toMatch(/status summary/i);
      expect(COMPACTION_RESUME_PREAMBLE).toMatch(/re-offer|re offer/i);
    });

    it('instructs the agent to assume continuity (not treat recovery as a fresh start)', () => {
      expect(COMPACTION_RESUME_PREAMBLE).toMatch(/continuity|carry forward|work-in-progress/i);
    });

    it('places the calm-acknowledgment instruction BEFORE the respond-to-last-message instruction', () => {
      // Order matters: the first sentence the agent emits must be the calm
      // compaction acknowledgment. If the "respond to most recent message"
      // instruction came first, the agent could skip the acknowledgment
      // entirely. Topic 6795 Mew screenshot is exactly this failure.
      const ackIdx = COMPACTION_RESUME_PREAMBLE.search(/paused for context compaction/i);
      const respondIdx = COMPACTION_RESUME_PREAMBLE.search(/most recent message/i);
      expect(ackIdx).toBeGreaterThanOrEqual(0);
      expect(respondIdx).toBeGreaterThan(ackIdx);
    });
  });
});

describe('formatInlineHistory', () => {
  it('returns empty string for an empty list', () => {
    expect(formatInlineHistory([])).toBe('');
  });

  it('renders sender, timestamp, and text for each entry in chronological order', () => {
    const entries: HistoryEntryLike[] = [
      { text: 'hi', fromUser: true, timestamp: '2026-04-17T16:00:00Z', senderName: 'Justin' },
      { text: 'hello', fromUser: false, timestamp: '2026-04-17T16:00:30Z' },
    ];
    const out = formatInlineHistory(entries, { topicName: 'demo', label: 'THREAD' });
    expect(out).toContain('--- THREAD (last 2 messages) ---');
    expect(out).toContain('Topic: demo');
    expect(out).toContain('[16:00:00] Justin: hi');
    expect(out).toContain('[16:00:30] Agent: hello');
    expect(out).toContain('--- END THREAD ---');
  });

  it('falls back to generic "User" when senderName missing', () => {
    const out = formatInlineHistory([{ text: 'hey', fromUser: true, timestamp: '2026-04-17T16:00:00Z' }]);
    expect(out).toContain('[16:00:00] User: hey');
  });

  it('truncates very long message bodies to 2000 chars', () => {
    const longText = 'x'.repeat(5000);
    const out = formatInlineHistory([{ text: longText, fromUser: true, timestamp: '2026-04-17T16:00:00Z' }]);
    expect(out).toContain('x'.repeat(2000));
    expect(out).not.toContain('x'.repeat(2001));
  });

  it('handles missing timestamp gracefully', () => {
    const out = formatInlineHistory([{ text: 'hey', fromUser: true }]);
    expect(out).toContain('[??:??] User: hey');
  });
});

describe('prepareInjectionText', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-resume-test-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('returns the payload verbatim when under the threshold', () => {
    const payload = 'short payload';
    const out = prepareInjectionText(payload, 'test', 42, { tmpDir });
    expect(out).toBe(payload);
  });

  it('writes to file and returns a read-this-file stub when over threshold', () => {
    const payload = 'x'.repeat(COMPACTION_RESUME_FILE_THRESHOLD + 100);
    const out = prepareInjectionText(payload, 'test', 42, { tmpDir });
    expect(out).not.toBe(payload);
    expect(out).toMatch(/compaction/i);
    expect(out).toMatch(/read that file/i);
    // The returned stub should contain a real path under our tmpDir.
    const match = out.match(new RegExp(`${tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/resume-[^ ]+\\.txt`));
    expect(match).toBeTruthy();
    const filepath = match![0];
    expect(fs.existsSync(filepath)).toBe(true);
    expect(fs.readFileSync(filepath, 'utf-8')).toBe(payload);
  });

  it('file-reference stub carries the same tone + intent guardrails as the inline preamble', () => {
    // The two branches (under threshold vs over) must give the agent the
    // same instructions — otherwise long-context recoveries fail in ways
    // short-context ones don't. Regression anchor: topic 6795 screenshots.
    const payload = 'x'.repeat(COMPACTION_RESUME_FILE_THRESHOLD + 100);
    const out = prepareInjectionText(payload, 'test', 42, { tmpDir });
    // Prescribed acknowledgment
    expect(out).toMatch(/paused for context compaction/i);
    // Forbids the alarming self-narration
    expect(out).toMatch(/lost track/i);
    expect(out).toMatch(/got lost/i);
    // Directs answering the user's most recent message
    expect(out).toMatch(/most recent message/i);
    expect(out).toMatch(/your call|you decide|delegated/i);
    // Forbids status-summary + re-offer reflex
    expect(out).toMatch(/status summary/i);
  });

  it('respects a custom threshold', () => {
    const payload = 'x'.repeat(20);
    const out = prepareInjectionText(payload, 'test', 42, { tmpDir, threshold: 10 });
    expect(out).not.toBe(payload);
    expect(out).toMatch(/resume-/);
  });
});

describe('integration — topic 6795 shape', () => {
  it('produces a payload that contains the last user message verbatim when context comes from inline history', () => {
    // Simulates the Slack-path / fallback scenario: no topicMemory, build
    // the context from raw log entries. We specifically want the user's
    // last message ("you really need to hand hold me") to be present in
    // the payload so the agent can't ignore it.
    const history: HistoryEntryLike[] = [
      { text: 'earlier work summary', fromUser: false, timestamp: '2026-04-17T16:00:00Z' },
      { text: 'Okay, you really need to hand hold me through whatever I need to do here', fromUser: true, timestamp: '2026-04-17T16:24:00Z', senderName: 'Justin' },
    ];
    const contextBlock = formatInlineHistory(history, { label: 'TOPIC CONTEXT' });
    const payload = buildCompactionResumePayload(contextBlock);
    expect(payload).toContain(COMPACTION_RESUME_PREAMBLE);
    expect(payload).toContain('Okay, you really need to hand hold me through whatever I need to do here');
    expect(payload).toContain('[16:24:00] Justin:');
  });
});
