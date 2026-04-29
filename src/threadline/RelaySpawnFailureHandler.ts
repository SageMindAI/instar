/**
 * RelaySpawnFailureHandler — smart authority that decides what to do
 * when the HeartbeatWatchdog reports a spawn failure or success.
 *
 * Component B / authority side of RELAY-SPAWN-GHOST-REPLY-CONTAINMENT-SPEC.
 * Per docs/signal-vs-authority.md this is the SINGLE owner of the
 * spawn-failure decision: it consumes signals, looks up the ledger row
 * and (eventually) operator config, and routes the envelope to one of:
 *
 *  - on heartbeat-verified  → mark ledger 'verified', emit thread-opened
 *                             ledger event (the one that previously fired
 *                             too early at ThreadlineRouter:628), proceed
 *                             with normal session lifecycle.
 *  - on missing/forged/dead → mark ledger 'failed' with reason, persist
 *                             envelope to receiver inbox via the existing
 *                             inbox-only path (no auto-retry — that's an
 *                             attacker amplification vector per spec).
 *  - on stale               → same as failed; the session was alive at
 *                             one point but is no longer reporting.
 *
 * Authority justification: the decision is per-signal AND per-config AND
 * per-policy. Smart-authority placement is correct — a brittle detector
 * could not own this. Watchdog stays as a pure signal-producer.
 */

import type { SpawnLedger } from './SpawnLedger.js';
import type { HeartbeatSignal, HeartbeatSignalKind } from './HeartbeatWatchdog.js';

export type SpawnOutcomeKind = 'verified' | 'failed-quarantined' | 'noop';

export interface SpawnOutcome {
  kind: SpawnOutcomeKind;
  eventId: string;
  threadId: string;
  failureReason?: HeartbeatSignalKind;
  detail: string;
}

export interface RelaySpawnFailureHandlerDeps {
  ledger: SpawnLedger;
  /** Persist the original envelope to the recipient's inbox (existing path). */
  quarantineToInbox: (eventId: string, reason: HeartbeatSignalKind, detail: string) => void;
  /** Emit the spec's `thread-opened` ledger event AFTER successful verify. */
  emitThreadOpened: (eventId: string, threadId: string) => void;
  /** Logger; defaults to noop. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

export class RelaySpawnFailureHandler {
  constructor(private readonly deps: RelaySpawnFailureHandlerDeps) {}

  /**
   * Consume a single signal. Returns the resulting outcome for callers
   * that want to assert behavior or log it.
   */
  handle(sig: HeartbeatSignal): SpawnOutcome {
    const log = this.deps.log ?? (() => {});

    switch (sig.kind) {
      case 'heartbeat-verified': {
        const changed = this.deps.ledger.markStatus(sig.eventId, 'verified');
        if (changed) {
          this.deps.emitThreadOpened(sig.eventId, sig.threadId);
          log('info', '[spawn-guard] verified', { eventId: sig.eventId });
        }
        return {
          kind: 'verified',
          eventId: sig.eventId,
          threadId: sig.threadId,
          detail: sig.detail,
        };
      }
      case 'heartbeat-missing':
      case 'heartbeat-forged':
      case 'heartbeat-stale':
      case 'heartbeat-pid-dead': {
        const changed = this.deps.ledger.markStatus(sig.eventId, 'failed', sig.kind);
        if (changed) {
          this.deps.quarantineToInbox(sig.eventId, sig.kind, sig.detail);
          log('warn', `[spawn-guard] ${sig.kind}`, {
            eventId: sig.eventId,
            detail: sig.detail,
          });
        }
        return {
          kind: 'failed-quarantined',
          eventId: sig.eventId,
          threadId: sig.threadId,
          failureReason: sig.kind,
          detail: sig.detail,
        };
      }
    }
  }
}
