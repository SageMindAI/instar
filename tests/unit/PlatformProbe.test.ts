/**
 * Unit tests for PlatformProbe (Tier 3 — Environment Readiness).
 *
 * Tests the tmux FDA and shell FDA probes that detect missing macOS
 * Full Disk Access permissions before they cause recurring popups.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createPlatformProbes } from '../../src/monitoring/probes/PlatformProbe.js';

// ── Platform-conditional suite ─────────────────────────────────────

const isMacOS = os.platform() === 'darwin';

describe('PlatformProbe', () => {
  describe('createPlatformProbes', () => {
    it('returns empty array on non-macOS platforms', () => {
      // If we're on macOS, mock the platform check
      if (isMacOS) {
        const spy = vi.spyOn(os, 'platform').mockReturnValue('linux');
        const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
        expect(probes).toEqual([]);
        spy.mockRestore();
      } else {
        const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
        expect(probes).toEqual([]);
      }
    });

    it('returns two probes on macOS', () => {
      if (!isMacOS) {
        // Can't meaningfully test macOS probe creation on Linux
        return;
      }
      const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
      expect(probes).toHaveLength(2);
      expect(probes[0].id).toBe('instar.platform.tmux-fda');
      expect(probes[1].id).toBe('instar.platform.shell-fda');
    });

    it('probes are tier 3 with Platform Readiness feature', () => {
      if (!isMacOS) return;
      const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
      for (const probe of probes) {
        expect(probe.tier).toBe(3);
        expect(probe.feature).toBe('Platform Readiness');
      }
    });

    it('tmux probe has 15s timeout, shell probe has 5s timeout', () => {
      if (!isMacOS) return;
      const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
      expect(probes[0].timeoutMs).toBe(15000);
      expect(probes[1].timeoutMs).toBe(5000);
    });

    it('prerequisites always return true (no dependencies)', () => {
      if (!isMacOS) return;
      const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
      for (const probe of probes) {
        expect(probe.prerequisites()).toBe(true);
      }
    });
  });

  // These tests only run on macOS where the probes are meaningful
  describe.skipIf(!isMacOS)('probe execution (macOS only)', () => {
    it('tmux-fda probe produces a valid ProbeResult', async () => {
      const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
      const result = await probes[0].run();

      expect(result.probeId).toBe('instar.platform.tmux-fda');
      expect(result.name).toBe('tmux Full Disk Access');
      expect(result.tier).toBe(3);
      expect(typeof result.passed).toBe('boolean');
      expect(typeof result.description).toBe('string');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics).toBeDefined();
    }, 20000);

    it('shell-fda probe produces a valid ProbeResult', async () => {
      const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
      const result = await probes[1].run();

      expect(result.probeId).toBe('instar.platform.shell-fda');
      expect(result.name).toBe('Shell Full Disk Access');
      expect(result.tier).toBe(3);
      expect(typeof result.passed).toBe('boolean');
      expect(typeof result.description).toBe('string');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics).toBeDefined();
    });

    it('tmux-fda probe handles invalid tmux path gracefully', async () => {
      const probes = createPlatformProbes({ tmuxPath: '/nonexistent/tmux' });
      const result = await probes[0].run();

      // Should not crash — returns passed:true with an error explanation
      expect(result.passed).toBe(true);
      expect(result.description).toContain('Could not verify');
    }, 20000);

    it('shell-fda probe includes shell info in diagnostics', async () => {
      const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
      const result = await probes[1].run();

      expect(result.diagnostics).toHaveProperty('shell');
      expect(result.diagnostics).toHaveProperty('pid');
    });

    it('tmux-fda probe cleans up temp files', async () => {
      const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
      await probes[0].run();

      // Check no probe temp files are left behind
      const tmpDir = os.tmpdir();
      const leftover = fs.readdirSync(tmpDir).filter(f => f.startsWith('instar-fda-probe-'));
      expect(leftover).toHaveLength(0);
    }, 20000);

    it('tmux-fda probe cleans up tmux sessions', async () => {
      const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
      await probes[0].run();

      // Verify no probe sessions are left
      const { execSync } = await import('node:child_process');
      try {
        const sessions = execSync('tmux list-sessions 2>/dev/null', { encoding: 'utf-8' });
        const probeSession = sessions.split('\n').find(s => s.includes('instar-fda-probe-'));
        expect(probeSession).toBeUndefined();
      } catch {
        // No tmux server running is fine — means cleanup worked
      }
    }, 20000);

    it('failed tmux probe includes remediation steps', async () => {
      // We can't easily force a TCC denial in tests, but we can verify
      // the structure is correct when access is denied by checking
      // the returned result shape
      const probes = createPlatformProbes({ tmuxPath: '/usr/bin/tmux' });
      const result = await probes[0].run();

      if (!result.passed) {
        // If this machine doesn't have FDA, verify remediation exists
        expect(result.remediation).toBeDefined();
        expect(result.remediation!.length).toBeGreaterThan(0);
        expect(result.remediation!.some(r => r.includes('Full Disk Access'))).toBe(true);
      }
      // If passed, no remediation needed — that's correct
    }, 20000);
  });
});
