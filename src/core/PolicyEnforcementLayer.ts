/**
 * Policy Enforcement Layer (PEL) — Deterministic hard policy checks for
 * the response review pipeline.
 *
 * Runs BEFORE any LLM-based review. Cannot be overridden. All rules are
 * regex-based and complete in <5ms. Even in observeOnly mode, PEL violations
 * are enforced — they represent non-negotiable safety boundaries.
 *
 * Checks for:
 * - Credential / API key leakage
 * - PII patterns (email, phone, SSN)
 * - Agent auth token leakage
 * - Internal URL exposure on external channels
 * - File path exposure on external channels
 * - Environment variable patterns
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export interface PELResult {
  pass: boolean;
  violations: PELViolation[];
  /** 'hard_block' = must block, 'warn' = advisory, 'pass' = clean */
  outcome: 'pass' | 'warn' | 'hard_block';
}

export interface PELViolation {
  rule: string;
  severity: 'hard_block' | 'warn';
  detail: string;
  /** Matched pattern (for debugging, not sent to agent) */
  match?: string;
}

export interface PELContext {
  channel: string;
  isExternalFacing: boolean;
  recipientType: 'primary-user' | 'secondary-user' | 'agent' | 'external-contact';
  stateDir: string;
}

// ── Rule Definitions ─────────────────────────────────────────────────

interface PELRule {
  name: string;
  severity: 'hard_block' | 'warn';
  /** If true, rule only fires when channel is external-facing */
  externalOnly: boolean;
  test: (message: string, context: PELContext, authToken: string | null) => PELViolation | null;
}

// ── Credential Patterns ──────────────────────────────────────────────

/** Regex patterns for common API key / credential formats */
const CREDENTIAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub personal access token', pattern: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub OAuth token', pattern: /\bgho_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub user-to-server token', pattern: /\bghu_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub server-to-server token', pattern: /\bghs_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub refresh token', pattern: /\bghr_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack bot token', pattern: /\bxoxb-[0-9]{10,}-[A-Za-z0-9-]+\b/ },
  { name: 'Slack user token', pattern: /\bxoxp-[0-9]{10,}-[A-Za-z0-9-]+\b/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Stripe secret key', pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/ },
  { name: 'Stripe test key', pattern: /\bsk_test_[A-Za-z0-9]{24,}\b/ },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Generic bearer token', pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/ },
  { name: 'Password assignment', pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{8,}/i },
  { name: 'Private key block', pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/ },
];

// ── PII Patterns ─────────────────────────────────────────────────────

const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'Email address', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i },
  { name: 'US phone number', pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  { name: 'SSN pattern', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
];

// ── Internal URL Patterns ────────────────────────────────────────────

const INTERNAL_URL_PATTERN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s)]*/i;

// ── File Path Patterns ───────────────────────────────────────────────

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /\/?\.instar\/[^\s)"]*/,
  /\/?\.claude\/[^\s)"]*/,
  /\/Users\/[^\s)"]*/,
  /\/home\/[^\s)"]*/,
];

// ── Environment Variable Patterns ────────────────────────────────────

const ENV_VAR_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: '$AUTH variable', pattern: /\$AUTH\b/ },
  { name: '$API_KEY variable', pattern: /\$API_KEY\b/ },
  { name: '$SECRET variable', pattern: /\$(?:SECRET|TOKEN|PASSWORD)\b/i },
  { name: 'process.env reference', pattern: /process\.env\.[A-Z_]{2,}/ },
];

// ── Implementation ───────────────────────────────────────────────────

