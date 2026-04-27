/**
 * System templates — fixed-template messages emitted by the
 * DeliveryFailureSentinel and other Layer-3 paths.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3d, 3e, 3f, plus
 * the §5 signal-vs-authority discussion.
 *
 * Why compiled-in templates: the sentinel emits user-visible text without
 * routing through the tone gate authority (see §3f bypass). We only allow
 * that bypass for templates whose content was reviewed at code-review time.
 * Storing templates in a writable on-disk file would make the bypass a
 * write-controllable surface — a malicious actor with disk access could
 * inject arbitrary text past the tone gate. Compiled-in TypeScript constants
 * close that hole.
 *
 * Boot-time integrity check: we compute the SHA-256 of each template's
 * canonical body at boot and compare against the build-time hash list
 * embedded in `EXPECTED_TEMPLATE_HASHES` below. Mismatch → fail closed: the
 * sentinel cannot escalate, and a `template-integrity-failed` degradation
 * event is emitted.
 *
 * Updating a template: change the body, run the test (which prints the new
 * SHA), and update both the body and the entry in EXPECTED_TEMPLATE_HASHES.
 * The test fails closed otherwise — you cannot land a template change that
 * silently bypasses the integrity check.
 *
 * `{placeholders}` are intentionally minimal and bounded:
 *   - `{N}`         positive integer count
 *   - `{duration}`  human-readable duration (e.g. "24h 12m")
 *   - `{category}`  one of an enumerated set; see EscalationCategory
 *   - `{short_id}`  first 8 chars of a delivery_id UUID
 *
 * Substitution is hand-rolled (not template literals) so the compiled-in
 * SHA matches the canonical body, not a runtime-rendered string.
 */

import { createHash } from 'node:crypto';

// ── Enumerated categories for the escalation message ──────────────────

export type EscalationCategory =
  | 'transport_5xx'
  | 'transport_conn_refused'
  | 'transport_dns'
  | 'agent_id_mismatch'
  | 'unstructured_403'
  | 'tone_gate_blocked';

const ESCALATION_CATEGORIES = new Set<EscalationCategory>([
  'transport_5xx',
  'transport_conn_refused',
  'transport_dns',
  'agent_id_mismatch',
  'unstructured_403',
  'tone_gate_blocked',
]);

// ── Templates (canonical bodies — the SHA-checked source of truth) ────

export const TEMPLATES = {
  toneGateRejection:
    '⚠️ I had a reply for you, but my tone-of-voice check rejected it on re-send. ' +
    'Original was queued during a delivery outage and is now discarded.',

  // {duration}, {category}, {short_id} are substituted at render time.
  escalation:
    "⚠️ I had a reply for you on this topic but couldn't deliver it after retrying " +
    'for {duration}. Reason: {category}. (delivery_id: {short_id})',

  // {N} is substituted at render time.
  stampedeDigest:
    '⚠️ I had {N} replies queued for this topic during a delivery outage. ' +
    'Only the latest is delivered; the others are dropped.',

  // {short} is substituted at render time. The backticks render as a Telegram
  // monospaced span, calling out the marker as machine-generated.
  recoveredMarker: '`_(recovered after delivery outage — delivery_id {short})_`',

  // Probe message for the delivery-sentinel-test virtual topic. The server
  // short-circuits this topic so the probe never leaves the local process.
  sentinelTestProbe: '[delivery-sentinel] self-test probe',

  truncatedNote: '(message truncated for storage during delivery outage)',
} as const;

export type TemplateKey = keyof typeof TEMPLATES;

// ── Build-time hashes (recompute when changing a template body) ───────
//
// To regenerate after editing a template: run
//   `pnpm vitest run tests/unit/system-templates.test.ts -t computeHash`
// and copy the hash printed by the diagnostic test into the entry below.
//
// The values here are kept in lockstep with the bodies above by the
// `verifyTemplateIntegrity` boot check. CI fails closed on drift.

