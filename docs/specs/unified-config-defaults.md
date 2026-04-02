# Unified Config Defaults System — Revised Specification v2.0

> **Status**: Implemented (v0.26.0)
> **Author**: Echo (instar developer)
> **Reviewers**: Architecture (7/10), DX (6.5/10), Security (5/10), Adversarial (4/10)
> **Date**: 2026-04-01
> **Addresses**: Init/update drift that caused PromptGate to be missing for all non-Echo agents

---

## Problem Statement

New config fields get added to `init.ts` (for new agents) but NOT to `PostUpdateMigrator.ts` (for existing agents). This is a structural problem — two code paths with no shared source of truth and no enforcement mechanism. The developer must remember to update both, which is a human memory problem that will fail repeatedly.

**Most recent incident**: PromptGate was missing for all agents except Echo (manually configured). Sessions hung on permission prompts with no relay to the user.

---

## Design Principles

1. **Single source of truth** — Config defaults defined ONCE, consumed by both init and migration
2. **Never overwrite user customization** — Deep merge adds missing keys only
3. **Explicit opt-out** — Users can permanently exclude fields from migration
4. **Atomic operations** — Config writes are crash-safe
5. **Auditable** — Every migration is logged with version and timestamp
6. **Type-aware** — Managed-project and standalone agents have different defaults where needed
7. **Testable** — CI prevents init/update drift

---

## Architecture

### ConfigDefaults.ts

The actual implementation has three data structures and three public exports:

```typescript
// src/config/ConfigDefaults.ts

export type AgentType = 'managed-project' | 'standalone';

/** Fields shared across ALL agent types (init + migration) */
const SHARED_DEFAULTS: Record<string, unknown> = {
  monitoring: {
    memoryMonitoring: true,
    healthCheckIntervalMs: 30000,
    promptGate: { enabled: true, autoApprove: { enabled: true, fileCreation: true, fileEdits: true, planApproval: false }, dryRun: false },
  },
  threadline: { relayEnabled: false, visibility: 'public', capabilities: ['chat'] },
};

/** Fields that differ between agent types at INIT time (override SHARED_DEFAULTS for new agents) */
const TYPE_OVERRIDES: Record<string, Record<string, unknown>> = {
  'managed-project': {
    monitoring: { quotaTracking: false },
    externalOperations: { enabled: true, sentinel: { enabled: true }, services: {}, readOnlyServices: [],
      trust: { floor: 'collaborative', autoElevateEnabled: true, elevationThreshold: 5 } },
    tunnel: { enabled: true, type: 'quick' },
  },
  standalone: {
    monitoring: { quotaTracking: true },
    externalOperations: { enabled: true, sentinel: { enabled: true }, services: {}, readOnlyServices: [],
      trust: { floor: 'collaborative', autoElevateEnabled: true, elevationThreshold: 5 } },
  },
};

/**
 * Fields that override SHARED_DEFAULTS + TYPE_OVERRIDES during MIGRATION only.
 * Uses conservative values for security-sensitive fields — existing agents were
 * operating without these features, so permissive defaults would change their security posture.
 */
const MIGRATION_OVERRIDES: Record<string, unknown> = {
  externalOperations: { enabled: true, sentinel: { enabled: true }, services: {}, readOnlyServices: [],
    trust: { floor: 'supervised', autoElevateEnabled: false, elevationThreshold: 10 } },
};

/** Get defaults for new agent creation (init.ts). */
export function getInitDefaults(agentType: AgentType): Record<string, unknown> { ... }

/** Get defaults for migration (PostUpdateMigrator). Applies conservative MIGRATION_OVERRIDES. */
export function getMigrationDefaults(agentType: AgentType): Record<string, unknown> { ... }

/** Apply defaults to an existing config. Only adds MISSING keys. Never overwrites. Respects _instar_noMigrate. */
export function applyDefaults(
  config: Record<string, unknown>,
  defaults: Record<string, unknown>,
): { patched: boolean; changes: string[]; skipped: string[] } { ... }
```

