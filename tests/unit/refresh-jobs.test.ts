/**
 * Tests for refreshJobs() — the job merge logic that adds new default jobs
 * to existing agents during updates.
 *
 * This is critical infrastructure: it's how existing agents get guardian jobs
 * without losing their customized job configurations. The merge logic must:
 * - Add new default jobs that don't exist yet
 * - Never overwrite existing jobs (even if the user modified them)
 * - Handle corrupt/missing files gracefully
 * - Apply port configuration correctly
 *
 * Born from Justin's insight: "We've run into pitfalls of shipping features
 * that had been 'fully tested' but still failed." The previous test
 * (default-jobs-valid.test.ts) only validated structure by reading source
 * as text — it never called refreshJobs() with a real filesystem.
 *
 * These tests use REAL temp directories and REAL file I/O. No mocking fs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { refreshHooksAndSettings } from '../../src/commands/init.js';
import { loadJobs } from '../../src/scheduler/JobLoader.js';

// ─── Helpers ─────────────────────────────────────────────────────

interface TestProject {
  dir: string;
  stateDir: string;
  jobsPath: string;
  configPath: string;
  cleanup: () => void;
}

function createTestProject(opts: { port?: number; jobs?: object[] } = {}): TestProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-refresh-test-'));
  const stateDir = path.join(dir, '.instar');

  // Create minimal directory structure
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

  // Write config
  const configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: opts.port ?? 4321,
    projectName: 'test-agent',
    agentName: 'Test Agent',
  }));

  // Write jobs file
  const jobsPath = path.join(stateDir, 'jobs.json');
  if (opts.jobs) {
    fs.writeFileSync(jobsPath, JSON.stringify(opts.jobs, null, 2));
  }

  // Create a minimal CLAUDE.md (refreshHooksAndSettings reads it)
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Test Agent\n');

  return {
    dir,
    stateDir,
    jobsPath,
    configPath,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Create a minimal valid job definition.
 */
