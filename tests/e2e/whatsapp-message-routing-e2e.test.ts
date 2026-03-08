/**
 * WhatsApp Message Routing — End-to-End Tests
 *
 * Tests the COMPLETE message routing pipeline:
 * 1. Incoming WhatsApp message → adapter → session spawn
 * 2. Subsequent messages → session injection
 * 3. Dead session → automatic respawn
 * 4. Reply API route → WhatsApp send
 * 5. WhatsApp reply script template existence
 * 6. Config fallback for authMethod/pairingPhoneNumber
 * 7. Stale credential auto-clear on 401
 * 8. Session injection tagging format
 *
 * Covers the full gap identified in baileys-405-fix-report.md:
 * "The WhatsApp pipeline receives messages and logs them, but has no
 *  messageHandler set — so messages go nowhere."
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { WhatsAppAdapter, type BackendCapabilities } from '../../src/messaging/WhatsAppAdapter.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig, Message } from '../../src/core/types.js';

// ── Setup ──────────────────────────────────────────────────

const AUTH_TOKEN = 'e2e-msg-routing-token';
const TEST_JID = '14155552671@s.whatsapp.net';
const TEST_JID_2 = '447911123456@s.whatsapp.net';

let project: TempProject;
let mockSM: MockSessionManager;
let whatsapp: WhatsAppAdapter;
let server: AgentServer;
let app: ReturnType<AgentServer['getApp']>;
let caps: BackendCapabilities & Record<string, ReturnType<typeof vi.fn>>;

beforeAll(async () => {
  project = createTempProject();
  mockSM = createMockSessionManager();

  // WhatsApp adapter with pairing-code at top level (tests config fallback)
  whatsapp = new WhatsAppAdapter(
    {
      backend: 'baileys',
      authorizedNumbers: ['+14155552671', '+447911123456'],
      requireConsent: false,
      authMethod: 'pairing-code',
      pairingPhoneNumber: '14155551234',
    } as Record<string, unknown>,
    project.stateDir,
  );

  caps = {
    sendText: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    stopTyping: vi.fn().mockResolvedValue(undefined),
    sendReadReceipt: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn().mockResolvedValue(undefined),
  };

  await whatsapp.start();
  whatsapp.setBackendCapabilities(caps);
  await whatsapp.setConnectionState('connected', '+14155551234');

  const config: InstarConfig = {
    projectName: 'whatsapp-routing-e2e',
    projectDir: project.dir,
    stateDir: project.stateDir,
    port: 0,
    authToken: AUTH_TOKEN,
    sessions: {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: project.dir,
      maxSessions: 5,
      protectedSessions: [],
      completionPatterns: [],
    },
    users: [],
    messaging: [],
    monitoring: {
      quotaTracking: false,
      memoryMonitoring: false,
      healthCheckIntervalMs: 30000,
    },
  };

  server = new AgentServer({
    config,
    sessionManager: mockSM as any,
    state: project.state,
    whatsapp,
  });
  app = server.getApp();
});

afterAll(async () => {
  await whatsapp.stop();
  project.cleanup();
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────

describe('WhatsApp Message Routing E2E', () => {
  beforeEach(() => {
    caps.sendText.mockClear();
    caps.sendTyping.mockClear();
    caps.sendReadReceipt.mockClear();
    caps.sendReaction.mockClear();
  });

  // ══════════════════════════════════════════════════════
  // 1. MESSAGE HANDLER WIRING
  // ══════════════════════════════════════════════════════

  describe('Message handler registration', () => {
    it('onMessage accepts a handler function', () => {
      const handler = vi.fn();
      // Should not throw
      whatsapp.onMessage(handler);
      // Restore original (the tests below set their own handlers)
      whatsapp.onMessage(async () => {});
    });

    it('messages reach the handler after onMessage is called', async () => {
      const received: Message[] = [];
      whatsapp.onMessage(async (msg) => {
        received.push(msg);
      });

      // Simulate incoming message through the adapter
      await whatsapp.handleIncomingMessage(
        TEST_JID,
        `msg-${Date.now()}`,
        'Hello from WhatsApp',
        'Test User',
      );

      expect(received.length).toBe(1);
      expect(received[0].content).toBe('Hello from WhatsApp');
      expect(received[0].channel?.identifier).toBe(TEST_JID);
      expect(received[0].userId).toMatch(/14155552671/);
    });

    it('messages from unauthorized numbers do NOT reach handler', async () => {
      const received: Message[] = [];
      whatsapp.onMessage(async (msg) => {
        received.push(msg);
      });

      await whatsapp.handleIncomingMessage(
        '19999999999@s.whatsapp.net',
        `msg-unauth-${Date.now()}`,
        'Unauthorized message',
        'Hacker',
      );

      expect(received.length).toBe(0);
    });

    it('deduplicates messages with the same ID', async () => {
      const received: Message[] = [];
      whatsapp.onMessage(async (msg) => {
        received.push(msg);
      });

      const msgId = `dedup-${Date.now()}`;
      await whatsapp.handleIncomingMessage(TEST_JID, msgId, 'First', 'User');
      await whatsapp.handleIncomingMessage(TEST_JID, msgId, 'Duplicate', 'User');

      expect(received.length).toBe(1);
      expect(received[0].content).toBe('First');
    });
  });

  // ══════════════════════════════════════════════════════
  // 2. SESSION MANAGEMENT (channel registry)
  // ══════════════════════════════════════════════════════

  describe('Session-channel mapping', () => {
    it('registerSession maps JID to session name', () => {
      whatsapp.registerSession(TEST_JID, 'wa-session-1');
      expect(whatsapp.getSessionForChannel(TEST_JID)).toBe('wa-session-1');
    });

    it('getChannelForSession returns JID for session', () => {
      whatsapp.registerSession(TEST_JID_2, 'wa-session-2');
      expect(whatsapp.getChannelForSession('wa-session-2')).toBe(TEST_JID_2);
    });

    it('multiple JIDs can map to different sessions', () => {
      whatsapp.registerSession(TEST_JID, 'wa-a');
      whatsapp.registerSession(TEST_JID_2, 'wa-b');
      expect(whatsapp.getSessionForChannel(TEST_JID)).toBe('wa-a');
      expect(whatsapp.getSessionForChannel(TEST_JID_2)).toBe('wa-b');
    });
  });

  // ══════════════════════════════════════════════════════
  // 3. WHATSAPP SEND API ROUTE
  // ══════════════════════════════════════════════════════

  describe('POST /whatsapp/send/:jid', () => {
    it('sends a message to a JID via the adapter', async () => {
      const res = await request(app)
        .post(`/whatsapp/send/${TEST_JID}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ text: 'Hello from Claude' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.jid).toBe(TEST_JID);
      // The adapter should have called sendText via capabilities
      expect(caps.sendText).toHaveBeenCalled();
    });

    it('returns 400 when text is missing', async () => {
      const res = await request(app)
        .post(`/whatsapp/send/${TEST_JID}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('text');
    });

    it('returns 400 when text exceeds max length', async () => {
      const res = await request(app)
        .post(`/whatsapp/send/${TEST_JID}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ text: 'x'.repeat(40001) });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('40000');
    });

    it('returns 401 without auth token', async () => {
      const res = await request(app)
        .post(`/whatsapp/send/${TEST_JID}`)
        .send({ text: 'No auth' });

      expect(res.status).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════
  // 4. CONFIG FALLBACK (getBaileysConfig)
  // ══════════════════════════════════════════════════════

  describe('getBaileysConfig() top-level fallback', () => {
    it('reads authMethod from top-level when nested baileys key is missing', () => {
      const config = whatsapp.getBaileysConfig();
      expect(config.authMethod).toBe('pairing-code');
    });

    it('reads pairingPhoneNumber from top-level when nested baileys key is missing', () => {
      const config = whatsapp.getBaileysConfig();
      expect(config.pairingPhoneNumber).toBe('14155551234');
    });

    it('prefers nested baileys config over top-level', () => {
      const adapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          authMethod: 'qr',
          pairingPhoneNumber: '999',
          baileys: {
            authMethod: 'pairing-code',
            pairingPhoneNumber: '111',
          },
        } as Record<string, unknown>,
        project.stateDir,
      );
      const config = adapter.getBaileysConfig();
      expect(config.authMethod).toBe('pairing-code');
      expect(config.pairingPhoneNumber).toBe('111');
    });

    it('defaults to qr when neither nested nor top-level authMethod exists', () => {
      const adapter = new WhatsAppAdapter(
        { backend: 'baileys' } as Record<string, unknown>,
        project.stateDir,
      );
      const config = adapter.getBaileysConfig();
      expect(config.authMethod).toBe('qr');
      expect(config.pairingPhoneNumber).toBe('');
    });
  });

  // ══════════════════════════════════════════════════════
  // 5. WHATSAPP REPLY SCRIPT TEMPLATE
  // ══════════════════════════════════════════════════════

  describe('WhatsApp reply script template', () => {
    it('whatsapp-reply.sh template exists', () => {
      const templatePath = path.join(process.cwd(), 'src/templates/scripts/whatsapp-reply.sh');
      expect(fs.existsSync(templatePath)).toBe(true);
    });

    it('template hits /whatsapp/send/ endpoint', () => {
      const templatePath = path.join(process.cwd(), 'src/templates/scripts/whatsapp-reply.sh');
      const content = fs.readFileSync(templatePath, 'utf-8');
      expect(content).toContain('/whatsapp/send/');
    });

    it('template accepts JID as first argument', () => {
      const templatePath = path.join(process.cwd(), 'src/templates/scripts/whatsapp-reply.sh');
      const content = fs.readFileSync(templatePath, 'utf-8');
      expect(content).toContain('JID="$1"');
    });

    it('template reads message from stdin or args', () => {
      const templatePath = path.join(process.cwd(), 'src/templates/scripts/whatsapp-reply.sh');
      const content = fs.readFileSync(templatePath, 'utf-8');
      expect(content).toContain('MSG="$(cat)"');
      expect(content).toContain('MSG="$*"');
    });

    it('template reads auth token from .instar/config.json', () => {
      const templatePath = path.join(process.cwd(), 'src/templates/scripts/whatsapp-reply.sh');
      const content = fs.readFileSync(templatePath, 'utf-8');
      expect(content).toContain('.instar/config.json');
      expect(content).toContain('authToken');
    });
  });

  // ══════════════════════════════════════════════════════
  // 6. BAILEYS BACKEND SOURCE VERIFICATION
  // ══════════════════════════════════════════════════════

  describe('BaileysBackend pairing code fix (source verification)', () => {
    const backendPath = path.join(process.cwd(), 'src/messaging/backends/BaileysBackend.ts');
    let src: string;

    beforeAll(() => {
      src = fs.readFileSync(backendPath, 'utf-8');
    });

    it('pairing code is requested on QR event, NOT inside connection open', () => {
      const qrSection = src.substring(
        src.indexOf('if (qr)'),
        src.indexOf("if (connection === 'open')"),
      );
      expect(qrSection).toContain('requestPairingCode');

      const openSection = src.substring(
        src.indexOf("if (connection === 'open')"),
        src.indexOf("if (connection === 'close')"),
      );
      expect(openSection).not.toContain('requestPairingCode');
    });

    it('stale credential detection checks creds.json age', () => {
      const closeSection = src.substring(
        src.indexOf("if (connection === 'close')"),
      );
      expect(closeSection).toContain('creds.json');
      expect(closeSection).toContain('5 * 60 * 1000');
      expect(closeSection).toContain('rmSync');
    });

    it('_pairingCodeRequested flag prevents duplicate requests', () => {
      expect(src).toContain('_pairingCodeRequested');
      // Set to true before requesting
      const qrSection = src.substring(
        src.indexOf('if (qr)'),
        src.indexOf("if (connection === 'open')"),
      );
      expect(qrSection).toContain('this._pairingCodeRequested = true');
      // Reset on failure
      expect(qrSection).toContain('this._pairingCodeRequested = false');
    });
  });

  // ══════════════════════════════════════════════════════
  // 7. WIRE WHATSAPP ROUTING (server.ts source verification)
  // ══════════════════════════════════════════════════════

  describe('wireWhatsAppRouting integration (source verification)', () => {
    const serverPath = path.join(process.cwd(), 'src/commands/server.ts');
    let src: string;

    beforeAll(() => {
      src = fs.readFileSync(serverPath, 'utf-8');
    });

    it('wireWhatsAppRouting function exists', () => {
      expect(src).toContain('function wireWhatsAppRouting(');
    });

    it('wireWhatsAppRouting calls whatsapp.onMessage', () => {
      const fnStart = src.indexOf('function wireWhatsAppRouting(');
      const fnBody = src.substring(fnStart, fnStart + 2000);
      expect(fnBody).toContain('whatsapp.onMessage(');
    });

    it('wireWhatsAppRouting spawns sessions for new JIDs', () => {
      const fnStart = src.indexOf('function wireWhatsAppRouting(');
      const fnBody = src.substring(fnStart, fnStart + 2000);
      expect(fnBody).toContain('spawnInteractiveSession');
      expect(fnBody).toContain('registerSession');
    });

    it('wireWhatsAppRouting injects messages into existing alive sessions', () => {
      const fnStart = src.indexOf('function wireWhatsAppRouting(');
      const fnBody = src.substring(fnStart, fnStart + 2000);
      expect(fnBody).toContain('injectWhatsAppMessage');
      expect(fnBody).toContain('isSessionAlive');
    });

    it('wireWhatsAppRouting handles dead sessions by respawning', () => {
      const fnStart = src.indexOf('function wireWhatsAppRouting(');
      const fnBody = src.substring(fnStart, fnStart + 2000);
      // Should check for alive then have an else branch for dead
      expect(fnBody).toContain('Session "${targetSession}" died');
      expect(fnBody).toContain('spawnInteractiveSession');
    });

    it('wireWhatsAppRouting is called during WhatsApp init', () => {
      expect(src).toContain('wireWhatsAppRouting(whatsappAdapter, sessionManager)');
    });

    it('bootstrap message includes whatsapp-reply.sh instructions', () => {
      const fnStart = src.indexOf('function wireWhatsAppRouting(');
      const fnBody = src.substring(fnStart, fnStart + 2000);
      expect(fnBody).toContain('whatsapp-reply.sh');
    });
  });

  // ══════════════════════════════════════════════════════
  // 8. SESSION MANAGER WHATSAPP INJECTION
  // ══════════════════════════════════════════════════════

  describe('SessionManager.injectWhatsAppMessage (source verification)', () => {
    const smPath = path.join(process.cwd(), 'src/core/SessionManager.ts');
    let src: string;

    beforeAll(() => {
      src = fs.readFileSync(smPath, 'utf-8');
    });

    it('injectWhatsAppMessage method exists', () => {
      expect(src).toContain('injectWhatsAppMessage(');
    });

    it('tags messages with [whatsapp:JID] format', () => {
      const fnStart = src.indexOf('injectWhatsAppMessage(');
      const fnBody = src.substring(fnStart, fnStart + 500);
      expect(fnBody).toContain('[whatsapp:${jid}');
    });

    it('includes sender name in tag when available', () => {
      const fnStart = src.indexOf('injectWhatsAppMessage(');
      const fnBody = src.substring(fnStart, fnStart + 500);
      expect(fnBody).toContain('from ${senderName');
    });

    it('handles long messages via temp files', () => {
      const fnStart = src.indexOf('injectWhatsAppMessage(');
      const fnBody = src.substring(fnStart, fnStart + 800);
      expect(fnBody).toContain('FILE_THRESHOLD');
      expect(fnBody).toContain('/tmp');
      expect(fnBody).toContain('instar-whatsapp');
      expect(fnBody).toContain('writeFileSync');
    });

    it('uses generic injectMessage for short messages', () => {
      const fnStart = src.indexOf('injectWhatsAppMessage(');
      const fnBody = src.substring(fnStart, fnStart + 800);
      expect(fnBody).toContain('this.injectMessage(tmuxSession, taggedText)');
    });
  });

  // ══════════════════════════════════════════════════════
  // 9. INIT SCRIPT INSTALLATION
  // ══════════════════════════════════════════════════════

  describe('Init installs WhatsApp relay script', () => {
    const initPath = path.join(process.cwd(), 'src/commands/init.ts');
    let src: string;

    beforeAll(() => {
      src = fs.readFileSync(initPath, 'utf-8');
    });

    it('isWhatsAppConfigured helper exists', () => {
      expect(src).toContain('function isWhatsAppConfigured(');
    });

    it('refreshScripts installs whatsapp-reply.sh when WhatsApp is configured', () => {
      expect(src).toContain('installWhatsAppRelay');
      expect(src).toContain('isWhatsAppConfigured');
    });

    it('installWhatsAppRelay function exists', () => {
      expect(src).toContain('function installWhatsAppRelay(');
    });

    it('installWhatsAppRelay writes to .instar/scripts/whatsapp-reply.sh', () => {
      const fnStart = src.indexOf('function installWhatsAppRelay(');
      const fnEnd = src.indexOf('\n}', fnStart + 50);
      const fnBody = src.substring(fnStart, fnEnd);
      expect(fnBody).toContain('whatsapp-reply.sh');
      expect(fnBody).toContain('/whatsapp/send/');
    });

    it('CLAUDE.md gets WhatsApp Relay section when WhatsApp is configured', () => {
      expect(src).toContain('WhatsApp Relay');
      expect(src).toContain('[whatsapp:JID]');
      expect(src).toContain('whatsapp-reply.sh');
    });
  });

  // ══════════════════════════════════════════════════════
  // 10. EXISTING WHATSAPP ROUTES STILL WORK
  // ══════════════════════════════════════════════════════

  describe('Existing WhatsApp routes', () => {
    it('GET /whatsapp/status returns status', async () => {
      const res = await request(app)
        .get('/whatsapp/status')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('connected');
      expect(res.body.phoneNumber).toBe('+14155551234');
    });

    it('GET /whatsapp/qr returns QR state', async () => {
      const res = await request(app)
        .get('/whatsapp/qr')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('connected');
      expect(res.body.qr).toBeNull(); // Connected, no QR needed
    });
  });

  // ── Dynamic Version Fetching & Platform Override ──────────────

  describe('BaileysBackend — version & platform management', () => {
    const baileysBackendSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/messaging/backends/BaileysBackend.ts'),
      'utf-8',
    );

    it('should attempt to fetch latest WA Web version dynamically', () => {
      // Verify fetchLatestWaWebVersion is destructured from baileys import
      expect(baileysBackendSrc).toContain('fetchLatestWaWebVersion');
      // Verify it's called during connect
      expect(baileysBackendSrc).toMatch(/fetchLatestWaWebVersion\s*\(/);
    });

    it('should fall back gracefully if version fetch fails', () => {
      // Verify there's a try/catch around the version fetch
      expect(baileysBackendSrc).toContain('Could not fetch latest WA version');
    });

    it('should pass version to makeWASocket when available', () => {
      // Verify version is spread into socket config
      expect(baileysBackendSrc).toMatch(/version\s*\?\s*\{\s*version\s*\}/);
    });

    it('should use config version override if provided', () => {
      // Verify config.version is checked first
      expect(baileysBackendSrc).toContain('this.config.version');
    });

    it('should default browser to Mac OS / Chrome (MACOS platform)', () => {
      // Default browser must map to MACOS platform, not WEB
      expect(baileysBackendSrc).toContain("['Mac OS', 'Chrome', '14.4.1']");
    });

    it('should allow browser config override', () => {
      // Verify config.browser is used
      expect(baileysBackendSrc).toContain('this.config.browser');
    });

    it('should pass browser to makeWASocket', () => {
      // Verify browser is in the socket config
      const socketConfigMatch = baileysBackendSrc.match(/makeWASocket\(\{[\s\S]*?browser[\s\S]*?\}\)/);
      expect(socketConfigMatch).not.toBeNull();
    });
  });

  // ── BaileysConfig — version & browser fields ──────────────

  describe('BaileysConfig — version & browser type definitions', () => {
    const adapterSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/messaging/WhatsAppAdapter.ts'),
      'utf-8',
    );

    it('should define version field in BaileysConfig', () => {
      expect(adapterSrc).toMatch(/version\?\s*:\s*\[number,\s*number,\s*number\]/);
    });

    it('should define browser field in BaileysConfig', () => {
      expect(adapterSrc).toMatch(/browser\?\s*:\s*\[string,\s*string,\s*string\]/);
    });

    it('should wire version through getBaileysConfig()', () => {
      expect(adapterSrc).toMatch(/version:\s*bc\.version/);
    });

    it('should wire browser through getBaileysConfig()', () => {
      expect(adapterSrc).toMatch(/browser:\s*bc\.browser/);
    });
  });

  // ── Config.json backup protection ──────────────────────────

  describe('Config.json backup protection', () => {
    const serverSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/commands/server.ts'),
      'utf-8',
    );

    it('should backup config.json before post-update migration', () => {
      expect(serverSrc).toContain('config.json.backup');
      expect(serverSrc).toContain('copyFileSync');
    });

    it('should only backup if config.json exists', () => {
      // Verify existsSync check before copy
      const backupSection = serverSrc.substring(
        serverSrc.indexOf('config.json.backup') - 200,
        serverSrc.indexOf('config.json.backup') + 100,
      );
      expect(backupSection).toContain('existsSync');
    });
  });

  // ── Server restart command ──────────────────────────────────

  describe('Server restart command', () => {
    const serverSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/commands/server.ts'),
      'utf-8',
    );
    const cliSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/cli.ts'),
      'utf-8',
    );

    it('should export restartServer function', () => {
      expect(serverSrc).toMatch(/export\s+async\s+function\s+restartServer/);
    });

    it('should handle launchd lifecycle on macOS', () => {
      expect(serverSrc).toContain('launchctl');
      expect(serverSrc).toContain('bootout');
      expect(serverSrc).toContain('bootstrap');
    });

    it('should handle systemd lifecycle on Linux', () => {
      expect(serverSrc).toContain('systemctl');
      expect(serverSrc).toContain('--user');
      expect(serverSrc).toContain('restart');
    });

    it('should fall back to stop + start without autostart', () => {
      expect(serverSrc).toContain('stopServer(options)');
      expect(serverSrc).toContain('startServer(');
    });

    it('should be registered as CLI subcommand', () => {
      expect(cliSrc).toContain("restartServer");
      expect(cliSrc).toContain("'restart [name]'");
    });

    it('should import restartServer in cli.ts', () => {
      expect(cliSrc).toMatch(/import.*restartServer.*from.*server/);
    });
  });

  // ══════════════════════════════════════════════════════
  // 9. LID JID HANDLING (WhatsApp Linked Identity)
  // ══════════════════════════════════════════════════════

  describe('LID JID handling', () => {
    const LID_JID = '272404173598970@lid';

    it('jidToPhone returns null for @lid JIDs', async () => {
      const { jidToPhone } = await import('../../src/messaging/shared/PhoneUtils.js');
      expect(jidToPhone(LID_JID)).toBeNull();
    });

    it('isJid recognizes @lid JIDs', async () => {
      const { isJid } = await import('../../src/messaging/shared/PhoneUtils.js');
      expect(isJid(LID_JID)).toBe(true);
    });

    it('isLidJid correctly identifies LID JIDs', async () => {
      const { isLidJid } = await import('../../src/messaging/shared/PhoneUtils.js');
      expect(isLidJid(LID_JID)).toBe(true);
      expect(isLidJid('14155552671@s.whatsapp.net')).toBe(false);
      expect(isLidJid('120363187170797617@g.us')).toBe(false);
    });

    it('adapter maps @lid JID to connected phone number', async () => {
      // The adapter was connected with phone '+14155551234' in beforeAll.
      // The authorized numbers include +14155552671 but we need the connected
      // phone to be authorized for the LID mapping to pass auth.
      const lidAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          authorizedNumbers: ['+14155551234'],
          requireConsent: false,
        } as Record<string, unknown>,
        project.stateDir,
      );

      await lidAdapter.start();
      lidAdapter.setBackendCapabilities({
        sendText: vi.fn().mockResolvedValue(undefined),
      });
      // Set connected phone — this is what @lid JIDs map to
      await lidAdapter.setConnectionState('connected', '14155551234');

      const received: Message[] = [];
      lidAdapter.onMessage(async (msg) => received.push(msg));

      await lidAdapter.handleIncomingMessage(
        LID_JID,
        `lid-msg-${Date.now()}`,
        'Self-chat from phone',
        'User',
      );

      expect(received.length).toBe(1);
      expect(received[0].userId).toBe('+14155551234');
      await lidAdapter.stop();
    });

    it('adapter rejects @lid JID when no phone number is set and auth is restricted', async () => {
      const lidAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          authorizedNumbers: ['+14155551234'], // Only allow a specific number
          requireConsent: false,
        } as Record<string, unknown>,
        project.stateDir,
      );

      await lidAdapter.start();
      lidAdapter.setBackendCapabilities({
        sendText: vi.fn().mockResolvedValue(undefined),
      });
      // Don't set connection state — phoneNumber remains null
      // So @lid won't map to a real phone, and the fake number from LID
      // won't be in authorizedNumbers → auth gate rejects it.

      const received: Message[] = [];
      lidAdapter.onMessage(async (msg) => received.push(msg));

      await lidAdapter.handleIncomingMessage(
        LID_JID,
        `lid-drop-${Date.now()}`,
        'Should be rejected by auth',
        'User',
      );

      // Without phone mapping, LID produces a fake number not in authorizedNumbers
      expect(received.length).toBe(0);
      await lidAdapter.stop();
    });
  });

  // ══════════════════════════════════════════════════════
  // 10. SELF-CHAT & OUTBOUND MESSAGE ID TRACKING
  // ══════════════════════════════════════════════════════

  describe('Self-chat support', () => {
    it('BaileysBackend tracks sent message IDs in sendText capability', () => {
      const baileysBackendSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/messaging/backends/BaileysBackend.ts'),
        'utf-8',
      );
      // Should track sent message IDs
      expect(baileysBackendSrc).toContain('sentMessageIds');
      expect(baileysBackendSrc).toContain('sent.key.id');
      expect(baileysBackendSrc).toContain('this.sentMessageIds.add(');
    });

    it('BaileysBackend filters by sentMessageIds instead of blanket fromMe', () => {
      const baileysBackendSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/messaging/backends/BaileysBackend.ts'),
        'utf-8',
      );
      // Should NOT have blanket fromMe filter
      expect(baileysBackendSrc).not.toContain('if (!msg.message || msg.key.fromMe) continue');
      // Should check sentMessageIds instead
      expect(baileysBackendSrc).toContain('this.sentMessageIds.has(msg.key.id)');
    });

    it('BaileysBackend accepts both notify and append message types', () => {
      const baileysBackendSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/messaging/backends/BaileysBackend.ts'),
        'utf-8',
      );
      expect(baileysBackendSrc).toContain("m.type !== 'notify' && m.type !== 'append'");
    });

    it('BaileysBackend has sent IDs size limit to prevent memory leak', () => {
      const baileysBackendSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/messaging/backends/BaileysBackend.ts'),
        'utf-8',
      );
      expect(baileysBackendSrc).toContain('SENT_IDS_MAX_SIZE');
    });

    it('WhatsAppAdapter maps @lid to connected phone in handleIncomingMessage', () => {
      const adapterSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/messaging/WhatsAppAdapter.ts'),
        'utf-8',
      );
      expect(adapterSrc).toContain("jid.endsWith('@lid')");
      expect(adapterSrc).toContain('this.phoneNumber');
    });
  });

  // ══════════════════════════════════════════════════════
  // 11. GROUP MESSAGE HANDLING
  // ══════════════════════════════════════════════════════

  describe('Group message handling', () => {
    const GROUP_JID = '120363187170797617@g.us';
    const SENDER_JID = '14155552671@s.whatsapp.net';

    it('ignores group messages when groups are not enabled', async () => {
      // Default adapter has no groups config
      const received: Message[] = [];
      whatsapp.onMessage(async (msg) => received.push(msg));

      await whatsapp.handleIncomingMessage(
        GROUP_JID,
        `grp-disabled-${Date.now()}`,
        'Hello group',
        'User',
        undefined,
        undefined,
        SENDER_JID,
      );

      expect(received.length).toBe(0);
    });

    it('processes group messages when groups are enabled and authorized', async () => {
      const groupAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          authorizedNumbers: [],
          requireConsent: false,
          groups: {
            enabled: true,
            authorizedGroups: [GROUP_JID],
            defaultActivation: 'always',
          },
        } as Record<string, unknown>,
        project.stateDir,
      );

      await groupAdapter.start();
      groupAdapter.setBackendCapabilities({
        sendText: vi.fn().mockResolvedValue(undefined),
      });
      await groupAdapter.setConnectionState('connected', '14155551234');

      const received: Message[] = [];
      groupAdapter.onMessage(async (msg) => received.push(msg));

      await groupAdapter.handleIncomingMessage(
        GROUP_JID,
        `grp-always-${Date.now()}`,
        'Hello from group',
        'GroupUser',
        undefined,
        undefined,
        SENDER_JID,
      );

      expect(received.length).toBe(1);
      expect(received[0].channel.identifier).toBe(GROUP_JID);
      expect(received[0].metadata?.isGroup).toBe(true);
      expect(received[0].metadata?.participant).toBe(SENDER_JID);
      await groupAdapter.stop();
    });

    it('buffers group messages for context', async () => {
      const groupAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          requireConsent: false,
          groups: {
            enabled: true,
            authorizedGroups: [GROUP_JID],
            defaultActivation: 'always',
            maxContextMessages: 5,
          },
        } as Record<string, unknown>,
        project.stateDir,
      );

      await groupAdapter.start();
      groupAdapter.setBackendCapabilities({
        sendText: vi.fn().mockResolvedValue(undefined),
      });
      await groupAdapter.setConnectionState('connected', '14155551234');
      groupAdapter.onMessage(async () => {});

      // Send 7 messages — buffer should keep last 5
      for (let i = 0; i < 7; i++) {
        await groupAdapter.handleIncomingMessage(
          GROUP_JID,
          `grp-buf-${Date.now()}-${i}`,
          `Message ${i}`,
          `User${i}`,
          undefined,
          undefined,
          SENDER_JID,
        );
      }

      const buffer = groupAdapter.getGroupBuffer(GROUP_JID);
      expect(buffer.length).toBe(5);
      expect(buffer[0].text).toBe('Message 2'); // Oldest kept
      expect(buffer[4].text).toBe('Message 6'); // Most recent
      await groupAdapter.stop();
    });

    it('rejects unauthorized groups', async () => {
      const groupAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          requireConsent: false,
          groups: {
            enabled: true,
            authorizedGroups: ['999999999@g.us'], // Different group
            defaultActivation: 'always',
          },
        } as Record<string, unknown>,
        project.stateDir,
      );

      await groupAdapter.start();
      groupAdapter.setBackendCapabilities({
        sendText: vi.fn().mockResolvedValue(undefined),
      });
      groupAdapter.onMessage(async () => {});

      const received: Message[] = [];
      groupAdapter.onMessage(async (msg) => received.push(msg));

      await groupAdapter.handleIncomingMessage(
        GROUP_JID,
        `grp-unauth-${Date.now()}`,
        'Not authorized',
        'User',
        undefined,
        undefined,
        SENDER_JID,
      );

      expect(received.length).toBe(0);
      await groupAdapter.stop();
    });

    it('only activates on @mention in mention mode', async () => {
      const groupAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          requireConsent: false,
          groups: {
            enabled: true,
            authorizedGroups: [GROUP_JID],
            defaultActivation: 'mention',
          },
        } as Record<string, unknown>,
        project.stateDir,
      );

      await groupAdapter.start();
      groupAdapter.setBackendCapabilities({
        sendText: vi.fn().mockResolvedValue(undefined),
      });
      await groupAdapter.setConnectionState('connected', '14155551234');

      const received: Message[] = [];
      groupAdapter.onMessage(async (msg) => received.push(msg));

      // Message without mention — should not activate
      await groupAdapter.handleIncomingMessage(
        GROUP_JID,
        `grp-nomention-${Date.now()}`,
        'Hello everyone',
        'User',
        undefined,
        undefined,
        SENDER_JID,
        [], // no mentions
      );

      expect(received.length).toBe(0);

      // Message with mention of bot's phone — should activate
      await groupAdapter.handleIncomingMessage(
        GROUP_JID,
        `grp-mention-${Date.now()}`,
        '@agent what is the status?',
        'User',
        undefined,
        undefined,
        SENDER_JID,
        ['14155551234@s.whatsapp.net'], // bot's phone mentioned
      );

      expect(received.length).toBe(1);
      await groupAdapter.stop();
    });

    it('activates on agent name text trigger in mention mode', async () => {
      const groupAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          requireConsent: false,
          groups: {
            enabled: true,
            authorizedGroups: [GROUP_JID],
            defaultActivation: 'mention',
            agentName: 'Dude',
          },
        } as Record<string, unknown>,
        project.stateDir,
      );

      await groupAdapter.start();
      groupAdapter.setBackendCapabilities({
        sendText: vi.fn().mockResolvedValue(undefined),
      });
      await groupAdapter.setConnectionState('connected', '14155551234');

      const received: Message[] = [];
      groupAdapter.onMessage(async (msg) => received.push(msg));

      // Message starting with agent name
      await groupAdapter.handleIncomingMessage(
        GROUP_JID,
        `grp-name-${Date.now()}`,
        '@Dude what is the CI status?',
        'User',
        undefined,
        undefined,
        SENDER_JID,
      );

      expect(received.length).toBe(1);
      await groupAdapter.stop();
    });

    it('provides recent group context in message metadata', async () => {
      const groupAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          requireConsent: false,
          groups: {
            enabled: true,
            authorizedGroups: [GROUP_JID],
            defaultActivation: 'always',
          },
        } as Record<string, unknown>,
        project.stateDir,
      );

      await groupAdapter.start();
      groupAdapter.setBackendCapabilities({
        sendText: vi.fn().mockResolvedValue(undefined),
      });
      await groupAdapter.setConnectionState('connected', '14155551234');

      const received: Message[] = [];
      groupAdapter.onMessage(async (msg) => received.push(msg));

      // Send a couple messages to build context
      await groupAdapter.handleIncomingMessage(
        GROUP_JID,
        `grp-ctx-1-${Date.now()}`,
        'First message',
        'Alice',
        undefined,
        undefined,
        '11111111111@s.whatsapp.net',
      );

      await groupAdapter.handleIncomingMessage(
        GROUP_JID,
        `grp-ctx-2-${Date.now()}`,
        'Second message',
        'Bob',
        undefined,
        undefined,
        '22222222222@s.whatsapp.net',
      );

      // The latest message should include context from prior messages
      const lastMsg = received[received.length - 1];
      expect(lastMsg.metadata?.recentGroupContext).toContain('First message');
      expect(lastMsg.metadata?.recentGroupContext).toContain('Alice');
      await groupAdapter.stop();
    });

    it('group mention detection falls back to top-level agentName', async () => {
      // Group config WITHOUT agentName, but top-level config HAS agentName
      const groupAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          authorizedNumbers: [],
          requireConsent: false,
          agentName: 'TopLevelBot',
          groups: {
            enabled: true,
            authorizedGroups: [],
            defaultActivation: 'mention',
          },
        } as Record<string, unknown>,
        project.stateDir,
      );

      const received: Message[] = [];
      groupAdapter.onMessage(async (msg) => { received.push(msg); });
      await groupAdapter.start();
      groupAdapter.setBackendCapabilities(caps);
      await groupAdapter.setConnectionState('connected', '14155551234');

      // Text trigger using top-level agentName
      await groupAdapter.handleIncomingMessage(
        '120363187170797617@g.us',
        'msg-fallback-1',
        'TopLevelBot what time is it?',
        'Alice',
        undefined,
        undefined,
        '11111111111@s.whatsapp.net',
      );

      expect(received.length).toBe(1);
      await groupAdapter.stop();
    });

    it('BaileysBackend passes participant and mentionedJids', () => {
      const baileysBackendSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/messaging/backends/BaileysBackend.ts'),
        'utf-8',
      );
      expect(baileysBackendSrc).toContain('msg.key.participant');
      expect(baileysBackendSrc).toContain('mentionedJid');
      expect(baileysBackendSrc).toContain('contextInfo');
    });
  });

  // ══════════════════════════════════════════════════════
  // 12. AGENT IDENTITY PREFIX
  // ══════════════════════════════════════════════════════

  describe('Agent identity prefix', () => {
    it('prepends default prefix when prefixEnabled is not set', async () => {
      // Default adapter has no agentName or prefixEnabled set
      const sendSpy = vi.fn().mockResolvedValue(undefined);
      const prefixAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          authorizedNumbers: [],
          requireConsent: false,
        } as Record<string, unknown>,
        project.stateDir,
      );
      await prefixAdapter.start();
      prefixAdapter.setBackendCapabilities({ ...caps, sendText: sendSpy });
      await prefixAdapter.setConnectionState('connected', '14155551234');

      await prefixAdapter.send({
        channel: { type: 'whatsapp' as const, identifier: TEST_JID },
        content: 'Hello world',
      });

      expect(sendSpy).toHaveBeenCalled();
      const sentText = sendSpy.mock.calls[0][1];
      expect(sentText).toBe('*[Agent]* Hello world');
      await prefixAdapter.stop();
    });

    it('uses custom agentName in prefix', async () => {
      const sendSpy = vi.fn().mockResolvedValue(undefined);
      const prefixAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          authorizedNumbers: [],
          requireConsent: false,
          agentName: 'Dude',
        } as Record<string, unknown>,
        project.stateDir,
      );
      await prefixAdapter.start();
      prefixAdapter.setBackendCapabilities({ ...caps, sendText: sendSpy });
      await prefixAdapter.setConnectionState('connected', '14155551234');

      await prefixAdapter.send({
        channel: { type: 'whatsapp' as const, identifier: TEST_JID },
        content: 'CI is green',
      });

      const sentText = sendSpy.mock.calls[0][1];
      expect(sentText).toBe('*[Dude]* CI is green');
      await prefixAdapter.stop();
    });

    it('uses custom messagePrefix when provided', async () => {
      const sendSpy = vi.fn().mockResolvedValue(undefined);
      const prefixAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          authorizedNumbers: [],
          requireConsent: false,
          agentName: 'Dude',
          messagePrefix: '🤖 *Dude:* ',
        } as Record<string, unknown>,
        project.stateDir,
      );
      await prefixAdapter.start();
      prefixAdapter.setBackendCapabilities({ ...caps, sendText: sendSpy });
      await prefixAdapter.setConnectionState('connected', '14155551234');

      await prefixAdapter.send({
        channel: { type: 'whatsapp' as const, identifier: TEST_JID },
        content: 'Custom prefix test',
      });

      const sentText = sendSpy.mock.calls[0][1];
      expect(sentText).toBe('🤖 *Dude:* Custom prefix test');
      await prefixAdapter.stop();
    });

    it('skips prefix when prefixEnabled is false', async () => {
      const sendSpy = vi.fn().mockResolvedValue(undefined);
      const prefixAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          authorizedNumbers: [],
          requireConsent: false,
          agentName: 'Dude',
          prefixEnabled: false,
        } as Record<string, unknown>,
        project.stateDir,
      );
      await prefixAdapter.start();
      prefixAdapter.setBackendCapabilities({ ...caps, sendText: sendSpy });
      await prefixAdapter.setConnectionState('connected', '14155551234');

      await prefixAdapter.send({
        channel: { type: 'whatsapp' as const, identifier: TEST_JID },
        content: 'No prefix here',
      });

      const sentText = sendSpy.mock.calls[0][1];
      expect(sentText).toBe('No prefix here');
      await prefixAdapter.stop();
    });

    it('prefix applies to chunked messages', async () => {
      const sendSpy = vi.fn().mockResolvedValue(undefined);
      const prefixAdapter = new WhatsAppAdapter(
        {
          backend: 'baileys',
          authorizedNumbers: [],
          requireConsent: false,
          agentName: 'Bot',
          maxMessageLength: 30,
        } as Record<string, unknown>,
        project.stateDir,
      );
      await prefixAdapter.start();
      prefixAdapter.setBackendCapabilities({ ...caps, sendText: sendSpy });
      await prefixAdapter.setConnectionState('connected', '14155551234');

      await prefixAdapter.send({
        channel: { type: 'whatsapp' as const, identifier: TEST_JID },
        content: 'A message that will be chunked into parts',
      });

      // The prefix is added to the full content, then chunked
      expect(sendSpy).toHaveBeenCalled();
      const firstChunk = sendSpy.mock.calls[0][1];
      expect(firstChunk).toContain('*[Bot]*');
      await prefixAdapter.stop();
    });
  });
});
