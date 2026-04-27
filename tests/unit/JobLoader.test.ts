import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadJobs, validateJob } from '../../src/scheduler/JobLoader.js';

describe('JobLoader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-loader-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const validJob = {
    slug: 'test-job',
    name: 'Test Job',
    description: 'A test job',
    schedule: '0 */4 * * *',
    priority: 'medium',
    expectedDurationMinutes: 5,
    model: 'sonnet',
    enabled: true,
    execute: { type: 'skill', value: 'scan' },
  };

  function writeJobsFile(jobs: unknown[]): string {
    const filePath = path.join(tmpDir, 'jobs.json');
    fs.writeFileSync(filePath, JSON.stringify(jobs));
    return filePath;
  }

  describe('loadJobs', () => {
    it('loads a valid jobs file', () => {
      const file = writeJobsFile([validJob]);
      const jobs = loadJobs(file);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].slug).toBe('test-job');
    });

    it('loads empty array', () => {
      const file = writeJobsFile([]);
      const jobs = loadJobs(file);
      expect(jobs).toHaveLength(0);
    });

    it('loads multiple jobs', () => {
      const file = writeJobsFile([
        validJob,
        { ...validJob, slug: 'second-job', name: 'Second' },
      ]);
      const jobs = loadJobs(file);
      expect(jobs).toHaveLength(2);
    });

    it('includes disabled jobs (filtering is caller responsibility)', () => {
      const file = writeJobsFile([
        validJob,
        { ...validJob, slug: 'off', enabled: false },
      ]);
      const jobs = loadJobs(file);
      expect(jobs).toHaveLength(2);
      expect(jobs[1].enabled).toBe(false);
    });

    it('returns empty list for missing file (does not throw)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const jobs = loadJobs('/nonexistent/jobs.json');
      expect(jobs).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Jobs file not found'));
      warn.mockRestore();
    });

    it('throws for non-array JSON', () => {
      const file = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(file, JSON.stringify({ jobs: [] }));
      expect(() => loadJobs(file))
        .toThrow('must contain a JSON array');
    });

    it('skips invalid entries and loads valid ones (does not throw)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const file = writeJobsFile([
        validJob,
        // Missing name + priority, invalid execute.type — the exact shape
        // of the contact-proposer job that crashed the scheduler in prod.
        { slug: 'broken-job', description: 'x', schedule: '0 * * * *', enabled: true, execute: { type: 'bash', value: 'echo hi' } },
        { ...validJob, slug: 'third-job', name: 'Third' },
      ]);
      const jobs = loadJobs(file);
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.slug)).toEqual(['test-job', 'third-job']);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('Skipping invalid job at index 1'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped 1 invalid entry'));
      warn.mockRestore();
      err.mockRestore();
    });
  });

  describe('validateJob', () => {
    it('accepts a valid job', () => {
      expect(() => validateJob(validJob)).not.toThrow();
    });

    it('rejects null', () => {
      expect(() => validateJob(null)).toThrow('must be an object');
    });

    it('rejects missing slug', () => {
      const { slug, ...noSlug } = validJob;
      expect(() => validateJob(noSlug)).toThrow('"slug" is required');
    });

    it('rejects empty slug', () => {
      expect(() => validateJob({ ...validJob, slug: '  ' }))
        .toThrow('"slug" is required');
    });

    it('rejects missing name', () => {
      const { name, ...noName } = validJob;
      expect(() => validateJob(noName)).toThrow('"name" is required');
    });

    it('rejects missing description', () => {
      const { description, ...noDesc } = validJob;
      expect(() => validateJob(noDesc)).toThrow('"description" is required');
    });

    it('rejects missing schedule', () => {
      const { schedule, ...noSchedule } = validJob;
      expect(() => validateJob(noSchedule)).toThrow('"schedule" is required');
    });

    it('rejects invalid priority', () => {
      expect(() => validateJob({ ...validJob, priority: 'urgent' }))
        .toThrow('"priority" must be one of');
    });

    it('rejects invalid cron expression', () => {
      expect(() => validateJob({ ...validJob, schedule: 'not a cron' }))
        .toThrow('invalid cron expression');
    });

    it('rejects non-boolean enabled', () => {
      expect(() => validateJob({ ...validJob, enabled: 'yes' }))
        .toThrow('"enabled" must be a boolean');
    });

    it('rejects missing execute', () => {
      const { execute, ...noExec } = validJob;
      expect(() => validateJob(noExec))
        .toThrow('"execute" must be an object');
    });

    it('rejects invalid execute.type', () => {
      expect(() => validateJob({ ...validJob, execute: { type: 'unknown', value: 'x' } }))
        .toThrow('execute.type must be');
    });

    it('rejects empty execute.value', () => {
      expect(() => validateJob({ ...validJob, execute: { type: 'skill', value: '' } }))
        .toThrow('execute.value is required');
    });

    it('includes index in error message', () => {
      expect(() => validateJob(null, 3)).toThrow('Job[3]');
    });

    // ── Grounding validation ──────────────────────────────────────
    describe('grounding validation', () => {
      it('accepts job with valid grounding config', () => {
        expect(() => validateJob({
          ...validJob,
          grounding: {
            requiresIdentity: true,
            processesExternalInput: false,
            contextFiles: ['identity-core.md'],
            questions: ['Am I grounded?'],
          },
        })).not.toThrow();
      });

      it('accepts job with minimal grounding (requiresIdentity only)', () => {
        expect(() => validateJob({
          ...validJob,
          grounding: { requiresIdentity: false },
        })).not.toThrow();
      });

      it('accepts job without grounding (optional field)', () => {
        expect(() => validateJob(validJob)).not.toThrow();
      });

      it('rejects grounding with non-boolean requiresIdentity', () => {
        expect(() => validateJob({
          ...validJob,
          grounding: { requiresIdentity: 'yes' },
        })).toThrow('grounding.requiresIdentity must be a boolean');
      });

      it('rejects grounding with non-boolean processesExternalInput', () => {
        expect(() => validateJob({
          ...validJob,
          grounding: { requiresIdentity: true, processesExternalInput: 'true' },
        })).toThrow('grounding.processesExternalInput must be a boolean');
      });

      it('rejects non-array contextFiles', () => {
        expect(() => validateJob({
          ...validJob,
          grounding: { requiresIdentity: true, contextFiles: 'file.md' },
        })).toThrow('grounding.contextFiles must be an array');
      });

      it('rejects empty string in contextFiles', () => {
        expect(() => validateJob({
          ...validJob,
          grounding: { requiresIdentity: true, contextFiles: ['valid.md', ''] },
        })).toThrow('grounding.contextFiles entries must be non-empty strings');
      });

      it('rejects non-array questions', () => {
        expect(() => validateJob({
          ...validJob,
          grounding: { requiresIdentity: true, questions: 'Am I grounded?' },
        })).toThrow('grounding.questions must be an array');
      });

      it('rejects empty string in questions', () => {
        expect(() => validateJob({
          ...validJob,
          grounding: { requiresIdentity: true, questions: ['valid?', '  '] },
        })).toThrow('grounding.questions entries must be non-empty strings');
      });

      it('rejects non-object grounding', () => {
        expect(() => validateJob({
          ...validJob,
          grounding: 'yes',
        })).toThrow('"grounding" must be an object');
      });
    });

    // ── Machine scope validation ────────────────────────────────────
    describe('machines validation', () => {
      it('accepts job with valid machines array', () => {
        expect(() => validateJob({
          ...validJob,
          machines: ['m_abc123', 'justins-macbook'],
        })).not.toThrow();
      });

      it('accepts job without machines (optional field)', () => {
        expect(() => validateJob(validJob)).not.toThrow();
      });

      it('accepts job with empty machines array (runs everywhere)', () => {
        expect(() => validateJob({
          ...validJob,
          machines: [],
        })).not.toThrow();
      });

      it('rejects non-array machines', () => {
        expect(() => validateJob({
          ...validJob,
          machines: 'm_abc123',
        })).toThrow('"machines" must be an array');
      });

      it('rejects empty string in machines', () => {
        expect(() => validateJob({
          ...validJob,
          machines: ['m_abc123', ''],
        })).toThrow('"machines" entries must be non-empty strings');
      });

      it('rejects non-string in machines', () => {
        expect(() => validateJob({
          ...validJob,
          machines: [123],
        })).toThrow('"machines" entries must be non-empty strings');
      });
    });
  });

  describe('grounding audit', () => {
    it('warns about ungrounded enabled jobs', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const file = writeJobsFile([validJob]);
      loadJobs(file);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Grounding audit: 1 enabled job(s)')
      );
      warnSpy.mockRestore();
    });

    it('does not warn about disabled jobs', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const file = writeJobsFile([{ ...validJob, enabled: false }]);
      loadJobs(file);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not warn about grounded jobs', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const file = writeJobsFile([{
        ...validJob,
        grounding: { requiresIdentity: true },
      }]);
      loadJobs(file);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not warn about exempt jobs (health-check, dispatch-check)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const file = writeJobsFile([
        { ...validJob, slug: 'health-check' },
        { ...validJob, slug: 'dispatch-check' },
      ]);
      loadJobs(file);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
