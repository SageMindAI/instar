/**
 * Unit tests for TelegramBridgeConfig — the settings surface that gates the
 * threadline → telegram bridge. Default-OFF auto-create is a hard requirement
 * (the bridge ships dark on day one), so we exercise that contract directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import {
  TelegramBridgeConfig,
  DEFAULT_TELEGRAM_BRIDGE_SETTINGS,
  type TelegramBridgeConfigChangeEvent,
} from '../../src/threadline/TelegramBridgeConfig.js';

function createTempConfig(): { dir: string; live: LiveConfig; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbridge-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ projectName: 'test' }, null, 2));
  const live = new LiveConfig(dir);
  return {
    dir,
    live,
    cleanup: () => { live.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('TelegramBridgeConfig', () => {
  let temp: ReturnType<typeof createTempConfig>;
  let cfg: TelegramBridgeConfig;

  beforeEach(() => {
    temp = createTempConfig();
    cfg = new TelegramBridgeConfig(temp.live);
  });

  afterEach(() => temp.cleanup());

  // ── Defaults — the noise budget ─────────────────────────────────

  describe('defaults', () => {
    it('returns the documented default settings when nothing is in config', () => {
      expect(cfg.getSettings()).toEqual(DEFAULT_TELEGRAM_BRIDGE_SETTINGS);
    });

    it('default-OFF auto-create — quiet by default is a hard requirement', () => {
      const s = cfg.getSettings();
      expect(s.enabled).toBe(false);
      expect(s.autoCreateTopics).toBe(false);
    });

    it('default-ON mirrorExisting — once a topic exists the user wants the traffic', () => {
      expect(cfg.getSettings().mirrorExisting).toBe(true);
    });

    it('returns fresh array copies — caller mutations do not leak into stored config', () => {
      const a = cfg.getSettings();
      const b = cfg.getSettings();
      expect(a.allowList).not.toBe(b.allowList);
      a.allowList.push('mutate-me');
      expect(cfg.getSettings().allowList).toEqual([]);
    });
  });

  // ── update() and validation ─────────────────────────────────────

  describe('update', () => {
    it('persists a partial update', () => {
      const after = cfg.update({ enabled: true });
      expect(after.enabled).toBe(true);
      expect(after.autoCreateTopics).toBe(false);

      // New instance reads from disk — proves persistence
      const cfg2 = new TelegramBridgeConfig(temp.live);
      expect(cfg2.getSettings().enabled).toBe(true);
    });

    it('rejects non-boolean enabled', () => {
      expect(() => cfg.update({ enabled: 'yes' as unknown as boolean })).toThrow(/enabled must be boolean/);
    });

    it('rejects non-array allowList', () => {
      expect(() => cfg.update({ allowList: 'not-array' as unknown as string[] })).toThrow(/allowList must be string\[\]/);
    });

    it('rejects array of non-strings in allowList', () => {
      expect(() => cfg.update({ allowList: [1 as unknown as string] })).toThrow(/allowList must be string\[\]/);
    });

    it('dedupes and trims list entries', () => {
      const after = cfg.update({ allowList: ['  dawn  ', 'dawn', '', 'gail'] });
      expect(after.allowList).toEqual(['dawn', 'gail']);
    });

    it('emits a change event for each field that actually changed', () => {
      const events: TelegramBridgeConfigChangeEvent[] = [];
      cfg.on('change', (e) => events.push(e));
      cfg.update({ enabled: true, autoCreateTopics: false }); // only enabled changes
      expect(events).toHaveLength(1);
      expect(events[0]!.field).toBe('enabled');
      expect(events[0]!.before).toBe(false);
      expect(events[0]!.after).toBe(true);
    });
  });

  // ── allow / deny list management ────────────────────────────────

  describe('allow / deny list', () => {
    it('addToAllowList is idempotent', () => {
      cfg.addToAllowList('dawn');
      cfg.addToAllowList('dawn');
      expect(cfg.getSettings().allowList).toEqual(['dawn']);
    });

    it('removeFromAllowList tolerates missing entries', () => {
      cfg.addToAllowList('dawn');
      cfg.removeFromAllowList('not-present');
      expect(cfg.getSettings().allowList).toEqual(['dawn']);
      cfg.removeFromAllowList('dawn');
      expect(cfg.getSettings().allowList).toEqual([]);
    });

    it('deny list parallels allow list', () => {
      cfg.addToDenyList('spammer');
      cfg.addToDenyList('spammer');
      expect(cfg.getSettings().denyList).toEqual(['spammer']);
      cfg.removeFromDenyList('spammer');
      expect(cfg.getSettings().denyList).toEqual([]);
    });
  });

  // ── shouldAutoCreateTopic policy ───────────────────────────────

  describe('shouldAutoCreateTopic', () => {
    it('returns false when bridge is disabled regardless of allow-list', () => {
      cfg.update({ enabled: false, autoCreateTopics: true, allowList: ['dawn'] });
      expect(cfg.shouldAutoCreateTopic('dawn')).toBe(false);
    });

    it('allow-list takes precedence over autoCreateTopics=false', () => {
      cfg.update({ enabled: true, autoCreateTopics: false, allowList: ['dawn'] });
      expect(cfg.shouldAutoCreateTopic('dawn')).toBe(true);
      expect(cfg.shouldAutoCreateTopic('stranger')).toBe(false);
    });

    it('deny-list overrides autoCreateTopics=true', () => {
      cfg.update({ enabled: true, autoCreateTopics: true, denyList: ['spammer'] });
      expect(cfg.shouldAutoCreateTopic('dawn')).toBe(true);
      expect(cfg.shouldAutoCreateTopic('spammer')).toBe(false);
    });

    it('allow-list wins when an id is in BOTH lists (allow > deny)', () => {
      cfg.update({ enabled: true, autoCreateTopics: false, allowList: ['ada'], denyList: ['ada'] });
      expect(cfg.shouldAutoCreateTopic('ada')).toBe(true);
    });

    it('default policy matches "quiet by default" — bridge enabled but autoCreate off → false', () => {
      cfg.update({ enabled: true });
      expect(cfg.shouldAutoCreateTopic('anyone')).toBe(false);
    });
  });

  // ── shouldMirrorIntoExistingTopic policy ───────────────────────

  describe('shouldMirrorIntoExistingTopic', () => {
    it('returns false when bridge disabled', () => {
      cfg.update({ enabled: false, mirrorExisting: true });
      expect(cfg.shouldMirrorIntoExistingTopic()).toBe(false);
    });

    it('returns true when bridge enabled and mirrorExisting on', () => {
      cfg.update({ enabled: true, mirrorExisting: true });
      expect(cfg.shouldMirrorIntoExistingTopic()).toBe(true);
    });

    it('returns false when bridge enabled but mirrorExisting off', () => {
      cfg.update({ enabled: true, mirrorExisting: false });
      expect(cfg.shouldMirrorIntoExistingTopic()).toBe(false);
    });

    it('mirroring is independent of the deny-list (existing topic = user already opted in)', () => {
      cfg.update({ enabled: true, mirrorExisting: true, denyList: ['anyone'] });
      expect(cfg.shouldMirrorIntoExistingTopic()).toBe(true);
    });
  });
});