export class PolicyEnforcementLayer {
  private stateDir: string;
  private cachedAuthToken: string | null = null;
  private configWatcher: fs.FSWatcher | null = null;
  private configPath: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.configPath = path.join(stateDir, 'config.json');
    this.loadAuthToken();
    this.watchConfig();
  }

  /**
   * Enforce all policy rules against a message. Returns within 5ms.
   * No I/O during enforcement — all state is pre-cached.
   */
  enforce(message: string, context: PELContext): PELResult {
    const violations: PELViolation[] = [];

    for (const rule of this.rules) {
      if (rule.externalOnly && !context.isExternalFacing) {
        continue;
      }
      const violation = rule.test(message, context, this.cachedAuthToken);
      if (violation) {
        violations.push(violation);
      }
    }

    const hasHardBlock = violations.some(v => v.severity === 'hard_block');
    const hasWarn = violations.some(v => v.severity === 'warn');

    return {
      pass: violations.length === 0,
      violations,
      outcome: hasHardBlock ? 'hard_block' : hasWarn ? 'warn' : 'pass',
    };
  }

  /**
   * Clean up resources (file watcher).
   */
  destroy(): void {
    if (this.configWatcher) {
      this.configWatcher.close();
      this.configWatcher = null;
    }
  }

  /**
   * Get the cached auth token (for testing).
   */
  getAuthToken(): string | null {
    return this.cachedAuthToken;
  }

  // ── Private ──────────────────────────────────────────────────────

  private loadAuthToken(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        this.cachedAuthToken = config.authToken || null;
      }
    } catch {
      this.cachedAuthToken = null;
    }
  }

  private watchConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        this.configWatcher = fs.watch(this.configPath, () => {
          this.loadAuthToken();
        });
        // Don't let the watcher keep the process alive
        this.configWatcher.unref();
      }
    } catch {
      // Silently ignore watch failures — token will be stale but enforcement still works
    }
  }

  /**
   * All rules as a flat array. Each rule is a pure function that tests
   * a message and returns a violation or null.
   */
  private rules: PELRule[] = [
    // ── Credential Patterns ──────────────────────────────────────
    ...CREDENTIAL_PATTERNS.map(({ name, pattern }): PELRule => ({
      name: 'credential-leak',
      severity: 'hard_block',
      externalOnly: false,
      test: (message) => {
        const match = message.match(pattern);
        if (match) {
          return {
            rule: 'credential-leak',
            severity: 'hard_block',
            detail: `Detected ${name} pattern in message`,
            match: match[0],
          };
        }
        return null;
      },
    })),

    // ── PII Detection ────────────────────────────────────────────
    ...PII_PATTERNS.map(({ name, pattern }): PELRule => ({
      name: 'pii-detection',
      severity: 'hard_block',
      externalOnly: true,
      test: (message) => {
        const match = message.match(pattern);
        if (match) {
          return {
            rule: 'pii-detection',
            severity: 'hard_block',
            detail: `Detected ${name} pattern in external-facing message`,
            match: match[0],
          };
        }
        return null;
      },
    })),

    // ── Auth Token Leakage ───────────────────────────────────────
    {
      name: 'auth-token-leak',
      severity: 'hard_block',
      externalOnly: false,
      test: (message, _context, authToken) => {
        if (authToken && authToken.length >= 8 && message.includes(authToken)) {
          return {
            rule: 'auth-token-leak',
            severity: 'hard_block',
            detail: 'Message contains the agent\'s own auth token',
            match: authToken.substring(0, 4) + '...',
          };
        }
        return null;
      },
    },

    // ── Internal URL Detection ───────────────────────────────────
    {
      name: 'internal-url-leak',
      severity: 'hard_block',
      externalOnly: true,
      test: (message) => {
        const match = message.match(INTERNAL_URL_PATTERN);
        if (match) {
          return {
            rule: 'internal-url-leak',
            severity: 'hard_block',
            detail: 'Internal URL detected in external-facing message',
            match: match[0],
          };
        }
        return null;
      },
    },

    // ── File Path Detection ──────────────────────────────────────
    ...SENSITIVE_PATH_PATTERNS.map((pattern, i): PELRule => ({
      name: 'file-path-leak',
      severity: 'warn',
      externalOnly: true,
      test: (message) => {
        const match = message.match(pattern);
        if (match) {
          return {
            rule: 'file-path-leak',
            severity: 'warn',
            detail: 'Sensitive file path detected in external-facing message',
            match: match[0],
          };
        }
        return null;
      },
    })),

    // ── Environment Variable Patterns ────────────────────────────
    ...ENV_VAR_PATTERNS.map(({ name, pattern }): PELRule => ({
      name: 'env-var-leak',
      severity: 'warn',
      externalOnly: false,
      test: (message) => {
        const match = message.match(pattern);
        if (match) {
          return {
            rule: 'env-var-leak',
            severity: 'warn',
            detail: `Environment variable reference detected: ${name}`,
            match: match[0],
          };
        }
        return null;
      },
    })),
  ];
}
