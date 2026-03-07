/**
 * ResumeValidator — LLM-supervised coherence gate for session resume.
 *
 * Before resuming a Claude session for a Telegram topic, validates that
 * the session's content actually matches the topic's conversation history.
 * Uses Claude CLI (via IntelligenceProvider) — no external API keys needed.
 *
 * Fail-safe: on ANY error (CLI unavailable, timeout, ambiguous response),
 * returns false — meaning "start fresh" rather than risk cross-connecting
 * topics to wrong sessions.
 *
 * Standard: LLM-Supervised Execution — all critical processes require
 * at minimum a lightweight model wrapper as the final call.
 *
 * REQUIREMENT: Instar NEVER requires external API keys for functionality
 * that can be handled by Claude Code models. This validator uses the
 * IntelligenceProvider interface (defaulting to ClaudeCliIntelligenceProvider)
 * which runs on the user's existing Claude subscription.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { IntelligenceProvider } from './types.js';

export interface TopicHistoryProvider {
  searchLog(opts: { topicId: number; limit: number }): Array<{ text: string; fromJustin?: boolean; fromUser?: boolean }>;
  getTopicName(topicId: number): string | null | undefined;
}

export interface ResumeValidatorDeps {
  /** Override topic history for testing */
  getTopicHistory?: () => Promise<{ topicName: string; messages: Array<{ sender: string; text: string }> }>;
  /** Override LLM evaluation for testing */
  evaluateFn?: (prompt: string) => Promise<string>;
  /** Override session JSONL reader for testing */
  readSessionJsonl?: (uuid: string) => string;
}

/**
 * Validate that a resume UUID's session content is coherent with a topic's history.
 *
 * @param resumeUuid - The Claude session JSONL UUID to resume
 * @param topicId - The Telegram topic ID requesting resume
 * @param topicName - Human-readable topic name
 * @param projectDir - The project directory for JSONL path resolution
 * @param telegram - Optional TelegramAdapter for reading topic history
 * @param intelligence - IntelligenceProvider (Claude CLI) for LLM judgment
 * @param deps - Injectable dependencies for testing
 */
export async function llmValidateResumeCoherence(
  resumeUuid: string,
  topicId: number,
  topicName: string,
  projectDir: string,
  telegram?: TopicHistoryProvider | null,
  intelligence?: IntelligenceProvider | null,
  deps: ResumeValidatorDeps = {},
): Promise<boolean> {
  // Must have either an IntelligenceProvider or a test evaluateFn
  if (!intelligence && !deps.evaluateFn) {
    console.warn(`[ResumeValidator] No IntelligenceProvider available — rejecting resume (fail-safe)`);
    return false;
  }

  try {
    // 1. Get topic history
    let topicHistory = `Topic name: "${topicName}"\n`;
    if (deps.getTopicHistory) {
      try {
        const history = await deps.getTopicHistory();
        if (history.messages.length > 0) {
          topicHistory += 'Recent topic messages:\n';
          for (const m of history.messages) {
            topicHistory += `  ${m.sender}: ${m.text}\n`;
          }
        } else {
          topicHistory += '(No topic message history available)\n';
        }
      } catch {
        topicHistory += '(Failed to read topic history)\n';
      }
    } else if (telegram) {
      try {
        const history = telegram.searchLog({ topicId, limit: 10 });
        if (history.length > 0) {
          topicHistory += 'Recent topic messages:\n';
          for (const m of history) {
            const sender = (m.fromJustin || m.fromUser) ? 'User' : 'Agent';
            const text = (m.text || '').slice(0, 200);
            topicHistory += `  ${sender}: ${text}\n`;
          }
        } else {
          topicHistory += '(No topic message history available)\n';
        }
      } catch {
        topicHistory += '(Failed to read topic history)\n';
      }
    }

    // 2. Sample the resume JSONL
    let sessionContext = '';
    if (deps.readSessionJsonl) {
      sessionContext = deps.readSessionJsonl(resumeUuid);
    } else {
      const projectHash = projectDir.replace(/\//g, '-');
      const jsonlPath = path.join(
        os.homedir(),
        '.claude', 'projects', projectHash,
        `${resumeUuid}.jsonl`
      );

      if (fs.existsSync(jsonlPath)) {
        try {
          const stat = fs.statSync(jsonlPath);
          const readSize = Math.min(4096, stat.size);
          const fd = fs.openSync(jsonlPath, 'r');
          const buf = Buffer.alloc(readSize);
          fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
          fs.closeSync(fd);

          const tail = buf.toString('utf-8');
          const lines = tail.split('\n').filter(l => l.trim());
          const snippets: string[] = [];
          for (const line of lines.slice(-5)) {
            try {
              const entry = JSON.parse(line);
              if (entry.message?.content) {
                const content = typeof entry.message.content === 'string'
                  ? entry.message.content.slice(0, 200)
                  : JSON.stringify(entry.message.content).slice(0, 200);
                snippets.push(content);
              }
            } catch { /* not valid JSON, skip */ }
          }
          sessionContext = snippets.length > 0
            ? `Session content samples:\n${snippets.map(s => `  ${s}`).join('\n')}`
            : '(Could not extract readable content from session JSONL)';
        } catch {
          sessionContext = '(Failed to read session JSONL)';
        }
      }
    }

    // 3. Ask the LLM for coherence judgment (via Claude CLI, no API key needed)
    const prompt = `You are a session-topic coherence validator. You must determine if a Claude session's context matches a Telegram topic's conversation history.

TOPIC CONTEXT (what this topic is about):
${topicHistory.slice(0, 1500)}

SESSION CONTEXT (what the session was doing):
${sessionContext.slice(0, 1500)}

Question: Does the session context appear to be about the SAME conversation/task as the topic?
- MATCH means the session was working on the topic's conversation
- MISMATCH means the session was doing something completely different (e.g., a different job, different topic)

If there's not enough information to tell, say MISMATCH (fail-safe).

Respond with ONLY one word: MATCH or MISMATCH`;

    const evaluate = deps.evaluateFn ?? ((p: string) => intelligence!.evaluate(p, { model: 'fast' }));
    const response = await evaluate(prompt);
    const text = response.trim().toUpperCase();

    console.log(`[ResumeValidator] Topic ${topicId} ("${topicName}") vs UUID ${resumeUuid.slice(0, 8)}...: LLM says ${text}`);

    if (text.includes('MATCH') && !text.includes('MISMATCH')) {
      return true;
    }

    console.warn(`[ResumeValidator] LLM detected MISMATCH for topic ${topicId} — will start fresh instead of resuming`);
    return false;
  } catch (err) {
    console.error(`[ResumeValidator] Error during coherence check:`, err);
    return false; // Fail-safe: don't resume if we can't validate
  }
}
