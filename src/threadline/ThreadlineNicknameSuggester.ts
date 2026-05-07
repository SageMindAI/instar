/**
 * ThreadlineNicknameSuggester — propose 1-2 word display nicknames for
 * threadline agents that show up only as 8-char fingerprints.
 *
 * Pipeline:
 *   1. Pull thread summaries from ThreadlineObservability
 *   2. Filter to agents with no friendly name AND no existing nickname
 *   3. Pull recent messages, send to a "fast" intelligence (Haiku) for naming
 *   4. Persist via ThreadlineNicknames with source: 'haiku'
 *
 * Heuristic guards that ensure we never overwrite something better:
 *   - Skips if a user/import nickname is already set
 *   - Skips if the agent already has a registry/declared name
 *   - Skips threads with fewer than the configured minimum messages
 *
 * Designed to be cheap and idempotent — safe to run on a periodic schedule
 * AND on demand from the dashboard.
 */

import type { IntelligenceProvider } from '../core/types.js';
import type { ThreadlineNicknames } from './ThreadlineNicknames.js';
import type { ThreadlineObservability } from './ThreadlineObservability.js';

export interface SuggestionApplied {
  fingerprint: string;
  nickname: string;
  source: 'haiku';
  basedOnThreadId: string;
  sampleMessageCount: number;
}

export interface SuggestionSkipped {
  fingerprint: string;
  reason: string;
}

export interface SuggestRunResult {
  scannedThreads: number;
  candidateAgents: number;
  applied: SuggestionApplied[];
  skipped: SuggestionSkipped[];
  durationMs: number;
}

export interface ThreadlineNicknameSuggesterOptions {
  observability: ThreadlineObservability;
  nicknames: ThreadlineNicknames;
  /** When omitted or null, the suggester is a no-op (returns empty result). */
  intelligence?: IntelligenceProvider | null;
  /** Minimum messages on a thread before we'll attempt naming (default 2). */
  minMessages?: number;
  /** Cap how many agents we name per run, to bound cost (default 5). */
  maxPerRun?: number;
  /** Optional logger — useful for periodic scheduler runs. */
  logger?: (line: string) => void;
}

const DEFAULT_MIN_MESSAGES = 2;
const DEFAULT_MAX_PER_RUN = 5;
const SAMPLE_SIZE = 10;
const PER_MESSAGE_MAX_CHARS = 240;
const NICKNAME_MAX_CHARS = 24;

export class ThreadlineNicknameSuggester {
  private readonly observability: ThreadlineObservability;
  private readonly nicknames: ThreadlineNicknames;
  private readonly intelligence: IntelligenceProvider | null;
  private readonly minMessages: number;
  private readonly maxPerRun: number;
  private readonly log: (line: string) => void;

  constructor(opts: ThreadlineNicknameSuggesterOptions) {
    this.observability = opts.observability;
    this.nicknames = opts.nicknames;
    this.intelligence = opts.intelligence ?? null;
    this.minMessages = opts.minMessages ?? DEFAULT_MIN_MESSAGES;
    this.maxPerRun = opts.maxPerRun ?? DEFAULT_MAX_PER_RUN;
    this.log = opts.logger ?? (() => {});
  }

  /** True iff there's an intelligence provider wired. */
  isAvailable(): boolean {
    return this.intelligence !== null;
  }

