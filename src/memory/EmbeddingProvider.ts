/**
 * EmbeddingProvider — Shared local embedding service using Transformers.js (ONNX).
 *
 * Loads all-MiniLM-L6-v2 (384-dim) once and provides embeddings to any memory
 * system (SemanticMemory, TopicMemory). Also handles loading the
 * sqlite-vec extension into better-sqlite3 connections.
 *
 * Design decisions:
 *   - Singleton: Model (~80MB) is loaded once, shared across all consumers
 *   - Lazy init: Model downloads on first embed() call, not on construction
 *   - Graceful degradation: If model fails to load, embed() throws but callers
 *     can catch and fall back to FTS5-only search
 *   - Batch support: embedBatch() is more efficient than sequential embed() calls
 */

type Database = import('better-sqlite3').Database;

export interface EmbeddingProviderConfig {
  /** Model name for @huggingface/transformers (default: 'Xenova/all-MiniLM-L6-v2') */
  modelName?: string;
  /** Embedding dimension (default: 384 for all-MiniLM-L6-v2) */
  dimensions?: number;
  /** Maximum text length to embed in characters (default: 8192) */
  maxTextLength?: number;
}

export class EmbeddingProvider {
  private pipeline: any = null;
  private loading: Promise<void> | null = null;
  private readonly modelName: string;
  readonly dimensions: number;
  private readonly maxTextLength: number;
  private vecExtensionLoaded = new WeakSet<object>();

  constructor(config?: EmbeddingProviderConfig) {
    this.modelName = config?.modelName ?? 'Xenova/all-MiniLM-L6-v2';
    this.dimensions = config?.dimensions ?? 384;
    this.maxTextLength = config?.maxTextLength ?? 8192;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  /**
   * Ensure the model is loaded. Safe to call multiple times — only loads once.
   */
  async initialize(): Promise<void> {
    if (this.pipeline) return;
    if (this.loading) {
      await this.loading;
      return;
    }

    this.loading = this.loadModel();
    await this.loading;
  }

  private async loadModel(): Promise<void> {
    const { pipeline: createPipeline } = await import('@huggingface/transformers');
    this.pipeline = await createPipeline('feature-extraction', this.modelName, {
      dtype: 'fp32',
    });
  }

  /**
   * Whether the model is loaded and ready for embedding.
   */
  get isReady(): boolean {
    return this.pipeline !== null;
  }

  // ─── Embedding ──────────────────────────────────────────────────

  /**
   * Generate a normalized embedding for a single text string.
   * Lazy-initializes the model on first call.
   */
  async embed(text: string): Promise<Float32Array> {
    await this.initialize();

    const truncated = text.slice(0, this.maxTextLength);
    const output = await this.pipeline(truncated, {
      pooling: 'mean',
      normalize: true,
    });

    // output.data is a Float32Array from the ONNX model
    return new Float32Array(output.data);
  }

  /**
   * Generate normalized embeddings for multiple texts.
   * More efficient than sequential embed() calls for large batches.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await this.embed(texts[0])];

    await this.initialize();

    const truncated = texts.map(t => t.slice(0, this.maxTextLength));
    const results: Float32Array[] = [];

    // Process in batches of 32 to avoid memory pressure
    const batchSize = 32;
    for (let i = 0; i < truncated.length; i += batchSize) {
      const batch = truncated.slice(i, i + batchSize);
      for (const text of batch) {
        const output = await this.pipeline(text, {
          pooling: 'mean',
          normalize: true,
        });
        results.push(new Float32Array(output.data));
      }
    }

    return results;
  }

  // ─── sqlite-vec Extension ───────────────────────────────────────

  /**
   * Load the sqlite-vec extension into a better-sqlite3 database connection.
   * Safe to call multiple times on the same connection — tracks loaded state.
   *
   * @returns true if loaded successfully, false if sqlite-vec unavailable
   */
  loadVecExtension(db: Database): boolean {
    // Use db object identity to track whether extension is already loaded
    if (this.vecExtensionLoaded.has(db as any)) return true;

    // sqlite-vec must be pre-loaded via loadVecExtensionAsync() first
    if (!this._sqliteVecModule) return false;

    try {
      this._sqliteVecModule.load(db);
      this.vecExtensionLoaded.add(db as any);
      return true;
    } catch { // @silent-fallback-ok: graceful degradation to FTS5-only when sqlite-vec fails
      return false;
    }
  }

  private _sqliteVecModule: { load: (db: any) => void } | null = null;

  /**
   * Pre-load the sqlite-vec module. Must be called before loadVecExtension().
   * Safe to call multiple times — only loads once.
   *
   * @returns true if sqlite-vec is available, false if not installed
   */
  async loadVecModule(): Promise<boolean> {
    if (this._sqliteVecModule) return true;

    try {
      const mod = await import('sqlite-vec');
      this._sqliteVecModule = mod;
      return true;
    } catch { // @silent-fallback-ok: sqlite-vec is optional dependency, FTS5-only when not installed
      return false;
    }
  }

  // ─── Utilities ──────────────────────────────────────────────────

  /**
   * Serialize a Float32Array to a Buffer for sqlite-vec storage.
   * sqlite-vec expects embeddings as raw binary blobs.
   */
  static toBuffer(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }

  /**
   * Deserialize a Buffer back to a Float32Array.
   */
  static fromBuffer(buffer: Buffer): Float32Array {
    const copy = new ArrayBuffer(buffer.length);
    const view = new Uint8Array(copy);
    view.set(buffer);
    return new Float32Array(copy);
  }

  /**
   * Compute cosine similarity between two embeddings.
   * Assumes both are already L2-normalized (as produced by embed()).
   */
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }
}
