/**
 * registerLedgerEmitters — single wiring point for the Integrated-Being ledger.
 *
 * Revert is a one-line deletion of the call in commands/server.ts, by design
 * (see docs/specs/integrated-being-ledger-v1.md §"Rollback plan").
 *
 * This function installs ledger-event callbacks on each subsystem. Subsystems
 * themselves hold no reference to the ledger. All emitters fail-open —
 * `ledger.append()` returns null on error, and we swallow exceptions.
 */

import type { SharedStateLedger } from './SharedStateLedger.js';
import type { ThreadlineRouter } from '../threadline/ThreadlineRouter.js';
import type { DispatchExecutor } from './DispatchExecutor.js';
import type { CoherenceGate } from './CoherenceGate.js';
import type { IntegratedBeingConfig, LedgerEntrySubsystem } from './types.js';

export interface LedgerEmitterDeps {
  threadlineRouter?: ThreadlineRouter | null;
  dispatchExecutor?: DispatchExecutor | null;
  coherenceGate?: CoherenceGate | null;
  /** Full config block — gates classifier emitter. */
  config: IntegratedBeingConfig;
  /** Machine/agent identity instance token (bounded charset). Fallback: 'server'. */
  instance?: string;
}

/**
 * Map threadline trust level (or a trust-lookup function) to ledger trustTier.
 * Default-deny on anything uncertain → untrusted.
 */
function trustTierFromName(
  _name: string,
  trustLookup?: (name: string) => 'autonomous' | 'collaborative' | 'supervised' | 'cautious' | 'unknown',
): 'trusted' | 'untrusted' {
  if (!trustLookup) return 'untrusted';
  try {
    const level = trustLookup(_name);
    if (level === 'autonomous' || level === 'collaborative') return 'trusted';
    return 'untrusted';
  } catch {
    return 'untrusted';
  }
}

/** Sanitize a raw name to the ledger's charset [a-zA-Z0-9-_.:] (max 64 chars). */
function sanitizeName(raw: string): string {
  const cleaned = (raw || 'unknown').replace(/[^a-zA-Z0-9\-_.:]/g, '-').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

export function registerLedgerEmitters(
  ledger: SharedStateLedger,
  deps: LedgerEmitterDeps,
): void {
  const instance = sanitizeName(deps.instance ?? 'server');
  const cfg = deps.config;

  // ── Threadline lifecycle ─────────────────────────────────────────
  if (deps.threadlineRouter) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tr = deps.threadlineRouter as any;
    // ThreadlineRouter now accepts onLedgerEvent in its constructor, but the
    // existing instance may have been built before we could pass one. We also
    // expose a setter for retrofit — if the field is writable, assign.
    const sink = (evt: import('../threadline/ThreadlineRouter.js').ThreadlineLedgerEvent) => {
      // Name sanitization + trust-tier snapshot at append time (default-deny).
      // v1 does not yet wire a live trust-lookup into the emitter; we treat
      // agent counterparties as untrusted unless the spec's trust-tier
      // mapping is extended in a future pass. The renderer hashes the name.
      const rawName = sanitizeName(evt.remoteAgent);
      const trustTier: 'trusted' | 'untrusted' = trustTierFromName(rawName);
      return ledger.append({
        emittedBy: { subsystem: 'threadline' as LedgerEntrySubsystem, instance },
        kind: evt.kind,
        subject: (evt.subject || evt.kind).slice(0, 200),
        counterparty: { type: 'agent', name: rawName, trustTier },
        provenance: 'subsystem-asserted',
        dedupKey: `threadline:${evt.kind}:${evt.threadId}`,
      });
    };
    // Prefer constructor-installed sink; fall back to writable private field.
    if (tr.onLedgerEvent == null) {
      try { tr.onLedgerEvent = sink; } catch { /* readonly — router was built w/o sink */ }
    }
  }

  // ── Dispatch ─────────────────────────────────────────────────────
  if (deps.dispatchExecutor) {
    deps.dispatchExecutor.setLedgerEventSink((evt) => {
      return ledger.append({
        emittedBy: { subsystem: 'dispatch' as LedgerEntrySubsystem, instance },
        kind: 'decision',
        subject: (evt.description || 'dispatch executed').slice(0, 200),
        summary: `${evt.completedSteps}/${evt.totalSteps} steps completed; verified=${evt.verified}`.slice(0, 400),
        counterparty: { type: 'system', name: 'dispatch-manager', trustTier: 'trusted' },
        provenance: 'subsystem-asserted',
        dedupKey: `dispatch:${evt.dispatchId ?? evt.timestamp}`,
      });
    });
  }

  // ── Coherence gate ───────────────────────────────────────────────
  if (deps.coherenceGate) {
    deps.coherenceGate.setLedgerEventSink((evt) => {
      // Rule ID ONLY. No rule context — spec §Write path §4.
      return ledger.append({
        emittedBy: { subsystem: 'coherence-gate' as LedgerEntrySubsystem, instance },
        kind: 'note',
        subject: `block:${sanitizeName(evt.ruleId)}`.slice(0, 200),
        counterparty: { type: 'system', name: 'coherence-gate', trustTier: 'trusted' },
        provenance: 'subsystem-asserted',
        dedupKey: `coherence-gate:${evt.sessionId}:${evt.ruleId}:${evt.timestamp}`,
      });
    });
  }

  // ── Outbound commitment classifier (DEFAULT-OFF) ─────────────────
  //
  // Per spec §Write path §2: only installed when config.classifierEnabled is
  // explicitly true. When not installed, there is zero hot-path cost —
  // nothing hooks into the outbound path at all. Keeps revert trivial.
  if (cfg.classifierEnabled === true) {
    // The actual hook into the outbound path lives in the MessageSentinel
    // paraphrase-detection flow (Step 11); installing the emitter here is
    // a no-op sentinel. When the outbound-classifier subsystem lands its
    // prefilter+haiku pipeline, it will call this helper directly:
    //
    //   void ledger.append({
    //     emittedBy: { subsystem: 'outbound-classifier', instance },
    //     kind: 'commitment',
    //     provenance: 'subsystem-inferred',
    //     source: 'heuristic-classifier',
    //     ...
    //   })
    //
    // We expose this on the ledger itself so the classifier can reach it
    // without the emitters module becoming a runtime dependency.
    //
    // (Intentionally a comment-only stub — v1 ships with the classifier
    // default-off per security-S1 resolution in the spec.)
  }
}
