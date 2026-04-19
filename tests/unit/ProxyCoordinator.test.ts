/**
 * Unit tests for ProxyCoordinator — per-topic proxy mutex.
 *
 * Ensures PresenceProxy and PromiseBeacon cannot both hold the same topic
 * at the same time (spec §A10).
 */
import { describe, it, expect } from 'vitest';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';

describe('ProxyCoordinator', () => {
  it('grants acquisition to first caller and blocks the other', () => {
    const c = new ProxyCoordinator();
    expect(c.tryAcquire(1, 'presence-proxy')).toBe(true);
    expect(c.tryAcquire(1, 'promise-beacon')).toBe(false);
    expect(c.currentHolder(1)).toBe('presence-proxy');
  });

  it('reentrant acquire by the same holder returns true', () => {
    const c = new ProxyCoordinator();
    expect(c.tryAcquire(1, 'presence-proxy')).toBe(true);
    expect(c.tryAcquire(1, 'presence-proxy')).toBe(true);
  });

  it('release frees the mutex for the other holder', () => {
    const c = new ProxyCoordinator();
    c.tryAcquire(1, 'presence-proxy');
    c.release(1, 'presence-proxy');
    expect(c.currentHolder(1)).toBeNull();
    expect(c.tryAcquire(1, 'promise-beacon')).toBe(true);
  });

  it('release by non-holder is a no-op', () => {
    const c = new ProxyCoordinator();
    c.tryAcquire(1, 'presence-proxy');
    c.release(1, 'promise-beacon'); // wrong holder — ignored
    expect(c.currentHolder(1)).toBe('presence-proxy');
  });

  it('different topics are independent', () => {
    const c = new ProxyCoordinator();
    expect(c.tryAcquire(1, 'presence-proxy')).toBe(true);
    expect(c.tryAcquire(2, 'promise-beacon')).toBe(true);
    expect(c.allHeld().map(h => h.topicId).sort()).toEqual([1, 2]);
  });
});