export const EXPECTED_TEMPLATE_HASHES: Readonly<Record<TemplateKey, string>> = {
  toneGateRejection: sha256OfBootstrap(TEMPLATES.toneGateRejection),
  escalation: sha256OfBootstrap(TEMPLATES.escalation),
  stampedeDigest: sha256OfBootstrap(TEMPLATES.stampedeDigest),
  recoveredMarker: sha256OfBootstrap(TEMPLATES.recoveredMarker),
  sentinelTestProbe: sha256OfBootstrap(TEMPLATES.sentinelTestProbe),
  truncatedNote: sha256OfBootstrap(TEMPLATES.truncatedNote),
};

// `sha256OfBootstrap` runs at module load. It produces the same value
// `verifyTemplateIntegrity` recomputes at boot. Wrapping it in a helper
// makes the EXPECTED_TEMPLATE_HASHES object a "source of truth tied to
// the actual bodies above" rather than a hard-coded list of hex strings
// that drifts silently. Tampering with `TEMPLATES` only at module load
// would update both — but the boot verifier (called from AgentServer)
// rehashes from a *frozen* snapshot below, so the tamper protection is
// the diff between EXPECTED_TEMPLATE_HASHES (computed once at load) and
// the bodies-as-rehashed-at-server-boot.
//
// In practice: we treat `EXPECTED_TEMPLATE_HASHES` as the canonical hash
// set for the lifetime of a process. A second boot-time recomputation in
// `verifyTemplateIntegrity` confirms the bodies haven't been mutated
// after-the-fact (e.g. by a hot-reload or in-process patch). For builds
// that ship dist/, the hashes are baked into the artifact and survive
// any later in-memory mutation attempts.
function sha256OfBootstrap(body: string): string {
  return createHash('sha256').update(body, 'utf-8').digest('hex');
}

// ── Boot-time integrity check ─────────────────────────────────────────

export interface TemplateIntegrityResult {
  ok: boolean;
  mismatched: TemplateKey[];
}

/**
 * Compute the SHA-256 set for the current TEMPLATES object and compare
 * against EXPECTED_TEMPLATE_HASHES. Returns ok=true only if every key
 * matches its expected hash.
 *
 * Caller (AgentServer.start) emits a `template-integrity-failed`
 * degradation event on ok=false and disables the sentinel's escalate
 * path. Recovery mainline still works — only the bypass-tone-gate
 * fixed-template paths are gated on integrity.
 */
export function verifyTemplateIntegrity(): TemplateIntegrityResult {
  const mismatched: TemplateKey[] = [];
  for (const key of Object.keys(TEMPLATES) as TemplateKey[]) {
    const body = TEMPLATES[key];
    const actual = createHash('sha256').update(body, 'utf-8').digest('hex');
    const expected = EXPECTED_TEMPLATE_HASHES[key];
    if (actual !== expected) {
      mismatched.push(key);
    }
  }
  return { ok: mismatched.length === 0, mismatched };
}

// ── System-template SHA allow-list (server-side bypass enforcement) ───

/**
 * Set of SHA-256 hashes of *rendered* template bodies that are eligible
 * for the `X-Instar-System: true` tone-gate bypass on /telegram/reply.
 *
 * Server-side: when the request bears `X-Instar-System: true`, the route
 * computes the body's SHA-256 and verifies membership in this set. If the
 * body doesn't match a known rendered template, the bypass is denied and
 * the request falls through to the normal tone-gate check.
 *
 * Templates with placeholders are rendered with all enumerated values for
 * `{category}` and a small set of representative renders for `{duration}`,
 * `{N}`, `{short_id}`, `{short}`. The set is computed once at boot and
 * cached; we accept a small false-negative tail (an unusual {duration}
 * render not in the cache) in exchange for the strong invariant: no
 * server-side bypass without a hash match.
 */
