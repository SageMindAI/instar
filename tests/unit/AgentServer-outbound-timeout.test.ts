/**
 * Structural guard: AgentServer must register extended request-timeout
 * overrides on every outbound messaging route.
 *
 * A silent regression — typo in a path key, merge drop, or someone removing
 * an override during a refactor — would NOT fail the existing route tests,
 * because those tests don't exercise the 30s→120s distinction. This test
 * reads the AgentServer source and asserts each outbound-messaging prefix is
 * present in the override map, so any accidental removal fails CI.
 *
 * Background: fix for the duplicate-outbound-message bug where the 30s
 * global timeout fired on LLM-backed outbound routes. See
 * upgrades/side-effects/outbound-timeout-408-ambiguous.md.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const AGENT_SERVER_PATH = path.join(import.meta.dirname, '../../src/server/AgentServer.ts');
const source = fs.readFileSync(AGENT_SERVER_PATH, 'utf-8');

describe('AgentServer — outbound messaging timeout overrides', () => {
  const requiredPrefixes = [
    '/telegram/reply',
    '/telegram/post-update',
    '/slack/reply',
    '/whatsapp/send',
    '/imessage/reply',
    '/imessage/validate-send',
  ];

  for (const prefix of requiredPrefixes) {
    it(`wires ${prefix} to the extended-timeout override map`, () => {
      // Match 'path-prefix': NUMBER as it appears in the requestTimeout call.
      // Matches both quoted-string keys ('/telegram/reply': 120_000) and any
      // reasonable whitespace.
      const pattern = new RegExp(`['"]${prefix.replace(/\//g, '\\/')}['"]\\s*:`);
      expect(source).toMatch(pattern);
    });
  }

  it('uses a numeric timeout (not the default 30s) for the outbound routes', () => {
    // The override value should be materially larger than the default 30_000.
    // Accept any value ≥ 90_000ms (90s) — gives room to tune the budget
    // without having to update this test.
    const match = source.match(/OUTBOUND_MESSAGING_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
    expect(match).not.toBeNull();
    const value = Number(match![1].replace(/_/g, ''));
    expect(value).toBeGreaterThanOrEqual(90_000);
  });

  it('still passes the global default to requestTimeout as the first arg', () => {
    // Regression guard: the global 30s default for every non-outbound route
    // must not be accidentally replaced with the outbound timeout.
    expect(source).toMatch(/requestTimeout\(options\.config\.requestTimeoutMs,/);
  });
});

describe('init.ts relay installers read from canonical templates (no inlined drift)', () => {
  const initSource = fs.readFileSync(
    path.join(import.meta.dirname, '../../src/commands/init.ts'),
    'utf-8',
  );

  it('installTelegramRelay uses loadRelayTemplate (not inlined bash)', () => {
    // Extract the function body and assert it delegates to loadRelayTemplate.
    // Prevents regression back to the old 70+ line inlined bash that went
    // out of sync with src/templates/scripts/telegram-reply.sh.
    const fnMatch = initSource.match(/function installTelegramRelay\([\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).toContain("loadRelayTemplate('telegram-reply.sh'");
    // Sanity: it must NOT contain the old inlined 200-branch echo, which
    // would indicate a partial revert.
    expect(fnMatch![0]).not.toMatch(/echo "Sent \$\(echo "\$MSG"/);
  });

  it('installWhatsAppRelay uses loadRelayTemplate (not inlined bash)', () => {
    const fnMatch = initSource.match(/function installWhatsAppRelay\([\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).toContain("loadRelayTemplate('whatsapp-reply.sh'");
    expect(fnMatch![0]).not.toMatch(/echo "Sent \$\(echo "\$MSG"/);
  });

  it('loadRelayTemplate substitutes INSTAR_PORT default with the agent port', () => {
    const fnMatch = initSource.match(/function loadRelayTemplate\([\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).toMatch(/INSTAR_PORT:-4040/);
    expect(fnMatch![0]).toMatch(/INSTAR_PORT:-\$\{port\}/);
  });
});
