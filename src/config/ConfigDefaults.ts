/**
 * ConfigDefaults — Single source of truth for Instar agent config defaults.
 *
 * RULES FOR THIS FILE:
 * 1. Only include fields that are SAFE for all agents (not runtime-generated)
 * 2. Never include: port, authToken, paths, dashboardPin, chatId, botToken
 * 3. If a field differs by agent type, put it in TYPE_OVERRIDES
 * 4. If a field should be more conservative for existing agents, put it in MIGRATION_OVERRIDES
 * 5. Every field here is auto-applied to existing agents on update via PostUpdateMigrator
 * 6. Adding a field here is equivalent to adding it to BOTH init AND migration
 *
 * Runtime-generated fields that MUST NOT appear here:
 *   port, authToken, dashboardPin, stateDir, projectDir, tmuxPath, claudePath,
 *   chatId, botToken, appToken, token (any credential), webhookUrl
 */

/** Fields shared across ALL agent types and contexts (init + migration) */
const SHARED_DEFAULTS: Record<string, unknown> = {
  monitoring: {
    memoryMonitoring: true,
    healthCheckIntervalMs: 30000,
    promptGate: {
      enabled: true,
      autoApprove: {
        enabled: true,
        fileCreation: true,
        fileEdits: true,
        planApproval: false,
      },
      dryRun: false,
    },
  },
  threadline: {
    relayEnabled: false,
    visibility: 'public',
    capabilities: ['chat'],
  },
};

/**
 * Fields that differ between agent types at INIT time.
 * These override SHARED_DEFAULTS when creating new agents.
 */
const TYPE_OVERRIDES: Record<string, Record<string, unknown>> = {
  'managed-project': {
    monitoring: { quotaTracking: false },
    externalOperations: {
      enabled: true,
      sentinel: { enabled: true },
      services: {},
      readOnlyServices: [],
      trust: {
        floor: 'collaborative',
        autoElevateEnabled: true,
        elevationThreshold: 5,
      },
    },
    tunnel: {
      enabled: true,
      type: 'quick',
    },
  },
  standalone: {
    monitoring: { quotaTracking: true },
    externalOperations: {
      enabled: true,
      sentinel: { enabled: true },
      services: {},
      readOnlyServices: [],
      trust: {
        floor: 'collaborative',
        autoElevateEnabled: true,
        elevationThreshold: 5,
      },
    },
  },
};

/**
 * Fields that should use MORE CONSERVATIVE values when migrating to existing agents.
 * These override SHARED_DEFAULTS + TYPE_OVERRIDES during migration only.
 *
 * Rationale: existing agents were operating without these features.
 * Silently enabling permissive settings could change security posture.
 * New agents get the permissive defaults; existing agents get conservative ones.
 */
const MIGRATION_OVERRIDES: Record<string, unknown> = {
  externalOperations: {
    enabled: true,
    sentinel: { enabled: true },
    services: {},
    readOnlyServices: [],
    trust: {
      floor: 'supervised',        // More conservative than init's 'collaborative'
      autoElevateEnabled: false,   // Don't auto-elevate existing agents
      elevationThreshold: 10,      // Higher threshold
    },
  },
};

// ── Deep Merge Utility ──

/**
 * Deep merge source into target (mutates target).
 * Arrays are treated as opaque leaves (replaced, never merged/concatenated).
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (
      typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key]) &&
      typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])
    ) {
      deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      target[key] = structuredClone(source[key]);
    }
  }
}

// ── Public API ──

export type AgentType = 'managed-project' | 'standalone';

/**
 * Get the complete defaults for a given agent type (used by init).
 * Returns a deep copy safe to mutate.
 */
export function getInitDefaults(agentType: AgentType): Record<string, unknown> {
  const base = structuredClone(SHARED_DEFAULTS);
  const overrides = TYPE_OVERRIDES[agentType];
  if (overrides) {
    deepMerge(base, structuredClone(overrides));
  }
  return base;
}

/**
 * Get the defaults for migration (used by PostUpdateMigrator).
 * Uses conservative overrides for security-sensitive fields.
 */
export function getMigrationDefaults(agentType: AgentType): Record<string, unknown> {
  const base = getInitDefaults(agentType);
  deepMerge(base, structuredClone(MIGRATION_OVERRIDES));
  return base;
}

/**
 * Apply defaults to an existing config. Only adds MISSING keys.
 * Never overwrites existing values. Respects _instar_noMigrate.
 *
 * Arrays are treated as opaque leaves — if present, left alone; if absent, added whole.
 *
 * @returns { patched, changes, skipped }
 */
export function applyDefaults(
  config: Record<string, unknown>,
  defaults: Record<string, unknown>,
): { patched: boolean; changes: string[]; skipped: string[] } {
  const noMigrate = new Set<string>(
    Array.isArray(config._instar_noMigrate)
      ? config._instar_noMigrate as string[]
      : [],
  );

  const changes: string[] = [];
  const skipped: string[] = [];

  function merge(target: Record<string, unknown>, source: Record<string, unknown>, path: string): void {
    for (const key of Object.keys(source)) {
      const fullPath = path ? `${path}.${key}` : key;

      // Skip fields the user explicitly opted out of
      if (noMigrate.has(fullPath) || noMigrate.has(key)) {
        skipped.push(`${fullPath} (opted out via _instar_noMigrate)`);
        continue;
      }

      if (!(key in target)) {
        // Key is missing — add it
        target[key] = structuredClone(source[key]);
        changes.push(`${fullPath} (added)`);
      } else if (
        typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key]) &&
        typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])
      ) {
        // Both are objects — recurse
        merge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>, fullPath);
      } else {
        // Key exists with a non-object value, or one side is an array — don't touch
        // (includes type mismatches like boolean vs object — skip, don't crash)
      }
    }
  }

  merge(config, defaults, '');
  return { patched: changes.length > 0, changes, skipped };
}