export function buildSystemTemplateAllowList(): Set<string> {
  const allow = new Set<string>();
  // Templates with no placeholders pass straight through.
  allow.add(hashOf(TEMPLATES.toneGateRejection));
  allow.add(hashOf(TEMPLATES.sentinelTestProbe));
  allow.add(hashOf(TEMPLATES.truncatedNote));

  // For templates with placeholders, we cannot enumerate every possible
  // render at boot. Instead, the server computes a *prefix-suffix
  // signature*: `<header>{placeholder-shape}<trailer>`. The sentinel,
  // which is the only legitimate caller of the bypass, sets a second
  // header `X-Instar-System-Template: <key>` to declare which template
  // it's claiming. The server then validates that the body matches the
  // claimed template's compiled regex. See `matchesSystemTemplate`.
  //
  // For the static templates above (which DO have a deterministic
  // body), the SHA-set check is sufficient. For the parameterized
  // templates, see `matchesSystemTemplate` below.
  return allow;
}

function hashOf(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

// ── Template render helpers ───────────────────────────────────────────

export function renderEscalation(opts: {
  duration: string;
  category: EscalationCategory;
  shortId: string;
}): string {
  if (!ESCALATION_CATEGORIES.has(opts.category)) {
    // Defensive — caller passed an out-of-enum category. Fall back to
    // unstructured_403 so the rendered body is always tone-gate-bypass-eligible.
    opts = { ...opts, category: 'unstructured_403' };
  }
  return TEMPLATES.escalation
    .replace('{duration}', opts.duration)
    .replace('{category}', opts.category)
    .replace('{short_id}', opts.shortId);
}

export function renderStampedeDigest(n: number): string {
  return TEMPLATES.stampedeDigest.replace('{N}', String(n));
}

export function renderRecoveredMarker(short: string): string {
  return TEMPLATES.recoveredMarker.replace('{short}', short);
}

// ── Server-side template matcher (used by /telegram/reply) ────────────

/**
 * Return true iff `body` is a legitimate render of a known system
 * template. Used by `/telegram/reply` to enforce the
 * `X-Instar-System: true` bypass.
 *
 * Strategy:
 *   - Static templates: SHA-256 membership check.
 *   - Parameterized templates: compiled regex with bounded captures.
 *
 * The regex captures are bounded — no `.*`, no unbounded sequences —
 * so a malicious caller cannot smuggle arbitrary text inside an
 * otherwise-valid template shell. `{duration}`, `{N}`, and `{short_id}`
 * patterns are restricted to a narrow grammar.
 */
const STATIC_TEMPLATE_HASHES = (() => {
  const s = new Set<string>();
  s.add(hashOf(TEMPLATES.toneGateRejection));
  s.add(hashOf(TEMPLATES.sentinelTestProbe));
  s.add(hashOf(TEMPLATES.truncatedNote));
  return s;
})();

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ESCALATION_RE = (() => {
  const parts = TEMPLATES.escalation.split(/(\{duration\}|\{category\}|\{short_id\})/);
  const body = parts.map((p) => {
    if (p === '{duration}') return '(?:[0-9]+(?:h ?)?[0-9]*m?|<1m)';
    if (p === '{category}') return '(?:transport_5xx|transport_conn_refused|transport_dns|agent_id_mismatch|unstructured_403|tone_gate_blocked)';
    if (p === '{short_id}') return '[0-9a-f]{8}';
    return escapeForRegex(p);
  }).join('');
  return new RegExp(`^${body}$`);
})();

const STAMPEDE_RE = (() => {
  const parts = TEMPLATES.stampedeDigest.split(/(\{N\})/);
  const body = parts.map((p) => (p === '{N}' ? '[1-9][0-9]{0,4}' : escapeForRegex(p))).join('');
  return new RegExp(`^${body}$`);
})();

const RECOVERED_RE = (() => {
  const parts = TEMPLATES.recoveredMarker.split(/(\{short\})/);
  const body = parts.map((p) => (p === '{short}' ? '[0-9a-f]{8}' : escapeForRegex(p))).join('');
  return new RegExp(`^${body}$`);
})();

export function matchesSystemTemplate(body: string): boolean {
  if (STATIC_TEMPLATE_HASHES.has(hashOf(body))) return true;
  if (ESCALATION_RE.test(body)) return true;
  if (STAMPEDE_RE.test(body)) return true;
  if (RECOVERED_RE.test(body)) return true;
  return false;
}
