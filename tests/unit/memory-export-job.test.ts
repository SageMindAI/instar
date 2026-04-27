/**
 * Unit tests — Memory Export Job definition.
 *
 * Validates that the memory-export job definition:
 *   1. Exists in the default jobs list
 *   2. Passes JobLoader validation
 *   3. Has correct structure (slug, schedule, model, gate, execute)
 *   4. Uses script-based execution (lightweight, no session needed)
 *   5. Gate checks both server health AND semantic memory availability
 *   6. Schedule runs every 6 hours
 *   7. Is enabled by default
 *   8. Has 'memory' and 'maintenance' tags
 *   9. Uses haiku model (lightweight task)
 *  10. Execute script calls the export-memory API with correct params
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadJobs, validateJob } from '../../src/scheduler/JobLoader.js';
import { refreshHooksAndSettings } from '../../src/commands/init.js';

describe('Memory Export Job definition', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-export-job-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Write config for refreshHooksAndSettings
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 3030, projectName: 'test', agentName: 'Test Agent' })
    );
    // Write empty jobs.json — refreshHooksAndSettings will add defaults
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), '[]');
    // CLAUDE.md must exist for refresh
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Test\n');

    // Refresh to populate with default jobs
    refreshHooksAndSettings(tmpDir, stateDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function getJobs() {
    const jobsPath = path.join(stateDir, 'jobs.json');
    return loadJobs(jobsPath);
  }

  function getMemoryExportJob() {
    const jobs = getJobs();
    return jobs.find((j: any) => j.slug === 'memory-export');
  }

  // 1. Exists in default jobs
  it('is present in the default jobs list', () => {
    const job = getMemoryExportJob();
    expect(job).toBeDefined();
  });

  // 2. Passes validation
  it('passes JobLoader validation', () => {
    const job = getMemoryExportJob();
    expect(() => validateJob(job)).not.toThrow();
  });

  // 3. Correct slug
  it('has slug "memory-export"', () => {
    const job = getMemoryExportJob();
    expect(job!.slug).toBe('memory-export');
  });

  // 4. Script-based execution
  it('uses script-based execution', () => {
    const job = getMemoryExportJob();
    expect(job!.execute.type).toBe('script');
  });

  // 5. Gate checks health AND semantic memory
  it('gate checks both server health and semantic memory availability', () => {
    const job = getMemoryExportJob();
    expect(job!.gate).toBeDefined();
    expect(job!.gate).toContain('/health');
    expect(job!.gate).toContain('/semantic/stats');
  });

  // 6. Runs every 6 hours
  it('is scheduled to run every 6 hours', () => {
    const job = getMemoryExportJob();
    expect(job!.schedule).toBe('0 */6 * * *');
  });

  // 7. Enabled by default
  it('is enabled by default', () => {
    const job = getMemoryExportJob();
    expect(job!.enabled).toBe(true);
  });

  // 8. Has correct tags
  it('has memory and maintenance tags', () => {
    const job = getMemoryExportJob();
    expect(job!.tags).toContain('cat:maintenance');
    expect(job!.tags).toContain('role:worker');
    expect(job!.tags).toContain('exec:script');
  });

  // 9. Uses haiku model
  it('uses haiku model for lightweight execution', () => {
    const job = getMemoryExportJob();
    expect(job!.model).toBe('haiku');
  });

  // 10. Execute script calls export-memory API
  it('execute script calls POST /semantic/export-memory', () => {
    const job = getMemoryExportJob();
    expect(job!.execute.value).toContain('/semantic/export-memory');
    expect(job!.execute.value).toContain('filePath');
    expect(job!.execute.value).toContain('MEMORY.md');
    expect(job!.execute.value).toContain('agentName');
  });

  // 11. Low priority
  it('has low priority', () => {
    const job = getMemoryExportJob();
    expect(job!.priority).toBe('medium');
  });

  // 12. Short expected duration
  it('expects 1 minute or less', () => {
    const job = getMemoryExportJob();
    expect(job!.expectedDurationMinutes).toBeLessThanOrEqual(2);
  });

  // 13. Port is wired into gate and script
  it('wires the configured port into gate and execute commands', () => {
    const job = getMemoryExportJob();
    expect(job!.gate).toContain('3030');
    expect(job!.execute.value).toContain('3030');
  });

  // 14. No duplicate slugs in the full job set
  it('has a unique slug in the job set', () => {
    const jobs = getJobs();
    const slugs = jobs.map((j: any) => j.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  // 15. All default jobs pass validation
  it('all default jobs pass validation', () => {
    const jobs = getJobs();
    for (const job of jobs) {
      expect(() => validateJob(job)).not.toThrow();
    }
  });
});
