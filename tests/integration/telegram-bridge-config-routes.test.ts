/**
 * Integration tests for the threadline → telegram bridge config endpoints.
 *
 * Wires the actual `createRoutes` against a minimal RouteContext that only
 * provides what the bridge-config routes touch (LiveConfig +
 * TelegramBridgeConfig). Other fields are nulled — Express only invokes the
 * routes hit by the test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import {
  TelegramBridgeConfig,
  DEFAULT_TELEGRAM_BRIDGE_SETTINGS,
} from '../../src/threadline/TelegramBridgeConfig.js';

function makeCtx(stateDir: string, telegramBridgeConfig: TelegramBridgeConfig | null): RouteContext {
  return {
    telegramBridgeConfig,
    startTime: new Date(),
    // Everything else can be null/empty for these route tests.
    config: { stateDir, projectName: 'test', projectDir: path.dirname(stateDir) } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
  } as unknown as RouteContext;
}

describe('Threadline → Telegram bridge config routes', () => {
  let tmpDir: string;
  let stateDir: string;
  let app: express.Express;
  let live: LiveConfig;
  let bridge: TelegramBridgeConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bridge-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'test' }, null, 2));
    live = new LiveConfig(stateDir);
    bridge = new TelegramBridgeConfig(live);
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(makeCtx(stateDir, bridge)));
  });

  afterEach(() => {
    live.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /threadline/telegram-bridge/config', () => {
    it('returns defaults on a fresh agent (default-OFF auto-create)', async () => {
      const res = await request(app).get('/threadline/telegram-bridge/config');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(DEFAULT_TELEGRAM_BRIDGE_SETTINGS);
      expect(res.body.enabled).toBe(false);
      expect(res.body.autoCreateTopics).toBe(false);
      expect(res.body.mirrorExisting).toBe(true);
    });

    it('returns 503 when bridge config is not initialized', async () => {
      const noCfgApp = express();
      noCfgApp.use(express.json());
      noCfgApp.use('/', createRoutes(makeCtx(stateDir, null)));
      const res = await request(noCfgApp).get('/threadline/telegram-bridge/config');
      expect(res.status).toBe(503);
    });
  });

  describe('PATCH /threadline/telegram-bridge/config', () => {
    it('applies a partial update and returns the new settings', async () => {
      const res = await request(app)
        .patch('/threadline/telegram-bridge/config')
        .send({ enabled: true, autoCreateTopics: true });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.autoCreateTopics).toBe(true);
      expect(res.body.mirrorExisting).toBe(true); // untouched defaults preserved
    });

    it('rejects non-boolean enabled with 400', async () => {
      const res = await request(app)
        .patch('/threadline/telegram-bridge/config')
        .send({ enabled: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/enabled must be boolean/);
    });

    it('rejects non-array allowList with 400', async () => {
      const res = await request(app)
        .patch('/threadline/telegram-bridge/config')
        .send({ allowList: 'dawn' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/allowList must be string\[\]/);
    });

    it('persists updates across requests (proves write-through to config.json)', async () => {
      await request(app).patch('/threadline/telegram-bridge/config').send({ allowList: ['dawn', 'ada'] });
      const res = await request(app).get('/threadline/telegram-bridge/config');
      expect(res.body.allowList).toEqual(['dawn', 'ada']);
    });

    it('returns 503 when bridge config is not initialized', async () => {
      const noCfgApp = express();
      noCfgApp.use(express.json());
      noCfgApp.use('/', createRoutes(makeCtx(stateDir, null)));
      const res = await request(noCfgApp)
        .patch('/threadline/telegram-bridge/config')
        .send({ enabled: true });
      expect(res.status).toBe(503);
    });

    it('ignores unknown fields without throwing', async () => {
      const res = await request(app)
        .patch('/threadline/telegram-bridge/config')
        .send({ enabled: true, futureToggle: 'should-be-ignored' });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      // The unknown field was not persisted — getSettings returns the documented shape only
      expect(res.body).not.toHaveProperty('futureToggle');
    });
  });
});
