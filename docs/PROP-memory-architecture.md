# PROP: Mature Memory Architecture for Instar

> **Version**: 3.0
> **Date**: 2026-02-28
> **Status**: Phase 1-2 complete (115 tests). v3.0 — cross-review fixes + hybrid vector search.
> **Author**: Dawn (Inside-Dawn, builder instance)
> **Instar Version**: 0.9.17 (baseline)
> **Target Version**: 0.10.x
> **Cross-Review**: 8.5/10 avg (GPT 5.2, Gemini 3 Pro, Grok 4) — all findings addressed in this revision.

---

## Problem Statement

Instar agents accumulate knowledge across sessions but lack a coherent memory architecture. The current system is a collection of independent subsystems that don't cross-pollinate:

| System | Format | What it knows | What it can't do |
|--------|--------|---------------|------------------|
| MEMORY.md | Flat markdown | Anything the agent wrote | Scale, decay, connect, retrieve by relevance |
| TopicMemory | SQLite + JSONL | Conversation history | Connect conversations to knowledge |
| Relationships | JSON files | People and interactions | Connect people to topics or knowledge |
| CanonicalState | JSON files | Quick facts, anti-patterns | Evolve, connect, forget |
| DecisionJournal | JSONL | Past decisions | Inform future ones (no retrieval by similarity) |
| MemoryIndex | SQLite FTS5 | Text search over files | Understand meaning, only keyword match |

**The core problem**: These systems are *silos*. A learning about an API endpoint lives in MEMORY.md. The person who built that API lives in relationships/. The conversation where the agent discovered the endpoint lives in TopicMemory. The decision to use that API lives in DecisionJournal. Nothing connects them.

**Scaling problems**:
1. **MEMORY.md doesn't scale** — At 5K words it's noise, at 10K it actively hurts context
2. **No relevance-based retrieval** — Context loading is all-or-nothing (FTS5 is keyword matching, not semantic)
3. **No forgetting** — Old facts have equal weight to verified current facts
4. **No connections** — Knowledge is isolated in silos with no cross-references
5. **No confidence tracking** — A guess from 3 months ago looks identical to a verified fact from today

---

## Design Goals