### Key Design Decisions

#### Arrays are treated as opaque leaves
Arrays (like `capabilities: ['chat']`) are NEVER merged — they're replaced-if-absent or left alone. This preserves idempotency. Union or concatenation would produce duplicates on repeated runs.

#### Agent-type overrides via composition
`SHARED_DEFAULTS` contains everything common. `TYPE_OVERRIDES` contains only the fields that differ. `getInitDefaults(agentType)` merges these for new agents. `getMigrationDefaults(agentType)` additionally applies `MIGRATION_OVERRIDES` on top, which substitutes conservative values for security-sensitive fields (e.g., `trust.floor: 'supervised'` instead of `'collaborative'` for existing agents).

The `agentType` field already exists in config.json (set during init). The migrator reads it to determine which defaults to apply.

#### `_instar_noMigrate` opt-out list
Users who intentionally disable a feature can add its key to this array:
```json
{
  "_instar_noMigrate": ["promptGate", "externalOperations"],
  "monitoring": {
    "promptGate": { "enabled": false }
  }
}
```
The migrator will never touch fields listed here, even if they're missing sub-keys. This solves the "can't distinguish intentional omission from never-migrated" problem.

#### Runtime-generated fields NEVER appear in defaults
These are instance state, not behavioral config:
- `port`, `authToken`, `dashboardPin` (generated at init)
- `chatId`, `botToken`, `appToken` (user-provided credentials)
- `stateDir`, `projectDir`, `tmuxPath`, `claudePath` (environment-dependent)

This is documented as a contract at the top of ConfigDefaults.ts.

---

## Usage

### In init.ts

```typescript
import { getInitDefaults } from '../config/ConfigDefaults.js';

// Managed-project init
const defaults = getInitDefaults('managed-project');
const config = {
  ...defaults,
  // Runtime-generated fields
  port,
  authToken,
  projectDir,
  stateDir,
  agentType: 'managed-project',
  // User-provided fields
  messaging: [],
  sessions: { tmuxPath, claudePath, ... },
};
```

### In PostUpdateMigrator.ts

```typescript
import { getMigrationDefaults, applyDefaults } from '../config/ConfigDefaults.js';

private migrateConfig(result: MigrationResult): void {
  // ... read config.json ...

  const agentType = (config.agentType as string) === 'standalone' ? 'standalone' : 'managed-project';
  const defaults = getMigrationDefaults(agentType);
  const { patched, changes, skipped } = applyDefaults(config, defaults);

  if (patched) {
    // Record migration version
    const migrations = (config._instar_migrations ?? []) as string[];
    migrations.push(`defaults-${version}-${new Date().toISOString()}`);
    config._instar_migrations = migrations;

    // Atomic write: tmp + rename
    const tmp = configPath + '.tmp';
    const bak = configPath + '.bak';
    fs.copyFileSync(configPath, bak); // Backup before patching
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);

    for (const change of changes) {
      result.upgraded.push(`config.json: ${change}`);
    }

    // Audit log
    this.logMigration(changes, version);
  }
}

private logMigration(changes: string[], version: string): void {
  const logPath = path.join(this.config.stateDir, 'security.jsonl');
  const entry = {
    event: 'config-migration',
    timestamp: new Date().toISOString(),
    version,
    changes,
    source: 'PostUpdateMigrator',
  };
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}
```

---

## Safety Mechanisms

### 1. Atomic writes
Config writes use write-to-tmp-then-rename. If the process crashes mid-write, the original config.json is untouched. A `.bak` backup is created before every migration.

### 2. Pre-migration backup
`config.json.bak` is created before any migration. If a migration produces wrong values, the user can restore from backup.

### 3. Migration versioning
`_instar_migrations: string[]` tracks which migrations have run:
```json
{
  "_instar_migrations": [
    "defaults-0.25.9-2026-03-31T20:05:18.000Z",
    "defaults-0.26.0-2026-04-15T10:30:00.000Z"
  ]
}
```
This enables:
- Knowing which agent has which migrations
- Corrective migrations (force-update a wrong default by checking the version list)
- Idempotency verification

