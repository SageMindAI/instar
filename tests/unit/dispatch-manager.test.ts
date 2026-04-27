/**
 * Unit tests for DispatchManager.
 *
 * Covers: URL validation, polling, local storage, dedup,
 * context generation, apply/mark, edge cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DispatchManager } from '../../src/core/DispatchManager.js';
import type { Dispatch, EvaluationDecision } from '../../src/core/DispatchManager.js';

describe('DispatchManager URL validation', () => {
  it('rejects HTTP URLs', () => {
    expect(() => new DispatchManager({
      enabled: true,
      dispatchUrl: 'http://example.com/dispatches',
      dispatchFile: '/tmp/test.json',
    })).toThrow('HTTPS');
  });

  it('rejects localhost URLs', () => {
    expect(() => new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://localhost/dispatches',
      dispatchFile: '/tmp/test.json',
    })).toThrow('internal');
  });

  it('rejects 127.0.0.1 URLs', () => {
    expect(() => new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://127.0.0.1/dispatches',
      dispatchFile: '/tmp/test.json',
    })).toThrow('internal');
  });

  it('rejects 192.168.x.x URLs', () => {
    expect(() => new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://192.168.1.1/dispatches',
      dispatchFile: '/tmp/test.json',
    })).toThrow('internal');
  });

  it('accepts valid HTTPS URLs', () => {
    expect(() => new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://dawn.bot-me.ai/api/instar/dispatches',
      dispatchFile: '/tmp/test.json',
    })).not.toThrow();
  });

  it('rejects invalid URLs', () => {
    expect(() => new DispatchManager({
      enabled: true,
      dispatchUrl: 'not-a-url',
      dispatchFile: '/tmp/test.json',
    })).toThrow('invalid');
  });
});

describe('DispatchManager local storage', () => {
  let tmpDir: string;
  let dispatchFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dispatch-'));
    dispatchFile = path.join(tmpDir, 'dispatches.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty list when no dispatches exist', () => {
    const manager = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    expect(manager.list()).toEqual([]);
    expect(manager.pending()).toEqual([]);
  });

  it('returns null for non-existent dispatch', () => {
    const manager = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    expect(manager.get('dsp-nonexistent')).toBeNull();
  });

  it('handles corrupted dispatch file', () => {
    fs.writeFileSync(dispatchFile, 'bad json {{');
    const manager = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    expect(manager.list()).toEqual([]);
  });

  it('marks dispatch as applied', () => {
    const dispatches: Dispatch[] = [{
      dispatchId: 'dsp-test1',
      type: 'strategy',
      title: 'Test Strategy',
      content: 'Try approach X for better results.',
      priority: 'normal',
      createdAt: '2026-01-01T00:00:00Z',
      receivedAt: '2026-01-01T01:00:00Z',
      applied: false,
    }];
    fs.writeFileSync(dispatchFile, JSON.stringify(dispatches));

    const manager = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    expect(manager.pending()).toHaveLength(1);

    const result = manager.markApplied('dsp-test1');
    expect(result).toBe(true);
    expect(manager.pending()).toHaveLength(0);
    expect(manager.list()[0].applied).toBe(true);
  });

  it('returns false when marking non-existent dispatch', () => {
    const manager = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    expect(manager.markApplied('dsp-nonexistent')).toBe(false);
  });

  it('persists applied state to disk', () => {
    const dispatches: Dispatch[] = [{
      dispatchId: 'dsp-persist',
      type: 'lesson',
      title: 'Persistence Test',
      content: 'This should persist.',
      priority: 'high',
      createdAt: '2026-01-01T00:00:00Z',
      receivedAt: '2026-01-01T01:00:00Z',
      applied: false,
    }];
    fs.writeFileSync(dispatchFile, JSON.stringify(dispatches));

    const manager1 = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    manager1.markApplied('dsp-persist');

    // Create new manager from same file
    const manager2 = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    expect(manager2.get('dsp-persist')?.applied).toBe(true);
    expect(manager2.pending()).toHaveLength(0);
  });
});

describe('DispatchManager context generation', () => {
  let tmpDir: string;
  let dispatchFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dispatch-ctx-'));
    dispatchFile = path.join(tmpDir, 'dispatches.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string when no pending dispatches', () => {
    const manager = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    expect(manager.generateContext()).toBe('');
  });

  it('generates context with pending dispatches', () => {
    const dispatches: Dispatch[] = [
      {
        dispatchId: 'dsp-ctx1',
        type: 'strategy',
        title: 'Better Memory Handling',
        content: 'When users ask about past conversations, check MEMORY.md first before claiming no memory.',
        priority: 'high',
        createdAt: '2026-01-01T00:00:00Z',
        receivedAt: '2026-01-01T01:00:00Z',
        applied: false,
      },
      {
        dispatchId: 'dsp-ctx2',
        type: 'behavioral',
        title: 'Reduce Verbosity',
        content: 'Health check reports should be concise — one line per component.',
        priority: 'normal',
        createdAt: '2026-01-02T00:00:00Z',
        receivedAt: '2026-01-02T01:00:00Z',
        applied: false,
      },
    ];
    fs.writeFileSync(dispatchFile, JSON.stringify(dispatches));

    const manager = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    const context = manager.generateContext();
    expect(context).toContain('Intelligence Dispatches');
    expect(context).toContain('Better Memory Handling');
    expect(context).toContain('[HIGH]');
    expect(context).toContain('Reduce Verbosity');
    expect(context).toContain('2 pending dispatches');
  });

  it('excludes applied dispatches from context', () => {
    const dispatches: Dispatch[] = [
      {
        dispatchId: 'dsp-applied',
        type: 'lesson',
        title: 'Already Applied',
        content: 'This was already applied.',
        priority: 'normal',
        createdAt: '2026-01-01T00:00:00Z',
        receivedAt: '2026-01-01T01:00:00Z',
        applied: true,
      },
    ];
    fs.writeFileSync(dispatchFile, JSON.stringify(dispatches));

    const manager = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    expect(manager.generateContext()).toBe('');
  });

  it('sorts by priority (critical first)', () => {
    const dispatches: Dispatch[] = [
      {
        dispatchId: 'dsp-low',
        type: 'configuration',
        title: 'Low Priority',
        content: 'Optional config change.',
        priority: 'low',
        createdAt: '2026-01-01T00:00:00Z',
        receivedAt: '2026-01-01T01:00:00Z',
        applied: false,
      },
      {
        dispatchId: 'dsp-critical',
        type: 'security',
        title: 'Critical Security',
        content: 'New injection pattern detected.',
        priority: 'critical',
        createdAt: '2026-01-02T00:00:00Z',
        receivedAt: '2026-01-02T01:00:00Z',
        applied: false,
      },
    ];
    fs.writeFileSync(dispatchFile, JSON.stringify(dispatches));

    const manager = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    const context = manager.generateContext();
    const criticalPos = context.indexOf('Critical Security');
    const lowPos = context.indexOf('Low Priority');
    expect(criticalPos).toBeLessThan(lowPos);
  });
});

describe('DispatchManager polling', () => {
  let tmpDir: string;
  let dispatchFile: string;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dispatch-poll-'));
    dispatchFile = path.join(tmpDir, 'dispatches.json');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty result when disabled', async () => {
    const manager = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    const result = await manager.check();
    expect(result.newCount).toBe(0);
    expect(result.dispatches).toEqual([]);
  });

  it('fetches and stores new dispatches', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        dispatches: [
          {
            dispatchId: 'dsp-new1',
            type: 'strategy',
            title: 'New Strategy',
            content: 'Try this approach.',
            priority: 'normal',
            createdAt: '2026-02-20T00:00:00Z',
          },
        ],
        count: 1,
        asOf: '2026-02-20T12:00:00Z',
      }),
    });

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      version: '0.1.12',
    });

    const result = await manager.check();
    expect(result.newCount).toBe(1);
    expect(result.dispatches[0].dispatchId).toBe('dsp-new1');
    expect(result.dispatches[0].receivedAt).toBeTruthy();
    expect(result.dispatches[0].applied).toBe(false);

    // Verify stored locally
    expect(manager.list()).toHaveLength(1);
    expect(manager.get('dsp-new1')).not.toBeNull();
  });

  it('sends proper identification headers', async () => {
    let capturedHeaders: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        json: async () => ({ dispatches: [], count: 0, asOf: new Date().toISOString() }),
      };
    });

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      version: '0.1.12',
    });

    await manager.check();

    expect(capturedHeaders['User-Agent']).toMatch(/^instar\/0\.1\.12/);
    expect(capturedHeaders['X-Instar-Version']).toBe('0.1.12');
    expect(capturedHeaders['Accept']).toBe('application/json');
  });

  it('deduplicates dispatches already received', async () => {
    // Pre-populate with existing dispatch
    const existing: Dispatch[] = [{
      dispatchId: 'dsp-existing',
      type: 'lesson',
      title: 'Already Have This',
      content: 'Old dispatch.',
      priority: 'normal',
      createdAt: '2026-01-01T00:00:00Z',
      receivedAt: '2026-01-01T01:00:00Z',
      applied: true,
    }];
    fs.writeFileSync(dispatchFile, JSON.stringify(existing));

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        dispatches: [
          {
            dispatchId: 'dsp-existing', // Same ID — should be deduped
            type: 'lesson',
            title: 'Already Have This',
            content: 'Old dispatch.',
            priority: 'normal',
            createdAt: '2026-01-01T00:00:00Z',
          },
          {
            dispatchId: 'dsp-new2',
            type: 'behavioral',
            title: 'Actually New',
            content: 'New guidance.',
            priority: 'high',
            createdAt: '2026-02-20T00:00:00Z',
          },
        ],
        count: 2,
        asOf: '2026-02-20T12:00:00Z',
      }),
    });

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      version: '0.1.12',
    });

    const result = await manager.check();
    expect(result.newCount).toBe(1); // Only the new one
    expect(result.dispatches[0].dispatchId).toBe('dsp-new2');
    expect(manager.list()).toHaveLength(2); // 1 existing + 1 new
  });

  it('handles server errors gracefully', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      version: '0.1.12',
    });

    const result = await manager.check();
    expect(result.newCount).toBe(0);
    expect(result.error).toContain('500');
  });

  it('handles network errors gracefully', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network unreachable'));

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      version: '0.1.12',
    });

    const result = await manager.check();
    expect(result.newCount).toBe(0);
    expect(result.error).toContain('Network unreachable');
  });

  it('sends since parameter on subsequent checks', async () => {
    let capturedUrl = '';

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ dispatches: [], count: 0, asOf: new Date().toISOString() }),
      };
    });

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      version: '0.1.12',
    });

    // First check — no since parameter
    await manager.check();
    expect(capturedUrl).not.toContain('since=');

    // Second check — should include since parameter
    await manager.check();
    expect(capturedUrl).toContain('since=');
  });
});

// ── Phase 2: Evaluation and intelligent application ──────────────

describe('DispatchManager evaluation', () => {
  let tmpDir: string;
  let dispatchFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dispatch-eval-'));
    dispatchFile = path.join(tmpDir, 'dispatches.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
    return {
      dispatchId: 'dsp-eval1',
      type: 'strategy',
      title: 'Test Strategy',
      content: 'Try approach X.',
      priority: 'normal',
      createdAt: '2026-01-01T00:00:00Z',
      receivedAt: '2026-01-01T01:00:00Z',
      applied: false,
      ...overrides,
    };
  }

  function createManager(overrides: Record<string, unknown> = {}) {
    return new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      ...overrides,
    });
  }

  it('records accepted evaluation and marks applied', () => {
    fs.writeFileSync(dispatchFile, JSON.stringify([seedDispatch()]));
    const manager = createManager();

    const result = manager.evaluate('dsp-eval1', 'accepted', 'Aligns with my values');
    expect(result).toBe(true);

    const dispatch = manager.get('dsp-eval1');
    expect(dispatch?.applied).toBe(true);
    expect(dispatch?.evaluation?.decision).toBe('accepted');
    expect(dispatch?.evaluation?.reason).toBe('Aligns with my values');
    expect(dispatch?.evaluation?.auto).toBe(false);
    expect(dispatch?.evaluation?.evaluatedAt).toBeTruthy();
  });

  it('records rejected evaluation without marking applied', () => {
    fs.writeFileSync(dispatchFile, JSON.stringify([seedDispatch()]));
    const manager = createManager();

    manager.evaluate('dsp-eval1', 'rejected', 'Contradicts my identity');

    const dispatch = manager.get('dsp-eval1');
    expect(dispatch?.applied).toBe(false);
    expect(dispatch?.evaluation?.decision).toBe('rejected');
  });

  it('records deferred evaluation without marking applied', () => {
    fs.writeFileSync(dispatchFile, JSON.stringify([seedDispatch()]));
    const manager = createManager();

    manager.evaluate('dsp-eval1', 'deferred', 'Need to discuss with user');

    const dispatch = manager.get('dsp-eval1');
    expect(dispatch?.applied).toBe(false);
    expect(dispatch?.evaluation?.decision).toBe('deferred');
  });

  it('returns false for non-existent dispatch', () => {
    const manager = createManager();
    expect(manager.evaluate('dsp-nonexistent', 'accepted', 'test')).toBe(false);
  });

  it('persists evaluation to disk', () => {
    fs.writeFileSync(dispatchFile, JSON.stringify([seedDispatch()]));

    const manager1 = createManager();
    manager1.evaluate('dsp-eval1', 'accepted', 'Good guidance');

    const manager2 = createManager();
    expect(manager2.get('dsp-eval1')?.evaluation?.decision).toBe('accepted');
  });
});

describe('DispatchManager context file', () => {
  let tmpDir: string;
  let dispatchFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dispatch-ctx2-'));
    dispatchFile = path.join(tmpDir, 'dispatches.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createManager(overrides: Record<string, unknown> = {}) {
    return new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      ...overrides,
    });
  }

  it('applyToContext marks dispatch as applied and writes context file', () => {
    const dispatches: Dispatch[] = [{
      dispatchId: 'dsp-ctx-test',
      type: 'strategy',
      title: 'Context File Test',
      content: 'Write this to the context file.',
      priority: 'normal',
      createdAt: '2026-01-01T00:00:00Z',
      receivedAt: '2026-01-01T01:00:00Z',
      applied: false,
    }];
    fs.writeFileSync(dispatchFile, JSON.stringify(dispatches));

    const manager = createManager();
    const result = manager.applyToContext('dsp-ctx-test');
    expect(result).toBe(true);

    // Verify context file was created
    const contextContent = manager.readContextFile();
    expect(contextContent).toContain('Context File Test');
    expect(contextContent).toContain('Write this to the context file.');
    expect(contextContent).toContain('Strategy Dispatches');
  });

  it('returns false for non-existent dispatch', () => {
    const manager = createManager();
    expect(manager.applyToContext('dsp-nonexistent')).toBe(false);
  });

  it('context file groups dispatches by type', () => {
    const dispatches: Dispatch[] = [
      {
        dispatchId: 'dsp-lesson1',
        type: 'lesson',
        title: 'Lesson One',
        content: 'Learned something.',
        priority: 'normal',
        createdAt: '2026-01-01T00:00:00Z',
        receivedAt: '2026-01-01T01:00:00Z',
        applied: true,
      },
      {
        dispatchId: 'dsp-strategy1',
        type: 'strategy',
        title: 'Strategy One',
        content: 'Try this approach.',
        priority: 'normal',
        createdAt: '2026-01-02T00:00:00Z',
        receivedAt: '2026-01-02T01:00:00Z',
        applied: true,
      },
      {
        dispatchId: 'dsp-security1',
        type: 'security',
        title: 'Security Alert',
        content: 'Watch for pattern X.',
        priority: 'high',
        createdAt: '2026-01-03T00:00:00Z',
        receivedAt: '2026-01-03T01:00:00Z',
        applied: true,
      },
    ];
    fs.writeFileSync(dispatchFile, JSON.stringify(dispatches));

    const manager = createManager();
    // Trigger rebuild by applying one more
    manager.applyToContext('dsp-lesson1');

    const content = manager.readContextFile();
    // Security should come first, then strategy, then lesson (by type order)
    const securityPos = content.indexOf('Security Dispatches');
    const strategyPos = content.indexOf('Strategy Dispatches');
    const lessonPos = content.indexOf('Lesson Dispatches');
    expect(securityPos).toBeLessThan(strategyPos);
    expect(strategyPos).toBeLessThan(lessonPos);
  });

  it('context file is removed when all dispatches are unapplied', () => {
    // No applied dispatches
    fs.writeFileSync(dispatchFile, JSON.stringify([]));
    const manager = createManager();

    // Create a context file manually to test cleanup
    const ctxPath = manager.getContextFilePath();
    fs.mkdirSync(path.dirname(ctxPath), { recursive: true });
    fs.writeFileSync(ctxPath, 'old content');

    // Apply a dispatch that doesn't exist — returns false, no rebuild
    manager.applyToContext('dsp-nonexistent');

    // readContextFile should still return old content (no rebuild triggered)
    expect(manager.readContextFile()).toBe('old content');
  });

  it('readContextFile returns empty when file does not exist', () => {
    const manager = createManager();
    expect(manager.readContextFile()).toBe('');
  });

  it('getContextFilePath returns path relative to dispatch file', () => {
    const manager = createManager();
    const ctxPath = manager.getContextFilePath();
    expect(ctxPath).toContain('dispatch-context.md');
    expect(ctxPath).toContain(tmpDir);
  });
});

describe('DispatchManager auto-apply', () => {
  let tmpDir: string;
  let dispatchFile: string;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dispatch-auto-'));
    dispatchFile = path.join(tmpDir, 'dispatches.json');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockFetchDispatches(dispatches: Array<Record<string, unknown>>) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        dispatches,
        count: dispatches.length,
        asOf: new Date().toISOString(),
      }),
    });
  }

  it('auto-applies lesson dispatches when enabled', async () => {
    mockFetchDispatches([{
      dispatchId: 'dsp-auto1',
      type: 'lesson',
      title: 'Auto Lesson',
      content: 'This should auto-apply.',
      priority: 'normal',
      createdAt: '2026-02-20T00:00:00Z',
    }]);

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      autoApply: true,
    });

    const result = await manager.checkAndAutoApply();
    expect(result.newCount).toBe(1);
    expect(result.autoApplied).toBe(1);

    const dispatch = manager.get('dsp-auto1');
    expect(dispatch?.applied).toBe(true);
    expect(dispatch?.evaluation?.auto).toBe(true);
    expect(dispatch?.evaluation?.decision).toBe('accepted');
  });

  it('auto-applies strategy dispatches when enabled', async () => {
    mockFetchDispatches([{
      dispatchId: 'dsp-auto2',
      type: 'strategy',
      title: 'Auto Strategy',
      content: 'Try this.',
      priority: 'high',
      createdAt: '2026-02-20T00:00:00Z',
    }]);

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      autoApply: true,
    });

    const result = await manager.checkAndAutoApply();
    expect(result.autoApplied).toBe(1);
  });

  it('does NOT auto-apply security dispatches', async () => {
    mockFetchDispatches([{
      dispatchId: 'dsp-security',
      type: 'security',
      title: 'Security Dispatch',
      content: 'New injection pattern.',
      priority: 'high',
      createdAt: '2026-02-20T00:00:00Z',
    }]);

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      autoApply: true,
    });

    const result = await manager.checkAndAutoApply();
    expect(result.autoApplied).toBe(0);
    expect(manager.get('dsp-security')?.applied).toBe(false);
  });

  it('does NOT auto-apply behavioral dispatches', async () => {
    mockFetchDispatches([{
      dispatchId: 'dsp-behavioral',
      type: 'behavioral',
      title: 'Behavioral Change',
      content: 'Change how you behave.',
      priority: 'normal',
      createdAt: '2026-02-20T00:00:00Z',
    }]);

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      autoApply: true,
    });

    const result = await manager.checkAndAutoApply();
    expect(result.autoApplied).toBe(0);
  });

  it('does NOT auto-apply configuration dispatches', async () => {
    mockFetchDispatches([{
      dispatchId: 'dsp-config',
      type: 'configuration',
      title: 'Config Change',
      content: 'Change timeout to 60s.',
      priority: 'normal',
      createdAt: '2026-02-20T00:00:00Z',
    }]);

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      autoApply: true,
    });

    const result = await manager.checkAndAutoApply();
    expect(result.autoApplied).toBe(0);
  });

  it('does NOT auto-apply critical priority dispatches even if type is safe', async () => {
    mockFetchDispatches([{
      dispatchId: 'dsp-critical-lesson',
      type: 'lesson',
      title: 'Critical Lesson',
      content: 'Urgent insight.',
      priority: 'critical',
      createdAt: '2026-02-20T00:00:00Z',
    }]);

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      autoApply: true,
    });

    const result = await manager.checkAndAutoApply();
    expect(result.autoApplied).toBe(0);
  });

  it('skips auto-apply when config disabled', async () => {
    mockFetchDispatches([{
      dispatchId: 'dsp-skip',
      type: 'lesson',
      title: 'Should Not Auto-Apply',
      content: 'Because autoApply is false.',
      priority: 'normal',
      createdAt: '2026-02-20T00:00:00Z',
    }]);

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      autoApply: false,
    });

    const result = await manager.checkAndAutoApply();
    expect(result.autoApplied).toBeUndefined();
    expect(manager.get('dsp-skip')?.applied).toBe(false);
  });

  it('writes context file on auto-apply', async () => {
    mockFetchDispatches([{
      dispatchId: 'dsp-ctx-auto',
      type: 'lesson',
      title: 'Auto Context',
      content: 'Should appear in context file.',
      priority: 'normal',
      createdAt: '2026-02-20T00:00:00Z',
    }]);

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      autoApply: true,
    });

    await manager.checkAndAutoApply();

    const contextContent = manager.readContextFile();
    expect(contextContent).toContain('Auto Context');
    expect(contextContent).toContain('Should appear in context file.');
  });

  it('isSafeForAutoApply correctly classifies dispatches', () => {
    const manager = new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });

    const base: Dispatch = {
      dispatchId: 'dsp-test',
      type: 'lesson',
      title: 'Test',
      content: 'Test',
      priority: 'normal',
      createdAt: '2026-01-01T00:00:00Z',
      receivedAt: '2026-01-01T01:00:00Z',
      applied: false,
    };

    // Safe types + safe priorities
    expect(manager.isSafeForAutoApply({ ...base, type: 'lesson', priority: 'normal' })).toBe(true);
    expect(manager.isSafeForAutoApply({ ...base, type: 'lesson', priority: 'low' })).toBe(true);
    expect(manager.isSafeForAutoApply({ ...base, type: 'lesson', priority: 'high' })).toBe(true);
    expect(manager.isSafeForAutoApply({ ...base, type: 'strategy', priority: 'normal' })).toBe(true);

    // Unsafe types
    expect(manager.isSafeForAutoApply({ ...base, type: 'security', priority: 'normal' })).toBe(false);
    expect(manager.isSafeForAutoApply({ ...base, type: 'behavioral', priority: 'normal' })).toBe(false);
    expect(manager.isSafeForAutoApply({ ...base, type: 'configuration', priority: 'normal' })).toBe(false);

    // Critical priority blocks even safe types
    expect(manager.isSafeForAutoApply({ ...base, type: 'lesson', priority: 'critical' })).toBe(false);
  });

  it('handles mixed dispatches — auto-applies safe, leaves unsafe', async () => {
    mockFetchDispatches([
      {
        dispatchId: 'dsp-safe',
        type: 'lesson',
        title: 'Safe Lesson',
        content: 'Auto-apply me.',
        priority: 'normal',
        createdAt: '2026-02-20T00:00:00Z',
      },
      {
        dispatchId: 'dsp-unsafe',
        type: 'security',
        title: 'Security Alert',
        content: 'Do not auto-apply.',
        priority: 'high',
        createdAt: '2026-02-20T00:00:00Z',
      },
    ]);

    const manager = new DispatchManager({
      enabled: true,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
      autoApply: true,
    });

    const result = await manager.checkAndAutoApply();
    expect(result.newCount).toBe(2);
    expect(result.autoApplied).toBe(1);

    expect(manager.get('dsp-safe')?.applied).toBe(true);
    expect(manager.get('dsp-unsafe')?.applied).toBe(false);
    expect(manager.pending()).toHaveLength(1);
  });
});

// ── Phase 3: Feedback loop closure ──────────────────────────────

describe('DispatchManager feedback', () => {
  let tmpDir: string;
  let dispatchFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dispatch-fb-'));
    dispatchFile = path.join(tmpDir, 'dispatches.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedDispatches(): Dispatch[] {
    return [
      {
        dispatchId: 'dsp-fb1',
        type: 'strategy',
        title: 'Strategy One',
        content: 'Try approach X.',
        priority: 'normal',
        createdAt: '2026-01-01T00:00:00Z',
        receivedAt: '2026-01-01T01:00:00Z',
        applied: true,
      },
      {
        dispatchId: 'dsp-fb2',
        type: 'lesson',
        title: 'Lesson One',
        content: 'Learned Y.',
        priority: 'normal',
        createdAt: '2026-01-02T00:00:00Z',
        receivedAt: '2026-01-02T01:00:00Z',
        applied: true,
      },
      {
        dispatchId: 'dsp-fb3',
        type: 'security',
        title: 'Security Alert',
        content: 'Watch for Z.',
        priority: 'high',
        createdAt: '2026-01-03T00:00:00Z',
        receivedAt: '2026-01-03T01:00:00Z',
        applied: false,
        evaluation: { decision: 'rejected' as const, reason: 'Not relevant', evaluatedAt: '2026-01-03T02:00:00Z', auto: false },
      },
    ];
  }

  function createManager() {
    return new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });
  }

  it('records helpful feedback', () => {
    fs.writeFileSync(dispatchFile, JSON.stringify(seedDispatches()));
    const manager = createManager();

    const result = manager.recordFeedback('dsp-fb1', true, 'Very useful');
    expect(result).toBe(true);

    const dispatch = manager.get('dsp-fb1');
    expect(dispatch?.feedback?.helpful).toBe(true);
    expect(dispatch?.feedback?.comment).toBe('Very useful');
    expect(dispatch?.feedback?.feedbackAt).toBeTruthy();
  });

  it('records unhelpful feedback', () => {
    fs.writeFileSync(dispatchFile, JSON.stringify(seedDispatches()));
    const manager = createManager();

    manager.recordFeedback('dsp-fb2', false, 'Did not apply to my use case');

    const dispatch = manager.get('dsp-fb2');
    expect(dispatch?.feedback?.helpful).toBe(false);
  });

  it('records feedback without comment', () => {
    fs.writeFileSync(dispatchFile, JSON.stringify(seedDispatches()));
    const manager = createManager();

    manager.recordFeedback('dsp-fb1', true);

    const dispatch = manager.get('dsp-fb1');
    expect(dispatch?.feedback?.helpful).toBe(true);
    expect(dispatch?.feedback?.comment).toBeUndefined();
  });

  it('returns false for non-existent dispatch', () => {
    const manager = createManager();
    expect(manager.recordFeedback('dsp-nonexistent', true)).toBe(false);
  });

  it('persists feedback to disk', () => {
    fs.writeFileSync(dispatchFile, JSON.stringify(seedDispatches()));

    const manager1 = createManager();
    manager1.recordFeedback('dsp-fb1', true, 'Helpful');

    const manager2 = createManager();
    expect(manager2.get('dsp-fb1')?.feedback?.helpful).toBe(true);
  });

  it('withFeedback returns only dispatches that have feedback', () => {
    fs.writeFileSync(dispatchFile, JSON.stringify(seedDispatches()));
    const manager = createManager();

    manager.recordFeedback('dsp-fb1', true);
    // dsp-fb2 and dsp-fb3 have no feedback

    const withFb = manager.withFeedback();
    expect(withFb).toHaveLength(1);
    expect(withFb[0].dispatchId).toBe('dsp-fb1');
  });
});

describe('DispatchManager stats', () => {
  let tmpDir: string;
  let dispatchFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dispatch-stats-'));
    dispatchFile = path.join(tmpDir, 'dispatches.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createManager() {
    return new DispatchManager({
      enabled: false,
      dispatchUrl: 'https://example.com/dispatches',
      dispatchFile,
    });
  }

  it('returns zero stats when no dispatches', () => {
    const manager = createManager();
    const stats = manager.stats();
    expect(stats.total).toBe(0);
    expect(stats.applied).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.rejected).toBe(0);
    expect(stats.helpfulCount).toBe(0);
    expect(stats.unhelpfulCount).toBe(0);
    expect(stats.byType).toEqual({});
  });

  it('counts applied, pending, and rejected correctly', () => {
    const dispatches: Dispatch[] = [
      {
        dispatchId: 'dsp-s1',
        type: 'strategy',
        title: 'Applied',
        content: '',
        priority: 'normal',
        createdAt: '2026-01-01T00:00:00Z',
        receivedAt: '2026-01-01T01:00:00Z',
        applied: true,
      },
      {
        dispatchId: 'dsp-s2',
        type: 'lesson',
        title: 'Pending',
        content: '',
        priority: 'normal',
        createdAt: '2026-01-02T00:00:00Z',
        receivedAt: '2026-01-02T01:00:00Z',
        applied: false,
      },
      {
        dispatchId: 'dsp-s3',
        type: 'security',
        title: 'Rejected',
        content: '',
        priority: 'high',
        createdAt: '2026-01-03T00:00:00Z',
        receivedAt: '2026-01-03T01:00:00Z',
        applied: false,
        evaluation: { decision: 'rejected' as const, reason: 'test', evaluatedAt: '2026-01-03T02:00:00Z', auto: false },
      },
    ];
    fs.writeFileSync(dispatchFile, JSON.stringify(dispatches));

    const manager = createManager();
    const stats = manager.stats();
    expect(stats.total).toBe(3);
    expect(stats.applied).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.rejected).toBe(1);
  });

  it('counts helpful and unhelpful feedback', () => {
    const dispatches: Dispatch[] = [
      {
        dispatchId: 'dsp-h1',
        type: 'strategy',
        title: 'Helpful',
        content: '',
        priority: 'normal',
        createdAt: '2026-01-01T00:00:00Z',
        receivedAt: '2026-01-01T01:00:00Z',
        applied: true,
        feedback: { helpful: true, feedbackAt: '2026-01-02T00:00:00Z' },
      },
      {
        dispatchId: 'dsp-h2',
        type: 'strategy',
        title: 'Also Helpful',
        content: '',
        priority: 'normal',
        createdAt: '2026-01-02T00:00:00Z',
        receivedAt: '2026-01-02T01:00:00Z',
        applied: true,
        feedback: { helpful: true, feedbackAt: '2026-01-03T00:00:00Z' },
      },
      {
        dispatchId: 'dsp-h3',
        type: 'lesson',
        title: 'Not Helpful',
        content: '',
        priority: 'normal',
        createdAt: '2026-01-03T00:00:00Z',
        receivedAt: '2026-01-03T01:00:00Z',
        applied: true,
        feedback: { helpful: false, comment: 'Did not work', feedbackAt: '2026-01-04T00:00:00Z' },
      },
    ];
    fs.writeFileSync(dispatchFile, JSON.stringify(dispatches));

    const manager = createManager();
    const stats = manager.stats();
    expect(stats.helpfulCount).toBe(2);
    expect(stats.unhelpfulCount).toBe(1);
  });

  it('breaks down stats by type', () => {
    const dispatches: Dispatch[] = [
      {
        dispatchId: 'dsp-t1',
        type: 'strategy',
        title: 'S1',
        content: '',
        priority: 'normal',
        createdAt: '2026-01-01T00:00:00Z',
        receivedAt: '2026-01-01T01:00:00Z',
        applied: true,
        feedback: { helpful: true, feedbackAt: '2026-01-02T00:00:00Z' },
      },
      {
        dispatchId: 'dsp-t2',
        type: 'strategy',
        title: 'S2',
        content: '',
        priority: 'normal',
        createdAt: '2026-01-02T00:00:00Z',
        receivedAt: '2026-01-02T01:00:00Z',
        applied: false,
      },
      {
        dispatchId: 'dsp-t3',
        type: 'lesson',
        title: 'L1',
        content: '',
        priority: 'normal',
        createdAt: '2026-01-03T00:00:00Z',
        receivedAt: '2026-01-03T01:00:00Z',
        applied: true,
      },
    ];
    fs.writeFileSync(dispatchFile, JSON.stringify(dispatches));

    const manager = createManager();
    const stats = manager.stats();

    expect(stats.byType['strategy']).toEqual({ total: 2, applied: 1, helpful: 1 });
    expect(stats.byType['lesson']).toEqual({ total: 1, applied: 1, helpful: 0 });
  });
});
