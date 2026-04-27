/**
 * Platform-agnostic session-channel registry.
 *
 * Extracted from TelegramAdapter as part of Phase 1 shared infrastructure.
 * Maps channels (topics, chats, etc.) to sessions bidirectionally.
 * Persists to disk as JSON for crash recovery.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ChannelMapping {
  channelId: string;
  sessionName: string;
  channelName: string | null;
  channelPurpose: string | null;
}

export interface SessionChannelRegistryConfig {
  /** Path to the JSON registry file */
  registryPath: string;
}

export class SessionChannelRegistry {
  private channelToSession: Map<string, string> = new Map();
  private sessionToChannel: Map<string, string> = new Map();
  private channelToName: Map<string, string> = new Map();
  private channelToPurpose: Map<string, string> = new Map();
  private registryPath: string;

  constructor(config: SessionChannelRegistryConfig) {
    this.registryPath = config.registryPath;

    // Ensure directory exists
    const dir = path.dirname(this.registryPath);
    fs.mkdirSync(dir, { recursive: true });

    this.load();
  }

  register(channelId: string, sessionName: string, channelName?: string): void {
    this.channelToSession.set(channelId, sessionName);
    this.sessionToChannel.set(sessionName, channelId);
    if (channelName) {
      this.channelToName.set(channelId, channelName);
    }
    this.save();
  }

  unregister(channelId: string): void {
    const sessionName = this.channelToSession.get(channelId);
    this.channelToSession.delete(channelId);
    if (sessionName) this.sessionToChannel.delete(sessionName);
    this.save();
  }

  getSessionForChannel(channelId: string): string | null {
    return this.channelToSession.get(channelId) ?? null;
  }

  getChannelForSession(sessionName: string): string | null {
    return this.sessionToChannel.get(sessionName) ?? null;
  }

  getChannelName(channelId: string): string | null {
    return this.channelToName.get(channelId) ?? null;
  }

  setChannelName(channelId: string, name: string): void {
    this.channelToName.set(channelId, name);
    this.save();
  }

  getChannelPurpose(channelId: string): string | null {
    return this.channelToPurpose.get(channelId) ?? null;
  }

  setChannelPurpose(channelId: string, purpose: string): void {
    this.channelToPurpose.set(channelId, purpose.toLowerCase());
    this.save();
  }

  /**
   * Get all active channel-session mappings.
   */
  getAllMappings(): ChannelMapping[] {
    const result: ChannelMapping[] = [];
    for (const [channelId, sessionName] of this.channelToSession) {
      result.push({
        channelId,
        sessionName,
        channelName: this.channelToName.get(channelId) ?? null,
        channelPurpose: this.channelToPurpose.get(channelId) ?? null,
      });
    }
    return result;
  }

  /**
   * Get all channel-session pairs as a Map (used by heartbeat/monitoring).
   */
  getAllChannelSessions(): Map<string, string> {
    return new Map(this.channelToSession);
  }

  /**
   * Get count of registered mappings.
   */
  get size(): number {
    return this.channelToSession.size;
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.registryPath)) return;
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));

      // Support both new format (channelToSession) and legacy (topicToSession)
      const sessionMap = data.channelToSession ?? data.topicToSession;
      if (sessionMap) {
        for (const [k, v] of Object.entries(sessionMap)) {
          this.channelToSession.set(String(k), v as string);
          this.sessionToChannel.set(v as string, String(k));
        }
      }

      const nameMap = data.channelToName ?? data.topicToName;
      if (nameMap) {
        for (const [k, v] of Object.entries(nameMap)) {
          this.channelToName.set(String(k), v as string);
        }
      }

      const purposeMap = data.channelToPurpose ?? data.topicToPurpose;
      if (purposeMap) {
        for (const [k, v] of Object.entries(purposeMap)) {
          this.channelToPurpose.set(String(k), v as string);
        }
      }
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  private save(): void {
    try {
      const data = {
        channelToSession: Object.fromEntries(this.channelToSession),
        channelToName: Object.fromEntries(this.channelToName),
        channelToPurpose: Object.fromEntries(this.channelToPurpose),
        // Write legacy keys too for backward compatibility during migration
        topicToSession: Object.fromEntries(this.channelToSession),
        topicToName: Object.fromEntries(this.channelToName),
        topicToPurpose: Object.fromEntries(this.channelToPurpose),
      };
      const tmpPath = this.registryPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
        fs.renameSync(tmpPath, this.registryPath);
      } catch (writeErr) {
        // safe-git-allow: incremental-migration
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw writeErr;
      }
    } catch (err) {
      console.error(`[session-channel-registry] Failed to save registry: ${err}`);
    }
  }
}
