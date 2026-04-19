/**
 * ProxyCoordinator — Per-topic mutex shared between PresenceProxy and
 * PromiseBeacon.
 *
 * Per PROMISE-BEACON-SPEC.md §"PresenceProxy coexistence (A10 fix)": only
 * one proxy-class emitter should fire per topic at a time. PresenceProxy
 * (reactive to user silence) and PromiseBeacon (reactive to agent
 * silence) can coincide; without coordination they'd double-post ⏳ + 🔭
 * within a second.
 *
 * In-memory only (spec §"ProxyCoordinator liveness" — P16). Dies with the
 * process. No persistence, no distributed lock.
 */
export type ProxyHolder = 'presence-proxy' | 'promise-beacon';

export class ProxyCoordinator {
  private held: Map<number, { holder: ProxyHolder; acquiredAt: number }> = new Map();

  /** Try to acquire. Returns true on success. */
  tryAcquire(topicId: number, holder: ProxyHolder): boolean {
    const current = this.held.get(topicId);
    if (current && current.holder !== holder) {
      return false;
    }
    this.held.set(topicId, { holder, acquiredAt: Date.now() });
    return true;
  }

  /** Release. No-op if not held by this holder. */
  release(topicId: number, holder: ProxyHolder): void {
    const current = this.held.get(topicId);
    if (current && current.holder === holder) {
      this.held.delete(topicId);
    }
  }

  /** Returns holder name or null. */
  currentHolder(topicId: number): ProxyHolder | null {
    return this.held.get(topicId)?.holder ?? null;
  }

  /** Diagnostics. */
  allHeld(): Array<{ topicId: number; holder: ProxyHolder; ageMs: number }> {
    const now = Date.now();
    return [...this.held.entries()].map(([topicId, v]) => ({
      topicId,
      holder: v.holder,
      ageMs: now - v.acquiredAt,
    }));
  }
}
