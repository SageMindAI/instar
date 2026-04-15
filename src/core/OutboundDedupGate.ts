/**
 * OutboundDedupGate — catches agent messages that near-duplicate a recent
 * outbound message in the same conversation.
 *
 * Problem it solves: when session lifecycle events cause two independent
 * attempts to answer the same user question (e.g., context-exhaustion
 * respawn racing with an in-flight reply), the user sees the same answer
 * twice. This gate is the structural safety net that catches duplication
 * from ANY cause, not just a specific bug.
 *
 * Algorithm: Jaccard similarity over word 3-grams between the candidate
 * message and each recent agent message in the same conversation. If any
 * pair exceeds the configured threshold, the gate reports a duplicate.
 *
 * Deterministic, no LLM call, ~sub-millisecond. Sized to run on every
 * outbound message without user-visible latency.
 */

export interface RecentOutboundMessage {
  text: string;
  /** Unix ms — used to filter to a recent time window. */
  timestamp: number;
}

export interface DedupCheckInput {
  /** The candidate message text being sent. */
  text: string;
  /** Recent outbound agent messages in the same conversation. */
  recent: RecentOutboundMessage[];
}

export interface DedupCheckResult {
  /** True if the candidate is a near-duplicate of a recent message. */
  duplicate: boolean;
  /** The similar recent message text (truncated to 200 chars for logging). */
  matchedText?: string;
  /** The Jaccard similarity score that triggered the match [0, 1]. */
  similarity?: number;
}

export interface OutboundDedupGateConfig {
  /** Jaccard similarity threshold for declaring a duplicate. Default 0.7. */
  threshold?: number;
  /** Time window for recent messages to consider, in ms. Default 5 minutes. */
  windowMs?: number;
  /**
   * Minimum length for the candidate text to be considered at all. Very
   * short messages ("ok", "on it") naturally duplicate across turns and
   * shouldn't be blocked. Default 40 characters.
   */
  minLength?: number;
}

export class OutboundDedupGate {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly minLength: number;

  constructor(config: OutboundDedupGateConfig = {}) {
    this.threshold = config.threshold ?? 0.7;
    this.windowMs = config.windowMs ?? 5 * 60 * 1000;
    this.minLength = config.minLength ?? 40;
  }

  check(input: DedupCheckInput): DedupCheckResult {
    const candidate = input.text.trim();
    if (candidate.length < this.minLength) {
      return { duplicate: false };
    }

    const cutoff = Date.now() - this.windowMs;
    const candidateGrams = wordNgrams(candidate, 3);
    if (candidateGrams.size === 0) {
      return { duplicate: false };
    }

    let best: { similarity: number; text: string } | null = null;
    for (const msg of input.recent) {
      if (msg.timestamp < cutoff) continue;
      if (!msg.text || msg.text.trim().length < this.minLength) continue;
      const priorGrams = wordNgrams(msg.text, 3);
      if (priorGrams.size === 0) continue;
      const sim = jaccard(candidateGrams, priorGrams);
      if (!best || sim > best.similarity) {
        best = { similarity: sim, text: msg.text };
      }
    }

    if (best && best.similarity >= this.threshold) {
      return {
        duplicate: true,
        matchedText: best.text.slice(0, 200),
        similarity: best.similarity,
      };
    }
    return { duplicate: false, similarity: best?.similarity };
  }
}

function wordNgrams(text: string, n: number): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  if (normalized.length < n) {
    // Short text — use single tokens as "grams" so two short similar messages
    // can still match. Without this, a 2-word message produces zero 3-grams.
    for (const w of normalized) out.add(w);
    return out;
  }
  for (let i = 0; i <= normalized.length - n; i++) {
    out.add(normalized.slice(i, i + n).join(' '));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
