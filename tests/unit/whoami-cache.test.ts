/**
 * Unit tests for the Layer 3 whoami-cache module.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3d step 2.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhoamiCache } from '../../src/messaging/whoami-cache.js';

function tmpConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoami-cache-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, '{"port":4042}');
  return p;
}

describe('WhoamiCache', () => {
  it('cache miss → calls fetchFn', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ agentId: 'echo', port: 4042 });
    const cache = new WhoamiCache({ fetchFn });
    const cfg = tmpConfig();
    const r = await cache.get(4042, 'token-1', cfg, 'echo');
    expect(r).toEqual({ agentId: 'echo', port: 4042 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('cache hit within TTL → no second fetch', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ agentId: 'echo', port: 4042 });
    const cache = new WhoamiCache({ fetchFn, ttlMs: 60_000 });
    const cfg = tmpConfig();
    await cache.get(4042, 'token-1', cfg, 'echo');
    await cache.get(4042, 'token-1', cfg, 'echo');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('cache miss after TTL elapses', async () => {
    let now = 1_000_000;
    const fetchFn = vi.fn().mockResolvedValue({ agentId: 'echo', port: 4042 });
    const cache = new WhoamiCache({ fetchFn, ttlMs: 60_000, now: () => now });
    const cfg = tmpConfig();
    await cache.get(4042, 'token-1', cfg, 'echo');
    now += 61_000;
    await cache.get(4042, 'token-1', cfg, 'echo');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('invalidates when config-mtime changes', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ agentId: 'echo', port: 4042 });
    const cache = new WhoamiCache({ fetchFn });
    const cfg = tmpConfig();
    await cache.get(4042, 'token-1', cfg, 'echo');
    // Touch the file to bump mtime.
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(cfg, future, future);
    await cache.get(4042, 'token-1', cfg, 'echo');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('separate cache entries per (port, token-hash, agentId)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ agentId: 'echo', port: 4042 });
    const cache = new WhoamiCache({ fetchFn });
    const cfg = tmpConfig();
    await cache.get(4042, 'token-A', cfg, 'echo');
    await cache.get(4042, 'token-B', cfg, 'echo');
    await cache.get(4043, 'token-A', cfg, 'echo');
    await cache.get(4042, 'token-A', cfg, 'cheryl');
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('clear() empties the cache', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ agentId: 'echo', port: 4042 });
    const cache = new WhoamiCache({ fetchFn });
    const cfg = tmpConfig();
    await cache.get(4042, 'token-1', cfg, 'echo');
    expect(cache.size()).toBe(1);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
