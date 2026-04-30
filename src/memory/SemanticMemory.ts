/**
 * SemanticMemory — Entity-relationship knowledge store with FTS5 + vector hybrid search.
 *
 * A typed, confidence-tracked knowledge graph stored in SQLite. Entities
 * represent knowledge (facts, people, projects, tools, patterns, decisions,
 * lessons) and edges represent relationships between them.
 *
 * Key features:
 *   - FTS5 full-text search with multi-signal ranking
 *   - Optional vector similarity search via sqlite-vec (Phase 5)
 *   - Hybrid scoring: FTS5 keyword + vector cosine similarity
 *   - Exponential confidence decay (lessons decay slower than facts)
 *   - BFS graph traversal with cycle detection
 *   - Export/import for portability
 *   - Formatted context generation for session injection
 *   - Graceful degradation: works FTS5-only when vectors unavailable
 *
 * Uses the same better-sqlite3 pattern as MemoryIndex and TopicMemory.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import type {
  MemoryEntity,
  MemoryEdge,
  ScoredEntity,
  ConnectedEntity,
  DecayReport,
  ImportReport,
  SemanticMemoryStats,
  SemanticMemoryConfig,
  SemanticSearchOptions,
  ExploreOptions,
  EntityType,
  RelationType,
} from '../core/types.js';
import type { PrivacyScopeType } from '../core/types.js';
import type { EmbeddingProvider } from './EmbeddingProvider.js';
import { VectorSearch } from './VectorSearch.js';
import { buildPrivacySqlFilter } from '../utils/privacy.js';

// Dynamic import for better-sqlite3 (optional dependency)
type Database = import('better-sqlite3').Database;

/**
 * Strip FTS5 special syntax characters from a query.
 * Prevents query manipulation via AND, OR, NOT, NEAR, *, column filters.
 */
