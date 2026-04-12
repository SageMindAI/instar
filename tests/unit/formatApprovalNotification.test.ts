/**
 * Regression tests for formatApprovalNotification().
 *
 * Before this was introduced, the approval notification said only:
 *   "I received 1 behavioral dispatch(es) that need your approval ..."
 * which gave the user no idea what they were being asked to approve.
 * These tests lock in the self-explanatory format.
 */

import { describe, it, expect } from 'vitest';
import { formatApprovalNotification } from '../../src/core/AutoDispatcher.js';
import type { Dispatch } from '../../src/core/DispatchManager.js';

function makeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    dispatchId: 'dsp-test-1',
    type: 'behavioral',
    title: 'Prefer structured logs',
    content: 'When logging, prefer structured JSON over free-form strings.',
    priority: 'normal',
    createdAt: '2026-04-11T10:00:00.000Z',
    receivedAt: '2026-04-11T10:00:01.000Z',
    applied: false,
    ...overrides,
  };
}

describe('formatApprovalNotification()', () => {
  it('returns an empty string when there are no dispatches', () => {
    expect(formatApprovalNotification([])).toBe('');
  });

  it('names the dispatch in plain language, not jargon', () => {
    const msg = formatApprovalNotification([makeDispatch()]);
    // No more "dispatch(es)" / opaque type codes in the user-facing text.
    expect(msg).not.toMatch(/dispatch\(es\)/i);
    expect(msg).toContain('behavior guideline');
    expect(msg).toContain('"Prefer structured logs"');
  });

  it('includes a content preview so the user knows what is being proposed', () => {
    const msg = formatApprovalNotification([
      makeDispatch({ content: 'When logging, prefer structured JSON over free-form strings.' }),
    ]);
    expect(msg).toContain('structured JSON');
  });

  it('includes the dispatch ID for traceability', () => {
    const msg = formatApprovalNotification([makeDispatch({ dispatchId: 'dsp-abc-123' })]);
    expect(msg).toContain('dsp-abc-123');
  });

  it('tells the user how to respond', () => {
    const msg = formatApprovalNotification([makeDispatch()]);
    expect(msg.toLowerCase()).toMatch(/approve|reject/);
  });

  it('uses singular header for one dispatch', () => {
    const msg = formatApprovalNotification([makeDispatch()]);
    expect(msg).toMatch(/a new guideline waiting/i);
  });

  it('uses plural header with count for multiple dispatches', () => {
    const msg = formatApprovalNotification([
      makeDispatch({ dispatchId: 'dsp-1', title: 'First' }),
      makeDispatch({ dispatchId: 'dsp-2', title: 'Second' }),
      makeDispatch({ dispatchId: 'dsp-3', title: 'Third' }),
    ]);
    expect(msg).toMatch(/3 new guidelines waiting/i);
    expect(msg).toContain('"First"');
    expect(msg).toContain('"Second"');
    expect(msg).toContain('"Third"');
  });

  it('truncates long content with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const msg = formatApprovalNotification([makeDispatch({ content: long })]);
    expect(msg).toContain('…');
    // Shouldn't dump all 500 chars
    expect(msg.length).toBeLessThan(600);
  });

  it('collapses whitespace in content previews', () => {
    const msg = formatApprovalNotification([
      makeDispatch({ content: 'line one\n\n\nline two\t\ttabs' }),
    ]);
    expect(msg).toContain('line one line two tabs');
  });

  it('labels security dispatches as "security update"', () => {
    const msg = formatApprovalNotification([makeDispatch({ type: 'security', title: 'Rotate tokens' })]);
    expect(msg).toContain('security update');
  });

  it('surfaces non-normal priorities', () => {
    const msg = formatApprovalNotification([
      makeDispatch({ priority: 'critical', title: 'Critical thing' }),
    ]);
    expect(msg).toMatch(/critical priority/i);
  });

  it('omits the priority note when priority is normal', () => {
    const msg = formatApprovalNotification([makeDispatch({ priority: 'normal' })]);
    expect(msg).not.toMatch(/normal priority/i);
  });

  it('handles empty content gracefully', () => {
    const msg = formatApprovalNotification([makeDispatch({ content: '' })]);
    expect(msg).toContain('(no content)');
  });
});