### 4. Audit trail
Every migration is logged to `security.jsonl` with the version, timestamp, and list of changed fields. This provides traceability for debugging.

### 5. Type-mismatch guards
If an existing field has an unexpected type (e.g., `monitoring: true` instead of an object), the merger skips it and logs a warning. It never overwrites with a different type.

### 6. Opt-out mechanism
`_instar_noMigrate` prevents the migrator from touching specific fields, permanently. Users who intentionally disable features won't have them re-enabled on update.

---

## CI Enforcement

### Test 1: Init/Update equivalence
```typescript
test('init and applyDefaults produce same config shape', () => {
  const initConfig = generateInitConfig({ agentType: 'managed-project' });
  const migratedConfig = applyDefaults({}, getInitDefaults('managed-project'));

  // Every key in defaults should exist in init output
  for (const key of Object.keys(migratedConfig)) {
    expect(initConfig).toHaveProperty(key);
  }
});
```

### Test 2: Idempotency
```typescript
test('applyDefaults is idempotent', () => {
  const defaults = getInitDefaults('standalone');
  const config = {};
  const first = applyDefaults(config, defaults);
  const second = applyDefaults(config, defaults);

  expect(second.patched).toBe(false); // No changes on second run
  expect(second.changes).toHaveLength(0);
});
```

### Test 3: Never overwrites
```typescript
test('applyDefaults never overwrites existing values', () => {
  const config = { monitoring: { promptGate: { enabled: false } } };
  const defaults = getInitDefaults('managed-project');
  applyDefaults(config, defaults);

  expect(config.monitoring.promptGate.enabled).toBe(false); // NOT overwritten
});
```

---

## Multi-Machine Considerations

Agents using git sync will propagate config.json changes across machines. The migration:
- Is idempotent (same result regardless of how many times it runs)
- Produces deterministic output (no timestamps in the config itself, only in `_instar_migrations`)
- Does not conflict with concurrent runs (add-only, no deletes or updates)

If two machines run the migrator on the same version, they produce identical changes. Git merge will see no conflict.

---

## LiveConfig Interaction

LiveConfig polls config.json mtime every ~5 seconds. After a migration write:
- The next poll (within 5s) picks up the new values
- No explicit refresh is needed for non-critical fields
- For critical fields (like `promptGate.enabled`), the 5s delay is acceptable since the migration runs before the server starts handling messages

If this delay proves problematic, a future enhancement can add a force-refresh signal.

---

## Deprecation Path

To deprecate a config field:
1. Remove it from `SHARED_DEFAULTS` / `TYPE_OVERRIDES` (new agents won't get it)
2. Add a `cleanupDeprecated()` method to PostUpdateMigrator that removes the field
3. Log the removal to security.jsonl
4. Ship as a separate versioned migration (not automatic via applyDefaults)

Deprecation is always explicit and logged. The `applyDefaults` function only adds — it never removes.

---

## What's NOT in Scope

- **Credential migration** — Tokens, API keys, and passwords are never in defaults
- **Schema validation** — Full config schema validation is a separate concern (can be added later)
- **Config UI** — No dashboard or CLI for editing config (manual JSON editing continues)
- **Cross-agent config sync** — Each agent manages its own config independently

---

## Implementation Plan

1. Create `src/config/ConfigDefaults.ts` with shared defaults, type overrides, and `applyDefaults()`
2. Write CI tests (equivalence, idempotency, no-overwrite)
3. Refactor `init.ts` to use `getConfigDefaults()` instead of inline objects
4. Refactor `PostUpdateMigrator.migrateConfig()` to use `applyDefaults()` instead of manual if-blocks
5. Add `_instar_noMigrate` support
6. Add `_instar_migrations` versioning
7. Add atomic writes (tmp + rename + backup)
8. Add audit logging to security.jsonl
9. Remove duplicate default definitions from existing code
10. Publish and verify on Echo, Indra, Dawn
