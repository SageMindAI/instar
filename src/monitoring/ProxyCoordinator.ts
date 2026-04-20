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
  /**
   * Last /build heartbeat timestamp per topic. Per BUILD-STALL-VISIBILITY-SPEC
   * Fix 2 "Routing": when a build-progress event is fresh (within the suppression
   * window), PresenceProxy suppresses its generic Tier 2/3 standby so the user
   * hears one progress voice per channel, not two.
   *
   * Tracked separately from `held` because heartbeats are stateless pings —
   * we don't want them to permanently hold the per-topic mutex (that would
   * block presence-proxy forever) but we DO want presence-proxy to know a
   * heartbeat arrived recently.
   */
  private lastBuildHeartbeatAt: Map<number, number> = new Map();

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

  /**
   * Record that a /build heartbeat just went out for this topic. Call from the
   * POST /build/heartbeat handler after a successful dispatch. PresenceProxy
   * reads via `hasRecentBuildHeartbeat` to decide whether to suppress its
   * own tier message.
   */
  recordBuildHeartbeat(topicId: number, atMs: number = Date.now()): void {
    this.lastBuildHeartbeatAt.set(topicId, atMs);
  }

  /**
   * Returns true if a build heartbeat has landed for this topic within
   * `windowMs` of now. PresenceProxy calls this before sending Tier 2/3;
   * if true, it stays silent for this cycle.
   *
   * Default window of 6 min exceeds the 5-min heartbeat cadence so a single
   * missed/delayed heartbeat doesn't immediately unsuppress standby.
   */
  hasRecentBuildHeartbeat(topicId: number, windowMs: number = 6 * 60_000): boolean {
    const last = this.lastBuildHeartbeatAt.get(topicId);
    if (last === undefined) return false;
    return Date.now() - last < windowMs;
  }

  /**
   * Clear the heartbeat marker (e.g. on /build complete) so subsequent standby
   * isn't suppressed by a stale timestamp.
   */
  clearBuildHeartbeat(topicId: number): void {
    this.lastBuildHeartbeatAt.delete(topicId);
  }
}
