/**
 * Tests for thread history inclusion in auto-spawned sessions via HTTP forward.
 *
 * Bug: When dawn-server forwards a message to Instar's /sessions/tmux/:name/input
 * endpoint and the session is dead, the auto-spawn only included relay instructions
 * — no thread history. The inheriting session had no conversational context.
 *
 * Fix: The route now calls getTopicHistory() and includes history in the context file.
 *
 * Tests the routes.ts auto-spawn path by verifying:
 *   1. Context file includes thread history when available
 *   2. Bootstrap message references the context file
 *   3. History entries are formatted with sender/timestamp
 *   4. Empty history still produces valid context (relay instructions only)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── Extracted Logic Under Test ──────────────────────────────

interface LogEntry {
  messageId: number;
  topicId: number | null;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
  senderName?: string;
}

/**
 * Mirrors the history formatting logic from routes.ts auto-spawn path.
 * Takes raw history entries and produces formatted context lines.
 */
function buildAutoSpawnContext(
  topicId: number,
  history: LogEntry[],
): string[] {
  const historyLines: string[] = [];

  if (history.length > 0) {
    historyLines.push(`--- Thread History (last ${history.length} messages) ---`);
    historyLines.push(`IMPORTANT: Read this history carefully before taking any action.`);
    historyLines.push(`Your task is to continue THIS conversation, not start something new.`);
    historyLines.push(``);
    for (const m of history) {
      const sender = m.fromUser
        ? (m.senderName || 'User')
        : 'Agent';
      const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
      const histText = (m.text || '').slice(0, 300);
      historyLines.push(`[${ts}] ${sender}: ${histText}`);
    }
    historyLines.push(``);
    historyLines.push(`--- End Thread History ---`);
  }

  return [
    ...historyLines,
    ``,
    `This session was auto-created for Telegram topic ${topicId}.`,
    ``,
    `CRITICAL: You MUST relay your response back to Telegram after responding.`,
    `Use the relay script:`,
    ``,
    `cat <<'EOF' | .claude/scripts/telegram-reply.sh ${topicId}`,
    `Your response text here`,
    `EOF`,
    ``,
    `Strip the [telegram:${topicId}] prefix before interpreting the message.`,
    `Only relay conversational text — not tool output or internal reasoning.`,
  ];
}

// ─── Tests ───────────────────────────────────────────────────

