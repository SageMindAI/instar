/**
 * Unit tests for TelegramBridge — the threadline → telegram relay.
 *
 * The bridge has three failure-mode contracts that we pin here:
 *   1. Default-OFF — when the bridge config has enabled=false, NOTHING posts.
 *   2. Auto-create gate — without an allow-list match (or autoCreateTopics=true),
 *      a brand-new thread does NOT spawn a Telegram topic.
 *   3. Relay-only — the bridge never throws to the caller, even when the
 *      Telegram sink fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { TelegramBridgeConfig } from '../../src/threadline/TelegramBridgeConfig.js';
import { TelegramBridge, MAX_BRIDGE_MESSAGE_BODY, type TelegramSink } from '../../src/threadline/TelegramBridge.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TopicCall { name: string; iconColor?: number }
interface SendCall { topicId: number; text: string }

function createFakeSink(opts?: { failCreate?: boolean; failSend?: boolean }): TelegramSink & { topicCalls: TopicCall[]; sendCalls: SendCall[]; counter: number } {
  let counter = 100;
  const topics = new Map<string, number>();
  const topicCalls: TopicCall[] = [];
  const sendCalls: SendCall[] = [];
  const sink: TelegramSink & { topicCalls: TopicCall[]; sendCalls: SendCall[]; counter: number } = {
    topicCalls,
    sendCalls,
    counter: 0,
    async findOrCreateForumTopic(name, iconColor) {
      topicCalls.push({ name, iconColor });
      if (opts?.failCreate) throw new Error('telegram-down');
      const existing = topics.get(name);
      if (existing !== undefined) return { topicId: existing, name, reused: true };
      counter += 1;
      topics.set(name, counter);
      return { topicId: counter, name, reused: false };
    },
    async sendToTopic(topicId, text) {
      sendCalls.push({ topicId, text });
      if (opts?.failSend) throw new Error('telegram-send-down');
      return { ok: true, messageId: counter * 10 };
    },
  };
  return sink;
}

function createBridge(opts?: { configPatch?: Partial<{ enabled: boolean; autoCreateTopics: boolean; mirrorExisting: boolean; allowList: string[]; denyList: string[] }>; sink?: ReturnType<typeof createFakeSink> }): {
  bridge: TelegramBridge;
  cfg: TelegramBridgeConfig;
  sink: ReturnType<typeof createFakeSink>;
  cleanup: () => void;
  stateDir: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bridge-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ projectName: 'test' }, null, 2));
  const live = new LiveConfig(dir);
  const cfg = new TelegramBridgeConfig(live);
  if (opts?.configPatch) cfg.update(opts.configPatch);
  const sink = opts?.sink ?? createFakeSink();
  const bridge = new TelegramBridge({
    stateDir: dir,
    localAgentName: 'echo',
    config: cfg,
    telegram: sink,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return {
    bridge,
    cfg,
    sink,
    cleanup: () => { live.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/TelegramBridge.test.ts' }); },
    stateDir: dir,
  };
}

describe('TelegramBridge', () => {
  let env: ReturnType<typeof createBridge>;

  afterEach(() => env?.cleanup());

  // ── Default-OFF — ZERO posts when bridge is disabled ────────────

  describe('default-OFF (master switch)', () => {
    it('does not create a topic for inbound when bridge is disabled', async () => {
      env = createBridge();
      const result = await env.bridge.mirrorInbound({
        threadId: 't1', remoteAgent: 'fp-dawn', remoteAgentName: 'Dawn', text: 'hello',
      });
      expect(result.posted).toBe(false);
      expect(result.reason).toBe('bridge-disabled');
      expect(env.sink.topicCalls).toHaveLength(0);
      expect(env.sink.sendCalls).toHaveLength(0);
    });

    it('does not post outbound when bridge is disabled', async () => {
      env = createBridge();
      const result = await env.bridge.mirrorOutbound({
        threadId: 't1', remoteAgent: 'fp-dawn', text: 'hi back',
      });
      expect(result.posted).toBe(false);
      expect(env.sink.sendCalls).toHaveLength(0);
    });
  });

  // ── Auto-create gate ────────────────────────────────────────────

  describe('auto-create gate (allow-list / deny-list / autoCreateTopics)', () => {
    it('does NOT auto-create a topic when enabled but autoCreateTopics=false (and not allow-listed)', async () => {
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: false } });
      const result = await env.bridge.mirrorInbound({
        threadId: 't1', remoteAgent: 'fp-stranger', remoteAgentName: 'Stranger', text: 'hello',
      });
      expect(result.posted).toBe(false);
      expect(result.reason).toBe('auto-create-disallowed');
      expect(env.sink.topicCalls).toHaveLength(0);
    });

    it('auto-creates when enabled + autoCreateTopics=true', async () => {
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: true } });
      const result = await env.bridge.mirrorInbound({
        threadId: 't1', remoteAgent: 'fp-dawn', remoteAgentName: 'Dawn', text: 'first contact',
      });
      expect(result.posted).toBe(true);
      expect(result.topicId).toBe(101);
      expect(env.sink.topicCalls).toHaveLength(1);
      expect(env.sink.sendCalls).toHaveLength(1);
    });

    it('auto-creates for an allow-listed remote even when autoCreateTopics=false', async () => {
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: false, allowList: ['Dawn'] } });
      const result = await env.bridge.mirrorInbound({
        threadId: 't1', remoteAgent: 'fp-dawn', remoteAgentName: 'Dawn', text: 'allow-listed',
      });
      expect(result.posted).toBe(true);
      expect(env.sink.topicCalls).toHaveLength(1);
    });

    it('matches allow-list by fingerprint OR name', async () => {
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: false, allowList: ['fp-ada'] } });
      const result = await env.bridge.mirrorInbound({
        threadId: 't1', remoteAgent: 'fp-ada', remoteAgentName: 'Ada', text: 'hi',
      });
      expect(result.posted).toBe(true);
    });

    it('does NOT auto-create for a deny-listed remote (with autoCreateTopics=true)', async () => {
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: true, denyList: ['Spammer'] } });
      const result = await env.bridge.mirrorInbound({
        threadId: 't1', remoteAgent: 'fp-spam', remoteAgentName: 'Spammer', text: 'noise',
      });
      expect(result.posted).toBe(false);
      expect(result.reason).toBe('auto-create-disallowed');
    });
  });

  // ── Existing-topic mirroring ───────────────────────────────────

  describe('existing-topic mirroring', () => {
    it('mirrors inbound into an existing topic regardless of allow/deny-list', async () => {
      // Seed a topic via auto-create, then deny-list, then send another inbound
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: true } });
      await env.bridge.mirrorInbound({ threadId: 't1', remoteAgent: 'fp-dawn', remoteAgentName: 'Dawn', text: 'first' });
      env.cfg.update({ autoCreateTopics: false, denyList: ['Dawn'] });

      const result = await env.bridge.mirrorInbound({
        threadId: 't1', remoteAgent: 'fp-dawn', remoteAgentName: 'Dawn', text: 'follow-up',
      });
      expect(result.posted).toBe(true);
      // Two send calls (one auto-create + one mirror), one topic create
      expect(env.sink.topicCalls).toHaveLength(1);
      expect(env.sink.sendCalls).toHaveLength(2);
    });

    it('does NOT mirror into existing topic when mirrorExisting is off', async () => {
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: true } });
      await env.bridge.mirrorInbound({ threadId: 't1', remoteAgent: 'fp-d', remoteAgentName: 'Dawn', text: 'first' });
      env.cfg.update({ mirrorExisting: false });

      const result = await env.bridge.mirrorInbound({
        threadId: 't1', remoteAgent: 'fp-d', remoteAgentName: 'Dawn', text: 'should not mirror',
      });
      expect(result.posted).toBe(false);
      expect(result.reason).toBe('mirror-disabled');
    });

    it('outbound mirrors into existing topic and never auto-creates', async () => {
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: true } });
      await env.bridge.mirrorInbound({ threadId: 't1', remoteAgent: 'fp-d', remoteAgentName: 'Dawn', text: 'inbound' });

      const result = await env.bridge.mirrorOutbound({
        threadId: 't1', remoteAgent: 'fp-d', remoteAgentName: 'Dawn', text: 'reply', outcome: 'accepted',
      });
      expect(result.posted).toBe(true);
      expect(env.sink.sendCalls).toHaveLength(2); // inbound + outbound

      // Outbound to a thread without a binding → nothing
      const result2 = await env.bridge.mirrorOutbound({
        threadId: 't-orphan', remoteAgent: 'fp-x', text: 'nope',
      });
      expect(result2.posted).toBe(false);
      expect(result2.reason).toBe('no-binding');
    });
  });

  // ── Bindings persistence ───────────────────────────────────────

  describe('bindings persistence', () => {
    it('persists bindings across instances (survives restart)', async () => {
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: true } });
      await env.bridge.mirrorInbound({ threadId: 't42', remoteAgent: 'fp-x', remoteAgentName: 'X', text: 'hi' });
      const stateDir = env.stateDir;
      const cfg = env.cfg;
      const sink = env.sink;

      const bridge2 = new TelegramBridge({
        stateDir, localAgentName: 'echo', config: cfg, telegram: sink,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      });
      const binding = bridge2.getBindingForThread('t42');
      expect(binding).not.toBeNull();
      expect(binding!.topicId).toBe(101);
      expect(binding!.remoteAgent).toBe('fp-x');
    });

    it('writes bindings file with 0o600 perms', async () => {
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: true } });
      await env.bridge.mirrorInbound({ threadId: 't1', remoteAgent: 'fp-x', text: 'hi' });
      const bindingsPath = path.join(env.stateDir, 'threadline', 'telegram-bridge-bindings.json');
      expect(fs.existsSync(bindingsPath)).toBe(true);
      const stats = fs.statSync(bindingsPath);
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  // ── Topic naming ───────────────────────────────────────────────

  describe('topic naming', () => {
    it('builds the documented "echo↔Remote — subject" pattern', () => {
      env = createBridge();
      expect(env.bridge.buildTopicName('Dawn', 'memory rot gates')).toBe('echo↔Dawn — memory rot gates');
    });

    it('truncates long subjects with an ellipsis to fit Telegram limits', () => {
      env = createBridge();
      const longSubject = 'a'.repeat(200);
      const name = env.bridge.buildTopicName('Dawn', longSubject);
      expect(name.length).toBeLessThanOrEqual(96);
      expect(name).toMatch(/echo↔Dawn — a+…/);
    });

    it('falls back to "thread" subject when none provided', () => {
      env = createBridge();
      expect(env.bridge.buildTopicName('Dawn')).toBe('echo↔Dawn — thread');
    });
  });

  // ── Failure tolerance — the bridge never throws to the caller ──

  describe('relay-only failure tolerance', () => {
    it('does not throw when topic creation fails', async () => {
      const sink = createFakeSink({ failCreate: true });
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: true }, sink });
      const result = await env.bridge.mirrorInbound({
        threadId: 't1', remoteAgent: 'fp-x', remoteAgentName: 'X', text: 'hi',
      });
      expect(result.posted).toBe(false);
      expect(result.reason).toBe('create-topic-failed');
      // No binding written (topic create failed)
      expect(env.bridge.getBindingForThread('t1')).toBeNull();
    });

    it('does not throw when sendToTopic fails on existing binding', async () => {
      const sink = createFakeSink();
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: true }, sink });
      await env.bridge.mirrorInbound({ threadId: 't1', remoteAgent: 'fp-x', remoteAgentName: 'X', text: 'hi' });
      // Now make sendToTopic fail
      sink.sendToTopic = vi.fn().mockRejectedValue(new Error('boom'));
      const result = await env.bridge.mirrorInbound({
        threadId: 't1', remoteAgent: 'fp-x', remoteAgentName: 'X', text: 'follow-up',
      });
      // Decision was to post; underlying call failed but bridge swallowed
      expect(result.posted).toBe(true);
    });

    it('truncates long bodies with an ellipsis', async () => {
      env = createBridge({ configPatch: { enabled: true, autoCreateTopics: true } });
      const longText = 'x'.repeat(MAX_BRIDGE_MESSAGE_BODY + 1000);
      await env.bridge.mirrorInbound({
        threadId: 't1', remoteAgent: 'fp-x', remoteAgentName: 'X', text: longText,
      });
      const sent = env.sink.sendCalls[0]!;
      // Body includes a head line + truncated text; total length <= MAX + head room
      expect(sent.text.length).toBeLessThanOrEqual(MAX_BRIDGE_MESSAGE_BODY + 200);
      expect(sent.text).toMatch(/…$/);
    });
  });
});
