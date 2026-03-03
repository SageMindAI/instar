/**
 * OutputPrivacyRouter — evaluates response sensitivity and routes to DM or shared topic.
 *
 * Implements Gap 10 from the User-Agent Topology Spec:
 *   "In a public topic, a sensitive reply is visible to all group members.
 *    The agent has no mechanism to route sensitive responses to DM instead
 *    of the shared topic."
 *
 * Routing rules:
 *   1. If response contains user-specific sensitive content → route to DM
 *   2. If sensitivity assessment is uncertain → default to DM (fail-closed)
 *   3. If response is clearly non-sensitive → allow shared topic
 *
 * Sensitivity signals (heuristic-based, no LLM needed):
 *   - Contains patterns matching credentials, keys, tokens, passwords
 *   - Contains personal data (emails, phone numbers, SSNs)
 *   - Response was generated from private-scoped memory
 *   - Explicit privacy markers from the chat planner
 *
 * Design:
 *   - Fail-closed: uncertain → DM
 *   - No false-negative tolerance: better to over-route to DM than expose sensitive data
 *   - Deterministic: same input always produces same routing decision
 *   - Fast: heuristic-only, no async operations
 */

import type { PrivacyScopeType } from '../core/types.js';

// ── Sensitivity Patterns ─────────────────────────────────────────

/**
 * Patterns that indicate the response contains sensitive content.
 * Each pattern has a name (for audit logging) and a regex.
 */
const SENSITIVE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // Credentials and secrets
  { name: 'api-key', pattern: /\b(sk-|pk-|api[_-]?key|api[_-]?token|api[_-]?secret)\s*[:=]\s*\S+/i },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { name: 'password', pattern: /\b(password|passwd|pwd)\s*[:=]\s*\S+/i },
  { name: 'secret-key', pattern: /\b(secret[_-]?key|private[_-]?key|encryption[_-]?key)\s*[:=]\s*\S+/i },
  { name: 'token-pattern', pattern: /\b[A-Za-z0-9]{32,}[._-][A-Za-z0-9]{16,}/i }, // Generic token patterns
  { name: 'ssh-key', pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i },
  { name: 'connection-string', pattern: /\b(postgres|mysql|mongodb|redis):\/\/\S+:\S+@/i },

  // Personal data (PII)
  { name: 'email-address', pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/ },
  { name: 'phone-number', pattern: /\b(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'credit-card', pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/ },

  // Financial data
  { name: 'bank-account', pattern: /\b(account\s*#?|routing\s*#?|iban)\s*[:=]?\s*\d{6,}\b/i },
  { name: 'pin-code', pattern: /\b(pin|PIN)\s*[:=]\s*\d{4,6}\b/ },
];

/**
 * Words that strongly indicate personal/private context even without pattern matches.
 */
const SENSITIVE_KEYWORDS = [
  'your password',
  'your api key',
  'your token',
  'your secret',
  'your credentials',
  'your private',
  'your bank',
  'your account number',
  'your ssn',
  'your social security',
  'don\'t share this',
  'keep this private',
  'confidential',
];

// ── Types ────────────────────────────────────────────────────────

export type RoutingDecision = 'dm' | 'shared';

export interface RoutingResult {
  /** Where to send the response */
  route: RoutingDecision;
  /** Why this routing was chosen */
  reason: string;
  /** Specific patterns that triggered DM routing (for audit) */
  triggers: string[];
  /** Overall confidence in the routing decision (0-1) */
  confidence: number;
}

export interface RoutingContext {
  /** The response text to evaluate */
  responseText: string;
  /** Whether the response was generated using private-scoped memory */
  usedPrivateMemory?: boolean;
  /** The privacy scope of the source data, if known */
  sourceScopes?: PrivacyScopeType[];
  /** Whether the planner explicitly marked this as sensitive */
  explicitlySensitive?: boolean;
  /** Whether the response is going to a shared topic (vs already a DM) */
  isSharedTopic?: boolean;
}

// ── Router ───────────────────────────────────────────────────────

/**
 * Evaluate a response for sensitivity and determine routing.
 *
 * This is the main entry point. Returns a RoutingResult with the decision,
 * reasoning, and triggering patterns.
 */
export function evaluateResponseSensitivity(ctx: RoutingContext): RoutingResult {
  // Fast path: already a DM — no routing needed
  if (ctx.isSharedTopic === false) {
    return {
      route: 'shared', // "shared" means "send normally" — in a DM, that's the DM
      reason: 'Already in DM — no routing needed',
      triggers: [],
      confidence: 1.0,
    };
  }

  const triggers: string[] = [];

  // Check 1: Explicitly marked sensitive by planner
  if (ctx.explicitlySensitive) {
    triggers.push('explicit-sensitive-marker');
    return {
      route: 'dm',
      reason: 'Explicitly marked as sensitive by chat planner',
      triggers,
      confidence: 1.0,
    };
  }

  // Check 2: Uses private-scoped memory
  if (ctx.usedPrivateMemory) {
    triggers.push('private-memory-source');
  }

  // Check 3: Source data includes private scopes
  if (ctx.sourceScopes?.includes('private')) {
    triggers.push('private-scope-source');
  }

  // Check 4: Pattern matching on response text
  for (const { name, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(ctx.responseText)) {
      triggers.push(name);
    }
  }

  // Check 5: Keyword matching
  const lowerText = ctx.responseText.toLowerCase();
  for (const keyword of SENSITIVE_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      triggers.push(`keyword:${keyword}`);
    }
  }

  // ── Decision logic ──────────────────────────────────────────

  if (triggers.length === 0) {
    return {
      route: 'shared',
      reason: 'No sensitive content detected',
      triggers: [],
      confidence: 0.8, // Moderate confidence — could miss novel patterns
    };
  }

  // Calculate confidence based on trigger count and types
  const hasPatternMatch = triggers.some(t => !t.startsWith('keyword:') && t !== 'private-memory-source' && t !== 'private-scope-source');
  const hasMemorySignal = triggers.includes('private-memory-source') || triggers.includes('private-scope-source');

  let confidence = 0.7; // Base confidence for any trigger
  if (hasPatternMatch) confidence += 0.2;
  if (hasMemorySignal) confidence += 0.1;
  confidence = Math.min(confidence, 1.0);

  const reason = triggers.length === 1
    ? `Sensitive content detected: ${triggers[0]}`
    : `${triggers.length} sensitivity signals detected: ${triggers.slice(0, 3).join(', ')}${triggers.length > 3 ? '...' : ''}`;

  return {
    route: 'dm',
    reason,
    triggers,
    confidence,
  };
}

/**
 * Quick check: does a response need DM routing?
 * Convenience wrapper for the full evaluateResponseSensitivity.
 */
export function shouldRouteToDm(responseText: string, opts?: {
  usedPrivateMemory?: boolean;
  isSharedTopic?: boolean;
}): boolean {
  const result = evaluateResponseSensitivity({
    responseText,
    usedPrivateMemory: opts?.usedPrivateMemory,
    isSharedTopic: opts?.isSharedTopic,
  });
  return result.route === 'dm';
}
