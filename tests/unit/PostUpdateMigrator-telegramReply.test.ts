/**
 * Verifies PostUpdateMigrator correctly upgrades existing agents' telegram-reply.sh
 * to the new version that handles HTTP 408 as an ambiguous-outcome (exit 0)
 * rather than a hard failure (exit 1).
 *
 * Without this migration, agents that have an older telegram-reply.sh already
 * installed would continue to treat server timeouts as send failures and
 * duplicate-send on retry — the bug fix would ship in the source but never
 * reach the install base.
 *
 * Safety guard under test: customized scripts (no "shipped" marker) are
 * preserved. Only scripts that match the shipped-shebang/header pattern AND
 * lack 408 handling are replaced.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

function createMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: true,
    projectName: 'test-agent',
  });
}

// Older shipped version — has the shebang comment but no 408 branch.
const OLD_SHIPPED_SCRIPT = `#!/bin/bash
# telegram-reply.sh — Send a message back to a Telegram topic via instar server.
TOPIC_ID="$1"
shift
MSG="\${*:-$(cat)}"
PORT="\${INSTAR_PORT:-4040}"
RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/telegram/reply/\${TOPIC_ID}" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"text\\":\\"$MSG\\"}")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent"
else
  echo "Failed" >&2
  exit 1
fi
`;

// User-customized script — no shipped-header marker, so migration must not touch.
const USER_CUSTOM_SCRIPT = `#!/bin/bash
# My custom reply script — do not touch
echo "custom behavior"
curl -X POST "http://example.com/my-endpoint" -d "$*"
`;

describe('PostUpdateMigrator — telegram-reply.sh 408 migration', () => {
  let projectDir: string;
  let scriptsDir: string;
  let scriptPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-update-mig-test-'));
    scriptsDir = path.join(projectDir, '.claude', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    scriptPath = path.join(scriptsDir, 'telegram-reply.sh');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('getTelegramReplyScript() returns a string that handles HTTP 408', () => {
    const migrator = createMigrator(projectDir);
    const script = (migrator as unknown as { getTelegramReplyScript(): string }).getTelegramReplyScript();
    expect(script).toContain('HTTP_CODE" = "408"');
    expect(script).toMatch(/ambiguous/i);
  });

  it('installs telegram-reply.sh when file is missing', async () => {
    const migrator = createMigrator(projectDir);
    const result = await migrator.migrate();
    expect(fs.existsSync(scriptPath)).toBe(true);
    const installed = fs.readFileSync(scriptPath, 'utf-8');
    expect(installed).toContain('HTTP_CODE" = "408"');
    expect(result.upgraded.some(u => u.includes('telegram-reply.sh'))).toBe(true);
  });

  it('upgrades the shipped-but-old script to the new 408-aware version', async () => {
    fs.writeFileSync(scriptPath, OLD_SHIPPED_SCRIPT, { mode: 0o755 });

    const migrator = createMigrator(projectDir);
    const result = await migrator.migrate();

    const updated = fs.readFileSync(scriptPath, 'utf-8');
    expect(updated).toContain('HTTP_CODE" = "408"');
    expect(updated).toMatch(/ambiguous/i);
    expect(result.upgraded.some(u => u.includes('HTTP 408'))).toBe(true);
  });

  it('leaves a user-customized script untouched (no shipped marker present)', async () => {
    fs.writeFileSync(scriptPath, USER_CUSTOM_SCRIPT, { mode: 0o755 });

    const migrator = createMigrator(projectDir);
    const result = await migrator.migrate();

    const after = fs.readFileSync(scriptPath, 'utf-8');
    expect(after).toBe(USER_CUSTOM_SCRIPT);
    expect(result.upgraded.some(u => u.includes('HTTP 408'))).toBe(false);
    expect(result.skipped.some(s => s.includes('telegram-reply.sh'))).toBe(true);
  });

  it('leaves an already-migrated script untouched (idempotent)', async () => {
    const migrator = createMigrator(projectDir);
    const newScript = (migrator as unknown as { getTelegramReplyScript(): string }).getTelegramReplyScript();
    fs.writeFileSync(scriptPath, newScript, { mode: 0o755 });

    const result = await migrator.migrate();

    const after = fs.readFileSync(scriptPath, 'utf-8');
    expect(after).toBe(newScript);
    expect(result.upgraded.some(u => u.includes('HTTP 408'))).toBe(false);
    expect(result.skipped.some(s => s.includes('telegram-reply.sh'))).toBe(true);
  });

  it('does not install telegram-reply.sh when Telegram is not configured', async () => {
    const migrator = new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test-agent',
    });
    await migrator.migrate();
    expect(fs.existsSync(scriptPath)).toBe(false);
  });
});

const OLD_SHIPPED_SLACK = `#!/usr/bin/env bash
# slack-reply.sh — Send a message to a Slack channel via the instar server.
CHANNEL_ID="$1"
shift
MESSAGE="$*"
RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:4042/slack/reply/\${CHANNEL_ID}" -d "$MESSAGE")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent"
else
  echo "Failed" >&2
  exit 1
fi
`;

const OLD_SHIPPED_WHATSAPP = `#!/bin/bash
# whatsapp-reply.sh — Send a message back to a WhatsApp JID via instar server.
JID="$1"
shift
MSG="$*"
PORT="\${INSTAR_PORT:-4040}"
RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/whatsapp/send/\${JID}" -d "{\\"text\\":\\"$MSG\\"}")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent"
else
  echo "Failed" >&2
  exit 1
fi
`;

describe('PostUpdateMigrator — slack-reply.sh 408 migration', () => {
  let projectDir: string;
  let scriptsDir: string;
  let scriptPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-update-mig-slack-'));
    scriptsDir = path.join(projectDir, '.claude', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    scriptPath = path.join(scriptsDir, 'slack-reply.sh');
  });
  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('upgrades the shipped-but-old slack-reply.sh to the new 408-aware version', async () => {
    fs.writeFileSync(scriptPath, OLD_SHIPPED_SLACK, { mode: 0o755 });
    const migrator = createMigrator(projectDir);
    const result = await migrator.migrate();

    const updated = fs.readFileSync(scriptPath, 'utf-8');
    expect(updated).toContain('HTTP_CODE" = "408"');
    expect(updated).toMatch(/ambiguous/i);
    expect(result.upgraded.some(u => u.includes('slack-reply.sh') && u.includes('HTTP 408'))).toBe(true);
  });

  it('leaves a custom slack-reply.sh untouched', async () => {
    fs.writeFileSync(scriptPath, USER_CUSTOM_SCRIPT, { mode: 0o755 });
    const migrator = createMigrator(projectDir);
    await migrator.migrate();
    expect(fs.readFileSync(scriptPath, 'utf-8')).toBe(USER_CUSTOM_SCRIPT);
  });

  it('does nothing when slack-reply.sh is not installed', async () => {
    const migrator = createMigrator(projectDir);
    await migrator.migrate();
    expect(fs.existsSync(scriptPath)).toBe(false);
  });
});

describe('PostUpdateMigrator — whatsapp-reply.sh 408 migration', () => {
  let projectDir: string;
  let whatsappScriptsDir: string;
  let scriptPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-update-mig-wa-'));
    whatsappScriptsDir = path.join(projectDir, '.instar', 'scripts');
    fs.mkdirSync(whatsappScriptsDir, { recursive: true });
    scriptPath = path.join(whatsappScriptsDir, 'whatsapp-reply.sh');
  });
  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('upgrades the shipped-but-old whatsapp-reply.sh to the new 408-aware version', async () => {
    fs.writeFileSync(scriptPath, OLD_SHIPPED_WHATSAPP, { mode: 0o755 });
    const migrator = createMigrator(projectDir);
    const result = await migrator.migrate();

    const updated = fs.readFileSync(scriptPath, 'utf-8');
    expect(updated).toContain('HTTP_CODE" = "408"');
    expect(updated).toMatch(/ambiguous/i);
    expect(result.upgraded.some(u => u.includes('whatsapp-reply.sh') && u.includes('HTTP 408'))).toBe(true);
  });

  it('leaves a custom whatsapp-reply.sh untouched', async () => {
    fs.writeFileSync(scriptPath, USER_CUSTOM_SCRIPT, { mode: 0o755 });
    const migrator = createMigrator(projectDir);
    await migrator.migrate();
    expect(fs.readFileSync(scriptPath, 'utf-8')).toBe(USER_CUSTOM_SCRIPT);
  });

  it('does nothing when whatsapp-reply.sh is not installed', async () => {
    const migrator = createMigrator(projectDir);
    await migrator.migrate();
    expect(fs.existsSync(scriptPath)).toBe(false);
  });
});
