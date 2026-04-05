/**
 * DiscoveryWaterfall — Three-tier agent discovery.
 *
 * Spec Section 3.4:
 * 1. LOCAL (instant): AgentRegistry + trust-domain check
 * 2. RELAY (fast, free, timeout 5s): Threadline presence + FTS5 directory
 * 3. NETWORK (slower, $0.02-0.05, timeout 15s): MoltBridge capability match
 *
 * Stages execute sequentially. Each has a timeout budget.
 * Duplicates resolved by fingerprint with source precedence.
 */

// ── Types ────────────────────────────────────────────────────────────

export type DiscoverySource = 'local' | 'relay' | 'moltbridge';

export interface DiscoveredAgent {
  fingerprint: string;
  canonicalId?: string;
  displayName?: string;
  capabilities: string[];
  source: DiscoverySource;
  iqsBand?: string;
  lastSeen?: string;
  /** Higher = more trustworthy source */
  sourcePrecedence: number;
  /** Rich profile discovery card (Tier 1) — present when discovered via MoltBridge */
  profileCard?: {
    narrativeSummary?: string;
    profileCompletenessScore?: number;
    profileUrl?: string;
  };
}

export interface DiscoveryOptions {
  /** What to search for */
  query: string;
  /** Max results per stage */
  limit?: number;
  /** Skip specific stages */
  skipStages?: DiscoverySource[];
  /** Custom timeouts per stage (ms) */
  timeouts?: Partial<Record<DiscoverySource, number>>;
}

export interface DiscoveryResult {
  agents: DiscoveredAgent[];
  stages: {
    source: DiscoverySource;
    status: 'success' | 'skipped' | 'timeout' | 'error' | 'no-preconditions';
    agentCount: number;
    durationMs: number;
    error?: string;
  }[];
  totalDurationMs: number;
}

/** Adapter interface for each discovery source */
export interface DiscoveryAdapter {
  source: DiscoverySource;
  /** Check if preconditions are met (e.g., wallet funded for MoltBridge) */
  isAvailable(): boolean;
  /** Search for agents */
  search(query: string, limit: number, timeoutMs: number): Promise<DiscoveredAgent[]>;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_TIMEOUTS: Record<DiscoverySource, number> = {
  local: 1000,
  relay: 5000,
  moltbridge: 15000,
};

/** Source precedence: higher = more trustworthy */
const SOURCE_PRECEDENCE: Record<DiscoverySource, number> = {
  local: 3,      // local signed contact
  relay: 2,      // active relay proof
  moltbridge: 1, // MoltBridge cached metadata
};

// ── Waterfall ────────────────────────────────────────────────────────

export class DiscoveryWaterfall {
  private adapters: Map<DiscoverySource, DiscoveryAdapter> = new Map();

  /**
   * Register a discovery adapter for a stage.
   */
  registerAdapter(adapter: DiscoveryAdapter): void {
    this.adapters.set(adapter.source, adapter);
  }

  /**
   * Execute the discovery waterfall.
   *
   * Stages run sequentially: local → relay → moltbridge.
   * Results are merged with duplicate resolution by fingerprint.
   */
  async discover(options: DiscoveryOptions): Promise<DiscoveryResult> {
    const startTime = Date.now();
    const limit = options.limit ?? 10;
    const skipStages = new Set(options.skipStages ?? []);
    const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };

    const allAgents: DiscoveredAgent[] = [];
    const stages: DiscoveryResult['stages'] = [];
    const stageOrder: DiscoverySource[] = ['local', 'relay', 'moltbridge'];

    for (const source of stageOrder) {
      if (skipStages.has(source)) {
        stages.push({ source, status: 'skipped', agentCount: 0, durationMs: 0 });
        continue;
      }

      const adapter = this.adapters.get(source);
      if (!adapter) {
        stages.push({ source, status: 'skipped', agentCount: 0, durationMs: 0 });
        continue;
      }

      if (!adapter.isAvailable()) {
        stages.push({ source, status: 'no-preconditions', agentCount: 0, durationMs: 0 });
        continue;
      }

      const stageStart = Date.now();
      try {
        const results = await withTimeout(
          adapter.search(options.query, limit, timeouts[source]),
          timeouts[source],
        );

        // Tag each result with source precedence
        for (const agent of results) {
          agent.source = source;
          agent.sourcePrecedence = SOURCE_PRECEDENCE[source];
        }

        allAgents.push(...results);
        stages.push({
          source, status: 'success',
          agentCount: results.length,
          durationMs: Date.now() - stageStart,
        });
      } catch (err) {
        const isTimeout = err instanceof Error && err.message === 'Discovery stage timeout';
        stages.push({
          source,
          status: isTimeout ? 'timeout' : 'error',
          agentCount: 0,
          durationMs: Date.now() - stageStart,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Deduplicate by fingerprint, keeping highest precedence source
    const deduped = deduplicateAgents(allAgents);

    return {
      agents: deduped.slice(0, limit),
      stages,
      totalDurationMs: Date.now() - startTime,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function deduplicateAgents(agents: DiscoveredAgent[]): DiscoveredAgent[] {
  const byFingerprint = new Map<string, DiscoveredAgent>();

  for (const agent of agents) {
    const existing = byFingerprint.get(agent.fingerprint);
    if (!existing || agent.sourcePrecedence > existing.sourcePrecedence) {
      byFingerprint.set(agent.fingerprint, agent);
    }
  }

  return [...byFingerprint.values()];
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Discovery stage timeout')), timeoutMs);
    promise.then(
      result => { clearTimeout(timer); resolve(result); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
