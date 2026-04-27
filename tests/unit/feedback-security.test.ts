/**
 * Unit tests for FeedbackManager security features.
 *
 * Covers: identification headers, version injection into payload,
 * User-Agent format, X-Instar-Version header, webhook payload completeness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FeedbackManager } from '../../src/core/FeedbackManager.js';

describe('FeedbackManager security headers', () => {
  let tmpDir: string;
  let feedbackFile: string;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fb-security-'));
    feedbackFile = path.join(tmpDir, 'feedback.json');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends User-Agent header with instar/<version> format', async () => {
    let capturedHeaders: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return { ok: true };
    });

    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
      version: '0.1.12',
    });

    await manager.submit({
      type: 'bug',
      title: 'Test bug',
      description: 'Testing headers',
      agentName: 'test-agent',
      instarVersion: '0.1.12',
      nodeVersion: 'v20.0.0',
      os: 'darwin arm64',
    });

    expect(capturedHeaders['User-Agent']).toMatch(/^instar\/0\.1\.12/);
    expect(capturedHeaders['User-Agent']).toContain('node/');
  });

  it('sends X-Instar-Version header', async () => {
    let capturedHeaders: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return { ok: true };
    });

    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
      version: '0.1.12',
    });

    await manager.submit({
      type: 'feature',
      title: 'Test feature',
      description: 'Testing version header',
      agentName: 'test-agent',
      instarVersion: '0.1.12',
      nodeVersion: 'v20.0.0',
      os: 'linux x64',
    });

    expect(capturedHeaders['X-Instar-Version']).toBe('0.1.12');
  });

  it('uses 0.0.0 as version fallback when not configured', async () => {
    let capturedHeaders: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return { ok: true };
    });

    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
      // No version field
    });

    await manager.submit({
      type: 'bug',
      title: 'No version',
      description: 'Testing fallback',
      agentName: 'test-agent',
      instarVersion: '0.0.0',
      nodeVersion: 'v20.0.0',
      os: 'darwin arm64',
    });

    expect(capturedHeaders['User-Agent']).toMatch(/^instar\/0\.0\.0/);
    expect(capturedHeaders['X-Instar-Version']).toBe('0.0.0');
  });

  it('always sends Content-Type application/json', async () => {
    let capturedHeaders: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return { ok: true };
    });

    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
      version: '1.0.0',
    });

    await manager.submit({
      type: 'improvement',
      title: 'Content type check',
      description: 'Verifying content type',
      agentName: 'test-agent',
      instarVersion: '1.0.0',
      nodeVersion: 'v22.0.0',
      os: 'win32 x64',
    });

    expect(capturedHeaders['Content-Type']).toBe('application/json');
  });
});

describe('FeedbackManager webhook payload completeness', () => {
  let tmpDir: string;
  let feedbackFile: string;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fb-payload-'));
    feedbackFile = path.join(tmpDir, 'feedback.json');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends feedbackId (not id) in payload', async () => {
    let capturedPayload: string = '';

    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedPayload = opts.body;
      return { ok: true };
    });

    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
      version: '0.1.12',
    });

    await manager.submit({
      type: 'bug',
      title: 'Payload shape test',
      description: 'Verifying feedbackId field name',
      agentName: 'test-agent',
      instarVersion: '0.1.12',
      nodeVersion: 'v20.0.0',
      os: 'darwin arm64',
    });

    const parsed = JSON.parse(capturedPayload);
    expect(parsed.feedbackId).toBeTruthy();
    expect(parsed.feedbackId).toMatch(/^fb-/);
    // Old field name should not be present
    expect(parsed.id).toBeUndefined();
  });

  it('includes all identification fields in payload', async () => {
    let capturedPayload: string = '';

    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedPayload = opts.body;
      return { ok: true };
    });

    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
      version: '0.1.12',
    });

    await manager.submit({
      type: 'bug',
      title: 'Full payload test',
      description: 'All fields should be present',
      agentName: 'my-cool-agent',
      instarVersion: '0.1.12',
      nodeVersion: 'v20.11.0',
      os: 'linux arm64',
      context: 'Some error context here',
    });

    const parsed = JSON.parse(capturedPayload);
    expect(parsed.feedbackId).toMatch(/^fb-/);
    expect(parsed.type).toBe('bug');
    expect(parsed.title).toBe('Full payload test');
    expect(parsed.description).toBe('All fields should be present');
    expect(parsed.agentName).toBe('my-cool-agent');
    expect(parsed.instarVersion).toBe('0.1.12');
    expect(parsed.nodeVersion).toBeTruthy(); // Uses process.version
    expect(parsed.os).toBe('linux arm64');
    expect(parsed.context).toBe('Some error context here');
    expect(parsed.submittedAt).toBeTruthy();
  });

  it('does not include internal-only forwarded field', async () => {
    let capturedPayload: string = '';

    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedPayload = opts.body;
      return { ok: true };
    });

    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
      version: '0.1.12',
    });

    await manager.submit({
      type: 'feature',
      title: 'No internal fields',
      description: 'Forwarded should not leak',
      agentName: 'test-agent',
      instarVersion: '0.1.12',
      nodeVersion: 'v20.0.0',
      os: 'darwin',
    });

    const parsed = JSON.parse(capturedPayload);
    expect(parsed.forwarded).toBeUndefined();
  });

  it('sends same headers for retryUnforwarded', async () => {
    // First: submit with broken webhook
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

    const manager = new FeedbackManager({
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
      version: '0.2.0',
    });

    await manager.submit({
      type: 'bug',
      title: 'Retry test',
      description: 'Will be retried',
      agentName: 'retry-agent',
      instarVersion: '0.2.0',
      nodeVersion: 'v22.0.0',
      os: 'linux x64',
    });

    // Now: mock fetch to succeed and capture headers
    let capturedHeaders: Record<string, string> = {};
    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return { ok: true };
    });

    await manager.retryUnforwarded();

    expect(capturedHeaders['User-Agent']).toMatch(/^instar\/0\.2\.0/);
    expect(capturedHeaders['X-Instar-Version']).toBe('0.2.0');
  });
});
