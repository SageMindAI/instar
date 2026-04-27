/**
 * User Manager — multi-user identity resolution.
 *
 * Maps incoming messages to known users based on their channels.
 * Same agent, same repo, different relationship per user.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { UserProfile, UserChannel, Message } from '../core/types.js';

export class UserManager {
  private users: Map<string, UserProfile> = new Map();
  private channelIndex: Map<string, string> = new Map(); // "type:identifier" -> userId
  private usersFile: string;

  constructor(stateDir: string, initialUsers?: UserProfile[]) {
    this.usersFile = path.join(stateDir, 'users.json');
    this.loadUsers(initialUsers);
  }

  /**
   * Resolve a user from an incoming message.
   * Returns the user profile if the sender is recognized.
   */
  resolveFromMessage(message: Message): UserProfile | null {
    return this.resolveFromChannel(message.channel);
  }

  /**
   * Resolve a user from a channel identifier.
   */
  resolveFromChannel(channel: UserChannel): UserProfile | null {
    const key = `${channel.type}:${channel.identifier}`;
    const userId = this.channelIndex.get(key);
    if (!userId) return null;
    return this.users.get(userId) || null;
  }

  /**
   * Resolve a user by their Telegram numeric user ID.
   * Scans all profiles for matching telegramUserId field.
   *
   * This is the primary resolution path for incoming Telegram messages,
   * since telegramUserId is stored as a direct field on UserProfile
   * (not a channel — channels use topic IDs).
   */
  resolveFromTelegramUserId(telegramUserId: number): UserProfile | null {
    if (!telegramUserId) return null;
    for (const user of this.users.values()) {
      if (user.telegramUserId === telegramUserId) return user;
    }
    return null;
  }

  /**
   * Get a user by ID.
   */
  getUser(userId: string): UserProfile | null {
    return this.users.get(userId) || null;
  }

  /**
   * List all registered users.
   */
  listUsers(): UserProfile[] {
    return Array.from(this.users.values());
  }

  /**
   * Add or update a user.
   */
  upsertUser(profile: UserProfile): void {
    this.validateProfile(profile);

    // Remove old channel index entries
    const existing = this.users.get(profile.id);
    if (existing) {
      for (const channel of existing.channels) {
        this.channelIndex.delete(`${channel.type}:${channel.identifier}`);
      }
    }

    // Check for channel collisions — prevent silent ownership transfer
    for (const channel of profile.channels) {
      const key = `${channel.type}:${channel.identifier}`;
      const existingOwner = this.channelIndex.get(key);
      if (existingOwner && existingOwner !== profile.id) {
        throw new Error(`Channel ${key} is already registered to user ${existingOwner}; cannot assign to ${profile.id}`);
      }
    }

    // Add new entries
    this.users.set(profile.id, profile);
    for (const channel of profile.channels) {
      this.channelIndex.set(`${channel.type}:${channel.identifier}`, profile.id);
    }

    this.persistUsers();
  }

  /**
   * Remove a user.
   */
  removeUser(userId: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;

    for (const channel of user.channels) {
      this.channelIndex.delete(`${channel.type}:${channel.identifier}`);
    }
    this.users.delete(userId);
    this.persistUsers();
    return true;
  }

  /**
   * Check if a user has a specific permission.
   */
  hasPermission(userId: string, permission: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;
    return user.permissions.includes(permission) || user.permissions.includes('admin');
  }

  /**
   * Add a user interactively (with defaults applied).
   * Returns the full profile.
   */
  addUserInteractive(partialProfile: Partial<UserProfile> & { id: string; name: string }): UserProfile {
    const profile: UserProfile = {
      channels: [],
      permissions: ['user'],
      preferences: {},
      createdAt: new Date().toISOString(),
      ...partialProfile,
    };
    this.upsertUser(profile);
    return profile;
  }

  /**
   * List users formatted for wizard display.
   * Returns name + id pairs suitable for selection prompts.
   */
  listUsersForSelection(): Array<{ name: string; value: string; description: string }> {
    return this.listUsers().map(user => ({
      name: user.name,
      value: user.id,
      description: `${user.permissions.includes('admin') ? 'Admin' : 'User'} — ${user.channels.map(c => c.type).join(', ') || 'no channels'}`,
    }));
  }

  /**
   * Find admin users.
   */
  getAdmins(): UserProfile[] {
    return this.listUsers().filter(u => u.permissions.includes('admin'));
  }

  private validateProfile(profile: UserProfile): void {
    if (!profile.id || typeof profile.id !== 'string' || !profile.id.trim()) {
      throw new Error('UserProfile.id must be a non-empty string');
    }
    if (!Array.isArray(profile.channels)) {
      throw new Error(`UserProfile(${profile.id}).channels must be an array`);
    }
    if (!Array.isArray(profile.permissions)) {
      throw new Error(`UserProfile(${profile.id}).permissions must be an array`);
    }
  }

  private loadUsers(initialUsers?: UserProfile[]): void {
    // Load from file if exists
    if (fs.existsSync(this.usersFile)) {
      try {
        const data: UserProfile[] = JSON.parse(fs.readFileSync(this.usersFile, 'utf-8'));
        for (const user of data) {
          // Skip malformed entries
          if (!user.id || !Array.isArray(user.channels) || !Array.isArray(user.permissions)) {
            console.warn(`[UserManager] Skipping malformed user entry: ${JSON.stringify(user).slice(0, 100)}`);
            continue;
          }
          this.users.set(user.id, user);
          for (const channel of user.channels) {
            if (channel.type && channel.identifier) {
              this.channelIndex.set(`${channel.type}:${channel.identifier}`, user.id);
            }
          }
        }
      } catch (err) {
        // Back up corrupted file instead of silently dropping all users
        const backupPath = this.usersFile + '.corrupt.' + Date.now();
        try { fs.copyFileSync(this.usersFile, backupPath); } catch { /* best effort */ }
        console.error(`[UserManager] Corrupted users file backed up to ${backupPath}: ${err}`);
      }
    }

    // Merge initial users (config takes precedence for initial setup)
    if (initialUsers) {
      for (const user of initialUsers) {
        if (!this.users.has(user.id)) {
          this.upsertUser(user);
        }
      }
    }
  }

  private persistUsers(): void {
    const dir = path.dirname(this.usersFile);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: unique temp filename prevents concurrent corruption
    const tmpPath = `${this.usersFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(Array.from(this.users.values()), null, 2));
      fs.renameSync(tmpPath, this.usersFile);
    } catch (err) {
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
}
