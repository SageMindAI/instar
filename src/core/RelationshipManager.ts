/**
 * RelationshipManager — Core system for tracking everyone the agent interacts with.
 *
 * Relationships are fundamental, not a plugin. Same tier as identity and memory.
 * Every person the agent interacts with — across any channel/platform — gets a
 * relationship record that grows over time.
 *
 * Architecture:
 * - One JSON file per person in .instar/relationships/
 * - Cross-platform identity resolution via channel index
 * - Auto-enrichment from every interaction
 * - Context injection before any interaction with a known person
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
  RelationshipRecord,
  RelationshipManagerConfig,
  IntelligenceProvider,
  InteractionSummary,
  UserChannel,
} from './types.js';

/** Maximum number of channels per relationship record. */
const MAX_CHANNELS = 50;
/** Maximum length of notes field. */
const MAX_NOTES_LENGTH = 10_000;

export class RelationshipManager {
  private relationships: Map<string, RelationshipRecord> = new Map();
  /** Maps "channel_type:identifier" -> relationship ID for cross-platform resolution */
  private channelIndex: Map<string, string> = new Map();
  /** Maps normalized name -> set of relationship IDs for fuzzy name resolution */
  private nameIndex: Map<string, Set<string>> = new Map();
  private config: RelationshipManagerConfig;

  constructor(config: RelationshipManagerConfig) {
    this.config = config;
    if (!existsSync(config.relationshipsDir)) {
      mkdirSync(config.relationshipsDir, { recursive: true });
    }
    this.loadAll();
  }

  /** Normalize a name for fuzzy matching: lowercase, trim, collapse whitespace, strip leading @ */
  private normalizeName(name: string): string {
    return name.trim().toLowerCase().replace(/^@/, '').replace(/[\s_-]+/g, ' ');
  }

  /** Add a record to the name index */
  private indexName(id: string, name: string): void {
    const key = this.normalizeName(name);
    if (!key) return;
    let ids = this.nameIndex.get(key);
    if (!ids) {
      ids = new Set();
      this.nameIndex.set(key, ids);
    }
    ids.add(id);
  }

  /** Remove a record from the name index */
  private unindexName(id: string, name: string): void {
    const key = this.normalizeName(name);
    const ids = this.nameIndex.get(key);
    if (ids) {
      ids.delete(id);
      if (ids.size === 0) this.nameIndex.delete(key);
    }
  }

