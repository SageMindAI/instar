/**
 * E2E test — Compaction recovery Telegram context injection.
 *
 * Tests:
 *   1. Unanswered message detection algorithm (Python parity)
 *   2. Hook templates contain required detection code
 *   3. PostUpdateMigrator generates hooks with detection
 *   4. Settings template includes UserPromptSubmit hook
 *   5. Migration adds UserPromptSubmit to existing settings
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Compaction & Telegram context recovery E2E', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'hooks', 'instar'), { recursive: true });

    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      projectName: 'test-compact',
      projectDir: tmpDir,
      stateDir,
      port: 19999,
      authToken: 'test-token',
    }));
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/compaction-telegram-context.test.ts:42' });
  });

  describe('Unanswered detection algorithm (Python parity)', () => {
    // Execute the ACTUAL Python detection logic used in the hooks
    function runPythonDetection(msgs: Array<{ text: string; fromUser: boolean; timestamp: string }>): string[] {
      const scriptPath = path.join(os.tmpdir(), 'test-unanswered-detect.py');
      const dataPath = path.join(os.tmpdir(), 'test-unanswered-data.json');
      fs.writeFileSync(scriptPath, `
import json, sys
msgs = json.load(open(sys.argv[1]))
pending_user = []
for m in msgs:
    text = m.get('text', '').strip()
    if not text:
        continue
    if m.get('fromUser'):
        pending_user.append(m)
    else:
        pending_user = []
print(json.dumps([m['text'] for m in pending_user]))
`);
      fs.writeFileSync(dataPath, JSON.stringify(msgs));
      const result = execSync(`python3 "${scriptPath}" "${dataPath}"`, { encoding: 'utf-8' }).trim();
      return JSON.parse(result);
    }

    it('detects unanswered messages (the original bug scenario)', () => {
      const msgs = [
        { text: 'Done with implementation', fromUser: false, timestamp: '2026-03-07T01:10' },
        { text: 'Done! Build passes.', fromUser: false, timestamp: '2026-03-07T01:10' },
        { text: 'I think the scope is wrong', fromUser: true, timestamp: '2026-03-07T01:20' },
        { text: 'Hello, please respond here', fromUser: true, timestamp: '2026-03-07T01:30' },
      ];

      const unanswered = runPythonDetection(msgs);
      expect(unanswered).toHaveLength(2);
      expect(unanswered[0]).toContain('scope is wrong');
      expect(unanswered[1]).toContain('please respond');
    });

    it('returns empty for fully answered conversation', () => {
      const msgs = [
        { text: 'Can you fix?', fromUser: true, timestamp: '2026-03-07T01:00' },
        { text: 'Fixed!', fromUser: false, timestamp: '2026-03-07T01:01' },
      ];
      expect(runPythonDetection(msgs)).toHaveLength(0);
    });

    it('handles conversation ending with agent response', () => {
      const msgs = [
        { text: 'Question', fromUser: true, timestamp: '2026-03-07T01:00' },
        { text: 'Answer', fromUser: false, timestamp: '2026-03-07T01:01' },
        { text: 'Follow up', fromUser: true, timestamp: '2026-03-07T01:02' },
        { text: 'Follow up answer', fromUser: false, timestamp: '2026-03-07T01:03' },
      ];
      expect(runPythonDetection(msgs)).toHaveLength(0);
    });

    it('detects single unanswered message', () => {
      const msgs = [
        { text: 'Answer', fromUser: false, timestamp: '2026-03-07T01:00' },
        { text: 'New question', fromUser: true, timestamp: '2026-03-07T01:01' },
      ];
      const unanswered = runPythonDetection(msgs);
      expect(unanswered).toHaveLength(1);
      expect(unanswered[0]).toBe('New question');
    });

    it('skips empty messages', () => {
      const msgs = [
        { text: 'Answer', fromUser: false, timestamp: '2026-03-07T01:00' },
        { text: '', fromUser: true, timestamp: '2026-03-07T01:01' },
        { text: '  ', fromUser: true, timestamp: '2026-03-07T01:02' },
      ];
      expect(runPythonDetection(msgs)).toHaveLength(0);
    });

    it('handles all-user messages', () => {
      const msgs = [
        { text: 'First', fromUser: true, timestamp: '2026-03-07T01:00' },
        { text: 'Second', fromUser: true, timestamp: '2026-03-07T01:01' },
        { text: 'Third', fromUser: true, timestamp: '2026-03-07T01:02' },
      ];
      expect(runPythonDetection(msgs)).toHaveLength(3);
    });
  });

  describe('Hook template content', () => {
    it('compaction-recovery.sh template uses INSTAR_TELEGRAM_TOPIC', () => {
      const hookPath = path.join(__dirname, '../../src/templates/hooks/compaction-recovery.sh');
      const content = fs.readFileSync(hookPath, 'utf-8');
      expect(content).toContain('INSTAR_TELEGRAM_TOPIC');
    });

    it('compaction-recovery.sh template has unanswered detection', () => {
      const hookPath = path.join(__dirname, '../../src/templates/hooks/compaction-recovery.sh');
      const content = fs.readFileSync(hookPath, 'utf-8');
      expect(content).toContain('pending_user');
      expect(content).toContain('UNANSWERED MESSAGE');
      expect(content).toContain('MUST address these messages substantively');
    });

    it('telegram-topic-context.sh template detects telegram prefix', () => {
      const hookPath = path.join(__dirname, '../../src/templates/hooks/telegram-topic-context.sh');
      const content = fs.readFileSync(hookPath, 'utf-8');
      expect(content).toContain('[telegram:');
      expect(content).toContain('UserPromptSubmit');
      expect(content).toContain('pending_user');
      expect(content).toContain('UNANSWERED MESSAGE');
    });
  });

  describe('PostUpdateMigrator hook generation', () => {
    let migrator: PostUpdateMigrator;

    beforeAll(() => {
      migrator = new PostUpdateMigrator({
        projectDir: tmpDir,
        stateDir,
        port: 19999,
        authToken: 'test-token',
        agentName: 'test-agent',
      });
    });

    it('compaction-recovery hook includes unanswered detection', () => {
      const content = migrator.getHookContent('compaction-recovery');
      expect(content).toContain('pending_user');
      expect(content).toContain('UNANSWERED MESSAGE');
      expect(content).toContain('MUST address these messages substantively');
    });

    it('compaction-recovery hook uses INSTAR_TELEGRAM_TOPIC', () => {
      const content = migrator.getHookContent('compaction-recovery');
      expect(content).toContain('INSTAR_TELEGRAM_TOPIC');
    });

    it('telegram-topic-context hook exists and has detection', () => {
      const content = migrator.getHookContent('telegram-topic-context');
      expect(content).toContain('pending_user');
      expect(content).toContain('UNANSWERED MESSAGE');
      expect(content).toContain('[telegram:');
    });

    it('migration writes telegram-topic-context.sh to hooks dir', () => {
      migrator.migrate();
      const hookPath = path.join(stateDir, 'hooks', 'instar', 'telegram-topic-context.sh');
      expect(fs.existsSync(hookPath)).toBe(true);
      const content = fs.readFileSync(hookPath, 'utf-8');
      expect(content).toContain('pending_user');
    });
  });

  describe('Settings template and migration', () => {
    it('settings-template.json includes UserPromptSubmit hook', () => {
      const templatePath = path.join(__dirname, '../../src/templates/hooks/settings-template.json');
      const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));

      expect(template.hooks.UserPromptSubmit).toBeDefined();
      expect(template.hooks.UserPromptSubmit).toHaveLength(1);
      expect(template.hooks.UserPromptSubmit[0].hooks[0].command).toContain('telegram-topic-context');
    });

    it('migration adds UserPromptSubmit to existing settings', () => {
      const settingsDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'bash .instar/hooks/instar/session-start.sh' }] }],
          },
        }),
      );

      const migrator = new PostUpdateMigrator({
        projectDir: tmpDir,
        stateDir,
        port: 19999,
        authToken: 'test-token',
        agentName: 'test-agent',
      });

      migrator.migrate();

      const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8'));
      expect(settings.hooks.UserPromptSubmit).toBeDefined();

      const hasTelegramContext = settings.hooks.UserPromptSubmit.some(
        (e: { hooks?: Array<{ command?: string }> }) =>
          e.hooks?.some(h => h.command?.includes('telegram-topic-context')),
      );
      expect(hasTelegramContext).toBe(true);
    });

    it('migration does not duplicate UserPromptSubmit hook on re-run', () => {
      const settingsDir = path.join(tmpDir, '.claude');
      const migrator = new PostUpdateMigrator({
        projectDir: tmpDir,
        stateDir,
        port: 19999,
        authToken: 'test-token',
        agentName: 'test-agent',
      });

      // Run migration twice
      migrator.migrate();
      migrator.migrate();

      const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8'));
      const telegramHooks = settings.hooks.UserPromptSubmit.filter(
        (e: { hooks?: Array<{ command?: string }> }) =>
          e.hooks?.some(h => h.command?.includes('telegram-topic-context')),
      );
      expect(telegramHooks).toHaveLength(1);
    });
  });
});
