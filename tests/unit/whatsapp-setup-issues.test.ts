/**
 * WhatsApp Setup Issues — Regression Tests
 *
 * Covers three critical issues discovered during real-world WhatsApp setup (2026-03-07):
 *
 * Issue 1: Baileys peer dependency not resolvable via require.resolve() in npx context
 * Issue 2: Baileys 405 Connection Failure causes infinite reconnect loop
 * Issue 3: Dashboard QR polling fails silently when auth is missing/invalid
 *
 * These tests verify the fixes and prevent regression.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── Issue 1: Baileys peer dep resolution ─────────────────────────

describe('Issue 1: Baileys peer dependency resolution', () => {
  const whatsappPath = path.join(process.cwd(), 'src/commands/whatsapp.ts');
  const baileysBackendPath = path.join(process.cwd(), 'src/messaging/backends/BaileysBackend.ts');
  const encryptedAuthStorePath = path.join(process.cwd(), 'src/messaging/shared/EncryptedAuthStore.ts');

  let whatsappSrc: string;
  let baileysBackendSrc: string;
  let encryptedAuthStoreSrc: string;

  beforeEach(() => {
    whatsappSrc = fs.readFileSync(whatsappPath, 'utf-8');
    baileysBackendSrc = fs.readFileSync(baileysBackendPath, 'utf-8');
    encryptedAuthStoreSrc = fs.readFileSync(encryptedAuthStorePath, 'utf-8');
  });

  it('whatsapp.ts does NOT use require.resolve for Baileys detection', () => {
    // require.resolve fails in npx context because it resolves relative
    // to the file location (npx cache), not the user's project directory.
    const requireResolvePattern = /require\.resolve\(['"]@whiskeysockets\/baileys['"]\)/;
    const matches = whatsappSrc.match(new RegExp(requireResolvePattern, 'g'));
    expect(matches).toBeNull();
  });

  it('whatsapp.ts has an isBaileysInstalled helper using dynamic import', () => {
    expect(whatsappSrc).toContain('async function isBaileysInstalled');
    expect(whatsappSrc).toContain("await import('@whiskeysockets/baileys')");
    expect(whatsappSrc).toContain("await import('baileys')");
  });

  it('whatsapp.ts isBaileysInstalled tries both v7 and v6 package names', () => {
    // v7: baileys (preferred), v6: @whiskeysockets/baileys (deprecated)
    const fnStart = whatsappSrc.indexOf('async function isBaileysInstalled');
    const fnEnd = whatsappSrc.indexOf('\n}', fnStart);
    const fnBody = whatsappSrc.substring(fnStart, fnEnd);

    expect(fnBody).toContain("@whiskeysockets/baileys");
    expect(fnBody).toContain("'baileys'");
    // v7 should be tried first (preferred)
    const v7Index = fnBody.indexOf("'baileys'");
    const v6Index = fnBody.indexOf("@whiskeysockets/baileys");
    expect(v7Index).toBeLessThan(v6Index);
  });

  it('whatsapp.ts uses isBaileysInstalled in addWhatsApp', () => {
    const addWhatsAppSection = whatsappSrc.substring(
      whatsappSrc.indexOf('// Check if Baileys is installed'),
      whatsappSrc.indexOf("console.log('Next steps:"),
    );
    expect(addWhatsAppSection).toContain('isBaileysInstalled()');
    expect(addWhatsAppSection).not.toContain('require.resolve');
  });

  it('whatsapp.ts uses isBaileysInstalled in channelLogin', () => {
    const channelLoginSection = whatsappSrc.substring(
      whatsappSrc.indexOf('export async function channelLogin'),
      whatsappSrc.indexOf('Dynamic import of BaileysBackend'),
    );
    expect(channelLoginSection).toContain('isBaileysInstalled()');
    expect(channelLoginSection).not.toContain('require.resolve');
  });

  it('whatsapp.ts uses isBaileysInstalled in channelDoctor', () => {
    const doctorSection = whatsappSrc.substring(
      whatsappSrc.indexOf("if (currentBackend === 'baileys')"),
    );
    expect(doctorSection).toContain('isBaileysInstalled()');
    expect(doctorSection).not.toContain('require.resolve');
  });

  it('BaileysBackend.ts tries v7 first, then v6 fallback on connect', () => {
    expect(baileysBackendSrc).toContain("import('@whiskeysockets/baileys')");
    expect(baileysBackendSrc).toContain("import('baileys')");

    // Verify v7 is tried first (preferred)
    const v7Index = baileysBackendSrc.indexOf("import('baileys')");
    const v6Index = baileysBackendSrc.indexOf("import('@whiskeysockets/baileys')");
    expect(v7Index).toBeLessThan(v6Index);
  });

  it('EncryptedAuthStore.ts tries v7 first, then v6 fallback', () => {
    expect(encryptedAuthStoreSrc).toContain("import('@whiskeysockets/baileys')");
    expect(encryptedAuthStoreSrc).toContain("import('baileys')");

    // v7 first
    const v7Index = encryptedAuthStoreSrc.indexOf("import('baileys')");
    const v6Index = encryptedAuthStoreSrc.indexOf("import('@whiskeysockets/baileys')");
    expect(v7Index).toBeLessThan(v6Index);
  });

  it('no file uses require.resolve for Baileys anywhere in src/', () => {
    // Comprehensive check across all source files
    const srcDir = path.join(process.cwd(), 'src');
    const tsFiles = findTsFiles(srcDir);

    for (const file of tsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const hasRequireResolve = /require\.resolve\(['"](@whiskeysockets\/baileys|baileys)['"]\)/.test(content);
      expect(hasRequireResolve, `${path.relative(srcDir, file)} still uses require.resolve for Baileys`).toBe(false);
    }
  });
});

// ── Issue 2: Baileys 405 Connection Failure ──────────────────────

describe('Issue 2: Baileys connection failure error handling', () => {
  const baileysBackendPath = path.join(process.cwd(), 'src/messaging/backends/BaileysBackend.ts');
  let src: string;

  beforeEach(() => {
    src = fs.readFileSync(baileysBackendPath, 'utf-8');
  });

  it('BaileysBackend detects 405 status code as terminal failure', () => {
    expect(src).toContain('statusCode === 405');
  });

  it('BaileysBackend detects "Connection Failure" in error message', () => {
    expect(src).toContain("errorMessage.includes('Connection Failure')");
  });

  it('BaileysBackend extracts statusCode from both Boom and plain errors', () => {
    // Boom errors (v6): err.output.statusCode
    expect(src).toContain('err?.output?.statusCode');
    // Plain errors: err.statusCode
    expect(src).toContain('err?.statusCode');
  });

  it('terminal failures (405/403) do NOT trigger reconnect', () => {
    const connectionCloseSection = src.substring(
      src.indexOf("if (connection === 'close')"),
      src.indexOf('// Message events'),
    );

    // The "else if (isTerminalFailure)" block should not contain scheduleReconnect.
    // Note: the loggedOut block above it CAN have scheduleReconnect for stale cred recovery,
    // so we specifically check the isTerminalFailure else-if block.
    const terminalBlockStart = connectionCloseSection.indexOf('} else if (isTerminalFailure)');
    const terminalBlockEnd = connectionCloseSection.indexOf('} else {', terminalBlockStart + 1);
    const terminalBlock = connectionCloseSection.substring(terminalBlockStart, terminalBlockEnd);
    expect(terminalBlock).toContain("Don't reconnect");
    expect(terminalBlock).not.toContain('scheduleReconnect');
  });

  it('terminal failure handler calls onError and setLastError', () => {
    const closeSection = src.substring(
      src.indexOf("if (connection === 'close')"),
      src.indexOf('// Message events'),
    );
    expect(closeSection).toContain('onError');
    expect(closeSection).toContain('setLastError');
  });

  it('does not pass printQRInTerminal option to makeWASocket', () => {
    // The comment mentioning it is fine — just ensure it's not used as a config option
    const makeWASocketSection = src.substring(
      src.indexOf('makeWASocket({'),
      src.indexOf('});', src.indexOf('makeWASocket({')) + 3,
    );
    expect(makeWASocketSection).not.toContain('printQRInTerminal:');
  });

  it('reconnect backoff delays are defined and escalating', () => {
    expect(src).toContain('BASE_DELAYS');
    const delayMatch = src.match(/BASE_DELAYS\s*=\s*\[([\d,\s]+)\]/);
    expect(delayMatch).not.toBeNull();
    const delays = delayMatch![1].split(',').map(d => parseInt(d.trim()));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });
});

// ── Issue 3: Pairing code timing (fixed: request on QR event, not connection open) ──

describe('Issue 3: Pairing code requests on QR event', () => {
  const baileysBackendPath = path.join(process.cwd(), 'src/messaging/backends/BaileysBackend.ts');
  let src: string;

  beforeEach(() => {
    src = fs.readFileSync(baileysBackendPath, 'utf-8');
  });

  it('requestPairingCode is called in the QR event handler, NOT inside connection open', () => {
    // The fix: pairing code must be requested when QR fires (socket connected to WA servers),
    // NOT after connection === 'open' (which only fires AFTER auth completes — chicken-and-egg).
    const qrSection = src.substring(
      src.indexOf('if (qr)'),
      src.indexOf("if (connection === 'open')"),
    );
    expect(qrSection).toContain('requestPairingCode');

    // Should NOT be in the connection open block
    const openSection = src.substring(
      src.indexOf("if (connection === 'open')"),
      src.indexOf("if (connection === 'close')"),
    );
    expect(openSection).not.toContain('requestPairingCode');
  });

  it('uses _pairingCodeRequested flag to prevent duplicate requests', () => {
    expect(src).toContain('_pairingCodeRequested');
    // Should check the flag before requesting
    const qrSection = src.substring(
      src.indexOf('if (qr)'),
      src.indexOf("if (connection === 'open')"),
    );
    expect(qrSection).toContain('!this._pairingCodeRequested');
    // Should set it to true before calling
    expect(qrSection).toContain('this._pairingCodeRequested = true');
  });

  it('resets _pairingCodeRequested on failure to allow retry', () => {
    const qrSection = src.substring(
      src.indexOf('if (qr)'),
      src.indexOf("if (connection === 'open')"),
    );
    // In the catch block, should reset the flag
    const catchIdx = qrSection.indexOf('catch (pairErr)');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = qrSection.substring(catchIdx, catchIdx + 200);
    expect(catchBlock).toContain('this._pairingCodeRequested = false');
  });

  it('resets _pairingCodeRequested on successful connection for future reconnections', () => {
    const openSection = src.substring(
      src.indexOf("if (connection === 'open')"),
      src.indexOf("if (connection === 'close')"),
    );
    expect(openSection).toContain('this._pairingCodeRequested = false');
  });

  it('requestPairingCode is NOT called outside the connection handler', () => {
    const afterHandlers = src.substring(src.indexOf("// Message events"));
    const connectEnd = afterHandlers.substring(0, afterHandlers.indexOf('disconnect'));
    expect(connectEnd).not.toContain('requestPairingCode');
  });

  it('requestPairingCode has error handling', () => {
    const qrSection = src.substring(
      src.indexOf('if (qr)'),
      src.indexOf("if (connection === 'open')"),
    );
    expect(qrSection).toContain('catch');
    expect(qrSection).toContain('Failed to request pairing code');
  });
});

// ── Issue 3: Dashboard QR polling ────────────────────────────────

describe('Issue 3: Dashboard QR polling error handling', () => {
  const dashboardPath = path.join(process.cwd(), 'dashboard/index.html');
  let dashboardSrc: string;

  beforeEach(() => {
    dashboardSrc = fs.readFileSync(dashboardPath, 'utf-8');
  });

  it('pollWaQr handles 401/403 errors with a visible message', () => {
    expect(dashboardSrc).toContain('r.status === 401');
    expect(dashboardSrc).toContain('r.status === 403');
    expect(dashboardSrc).toContain('Authentication failed');
  });

  it('pollWaQr handles non-ok responses with error info instead of silently returning null', () => {
    // The old code just had: if (!r.ok) return null;
    // The new code should show an error message
    const pollSection = dashboardSrc.substring(
      dashboardSrc.indexOf('function pollWaQr()'),
      dashboardSrc.indexOf('function updateWaButton'),
    );
    // Should show HTTP status in error message
    expect(pollSection).toContain("'Error fetching QR code (HTTP '");
  });

  it('pollWaQr catch block surfaces network errors', () => {
    const pollSection = dashboardSrc.substring(
      dashboardSrc.indexOf('function pollWaQr()'),
      dashboardSrc.indexOf('function updateWaButton'),
    );
    // Old code had: .catch(() => {});
    // New code should show connection error
    expect(pollSection).toContain('Connection error');
    expect(pollSection).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
  });

  it('dashboard has WhatsApp QR panel with proper auth flow', () => {
    // Dashboard should fetch /whatsapp/qr with Bearer token
    expect(dashboardSrc).toContain("'Authorization': `Bearer ${token}`");
    expect(dashboardSrc).toContain('/whatsapp/qr');
  });

  it('dashboard PIN input is visible (not hidden by CSS)', () => {
    // The PIN input element itself should not have display:none or visibility:hidden
    const pinIdx = dashboardSrc.indexOf('id="pinInput"');
    // Extract just the <input ...> tag containing the pinInput id
    const tagStart = dashboardSrc.lastIndexOf('<input', pinIdx);
    const tagEnd = dashboardSrc.indexOf('>', pinIdx) + 1;
    const pinTag = dashboardSrc.substring(tagStart, tagEnd);
    expect(pinTag).not.toContain('display:none');
    expect(pinTag).not.toContain('display: none');
    expect(pinTag).not.toContain('visibility:hidden');
    expect(pinTag).not.toContain('visibility: hidden');
  });

  it('dashboard has QR timeout logic (30s)', () => {
    expect(dashboardSrc).toContain('WA_QR_TIMEOUT_MS');
    expect(dashboardSrc).toContain('30000');
    // Should show timeout message
    expect(dashboardSrc).toContain('timed out');
  });

  it('dashboard displays adapter error when present', () => {
    // renderQrPanel should check data.error
    expect(dashboardSrc).toContain('data.error');
    expect(dashboardSrc).toContain('connection failed');
  });

  it('dashboard captures lastError from poll responses', () => {
    expect(dashboardSrc).toContain('waLastError');
    // Should store error from data
    expect(dashboardSrc).toContain('data.error');
  });

  it('dashboard has escapeHtml helper for safe error display', () => {
    expect(dashboardSrc).toContain('function escapeHtml');
  });
});

// ── Server-side dashboard auth ───────────────────────────────────

describe('Server dashboard unlock endpoint', () => {
  const serverPath = path.join(process.cwd(), 'src/server/AgentServer.ts');
  let serverSrc: string;

  beforeEach(() => {
    serverSrc = fs.readFileSync(serverPath, 'utf-8');
  });

  it('checks for missing dashboardPin or authToken before unlock', () => {
    expect(serverSrc).toContain('dashboardPin');
    expect(serverSrc).toContain('authToken');
  });

  it('/dashboard/unlock endpoint uses timing-safe comparison for PIN', () => {
    expect(serverSrc).toContain('timingSafeEqual');
  });

  it('/dashboard/unlock endpoint has rate limiting', () => {
    expect(serverSrc).toContain('MAX_ATTEMPTS');
    expect(serverSrc).toContain('status(429)');
  });
});

// ── Issue 5: Baileys bundled + wizard pre-flight ─────────────────

describe('Issue 5: Baileys as bundled dependency + wizard pre-flight', () => {
  it('package.json has baileys in optionalDependencies (not peerDependencies)', () => {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    // Should be in optionalDependencies
    expect(pkg.optionalDependencies?.baileys).toBeDefined();
    // Should NOT be in peerDependencies
    expect(pkg.peerDependencies?.['@whiskeysockets/baileys']).toBeUndefined();
    expect(pkg.peerDependencies?.baileys).toBeUndefined();
  });

  it('package.json uses baileys v7 (not @whiskeysockets/baileys v6)', () => {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const version = pkg.optionalDependencies?.baileys;
    expect(version).toMatch(/\^7/);
  });

  it('setup wizard has Baileys pre-flight check', () => {
    const skillPath = path.join(process.cwd(), '.claude/skills/setup-wizard/SKILL.md');
    const skill = fs.readFileSync(skillPath, 'utf-8');
    expect(skill).toContain('BAILEYS_V7_OK');
    expect(skill).toContain('BAILEYS_NOT_FOUND');
    expect(skill).toContain('npm install baileys@latest');
  });

  it('setup wizard has QR timeout with fallback instructions', () => {
    const skillPath = path.join(process.cwd(), '.claude/skills/setup-wizard/SKILL.md');
    const skill = fs.readFileSync(skillPath, 'utf-8');
    expect(skill).toContain('TIMEOUT CHECK');
    expect(skill).toContain('30 seconds');
    expect(skill).toContain('Do NOT keep waiting silently');
  });
});

// ── WhatsApp adapter error reporting ────────────────────────────

describe('WhatsApp adapter error reporting', () => {
  it('WhatsAppAdapter has lastError field in status', () => {
    const adapterPath = path.join(process.cwd(), 'src/messaging/WhatsAppAdapter.ts');
    const src = fs.readFileSync(adapterPath, 'utf-8');
    expect(src).toContain('lastError: string | null');
    expect(src).toContain('setLastError');
  });

  it('/whatsapp/qr endpoint includes error field', () => {
    const routesPath = path.join(process.cwd(), 'src/server/routes.ts');
    const src = fs.readFileSync(routesPath, 'utf-8');
    // Find the qr endpoint and get enough context to include the res.json call
    const qrStart = src.indexOf("router.get('/whatsapp/qr'");
    const qrSection = src.substring(qrStart, qrStart + 500);
    expect(qrSection).toContain('lastError');
  });
});

// ── Issue 6: Config structure mismatch (getBaileysConfig fallback) ──

describe('Issue 6: getBaileysConfig() falls back to top-level config', () => {
  const adapterPath = path.join(process.cwd(), 'src/messaging/WhatsAppAdapter.ts');
  let src: string;

  beforeEach(() => {
    src = fs.readFileSync(adapterPath, 'utf-8');
  });

  it('getBaileysConfig falls back to top-level authMethod when baileys key is missing', () => {
    const fnStart = src.indexOf('getBaileysConfig()');
    const fnEnd = src.indexOf('\n  }', fnStart);
    const fnBody = src.substring(fnStart, fnEnd);
    // Should reference topLevel or this.config for authMethod fallback
    expect(fnBody).toContain('topLevel.authMethod');
  });

  it('getBaileysConfig falls back to top-level pairingPhoneNumber when baileys key is missing', () => {
    const fnStart = src.indexOf('getBaileysConfig()');
    const fnEnd = src.indexOf('\n  }', fnStart);
    const fnBody = src.substring(fnStart, fnEnd);
    expect(fnBody).toContain('topLevel.pairingPhoneNumber');
  });

  it('getBaileysConfig prefers nested baileys values over top-level', () => {
    const fnStart = src.indexOf('getBaileysConfig()');
    const fnEnd = src.indexOf('\n  }', fnStart);
    const fnBody = src.substring(fnStart, fnEnd);
    // bc.authMethod should be checked first (before topLevel)
    const bcIndex = fnBody.indexOf('bc.authMethod');
    const topLevelIndex = fnBody.indexOf('topLevel.authMethod');
    expect(bcIndex).toBeLessThan(topLevelIndex);
  });

  it('getBaileysConfig defaults to qr when neither nested nor top-level authMethod exists', () => {
    const fnStart = src.indexOf('getBaileysConfig()');
    const fnEnd = src.indexOf('\n  }', fnStart);
    const fnBody = src.substring(fnStart, fnEnd);
    // Should have 'qr' as final fallback
    expect(fnBody).toContain("?? 'qr'");
  });
});

// ── Issue 7: Stale credential handling (401 after incomplete pairing) ──

describe('Issue 7: Stale credential auto-clear on 401', () => {
  const baileysBackendPath = path.join(process.cwd(), 'src/messaging/backends/BaileysBackend.ts');
  let src: string;

  beforeEach(() => {
    src = fs.readFileSync(baileysBackendPath, 'utf-8');
  });

  it('checks creds.json age when receiving a 401 (loggedOut)', () => {
    const loggedOutSection = src.substring(
      src.indexOf('if (loggedOut)'),
      src.indexOf('} else if (isTerminalFailure)'),
    );
    expect(loggedOutSection).toContain('creds.json');
    expect(loggedOutSection).toContain('statSync');
    expect(loggedOutSection).toContain('ageMs');
  });

  it('uses 5-minute threshold to distinguish stale incomplete pairing from real logout', () => {
    const loggedOutSection = src.substring(
      src.indexOf('if (loggedOut)'),
      src.indexOf('} else if (isTerminalFailure)'),
    );
    expect(loggedOutSection).toContain('5 * 60 * 1000');
  });

  it('auto-clears auth directory when credentials are stale from incomplete pairing', () => {
    const loggedOutSection = src.substring(
      src.indexOf('if (loggedOut)'),
      src.indexOf('} else if (isTerminalFailure)'),
    );
    expect(loggedOutSection).toContain('rmSync');
    expect(loggedOutSection).toContain('recursive: true');
    expect(loggedOutSection).toContain('force: true');
    // Should recreate the directory after clearing
    expect(loggedOutSection).toContain('mkdirSync');
  });

  it('schedules reconnect after clearing stale credentials', () => {
    const loggedOutSection = src.substring(
      src.indexOf('if (isStaleIncomplete)'),
      src.indexOf('} else {'),
    );
    expect(loggedOutSection).toContain('scheduleReconnect');
  });

  it('resets _pairingCodeRequested after clearing stale credentials', () => {
    const loggedOutSection = src.substring(
      src.indexOf('if (isStaleIncomplete)'),
      src.indexOf('} else {'),
    );
    expect(loggedOutSection).toContain('this._pairingCodeRequested = false');
  });

  it('still treats genuine logout (old creds) as terminal', () => {
    const loggedOutSection = src.substring(
      src.indexOf('if (loggedOut)'),
      src.indexOf('} else if (isTerminalFailure)'),
    );
    // The else branch (not stale) should call onDisconnected with logged-out
    expect(loggedOutSection).toContain("onDisconnected('logged-out', false)");
  });

  it('handles missing creds.json gracefully (no crash)', () => {
    const loggedOutSection = src.substring(
      src.indexOf('if (loggedOut)'),
      src.indexOf('} else if (isTerminalFailure)'),
    );
    // Should have try/catch around statSync
    expect(loggedOutSection).toContain('catch');
    expect(loggedOutSection).toContain('no creds file');
  });
});

// ── Helpers ──────────────────────────────────────────────────────

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...findTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}