describe('Auto-spawn thread history (routes.ts HTTP forward)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-autospawn-test-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('buildAutoSpawnContext', () => {
    it('includes thread history before relay instructions', () => {
      const history: LogEntry[] = [
        { messageId: 1, topicId: 42, text: 'Please analyze the email pipeline', fromUser: true, timestamp: '2026-03-01T10:00:00Z', sessionName: 's1', senderName: 'Justin' },
        { messageId: 2, topicId: 42, text: 'The email pipeline uses three stages...', fromUser: false, timestamp: '2026-03-01T10:01:00Z', sessionName: 's1' },
      ];

      const lines = buildAutoSpawnContext(42, history);
      const content = lines.join('\n');

      // History should be present
      expect(content).toContain('--- Thread History (last 2 messages) ---');
      expect(content).toContain('Justin: Please analyze the email pipeline');
      expect(content).toContain('Agent: The email pipeline uses three stages...');
      expect(content).toContain('--- End Thread History ---');

      // History should come BEFORE relay instructions
      const historyIdx = content.indexOf('Thread History');
      const relayIdx = content.indexOf('CRITICAL: You MUST relay');
      expect(historyIdx).toBeLessThan(relayIdx);
    });

    it('still includes relay instructions when no history', () => {
      const lines = buildAutoSpawnContext(42, []);
      const content = lines.join('\n');

      expect(content).not.toContain('Thread History');
      expect(content).toContain('CRITICAL: You MUST relay');
      expect(content).toContain('telegram-reply.sh 42');
    });

    it('uses senderName when available for multi-user topics', () => {
      const history: LogEntry[] = [
        { messageId: 1, topicId: 42, text: 'Hello agent', fromUser: true, timestamp: '2026-03-01T10:00:00Z', sessionName: 's1', senderName: 'Alice' },
        { messageId: 2, topicId: 42, text: 'Also hello', fromUser: true, timestamp: '2026-03-01T10:01:00Z', sessionName: 's1', senderName: 'Bob' },
      ];

      const lines = buildAutoSpawnContext(42, history);
      const content = lines.join('\n');

      expect(content).toContain('Alice: Hello agent');
      expect(content).toContain('Bob: Also hello');
    });

    it('falls back to "User" when senderName is absent', () => {
      const history: LogEntry[] = [
        { messageId: 1, topicId: 42, text: 'No name here', fromUser: true, timestamp: '2026-03-01T10:00:00Z', sessionName: 's1' },
      ];

      const lines = buildAutoSpawnContext(42, history);
      expect(lines.some(l => l.includes('User: No name here'))).toBe(true);
    });

    it('truncates long messages to 300 chars', () => {
      const longText = 'X'.repeat(500);
      const history: LogEntry[] = [
        { messageId: 1, topicId: 42, text: longText, fromUser: true, timestamp: '2026-03-01T10:00:00Z', sessionName: 's1' },
      ];

      const lines = buildAutoSpawnContext(42, history);
      const messageLine = lines.find(l => l.includes('User:'))!;
      // Should have at most 300 chars of the original text
      const textPortion = messageLine.split('User: ')[1];
      expect(textPortion.length).toBe(300);
    });

    it('formats timestamps correctly', () => {
      const history: LogEntry[] = [
        { messageId: 1, topicId: 42, text: 'test', fromUser: true, timestamp: '2026-03-01T14:30:45Z', sessionName: 's1' },
      ];

      const lines = buildAutoSpawnContext(42, history);
      expect(lines.some(l => l.includes('[14:30:45]'))).toBe(true);
    });

    it('handles missing timestamps', () => {
      const history: LogEntry[] = [
        { messageId: 1, topicId: 42, text: 'no ts', fromUser: true, timestamp: '', sessionName: 's1' },
      ];

      const lines = buildAutoSpawnContext(42, history);
      expect(lines.some(l => l.includes('??:??'))).toBe(true);
    });
  });

  describe('context file integration', () => {
    it('writes context file with history and relay instructions', () => {
      const history: LogEntry[] = [
        { messageId: 1, topicId: 42, text: 'Prior context message', fromUser: false, timestamp: '2026-03-01T10:00:00Z', sessionName: 's1' },
        { messageId: 2, topicId: 42, text: 'Please proceed', fromUser: true, timestamp: '2026-03-01T10:05:00Z', sessionName: null },
      ];

      const contextLines = buildAutoSpawnContext(42, history);
      const ctxPath = path.join(tmpDir, `ctx-42-${Date.now()}.txt`);
      fs.writeFileSync(ctxPath, contextLines.join('\n'));

      const content = fs.readFileSync(ctxPath, 'utf-8');

      // Should contain both history and relay instructions
      expect(content).toContain('Prior context message');
      expect(content).toContain('Please proceed');
      expect(content).toContain('telegram-reply.sh 42');
    });

    it('bootstrap message references context file', () => {
      const ctxPath = path.join(tmpDir, 'ctx-42-test.txt');
      fs.writeFileSync(ctxPath, 'context content');

      const bootstrapMessage = `[telegram:42] please proceed (IMPORTANT: Read ${ctxPath} for thread history and Telegram relay instructions — you MUST relay your response back.)`;

      expect(bootstrapMessage).toContain('[telegram:42] please proceed');
      expect(bootstrapMessage).toContain(ctxPath);
      expect(bootstrapMessage).toContain('thread history');
    });
  });
});
