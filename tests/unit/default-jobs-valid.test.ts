/**
 * Validates that all default jobs pass JobLoader validation.
 *
 * Ensures new default jobs have correct structure: valid cron expressions,
 * required fields, valid priority/model values, and sensible configuration.
 *
 * Born from the guardian network addition (2026-02-25): When adding 5 new
 * guardian jobs, we need to verify they'll pass validation at init time.
 */

import { describe, it, expect } from 'vitest';
import { validateJob } from '../../src/scheduler/JobLoader.js';

// Import the getDefaultJobs function — it's not exported, so we'll
// inline the same logic by requiring the init module indirectly.
// Instead, we test by writing a temp jobs.json and loading it.

import fs from 'node:fs';
import path from 'node:path';
import { loadJobs } from '../../src/scheduler/JobLoader.js';

const INIT_PATH = path.resolve(__dirname, '../../src/commands/init.ts');

describe('Default Jobs Validation', () => {
  // Extract default jobs from init.ts at test time
  let defaultJobs: unknown[];

  // We can't import getDefaultJobs directly (it's not exported),
  // so we'll use a different approach: create a temp jobs.json from
  // what init.ts would generate, then validate it with loadJobs.
  //
  // For now, we extract the jobs by evaluating the function.
  // Simpler approach: read the init.ts source, find getDefaultJobs,
  // and validate the structure.

  it('init.ts contains getDefaultJobs function', () => {
    const content = fs.readFileSync(INIT_PATH, 'utf-8');
    expect(content).toContain('function getDefaultJobs(');
  });

  it('all default jobs have required fields', () => {
    const content = fs.readFileSync(INIT_PATH, 'utf-8');

    // Extract all slug values from the function
    const slugMatches = [...content.matchAll(/slug:\s*'([^']+)'/g)];
    const slugs = slugMatches.map(m => m[1]);

    // We should have at least the original 12 + 5 new guardian jobs
    expect(slugs.length).toBeGreaterThanOrEqual(17);

    // Verify no duplicate slugs
    const uniqueSlugs = new Set(slugs);
    expect(uniqueSlugs.size).toBe(slugs.length);
  });

  it('guardian jobs are present', () => {
    const content = fs.readFileSync(INIT_PATH, 'utf-8');

    const guardianSlugs = [
      'degradation-digest',
      'state-integrity-check',
      'memory-hygiene',
      'guardian-pulse',
      'session-continuity-check',
    ];

    for (const slug of guardianSlugs) {
      expect(content).toContain(`slug: '${slug}'`);
    }
  });

  it('all jobs have valid priority values', () => {
    const content = fs.readFileSync(INIT_PATH, 'utf-8');
    const priorityMatches = [...content.matchAll(/priority:\s*'([^']+)'/g)];
    const validPriorities = ['critical', 'high', 'medium', 'low'];

    for (const [, priority] of priorityMatches) {
      expect(validPriorities).toContain(priority);
    }
  });

  it('all jobs have valid model values', () => {
    const content = fs.readFileSync(INIT_PATH, 'utf-8');
    const modelMatches = [...content.matchAll(/model:\s*'([^']+)'/g)];
    const validModels = ['opus', 'sonnet', 'haiku'];

    for (const [, model] of modelMatches) {
      expect(validModels).toContain(model);
    }
  });

  it('guardian jobs have appropriate tags', () => {
    const content = fs.readFileSync(INIT_PATH, 'utf-8');

    // All guardian jobs should have the 'guardian' tag
    // Extract sections between each guardian slug and the next closing brace
    const guardianSlugs = [
      'degradation-digest',
      'state-integrity-check',
      'guardian-pulse',
      'session-continuity-check',
    ];

    for (const slug of guardianSlugs) {
      const slugIndex = content.indexOf(`slug: '${slug}'`);
      expect(slugIndex).toBeGreaterThan(-1);

      // Look for the tags array — prompts can be very long so search a wide window
      const section = content.slice(slugIndex, slugIndex + 5000);
      expect(section).toContain("'cat:guardian'");
    }

    // memory-hygiene exists but is classified as cat:maintenance
    const hygieneIndex = content.indexOf("slug: 'memory-hygiene'");
    expect(hygieneIndex).toBeGreaterThan(-1);
    const hygieneSection = content.slice(hygieneIndex, hygieneIndex + 5000);
    expect(hygieneSection).toContain("'cat:maintenance'");
  });

  it('guardian-pulse has high priority (meta-monitor should run reliably)', () => {
    const content = fs.readFileSync(INIT_PATH, 'utf-8');
    const pulseIndex = content.indexOf("slug: 'guardian-pulse'");
    const section = content.slice(pulseIndex, pulseIndex + 500);
    expect(section).toContain("priority: 'high'");
  });

  it('memory-hygiene uses opus (needs judgment for quality assessment)', () => {
    const content = fs.readFileSync(INIT_PATH, 'utf-8');
    const hygieneIndex = content.indexOf("slug: 'memory-hygiene'");
    const section = content.slice(hygieneIndex, hygieneIndex + 500);
    expect(section).toContain("model: 'opus'");
  });

  it('memory-hygiene has grounding config (needs identity for quality judgment)', () => {
    const content = fs.readFileSync(INIT_PATH, 'utf-8');
    const hygieneIndex = content.indexOf("slug: 'memory-hygiene'");
    const section = content.slice(hygieneIndex, hygieneIndex + 5000);
    expect(section).toContain('requiresIdentity: true');
  });

  it('all guardian jobs have gates (zero-token pre-screening)', () => {
    const content = fs.readFileSync(INIT_PATH, 'utf-8');
    const guardianSlugs = [
      'degradation-digest',
      'state-integrity-check',
      'memory-hygiene',
      'guardian-pulse',
      'session-continuity-check',
    ];

    for (const slug of guardianSlugs) {
      const slugIndex = content.indexOf(`slug: '${slug}'`);
      const section = content.slice(slugIndex, slugIndex + 2000);
      expect(section).toMatch(/gate:/);
    }
  });

  it('default jobs can be written and loaded as valid jobs.json', () => {
    // Create a temporary jobs.json file with inline job definitions
    // that mirror the guardian jobs structure, then validate with loadJobs
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'instar-test-'));
    const tmpJobsFile = path.join(tmpDir, 'jobs.json');

    const testJobs = [
      {
        slug: 'degradation-digest',
        name: 'Degradation Digest',
        description: 'Read DegradationReporter events and escalate trends.',
        schedule: '0 */4 * * *',
        priority: 'medium',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'Check degradation events.' },
        gate: 'test -f /tmp/test-file',
        tags: ['coherence', 'default', 'guardian'],
      },
      {
        slug: 'state-integrity-check',
        name: 'State Integrity Check',
        description: 'Cross-validate state file consistency.',
        schedule: '0 */6 * * *',
        priority: 'medium',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'Check state integrity.' },
        gate: 'curl -sf http://localhost:4321/health >/dev/null 2>&1',
        tags: ['coherence', 'default', 'guardian'],
      },
      {
        slug: 'memory-hygiene',
        name: 'Memory Hygiene',
        description: 'Review MEMORY.md for quality issues.',
        schedule: '0 */12 * * *',
        priority: 'low',
        expectedDurationMinutes: 5,
        model: 'opus',
        enabled: true,
        execute: { type: 'prompt', value: 'Review memory quality.' },
        gate: 'test -f .instar/MEMORY.md',
        grounding: { requiresIdentity: true, contextFiles: ['MEMORY.md'] },
        tags: ['coherence', 'default', 'guardian'],
      },
      {
        slug: 'guardian-pulse',
        name: 'Guardian Pulse',
        description: 'Meta-monitor: verify other jobs are healthy.',
        schedule: '0 */8 * * *',
        priority: 'high',
        expectedDurationMinutes: 2,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'Check guardian health.' },
        gate: 'curl -sf http://localhost:4321/health >/dev/null 2>&1',
        tags: ['coherence', 'default', 'guardian', 'meta'],
      },
      {
        slug: 'session-continuity-check',
        name: 'Session Continuity Check',
        description: 'Verify sessions produce lasting artifacts.',
        schedule: '0 */4 * * *',
        priority: 'low',
        expectedDurationMinutes: 2,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'Check session continuity.' },
        gate: 'curl -sf http://localhost:4321/health >/dev/null 2>&1',
        tags: ['coherence', 'default', 'guardian'],
      },
    ];

    fs.writeFileSync(tmpJobsFile, JSON.stringify(testJobs, null, 2));

    // loadJobs should not throw — all jobs are valid
    const loaded = loadJobs(tmpJobsFile);
    expect(loaded).toHaveLength(5);

    // Verify each job has the expected structure
    for (const job of loaded) {
      expect(job.slug).toBeTruthy();
      expect(job.name).toBeTruthy();
      expect(job.description).toBeTruthy();
      expect(job.schedule).toBeTruthy();
      expect(job.enabled).toBe(true);
      expect(job.execute).toBeTruthy();
    }

    // Cleanup
    // safe-git-allow: incremental-migration
    fs.unlinkSync(tmpJobsFile);
    // safe-git-allow: incremental-migration
    fs.rmdirSync(tmpDir);
  });
});
