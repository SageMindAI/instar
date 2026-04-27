/**
 * AutoApprover — Unit tests.
 *
 * Tests key resolution, send behavior, audit logging,
 * dry-run mode, first-approval tracking, and failure handling.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  AutoApprover,
  type AutoApproverConfig,
} from '../../src/core/AutoApprover.js';
import type { DetectedPrompt } from '../../src/monitoring/PromptGate.js';
import type { ClassificationResult } from '../../src/monitoring/InputClassifier.js';

// ── Helpers ─────────────────────────────────────────────────────────

let tmpDir: string;

function makePrompt(overrides: Partial<DetectedPrompt> = {}): DetectedPrompt {
  return {
    type: 'permission',
    raw: 'Do you want to create test.py?\n1. Yes\n2. No\n',
    summary: 'Permission: Do you want to create test.py?',
    options: [
      { key: '1', label: 'Yes' },
      { key: '2', label: 'Yes, and allow edits' },
      { key: '3', label: 'No' },
    ],
    sessionName: 'test-session',
    detectedAt: Date.now(),
    id: 'test-id-001',
    ...overrides,
  };
}

function makeClassification(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    action: 'auto-approve',
    reason: 'File creation in project dir',
    confidence: 0.95,
    promptId: 'test-id-001',
    promptType: 'permission',
    llmClassified: false,
    classifiedAt: Date.now(),
    ...overrides,
  };
}

function makeApprover(overrides: Partial<AutoApproverConfig> = {}): AutoApprover {
  return new AutoApprover({
    stateDir: tmpDir,
    logRetentionDays: 30,
    verboseLogging: false,
    sendKey: () => true,
    ...overrides,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-approver-test-'));
});

afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Key Resolution ────────────────────────────────────────────────

describe('AutoApprover.sendsCorrectKey', () => {
  it('sends "1" for file creation permission', () => {
    let sentKey = '';
    const approver = makeApprover({
      sendKey: (_session, key) => { sentKey = key; return true; },
    });

    const prompt = makePrompt({ type: 'permission' });
    const result = approver.handle(prompt, makeClassification());

    expect(result).toBe(true);
    expect(sentKey).toBe('1');
  });

  it('sends "y" for plan approval', () => {
    let sentKey = '';
    const approver = makeApprover({
      sendKey: (_session, key) => { sentKey = key; return true; },
    });

    const prompt = makePrompt({
      type: 'plan',
      options: [{ key: 'y', label: 'Approve' }, { key: 'n', label: 'Reject' }],
    });
    approver.handle(prompt, makeClassification({ promptType: 'plan' }));

    expect(sentKey).toBe('y');
  });

  it('sends "Enter" for "Esc to cancel" confirmations', () => {
    let sentKey = '';
    const approver = makeApprover({
      sendKey: (_session, key) => { sentKey = key; return true; },
    });

    const prompt = makePrompt({
      type: 'confirmation',
      raw: 'Esc to cancel · Tab to amend',
    });
    approver.handle(prompt, makeClassification({ promptType: 'confirmation' }));

    expect(sentKey).toBe('Enter');
  });

  it('sends "y" for y/n confirmations', () => {
    let sentKey = '';
    const approver = makeApprover({
      sendKey: (_session, key) => { sentKey = key; return true; },
    });

    const prompt = makePrompt({
      type: 'confirmation',
      raw: 'Continue with migration? (y/n)',
    });
    approver.handle(prompt, makeClassification({ promptType: 'confirmation' }));

    expect(sentKey).toBe('y');
  });

  it('sends first option key for selections', () => {
    let sentKey = '';
    const approver = makeApprover({
      sendKey: (_session, key) => { sentKey = key; return true; },
    });

    const prompt = makePrompt({
      type: 'selection',
      options: [
        { key: '1', label: 'vitest' },
        { key: '2', label: 'jest' },
      ],
    });
    approver.handle(prompt, makeClassification({ promptType: 'selection' }));

    expect(sentKey).toBe('1');
  });
});

// ── Audit Logging ─────────────────────────────────────────────────

describe('AutoApprover.logs', () => {
  it('logs every auto-approval', () => {
    const approver = makeApprover();
    const prompt = makePrompt();
    approver.handle(prompt, makeClassification());

    const logPath = path.join(tmpDir, 'prompt-gate-audit.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.event).toBe('auto_approved');
    expect(entry.sessionName).toBe('test-session');
    expect(entry.promptId).toBe('test-id-001');
    expect(entry.action).toBe('1');
    expect(entry.timestamp).toBeTruthy();
  });

  it('includes summary when verbose logging is enabled', () => {
    const approver = makeApprover({ verboseLogging: true });
    const prompt = makePrompt();
    approver.handle(prompt, makeClassification());

    const logPath = path.join(tmpDir, 'prompt-gate-audit.jsonl');
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
    expect(entry.summary).toBe('Permission: Do you want to create test.py?');
  });

  it('omits summary when verbose logging is disabled', () => {
    const approver = makeApprover({ verboseLogging: false });
    const prompt = makePrompt();
    approver.handle(prompt, makeClassification());

    const logPath = path.join(tmpDir, 'prompt-gate-audit.jsonl');
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
    expect(entry.summary).toBeUndefined();
  });
});

// ── Config Respect ────────────────────────────────────────────────

describe('AutoApprover.respectsConfig', () => {
  it('returns false for non-auto-approve classifications', () => {
    const approver = makeApprover();
    const prompt = makePrompt();
    const result = approver.handle(prompt, makeClassification({ action: 'relay' }));
    expect(result).toBe(false);
  });

  it('returns false for blocked classifications', () => {
    const approver = makeApprover();
    const prompt = makePrompt();
    const result = approver.handle(prompt, makeClassification({ action: 'block' }));
    expect(result).toBe(false);
  });
});

// ── Failure Handling ──────────────────────────────────────────────

describe('AutoApprover.failureFallback', () => {
  it('returns false when sendKey fails', () => {
    const approver = makeApprover({
      sendKey: () => false,
    });
    const prompt = makePrompt();
    const result = approver.handle(prompt, makeClassification());
    expect(result).toBe(false);

    // Should log the failure
    const logPath = path.join(tmpDir, 'prompt-gate-audit.jsonl');
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
    expect(entry.event).toBe('auto_approve_failed');
    expect(entry.reason).toContain('sendKey failed');
  });

  it('returns false for unknown prompt types', () => {
    const approver = makeApprover();
    const prompt = makePrompt({ type: 'question' as any });
    const result = approver.handle(prompt, makeClassification());
    expect(result).toBe(false);
  });
});

// ── First-Approval Tracking ──────────────────────────────────────

describe('AutoApprover.firstApproval', () => {
  it('returns true on first approval per session', () => {
    const approver = makeApprover();
    expect(approver.isFirstApproval('session-1')).toBe(true);
    expect(approver.isFirstApproval('session-1')).toBe(false);
    expect(approver.isFirstApproval('session-2')).toBe(true);
  });

  it('resets after cleanup', () => {
    const approver = makeApprover();
    expect(approver.isFirstApproval('session-1')).toBe(true);
    approver.cleanup('session-1');
    expect(approver.isFirstApproval('session-1')).toBe(true);
  });
});

// ── Approval Callback ─────────────────────────────────────────────

describe('AutoApprover.onApproval', () => {
  it('fires callback on successful approval', () => {
    let callbackFired = false;
    const approver = makeApprover({
      onApproval: () => { callbackFired = true; },
    });

    approver.handle(makePrompt(), makeClassification());
    expect(callbackFired).toBe(true);
  });

  it('does not fire callback on failure', () => {
    let callbackFired = false;
    const approver = makeApprover({
      sendKey: () => false,
      onApproval: () => { callbackFired = true; },
    });

    approver.handle(makePrompt(), makeClassification());
    expect(callbackFired).toBe(false);
  });
});