  /**
   * Scan threadline observability for agents lacking a friendly name and
   * propose nicknames via the configured intelligence provider.
   */
  async run(opts?: { dryRun?: boolean; max?: number }): Promise<SuggestRunResult> {
    const startedAt = Date.now();
    const applied: SuggestionApplied[] = [];
    const skipped: SuggestionSkipped[] = [];

    if (!this.intelligence) {
      return {
        scannedThreads: 0,
        candidateAgents: 0,
        applied,
        skipped: [{ fingerprint: '*', reason: 'no intelligence provider configured' }],
        durationMs: Date.now() - startedAt,
      };
    }

    const threads = this.observability.listThreads();

    // Group threads by counterparty fingerprint, keeping the most-recent thread
    // first (listThreads() already sorts that way).
    const candidatesByAgent = new Map<string, { threadId: string; messageCount: number }[]>();
    for (const t of threads) {
      const fp = t.remoteAgent;
      if (!fp || fp === '(unknown)') continue;
      // Already has a user/haiku/import nickname → skip entirely
      if (this.nicknames.get(fp)) continue;
      // Already resolves to a friendly name (registry, inline senderName, etc.) → skip
      if (!this.observability.hasNoFriendlyName(fp)) continue;

      const list = candidatesByAgent.get(fp) ?? [];
      list.push({ threadId: t.threadId, messageCount: t.messageCount });
      candidatesByAgent.set(fp, list);
    }

    const cap = Math.min(opts?.max ?? this.maxPerRun, this.maxPerRun);
    let processed = 0;

    for (const [fingerprint, threadList] of candidatesByAgent) {
      if (processed >= cap) {
        skipped.push({ fingerprint, reason: 'max-per-run cap reached' });
        continue;
      }

      // Pick the most-recent thread that has enough messages
      const usable = threadList.find(t => t.messageCount >= this.minMessages) ?? threadList[0];
      if (!usable || usable.messageCount < this.minMessages) {
        skipped.push({ fingerprint, reason: `< ${this.minMessages} messages — too thin to name` });
        continue;
      }

      const detail = this.observability.getThread(usable.threadId);
      if (!detail || detail.messages.length === 0) {
        skipped.push({ fingerprint, reason: 'thread detail unavailable' });
        continue;
      }

      const sample = detail.messages.slice(-SAMPLE_SIZE);
      const transcript = sample
        .map(m => `[${m.direction === 'in' ? 'them' : 'us'}] ${truncate(extractText(m.text), PER_MESSAGE_MAX_CHARS)}`)
        .join('\n');

      const prompt = buildPrompt(transcript);

      let raw: string;
      try {
        raw = await this.intelligence.evaluate(prompt, {
          model: 'fast',
          maxTokens: 24,
          temperature: 0.4,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        skipped.push({ fingerprint, reason: `intelligence call failed: ${reason}` });
        this.log(`[nickname-suggester] ${fingerprint.slice(0, 8)} failed: ${reason}`);
        continue;
      }

      processed++;

      const cleaned = sanitizeNickname(raw);
      if (!cleaned) {
        skipped.push({ fingerprint, reason: `model returned no usable name (raw: ${truncate(raw, 60)})` });
        continue;
      }

      if (!opts?.dryRun) {
        try {
          this.nicknames.set(fingerprint, cleaned, 'haiku');
        } catch (err) {
          skipped.push({ fingerprint, reason: `persist failed: ${err instanceof Error ? err.message : String(err)}` });
          continue;
        }
      }

      applied.push({
        fingerprint,
        nickname: cleaned,
        source: 'haiku',
        basedOnThreadId: usable.threadId,
        sampleMessageCount: sample.length,
      });
      this.log(`[nickname-suggester] ${fingerprint.slice(0, 8)} → ${cleaned}${opts?.dryRun ? ' (dry-run)' : ''}`);
    }

    return {
      scannedThreads: threads.length,
      candidateAgents: candidatesByAgent.size,
      applied,
      skipped,
      durationMs: Date.now() - startedAt,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildPrompt(transcript: string): string {
  return [
    'Pick a SHORT display name (1-2 words, max 20 chars) for the "them" agent in the conversation below.',
    '',
    'Priority order — use the FIRST that applies:',
    '  1. If "us" addresses "them" by a proper name (e.g., "Hey Dawn", "Dawn —") OR "them" signs off with a name, use that exact name.',
    '  2. If "them" introduces themselves ("This is X", "I am X"), use that name.',
    '  3. Otherwise pick a 1-2 word descriptor of "them"\'s role or project (e.g., "Sage", "PR Bot", "ResearchBot").',
    '',
    'Use proper-case. No quotes, no punctuation, no explanation. If you truly cannot tell, return: Unnamed',
    '',
    'Conversation excerpt:',
    transcript,
    '',
    'Display name:',
  ].join('\n');
}

function sanitizeNickname(raw: string): string {
  if (!raw) return '';
  let s = String(raw).trim();
  // Strip leading "Nickname:" / "Name:" / "Display name:" prefixes the model may add
  s = s.replace(/^\s*(?:nickname|name|display name|answer)\s*[:\-—]\s*/i, '').trim();
  // Take only the first line
  s = s.split(/\r?\n/)[0]!.trim();
  // Strip surrounding quotes / backticks
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  // Drop trailing punctuation
  s = s.replace(/[.,!?;:]+$/g, '').trim();
  if (!s) return '';
  if (/^unnamed$/i.test(s)) return '';
  if (s.length > NICKNAME_MAX_CHARS) s = s.slice(0, NICKNAME_MAX_CHARS).trim();
  // Reject obvious non-names (only digits, only punctuation, etc.)
  if (!/[A-Za-z]/.test(s)) return '';
  return s;
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function extractText(text: unknown): string {
  if (typeof text === 'string') return text;
  if (text && typeof text === 'object') {
    try { return JSON.stringify(text); } catch { return String(text); }
  }
  return String(text ?? '');
}
