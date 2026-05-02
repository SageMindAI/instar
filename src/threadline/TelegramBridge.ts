/**
 * TelegramBridge — mirrors threadline messages into per-thread Telegram topics.
 *
 * The bridge gives Justin visibility into agent-to-agent conversations:
 * every inbound and outbound threadline message gets relayed into a
 * dedicated Telegram topic so he can watch the exchange in real time.
 *
 * **Relay-only.** The bridge is a pure observer — it never blocks, gates,
 * or vetoes a message. The blocking authority lives in TelegramBridgeConfig
 * (the dashboard toggles + allow/deny list). The bridge simply asks the
 * config "should I post?" and, if yes, posts.
 *
 * **No double-fire.** The bridge does NOT use the existing `telegram-reply`
 * pipeline (which is for agent → user replies). It writes directly through
 * the TelegramAdapter primitives `findOrCreateForumTopic` + `sendToTopic`,
 * and persists thread → topic bindings in
 * `.instar/threadline/telegram-bridge-bindings.json`.
 *
 * **Does NOT replace spawn-session.** The relay handler in server.ts still
 * spawns Claude Code sessions for inbound messages. The bridge runs
 * alongside that path; it's purely additive for user visibility.
 *
 * Topic naming: `{localAgent}↔{remoteAgentName} — {subject}` (truncated to
 * Telegram's 128-char limit). Subject defaults to the first ~40 chars of
 * the inbound message when no explicit subject is supplied.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TelegramBridgeConfig } from './TelegramBridgeConfig.js';

// Topic-name length cap: Telegram allows 128 chars, we leave headroom.
const MAX_TOPIC_NAME = 96;
// Per-message body cap: Telegram messages are 4096 chars; leave headroom for prefix lines.
export const MAX_BRIDGE_MESSAGE_BODY = 3800;

export interface TelegramBridgeBinding {
  threadId: string;
  topicId: number;
  remoteAgent: string;
  topicName: string;
  createdAt: string;
  lastMessageAt: string;
}

export interface TelegramBridgeBindingsFile {
  version: 1;
  bindings: TelegramBridgeBinding[];
}

/** Subset of TelegramAdapter the bridge needs — keeps tests easy to mock. */
export interface TelegramSink {
  findOrCreateForumTopic(
    name: string,
    iconColor?: number,
  ): Promise<{ topicId: number; name: string; reused: boolean }>;
  sendToTopic(
    topicId: number,
    text: string,
    options?: { silent?: boolean; skipStallClear?: boolean },
  ): Promise<{ ok: boolean; messageId?: number; reason?: string } | unknown>;
}

export interface BridgeInboundEvent {
  threadId: string;
  remoteAgent: string;
  remoteAgentName?: string;
  text: string;
  subject?: string;
  messageId?: string;
  timestamp?: string;
}

export interface BridgeOutboundEvent {
  threadId: string;
  remoteAgent: string;
  remoteAgentName?: string;
  text: string;
  messageId?: string;
  timestamp?: string;
  /** Optional preview of the agent reply being mirrored (e.g. truncated body). */
  outcome?: string;
}

