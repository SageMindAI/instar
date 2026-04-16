/**
 * LedgerParaphraseDetector — Integrated-Being v1 outbound cross-check.
 *
 * SIGNAL ONLY. This detector compares outbound-message text against recent
 * SharedStateLedger entries' `summary` field. When it finds a close paraphrase
 * of an entry whose counterparty differs from the current outbound target, it
 * emits a ToneReviewSignals.paraphrase signal.
 *
 * It NEVER blocks. The MessagingToneGate remains the single authority for the
 * block/allow decision; this detector only produces observability data. See
 * docs/signal-vs-authority.md and the spec's §Downstream cross-check.
 *
 * Scoping rules (from spec):
 *  - Excludes `provenance: subsystem-inferred` (classifier output — low-confidence)
 *  - Fires only when counterparty differs from current outbound target
 *  - Threshold similarity ≥ 0.7
 *  - Default-on via config.integratedBeing.paraphraseCheckEnabled (default true)
 *
 * Similarity metric: Jaccard over lowercased word sets. Cheap, deterministic,
 * no LLM. Good enough for a signal that's intentionally noisy → observability-only.
 */

import type { SharedStateLedger } from './SharedStateLedger.js';
import type { LedgerEntry, IntegratedBeingConfig } from './types.js';

export interface ParaphraseCheckInput {
  /** The outbound message being evaluated. */
  outboundText: string;
  /** The intended recipient counterparty (what we're about to send TO). */
  outboundCounterparty: {
    type: 'user' | 'agent' | 'self' | 'system';
    name: string;
  };
}

export interface ParaphraseSignal {
  detected: boolean;
  similarityScore?: number;
  matchedEntryId?: string;
  counterparty?: { type: string; name: string };
}

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_COMPARE_ENTRIES = 50;
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'and',
  'or', 'but', 'if', 'then', 'so', 'as', 'it', 'this', 'that', 'these',
  'those', 'i', 'you', 'he', 'she', 'we', 'they', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can', 'may',
]);

function tokenize(s: string): Set<string> {
  const tokens = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens.filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const tok of a) if (b.has(tok)) intersect += 1;
  const union = a.size + b.size - intersect;
  if (union === 0) return 0;
  return intersect / union;
}

export class LedgerParaphraseDetector {
  private readonly ledger: SharedStateLedger;
  private readonly config: IntegratedBeingConfig;

  constructor(ledger: SharedStateLedger, config: IntegratedBeingConfig) {
    this.ledger = ledger;
    this.config = config;
  }

  /**
   * Run the paraphrase check. Returns a signal object suitable for
   * MessagingToneGate's ToneReviewSignals.paraphrase.
   *
   * Fail-open: returns `{ detected: false }` on any error.
   */
  async check(input: ParaphraseCheckInput): Promise<ParaphraseSignal> {
    // Default-on; disable only when explicitly set to false.
    if (this.config.paraphraseCheckEnabled === false) {
      return { detected: false };
    }

    try {
      const entries = await this.ledger.recent({ limit: DEFAULT_COMPARE_ENTRIES });
      const outTokens = tokenize(input.outboundText);
      if (outTokens.size === 0) return { detected: false };

      let best: { score: number; entry: LedgerEntry } | null = null;
      for (const e of entries) {
        // Spec: skip classifier-inferred entries.
        if (e.provenance === 'subsystem-inferred') continue;
        // Spec: fire only on cross-counterparty paraphrase.
        if (
          e.counterparty.type === input.outboundCounterparty.type &&
          e.counterparty.name === input.outboundCounterparty.name
        ) continue;
        const textForCompare = e.summary ?? e.subject;
        const score = jaccard(outTokens, tokenize(textForCompare));
        if (!best || score > best.score) best = { score, entry: e };
      }
      if (!best || best.score < DEFAULT_THRESHOLD) {
        return { detected: false };
      }
      return {
        detected: true,
        similarityScore: best.score,
        matchedEntryId: best.entry.id,
        counterparty: {
          type: best.entry.counterparty.type,
          name: best.entry.counterparty.name,
        },
      };
    } catch {
      // Fail-open: no signal on error, never block on a detector failure.
      return { detected: false };
    }
  }
}
