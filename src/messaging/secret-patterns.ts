/**
 * Compiled-in secret-pattern redaction (spec § 3g).
 *
 * Defense-in-depth on the queued-text column of pending-relay.<agentId>.sqlite —
 * if a stray secret reached an outbound message, we don't want it durably
 * persisted on disk. The pattern list is shipped in source (NOT a writable
 * config file) so adding a new provider requires a code review, not an
 * operator config edit.
 *
 * Patterns are conservative — we'd rather under-redact than nuke a normal
 * message that happens to contain a token-shaped substring. They're not a
 * substitute for agents not putting secrets in user messages in the first
 * place; that contract is upstream of this file.
 *
 * Each pattern emits `<redacted:type>` so downstream tooling can audit
 * what was substituted (count by type, etc.).
 */

interface SecretPattern {
  type: string;
  re: RegExp;
}

// Order matters — more specific patterns first so we don't shadow them with
// the generic Bearer match. All patterns use the global flag so multiple
// occurrences are caught in a single string.
const PATTERNS: ReadonlyArray<SecretPattern> = [
  // Anthropic API keys (must come before generic sk- match)
  { type: 'anthropic-key', re: /\bsk-ant-(?:api|admin)\d{0,2}-[A-Za-z0-9_-]{40,}\b/g },
  // OpenAI sk- keys (legacy and project)
  { type: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  // AWS Access Key IDs (AKIA / ASIA prefix, 16 alnum after)
  { type: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // GitHub fine-grained PATs
  { type: 'github-pat-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  // GitHub classic PATs (ghp_, gho_, ghu_, ghs_, ghr_)
  { type: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  // Slack bot tokens (xoxb-) and user tokens (xoxp-)
  { type: 'slack-token', re: /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/g },
  // Telegraph access tokens (hex 60+ chars on a known prefix path)
  // Telegraph uses 60-char access_token but they're indistinguishable from
  // many hex strings without context, so we only catch the explicit
  // assignment pattern `access_token=` or `accessToken: "..."`.
  { type: 'telegraph-token', re: /\b(?:access_token|accessToken)["'\s:=]+([a-f0-9]{50,})\b/gi },
  // Bearer tokens — last so the more specific patterns above get first
  // dibs on the substring. Match the full `Bearer <token>` form.
  { type: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._\-+/]{16,}=*/g },
];

/**
 * Redact known-secret substrings from `text`. Each match is replaced with
 * `<redacted:<type>>`.
 *
 * Returns the redacted string. If `text` contains no matches, the returned
 * string is identical to the input (referentially, when possible).
 *
 * Performance note: regex iteration is linear in input length × pattern
 * count. The text column is capped at 32KB by Layer 2; even with 8 patterns,
 * worst-case wall time is well under a millisecond.
 */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { type, re } of PATTERNS) {
    out = out.replace(re, () => `<redacted:${type}>`);
  }
  return out;
}

/**
 * Test introspection — returns the pattern types in order. Used by unit
 * tests to assert the ordering invariant (specific before generic).
 */
export function listPatternTypes(): readonly string[] {
  return PATTERNS.map((p) => p.type);
}
