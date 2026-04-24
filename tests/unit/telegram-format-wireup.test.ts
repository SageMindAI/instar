/**
 * PR2 wire-up tests — verify the formatter runs inside both Bot API chokepoints
 * (TelegramAdapter.apiCall, TelegramLifeline.apiCall) exactly where the spec
 * says, and that `'legacy-passthrough'` preserves byte-for-byte behavior.
 *
 * Spec: docs/specs/TELEGRAM-MARKDOWN-RENDERER-SPEC.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter, applyTelegramFormatter } from '../../src/messaging/TelegramAdapter.js';
import { resetFormatMetrics, getFormatMetricsSnapshot } from '../../src/messaging/telegramFormatMetrics.js';

describe('applyTelegramFormatter (pure wire-up helper)', () => {
  beforeEach(() => resetFormatMetrics());

  it('bypasses formatter for non-send methods', () => {
    const r = applyTelegramFormatter('getUpdates', { offset: 1 }, 'markdown');
    expect(r.didFormat).toBe(false);
    expect(r.outgoingParams).toEqual({ offset: 1 });
  });

  it('bypasses formatter in legacy-passthrough mode (byte-for-byte)', () => {
    const params = { text: '**bold**', chat_id: '1', parse_mode: 'Markdown' };
    const r = applyTelegramFormatter('sendMessage', params, 'legacy-passthrough');
    expect(r.didFormat).toBe(false);
    expect(r.outgoingParams.text).toBe('**bold**');
    expect(r.outgoingParams.parse_mode).toBe('Markdown');
  });

  it('bypasses formatter when mode is undefined (config not set)', () => {
    const params = { text: '**bold**', chat_id: '1', parse_mode: 'Markdown' };
    const r = applyTelegramFormatter('sendMessage', params, undefined);
    expect(r.didFormat).toBe(false);
    expect(r.outgoingParams.text).toBe('**bold**');
    expect(r.outgoingParams.parse_mode).toBe('Markdown');
  });

  it('runs formatter for sendMessage in markdown mode and overrides parse_mode', () => {
    const params = { text: '**bold**', chat_id: '1', parse_mode: 'Markdown' };
    const r = applyTelegramFormatter('sendMessage', params, 'markdown');
    expect(r.didFormat).toBe(true);
    expect(r.outgoingParams.text).toBe('<b>bold</b>');
    expect(r.outgoingParams.parse_mode).toBe('HTML');
    const snap = getFormatMetricsSnapshot();
    expect(snap.formatAppliedTotal.markdown).toBe(1);
  });

  it('runs formatter for editMessageText too', () => {
    const r = applyTelegramFormatter('editMessageText',
      { text: '**x**', chat_id: '1', message_id: 9 },
      'markdown');
    expect(r.didFormat).toBe(true);
    expect(r.outgoingParams.text).toBe('<b>x</b>');
  });

  it('honors plain mode', () => {
    const r = applyTelegramFormatter('sendMessage', { text: '**x**' }, 'plain');
    expect(r.outgoingParams.parse_mode).toBe('HTML');
    // plain strips markdown tokens but HTML-escapes the result
    expect(r.outgoingParams.text).not.toContain('**');
  });

  it('honors code mode — wraps in <pre>', () => {
    const r = applyTelegramFormatter('sendMessage', { text: 'x' }, 'code');
    expect(r.outgoingParams.text).toBe('<pre>x</pre>');
    expect(r.outgoingParams.parse_mode).toBe('HTML');
  });

  it('does NOT re-format when _isPlainRetry flag is set (recursion guard)', () => {
    const params = { text: '**x**', _isPlainRetry: true };
    const r = applyTelegramFormatter('sendMessage', params, 'markdown');
    expect(r.didFormat).toBe(false);
    expect(r.isPlainRetry).toBe(true);
    expect(r.outgoingParams.text).toBe('**x**');
    // _isPlainRetry should be stripped before going to Bot API
    expect((r.outgoingParams as Record<string, unknown>)._isPlainRetry).toBeUndefined();
  });

  it('strips internal _idempotencyKey flag from outgoing params', () => {
    const r = applyTelegramFormatter('sendMessage',
      { text: 'x', _idempotencyKey: 'key1' } as Record<string, unknown>,
      'legacy-passthrough');
    expect((r.outgoingParams as Record<string, unknown>)._idempotencyKey).toBeUndefined();
  });

  it('records lint issue counters when formatter reports them', () => {
    applyTelegramFormatter('sendMessage', { text: '**bold**' }, 'markdown');
    const snap = getFormatMetricsSnapshot();
    // The formatter's lintTelegramMarkdown emits canonical prose for bold.
    const keys = Object.keys(snap.formatLintIssuesTotal);
    expect(keys.some(k => k.includes('bold'))).toBe(true);
  });
});

describe('TelegramAdapter — formatter wire-up in apiCall', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fmt-wire-'));
    resetFormatMetrics();
  });

  afterEach(async () => {
    if (adapter) await adapter.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('legacy-passthrough (default): preserves per-callsite parse_mode byte-for-byte', async () => {
    adapter = new TelegramAdapter(
      { token: 't', chatId: '-1001', getFormatMode: () => 'legacy-passthrough' },
      tmpDir,
    );
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await adapter.send({
      userId: 'u',
      content: '**bold** still literal',
      channel: { type: 'telegram', identifier: '42' },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toBe('**bold** still literal');
    expect(body.parse_mode).toBe('Markdown'); // from the Markdown callsite in send()
  });

  it('markdown mode: converts **bold** to <b>bold</b> and sets parse_mode=HTML', async () => {
    adapter = new TelegramAdapter(
      { token: 't', chatId: '-1001', getFormatMode: () => 'markdown' },
      tmpDir,
    );
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 2 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await adapter.send({
      userId: 'u',
      content: '**bold**',
      channel: { type: 'telegram', identifier: '42' },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toBe('<b>bold</b>');
    expect(body.parse_mode).toBe('HTML');
  });

  it('400 response triggers plain-retry with raw text and increments fallback counter', async () => {
    adapter = new TelegramAdapter(
      { token: 't', chatId: '-1001', getFormatMode: () => 'markdown' },
      tmpDir,
    );
    // First call returns 400, second call (retry) returns 200.
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"ok":false,"description":"can\'t parse entities"}',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 3 } }),
      });
    vi.stubGlobal('fetch', mockFetch);

    // send() catches 400 and retries WITHOUT parse_mode; that's the existing
    // adapter-level retry. The apiCall-level plain-retry fires first (formatter
    // fallback) before the send()-level retry. Either way, mockFetch is called
    // at least twice and the retry body uses the RAW text, not re-formatted.
    await adapter.send({
      userId: 'u',
      content: '**bold**',
      channel: { type: 'telegram', identifier: '42' },
    });

    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(firstBody.text).toBe('<b>bold</b>');
    expect(firstBody.parse_mode).toBe('HTML');
    // Retry uses the raw (pre-format) text and drops parse_mode.
    expect(retryBody.text).toBe('**bold**');
    expect(retryBody.parse_mode).toBeUndefined();
    expect(getFormatMetricsSnapshot().formatFallbackPlainRetryTotal).toBeGreaterThanOrEqual(1);
  });

  it('hot-reloads: changing the accessor return value flips behavior without restart', async () => {
    let mode: 'legacy-passthrough' | 'markdown' = 'legacy-passthrough';
    adapter = new TelegramAdapter(
      { token: 't', chatId: '-1001', getFormatMode: () => mode },
      tmpDir,
    );
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 10 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await adapter.send({
      userId: 'u',
      content: '**x**',
      channel: { type: 'telegram', identifier: '42' },
    });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).text).toBe('**x**');

    // Flip the closure mid-session — no restart.
    mode = 'markdown';

    await adapter.send({
      userId: 'u',
      content: '**x**',
      channel: { type: 'telegram', identifier: '42' },
    });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).text).toBe('<b>x</b>');
  });
});
