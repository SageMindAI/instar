/**
 * JargonDetector — signal producer for health-alert messages that leak
 * internal jargon ("reflection-trigger job", "load-bearing infrastructure").
 *
 * SIGNAL ONLY. This detector produces evidence; it does not block. The
 * MessagingToneGate is the single authority that combines this signal with
 * conversation context and decides. See docs/signal-vs-authority.md.
 *
 * The bar for "jargon" is words that an end user with no instar background
 * would not be able to act on. The detector is intentionally brittle —
 * literal token matching against a fixed list. Brittleness is fine for a
 * detector; it would only be a problem for an authority.
 */
export interface JargonSignal {
  detected: boolean;
  /** The jargon terms found in the candidate text (lowercased). */
  terms: string[];
  /** Count of jargon hits, used by the authority as a confidence cue. */
  score: number;
}

const JARGON_TERMS: readonly string[] = [
  'job',
  'jobs',
  'log',
  'logs',
  'process',
  'processes',
  'abi',
  'module',
  'modules',
  'binary',
  'binaries',
  'stderr',
  'stdout',
  'exit code',
  'cron',
  'pid',
  'load-bearing',
  'load bearing',
  'infrastructure',
  'trigger',
  'triggers',
  'registry',
  'manifest',
  'subprocess',
  'daemon',
  'launchd',
  'systemd',
];

/**
 * Detect jargon hits in a candidate outbound message.
 *
 * Word-boundary matching prevents false positives like "registry" inside
 * "registrytrend" (a hypothetical product name) or "job" inside "objective".
 */
export function detectJargon(text: string): JargonSignal {
  if (!text) {
    return { detected: false, terms: [], score: 0 };
  }
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const term of JARGON_TERMS) {
    // Build a regex that requires non-word chars (or string boundaries) on
    // either side. For multi-word terms ("load-bearing"), the hyphen is
    // already word-internal so the boundary check is on the outside only.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
    if (pattern.test(lower)) {
      found.add(term);
    }
  }
  const terms = Array.from(found).sort();
  return {
    detected: terms.length > 0,
    terms,
    score: terms.length,
  };
}
