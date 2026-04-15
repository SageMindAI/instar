import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SharedStateLedger } from '../../src/core/SharedStateLedger.js';

describe('SharedStateLedger', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-state-test-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe('append', () => {
    it('writes an entry and returns it with id and timestamp', () => {
      const ledger = new SharedStateLedger(projectDir);
      const entry = ledger.append({
        sessionId: 'sess-1',
        kind: 'commitment',
        subject: 'Will ship the feedback endpoints by Friday',
        party: 'sagemind',
      });
      expect(entry.id).toMatch(/^[a-f0-9]{12}$/);
      expect(entry.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.subject).toBe('Will ship the feedback endpoints by Friday');
      expect(entry.party).toBe('sagemind');
      expect(entry.kind).toBe('commitment');
    });

    it('persists the entry as a line in .instar/shared-state.jsonl', () => {
      const ledger = new SharedStateLedger(projectDir);
      ledger.append({
        sessionId: 'sess-1',
        kind: 'note',
        subject: 'Something notable happened',
      });
      const content = fs.readFileSync(
        path.join(projectDir, '.instar', 'shared-state.jsonl'),
        'utf-8',
      );
      const parsed = JSON.parse(content.trim());
      expect(parsed.subject).toBe('Something notable happened');
    });

    it('throws when subject is empty', () => {
      const ledger = new SharedStateLedger(projectDir);
      expect(() =>
        ledger.append({ sessionId: 'sess-1', kind: 'note', subject: '' }),
      ).toThrow(/subject is required/);
      expect(() =>
        ledger.append({ sessionId: 'sess-1', kind: 'note', subject: '   ' }),
      ).toThrow(/subject is required/);
    });

    it('truncates subject beyond MAX_SUBJECT', () => {
      const ledger = new SharedStateLedger(projectDir);
      const longSubject = 'a'.repeat(500);
      const entry = ledger.append({
        sessionId: 'sess-1',
        kind: 'note',
        subject: longSubject,
      });
      expect(entry.subject.length).toBe(SharedStateLedger.MAX_SUBJECT);
    });

    it('truncates summary beyond MAX_SUMMARY', () => {
      const ledger = new SharedStateLedger(projectDir);
      const longSummary = 'b'.repeat(5000);
      const entry = ledger.append({
        sessionId: 'sess-1',
        kind: 'note',
        subject: 'Has long summary',
        summary: longSummary,
      });
      expect(entry.summary?.length).toBe(SharedStateLedger.MAX_SUMMARY);
    });

    it('caps MAX_SUMMARY at 500 chars (security-boundary backstop)', () => {
      // The cap is set small enough to make pasting a full threadline
      // message body physically inconvenient. If a future change raises
      // the cap, that choice needs its own side-effects review — this
      // test is intentionally tight to surface such a change.
      expect(SharedStateLedger.MAX_SUMMARY).toBe(500);
    });

    it('preserves entries across multiple appends', () => {
      const ledger = new SharedStateLedger(projectDir);
      ledger.append({ sessionId: 's1', kind: 'note', subject: 'first' });
      ledger.append({ sessionId: 's2', kind: 'note', subject: 'second' });
      ledger.append({ sessionId: 's3', kind: 'note', subject: 'third' });
      const entries = ledger.recent(10);
      expect(entries.map((e) => e.subject)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('recent', () => {
    it('returns [] when the ledger does not yet exist', () => {
      const ledger = new SharedStateLedger(projectDir);
      expect(ledger.recent()).toEqual([]);
    });

    it('returns the most recent N entries, oldest-to-newest', () => {
      const ledger = new SharedStateLedger(projectDir);
      for (let i = 0; i < 30; i++) {
        ledger.append({ sessionId: 's', kind: 'note', subject: `entry-${i}` });
      }
      const recent = ledger.recent(5);
      expect(recent.map((e) => e.subject)).toEqual([
        'entry-25',
        'entry-26',
        'entry-27',
        'entry-28',
        'entry-29',
      ]);
    });

    it('skips malformed lines silently', () => {
      const ledger = new SharedStateLedger(projectDir);
      ledger.append({ sessionId: 's', kind: 'note', subject: 'valid-1' });
      // Manually append a malformed line
      fs.appendFileSync(ledger.filePath, 'this is not JSON\n');
      fs.appendFileSync(ledger.filePath, '{"id": "incomplete"}\n');
      ledger.append({ sessionId: 's', kind: 'note', subject: 'valid-2' });
      const recent = ledger.recent(10);
      expect(recent.map((e) => e.subject)).toEqual(['valid-1', 'valid-2']);
    });
  });

  describe('renderForInjection', () => {
    it('returns a placeholder when ledger is empty', () => {
      const ledger = new SharedStateLedger(projectDir);
      const rendered = ledger.renderForInjection();
      expect(rendered).toContain('[shared-state]');
      expect(rendered).toContain('no recent entries');
    });

    it('includes each entry with timestamp, kind, subject', () => {
      const ledger = new SharedStateLedger(projectDir);
      ledger.append({
        sessionId: 's1',
        kind: 'agreement',
        subject: 'Aligned with sagemind on feedback endpoints',
        party: 'sagemind',
      });
      const rendered = ledger.renderForInjection();
      expect(rendered).toContain('shared-state');
      expect(rendered).toContain('agreement');
      expect(rendered).toContain('Aligned with sagemind');
      expect(rendered).toContain('party: sagemind');
    });

    it('includes summary on its own indented line when present', () => {
      const ledger = new SharedStateLedger(projectDir);
      ledger.append({
        sessionId: 's1',
        kind: 'commitment',
        subject: 'Will ship endpoints Friday',
        summary: 'Four-endpoint contract; Dawn building on her side',
      });
      const rendered = ledger.renderForInjection();
      expect(rendered).toContain('Four-endpoint contract');
    });

    it('bounds injection to recent entries only', () => {
      const ledger = new SharedStateLedger(projectDir);
      for (let i = 0; i < 50; i++) {
        ledger.append({ sessionId: 's', kind: 'note', subject: `entry-${i}` });
      }
      const rendered = ledger.renderForInjection(5);
      expect(rendered).toContain('entry-49');
      expect(rendered).toContain('entry-45');
      expect(rendered).not.toContain('entry-10');
      expect(rendered).not.toContain('entry-44');
    });
  });

  describe('rotation', () => {
    it('rotates the file when line count exceeds ROTATE_AT_LINES', () => {
      const ledger = new SharedStateLedger(projectDir);
      // Write enough entries with padded summaries to exceed the size
      // threshold that triggers the exact line-count check. Default
      // ROTATE_AT_LINES is 5000; write one more than that to trigger.
      const pad = 'x'.repeat(200);
      for (let i = 0; i < SharedStateLedger.ROTATE_AT_LINES + 1; i++) {
        ledger.append({
          sessionId: 's',
          kind: 'note',
          subject: `entry-${i}`,
          summary: pad,
        });
      }
      // The rotated file should exist at .jsonl.1
      const rotated = ledger.filePath + '.1';
      expect(fs.existsSync(rotated)).toBe(true);
      // The current file should have only the most recent entry
      // (everything before rotation went to .jsonl.1)
      const currentEntries = ledger.recent(10000);
      expect(currentEntries.length).toBeLessThan(SharedStateLedger.ROTATE_AT_LINES);
    });

    it('ROTATE_AT_LINES is 5000 — bounded read-path cost', () => {
      expect(SharedStateLedger.ROTATE_AT_LINES).toBe(5000);
    });
  });

  describe('security-boundary discipline', () => {
    it('accepts derived-facts style summaries', () => {
      const ledger = new SharedStateLedger(projectDir);
      const entry = ledger.append({
        sessionId: 's1',
        kind: 'agreement',
        subject: 'Agreed on 4-endpoint feedback contract',
        summary:
          'Derived fact: contract scope covers lookup, status update, resolve, and event emit. Dawn is building.',
        party: 'sagemind',
      });
      expect(entry.summary).toContain('contract scope');
    });

    it('does not enforce the derived-facts rule itself — that is a prompt/process concern', () => {
      // The ledger does not parse summary content. Enforcement of "derived
      // facts only, no raw messages" is a process discipline enforced by the
      // /instar-dev skill's side-effects review, not by the ledger API.
      // This test documents that intentional split.
      const ledger = new SharedStateLedger(projectDir);
      const anything = ledger.append({
        sessionId: 's1',
        kind: 'note',
        subject: 'Whatever',
        summary: 'Any text is stored as-is',
      });
      expect(anything.summary).toBe('Any text is stored as-is');
    });
  });
});