export interface TelegramBridgeOptions {
  stateDir: string;
  localAgentName: string;
  config: TelegramBridgeConfig;
  telegram: TelegramSink;
  /** Optional override for the bindings filename (testing). */
  bindingsFilename?: string;
  /** Logger; defaults to console. */
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export class TelegramBridge {
  private readonly stateDir: string;
  private readonly bindingsPath: string;
  private readonly localAgentName: string;
  private readonly cfg: TelegramBridgeConfig;
  private readonly telegram: TelegramSink;
  private readonly log: NonNullable<TelegramBridgeOptions['log']>;
  private bindings = new Map<string, TelegramBridgeBinding>(); // threadId → binding

  constructor(opts: TelegramBridgeOptions) {
    this.stateDir = opts.stateDir;
    this.localAgentName = opts.localAgentName;
    this.cfg = opts.config;
    this.telegram = opts.telegram;
    this.log = opts.log ?? {
      info: (m) => console.log(`[tg-bridge] ${m}`),
      warn: (m) => console.warn(`[tg-bridge] ${m}`),
      error: (m) => console.error(`[tg-bridge] ${m}`),
    };
    this.bindingsPath = path.join(
      opts.stateDir,
      'threadline',
      opts.bindingsFilename ?? 'telegram-bridge-bindings.json',
    );
    this.loadBindings();
  }

  // ── Bindings persistence ───────────────────────────────────────

  private loadBindings(): void {
    try {
      if (!fs.existsSync(this.bindingsPath)) return;
      const raw = fs.readFileSync(this.bindingsPath, 'utf-8');
      const parsed = JSON.parse(raw) as TelegramBridgeBindingsFile;
      for (const b of parsed.bindings ?? []) {
        if (b.threadId && typeof b.topicId === 'number') {
          this.bindings.set(b.threadId, b);
        }
      }
    } catch (err) {
      this.log.warn(`Could not load bindings file (${err instanceof Error ? err.message : err}); starting fresh.`);
    }
  }

  private persistBindings(): void {
    try {
      const dir = path.dirname(this.bindingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file: TelegramBridgeBindingsFile = {
        version: 1,
        bindings: Array.from(this.bindings.values()),
      };
      fs.writeFileSync(this.bindingsPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log.warn(`Could not persist bindings file (${err instanceof Error ? err.message : err}).`);
    }
  }

  /** Public for inspection (dashboard, observability tab). */
  getBindings(): TelegramBridgeBinding[] {
    return Array.from(this.bindings.values());
  }

  /** Public for the observability tab to query a single binding. */
  getBindingForThread(threadId: string): TelegramBridgeBinding | null {
    return this.bindings.get(threadId) ?? null;
  }

  // ── Topic naming ───────────────────────────────────────────────

  /** Build the topic name for a thread — used at create time. Exposed for tests. */
  buildTopicName(remoteAgentName: string, subject?: string): string {
    const baseSubject = (subject ?? 'thread').trim().replace(/\s+/g, ' ');
    const head = `${this.localAgentName}↔${remoteAgentName}`;
    const sep = ' — ';
    const remaining = MAX_TOPIC_NAME - head.length - sep.length;
    const trimmedSubject = remaining > 4 && baseSubject.length > remaining
      ? baseSubject.slice(0, remaining - 1) + '…'
      : baseSubject;
    return `${head}${sep}${trimmedSubject}`.slice(0, MAX_TOPIC_NAME);
  }

  // ── Mirror inbound ─────────────────────────────────────────────

  /**
   * Mirror an inbound threadline message into Telegram.
   *
   * Decision tree:
   *   1. If the bridge config disallows mirroring AND no existing topic
   *      → no-op.
   *   2. If a topic exists for this thread → post (subject to mirrorExisting).
   *   3. Else (no existing topic) → check shouldAutoCreateTopic; if yes,
   *      create + post; else no-op.
   *
   * Failure-tolerant — never throws. Returns `{posted, topicId}` for
   * observability.
   */
  async mirrorInbound(evt: BridgeInboundEvent): Promise<{ posted: boolean; topicId?: number; reason?: string }> {
    const settings = this.cfg.getSettings();
    if (!settings.enabled) return { posted: false, reason: 'bridge-disabled' };

    const existing = this.bindings.get(evt.threadId);
    if (existing) {
      if (!this.cfg.shouldMirrorIntoExistingTopic()) {
        return { posted: false, reason: 'mirror-disabled' };
      }
      const body = this.formatInboundBody(evt);
      await this.postSafe(existing.topicId, body, evt.threadId);
      return { posted: true, topicId: existing.topicId };
    }

    // No existing binding — check whether we may auto-create. Both the
    // remote fingerprint AND the human-readable name are consulted; the
    // deny-list and allow-list short-circuits are evaluated across the
    // union, so a deny match on EITHER id blocks auto-create even when
    // autoCreateTopics is on. (Fingerprint-only allow-list with a
    // human-name deny-list, or vice versa, still produces a single
    // consistent decision.)
    const remoteId = evt.remoteAgent;
    const matcher = evt.remoteAgentName ?? remoteId;
    const ids = Array.from(new Set([remoteId, matcher].filter(Boolean) as string[]));
    const inAllowList = ids.some(id => settings.allowList.includes(id));
    const inDenyList = ids.some(id => settings.denyList.includes(id));
    const allow = inAllowList || (!inDenyList && settings.autoCreateTopics);
    if (!allow) return { posted: false, reason: 'auto-create-disallowed' };

    const topicName = this.buildTopicName(matcher, evt.subject ?? evt.text);
    let topicId: number | undefined;
    try {
      const created = await this.telegram.findOrCreateForumTopic(topicName);
      topicId = created.topicId;
      this.bindings.set(evt.threadId, {
        threadId: evt.threadId,
        topicId,
        remoteAgent: remoteId,
        topicName: created.name,
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });
      this.persistBindings();
    } catch (err) {
      this.log.warn(`mirrorInbound: could not create topic "${topicName}" — ${err instanceof Error ? err.message : err}`);
      return { posted: false, reason: 'create-topic-failed' };
    }

    const body = this.formatInboundBody(evt);
    await this.postSafe(topicId, body, evt.threadId);
    return { posted: true, topicId };
  }

  // ── Mirror outbound ────────────────────────────────────────────

  /**
   * Mirror an outbound threadline message (sent via threadline_send) into
   * the corresponding Telegram topic. Outbound mirroring requires an
   * existing binding — outbound traffic alone never auto-creates topics
   * (the user opted in via inbound or by manual action).
   */
  async mirrorOutbound(evt: BridgeOutboundEvent): Promise<{ posted: boolean; topicId?: number; reason?: string }> {
    if (!this.cfg.shouldMirrorIntoExistingTopic()) {
      return { posted: false, reason: 'mirror-disabled' };
    }
    const binding = this.bindings.get(evt.threadId);
    if (!binding) return { posted: false, reason: 'no-binding' };

    const body = this.formatOutboundBody(evt);
    await this.postSafe(binding.topicId, body, evt.threadId);
    return { posted: true, topicId: binding.topicId };
  }

  // ── Body formatters ────────────────────────────────────────────

  private formatInboundBody(evt: BridgeInboundEvent): string {
    const name = evt.remoteAgentName ?? evt.remoteAgent.slice(0, 8);
    const head = `📥 ${name} → ${this.localAgentName}`;
    const text = truncateBody(evt.text);
    const meta = evt.messageId ? `\nmsg: ${evt.messageId}` : '';
    return `${head}\n${text}${meta}`;
  }

  private formatOutboundBody(evt: BridgeOutboundEvent): string {
    const name = evt.remoteAgentName ?? evt.remoteAgent.slice(0, 8);
    const head = `📤 ${this.localAgentName} → ${name}`;
    const text = truncateBody(evt.text);
    const meta = evt.outcome ? `\noutcome: ${evt.outcome}` : '';
    return `${head}\n${text}${meta}`;
  }

  // ── Post (failure-tolerant) ────────────────────────────────────

  private async postSafe(topicId: number, body: string, threadId: string): Promise<void> {
    try {
      await this.telegram.sendToTopic(topicId, body, { silent: true, skipStallClear: true });
      const binding = this.bindings.get(threadId);
      if (binding) {
        binding.lastMessageAt = new Date().toISOString();
        this.persistBindings();
      }
    } catch (err) {
      this.log.warn(`postSafe: failed for topic ${topicId} thread ${threadId.slice(0, 8)} — ${err instanceof Error ? err.message : err}`);
    }
  }
}

function truncateBody(text: string): string {
  if (text.length <= MAX_BRIDGE_MESSAGE_BODY) return text;
  return text.slice(0, MAX_BRIDGE_MESSAGE_BODY - 1) + '…';
}