1. **Scale gracefully** — 10 facts or 10,000 facts, same retrieval quality
2. **Retrieve by relevance** — "What do I know about deployment?" returns deployment knowledge, not everything
3. **Connect knowledge** — People, conversations, facts, and decisions form a web, not isolated lists
4. **Forget gracefully** — Knowledge decays unless verified; the agent stays current, not encyclopedic
5. **Migrate incrementally** — No big-bang migration; current systems continue working throughout
6. **Stay file-based** — No external database server; SQLite + JSON only (Instar's core portability promise)
7. **LLM-supervised quality** — The agent curates its own memory, not just accumulates

---

## Architecture Overview

### The Three Memory Systems

Drawing from cognitive science and Dawn's operational experience, a mature agent memory has three layers:

```
                    ┌─────────────────────────────┐
                    │     WORKING MEMORY           │
                    │  (Session context window)     │
                    │  What I'm thinking about now  │
                    └──────────────┬──────────────┘
                                   │ retrieves from
                    ┌──────────────▼──────────────┐
                    │     SEMANTIC MEMORY           │
                    │  (Structured knowledge graph)  │
                    │  Facts, entities, connections  │
                    └──────────────┬──────────────┘
                                   │ summarized from
                    ┌──────────────▼──────────────┐
                    │     EPISODIC MEMORY           │
                    │  (Session digests + raw logs)  │
                    │  What happened, what I learned │
                    └─────────────────────────────┘
```

**Episodic Memory** = What happened (sessions, conversations, events)
**Semantic Memory** = What I know (facts, entities, relationships, patterns)
**Working Memory** = What's relevant right now (session-specific context injection)

### Why Not a Full Knowledge Graph?

Knowledge graphs (Neo4j, etc.) are powerful but violate Instar's core constraint: **no external database servers**. The right level of graph-ness for Instar is:

- **Yes**: Entities with typed relationships and confidence scores
- **Yes**: Bidirectional connections between facts, people, topics
- **Yes**: Traversal queries ("what do I know about things related to X?")
- **No**: Full graph query language (Cypher, SPARQL)
- **No**: Running database server
- **No**: Schema-first rigid ontology

**The solution**: A lightweight entity-relationship store in SQLite, with a JSON export for portability and disaster recovery. Graph *concepts* without graph *infrastructure*.

---

## Detailed Design

### Phase 1: Semantic Memory Store (SQLite + JSON)

**New file**: `src/memory/SemanticMemory.ts`

#### Entity Model

```typescript
interface MemoryEntity {
  id: string;                    // UUID
  type: EntityType;              // 'fact' | 'person' | 'project' | 'tool' | 'pattern' | 'decision' | 'lesson'
  name: string;                  // Human-readable label
  content: string;               // The actual knowledge (markdown)
  confidence: number;            // 0.0 - 1.0 (BASE confidence — not pre-decayed. See Confidence Decay.)
  sensitivity: Sensitivity;      // Data classification for redaction/export control
  decayHalfLife: number;         // Days until confidence halves (default 30; per-entity override)
  version: number;               // Incremented on every update (optimistic concurrency)
  accessCount: number;           // Incremented on recall/search inclusion

  // Temporal
  createdAt: string;             // When first recorded
  lastVerified: string;          // When last confirmed true (ONLY updated by verify())
  lastAccessed: string;          // When last retrieved for a session
  expiresAt?: string;            // Optional hard expiry (e.g., "API key rotates monthly")

  // Provenance
  source: string;                // Where this came from ('session:ABC', 'observation', 'user:Justin')
  sourceSession?: string;        // Session ID that created this

  // Classification
  tags: string[];                // Free-form tags for filtering
  domain?: string;               // Optional domain grouping ('infrastructure', 'relationships', 'business')
}

type EntityType = 'fact' | 'person' | 'project' | 'tool' | 'pattern' | 'decision' | 'lesson';
type Sensitivity = 'public' | 'internal' | 'sensitive';
```

**Default `decayHalfLife` by entity type:**

| Entity Type | Default Half-Life | Rationale |
|------------|------------------|-----------|
| `fact` | 30 days | Facts go stale; need re-verification |
| `person` | 90 days | People don't change as fast |
| `project` | 60 days | Projects evolve moderately |
| `tool` | 30 days | Tool knowledge goes stale (version changes) |
| `pattern` | 90 days | Hard-won patterns persist |
| `decision` | 60 days | Decisions are contextual but not ephemeral |
| `lesson` | 90 days | Lessons are the most durable knowledge |

#### Relationship Model

```typescript
interface MemoryEdge {
  id: string;                    // UUID
  fromId: string;                // Source entity
  toId: string;                  // Target entity
  relation: RelationType;        // Type of connection
  weight: number;                // 0.0 - 1.0 (strength of connection)
  context?: string;              // Why this connection exists
  createdAt: string;
}

type RelationType =
  | 'related_to'       // Generic association
  | 'built_by'         // Person → Project/Tool
  | 'learned_from'     // Lesson → Session/Person
  | 'depends_on'       // Project → Tool/API
  | 'supersedes'       // New fact → Old fact
  | 'contradicts'      // Fact → Fact (conflict detection)
  | 'part_of'          // Component → System
  | 'used_in'          // Tool → Project
  | 'knows_about'      // Person → Topic
  | 'caused'           // Event → Consequence
  | 'verified_by';     // Fact → Session (re-verification)
```

#### SQLite Schema

**Database initialization** (mandatory for all connections):

```sql
PRAGMA journal_mode=WAL;         -- Write-Ahead Logging for concurrent read/write
PRAGMA busy_timeout=5000;        -- Wait up to 5s for locks instead of failing immediately
PRAGMA foreign_keys=ON;          -- Enforce referential integrity
```

> **Why WAL mode**: The Session Activity Sentinel (background) and Agent (foreground) write to the same SQLite file. Without WAL, concurrent writes cause `SQLITE_BUSY` errors. WAL allows readers and one writer to operate concurrently. (Cross-review: flagged by all 3 models as P0.)

```sql
-- Schema version tracking for future migrations
CREATE TABLE schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  description TEXT
);
INSERT INTO schema_version VALUES (1, datetime('now'), 'Initial schema');

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  sensitivity TEXT NOT NULL DEFAULT 'internal',  -- 'public' | 'internal' | 'sensitive'
  decay_half_life INTEGER NOT NULL DEFAULT 30,   -- Days; overridable per entity
  version INTEGER NOT NULL DEFAULT 1,            -- Incremented on every update
  access_count INTEGER NOT NULL DEFAULT 0,       -- Incremented on recall/search inclusion
  created_at TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  last_accessed TEXT NOT NULL,
  expires_at TEXT,
  source TEXT NOT NULL,
  source_session TEXT,
  domain TEXT,
  tags TEXT NOT NULL DEFAULT '[]'  -- JSON array
);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  context TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,

  UNIQUE(from_id, to_id, relation)
);

-- Full-text search over entity content (external content table)
CREATE VIRTUAL TABLE entities_fts USING fts5(
  name, content, tags,
  content=entities,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

-- FTS5 sync triggers (REQUIRED for external content tables)
-- Without these, the FTS index will be stale/empty after entity updates.
CREATE TRIGGER entities_fts_insert AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name, content, tags)
  VALUES (new.rowid, new.name, new.content, new.tags);
END;

CREATE TRIGGER entities_fts_delete AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, content, tags)
  VALUES ('delete', old.rowid, old.name, old.content, old.tags);
END;

CREATE TRIGGER entities_fts_update AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, content, tags)
  VALUES ('delete', old.rowid, old.name, old.content, old.tags);
  INSERT INTO entities_fts(rowid, name, content, tags)
  VALUES (new.rowid, new.name, new.content, new.tags);
END;

-- Audit log for entity changes (tracks who/what modified)
CREATE TABLE entity_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,            -- 'create' | 'update' | 'verify' | 'decay' | 'forget'
  old_version INTEGER,
  new_version INTEGER,
  changed_fields TEXT,             -- JSON array of field names
  source TEXT,                     -- What triggered the change ('session:X', 'sentinel', 'decay_job')
  created_at TEXT NOT NULL
);

-- Index for efficient queries
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_domain ON entities(domain);
CREATE INDEX idx_entities_confidence ON entities(confidence);
CREATE INDEX idx_entities_sensitivity ON entities(sensitivity);
CREATE INDEX idx_edges_from ON edges(from_id);
CREATE INDEX idx_edges_to ON edges(to_id);
CREATE INDEX idx_edges_relation ON edges(relation);
CREATE INDEX idx_audit_entity ON entity_audit(entity_id);
```

#### Vector Search Schema (Phase 5 — sqlite-vec)

When hybrid search is enabled (Phase 5), the following table is added via the `sqlite-vec` extension:

```sql
-- Vector embeddings for semantic similarity search
-- Requires: sqlite-vec extension loaded via sqliteVec.load(db)
CREATE VIRTUAL TABLE entity_embeddings USING vec0(
  entity_id TEXT PRIMARY KEY,
  embedding float[384]             -- 384-dim for all-MiniLM-L6-v2 (configurable)
);
```

This sits alongside FTS5, enabling hybrid retrieval: keyword match (FTS5) + semantic similarity (vector KNN) combined in the scoring formula. See [Phase 5: Hybrid Search](#phase-5-hybrid-search-fts5--vector-v0105) for details.

#### Core Operations

```typescript
class SemanticMemory {
  // ── Create & Update ──

  /**
   * Record a new fact, lesson, pattern, etc.
   *
   * DEDUPLICATION: Before inserting, searches for existing entities with
   * matching name (case-insensitive exact match or Levenshtein distance ≤ 2).
   * If a match is found:
   *   - Same type: merge (update content, refresh confidence, bump version)
   *   - Different type: link via 'related_to' edge, create new entity
   * Returns existing entity ID on merge, new entity ID on create.
   *
   * REDACTION: Content is passed through the Sanitizer before storage.
   * Patterns matching secrets (API keys, tokens, passwords) are stripped.
   */
  remember(entity: Omit<MemoryEntity, 'id' | 'createdAt' | 'lastAccessed' | 'version' | 'accessCount'>): string;

  /** Connect two entities */
  connect(fromId: string, toId: string, relation: RelationType, context?: string): string;

  /** Update confidence after verification. Only method that updates lastVerified. */
  verify(id: string, newConfidence?: number): void;

  /** Mark an entity as superseded by a newer one */
  supersede(oldId: string, newId: string, reason: string): void;

  // ── Retrieval ──

  /**
   * Search by text relevance with optional query expansion.
   *
   * Pipeline:
   * 1. Sanitize query for FTS5 special characters
   * 2. (If enabled) LLM query expansion: generate 3-5 synonym/related terms
   * 3. FTS5 keyword search with expanded query
   * 4. (If Phase 5 enabled) Vector KNN search for semantic similarity
   * 5. Multi-signal scoring (see Retrieval Scoring)
   * 6. Filter by type/domain/confidence
   * 7. Increment access_count for returned entities
   *
   * Entities with sensitivity='sensitive' are excluded from results
   * unless options.includeSensitive is true.
   */
  search(query: string, options?: {
    types?: EntityType[];
    domain?: string;
    minConfidence?: number;
    limit?: number;
    expandQuery?: boolean;        // LLM synonym expansion (default: false)
    includeSensitive?: boolean;   // Include sensitive entities (default: false)
  }): ScoredEntity[];

  /**
   * Get an entity and its connections (1-hop neighborhood).
   * Returns BOTH inbound and outbound edges by default.
   * Increments access_count for the primary entity.
   */
  recall(id: string, options?: {
    direction?: 'both' | 'outbound' | 'inbound';  // Default: 'both'
  }): { entity: MemoryEntity; connections: ConnectedEntity[] };

  /**
   * Find entities related to a topic (graph traversal).
   * Traverses BOTH directions by default, respects edge weights.
   */
  explore(startId: string, options?: {
    maxDepth?: number;    // Default: 2
    relations?: RelationType[];
    minWeight?: number;
    direction?: 'both' | 'outbound' | 'inbound';
  }): MemoryEntity[];

  /** Get context for a session — the "working memory loader" */
  getRelevantContext(query: string, options?: {
    maxTokens?: number;   // Default: 2000
    types?: EntityType[];
  }): string;  // Formatted markdown for session injection

  // ── Maintenance ──

  /**
   * Apply confidence decay to all entities.
   * Uses STORED base confidence + per-entity decayHalfLife.
   * Effective confidence is computed AT QUERY TIME only.
   * This method does NOT modify stored confidence — it is for
   * housekeeping only (finding entities that have decayed below threshold).
   *
   * See "Confidence Decay" section for the full model.
   */
  decayAll(): DecayReport;

  /** Find low-confidence or expired entities */
  findStale(options?: { maxConfidence?: number; olderThan?: string }): MemoryEntity[];

  /**
   * Remove an entity and its edges.
   * Uses soft-delete (tombstone) for 'person' and 'decision' entities.
   * Hard-deletes 'fact' and 'tool' entities.
   * Always logs to entity_audit table.
   */
  forget(id: string, reason: string): void;

  /**
   * Export to JSON (for backup, git state, portability).
   * REDACTION: Entities with sensitivity='sensitive' are excluded
   * unless options.includeSensitive is true.
   */
  export(options?: { includeSensitive?: boolean }): { entities: MemoryEntity[]; edges: MemoryEdge[] };

  /**
   * Import from JSON (migration, restore).
   * Uses entity version numbers to detect conflicts.
   * Conflict resolution: higher version wins; ties → merge.
   */
  import(data: { entities: MemoryEntity[]; edges: MemoryEdge[] }): ImportReport;

  /** Statistics */
  stats(): SemanticMemoryStats;
}
```

#### Retrieval Scoring

The key innovation: **multi-signal ranking** that combines text relevance, confidence, recency, and access frequency.

```
score = (text_score * 0.4) + (effective_confidence * 0.3) + (access_score * 0.1) + (vector_score * 0.2)

where:
  text_score          = 1 / (1 + abs(bm25_rank))     -- FTS5 BM25 normalization (0-1)
  effective_confidence = confidence * exp(-0.693 * days_since_verified / decay_half_life)
  access_score        = min(1.0, access_count / 10)   -- Frequently accessed = more relevant
  vector_score        = cosine_similarity              -- 0 if Phase 5 not enabled
```

> **BM25 normalization**: SQLite FTS5's `bm25()` returns negative values where *lower* (more negative) is *better*. The `1 / (1 + abs(rank))` transformation maps this to 0-1 where higher is better. (Cross-review: GPT caught that the original "normalized 0-1" was incorrect for FTS5.)

> **Effective confidence**: Computed AT QUERY TIME from stored base confidence + per-entity `decayHalfLife`. The stored `confidence` field is NEVER pre-decayed. This avoids the double-decay bug where storing decayed confidence AND computing decay at query time would cause confidence to collapse exponentially faster than intended. (Cross-review: GPT caught this P0 issue.)

> **Vector score**: When Phase 5 (Hybrid Search) is enabled, cosine similarity from sqlite-vec contributes 0.2 of the total score. When disabled, this weight is redistributed to text_score (0.5) and effective_confidence (0.3).

**Weights without vector search (Phase 1-4):**
```
score = (text_score * 0.5) + (effective_confidence * 0.3) + (access_score * 0.1) + (recency_bonus * 0.1)

where:
  recency_bonus = exp(-0.693 * days_since_verified / decay_half_life)
```

This means:
- A verified fact from yesterday ranks higher than an unverified claim from last month
- A frequently-accessed entity ranks higher than a rarely-used one
- Text relevance is the primary signal, but it's modulated by quality indicators
- With vector search enabled, "how do I ship code?" matches "Deployment Protocols" even without keyword overlap

#### Confidence Decay

**Model**: Confidence is stored as a BASE value. Effective confidence is computed at QUERY TIME. The stored `confidence` field is never pre-decayed.

```
effective_confidence = confidence * exp(-0.693 * days_since_verified / entity.decayHalfLife)
```

**Key invariants** (cross-review: GPT identified double-decay risk):
1. `confidence` stores the BASE confidence set at creation or last `verify()` call
2. `lastVerified` is ONLY updated by `verify()` — never by decay, search, or any other operation
3. Effective confidence is computed at query time using the formula above
4. `decayAll()` does NOT modify `confidence` — it only identifies entities that have decayed below a threshold for cleanup/notification

**Per-entity half-life** (cross-review: Grok recommendation):
Each entity has its own `decayHalfLife` (in days), defaulting by entity type (see table above). A `fact` with decayHalfLife=30 not re-verified in 30 days has effective confidence at 50%. In 60 days, 25%. In 90 days, 12.5%.

**Why this matters**: An agent that learned "the API endpoint is at /v1/users" 90 days ago and never re-verified it should treat that knowledge with appropriate skepticism. The decay doesn't delete the fact — it makes it rank lower in retrieval, so fresh verified knowledge surfaces first.

**Override examples**:
- Core architectural pattern → `decayHalfLife: 180` (changes rarely)
- Debug workaround → `decayHalfLife: 7` (likely temporary)
- Person's role at company → `decayHalfLife: 90` (stable-ish)

### Phase 2: Episodic Memory + Session Activity Sentinel

**New files**: `src/memory/EpisodicMemory.ts`, `src/monitoring/SessionActivitySentinel.ts`, `src/memory/ActivityPartitioner.ts`

#### The Problem with Session-End Digests

The original design assumed sessions are short, discrete units — digest them when they end. Reality is different: Telegram sessions can span hours or days, covering multiple unrelated topics. A session might never end cleanly (compaction, timeout, machine restart). And learnings from hour 1 are cold by hour 8.

**The solution**: Continuous mid-session digestion with end-of-session synthesis.

#### Two-Level Digest Architecture

```
Long-running session (hours/days)
  │
  ├─ Activity Unit 1: "Built migration engine" (45 min)
  │   └─ Mini-digest + entity extraction
  │
  ├─ Activity Unit 2: "Wrote E2E tests" (30 min)
  │   └─ Mini-digest + entity extraction
  │
  ├─ Activity Unit 3: "Discussed Phase 3 architecture" (20 min)
  │   └─ Mini-digest + entity extraction
  │
  └─ Session ends
      └─ Synthesis digest (reads all mini-digests → coherent overview)
```

#### Activity Digest (Mini-Digest)

```typescript
interface ActivityDigest {
  id: string;                      // UUID
  sessionId: string;               // Parent session
  sessionName: string;
  startedAt: string;               // When this activity unit began
  endedAt: string;                 // When it ended (next boundary)
  telegramTopicId?: number;        // Linked Telegram topic (if any)

  // What happened
  summary: string;                 // 2-3 sentence overview of this activity unit
  actions: string[];               // Key actions taken (commits, file edits, tests)

  // What was learned
  entities: string[];              // IDs of SemanticMemory entities created/updated
  learnings: string[];             // Key insights (free text)

  // What matters
  significance: number;            // 1-10
  themes: string[];                // Topic tags
  boundarySignal: BoundarySignal;  // What triggered this partition
}

type BoundarySignal =
  | 'topic_shift'       // Conversation changed direction
  | 'task_complete'     // Commit, test run, deployment
  | 'long_pause'        // 30+ min gap in activity
  | 'explicit_switch'   // User said "now let's work on..."
  | 'time_threshold'    // Max time between digests (60 min)
  | 'session_end';      // Session completed/killed
```

#### Session Synthesis (End-of-Session)

```typescript
interface SessionSynthesis {
  sessionId: string;
  sessionName: string;
  startedAt: string;
  endedAt: string;
  jobSlug?: string;
  telegramTopicId?: number;

  // Composed from mini-digests
  activityDigestIds: string[];     // References to all activity digests
  summary: string;                 // Coherent overview of the full session
  keyOutcomes: string[];           // What was accomplished

  // Aggregated from mini-digests
  allEntities: string[];           // All SemanticMemory entities created
  allLearnings: string[];          // All insights across activity units

  // Session-level assessment
  significance: number;            // 1-10
  themes: string[];                // Union of all activity themes
  followUp?: string;               // What the next session should do
}
```

#### Session Activity Sentinel

The sentinel is a monitoring process that runs inside the Instar server, watching for sessions that have accumulated unprocessed activity.

```typescript
class SessionActivitySentinel {
  /**
   * Check all running sessions for undigested activity.
   * Called periodically (every 30-60 min) by the scheduler.
   */
  async scan(): Promise<SentinelReport>;

  /**
   * Digest a specific session's recent activity.
   * Reads both session logs AND Telegram topic logs.
   */
  async digestActivity(sessionId: string): Promise<ActivityDigest[]>;

  /**
   * Synthesize all mini-digests into a session-level summary.
   * Called when a session completes.
   */
  async synthesizeSession(sessionId: string): Promise<SessionSynthesis>;
}
```

**Trigger points:**
1. **Periodic scan** (every 30-60 min): Sentinel checks running sessions, digests any with significant new activity since last digest
2. **Session completion** (`sessionComplete` event): Sentinel creates final activity digest + session synthesis
3. **On-demand** (API/CLI): Manual digest trigger for debugging or catch-up

**Concurrency & Idempotency** (cross-review: all 3 models flagged as P0):

- **Locking**: Sentinel uses `BEGIN IMMEDIATE` transactions when writing digests, ensuring atomic writes. The WAL mode configured at database initialization allows the Agent to continue reading while the Sentinel writes.
- **Idempotency**: Each digest is keyed by `hash(sessionId + startedAt + endedAt)`. If a digest with the same key already exists, the write is skipped. This prevents duplicate digests from overlapping scans or manual triggers racing with scheduled scans.
- **Dormant session gating**: Sentinel skips sessions where `last_activity_timestamp <= last_digest_timestamp`. This prevents burning tokens re-scanning inactive sessions. (Cross-review: Gemini flagged cost control.)
- **Minimum activity threshold**: A digest is only created if the activity unit contains ≥5 Telegram messages OR ≥10 minutes of session output. This prevents noisy trivial digests.

**LLM failure handling** (cross-review: Grok recommendation):

If the LLM call fails during digestion (API timeout, rate limit, etc.):
1. Raw activity content is saved to `state/episodes/pending/{sessionId}/{timestamp}.json`
2. The sentinel state records the failed attempt
3. Next scan retry processes pending raw content before scanning for new activity
4. After 3 failed retries, the raw content is archived and a warning is logged

#### Dual-Source Activity Partitioning

The ActivityPartitioner reads from two sources to build a unified activity timeline:

| Source | What it captures | Best for |
|--------|-----------------|----------|
| **Session logs** (tmux capture-pane) | Raw actions — file edits, test runs, git commits, tool output | WHAT the agent did |
| **Telegram topic logs** (JSONL) | Conversation — human instructions, agent responses, decisions, feedback | WHY the agent did it |

```typescript
class ActivityPartitioner {
  /**
   * Build a unified activity timeline from session + Telegram logs.
   * Identifies natural boundaries where activity shifts.
   */
  partition(input: {
    sessionOutput: string;           // tmux capture output
    telegramMessages?: TelegramLogEntry[];  // JSONL entries for linked topic
    lastDigestedAt?: string;         // Only process activity after this timestamp
  }): ActivityUnit[];
}

interface ActivityUnit {
  startedAt: string;
  endedAt: string;
  sessionContent: string;          // Relevant session output for this unit
  telegramContent?: string;        // Relevant Telegram messages for this unit
  boundarySignal: BoundarySignal;  // What marks the end of this unit
}
```

**Boundary detection signals (ranked by strength):**
1. **Explicit topic shift** in Telegram: "now let's work on X" / "moving on to..."
2. **Git commit** in session output: clear task completion marker
3. **Long pause** (30+ min gap): natural break in activity
4. **Telegram topic change**: messages shift to a different subject
5. **Time threshold** (60 min max): prevents unbounded activity units

For **job sessions** with no Telegram topic, the partitioner uses session logs only. For **interactive Telegram sessions**, it uses both. The Telegram logs are the richer signal for boundary detection because they contain the human's intent.

#### Storage

- Activity digests: `state/episodes/activities/{sessionId}/{digestId}.json`
- Session syntheses: `state/episodes/sessions/{sessionId}.json`
- Sentinel state: `state/episodes/sentinel-state.json` (tracks last-digested timestamps per session)

#### Retrieval

```typescript
class EpisodicMemory {
  /** Get all activity digests for a session */
  getSessionActivities(sessionId: string): ActivityDigest[];

  /** Get the session synthesis */
  getSessionSynthesis(sessionId: string): SessionSynthesis | null;

  /** Search across all digests by time range */
  getByTimeRange(start: string, end: string): ActivityDigest[];

  /** Search by theme */
  getByTheme(theme: string): ActivityDigest[];

  /** Search by significance (most important activity) */
  getBySignificance(minSignificance: number): ActivityDigest[];

  /** Get recent activity across all sessions (for working memory) */
  getRecentActivity(hours: number, limit: number): ActivityDigest[];
}
```

### Phase 3: Working Memory (Context-Aware Retrieval)

**Enhancement to**: `src/core/ContextHierarchy.ts`

The working memory layer assembles the right context for each session from all memory systems:

```typescript
interface WorkingMemoryAssembly {
  /** Identity grounding (Tier 0 — always) */
  identity: string;

  /** Relevant semantic knowledge (Tier 1 — session-specific) */
  knowledge: string;           // Top-ranked entities from SemanticMemory.search()

  /** Recent episode context (Tier 1) */
  recentEpisodes: string;      // Last 2-3 session digests

  /** Relationship context (Tier 1, if person detected) */
  relationships: string;       // Relevant relationship records

  /** Topic history (Tier 1, if topic detected) */
  topicContext: string;        // TopicMemory summary + recent messages

  /** Job-specific context (Tier 1, if job session) */
  jobContext: string;          // Handoff notes + last job state

  /** Total token estimate */
  estimatedTokens: number;
}
```

**Assembly strategy**:
1. Parse the session trigger (message, job prompt) to identify topics
2. Query SemanticMemory for relevant entities (with optional query expansion)
3. Check for related people (person entities connected to topic entities)
4. Load episode digests for continuity
5. Budget tokens across sources (identity: 200, knowledge: 800, episodes: 400, relationships: 300, topic: 300)
6. Return formatted context for session-start hook injection

**Render strategy within token budgets** (cross-review: Gemini gap):

When a source returns more entities than fit in its token budget:
- **Top 3**: Full content (name + content + confidence + connections summary)
- **Next 7**: Compact (name + first sentence of content + confidence)
- **Remainder**: Name-only list ("Also related: X, Y, Z")

This ensures the most relevant knowledge gets full detail while maintaining breadth of awareness. Token budgets may be dynamically adjusted in future versions based on source availability (e.g., if no relationships are relevant, that budget shifts to knowledge).

### Phase 4: Migration from Current Systems

**Critical constraint**: Migration is incremental. Current systems keep working throughout.

#### Step 1: SemanticMemory Ingestion (Automated)

A one-time migration job + ongoing sync:

1. **MEMORY.md → entities**: Parse headings as entities, content as knowledge. Each section becomes a `fact` or `pattern` entity. Confidence = 0.7 (not recently verified).

2. **Relationships → person entities + edges**: Each relationship becomes a `person` entity. Interaction themes become `knows_about` edges. Significance maps to confidence.

3. **CanonicalState → entities**: Quick facts become `fact` entities (confidence = 0.95). Anti-patterns become `lesson` entities. Project registry entries become `project` entities.

4. **DecisionJournal → decision entities + edges**: Each decision becomes a `decision` entity with `caused` edges to the entities it affected.

#### Step 2: Dual-Write Period

For 2-3 releases, both old and new systems receive writes:
- MEMORY.md continues to be updated (backward compatibility)
- SemanticMemory also receives the same knowledge
- MemoryIndex continues to work as before
- SemanticMemory's FTS5 provides an alternative search path

#### Step 3: Gradual Cutover

Once SemanticMemory proves reliable:
- New sessions prefer SemanticMemory for retrieval
- MEMORY.md becomes a human-readable export (still generated, no longer primary)
- MemoryIndex deprecated in favor of SemanticMemory's built-in FTS5

**Canonical source declaration** (cross-review: GPT flagged ambiguity):

| Data Type | Canonical Source | Mirror/Export |
|-----------|-----------------|---------------|
| People/Relationships | Relationships JSON | → `person` entities + `knows_about` edges in SemanticMemory |
| Facts/Knowledge | SemanticMemory | → MEMORY.md (generated) |
| Decisions | SemanticMemory | → DecisionJournal (legacy, read-only) |
| Conversation history | TopicMemory | → `learned_from` edges referencing topic IDs |
| Quick facts | CanonicalState JSON | → `fact` entities (confidence=0.95) |

People remain canonical in Relationships JSON because they have rich structured fields (interaction history, themes, significance) that don't map cleanly to entity content. SemanticMemory mirrors them as `person` entities with edges, enabling graph traversal. Updates flow: Relationships JSON → SemanticMemory sync (not the reverse).

#### Step 4: MEMORY.md as Generated Artifact

MEMORY.md transitions from "source of truth" to "generated snapshot":
- Periodically regenerated from SemanticMemory (top entities by confidence)
- Still loaded by session-start hooks (backward compatible with existing agents)
- Agents that haven't updated continue working as before
- Updated agents use SemanticMemory directly for retrieval

---

## Implementation Plan

### Phase 1: SemanticMemory Core (v0.10.0)
**Effort**: 2-3 sessions
**Files**:
- `src/memory/SemanticMemory.ts` — Core entity/edge store
- `tests/unit/semantic-memory.test.ts` — Entity CRUD, search, decay, export/import
- `src/server/routes.ts` — API endpoints: GET/POST /memory/semantic, /memory/semantic/search

**Deliverables**:
- Entity and edge CRUD operations
- FTS5 search with multi-signal ranking
- Confidence decay engine
- JSON export/import
- API routes for management and search

### Phase 2: Migration Engine (v0.10.1)
**Effort**: 1-2 sessions
**Files**:
- `src/memory/MemoryMigrator.ts` — Ingests MEMORY.md, relationships, canonical state
- `src/commands/memory.ts` — CLI commands: `instar memory migrate`, `instar memory stats`
- Job: `memory-migration` (one-time)

**Deliverables**:
- Automated ingestion from all existing memory sources
- Dual-write hooks in existing managers
- CLI for manual migration and inspection

### Phase 3: Episodic Memory + Session Activity Sentinel (v0.10.2)
**Effort**: 3-4 sessions
**Files**:
- `src/memory/EpisodicMemory.ts` — Activity digest + session synthesis storage and retrieval
- `src/memory/ActivityPartitioner.ts` — Dual-source activity timeline builder with boundary detection
- `src/monitoring/SessionActivitySentinel.ts` — Periodic scan of running sessions for undigested activity
- `tests/unit/episodic-memory.test.ts` — Storage, retrieval, time-range queries
- `tests/unit/activity-partitioner.test.ts` — Boundary detection, dual-source merging
- `tests/unit/session-activity-sentinel.test.ts` — Scan logic, trigger conditions
- `tests/integration/episodic-memory.test.ts` — Full HTTP pipeline for episode API routes
- `tests/e2e/episodic-memory-lifecycle.test.ts` — Production path verification (E2E standard)
- `src/server/routes.ts` — Episode API endpoints
- Enhancement to `sessionComplete` event handler — Triggers synthesis

**Deliverables**:
- Mid-session activity digestion (continuous, not just at session end)
- Dual-source partitioning (session logs + Telegram topic logs)
- Activity boundary detection (topic shifts, commits, pauses, time thresholds)
- End-of-session synthesis from accumulated mini-digests
- Entity extraction from digests into SemanticMemory
- Time-range, theme, and significance-based episode retrieval
- Sentinel job for monitoring long-running sessions

### Phase 4: Working Memory Assembly (v0.10.3)
**Effort**: 1-2 sessions
**Files**:
- Enhancement to `src/core/ContextHierarchy.ts` — Uses SemanticMemory for Tier 1/2
- Enhancement to session-start hook — Injects relevant context
- Enhancement to compaction-recovery hook — Re-injects from SemanticMemory

**Deliverables**:
- Context-aware session bootstrapping
- Token-budgeted assembly from all memory layers
- Seamless integration with existing hook system

### Phase 5: Hybrid Search — FTS5 + Vector (v0.10.4)
**Effort**: 2-3 sessions
**Files**:
- `src/memory/VectorSearch.ts` — sqlite-vec integration, embedding generation, KNN queries
- `src/memory/EmbeddingProvider.ts` — Local embedding via @huggingface/transformers (ONNX)
- Enhancement to `src/memory/SemanticMemory.ts` — Hybrid scoring (FTS5 + vector)
- `tests/unit/vector-search.test.ts` — Embedding generation, KNN accuracy, hybrid scoring
- `tests/integration/hybrid-search.test.ts` — Full pipeline: query → expand → FTS5 + vector → ranked results
- `tests/e2e/hybrid-search-lifecycle.test.ts` — Production path verification

**Deliverables**:
- Local embedding generation using Transformers.js (all-MiniLM-L6-v2, 384-dim)
- sqlite-vec virtual table alongside existing FTS5 index
- Hybrid retrieval: FTS5 keyword match + vector cosine similarity
- Automatic embedding generation on entity create/update
- Batch embedding for existing entities (migration job)
- LLM query expansion as a bridge (synonym generation before FTS5)
- Zero external API dependencies — all embeddings computed locally

**Technical details**:
- **npm packages**: `sqlite-vec` (loads as SQLite extension via `better-sqlite3`), `@huggingface/transformers` (ONNX runtime)
- **Model**: `all-MiniLM-L6-v2` (384-dim, ~80MB, fast inference) — configurable via agent settings
- **Embedding on write**: Every `remember()` and entity update generates an embedding and upserts into `entity_embeddings`
- **Hybrid query**: FTS5 results (top 50) and vector KNN results (top 50) are merged via the scoring formula, with FTS5 providing keyword precision and vectors providing semantic recall
- **Graceful degradation**: If sqlite-vec fails to load (platform incompatibility), falls back to FTS5-only search with a logged warning. Vector search is an enhancement, not a hard dependency.

### Phase 6: MEMORY.md Generation & Cutover (v0.10.5)
**Effort**: 1 session
**Files**:
- `src/memory/MemoryExporter.ts` — Generates MEMORY.md from SemanticMemory
- New job: `memory-export` — Periodic MEMORY.md regeneration
- Deprecation of MemoryIndex in favor of SemanticMemory search

**Deliverables**:
- MEMORY.md as generated artifact
- Backward compatibility preserved
- MemoryIndex deprecated with migration path

---

## Knowledge Graph Concepts: What We Take and What We Leave

### What We Take

| Concept | How We Use It | Why |
|---------|--------------|-----|
| **Typed entities** | EntityType enum (fact, person, project, etc.) | Different knowledge needs different handling |
| **Typed relationships** | RelationType enum (built_by, depends_on, etc.) | Enables meaningful traversal ("who built X?") |
| **Graph traversal** | `explore()` with depth limit | Find related knowledge 1-2 hops away |
| **Edge weights** | Connection strength (0-1) | Some connections are stronger than others |
| **Temporal properties** | Created, verified, accessed timestamps | Knowledge has a lifecycle |
| **Confidence scores** | Per-entity confidence with decay | Not all knowledge is equally trustworthy |

### What We Leave

| Concept | Why We Skip It | What We Do Instead |
|---------|---------------|-------------------|
| **Graph database** (Neo4j, etc.) | Violates file-based portability | SQLite with explicit edges table |
| **Query language** (Cypher, SPARQL) | Overkill for agent use cases | Typed API methods (search, recall, explore) |
| **Rigid ontology** | Agents need flexibility | Loose typing with free-form tags |
| **Full reasoning engine** | Too complex, diminishing returns | LLM handles reasoning over retrieved context |
| **Distributed graphs** | Single agent, single machine | Local SQLite with JSON export |
| **Real-time graph analytics** | Agents don't need PageRank | Simple BFS traversal with depth limits |

### The Principle

We use graph *concepts* (entities, edges, traversal, confidence) implemented in graph-*free* infrastructure (SQLite + JSON). The agent gets 80% of the value of a knowledge graph at 20% of the complexity, with zero operational burden.

---

## API Surface

### Server Endpoints

```
GET    /memory/semantic                    # Stats and overview
GET    /memory/semantic/search?q=QUERY     # FTS5 search with ranking
POST   /memory/semantic/entities           # Create entity
GET    /memory/semantic/entities/:id       # Get entity + connections
PATCH  /memory/semantic/entities/:id       # Update entity
DELETE /memory/semantic/entities/:id       # Forget entity
POST   /memory/semantic/entities/:id/verify  # Re-verify (refresh confidence)
POST   /memory/semantic/edges              # Create edge
DELETE /memory/semantic/edges/:id          # Remove edge
GET    /memory/semantic/explore/:id        # Graph traversal from entity
POST   /memory/semantic/context            # Get relevant context for a query
GET    /memory/semantic/stale              # List low-confidence entities
POST   /memory/semantic/decay              # Trigger confidence decay
POST   /memory/semantic/export             # Full JSON export
POST   /memory/semantic/import             # Full JSON import

GET    /memory/episodes                    # List session syntheses
GET    /memory/episodes/:sessionId         # Get session synthesis + activity digests
GET    /memory/episodes/activities         # List activity digests (with time/theme filters)
GET    /memory/episodes/activities/:id     # Get specific activity digest
GET    /memory/episodes/recent?hours=24    # Recent activity across all sessions
POST   /memory/episodes/digest/:sessionId  # Trigger manual digest for a running session
GET    /memory/episodes/sentinel           # Sentinel status (last scan, pending sessions)
POST   /memory/episodes/sentinel/scan      # Trigger sentinel scan on-demand
```

### CLI Commands

```bash
instar memory stats              # Overview of all memory systems
instar memory search "query"     # Search across all memory
instar memory migrate            # Run migration from existing systems
instar memory export             # Export to JSON
instar memory import FILE        # Import from JSON
instar memory decay              # Trigger confidence decay
instar memory stale              # List entities needing re-verification
instar memory episodes           # List recent session syntheses
instar memory digest SESSION_ID  # Trigger manual digest for a session
instar memory sentinel           # Show sentinel status and pending sessions
```

---

## Sensitive Data Handling

> Cross-review: All 3 models flagged the absence of security/privacy controls as a critical gap.

**Problem**: Session logs and Telegram messages contain arbitrary content — including potential API keys, tokens, passwords, PII, and proprietary information. Without redaction, SemanticMemory becomes a high-risk data sink that could persist and export secrets.

### Redaction Pipeline

Content passes through the `Sanitizer` before being stored in any entity's `content` field:

```typescript
class Sanitizer {
  /** Strip secrets from content before storage */
  sanitize(content: string): string;

  /** Patterns matched (applied in order):
   *  1. API keys: sk-..., ghp_..., xoxb-..., AKIA..., Bearer ...
   *  2. Tokens: JWT patterns (eyJ...), OAuth tokens
   *  3. Passwords: password=, passwd=, secret= followed by values
   *  4. Private keys: -----BEGIN ... PRIVATE KEY-----
   *  5. Connection strings: postgresql://, mongodb://, redis://
   *  6. Custom patterns from agent config
   */

  /** Returns '[REDACTED:api_key]' etc. so the agent knows something was removed */
}
```

### Entity Sensitivity Classification

Every entity has a `sensitivity` field:

| Level | Meaning | Behavior |
|-------|---------|----------|
| `public` | Safe for export, sharing, MEMORY.md | No restrictions |
| `internal` | Default. Safe within the agent's own systems | Excluded from JSON exports unless explicitly requested |
| `sensitive` | Contains PII, proprietary info, or personal context | Excluded from search results by default; excluded from all exports |

### API Endpoint Authentication

All `/memory/*` endpoints require a Bearer token (`INTERNAL_API_KEY`). This is already the pattern used by Instar's internal job API. While Instar runs locally (reducing network attack surface), the auth requirement prevents accidental exposure if the server port is forwarded or the machine is shared.

### Export/Import Protections

- `export()` excludes `sensitive` entities by default
- `import()` validates entity versions and logs all imported entities to the audit table
- JSON exports include a checksum for integrity verification

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| SQLite corruption | Memory loss | WAL mode + JSON export every 24h (backup), JSONL source of truth for messages |
| SQLite concurrency (SQLITE_BUSY) | Write failures between Sentinel + Agent | WAL mode, busy_timeout=5000ms, BEGIN IMMEDIATE for Sentinel writes |
| Migration data loss | Knowledge not transferred | Dual-write period, validation report after migration, MEMORY.md diff comparison |
| Performance at scale | Slow session starts | Token budgets, indexed queries, lazy loading, cached embeddings |
| Over-engineering | Complexity without value | Start with Phase 1 only; validate before proceeding |
| Backward compatibility | Existing agents break | MEMORY.md continues to work; new features are additive |
| Confidence decay too aggressive | Useful knowledge forgotten | Per-entity decayHalfLife (configurable), query-time-only decay |
| Double-decay bug | Confidence collapses exponentially | Stored base confidence + query-time decay ONLY; decayAll() doesn't modify confidence |
| Entity bloat / duplication | Split confidence, degraded retrieval | Dedup check in remember() + memory-hygiene guardian prunes stale entities |
| Secrets persisted in memory | Credential exposure via export/search | Sanitizer pipeline on ingestion; sensitivity classification; export redaction |
| Sentinel LLM cost | Frequent digestion burns API tokens | Haiku tier for digestion; configurable scan interval; skip dormant sessions |
| Sentinel LLM failure | Digests lost during API downtime | Pending queue with retry (3 attempts); raw content archived on failure |
| tmux buffer overflow | Long sessions lose early output | Sentinel digests continuously so early activity is captured before buffer scrolls |
| Noisy activity partitioning | Too many trivial mini-digests | Configurable minimum activity threshold (default: 5 messages or 10 min) |
| Digest quality varies | LLM summaries may miss key insights | Entity extraction as separate step; human review via API/CLI |
| Sentinel interferes with running session | Reading tmux output disrupts active session | Read-only capture-pane (already non-disruptive); Telegram JSONL is separate file |
| FTS5 index staleness | Search returns outdated results | Mandatory sync triggers on INSERT/UPDATE/DELETE (see schema) |
| sqlite-vec platform incompatibility | Vector search unavailable | Graceful degradation to FTS5-only; logged warning; not a hard dependency |
| Embedding model size | ~80MB download on first use | One-time download, cached locally; configurable model selection |
| Schema migration failures | Database locked to old schema | schema_version table + startup migration check with rollback support |

---

## Success Criteria

1. **An agent with 1000+ entities can retrieve relevant context in <100ms** (WAL mode, indexed queries)
2. **Session context quality improves** — sessions start with more relevant knowledge
3. **Knowledge connections discoverable** — "what do I know about X?" returns X + related entities
4. **Stale knowledge identified** — entities older than 60 days without verification are flagged
5. **MEMORY.md stays readable** — generated version is as useful as hand-written version
6. **Zero breaking changes** — existing agents continue working without modification
7. **Migration is reversible** — JSON export can restore to any point; version-based conflict resolution
8. **Long sessions don't lose learnings** — activity from hour 1 of a 6-hour session is captured, not forgotten
9. **Digests capture both what and why** — dual-source digests include agent actions AND human intent
10. **Sentinel overhead is negligible** — <$0.01 per digest using Haiku tier
11. **No secrets persist in memory** — Sanitizer catches API keys, tokens, passwords before storage
12. **Semantic search works without keyword overlap** — "how do I ship code?" finds "Deployment Protocols" (Phase 5)
13. **Entity deduplication prevents bloat** — same fact remembered twice merges, doesn't duplicate
14. **Concurrent Sentinel + Agent writes never conflict** — WAL mode + locking eliminates SQLITE_BUSY errors

---

## Open Questions

1. ~~**Embedding-based retrieval**~~ → **Addressed in Phase 5** (Hybrid Search via sqlite-vec + Transformers.js)

2. **Cross-agent memory sharing**: Should entities be shareable between agents? The JSON export/import enables this manually, but a shared registry could enable automatic knowledge sharing. What does eventual consistency look like when two agents on different machines learn the same fact?

3. **Memory capacity limits**: Should there be a hard cap on entities? Or should the decay + hygiene + deduplication system naturally keep the count manageable?

4. **LLM-supervised entity creation**: Should entity creation always go through an LLM for quality assessment? Or is that too expensive for high-frequency fact recording? (The extraction prompt design for episodic→semantic ingestion is critical and underspecified — needs concrete prompt templates before Phase 3 implementation.)

5. **Dynamic token budgets**: The fixed allocations (identity: 200, knowledge: 800, episodes: 400, relationships: 300, topic: 300) may need to be dynamic. What happens when one source dominates (e.g., 20 highly relevant knowledge entities competing for 800 tokens)?

6. ~~**Other SQLite systems**~~ → **Audited.** See "SQLite Vector Search Audit" appendix below.

---

## Relationship to Guardian Network

The guardian network (implemented in commit 913b871) maintains whatever memory system exists. With SemanticMemory, the guardians evolve:

- **memory-hygiene** → Audits SemanticMemory entities instead of MEMORY.md text
- **session-continuity-check** → Verifies session digests are being created
- **degradation-digest** → Can track memory-related degradations
- **guardian-pulse** → Monitors memory migration job health

The guardians are the immune system. SemanticMemory is the nervous system. They complement, not replace, each other.

---

## Cross-Review Attribution

This revision (v3.0) incorporates findings from independent reviews by GPT 5.2, Gemini 3 Pro, and Grok 4, conducted 2026-02-27. Full reviews available at `.claude/skills/crossreview/output/20260227-181548/`.

**Key fixes from cross-review:**
- P0: WAL mode + concurrency controls (all 3 models)
- P0: FTS5 sync triggers for external content table (GPT)
- P0: Double-decay bug prevention — query-time-only decay model (GPT)
- P0: `access_count` column added to schema (GPT)
- P1: Entity deduplication in `remember()` (all 3 models)
- P1: Sensitive Data Handling section with Sanitizer pipeline (all 3 models)
- P1: Canonical source declaration for person/relationship data (GPT)
- P2: Per-entity `decayHalfLife` field (Grok)
- P2: Context injection render strategy (Gemini)
- P2: Schema versioning table (Gemini + Grok)
- P2: LLM query expansion before FTS5 (Gemini)
- P3: Sentinel LLM failure handling with retry queue (Grok)
- P3: Edge directionality in query APIs (GPT)
- P3: Entity audit log table (Grok)

**New addition (v3.0):**
- Phase 5: Hybrid Search (FTS5 + sqlite-vec vector search) — addresses the "semantic gap" consensus finding

---

## Appendix: SQLite Vector Search Audit

> Audit conducted 2026-02-28. All three SQLite databases in Instar assessed for vector search upgrade potential.

### Current SQLite Systems

Instar has **three production SQLite databases**, all using `better-sqlite3` v12.6.2 with WAL mode and FTS5 (`porter unicode61` tokenizer):

| System | DB File | What it Stores | Current Search | Vector ROI |
|--------|---------|---------------|----------------|------------|
| **SemanticMemory** | `semantic.db` | Typed entities + edges (knowledge graph) | FTS5 + confidence + recency + graph traversal | **HIGHEST** |
| **MemoryIndex** | `memory.db` | Chunks from agent memory files (MEMORY.md, relationships, knowledge base) | FTS5 + temporal decay | **HIGH** |
| **TopicMemory** | `topic-memory.db` | Telegram conversation messages + LLM summaries | FTS5 + topic scope + highlights | **MEDIUM** |

### Analysis

**SemanticMemory** (HIGHEST priority — already planned as Phase 5):
- Stores the richest structured knowledge with the most diverse query patterns
- Multi-signal scoring formula already has a `vector_score` slot for embedding similarity
- "How do I ship code?" → cannot find "Deployment Protocols" via FTS5 alone
- Graph traversal partially compensates but initial search is purely lexical

**MemoryIndex** (HIGH priority — should be Phase 5b):
- Indexes all agent memory files and knowledge base content
- Classic "vocabulary mismatch" problem: file about "Vercel hosting" won't match query about "deployment infrastructure"
- Already has a `vectorSearchAvailable: boolean` field in `MemoryIndexStats` (currently hardcoded `false`) — the hook point is pre-built
- Shares the same `better-sqlite3` dependency, so sqlite-vec loading is trivial to add

**TopicMemory** (MEDIUM priority — defer):
- LLM-generated rolling summaries already perform semantic compression
- Most conversation search is temporal ("what did we talk about recently?") not conceptual
- Cross-topic semantic search ("find all conversations about architecture decisions") would benefit from embeddings, but the summary layer handles the 80% case
- Recommend deferring until Phase 5 proves the pattern, then retrofitting

### Recommendation

Phase 5 should implement a **shared `EmbeddingProvider`** (`src/memory/EmbeddingProvider.ts`) that any SQLite system can use:

```typescript
class EmbeddingProvider {
  /** Generate embedding for text using local ONNX model */
  embed(text: string): Promise<Float32Array>;

  /** Batch embed multiple texts (more efficient) */
  embedBatch(texts: string[]): Promise<Float32Array[]>;

  /** Load sqlite-vec extension into a better-sqlite3 connection */
  loadVecExtension(db: Database): void;
}
```

This provider is initialized once at server startup and shared across SemanticMemory, MemoryIndex, and (eventually) TopicMemory. The embedding model (~80MB) is downloaded once and cached locally. Each system adds its own `vec0` virtual table but shares the same embedding pipeline.

**Implementation order:**
1. `EmbeddingProvider` (shared infrastructure)
2. SemanticMemory hybrid search (highest ROI, most complex scoring)
3. MemoryIndex hybrid search (hook point exists, straightforward addition)
4. TopicMemory (deferred — evaluate after 1-2 months of usage data)

