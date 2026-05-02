/**
 * TelegramBridgeConfig — settings surface for the threadline → telegram bridge.
 *
 * The bridge mirrors threadline messages into per-thread Telegram topics so the
 * user has visibility into agent-to-agent conversations. To avoid noise, all
 * topic-creating behavior is gated by user-controlled toggles. This class is
 * the single source of truth for those toggles and the per-remote-agent
 * allow/deny list.
 *
 * Stored under `threadline.telegramBridge` in the agent's `.instar/config.json`.
 * Reads and writes go through LiveConfig so changes from the dashboard are
 * picked up without a server restart.
 *
 * Defaults — the noise budget:
 *   enabled            = false   master kill-switch (default OFF)
 *   autoCreateTopics   = false   never spawn a brand-new topic unless an allow-list entry says so
 *   mirrorExisting     = true    once a topic exists for a thread, mirror traffic into it
 *   allowList          = []      remote-agent identifiers that always get auto-created topics
 *   denyList           = []      remote-agent identifiers that never get auto-created topics
 *
 * Allow-list takes precedence over deny-list when both contain the same id.
 */

import { EventEmitter } from 'node:events';
import type { LiveConfig } from '../config/LiveConfig.js';

export interface TelegramBridgeSettings {
  enabled: boolean;
  autoCreateTopics: boolean;
  mirrorExisting: boolean;
  allowList: string[];
  denyList: string[];
}

export const DEFAULT_TELEGRAM_BRIDGE_SETTINGS: TelegramBridgeSettings = {
  enabled: false,
  autoCreateTopics: false,
  mirrorExisting: true,
  allowList: [],
  denyList: [],
};

const KEY_ENABLED = 'threadline.telegramBridge.enabled';
const KEY_AUTO_CREATE = 'threadline.telegramBridge.autoCreateTopics';
const KEY_MIRROR_EXISTING = 'threadline.telegramBridge.mirrorExisting';
const KEY_ALLOW_LIST = 'threadline.telegramBridge.allowList';
const KEY_DENY_LIST = 'threadline.telegramBridge.denyList';

export type TelegramBridgeConfigChangeEvent = {
  field: keyof TelegramBridgeSettings;
  before: unknown;
  after: unknown;
};

export class TelegramBridgeConfig extends EventEmitter {
  constructor(private readonly liveConfig: LiveConfig) {
    super();
  }

  getSettings(): TelegramBridgeSettings {
    return {
      enabled: this.liveConfig.get<boolean>(KEY_ENABLED, DEFAULT_TELEGRAM_BRIDGE_SETTINGS.enabled),
      autoCreateTopics: this.liveConfig.get<boolean>(KEY_AUTO_CREATE, DEFAULT_TELEGRAM_BRIDGE_SETTINGS.autoCreateTopics),
      mirrorExisting: this.liveConfig.get<boolean>(KEY_MIRROR_EXISTING, DEFAULT_TELEGRAM_BRIDGE_SETTINGS.mirrorExisting),
      allowList: [...this.liveConfig.get<string[]>(KEY_ALLOW_LIST, DEFAULT_TELEGRAM_BRIDGE_SETTINGS.allowList)],
      denyList: [...this.liveConfig.get<string[]>(KEY_DENY_LIST, DEFAULT_TELEGRAM_BRIDGE_SETTINGS.denyList)],
    };
  }

  /**
   * Apply a partial update. Returns the full settings after the update.
   * Validation: booleans must be boolean; lists must be string[].
   */
  update(patch: Partial<TelegramBridgeSettings>): TelegramBridgeSettings {
    const before = this.getSettings();

    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be boolean');
      this.liveConfig.set(KEY_ENABLED, patch.enabled);
    }
    if (patch.autoCreateTopics !== undefined) {
      if (typeof patch.autoCreateTopics !== 'boolean') throw new Error('autoCreateTopics must be boolean');
      this.liveConfig.set(KEY_AUTO_CREATE, patch.autoCreateTopics);
    }
    if (patch.mirrorExisting !== undefined) {
      if (typeof patch.mirrorExisting !== 'boolean') throw new Error('mirrorExisting must be boolean');
      this.liveConfig.set(KEY_MIRROR_EXISTING, patch.mirrorExisting);
    }
    if (patch.allowList !== undefined) {
      if (!Array.isArray(patch.allowList) || !patch.allowList.every(s => typeof s === 'string')) {
        throw new Error('allowList must be string[]');
      }
      this.liveConfig.set(KEY_ALLOW_LIST, dedupeAndTrim(patch.allowList));
    }
    if (patch.denyList !== undefined) {
      if (!Array.isArray(patch.denyList) || !patch.denyList.every(s => typeof s === 'string')) {
        throw new Error('denyList must be string[]');
      }
      this.liveConfig.set(KEY_DENY_LIST, dedupeAndTrim(patch.denyList));
    }

    const after = this.getSettings();
    for (const k of Object.keys(after) as (keyof TelegramBridgeSettings)[]) {
      const b = before[k]; const a = after[k];
      const changed = Array.isArray(b) || Array.isArray(a)
        ? JSON.stringify(b) !== JSON.stringify(a)
        : b !== a;
      if (changed) this.emit('change', { field: k, before: b, after: a });
    }
    return after;
  }

  addToAllowList(agentId: string): TelegramBridgeSettings {
    const list = this.getSettings().allowList;
    if (list.includes(agentId)) return this.getSettings();
    return this.update({ allowList: [...list, agentId] });
  }

  removeFromAllowList(agentId: string): TelegramBridgeSettings {
    const list = this.getSettings().allowList.filter(a => a !== agentId);
    return this.update({ allowList: list });
  }

  addToDenyList(agentId: string): TelegramBridgeSettings {
    const list = this.getSettings().denyList;
    if (list.includes(agentId)) return this.getSettings();
    return this.update({ denyList: [...list, agentId] });
  }

  removeFromDenyList(agentId: string): TelegramBridgeSettings {
    const list = this.getSettings().denyList.filter(a => a !== agentId);
    return this.update({ denyList: list });
  }

  /**
   * Decide whether a brand-new Telegram topic should be auto-created for an
   * inbound message from `remoteAgent`. The bridge module calls this on every
   * inbound message that doesn't already have a bridged topic.
   *
   * Decision order (first match wins):
   *   1. If bridge is disabled overall → false.
   *   2. If allowList contains the agent (any matching id) → true. (allow > deny)
   *   3. If denyList contains the agent → false.
   *   4. Otherwise fall through to autoCreateTopics (the global default).
   *
   * `remoteAgent` is an opaque identifier — typically the remote agent's
   * fingerprint, but the matcher accepts any string the dashboard surfaces
   * (display name, fingerprint prefix). Allow/deny matching is case-sensitive
   * exact-match.
   */
  shouldAutoCreateTopic(remoteAgent: string): boolean {
    const s = this.getSettings();
    if (!s.enabled) return false;
    if (s.allowList.includes(remoteAgent)) return true;
    if (s.denyList.includes(remoteAgent)) return false;
    return s.autoCreateTopics;
  }

  /**
   * Decide whether to mirror an inbound/outbound message into a topic that
   * already exists for this thread. Bridge module calls this when there's a
   * known topic-id binding for the thread.
   *
   * Mirroring is independent of the deny-list — once the user has a topic
   * for a thread (which they explicitly created or allow-listed), traffic
   * keeps flowing unless the master switch is off or `mirrorExisting` is off.
   */
  shouldMirrorIntoExistingTopic(): boolean {
    const s = this.getSettings();
    return s.enabled && s.mirrorExisting;
  }
}

function dedupeAndTrim(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
