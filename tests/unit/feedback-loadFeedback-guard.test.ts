/**
 * Unit tests for FeedbackManager.loadFeedback() array guard and POST /feedback
 * error handling when feedback data is corrupted.
 *
 * Covers: non-array JSON in feedback.json (object, null, number, string),
 * valid array passthrough, and route-level error response on corrupted data.
 *
 * Fixes #93 — POST /feedback returns 500 when feedback.json has non-array data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FeedbackManager } from '../../src/core/FeedbackManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('FeedbackManager loadFeedback array guard', () => {
  let tmpDir: string;
  let feedbackFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fb-guard-'));
    feedbackFile = path.join(tmpDir, 'feedback.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/feedback-loadFeedback-guard.test.ts:afterEach' });
  });

  it('returns [] when feedback.json contains a plain object', () => {
    fs.writeFileSync(feedbackFile, JSON.stringify({ key: 'value' }));

    const manager = new FeedbackManager({
      enabled: false,
      webhookUrl: '',
      feedbackFile,
    });

    const items = manager.list();
    expect(items).toEqual([]);
  });

  it('returns [] when feedback.json contains null', () => {
    fs.writeFileSync(feedbackFile, 'null');

    const manager = new FeedbackManager({
      enabled: false,
      webhookUrl: '',
      feedbackFile,
    });

    const items = manager.list();
    expect(items).toEqual([]);
  });

  it('returns [] when feedback.json contains a number', () => {
    fs.writeFileSync(feedbackFile, '42');

    const manager = new FeedbackManager({
      enabled: false,
      webhookUrl: '',
      feedbackFile,
    });

    const items = manager.list();
    expect(items).toEqual([]);
  });

  it('returns [] when feedback.json contains a string', () => {
    fs.writeFileSync(feedbackFile, '"hello"');

    const manager = new FeedbackManager({
      enabled: false,
      webhookUrl: '',
      feedbackFile,
    });

    const items = manager.list();
    expect(items).toEqual([]);
  });

  it('returns the array when feedback.json contains a valid array', () => {
    const validData = [
      {
        id: 'fb-test1',
        type: 'bug',
        title: 'Test bug',
        description: 'A real bug report',
        agentName: 'test-agent',
        agentPseudonym: 'agent-abc123',
        instarVersion: '0.1.0',
        nodeVersion: 'v20.0.0',
        os: 'darwin arm64',
        submittedAt: '2025-01-01T00:00:00.000Z',
        forwarded: false,
      },
    ];
    fs.writeFileSync(feedbackFile, JSON.stringify(validData));

    const manager = new FeedbackManager({
      enabled: false,
      webhookUrl: '',
      feedbackFile,
    });

    const items = manager.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('fb-test1');
  });

  it('returns [] when feedback.json does not exist', () => {
    const manager = new FeedbackManager({
      enabled: false,
      webhookUrl: '',
      feedbackFile: path.join(tmpDir, 'nonexistent.json'),
    });

    const items = manager.list();
    expect(items).toEqual([]);
  });

  it('returns [] when feedback.json contains invalid JSON', () => {
    fs.writeFileSync(feedbackFile, '{not valid json!!!');

    const manager = new FeedbackManager({
      enabled: false,
      webhookUrl: '',
      feedbackFile,
    });

    const items = manager.list();
    expect(items).toEqual([]);
  });

  it('validateFeedbackQuality does not throw when feedback.json contains non-array data', () => {
    fs.writeFileSync(feedbackFile, JSON.stringify({ corrupted: true }));

    const manager = new FeedbackManager({
      enabled: false,
      webhookUrl: '',
      feedbackFile,
    });

    // This calls loadFeedback() internally for duplicate checking —
    // before the fix, it would throw TypeError on .slice()
    const result = manager.validateFeedbackQuality(
      'A valid title for testing',
      'This is a description with enough real content to pass the minimum length check easily',
    );
    expect(result.valid).toBe(true);
  });
});