  /** Validate a record ID is a valid UUID format to prevent path traversal. */
  private validateId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new Error(`RelationshipManager: invalid record ID format: ${id}`);
    }
  }

  // ── Core Operations ────────────────────────────────────────────────

  /**
   * Find or create a relationship from an incoming interaction.
   * Resolves cross-platform: if the same person messages from Telegram and email,
   * this returns the same relationship.
   */
  findOrCreate(name: string, channel: UserChannel): RelationshipRecord {
    const channelKey = `${channel.type}:${channel.identifier}`;

    // Try to resolve by channel first (strongest signal)
    const existingId = this.channelIndex.get(channelKey);
    if (existingId) {
      const existing = this.relationships.get(existingId);
      if (existing) return existing;
      // Channel index is stale — clean it up and fall through
      this.channelIndex.delete(channelKey);
    }

    // Try name resolution before creating (prevents ColonistOne-style duplicates)
    const nameMatches = this.resolveByName(name);
    if (nameMatches.length === 1) {
      // Unambiguous name match — link the new channel and return
      const match = nameMatches[0];
      this.linkChannel(match.id, channel);
      return match;
    }

    // Create new relationship (no match, or ambiguous name)
    const now = new Date().toISOString();
    const record: RelationshipRecord = {
      id: randomUUID(),
      name,
      channels: [channel],
      firstInteraction: now,
      lastInteraction: now,
      interactionCount: 0,
      themes: [],
      notes: '',
      significance: 1,
      recentInteractions: [],
    };

    this.relationships.set(record.id, record);
    this.channelIndex.set(channelKey, record.id);
    this.indexName(record.id, name);
    this.save(record);
    return record;
  }

  /**
   * LLM-supervised version of findOrCreate.
   * When an intelligence provider is configured:
   * - Heuristics narrow candidates (channel match, name match)
   * - LLM confirms ambiguous name matches before linking
   * - LLM can detect matches that string heuristics miss
   *
   * Falls back to sync findOrCreate when no provider is available.
   */
  async findOrCreateAsync(name: string, channel: UserChannel): Promise<RelationshipRecord> {
    const intelligence = this.config.intelligence;

    // Channel match is always definitive — no LLM needed
    const channelKey = `${channel.type}:${channel.identifier}`;
    const existingId = this.channelIndex.get(channelKey);
    if (existingId) {
      const existing = this.relationships.get(existingId);
      if (existing) return existing;
      this.channelIndex.delete(channelKey);
    }

    // Name-based candidates (heuristic pre-filter)
    const nameMatches = this.resolveByName(name);

    if (nameMatches.length === 1 && !intelligence) {
      // No LLM, unambiguous match — link directly (sync behavior)
      const match = nameMatches[0];
      this.linkChannel(match.id, channel);
      return match;
    }

    if (nameMatches.length >= 1 && intelligence) {
      // LLM confirms: is this new interaction from one of the existing people?
      const confirmed = await this.askIdentityMatch(intelligence, name, channel, nameMatches);
      if (confirmed) {
        this.linkChannel(confirmed.id, channel);
        return confirmed;
      }
    }

    // Create new (no match, or LLM said no match)
    const now = new Date().toISOString();
    const record: RelationshipRecord = {
      id: randomUUID(),
      name,
      channels: [channel],
      firstInteraction: now,
      lastInteraction: now,
      interactionCount: 0,
      themes: [],
      notes: '',
      significance: 1,
      recentInteractions: [],
    };

    this.relationships.set(record.id, record);
    this.channelIndex.set(channelKey, record.id);
    this.indexName(record.id, name);
    this.save(record);
    return record;
  }

  /**
   * LLM-supervised duplicate detection.
   * Runs heuristic findDuplicates() first, then asks the LLM to confirm
   * each candidate group. Returns only LLM-confirmed duplicates.
   *
   * Falls back to heuristic-only when no provider is available.
   */
  async findDuplicatesAsync(): Promise<Array<{ records: RelationshipRecord[]; reason: string; confirmed: boolean }>> {
    const candidates = this.findDuplicates();
    const intelligence = this.config.intelligence;

    if (!intelligence) {
      return candidates.map((g) => ({ ...g, confirmed: false }));
    }

    const results: Array<{ records: RelationshipRecord[]; reason: string; confirmed: boolean }> = [];

    for (const group of candidates) {
      const confirmed = await this.askDuplicateConfirmation(intelligence, group.records, group.reason);
      results.push({ ...group, confirmed });
    }

    return results;
  }

  // ── LLM Intelligence Prompts ────────────────────────────────────────

  /**
   * Ask the LLM whether a new name+channel belongs to one of the candidate records.
   * Returns the matching record, or null if the LLM says it's a new person.
   */
  private async askIdentityMatch(
    intelligence: IntelligenceProvider,
    name: string,
    channel: UserChannel,
    candidates: RelationshipRecord[],
  ): Promise<RelationshipRecord | null> {
    const candidateDescriptions = candidates.map((r, i) => {
      const channels = r.channels.map((c) => `${c.type}:${c.identifier}`).join(', ');
      const themes = r.themes.slice(0, 5).join(', ') || 'none';
      return `[${i}] "${r.name}" — channels: ${channels} — themes: ${themes} — interactions: ${r.interactionCount}`;
    }).join('\n');

    const prompt = `You are an identity resolution system. Determine if a new interaction belongs to an existing person.

New interaction:
- Name: "${name}"
- Channel: ${channel.type}:${channel.identifier}

Existing candidates:
${candidateDescriptions}

Does the new interaction belong to one of these existing people? Consider:
- Name similarity (case, spacing, special characters, abbreviations)
- Platform conventions (same person may use different handles across platforms)
- When uncertain, prefer creating a new record over a false merge

Respond with ONLY one of:
- MATCH:N (where N is the candidate index, e.g., MATCH:0)
- NEW (if this is a different person)`;

    try {
      const response = await intelligence.evaluate(prompt, { model: 'fast', maxTokens: 20, temperature: 0 });
      const trimmed = response.trim().toUpperCase();

      const matchResult = trimmed.match(/^MATCH:(\d+)/);
      if (matchResult) {
        const index = parseInt(matchResult[1], 10);
        if (index >= 0 && index < candidates.length) {
          return candidates[index];
        }
      }

      // LLM explicitly said NEW — respect the decision
      if (trimmed.startsWith('NEW')) {
        return null;
      }
    } catch {
      // @silent-fallback-ok — LLM fallback to heuristic
    }

    // Default to heuristic: single unambiguous match → link, else new
    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * Ask the LLM to confirm whether a group of records are truly duplicates.
   */
  private async askDuplicateConfirmation(
    intelligence: IntelligenceProvider,
    records: RelationshipRecord[],
    reason: string,
  ): Promise<boolean> {
    const descriptions = records.map((r, i) => {
      const channels = r.channels.map((c) => `${c.type}:${c.identifier}`).join(', ');
      const themes = r.themes.slice(0, 5).join(', ') || 'none';
      return `[${i}] "${r.name}" — channels: ${channels} — themes: ${themes} — notes: ${(r.notes || '').slice(0, 100)}`;
    }).join('\n');

    const prompt = `You are an identity resolution system. Determine if these relationship records represent the same person.

Flagged reason: ${reason}

Records:
${descriptions}

Are these the same person? Consider:
- Same name with different formatting is likely the same person
- Different names on different platforms could be the same person if context aligns
- Different themes/topics alone don't mean different people
- When uncertain, say NO to avoid false merges

Respond with ONLY: YES or NO`;

    try {
      const response = await intelligence.evaluate(prompt, { model: 'fast', maxTokens: 10, temperature: 0 });
      return response.trim().toUpperCase().startsWith('YES');
    } catch {
      // @silent-fallback-ok — fail-closed on LLM error
      return false;
    }
  }

  /**
   * Resolve a channel identifier to an existing relationship, or null.
   */
  resolveByChannel(channel: UserChannel): RelationshipRecord | null {
    const channelKey = `${channel.type}:${channel.identifier}`;
    const id = this.channelIndex.get(channelKey);
    return id ? this.relationships.get(id) ?? null : null;
  }

  /**
   * Resolve by name using fuzzy matching. Returns all matches.
   * Handles: case differences, leading @, underscores vs hyphens vs spaces.
   * Port of Portal's _find_existing_person() pattern.
   */
  resolveByName(name: string): RelationshipRecord[] {
    const key = this.normalizeName(name);
    if (!key) return [];

    const results: RelationshipRecord[] = [];
    const seen = new Set<string>();

    // Exact normalized match
    const exactIds = this.nameIndex.get(key);
    if (exactIds) {
      for (const id of exactIds) {
        const r = this.relationships.get(id);
        if (r && !seen.has(id)) {
          results.push(r);
          seen.add(id);
        }
      }
    }

    // Collapsed match (remove all separators): catches "ColonistOne" vs "colonist one"
    const collapsed = key.replace(/\s/g, '');
    for (const [indexKey, ids] of this.nameIndex) {
      if (indexKey.replace(/\s/g, '') === collapsed) {
        for (const id of ids) {
          if (!seen.has(id)) {
            const r = this.relationships.get(id);
            if (r) {
              results.push(r);
              seen.add(id);
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Get a relationship by ID.
   */
  get(id: string): RelationshipRecord | null {
    return this.relationships.get(id) ?? null;
  }

  /**
   * Get all relationships, optionally sorted by significance or recency.
   */
  getAll(sortBy: 'significance' | 'recent' | 'name' = 'significance'): RelationshipRecord[] {
    const all = Array.from(this.relationships.values());
    switch (sortBy) {
      case 'significance':
        return all.sort((a, b) => b.significance - a.significance);
      case 'recent':
        return all.sort((a, b) => b.lastInteraction.localeCompare(a.lastInteraction));
      case 'name':
        return all.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  /**
   * Detect potential duplicate relationships that could be merged.
   * Port of Portal's find_potential_duplicates() pattern.
   * Returns groups of records that likely represent the same person,
   * with a reason string explaining why they were flagged.
   */
  findDuplicates(): Array<{ records: RelationshipRecord[]; reason: string }> {
    const groups: Array<{ records: RelationshipRecord[]; reason: string }> = [];
    const seen = new Set<string>();

    // Check for name collisions (same normalized name, different records)
    for (const [key, ids] of this.nameIndex) {
      if (ids.size > 1) {
        const records = Array.from(ids)
          .map((id) => this.relationships.get(id))
          .filter((r): r is RelationshipRecord => r != null);
        if (records.length > 1) {
          const groupKey = Array.from(ids).sort().join(',');
          if (!seen.has(groupKey)) {
            seen.add(groupKey);
            groups.push({
              records,
              reason: `Same normalized name: "${key}"`,
            });
          }
        }
      }
    }

    // Check for collapsed-name collisions (e.g., "colonist one" vs "colonistone")
    const collapsedMap = new Map<string, Set<string>>();
    for (const [key, ids] of this.nameIndex) {
      const collapsed = key.replace(/\s/g, '');
      let existing = collapsedMap.get(collapsed);
      if (!existing) {
        existing = new Set();
        collapsedMap.set(collapsed, existing);
      }
      for (const id of ids) existing.add(id);
    }

    for (const [collapsed, ids] of collapsedMap) {
      if (ids.size > 1) {
        const groupKey = Array.from(ids).sort().join(',');
        if (!seen.has(groupKey)) {
          seen.add(groupKey);
          const records = Array.from(ids)
            .map((id) => this.relationships.get(id))
            .filter((r): r is RelationshipRecord => r != null);
          if (records.length > 1) {
            groups.push({
              records,
              reason: `Similar collapsed name: "${collapsed}"`,
            });
          }
        }
      }
    }

    return groups;
  }

  // ── Enrichment ─────────────────────────────────────────────────────

  /**
   * Record an interaction with a person. Updates recency, count, and interaction log.
   */
  recordInteraction(
    id: string,
    interaction: InteractionSummary,
  ): void {
    const record = this.relationships.get(id);
    if (!record) return;

    record.lastInteraction = interaction.timestamp;
    record.interactionCount++;

    // Add to recent interactions, trim to max
    record.recentInteractions.push(interaction);
    if (record.recentInteractions.length > this.config.maxRecentInteractions) {
      record.recentInteractions = record.recentInteractions.slice(
        -this.config.maxRecentInteractions,
      );
    }

    // Merge new topics into themes
    if (interaction.topics) {
      for (const topic of interaction.topics) {
        if (!record.themes.includes(topic)) {
          record.themes.push(topic);
        }
      }
      // Keep themes manageable
      if (record.themes.length > 20) {
        record.themes = record.themes.slice(-20);
      }
    }

    // Auto-derive significance from frequency and recency
    record.significance = this.calculateSignificance(record);

    this.save(record);
  }

  /**
   * Update notes or other metadata for a relationship.
   */
  updateNotes(id: string, notes: string): void {
    const record = this.relationships.get(id);
    if (!record) return;
    record.notes = notes.slice(0, MAX_NOTES_LENGTH);
    this.save(record);
  }

  /**
   * Update the arc summary for a relationship.
   */
  updateArcSummary(id: string, arcSummary: string): void {
    const record = this.relationships.get(id);
    if (!record) return;
    record.arcSummary = arcSummary;
    this.save(record);
  }

  /**
   * Link a new channel to an existing relationship (cross-platform identity merge).
   */
  linkChannel(id: string, channel: UserChannel): void {
    const record = this.relationships.get(id);
    if (!record) return;

    const channelKey = `${channel.type}:${channel.identifier}`;

    // Check if this channel is already linked to someone else
    const existingId = this.channelIndex.get(channelKey);
    if (existingId && existingId !== id) {
      // Merge the other record into this one
      this.mergeRelationships(id, existingId);
      return;
    }

    if (!record.channels.some((c) => c.type === channel.type && c.identifier === channel.identifier)) {
      if (record.channels.length >= MAX_CHANNELS) {
        console.warn(`[RelationshipManager] Channel limit (${MAX_CHANNELS}) reached for ${record.name}`);
        return;
      }
      record.channels.push(channel);
      this.channelIndex.set(channelKey, id);
      this.save(record);
    }
  }

  /**
   * Merge two relationship records (when we discover two channels are the same person).
   */
  mergeRelationships(keepId: string, mergeId: string): void {
    const keep = this.relationships.get(keepId);
    const merge = this.relationships.get(mergeId);
    if (!keep || !merge) return;

    // Merge channels (respect MAX_CHANNELS cap)
    for (const channel of merge.channels) {
      if (keep.channels.length >= MAX_CHANNELS) break;
      if (!keep.channels.some((c) => c.type === channel.type && c.identifier === channel.identifier)) {
        keep.channels.push(channel);
      }
      this.channelIndex.set(`${channel.type}:${channel.identifier}`, keepId);
    }

    // Merge interaction history
    keep.recentInteractions = [...keep.recentInteractions, ...merge.recentInteractions]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-this.config.maxRecentInteractions);

    // Merge themes (cap at 20 to match recordInteraction behavior)
    for (const theme of merge.themes) {
      if (keep.themes.length >= 20) break;
      if (!keep.themes.includes(theme)) keep.themes.push(theme);
    }

    // Take the earlier first interaction
    if (merge.firstInteraction < keep.firstInteraction) {
      keep.firstInteraction = merge.firstInteraction;
    }

    // Sum interaction counts
    keep.interactionCount += merge.interactionCount;

    // Merge notes (cap total length)
    if (merge.notes && merge.notes !== keep.notes) {
      keep.notes = keep.notes
        ? `${keep.notes}\n\n[Merged from ${merge.name}]: ${merge.notes}`.slice(0, MAX_NOTES_LENGTH)
        : merge.notes.slice(0, MAX_NOTES_LENGTH);
    }

    // Merge category (keep existing, or take from merged)
    if (!keep.category && merge.category) {
      keep.category = merge.category;
    }

    // Merge tags
    if (merge.tags) {
      if (!keep.tags) keep.tags = [];
      for (const tag of merge.tags) {
        if (!keep.tags.includes(tag)) keep.tags.push(tag);
      }
    }

    keep.significance = this.calculateSignificance(keep);
    this.save(keep);

    // Delete the merged record and clean up name index
    this.unindexName(mergeId, merge.name);
    this.relationships.delete(mergeId);
    this.deleteFile(mergeId);
  }

  /**
   * Delete a relationship and its disk file.
   */
  delete(id: string): boolean {
    const record = this.relationships.get(id);
    if (!record) return false;

    // Remove channel index entries
    for (const channel of record.channels) {
      const channelKey = `${channel.type}:${channel.identifier}`;
      if (this.channelIndex.get(channelKey) === id) {
        this.channelIndex.delete(channelKey);
      }
    }

    // Remove name index entry
    this.unindexName(id, record.name);

    this.relationships.delete(id);
    this.deleteFile(id);
    return true;
  }

  /**
   * Update the category for a relationship.
   */
  updateCategory(id: string, category: string): void {
    const record = this.relationships.get(id);
    if (!record) return;
    record.category = category;
    this.save(record);
  }

  /**
   * Add tags to a relationship (deduplicates).
   */
  addTags(id: string, tags: string[]): void {
    const record = this.relationships.get(id);
    if (!record) return;
    if (!record.tags) record.tags = [];
    for (const tag of tags) {
      if (!record.tags.includes(tag)) {
        record.tags.push(tag);
      }
    }
    this.save(record);
  }

  /**
   * Remove tags from a relationship.
   */
  removeTags(id: string, tags: string[]): void {
    const record = this.relationships.get(id);
    if (!record || !record.tags) return;
    record.tags = record.tags.filter((t) => !tags.includes(t));
    this.save(record);
  }

  // ── Context Generation ─────────────────────────────────────────────

  /**
   * Generate context string for injection into a Claude session before interacting
   * with a known person. This is what makes the agent "know" who it's talking to.
   */
  getContextForPerson(id: string): string | null {
    const record = this.relationships.get(id);
    if (!record) return null;

    // Sanitize user-controlled strings to prevent XML/prompt injection
    const sanitize = (s: string): string =>
      s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const safeName = sanitize(record.name);

    const lines: string[] = [
      `<relationship_context person="${safeName}">`,
      `Name: ${safeName}`,
      `Known since: ${record.firstInteraction}`,
      `Last interaction: ${record.lastInteraction}`,
      `Total interactions: ${record.interactionCount}`,
      `Significance: ${record.significance}/10`,
    ];

    // Cross-platform presence summary
    if (record.channels.length > 1) {
      const platforms = [...new Set(record.channels.map((c) => c.type))];
      lines.push(`Platforms: ${platforms.map(sanitize).join(', ')}`);
    }

    if (record.category) {
      lines.push(`Category: ${sanitize(record.category)}`);
    }

    if (record.tags && record.tags.length > 0) {
      lines.push(`Tags: ${record.tags.map(sanitize).join(', ')}`);
    }

    if (record.themes.length > 0) {
      lines.push(`Key themes: ${record.themes.map(sanitize).join(', ')}`);
    }

    if (record.communicationStyle) {
      lines.push(`Communication style: ${sanitize(record.communicationStyle)}`);
    }

    if (record.arcSummary) {
      lines.push(`Relationship arc: ${sanitize(record.arcSummary)}`);
    }

    if (record.notes) {
      lines.push(`Notes: ${sanitize(record.notes)}`);
    }

    if (record.recentInteractions.length > 0) {
      lines.push('Recent interactions:');
      for (const interaction of record.recentInteractions.slice(-5)) {
        lines.push(`  - [${sanitize(interaction.timestamp)}] ${sanitize(interaction.summary)}`);
      }
    }

    lines.push('</relationship_context>');
    return lines.join('\n');
  }

  /**
   * Find relationships that haven't been contacted in a while.
   */
  getStaleRelationships(daysThreshold: number = 14): RelationshipRecord[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysThreshold);
    const cutoffStr = cutoff.toISOString();

    return this.getAll('recent').filter(
      (r) => r.lastInteraction < cutoffStr && r.significance >= 3,
    );
  }

  // ── Persistence ────────────────────────────────────────────────────

  private loadAll(): void {
    if (!existsSync(this.config.relationshipsDir)) return;

    const files = readdirSync(this.config.relationshipsDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(this.config.relationshipsDir, file), 'utf-8'));
        // Verify the filename matches the record ID (prevents tampered/misnamed files)
        const expectedFile = `${data.id}.json`;
        if (file !== expectedFile) {
          console.warn(`[RelationshipManager] Filename mismatch: ${file} contains id ${data.id}, skipping`);
          continue;
        }
        this.validateId(data.id);
        this.relationships.set(data.id, data);
        this.indexName(data.id, data.name);
        for (const channel of (data.channels ?? [])) {
          this.channelIndex.set(`${channel.type}:${channel.identifier}`, data.id);
        }
      } catch {
        // Skip corrupted files
      }
    }
  }

  private save(record: RelationshipRecord): void {
    this.validateId(record.id);
    const filePath = join(this.config.relationshipsDir, `${record.id}.json`);
    // Atomic write: write to unique .tmp then rename
    const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(record, null, 2));
      renameSync(tmpPath, filePath);
    } catch (err) {
      // safe-git-allow: incremental-migration
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  private deleteFile(id: string): void {
    this.validateId(id);
    const filePath = join(this.config.relationshipsDir, `${id}.json`);
    try {
      // safe-git-allow: incremental-migration
      unlinkSync(filePath);
    } catch {
      // File may not exist
    }
  }

  // ── Internal ───────────────────────────────────────────────────────

  private calculateSignificance(record: RelationshipRecord): number {
    // Significance is derived from:
    // - Interaction frequency (count)
    // - Recency (how recently they interacted)
    // - Theme depth (variety of topics)
    const now = Date.now();
    const lastInteraction = new Date(record.lastInteraction).getTime();
    const daysSinceLastInteraction = (now - lastInteraction) / (1000 * 60 * 60 * 24);

    let score = 0;

    // Frequency component (0-4 points)
    if (record.interactionCount >= 50) score += 4;
    else if (record.interactionCount >= 20) score += 3;
    else if (record.interactionCount >= 5) score += 2;
    else if (record.interactionCount >= 2) score += 1;

    // Recency component (0-3 points)
    if (daysSinceLastInteraction < 1) score += 3;
    else if (daysSinceLastInteraction < 7) score += 2;
    else if (daysSinceLastInteraction < 30) score += 1;

    // Theme depth (0-3 points)
    if (record.themes.length >= 10) score += 3;
    else if (record.themes.length >= 5) score += 2;
    else if (record.themes.length >= 2) score += 1;

    return Math.min(10, Math.max(1, score));
  }
}
