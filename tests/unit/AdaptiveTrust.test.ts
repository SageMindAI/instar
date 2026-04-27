import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import type { AdaptiveTrustConfig, TrustLevel } from '../../src/core/AdaptiveTrust.js';

describe('AdaptiveTrust', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-test-'));
    stateDir = tmpDir;
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  });

  afterAll(() => {
    const prefix = path.join(os.tmpdir(), 'trust-test-');
    for (const entry of fs.readdirSync(os.tmpdir())) {
      const full = path.join(os.tmpdir(), entry);
      if (full.startsWith(prefix)) {
        // safe-git-allow: incremental-migration
        fs.rmSync(full, { recursive: true, force: true });
      }
    }
  });

  function createTrust(overrides?: Partial<AdaptiveTrustConfig>): AdaptiveTrust {
    return new AdaptiveTrust({
      stateDir,
      ...overrides,
    });
  }

  describe('default trust levels', () => {
    it('read operations default to autonomous', () => {
      const trust = createTrust();
      const entry = trust.getTrustLevel('gmail', 'read');
      expect(entry.level).toBe('autonomous');
      expect(entry.source).toBe('default');
    });

    it('write operations default to log', () => {
      const trust = createTrust();
      const entry = trust.getTrustLevel('gmail', 'write');
      expect(entry.level).toBe('log');
    });

    it('modify operations default to approve-always', () => {
      const trust = createTrust();
      const entry = trust.getTrustLevel('gmail', 'modify');
      expect(entry.level).toBe('approve-always');
    });

    it('delete operations default to approve-always', () => {
      const trust = createTrust();
      const entry = trust.getTrustLevel('gmail', 'delete');
      expect(entry.level).toBe('approve-always');
    });
  });

  describe('trustToAutonomy mapping', () => {
    it('maps trust levels to autonomy behaviors', () => {
      const trust = createTrust();
      expect(trust.trustToAutonomy('blocked')).toBe('block');
      expect(trust.trustToAutonomy('approve-always')).toBe('approve');
      expect(trust.trustToAutonomy('approve-first')).toBe('approve');
      expect(trust.trustToAutonomy('log')).toBe('log');
      expect(trust.trustToAutonomy('autonomous')).toBe('proceed');
    });
  });

  describe('recording successes', () => {
    it('increments success count', () => {
      const trust = createTrust();
      trust.recordSuccess('gmail', 'read');
      trust.recordSuccess('gmail', 'read');

      const history = trust.getServiceHistory('gmail');
      expect(history).toBeDefined();
      expect(history!.successCount).toBe(2);
      expect(history!.streakSinceIncident).toBe(2);
    });

    it('returns null when no elevation suggestion', () => {
      const trust = createTrust();
      const suggestion = trust.recordSuccess('gmail', 'read');
      expect(suggestion).toBeNull(); // read is already autonomous, can't elevate
    });

    it('suggests elevation after threshold', () => {
      const trust = createTrust({ elevationThreshold: 3 });
      // modify defaults to approve-always with source: default → can auto-elevate
      // Record enough successes to pass threshold
      let suggestion = null;
      for (let i = 0; i < 10; i++) {
        suggestion = trust.recordSuccess('gmail', 'modify');
        if (suggestion) break;
      }

      expect(suggestion).not.toBeNull();
      expect(suggestion!.currentLevel).toBe('approve-always');
      expect(suggestion!.suggestedLevel).toBe('approve-first');
      expect(suggestion!.streak).toBeGreaterThanOrEqual(3);
    });

    it('never auto-elevates past log level', () => {
      const trust = createTrust({ elevationThreshold: 2 });
      // Start at log — max auto level
      // Default read is autonomous, default write is log, default modify is approve-always

      // Write starts at log (default) — should NOT suggest elevation past log
      for (let i = 0; i < 5; i++) {
        const suggestion = trust.recordSuccess('gmail', 'write');
        expect(suggestion).toBeNull(); // log is already at MAX_AUTO_LEVEL
      }
    });

    it('does not suggest elevation for user-explicit levels', () => {
      const trust = createTrust({ elevationThreshold: 2 });
      trust.grantTrust('gmail', 'modify', 'approve-always', 'I want it this way');

      for (let i = 0; i < 10; i++) {
        const suggestion = trust.recordSuccess('gmail', 'modify');
        expect(suggestion).toBeNull(); // user-explicit blocks auto-elevation
      }
    });
  });

  describe('recording incidents', () => {
    it('drops trust on incident', () => {
      const trust = createTrust();
      // Start with a non-default elevated level
      trust.grantTrust('gmail', 'write', 'autonomous', 'Full trust');

      const event = trust.recordIncident('gmail', 'write', 'Deleted emails without approval');
      expect(event).toBeDefined();
      expect(event!.from).toBe('autonomous');
      expect(event!.to).toBe('approve-always');
    });

    it('resets streak on incident', () => {
      const trust = createTrust();
      trust.recordSuccess('gmail', 'read');
      trust.recordSuccess('gmail', 'read');
      trust.recordSuccess('gmail', 'read');

      trust.recordIncident('gmail', 'read', 'Something went wrong');

      const history = trust.getServiceHistory('gmail');
      expect(history!.streakSinceIncident).toBe(0);
      expect(history!.incidentCount).toBe(1);
      expect(history!.lastIncident).toBeDefined();
    });

    it('does not drop if already at or below drop level', () => {
      const trust = createTrust();
      // Default modify is approve-always, which is the default drop level
      const event = trust.recordIncident('gmail', 'modify', 'Minor issue');
      expect(event).toBeNull(); // Already at approve-always
    });

    it('uses configured incident drop level', () => {
      const trust = createTrust({ incidentDropLevel: 'blocked' });
      trust.grantTrust('gmail', 'write', 'autonomous', 'Full trust');

      const event = trust.recordIncident('gmail', 'write', 'Catastrophic failure');
      expect(event).toBeDefined();
      expect(event!.to).toBe('blocked');
    });
  });

  describe('explicit trust grants', () => {
    it('sets trust for specific operation', () => {
      const trust = createTrust();
      const event = trust.grantTrust('gmail', 'delete', 'autonomous', "You don't need to ask me about deleting emails");

      expect(event.from).toBe('approve-always'); // default
      expect(event.to).toBe('autonomous');
      expect(event.source).toBe('user-explicit');

      const entry = trust.getTrustLevel('gmail', 'delete');
      expect(entry.level).toBe('autonomous');
      expect(entry.source).toBe('user-explicit');
      expect(entry.userStatement).toContain("don't need to ask");
    });

    it('sets trust for entire service', () => {
      const trust = createTrust();
      const events = trust.grantServiceTrust('calendar', 'log', 'I trust you with calendar management');

      expect(events).toHaveLength(4); // read, write, modify, delete
      for (const event of events) {
        expect(event.to).toBe('log');
        expect(event.source).toBe('user-explicit');
      }
    });

    it('can block specific operations', () => {
      const trust = createTrust();
      trust.grantTrust('gmail', 'delete', 'blocked', 'Never delete my emails');

      const entry = trust.getTrustLevel('gmail', 'delete');
      expect(entry.level).toBe('blocked');
      expect(entry.source).toBe('user-explicit');
    });
  });

  describe('pending elevations', () => {
    it('returns empty when auto-elevate disabled', () => {
      const trust = createTrust({ autoElevateEnabled: false });
      for (let i = 0; i < 20; i++) {
        trust.recordSuccess('gmail', 'modify');
      }
      expect(trust.getPendingElevations()).toHaveLength(0);
    });

    it('returns elevations for services with high streaks', () => {
      const trust = createTrust({ elevationThreshold: 3 });
      for (let i = 0; i < 5; i++) {
        trust.recordSuccess('gmail', 'modify');
      }

      const elevations = trust.getPendingElevations();
      expect(elevations.length).toBeGreaterThan(0);
      expect(elevations[0].service).toBe('gmail');
      expect(elevations[0].currentLevel).toBe('approve-always');
      expect(elevations[0].suggestedLevel).toBe('approve-first');
    });
  });

  describe('change log', () => {
    it('tracks trust changes', () => {
      const trust = createTrust();
      trust.grantTrust('gmail', 'delete', 'autonomous', 'Full trust');
      trust.recordIncident('gmail', 'delete', 'Oops');

      const log = trust.getChangeLog();
      expect(log).toHaveLength(2);
      expect(log[0].to).toBe('autonomous');
      expect(log[1].to).toBe('approve-always'); // incident drop
    });
  });

  describe('persistence', () => {
    it('saves and loads trust profile', () => {
      const trust1 = createTrust();
      trust1.grantTrust('gmail', 'delete', 'autonomous', 'Trust granted');
      trust1.recordSuccess('gmail', 'delete');
      trust1.recordSuccess('gmail', 'delete');

      // Create new instance pointing to same state dir
      const trust2 = createTrust();
      const entry = trust2.getTrustLevel('gmail', 'delete');
      expect(entry.level).toBe('autonomous');
      expect(entry.source).toBe('user-explicit');

      const history = trust2.getServiceHistory('gmail');
      expect(history!.successCount).toBe(2);
    });

    it('handles corrupt profile gracefully', () => {
      const profilePath = path.join(stateDir, 'state', 'trust-profile.json');
      fs.writeFileSync(profilePath, 'not json{{{');

      const trust = createTrust();
      // Should start fresh without throwing
      const entry = trust.getTrustLevel('gmail', 'read');
      expect(entry.level).toBe('autonomous'); // default
    });
  });

  describe('profile access', () => {
    it('returns deep copy of profile', () => {
      const trust = createTrust();
      trust.grantTrust('gmail', 'delete', 'autonomous', 'Trust');

      const profile = trust.getProfile();
      // Mutating the copy shouldn't affect the original
      profile.services.gmail.operations.delete.level = 'blocked';

      const entry = trust.getTrustLevel('gmail', 'delete');
      expect(entry.level).toBe('autonomous'); // unchanged
    });
  });

  describe('summary', () => {
    it('generates summary with no services', () => {
      const trust = createTrust();
      const summary = trust.getSummary();
      expect(summary).toContain('No services configured');
      expect(summary).toContain('collaborative'); // default floor
    });

    it('generates summary with services', () => {
      const trust = createTrust();
      trust.grantTrust('gmail', 'read', 'autonomous', 'Trust reads');
      trust.recordSuccess('gmail', 'read');

      const summary = trust.getSummary();
      expect(summary).toContain('gmail');
      expect(summary).toContain('autonomous');
      expect(summary).toContain('streak');
    });

    it('respects custom floor', () => {
      const trust = createTrust({ floor: 'supervised' });
      const summary = trust.getSummary();
      expect(summary).toContain('supervised');
    });
  });

  describe('global trust state', () => {
    it('tracks last event', () => {
      const trust = createTrust();
      trust.grantTrust('gmail', 'delete', 'autonomous', 'Full trust');

      const profile = trust.getProfile();
      expect(profile.global.lastEvent).toContain('gmail.delete');
      expect(profile.global.lastEvent).toContain('autonomous');
      expect(profile.global.lastEventAt).toBeDefined();
    });

    it('initializes with configured floor', () => {
      const trust = createTrust({ floor: 'supervised' });
      const profile = trust.getProfile();
      expect(profile.global.floor).toBe('supervised');
    });

    it('defaults floor to collaborative', () => {
      const trust = createTrust();
      const profile = trust.getProfile();
      expect(profile.global.floor).toBe('collaborative');
    });
  });
});
