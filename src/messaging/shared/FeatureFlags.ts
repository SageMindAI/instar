/**
 * Feature flags for incremental shared infrastructure extraction.
 *
 * Each flag enables one shared module, allowing per-module rollback
 * without reverting the entire extraction. Flags are removed once
 * all tests pass for 2 weeks post-extraction.
 *
 * Phase 1a: CommandRouter
 * Phase 1b: MessageLogger
 * Phase 1c: StallDetector
 * Phase 1d: AuthGate
 * Phase 1e: EventEmitter pattern
 */
export const SHARED_INFRA_FLAGS = {
  useSharedCommandRouter: false,    // Phase 1a
  useSharedMessageLogger: false,    // Phase 1b
  useSharedStallDetector: false,    // Phase 1c
  useSharedAuthGate: false,         // Phase 1d
  useEventEmitterPattern: false,    // Phase 1e
};
