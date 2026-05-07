/**
 * ThreadlineNicknames — user-editable display names for threadline agents,
 * keyed by fingerprint (or any stable id).
 *
 * Storage: .instar/threadline/nicknames.json
 *   {
 *     "version": 1,
 *     "nicknames": {
 *       "8c7928aa9f04fbda...": {
 *         "nickname": "Dawn",
 *         "source": "user" | "haiku" | "import",
 *         "updatedAt": "2026-05-06T17:00:00.000Z"
 *       }
 *     }
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';

export type NicknameSource = 'user' | 'haiku' | 'import';

export interface NicknameEntry {
  nickname: string;
  source: NicknameSource;
  updatedAt: string;
}

interface NicknamesFile {
  version: number;
  nicknames: Record<string, NicknameEntry>;
}

export interface ThreadlineNicknamesOptions {
  stateDir: string;
}

const FILE_VERSION = 1;

export class ThreadlineNicknames {
  private readonly stateDir: string;
  private cache: Map<string, NicknameEntry> | null = null;
  private cacheReadAt = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(opts: ThreadlineNicknamesOptions) {
    this.stateDir = opts.stateDir;
  }

  /** Path to the nicknames JSON file. */
  filePath(): string {
    return path.join(this.stateDir, 'threadline', 'nicknames.json');
  }

  /** Returns the nickname for a fingerprint, or null if none set. */
  get(fingerprint: string): NicknameEntry | null {
    if (!fingerprint) return null;
    const map = this.load();
    return map.get(fingerprint) ?? null;
  }

  /** Returns all nicknames as a plain map. */
  all(): Record<string, NicknameEntry> {
    const map = this.load();
    const out: Record<string, NicknameEntry> = {};
    for (const [k, v] of map) out[k] = v;
    return out;
  }

  /** Set a nickname for a fingerprint. Empty/whitespace nickname clears it. */
  set(fingerprint: string, nickname: string, source: NicknameSource = 'user'): NicknameEntry | null {
    if (!fingerprint) throw new Error('fingerprint required');
    const trimmed = nickname.trim();
    const map = this.load();
    if (trimmed.length === 0) {
      map.delete(fingerprint);
      this.persist(map);
      return null;
    }
    if (trimmed.length > 64) {
      throw new Error('nickname too long (max 64 chars)');
    }
    const entry: NicknameEntry = {
      nickname: trimmed,
      source,
      updatedAt: new Date().toISOString(),
    };
    map.set(fingerprint, entry);
    this.persist(map);
    return entry;
  }

  /** Delete a nickname mapping. Returns true if one existed. */
  delete(fingerprint: string): boolean {
    const map = this.load();
    if (!map.has(fingerprint)) return false;
    map.delete(fingerprint);
    this.persist(map);
    return true;
  }

  /** Force-reload on next get(). */
  invalidate(): void {
    this.cache = null;
    this.cacheReadAt = 0;
  }

  // ── internal ───────────────────────────────────────────────────

  private load(): Map<string, NicknameEntry> {
    const fresh = Date.now() - this.cacheReadAt < ThreadlineNicknames.CACHE_TTL_MS;
    if (this.cache && fresh) return this.cache;
    const map = new Map<string, NicknameEntry>();
    const file = this.filePath();
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw) as NicknamesFile;
        const items = parsed?.nicknames ?? {};
        for (const [k, v] of Object.entries(items)) {
          if (v && typeof v.nickname === 'string') {
            map.set(k, {
              nickname: v.nickname,
              source: (v.source as NicknameSource) ?? 'user',
              updatedAt: v.updatedAt ?? new Date().toISOString(),
            });
          }
        }
      } catch {
        /* ignore corrupt file — start empty */
      }
    }
    this.cache = map;
    this.cacheReadAt = Date.now();
    return map;
  }

  private persist(map: Map<string, NicknameEntry>): void {
    const file = this.filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const obj: NicknamesFile = {
      version: FILE_VERSION,
      nicknames: Object.fromEntries(map),
    };
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf-8');
    this.cache = map;
    this.cacheReadAt = Date.now();
  }
}