function makeJob(slug: string, overrides: Record<string, unknown> = {}): object {
  return {
    slug,
    name: slug.replace(/-/g, ' '),
    description: `Test job: ${slug}`,
    schedule: '0 */4 * * *',
    priority: 'medium',
    expectedDurationMinutes: 1,
    model: 'haiku',
    enabled: true,
    execute: { type: 'prompt', value: `Run ${slug}` },
    tags: ['test'],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('refreshJobs()', () => {
  let project: TestProject;

  afterEach(() => {
    project?.cleanup();
  });

  describe('adding new default jobs to existing agents', () => {
    it('adds guardian jobs to an agent that only has original 12 jobs', () => {
      // Simulate an agent created before the guardian network was added
      const originalJobs = [
        makeJob('health-check'),
        makeJob('email-check'),
        makeJob('reflection-trigger'),
      ];

      project = createTestProject({ jobs: originalJobs });

      // Run refresh — this is what happens when the user updates instar
      refreshHooksAndSettings(project.dir, project.stateDir);

      // Read the updated jobs file
      const updatedJobs = JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as Array<{ slug: string }>;
      const slugs = new Set(updatedJobs.map(j => j.slug));

      // Original jobs should still be there
      expect(slugs.has('health-check')).toBe(true);
      expect(slugs.has('email-check')).toBe(true);
      expect(slugs.has('reflection-trigger')).toBe(true);

      // Guardian jobs should have been added
      expect(slugs.has('degradation-digest')).toBe(true);
      expect(slugs.has('state-integrity-check')).toBe(true);
      expect(slugs.has('memory-hygiene')).toBe(true);
      expect(slugs.has('guardian-pulse')).toBe(true);
      expect(slugs.has('session-continuity-check')).toBe(true);
    });

    it('does not duplicate jobs that already exist', () => {
      // Agent already has some guardian jobs (maybe from a previous update)
      const existingJobs = [
        makeJob('health-check'),
        makeJob('guardian-pulse', { priority: 'low' }), // User customized priority
      ];

      project = createTestProject({ jobs: existingJobs });
      refreshHooksAndSettings(project.dir, project.stateDir);

      const updatedJobs = JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as Array<{ slug: string; priority?: string }>;

      // Count guardian-pulse — should be exactly 1
      const guardianPulseJobs = updatedJobs.filter(j => j.slug === 'guardian-pulse');
      expect(guardianPulseJobs).toHaveLength(1);

      // The user's customization should be preserved (priority: low, not high)
      expect(guardianPulseJobs[0].priority).toBe('low');
    });

    it('added jobs pass loadJobs validation', () => {
      // Start with minimal jobs
      project = createTestProject({ jobs: [makeJob('health-check')] });
      refreshHooksAndSettings(project.dir, project.stateDir);

      // loadJobs should not throw — this is the real validation
      // that happens at server startup
      const loaded = loadJobs(project.jobsPath);
      expect(loaded.length).toBeGreaterThan(1);

      // Every loaded job should have required fields
      for (const job of loaded) {
        expect(job.slug).toBeTruthy();
        expect(job.name).toBeTruthy();
        expect(job.schedule).toBeTruthy();
        expect(typeof job.enabled).toBe('boolean');
        expect(job.execute).toBeTruthy();
      }
    });
  });

  describe('port configuration in job templates', () => {
    it('substitutes the configured port into guardian job gates', () => {
      const customPort = 5555;
      project = createTestProject({ port: customPort, jobs: [makeJob('health-check')] });
      refreshHooksAndSettings(project.dir, project.stateDir);

      const updatedJobs = JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as Array<{
        slug: string;
        execute?: { type?: string; value?: string };
        gate?: string;
      }>;

      // Find a guardian job that references the port in its gate
      const stateCheck = updatedJobs.find(j => j.slug === 'state-integrity-check');
      expect(stateCheck).toBeDefined();

      // The gate should reference the configured port
      expect(stateCheck!.gate).toContain(String(customPort));

      // Guardian jobs now use type: 'skill' — execute value is a skill name, not a port-bearing command
      expect(stateCheck!.execute!.type).toBe('skill');
    });

    it('uses default port 4040 when config is missing', () => {
      project = createTestProject({ jobs: [makeJob('health-check')] });

      // Delete config to simulate missing config
      // safe-git-allow: incremental-migration
      fs.unlinkSync(project.configPath);

      refreshHooksAndSettings(project.dir, project.stateDir);

      const updatedJobs = JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as Array<{
        slug: string;
        gate?: string;
      }>;

      const stateCheck = updatedJobs.find(j => j.slug === 'state-integrity-check');
      if (stateCheck?.gate) {
        expect(stateCheck.gate).toContain('4040');
      }
    });
  });

  describe('error resilience', () => {
    it('does not crash on corrupt jobs.json', () => {
      project = createTestProject();
      fs.writeFileSync(project.jobsPath, 'not valid json {{{');

      // Should not throw — the silent catch protects the caller
      expect(() => {
        refreshHooksAndSettings(project.dir, project.stateDir);
      }).not.toThrow();

      // File should still be the corrupt content (not overwritten)
      const content = fs.readFileSync(project.jobsPath, 'utf-8');
      expect(content).toBe('not valid json {{{');
    });

    it('does not crash when jobs.json does not exist', () => {
      project = createTestProject();
      // No jobs.json written — should be a no-op

      expect(() => {
        refreshHooksAndSettings(project.dir, project.stateDir);
      }).not.toThrow();
    });

    it('does not crash on empty jobs array', () => {
      project = createTestProject({ jobs: [] });

      refreshHooksAndSettings(project.dir, project.stateDir);

      const updatedJobs = JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as Array<{ slug: string }>;

      // Should have added all default jobs to the empty array
      expect(updatedJobs.length).toBeGreaterThan(0);

      // All should be valid
      const loaded = loadJobs(project.jobsPath);
      expect(loaded.length).toBe(updatedJobs.length);
    });

    it('does not crash on jobs with extra unknown fields', () => {
      const jobsWithExtras = [
        makeJob('health-check', {
          customField: 'user-added',
          anotherField: { nested: true },
        }),
      ];

      project = createTestProject({ jobs: jobsWithExtras });

      expect(() => {
        refreshHooksAndSettings(project.dir, project.stateDir);
      }).not.toThrow();

      // User's custom fields should be preserved
      const updatedJobs = JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as Array<{
        slug: string;
        customField?: string;
      }>;
      const healthCheck = updatedJobs.find(j => j.slug === 'health-check');
      expect(healthCheck?.customField).toBe('user-added');
    });
  });

  describe('idempotency', () => {
    it('running refresh twice produces same result', () => {
      project = createTestProject({ jobs: [makeJob('health-check')] });

      refreshHooksAndSettings(project.dir, project.stateDir);
      const afterFirst = fs.readFileSync(project.jobsPath, 'utf-8');

      refreshHooksAndSettings(project.dir, project.stateDir);
      const afterSecond = fs.readFileSync(project.jobsPath, 'utf-8');

      expect(afterFirst).toBe(afterSecond);
    });

    it('job count is stable across multiple refreshes', () => {
      project = createTestProject({ jobs: [makeJob('health-check')] });

      refreshHooksAndSettings(project.dir, project.stateDir);
      const firstCount = (JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as unknown[]).length;

      refreshHooksAndSettings(project.dir, project.stateDir);
      refreshHooksAndSettings(project.dir, project.stateDir);
      refreshHooksAndSettings(project.dir, project.stateDir);
      const finalCount = (JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as unknown[]).length;

      expect(finalCount).toBe(firstCount);
    });
  });

  describe('guardian job structural integrity', () => {
    it('all guardian jobs have the guardian tag', () => {
      project = createTestProject({ jobs: [] });
      refreshHooksAndSettings(project.dir, project.stateDir);

      const jobs = JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as Array<{
        slug: string;
        tags?: string[];
      }>;

      const guardianSlugs = [
        'degradation-digest',
        'state-integrity-check',
        'guardian-pulse',
        'session-continuity-check',
      ];

      for (const slug of guardianSlugs) {
        const job = jobs.find(j => j.slug === slug);
        expect(job, `guardian job ${slug} should exist`).toBeDefined();
        expect(job!.tags, `guardian job ${slug} should have tags`).toBeDefined();
        expect(job!.tags).toContain('cat:guardian');
      }

      // memory-hygiene exists but is classified as cat:maintenance
      const hygiene = jobs.find(j => j.slug === 'memory-hygiene');
      expect(hygiene, 'memory-hygiene should exist').toBeDefined();
      expect(hygiene!.tags).toContain('cat:maintenance');
    });

    it('guardian-pulse is high priority', () => {
      project = createTestProject({ jobs: [] });
      refreshHooksAndSettings(project.dir, project.stateDir);

      const jobs = JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as Array<{
        slug: string;
        priority?: string;
      }>;
      const pulse = jobs.find(j => j.slug === 'guardian-pulse');
      expect(pulse?.priority).toBe('high');
    });

    it('memory-hygiene uses opus model with grounding', () => {
      project = createTestProject({ jobs: [] });
      refreshHooksAndSettings(project.dir, project.stateDir);

      const jobs = JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as Array<{
        slug: string;
        model?: string;
        grounding?: { requiresIdentity?: boolean };
      }>;
      const hygiene = jobs.find(j => j.slug === 'memory-hygiene');
      expect(hygiene?.model).toBe('opus');
      expect(hygiene?.grounding?.requiresIdentity).toBe(true);
    });

    it('all guardian jobs have gates', () => {
      project = createTestProject({ jobs: [] });
      refreshHooksAndSettings(project.dir, project.stateDir);

      const jobs = JSON.parse(fs.readFileSync(project.jobsPath, 'utf-8')) as Array<{
        slug: string;
        gate?: string;
      }>;

      const guardianSlugs = [
        'degradation-digest',
        'state-integrity-check',
        'memory-hygiene',
        'guardian-pulse',
        'session-continuity-check',
      ];

      for (const slug of guardianSlugs) {
        const job = jobs.find(j => j.slug === slug);
        expect(job?.gate, `${slug} should have a gate`).toBeTruthy();
      }
    });
  });
});