function sanitizeFts5Query(query: string): string {
  return query
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
    .replace(/[*:"^{}().$@#!~`?\\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class SemanticMemory {
  private db: Database | null = null;
  private readonly config: SemanticMemoryConfig;
  private embeddingProvider: EmbeddingProvider | null = null;
  private vectorSearch: VectorSearch | null = null;
  private _vectorAvailable = false;
  private jsonlPath: string;
  /** Set after corruption auto-recovery — caller should reimport from JSONL */
  private _needsRebuild = false;

  constructor(config: SemanticMemoryConfig) {
    this.config = config;
    // JSONL append log lives alongside the database — source of truth for disaster recovery
    this.jsonlPath = config.dbPath.replace(/\.db$/, '.jsonl');
  }

  /**
   * Whether hybrid vector search is active (sqlite-vec loaded + embeddings table created).
   */
  get vectorSearchAvailable(): boolean {
    return this._vectorAvailable;
  }

  /**
   * Attach an EmbeddingProvider to enable hybrid search.
   * Must be called BEFORE open() for full effect, but can be called after
   * to enable vector search on an already-open database.
   */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
    this.vectorSearch = new VectorSearch({
      tableName: 'entity_embeddings',
      dimensions: provider.dimensions,
    });

    // If DB is already open, try to wire up vector search now
    if (this.db) {
      this.initVectorSearch();
    }
  }

  private initVectorSearch(): void {
    if (!this.db || !this.embeddingProvider || !this.vectorSearch) return;

    const loaded = this.embeddingProvider.loadVecExtension(this.db);
    if (loaded) {
      this.vectorSearch.createTable(this.db);
      this._vectorAvailable = true;
    }
  }

  /**
   * Async initialization for vector search.
   * Loads sqlite-vec module, then wires up the extension and creates tables.
   * Call this after open() and setEmbeddingProvider() for full hybrid search.
   */
  async initializeVectorSearch(): Promise<boolean> {
    if (!this.db || !this.embeddingProvider || !this.vectorSearch) return false;

    const vecAvailable = await this.embeddingProvider.loadVecModule();
    if (!vecAvailable) return false;

    this.initVectorSearch();
    return this._vectorAvailable;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  async open(): Promise<void> {
    if (this.db) return;

    let BetterSqlite3: any;
    try {
      BetterSqlite3 = await import('better-sqlite3');
    } catch {
      throw new Error(
        'SemanticMemory requires better-sqlite3. Run: npm install better-sqlite3'
      );
    }

    const constructor = BetterSqlite3.default || BetterSqlite3;

    // Ensure parent directory exists
    const dbDir = path.dirname(this.config.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = constructor(this.config.dbPath) as Database;

    // Integrity check — auto-recover from corruption (JSONL is source of truth).
    // Corrupt DBs are quarantined (renamed) not deleted, and a marker file is written
    // so operators can notice the recovery after the fact.
    if (fs.existsSync(this.config.dbPath) && fs.statSync(this.config.dbPath).size > 0) {
      try {
        const result = this.db!.pragma('integrity_check') as Array<{ integrity_check: string }>;
        if (result[0]?.integrity_check !== 'ok') {
          this.quarantineCorruptDb(`integrity_check=${result[0]?.integrity_check}`);
          this.db = constructor(this.config.dbPath) as Database;
          this._needsRebuild = true;
        }
      } catch (err) {
        this.quarantineCorruptDb(`pragma threw: ${(err as Error).message}`);
        this.db = constructor(this.config.dbPath) as Database;
        this._needsRebuild = true;
      }

      // Secondary probe: integrity_check can miss torn interior pages that aren't
      // reachable from the B-tree schema walk. A probe read on existing tables catches these.
      if (!this._needsRebuild) {
        try {
          const tables = this.db!.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'fts%' AND name NOT LIKE 'sqlite%'"
          ).all() as Array<{ name: string }>;
          for (const t of tables) {
            this.db!.prepare(`SELECT * FROM "${t.name}" LIMIT 100`).all();
          }
        } catch (err) {
          this.quarantineCorruptDb(`probe read failed: ${(err as Error).message}`);
          this.db = constructor(this.config.dbPath) as Database;
          this._needsRebuild = true;
        }
      }
    }

    this.db!.pragma('journal_mode = WAL');
    this.db!.pragma('busy_timeout = 5000');
    this.db!.pragma('foreign_keys = ON');

    this.createSchema();
    this.migrateIfNeeded();

    // Initialize vector search if embedding provider is attached
    this.initVectorSearch();

    // Auto-rebuild from JSONL after corruption recovery
    if (this._needsRebuild) {
      const maxBytes = this.config.autoRebuildMaxBytes ?? 50 * 1024 * 1024;
      if (fs.existsSync(this.jsonlPath)) {
        const jsonlSize = fs.statSync(this.jsonlPath).size;
        if (maxBytes > 0 && jsonlSize > maxBytes) {
          console.warn(
            `[SemanticMemory] JSONL too large for synchronous rebuild ` +
            `(${(jsonlSize / 1024 / 1024).toFixed(1)} MB, limit ${(maxBytes / 1024 / 1024).toFixed(0)} MB). ` +
            `Starting with empty DB — rebuild manually via importFromJsonl().`
          );
          this.writeSkippedRebuildMarker(jsonlSize, maxBytes);
        } else {
          const result = this.importFromJsonl(this.jsonlPath);
          console.log(`[SemanticMemory] Auto-rebuilt from JSONL: ${result.entities} entities, ${result.edges} edges reimported`);
        }
      } else {
        console.warn('[SemanticMemory] No JSONL log found for rebuild — starting fresh');
      }
      this._needsRebuild = false;
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Checkpoint the WAL file. Call after sleep/wake to flush stale WAL locks.
   * Uses PASSIVE mode (non-blocking) — safe to call at any time.
   */
  checkpoint(): void {
    if (this.db) {
      try { this.db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* non-critical */ }
    }
  }

  private ensureOpen(): Database {
    if (!this.db) throw new Error('Database not open. Call open() first.');
    return this.db;
  }

  /**
   * Move a corrupt DB aside (rename, not delete) and drop a marker file so
   * operators can notice the auto-recovery. JSONL is source of truth, but
   * keeping the corrupt file enables forensic analysis (did WAL tear? disk full?).
   */
  private quarantineCorruptDb(reason: string): void {
    const ts = Date.now();
    const dir = path.dirname(this.config.dbPath);
    const base = path.basename(this.config.dbPath);
    const corruptPath = `${this.config.dbPath}.corrupt.${ts}`;
    const markerPath = path.join(dir, `${base}.corrupt-recovery.${ts}.marker.json`);

    console.warn(`[SemanticMemory] Database corrupt (${reason}) — quarantining to ${corruptPath} and rebuilding`);

    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;

    try {
      if (fs.existsSync(this.config.dbPath)) {
        fs.renameSync(this.config.dbPath, corruptPath);
      }
    } catch (err) {
      // If rename fails (cross-device, permissions), fall back to delete so the rebuild can proceed.
      console.warn(`[SemanticMemory] Could not quarantine corrupt DB (${(err as Error).message}) — falling back to delete`);
      try { SafeFsExecutor.safeUnlinkSync(this.config.dbPath, { operation: 'SemanticMemory.quarantineCorruptDb' }); } catch { /* already gone */ }
    }

    // WAL/SHM are always removed — they're tied to the now-quarantined main file
    // and keeping them around would confuse a fresh DB opened at the same path.
    for (const ext of ['-wal', '-shm']) {
      try { SafeFsExecutor.safeUnlinkSync(this.config.dbPath + ext, { operation: 'SemanticMemory.quarantineCorruptDb:sidecar' }); } catch { /* may not exist */ }
    }

    // Drop a marker file so operators / monitoring can detect the auto-recovery
    // without tailing server logs. Safe to overwrite; safe to ignore if disk full.
    try {
      const marker = {
        event: 'semantic_memory.auto_recovery',
        timestamp: new Date(ts).toISOString(),
        dbPath: this.config.dbPath,
        quarantinedTo: fs.existsSync(corruptPath) ? corruptPath : null,
        reason,
      };
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    } catch {
      // @silent-fallback-ok: marker is a hint for operators; recovery itself already succeeded
    }
  }

  private writeSkippedRebuildMarker(jsonlSize: number, maxBytes: number): void {
    const ts = Date.now();
    const dir = path.dirname(this.config.dbPath);
    const base = path.basename(this.config.dbPath);
    const markerPath = path.join(dir, `${base}.skipped-rebuild.${ts}.marker.json`);
    try {
      fs.writeFileSync(markerPath, JSON.stringify({
        event: 'semantic_memory.skipped_rebuild',
        timestamp: new Date(ts).toISOString(),
        dbPath: this.config.dbPath,
        jsonlPath: this.jsonlPath,
        jsonlSizeBytes: jsonlSize,
        maxAllowedBytes: maxBytes,
        action: 'Started with empty DB — operator should run importFromJsonl() manually',
      }, null, 2));
    } catch {
      // @silent-fallback-ok: marker is advisory
    }
  }

  // ─── JSONL Append Log ─────────────────────────────────────────

  /**
   * Append a mutation record to the JSONL log.
   * This is the source of truth for disaster recovery — if semantic.db
   * is lost, the JSONL can reconstruct the full knowledge graph.
   *
   * Actions: remember, connect, forget, verify, supersede, update, import
   */
  private appendToJournal(action: string, data: Record<string, unknown>): void {
    try {
      const entry = JSON.stringify({ action, timestamp: new Date().toISOString(), ...data });
      fs.appendFileSync(this.jsonlPath, entry + '\n');
    } catch {
      // @silent-fallback-ok: JSONL write failure is non-fatal — DB is still the primary query layer
    }
  }

  // ─── Schema ─────────────────────────────────────────────────────

  private createSchema(): void {
    const db = this.ensureOpen();

    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        last_verified TEXT NOT NULL,
        last_accessed TEXT NOT NULL,
        expires_at TEXT,
        source TEXT NOT NULL,
        source_session TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        domain TEXT,
        owner_id TEXT,
        privacy_scope TEXT DEFAULT 'shared-project'
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        context TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(from_id, to_id, relation)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_entities_confidence ON entities(confidence);
      CREATE INDEX IF NOT EXISTS idx_entities_domain ON entities(domain);
      CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(source);

      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name,
        content,
        tags,
        content='entities',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      -- Triggers to keep FTS in sync with entities table
      CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
        INSERT INTO entities_fts(rowid, name, content, tags)
        VALUES (new.rowid, new.name, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, content, tags)
        VALUES ('delete', old.rowid, old.name, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, content, tags)
        VALUES ('delete', old.rowid, old.name, old.content, old.tags);
        INSERT INTO entities_fts(rowid, name, content, tags)
        VALUES (new.rowid, new.name, new.content, new.tags);
      END;
    `);
  }

  /**
   * Migrate existing databases to add privacy columns.
   * Safe to call repeatedly — checks for column existence first.
   */
  private migrateIfNeeded(): void {
    const db = this.ensureOpen();

    // Check if owner_id column exists
    const columns = db.prepare("PRAGMA table_info(entities)").all() as { name: string }[];
    const columnNames = columns.map(c => c.name);

    if (!columnNames.includes('owner_id')) {
      db.exec(`
        ALTER TABLE entities ADD COLUMN owner_id TEXT;
        ALTER TABLE entities ADD COLUMN privacy_scope TEXT DEFAULT 'shared-project';
      `);
    }

    // Always ensure indexes exist (safe for both fresh and migrated DBs)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_id);
      CREATE INDEX IF NOT EXISTS idx_entities_privacy ON entities(privacy_scope);
    `);
  }

  // ─── Entity CRUD ────────────────────────────────────────────────

  /**
   * Store a knowledge entity. Returns the generated UUID.
   */
  remember(input: {
    type: EntityType;
    name: string;
    content: string;
    confidence: number;
    lastVerified: string;
    source: string;
    sourceSession?: string;
    tags: string[];
    domain?: string;
    expiresAt?: string;
    ownerId?: string;
    privacyScope?: PrivacyScopeType;
  }): string {
    const db = this.ensureOpen();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO entities (id, type, name, content, confidence, created_at, last_verified, last_accessed, expires_at, source, source_session, tags, domain, owner_id, privacy_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.type,
      input.name,
      input.content,
      input.confidence,
      now,
      input.lastVerified,
      now,
      input.expiresAt ?? null,
      input.source,
      input.sourceSession ?? null,
      JSON.stringify(input.tags),
      input.domain ?? null,
      input.ownerId ?? null,
      input.privacyScope ?? 'shared-project',
    );

    // Dual-write to JSONL append log
    this.appendToJournal('remember', {
      entity: {
        id, type: input.type, name: input.name, content: input.content,
        confidence: input.confidence, createdAt: now, lastVerified: input.lastVerified,
        lastAccessed: now, expiresAt: input.expiresAt ?? null,
        source: input.source, sourceSession: input.sourceSession ?? null,
        tags: input.tags, domain: input.domain ?? null,
        ownerId: input.ownerId ?? null, privacyScope: input.privacyScope ?? 'shared-project',
      },
    });

    // Generate embedding asynchronously (fire-and-forget for write performance)
    if (this._vectorAvailable && this.embeddingProvider && this.vectorSearch) {
      const embeddingText = `${input.name} ${input.content}`;
      this.embeddingProvider.embed(embeddingText).then(embedding => {
        if (this.db && this.vectorSearch) {
          this.vectorSearch.upsert(this.db, id, embedding);
        }
      }).catch(() => { // @silent-fallback-ok: embedding failure is non-fatal, FTS5 search still works
      });
    }

    return id;
  }

  /**
   * Store a knowledge entity AND generate its embedding synchronously.
   * Use this when you need the embedding to be available immediately
   * (e.g., during migration or when testing search after insert).
   */
  async rememberWithEmbedding(input: {
    type: EntityType;
    name: string;
    content: string;
    confidence: number;
    lastVerified: string;
    source: string;
    sourceSession?: string;
    tags: string[];
    domain?: string;
    expiresAt?: string;
    ownerId?: string;
    privacyScope?: PrivacyScopeType;
  }): Promise<string> {
    const id = this.remember(input);

    // Wait for embedding to be generated and stored
    if (this._vectorAvailable && this.embeddingProvider && this.vectorSearch) {
      const db = this.ensureOpen();
      const embeddingText = `${input.name} ${input.content}`;
      const embedding = await this.embeddingProvider.embed(embeddingText);
      this.vectorSearch.upsert(db, id, embedding);
    }

    return id;
  }

  /**
   * Retrieve an entity by ID, including its connections.
   * Updates lastAccessed on read.
   */
  recall(id: string): { entity: MemoryEntity; connections: ConnectedEntity[] } | null {
    const db = this.ensureOpen();

    const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined;
    if (!row) return null;

    // Update lastAccessed
    const now = new Date().toISOString();
    db.prepare('UPDATE entities SET last_accessed = ? WHERE id = ?').run(now, id);

    const entity = rowToEntity({ ...row, last_accessed: now });

    // Get connections (both outgoing and incoming)
    const connections = this.getConnections(db, id);

    return { entity, connections };
  }

  /**
   * Delete an entity and all its edges.
   */
  forget(id: string, _reason?: string): void {
    const db = this.ensureOpen();

    // Delete edges first (both directions)
    db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?').run(id, id);
    // Delete embedding if vector search is active
    if (this._vectorAvailable && this.vectorSearch) {
      this.vectorSearch.delete(db, id);
    }
    // Delete entity
    db.prepare('DELETE FROM entities WHERE id = ?').run(id);

    // Dual-write to JSONL
    this.appendToJournal('forget', { entityId: id, reason: _reason ?? null });
  }

  // ─── User-Scoped Queries ────────────────────────────────────────

  /**
   * Get all entities owned by a specific user.
   * Used for GDPR data export (/mydata).
   */
  getEntitiesByUser(userId: string): MemoryEntity[] {
    const db = this.ensureOpen();
    const rows = db.prepare('SELECT * FROM entities WHERE owner_id = ?').all(userId) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /**
   * Delete all entities owned by a specific user and their associated edges.
   * Used for GDPR data erasure (/forget).
   * Returns the number of entities deleted.
   */
  deleteEntitiesByUser(userId: string): number {
    const db = this.ensureOpen();

    // Get IDs of entities to delete
    const ids = db.prepare('SELECT id FROM entities WHERE owner_id = ?').all(userId) as { id: string }[];

    if (ids.length === 0) return 0;

    const deleteEdges = db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?');
    const deleteEntity = db.prepare('DELETE FROM entities WHERE id = ?');

    const runDeletion = db.transaction(() => {
      for (const { id } of ids) {
        deleteEdges.run(id, id);
        if (this._vectorAvailable && this.vectorSearch) {
          this.vectorSearch.delete(db, id);
        }
        deleteEntity.run(id);
      }
    });

    runDeletion();
    return ids.length;
  }

  // ─── Edge CRUD ──────────────────────────────────────────────────

  /**
   * Create a relationship between two entities.
   * Returns the edge ID. Silently returns existing edge ID if duplicate.
   */
  connect(
    fromId: string,
    toId: string,
    relation: RelationType,
    context?: string,
    weight: number = 1.0,
  ): string {
    const db = this.ensureOpen();

    // Check for existing edge with same (from, to, relation)
    const existing = db.prepare(
      'SELECT id FROM edges WHERE from_id = ? AND to_id = ? AND relation = ?'
    ).get(fromId, toId, relation) as { id: string } | undefined;

    if (existing) return existing.id;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO edges (id, from_id, to_id, relation, weight, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, fromId, toId, relation, weight, context ?? null, now);

    // Dual-write to JSONL
    this.appendToJournal('connect', {
      edge: { id, fromId, toId, relation, weight, context: context ?? null, createdAt: now },
    });

    return id;
  }

  // ─── Lookup ─────────────────────────────────────────────────────

  /**
   * Find an entity by its exact source key.
   * Used for deduplication during migration.
   */
  findBySource(source: string): MemoryEntity | null {
    const db = this.ensureOpen();
    const row = db.prepare('SELECT * FROM entities WHERE source = ?').get(source) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  // ─── Search ─────────────────────────────────────────────────────

  /**
   * Full-text search with multi-signal ranking.
   *
   * Without vector search:
   *   Score = (fts5_rank * 0.5) + (confidence * 0.3) + (access * 0.1) + (recency * 0.1)
   *
   * With vector search (hybrid mode):
   *   Score = (fts5_rank * 0.4) + (confidence * 0.3) + (access * 0.1) + (vector_sim * 0.2)
   */
  search(query: string, options?: SemanticSearchOptions): ScoredEntity[] {
    const db = this.ensureOpen();

    const sanitized = sanitizeFts5Query(query);
    if (!sanitized) return [];

    const limit = options?.limit ?? 20;

    // ─── FTS5 results ─────────────────────────────────────────
    let sql = `
      SELECT e.*, entities_fts.rank as fts_rank
      FROM entities_fts
      JOIN entities e ON e.rowid = entities_fts.rowid
      WHERE entities_fts MATCH ?
    `;

    const params: (string | number)[] = [sanitized];

    if (options?.types && options.types.length > 0) {
      const placeholders = options.types.map(() => '?').join(',');
      sql += ` AND e.type IN (${placeholders})`;
      params.push(...options.types);
    }

    if (options?.domain) {
      sql += ` AND e.domain = ?`;
      params.push(options.domain);
    }

    if (options?.minConfidence !== undefined) {
      sql += ` AND e.confidence >= ?`;
      params.push(options.minConfidence);
    }

    // Privacy filtering: if userId is provided, filter by visibility
    if (options?.userId) {
      const privacyFilter = buildPrivacySqlFilter(options.userId, {
        ownerColumn: 'e.owner_id',
        scopeColumn: 'e.privacy_scope',
      });
      sql += ` AND ${privacyFilter.clause}`;
      params.push(...privacyFilter.params);
    }

    sql += ` ORDER BY entities_fts.rank LIMIT ?`;
    params.push(limit * 3); // Fetch extra for re-ranking

    const rows = db.prepare(sql).all(...params) as (EntityRow & { fts_rank: number })[];

    // ─── Vector results (if available) ────────────────────────
    // vectorScores is populated asynchronously via searchHybrid() for callers
    // that need vector scoring. For synchronous search(), we use cached scores
    // from _lastVectorScores if searchHybrid was recently called.
    const vectorScores = this._lastVectorScores;
    const useVectors = this._vectorAvailable && vectorScores !== null && vectorScores.size > 0;

    // ─── Merge & re-rank ──────────────────────────────────────
    const now = Date.now();
    const entityMap = new Map<string, ScoredEntity>();

    for (const row of rows) {
      const entity = rowToEntity(row);
      const ftsScore = 1 / (1 + Math.abs(row.fts_rank));

      const daysSinceAccessed = (now - new Date(entity.lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
      const accessScore = Math.exp(-0.01 * daysSinceAccessed);

      let score: number;
      if (useVectors) {
        const vecSim = vectorScores.get(entity.id) ?? 0;
        score =
          ftsScore * 0.4 +
          entity.confidence * 0.3 +
          accessScore * 0.1 +
          vecSim * 0.2;
      } else {
        const daysSinceVerified = (now - new Date(entity.lastVerified).getTime()) / (1000 * 60 * 60 * 24);
        const recencyScore = Math.exp(-0.02 * daysSinceVerified);
        score =
          ftsScore * 0.5 +
          entity.confidence * 0.3 +
          accessScore * 0.1 +
          recencyScore * 0.1;
      }

      entityMap.set(entity.id, { ...entity, score });
    }

    // If vectors are available, also add vector-only hits (entities found by
    // semantic similarity but missed by FTS5 keyword matching)
    if (useVectors && vectorScores) {
      vectorScores.forEach((vecSim, id) => {
        if (!entityMap.has(id)) {
          const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined;
          if (row) {
            const entity = rowToEntity(row);

            // Apply type/domain/confidence filters
            if (options?.types && options.types.length > 0 && !options.types.includes(entity.type)) return;
            if (options?.domain && entity.domain !== options.domain) return;
            if (options?.minConfidence !== undefined && entity.confidence < options.minConfidence) return;

            const daysSinceAccessed = (now - new Date(entity.lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
            const accessScore = Math.exp(-0.01 * daysSinceAccessed);

            // Vector-only result: no FTS score, so it contributes 0 for text signal
            const score =
              0 +                       // ftsScore * 0.4 = 0 (no keyword match)
              entity.confidence * 0.3 +
              accessScore * 0.1 +
              vecSim * 0.2;

            entityMap.set(entity.id, { ...entity, score });
          }
        }
      });
    }

    const scored = Array.from(entityMap.values());
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // Cached vector scores from the most recent searchHybrid() call
  private _lastVectorScores: Map<string, number> | null = null;

  /**
   * Hybrid search — runs both FTS5 and vector KNN, then merges results.
   * This is the recommended search method when vector search is available.
   *
   * Falls back to FTS5-only search when vectors are not available.
   */
  async searchHybrid(query: string, options?: SemanticSearchOptions): Promise<ScoredEntity[]> {
    if (!this._vectorAvailable || !this.embeddingProvider || !this.vectorSearch) {
      // Graceful degradation: fall back to FTS5-only
      return this.search(query, options);
    }

    const db = this.ensureOpen();
    const limit = options?.limit ?? 20;

    // Generate query embedding
    const queryEmbedding = await this.embeddingProvider.embed(query);

    // Run vector KNN search
    const vecResults = this.vectorSearch.search(db, queryEmbedding, limit * 3);

    // Build vector score map for the search() method to use
    this._lastVectorScores = new Map<string, number>();
    for (const result of vecResults) {
      this._lastVectorScores.set(result.id, result.similarity);
    }

    // Run the combined search (which now picks up vector scores)
    const results = this.search(query, options);

    // Clear cached scores
    this._lastVectorScores = null;

    return results;
  }

  /**
   * Batch-embed all entities that are missing embeddings.
   * Used for migration when enabling vector search on an existing database.
   *
   * @returns Number of entities embedded
   */
  async embedAllEntities(
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    if (!this._vectorAvailable || !this.embeddingProvider || !this.vectorSearch) {
      return 0;
    }

    const db = this.ensureOpen();
    const missingIds = this.vectorSearch.findMissingEmbeddings(db, 'entities');

    if (missingIds.length === 0) return 0;

    let done = 0;
    const batchSize = 32;

    for (let i = 0; i < missingIds.length; i += batchSize) {
      const batchIds = missingIds.slice(i, i + batchSize);
      const batchTexts: string[] = [];

      for (const id of batchIds) {
        const row = db.prepare('SELECT name, content FROM entities WHERE id = ?')
          .get(id) as { name: string; content: string } | undefined;
        if (row) {
          batchTexts.push(`${row.name} ${row.content}`);
        } else {
          batchTexts.push('');
        }
      }

      const embeddings = await this.embeddingProvider.embedBatch(batchTexts);

      const items = batchIds.map((id, idx) => ({
        id,
        embedding: embeddings[idx],
      }));

      this.vectorSearch.upsertBatch(db, items);
      done += batchIds.length;

      if (onProgress) {
        onProgress(done, missingIds.length);
      }
    }

    return done;
  }

  // ─── Confidence Decay ───────────────────────────────────────────

  /**
   * Apply exponential confidence decay to all entities.
   * formula: new_confidence = confidence * exp(-0.693 * days_since_verified / half_life)
   */
  decayAll(): DecayReport {
    const db = this.ensureOpen();

    const rows = db.prepare('SELECT * FROM entities').all() as EntityRow[];
    const now = Date.now();

    let decayed = 0;
    let expired = 0;
    let minConf = Infinity;
    let maxConf = -Infinity;
    let sumConf = 0;

    const update = db.prepare('UPDATE entities SET confidence = ? WHERE id = ?');
    const del = db.prepare('DELETE FROM entities WHERE id = ?');
    const delEdges = db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?');

    const runDecay = db.transaction(() => {
      for (const row of rows) {
        const halfLife = row.type === 'lesson'
          ? this.config.lessonDecayHalfLifeDays
          : this.config.decayHalfLifeDays;

        const daysSinceVerified = (now - new Date(row.last_verified).getTime()) / (1000 * 60 * 60 * 24);
        const newConfidence = row.confidence * Math.exp(-0.693 * daysSinceVerified / halfLife);

        // Check hard expiry
        if (row.expires_at && new Date(row.expires_at).getTime() < now) {
          delEdges.run(row.id, row.id);
          // Clean up embedding if vector search active
          if (this._vectorAvailable && this.vectorSearch) {
            this.vectorSearch.delete(db, row.id);
          }
          del.run(row.id);
          expired++;
          continue;
        }

        if (Math.abs(newConfidence - row.confidence) > 0.001) {
          update.run(newConfidence, row.id);
          decayed++;
          minConf = Math.min(minConf, newConfidence);
          maxConf = Math.max(maxConf, newConfidence);
          sumConf += newConfidence;
        } else {
          minConf = Math.min(minConf, row.confidence);
          maxConf = Math.max(maxConf, row.confidence);
          sumConf += row.confidence;
        }
      }
    });

    runDecay();

    const activeCount = rows.length - expired;

    return {
      entitiesProcessed: rows.length,
      entitiesDecayed: decayed,
      entitiesExpired: expired,
      minConfidence: activeCount > 0 ? minConf : 0,
      maxConfidence: activeCount > 0 ? maxConf : 0,
      avgConfidence: activeCount > 0 ? sumConf / activeCount : 0,
    };
  }

  // ─── Verify ─────────────────────────────────────────────────────

  /**
   * Re-verify an entity, refreshing lastVerified and optionally updating confidence.
   */
  verify(id: string, newConfidence?: number): void {
    const db = this.ensureOpen();
    const now = new Date().toISOString();

    if (newConfidence !== undefined) {
      db.prepare('UPDATE entities SET last_verified = ?, confidence = ? WHERE id = ?')
        .run(now, newConfidence, id);
    } else {
      db.prepare('UPDATE entities SET last_verified = ? WHERE id = ?')
        .run(now, id);
    }

    // Dual-write to JSONL
    this.appendToJournal('verify', { entityId: id, confidence: newConfidence ?? null });
  }

  // ─── Supersede ──────────────────────────────────────────────────

  /**
   * Mark an entity as superseded by a newer one.
   * Creates a 'supersedes' edge and lowers the old entity's confidence.
   */
  supersede(oldId: string, newId: string, reason?: string): void {
    const db = this.ensureOpen();

    // Create supersedes edge (new -> old) — connect() already journals the edge
    this.connect(newId, oldId, 'supersedes', reason);

    // Lower old entity's confidence by half
    const old = db.prepare('SELECT confidence FROM entities WHERE id = ?').get(oldId) as { confidence: number } | undefined;
    if (old) {
      const newConf = old.confidence * 0.5;
      db.prepare('UPDATE entities SET confidence = ? WHERE id = ?')
        .run(newConf, oldId);

      // Dual-write to JSONL
      this.appendToJournal('supersede', { oldId, newId, newConfidence: newConf, reason: reason ?? null });
    }
  }

  // ─── Graph Traversal ───────────────────────────────────────────

  /**
   * BFS graph traversal from a starting entity.
   * Returns all reachable entities (excluding the start) up to maxDepth.
   */
  explore(startId: string, options?: ExploreOptions): MemoryEntity[] {
    const db = this.ensureOpen();
    const maxDepth = options?.maxDepth ?? 2;
    const relations = options?.relations;
    const minWeight = options?.minWeight ?? 0;

    const visited = new Set<string>([startId]);
    const result: MemoryEntity[] = [];
    let frontier = [startId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        // Get outgoing edges
        let outgoing = db.prepare('SELECT * FROM edges WHERE from_id = ?').all(nodeId) as EdgeRow[];
        // Get incoming edges
        let incoming = db.prepare('SELECT * FROM edges WHERE to_id = ?').all(nodeId) as EdgeRow[];

        // Filter by relation type
        if (relations) {
          outgoing = outgoing.filter(e => relations.includes(e.relation as RelationType));
          incoming = incoming.filter(e => relations.includes(e.relation as RelationType));
        }

        // Filter by weight
        if (minWeight > 0) {
          outgoing = outgoing.filter(e => e.weight >= minWeight);
          incoming = incoming.filter(e => e.weight >= minWeight);
        }

        // Process outgoing: neighbor is the "to" end
        for (const edge of outgoing) {
          if (!visited.has(edge.to_id)) {
            visited.add(edge.to_id);
            const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(edge.to_id) as EntityRow | undefined;
            if (row) {
              result.push(rowToEntity(row));
              nextFrontier.push(edge.to_id);
            }
          }
        }

        // Process incoming: neighbor is the "from" end
        for (const edge of incoming) {
          if (!visited.has(edge.from_id)) {
            visited.add(edge.from_id);
            const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(edge.from_id) as EntityRow | undefined;
            if (row) {
              result.push(rowToEntity(row));
              nextFrontier.push(edge.from_id);
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    return result;
  }

  // ─── Stale Detection ───────────────────────────────────────────

  /**
   * Find entities that are stale (low confidence or old).
   */
  findStale(options?: {
    maxConfidence?: number;
    olderThan?: string;
    limit?: number;
  }): MemoryEntity[] {
    const db = this.ensureOpen();
    const limit = options?.limit ?? 50;

    let sql = 'SELECT * FROM entities WHERE 1=1';
    const params: (string | number)[] = [];

    if (options?.maxConfidence !== undefined) {
      sql += ' AND confidence <= ?';
      params.push(options.maxConfidence);
    }

    if (options?.olderThan) {
      sql += ' AND last_verified < ?';
      params.push(options.olderThan);
    }

    sql += ' ORDER BY confidence ASC, last_verified ASC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as EntityRow[];
    return rows.map(rowToEntity);
  }

  // ─── Export / Import ───────────────────────────────────────────

  /**
   * Export all entities and edges as a JSON-serializable structure.
   */
  export(): { entities: MemoryEntity[]; edges: MemoryEdge[] } {
    const db = this.ensureOpen();

    const entityRows = db.prepare('SELECT * FROM entities').all() as EntityRow[];
    const edgeRows = db.prepare('SELECT * FROM edges').all() as EdgeRow[];

    return {
      entities: entityRows.map(rowToEntity),
      edges: edgeRows.map(rowToEdge),
    };
  }

  /**
   * Import entities and edges, skipping duplicates by ID.
   */
  import(data: { entities: MemoryEntity[]; edges: MemoryEdge[] }): ImportReport {
    const db = this.ensureOpen();

    let entitiesImported = 0;
    let edgesImported = 0;
    let entitiesSkipped = 0;
    let edgesSkipped = 0;

    const insertEntity = db.prepare(`
      INSERT INTO entities (id, type, name, content, confidence, created_at, last_verified, last_accessed, expires_at, source, source_session, tags, domain, owner_id, privacy_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertEdge = db.prepare(`
      INSERT INTO edges (id, from_id, to_id, relation, weight, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const checkEntity = db.prepare('SELECT id FROM entities WHERE id = ?');
    const checkEdge = db.prepare('SELECT id FROM edges WHERE id = ?');

    const runImport = db.transaction(() => {
      for (const entity of data.entities) {
        if (checkEntity.get(entity.id)) {
          entitiesSkipped++;
          continue;
        }

        insertEntity.run(
          entity.id,
          entity.type,
          entity.name,
          entity.content,
          entity.confidence,
          entity.createdAt,
          entity.lastVerified,
          entity.lastAccessed,
          entity.expiresAt ?? null,
          entity.source,
          entity.sourceSession ?? null,
          JSON.stringify(entity.tags),
          entity.domain ?? null,
          entity.ownerId ?? null,
          entity.privacyScope ?? 'shared-project',
        );
        entitiesImported++;
      }

      for (const edge of data.edges) {
        if (checkEdge.get(edge.id)) {
          edgesSkipped++;
          continue;
        }

        insertEdge.run(
          edge.id,
          edge.fromId,
          edge.toId,
          edge.relation,
          edge.weight,
          edge.context ?? null,
          edge.createdAt,
        );
        edgesImported++;
      }
    });

    runImport();

    // Journal all successfully imported items (count-based — we know exactly how many were new)
    if (entitiesImported > 0 || edgesImported > 0) {
      this.appendToJournal('import', {
        entitiesImported, edgesImported, entitiesSkipped, edgesSkipped,
      });
    }

    return { entitiesImported, edgesImported, entitiesSkipped, edgesSkipped };
  }

  // ─── JSONL Rebuild (Disaster Recovery) ─────────────────────────

  /**
   * Import entities and edges from the JSONL append log.
   * Replays all 'remember' and 'connect' actions, skipping duplicates.
   * Applies 'forget' actions to remove deleted entities.
   * Returns the number of entities and edges recovered.
   *
   * Follows TopicMemory's resilience pattern: JSONL is source of truth,
   * SQLite is derived query layer that can be rebuilt at any time.
   */
  importFromJsonl(jsonlPath?: string): { entities: number; edges: number; forgotten: number } {
    const db = this.ensureOpen();
    const logPath = jsonlPath ?? this.jsonlPath;

    if (!fs.existsSync(logPath)) return { entities: 0, edges: 0, forgotten: 0 };

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    let entities = 0;
    let edges = 0;
    let forgotten = 0;

    const insertEntity = db.prepare(`
      INSERT OR IGNORE INTO entities (id, type, name, content, confidence, created_at, last_verified, last_accessed, expires_at, source, source_session, tags, domain, owner_id, privacy_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertEdge = db.prepare(`
      INSERT OR IGNORE INTO edges (id, from_id, to_id, relation, weight, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteEntity = db.prepare('DELETE FROM entities WHERE id = ?');
    const deleteEdges = db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?');

    const updateVerify = db.prepare('UPDATE entities SET last_verified = ?, confidence = COALESCE(?, confidence) WHERE id = ?');

    const runReplay = db.transaction(() => {
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          switch (entry.action) {
            case 'remember': {
              const e = entry.entity;
              if (!e?.id) break;
              const result = insertEntity.run(
                e.id, e.type, e.name, e.content, e.confidence,
                e.createdAt, e.lastVerified, e.lastAccessed,
                e.expiresAt ?? null, e.source, e.sourceSession ?? null,
                JSON.stringify(e.tags ?? []), e.domain ?? null,
                e.ownerId ?? null, e.privacyScope ?? 'shared-project',
              );
              if (result.changes > 0) entities++;
              break;
            }

            case 'connect': {
              const edge = entry.edge;
              if (!edge?.id) break;
              const result = insertEdge.run(
                edge.id, edge.fromId, edge.toId, edge.relation,
                edge.weight ?? 1.0, edge.context ?? null, edge.createdAt,
              );
              if (result.changes > 0) edges++;
              break;
            }

            case 'forget': {
              const id = entry.entityId;
              if (!id) break;
              deleteEdges.run(id, id);
              const result = deleteEntity.run(id);
              if (result.changes > 0) forgotten++;
              break;
            }

            case 'verify': {
              const id = entry.entityId;
              if (!id) break;
              updateVerify.run(entry.timestamp, entry.confidence ?? null, id);
              break;
            }

            case 'supersede': {
              // supersede journals are informational — the actual connect + confidence
              // update are replayed from their own journal entries
              break;
            }
          }
        } catch { /* @silent-fallback-ok — skip corrupted JSONL lines */ }
      }
    });

    runReplay();

    // Rebuild FTS5 index to match recovered data
    try {
      db.exec(`INSERT INTO entities_fts(entities_fts) VALUES ('rebuild')`);
    } catch { /* @silent-fallback-ok — FTS rebuild non-critical */ }

    return { entities, edges, forgotten };
  }

  /**
   * Full rebuild — drop all entities and edges, rebuild from JSONL.
   * This is the nuclear option for disaster recovery.
   *
   * Preserves the JSONL log (source of truth) and rebuilds SQLite from it.
   */
  rebuild(jsonlPath?: string): { entities: number; edges: number; forgotten: number } {
    const db = this.ensureOpen();

    db.exec('DELETE FROM edges');
    db.exec('DELETE FROM entities');
    db.exec(`INSERT INTO entities_fts(entities_fts) VALUES ('rebuild')`);

    // Delete vector embeddings if available (they'll be regenerated)
    if (this._vectorAvailable) {
      try {
        db.exec('DELETE FROM entity_embeddings');
      } catch { /* @silent-fallback-ok — vector table may not exist */ }
    }

    return this.importFromJsonl(jsonlPath);
  }

  /**
   * Write a full JSON snapshot to disk for periodic backup.
   * This is a point-in-time export that complements the JSONL append log.
   */
  writeSnapshot(snapshotPath?: string): { path: string; entities: number; edges: number; sizeBytes: number } {
    const data = this.export();
    const outPath = snapshotPath ?? this.config.dbPath.replace(/\.db$/, '-snapshot.json');

    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(outPath, json, 'utf-8');

    return {
      path: outPath,
      entities: data.entities.length,
      edges: data.edges.length,
      sizeBytes: Buffer.byteLength(json),
    };
  }

  // ─── Statistics ─────────────────────────────────────────────────

  /**
   * Get aggregate statistics about the memory store.
   */
  stats(): SemanticMemoryStats {
    const db = this.ensureOpen();

    const entityCount = (db.prepare('SELECT COUNT(*) as cnt FROM entities').get() as { cnt: number }).cnt;
    const edgeCount = (db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as { cnt: number }).cnt;

    // Count by type
    const typeCounts = db.prepare('SELECT type, COUNT(*) as cnt FROM entities GROUP BY type').all() as { type: string; cnt: number }[];
    const entityCountsByType: Record<string, number> = {};
    for (const row of typeCounts) {
      entityCountsByType[row.type] = row.cnt;
    }

    // Avg confidence
    const avgRow = db.prepare('SELECT AVG(confidence) as avg FROM entities').get() as { avg: number | null };
    const avgConfidence = avgRow.avg ?? 0;

    // Stale count
    const staleCount = (db.prepare('SELECT COUNT(*) as cnt FROM entities WHERE confidence < ?').get(this.config.staleThreshold) as { cnt: number }).cnt;

    // DB file size
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.statSync(this.config.dbPath).size;
    } catch {
      // File may not exist yet  @silent-fallback-ok: stat before DB fully flushed
    }

    // Vector search stats
    let embeddingCount = 0;
    if (this._vectorAvailable && this.vectorSearch) {
      try {
        embeddingCount = this.vectorSearch.count(db);
      } catch { // @silent-fallback-ok: vec0 table may not be queryable, report 0 embeddings
      }
    }

    return {
      totalEntities: entityCount,
      totalEdges: edgeCount,
      entityCountsByType: entityCountsByType as Record<EntityType, number>,
      avgConfidence: Math.round(avgConfidence * 100) / 100, // Round to 2 decimal places
      staleCount,
      dbSizeBytes,
      vectorSearchAvailable: this._vectorAvailable,
      embeddingCount,
    };
  }

  // ─── Context Generation ─────────────────────────────────────────

  /**
   * Generate formatted markdown context for a query, suitable for session injection.
   * Returns empty string if no relevant entities found.
   */
  getRelevantContext(
    query: string,
    options?: { maxTokens?: number; limit?: number; userId?: string },
  ): string {
    const maxTokens = options?.maxTokens ?? 2000;
    const limit = options?.limit ?? 10;

    const results = this.search(query, { limit, userId: options?.userId });
    if (results.length === 0) return '';

    const lines: string[] = [];
    let estimatedTokens = 0;

    for (const entity of results) {
      const entry = `### ${entity.name} (${entity.type})\n${entity.content}\n`;
      // Rough token estimate: ~0.75 tokens per word
      const entryTokens = entry.split(/\s+/).length / 0.75;

      if (estimatedTokens + entryTokens > maxTokens) break;

      lines.push(entry);
      estimatedTokens += entryTokens;
    }

    return lines.join('\n');
  }

  // ─── Private Helpers ───────────────────────────────────────────

  private getConnections(db: Database, entityId: string): ConnectedEntity[] {
    const connections: ConnectedEntity[] = [];

    // Outgoing edges — use explicit column aliases to avoid JOIN collisions
    const outgoing = db.prepare(`
      SELECT
        e.id as edge_id, e.from_id, e.to_id, e.relation, e.weight,
        e.context as edge_context, e.created_at as edge_created_at,
        ent.id as ent_id, ent.type, ent.name, ent.content, ent.confidence,
        ent.created_at as ent_created_at, ent.last_verified, ent.last_accessed,
        ent.expires_at, ent.source, ent.source_session, ent.tags, ent.domain,
        ent.owner_id, ent.privacy_scope
      FROM edges e
      JOIN entities ent ON ent.id = e.to_id
      WHERE e.from_id = ?
    `).all(entityId) as JoinRow[];

    for (const row of outgoing) {
      connections.push({
        entity: joinRowToEntity(row),
        edge: joinRowToEdge(row),
        direction: 'outgoing',
      });
    }

    // Incoming edges
    const incoming = db.prepare(`
      SELECT
        e.id as edge_id, e.from_id, e.to_id, e.relation, e.weight,
        e.context as edge_context, e.created_at as edge_created_at,
        ent.id as ent_id, ent.type, ent.name, ent.content, ent.confidence,
        ent.created_at as ent_created_at, ent.last_verified, ent.last_accessed,
        ent.expires_at, ent.source, ent.source_session, ent.tags, ent.domain,
        ent.owner_id, ent.privacy_scope
      FROM edges e
      JOIN entities ent ON ent.id = e.from_id
      WHERE e.to_id = ?
    `).all(entityId) as JoinRow[];

    for (const row of incoming) {
      connections.push({
        entity: joinRowToEntity(row),
        edge: joinRowToEdge(row),
        direction: 'incoming',
      });
    }

    return connections;
  }
}

// ─── Row Types ──────────────────────────────────────────────────

interface EntityRow {
  id: string;
  type: string;
  name: string;
  content: string;
  confidence: number;
  created_at: string;
  last_verified: string;
  last_accessed: string;
  expires_at: string | null;
  source: string;
  source_session: string | null;
  tags: string;
  domain: string | null;
  owner_id: string | null;
  privacy_scope: string | null;
  rowid?: number;
}

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  relation: string;
  weight: number;
  context: string | null;
  created_at: string;
}

/** Row from a JOIN query with explicit column aliases */
interface JoinRow {
  edge_id: string;
  from_id: string;
  to_id: string;
  relation: string;
  weight: number;
  edge_context: string | null;
  edge_created_at: string;
  ent_id: string;
  type: string;
  name: string;
  content: string;
  confidence: number;
  ent_created_at: string;
  last_verified: string;
  last_accessed: string;
  expires_at: string | null;
  source: string;
  source_session: string | null;
  tags: string;
  domain: string | null;
  owner_id: string | null;
  privacy_scope: string | null;
}

// ─── Converters ─────────────────────────────────────────────────

function rowToEntity(row: EntityRow): MemoryEntity {
  return {
    id: row.id,
    type: row.type as EntityType,
    name: row.name,
    content: row.content,
    confidence: row.confidence,
    createdAt: row.created_at,
    lastVerified: row.last_verified,
    lastAccessed: row.last_accessed,
    expiresAt: row.expires_at ?? undefined,
    source: row.source,
    sourceSession: row.source_session ?? undefined,
    tags: JSON.parse(row.tags),
    domain: row.domain ?? undefined,
    ownerId: row.owner_id ?? undefined,
    privacyScope: (row.privacy_scope as PrivacyScopeType) ?? undefined,
  };
}

function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation as RelationType,
    weight: row.weight,
    context: row.context ?? undefined,
    createdAt: row.created_at,
  };
}

/** Convert a JOIN row (with explicit aliases) to a MemoryEntity */
function joinRowToEntity(row: JoinRow): MemoryEntity {
  return {
    id: row.ent_id,
    type: row.type as EntityType,
    name: row.name,
    content: row.content,
    confidence: row.confidence,
    createdAt: row.ent_created_at,
    lastVerified: row.last_verified,
    lastAccessed: row.last_accessed,
    expiresAt: row.expires_at ?? undefined,
    source: row.source,
    sourceSession: row.source_session ?? undefined,
    tags: JSON.parse(row.tags),
    domain: row.domain ?? undefined,
    ownerId: row.owner_id ?? undefined,
    privacyScope: (row.privacy_scope as PrivacyScopeType) ?? undefined,
  };
}

/** Convert a JOIN row (with explicit aliases) to a MemoryEdge */
function joinRowToEdge(row: JoinRow): MemoryEdge {
  return {
    id: row.edge_id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation as RelationType,
    weight: row.weight,
    context: row.edge_context ?? undefined,
    createdAt: row.edge_created_at,
  };
}
