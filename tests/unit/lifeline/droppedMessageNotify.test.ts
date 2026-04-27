import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { notifyMessageDropped } from '../../../src/lifeline/droppedMessages.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';

describe('notifyMessageDropped', () => {
  let stateDir: string;

  beforeEach(() => {
    DegradationReporter.resetForTesting();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-notify-test-'));
  });

  afterEach(() => {
    DegradationReporter.resetForTesting();
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('persists the drop, reports to DegradationReporter, and sends a user-visible notice', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir, agentName: 'test', instarVersion: '0.0.0' });
    const reportSpy = vi.spyOn(reporter, 'report');

    const sendToTopic = vi.fn().mockResolvedValue(undefined);

    await notifyMessageDropped({
      stateDir,
      topicId: 5447,
      messageId: 'tg-789',
      senderName: 'Justin',
      text: 'hi echo, can you hear me?',
      retryCount: 3,
      reason: 'server returned 500 on all 3 retries',
      sendToTopic,
    });

    // (1) Persisted
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'dropped-messages.json'), 'utf-8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].messageId).toBe('tg-789');

    // (2) Reported
    expect(reportSpy).toHaveBeenCalledTimes(1);
    const reportArg = reportSpy.mock.calls[0][0];
    expect(reportArg.feature).toBe('TelegramLifeline.forwardToServer');
    expect(reportArg.reason).toMatch(/server returned 500/);

    // (3) User notified in original topic with ELI10 text
    expect(sendToTopic).toHaveBeenCalledTimes(1);
    expect(sendToTopic).toHaveBeenCalledWith(5447, expect.any(String));
    const noticeText = sendToTopic.mock.calls[0][1];
    expect(noticeText).toContain("couldn't deliver");
    expect(noticeText).toContain('resend');
    expect(noticeText).toContain('hi echo, can you hear me?');
    // Preview is wrapped in a code fence so Markdown parse_mode can't render user content
    expect(noticeText).toMatch(/```\n.*hi echo.*\n```/s);
  });

  it('escapes markdown breakout attempts in the preview', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir, agentName: 'test', instarVersion: '0.0.0' });

    const sendToTopic = vi.fn().mockResolvedValue(undefined);
    const malicious = 'innocent\n```\n[click me](http://evil)\n*BOLD*';

    await notifyMessageDropped({
      stateDir,
      topicId: 1,
      messageId: 'tg-mal',
      senderName: 's',
      text: malicious,
      retryCount: 3,
      reason: 'r',
      sendToTopic,
    });

    const noticeText = sendToTopic.mock.calls[0][1] as string;
    // Triple-backtick breakout is neutralized
    const backtickRuns = noticeText.match(/```/g) ?? [];
    expect(backtickRuns).toHaveLength(2); // only the wrapping fence
  });

  it('bounds sendToTopic with a timeout so a hung Telegram does not block', async () => {
    vi.useFakeTimers();
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir, agentName: 'test', instarVersion: '0.0.0' });

    const sendToTopic = vi.fn(() => new Promise<void>(() => { /* never resolves */ }));

    const p = notifyMessageDropped({
      stateDir,
      topicId: 1,
      messageId: 'tg-hang',
      senderName: 's',
      text: 'test',
      retryCount: 3,
      reason: 'r',
      sendToTopic,
    });

    await vi.advanceTimersByTimeAsync(6000);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('fires a distinct DegradationReporter feature when persistence itself fails', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir, agentName: 'test', instarVersion: '0.0.0' });
    const reportSpy = vi.spyOn(reporter, 'report');

    // Make the state dir unwritable to force persist failure.
    const badStateDir = path.join(stateDir, 'readonly');
    fs.mkdirSync(badStateDir, { recursive: true });
    fs.chmodSync(badStateDir, 0o500);

    const sendToTopic = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyMessageDropped({
        stateDir: badStateDir,
        topicId: 1,
        messageId: 'tg-noperm',
        senderName: 's',
        text: 'test',
        retryCount: 3,
        reason: 'primary reason',
        sendToTopic,
      });

      const features = reportSpy.mock.calls.map(c => (c[0] as { feature: string }).feature);
      expect(features).toContain('TelegramLifeline.forwardToServer');
      expect(features).toContain('TelegramLifeline.dropRecordPersist');
    } finally {
      fs.chmodSync(badStateDir, 0o700);
    }
  });

  it('still persists and reports even if sendToTopic throws (best-effort notification)', async () => {
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir, agentName: 'test', instarVersion: '0.0.0' });
    const reportSpy = vi.spyOn(reporter, 'report');

    const sendToTopic = vi.fn().mockRejectedValue(new Error('telegram unreachable'));

    await expect(
      notifyMessageDropped({
        stateDir,
        topicId: 1,
        messageId: 'tg-x',
        senderName: 'x',
        text: 'hello',
        retryCount: 3,
        reason: 'r',
        sendToTopic,
      })
    ).resolves.toBeUndefined();

    expect(reportSpy).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'dropped-messages.json'), 'utf-8'));
    expect(saved).toHaveLength(1);
  });
});
