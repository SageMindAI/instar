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
  InteractionSummary,
  UserChannel,
} from './types.js';

export class RelationshipManager {
  private relationships: Map<string, RelationshipRecord> = new Map();
  /** Maps "channel_type:identifier" -> relationship ID for cross-platform resolution */
  private channelIndex: Map<string, string> = new Map();
  private config: RelationshipManagerConfig;

  constructor(config: RelationshipManagerConfig) {
    this.config = config;
    if (!existsSync(config.relationshipsDir)) {
      mkdirSync(config.relationshipsDir, { recursive: true });
    }
    this.loadAll();
  }

  // ── Core Operations ────────────────────────────────────────────────

  /**
   * Find or create a relationship from an incoming interaction.
   * Resolves cross-platform: if the same person messages from Telegram and email,
   * this returns the same relationship.
   */
  findOrCreate(name: string, channel: UserChannel): RelationshipRecord {
    const channelKey = `${channel.type}:${channel.identifier}`;

    // Try to resolve by channel first
    const existingId = this.channelIndex.get(channelKey);
    if (existingId) {
      const existing = this.relationships.get(existingId);
      if (existing) return existing;
      // Channel index is stale — clean it up and fall through to create
      this.channelIndex.delete(channelKey);
    }

    // Create new relationship
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
    this.save(record);
    return record;
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
    record.notes = notes;
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

    // Merge channels
    for (const channel of merge.channels) {
      if (!keep.channels.some((c) => c.type === channel.type && c.identifier === channel.identifier)) {
        keep.channels.push(channel);
      }
      this.channelIndex.set(`${channel.type}:${channel.identifier}`, keepId);
    }

    // Merge interaction history
    keep.recentInteractions = [...keep.recentInteractions, ...merge.recentInteractions]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-this.config.maxRecentInteractions);

    // Merge themes
    for (const theme of merge.themes) {
      if (!keep.themes.includes(theme)) keep.themes.push(theme);
    }

    // Take the earlier first interaction
    if (merge.firstInteraction < keep.firstInteraction) {
      keep.firstInteraction = merge.firstInteraction;
    }

    // Sum interaction counts
    keep.interactionCount += merge.interactionCount;

    // Merge notes
    if (merge.notes && merge.notes !== keep.notes) {
      keep.notes = keep.notes
        ? `${keep.notes}\n\n[Merged from ${merge.name}]: ${merge.notes}`
        : merge.notes;
    }

    keep.significance = this.calculateSignificance(keep);
    this.save(keep);

    // Delete the merged record
    this.relationships.delete(mergeId);
    this.deleteFile(mergeId);
  }

  // ── Context Generation ─────────────────────────────────────────────

  /**
   * Generate context string for injection into a Claude session before interacting
   * with a known person. This is what makes the agent "know" who it's talking to.
   */
  getContextForPerson(id: string): string | null {
    const record = this.relationships.get(id);
    if (!record) return null;

    const lines: string[] = [
      `<relationship_context person="${record.name}">`,
      `Name: ${record.name}`,
      `Known since: ${record.firstInteraction}`,
      `Last interaction: ${record.lastInteraction}`,
      `Total interactions: ${record.interactionCount}`,
      `Significance: ${record.significance}/10`,
    ];

    if (record.themes.length > 0) {
      lines.push(`Key themes: ${record.themes.join(', ')}`);
    }

    if (record.communicationStyle) {
      lines.push(`Communication style: ${record.communicationStyle}`);
    }

    if (record.arcSummary) {
      lines.push(`Relationship arc: ${record.arcSummary}`);
    }

    if (record.notes) {
      lines.push(`Notes: ${record.notes}`);
    }

    if (record.recentInteractions.length > 0) {
      lines.push('Recent interactions:');
      for (const interaction of record.recentInteractions.slice(-5)) {
        lines.push(`  - [${interaction.timestamp}] ${interaction.summary}`);
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
        this.relationships.set(data.id, data);
        for (const channel of data.channels) {
          this.channelIndex.set(`${channel.type}:${channel.identifier}`, data.id);
        }
      } catch {
        // Skip corrupted files
      }
    }
  }

  private save(record: RelationshipRecord): void {
    const filePath = join(this.config.relationshipsDir, `${record.id}.json`);
    // Atomic write: write to .tmp then rename
    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(record, null, 2));
    renameSync(tmpPath, filePath);
  }

  private deleteFile(id: string): void {
    const filePath = join(this.config.relationshipsDir, `${id}.json`);
    try {
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
