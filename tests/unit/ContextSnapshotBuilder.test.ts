/**
 * Unit tests for ContextSnapshotBuilder — structured agent context snapshots.
 *
 * Tests cover:
 * - build(): identity, capabilities, jobs, decisions, autonomy, dispatches
 * - renderForPrompt(): text rendering for LLM prompts
 * - buildExternalSnapshot(): data minimization for sharing
 * - Caching: TTL, invalidation
 * - Truncation: intent length, decision count/length, job count
 * - Edge cases: missing files, corrupt data, empty state
 * - AGENT.md parsing: description extraction, intent section extraction
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextSnapshotBuilder } from '../../src/core/ContextSnapshotBuilder.js';

describe('ContextSnapshotBuilder', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-test-'));
    projectDir = tmpDir;
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeBuilder(config?: any) {
    return new ContextSnapshotBuilder(
      {
        projectName: 'TestAgent',
        projectDir,
        stateDir,
      },
      config,
    );
  }

  // ── build() — Identity ────────────────────────────────────────────

  describe('build() identity', () => {
    it('uses projectName as identity.name', () => {
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.identity.name).toBe('TestAgent');
    });

    it('defaults to "Unknown Agent" when projectName is empty', () => {
      const builder = new ContextSnapshotBuilder({
        projectName: '',
        projectDir,
        stateDir,
      });
      const snapshot = builder.build();
      expect(snapshot.identity.name).toBe('Unknown Agent');
    });

    it('reads description from AGENT.md first paragraph', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), `# My Agent\n\nThis is a smart assistant that helps with coding tasks.\n\n## Intent\n\nSome intent here.`);
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.identity.description).toBe('This is a smart assistant that helps with coding tasks.');
    });

    it('reads intent from AGENT.md Intent section', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), `# My Agent\n\nDescription here.\n\n## Intent\n\nTo help developers write better code and learn from experience.\n\n## Other Section\n\nStuff.`);
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.identity.intent).toBe('To help developers write better code and learn from experience.');
    });

    it('reads intent from Purpose section as alternative', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), `# Agent\n\nDesc.\n\n## Purpose\n\nMy purpose is to assist.\n\n## Config`);
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.identity.intent).toBe('My purpose is to assist.');
    });

    it('truncates intent at maxIntentChars', () => {
      const longIntent = 'A'.repeat(1000);
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), `# Agent\n\nDesc.\n\n## Intent\n\n${longIntent}\n\n## End`);
      const builder = makeBuilder({ maxIntentChars: 100 });
      const snapshot = builder.build();
      expect(snapshot.identity.intent!.length).toBe(100 + ' [truncated]'.length);
      expect(snapshot.identity.intent!.endsWith('[truncated]')).toBe(true);
    });

    it('handles missing AGENT.md gracefully', () => {
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.identity.description).toBe('');
      expect(snapshot.identity.intent).toBeUndefined();
    });
  });

  // ── build() — Capabilities ────────────────────────────────────────

  describe('build() capabilities', () => {
    it('returns empty capabilities when no config exists', () => {
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.capabilities.platforms).toEqual([]);
      expect(snapshot.capabilities.features).toEqual([]);
    });

    it('extracts messaging platforms from config', () => {
      const config = {
        messaging: [
          { type: 'telegram', enabled: true },
          { type: 'whatsapp', enabled: true },
          { type: 'slack', enabled: false },
        ],
      };
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config));
      const builder = makeBuilder();
      builder.invalidateCache();
      const snapshot = builder.build();
      expect(snapshot.capabilities.platforms).toContain('telegram');
      expect(snapshot.capabilities.platforms).toContain('whatsapp');
      expect(snapshot.capabilities.platforms).not.toContain('slack');
    });

    it('extracts feature flags from config', () => {
      const config = {
        feedback: { enabled: true },
        dispatches: { enabled: true },
        relationships: { enabled: false },
      };
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config));
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.capabilities.features).toContain('feedback');
      expect(snapshot.capabilities.features).toContain('dispatches');
      expect(snapshot.capabilities.features).not.toContain('relationships');
    });
  });

  // ── build() — Active Jobs ─────────────────────────────────────────

  describe('build() activeJobs', () => {
    it('returns empty when no jobs file specified', () => {
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.activeJobs).toEqual([]);
    });

    it('reads jobs from jobs file', () => {
      const jobsFile = path.join(tmpDir, 'jobs.json');
      const jobs = [
        { slug: 'daily-report', name: 'Daily Report', description: 'Generate daily report', enabled: true },
        { slug: 'cleanup', name: 'Cleanup', description: 'Clean up old files' },
      ];
      fs.writeFileSync(jobsFile, JSON.stringify(jobs));

      const builder = new ContextSnapshotBuilder(
        { projectName: 'Test', projectDir, stateDir, jobsFile },
      );
      const snapshot = builder.build();
      expect(snapshot.activeJobs).toHaveLength(2);
      expect(snapshot.activeJobs[0].slug).toBe('daily-report');
    });

    it('excludes disabled jobs', () => {
      const jobsFile = path.join(tmpDir, 'jobs.json');
      const jobs = [
        { slug: 'active', name: 'Active', description: 'Active job', enabled: true },
        { slug: 'disabled', name: 'Disabled', description: 'Disabled job', enabled: false },
      ];
      fs.writeFileSync(jobsFile, JSON.stringify(jobs));

      const builder = new ContextSnapshotBuilder(
        { projectName: 'Test', projectDir, stateDir, jobsFile },
      );
      const snapshot = builder.build();
      expect(snapshot.activeJobs).toHaveLength(1);
      expect(snapshot.activeJobs[0].slug).toBe('active');
    });

    it('caps jobs at maxActiveJobs', () => {
      const jobsFile = path.join(tmpDir, 'jobs.json');
      const jobs = Array.from({ length: 30 }, (_, i) => ({
        slug: `job-${i}`, name: `Job ${i}`, description: `Description ${i}`,
      }));
      fs.writeFileSync(jobsFile, JSON.stringify(jobs));

      const builder = new ContextSnapshotBuilder(
        { projectName: 'Test', projectDir, stateDir, jobsFile },
        { maxActiveJobs: 5 },
      );
      const snapshot = builder.build();
      expect(snapshot.activeJobs).toHaveLength(5);
    });

    it('handles corrupt jobs file gracefully', () => {
      const jobsFile = path.join(tmpDir, 'jobs.json');
      fs.writeFileSync(jobsFile, 'not json');

      const builder = new ContextSnapshotBuilder(
        { projectName: 'Test', projectDir, stateDir, jobsFile },
      );
      const snapshot = builder.build();
      expect(snapshot.activeJobs).toEqual([]);
    });
  });

  // ── build() — Recent Decisions ────────────────────────────────────

  describe('build() recentDecisions', () => {
    it('returns empty when no journal exists', () => {
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.recentDecisions).toEqual([]);
    });

    it('reads recent decisions from journal', () => {
      const entries = [
        { timestamp: '2026-03-01T00:00:00Z', sessionId: 's1', decision: 'Use caching' },
        { timestamp: '2026-03-02T00:00:00Z', sessionId: 's2', decision: 'Deploy to staging', principle: 'safety-first' },
      ];
      const content = entries.map(e => JSON.stringify(e)).join('\n');
      fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), content);

      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.recentDecisions).toHaveLength(2);
      expect(snapshot.recentDecisions[0].decision).toBe('Use caching');
      expect(snapshot.recentDecisions[1].principle).toBe('safety-first');
    });

    it('caps decisions at maxRecentDecisions (takes most recent)', () => {
      const entries = Array.from({ length: 50 }, (_, i) => ({
        timestamp: new Date(Date.now() - (50 - i) * 1000).toISOString(),
        sessionId: `s${i}`,
        decision: `Decision ${i}`,
      }));
      const content = entries.map(e => JSON.stringify(e)).join('\n');
      fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), content);

      const builder = makeBuilder({ maxRecentDecisions: 10 });
      const snapshot = builder.build();
      expect(snapshot.recentDecisions).toHaveLength(10);
      // Should be the last 10 entries (most recent)
      expect(snapshot.recentDecisions[0].decision).toBe('Decision 40');
    });

    it('truncates individual decision strings', () => {
      const longDecision = 'X'.repeat(200);
      const entry = { timestamp: new Date().toISOString(), sessionId: 's1', decision: longDecision };
      fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), JSON.stringify(entry));

      const builder = makeBuilder({ maxDecisionChars: 50 });
      const snapshot = builder.build();
      expect(snapshot.recentDecisions[0].decision.length).toBe(50);
    });

    it('skips corrupt journal lines', () => {
      const content = [
        JSON.stringify({ timestamp: '2026-03-01T00:00:00Z', sessionId: 's1', decision: 'Good' }),
        'not json',
        JSON.stringify({ timestamp: '2026-03-02T00:00:00Z', sessionId: 's2', decision: 'Also good' }),
      ].join('\n');
      fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), content);

      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.recentDecisions).toHaveLength(2);
    });
  });

  // ── build() — Autonomy Level ──────────────────────────────────────

  describe('build() autonomyLevel', () => {
    it('defaults to supervised when no profile file exists', () => {
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.autonomyLevel).toBe('supervised');
    });

    it('reads autonomy level from profile file', () => {
      fs.writeFileSync(
        path.join(stateDir, 'state', 'autonomy-profile.json'),
        JSON.stringify({ profile: 'collaborative' }),
      );
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.autonomyLevel).toBe('collaborative');
    });

    it('falls back to supervised for invalid profile values', () => {
      fs.writeFileSync(
        path.join(stateDir, 'state', 'autonomy-profile.json'),
        JSON.stringify({ profile: 'invalid-value' }),
      );
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.autonomyLevel).toBe('supervised');
    });

    it('handles corrupt profile file', () => {
      fs.writeFileSync(path.join(stateDir, 'state', 'autonomy-profile.json'), 'corrupt');
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.autonomyLevel).toBe('supervised');
    });
  });

  // ── build() — Applied Dispatch Summary ────────────────────────────

  describe('build() appliedDispatchSummary', () => {
    it('returns zero counts when no dispatches file exists', () => {
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.appliedDispatchSummary.count).toBe(0);
      expect(snapshot.appliedDispatchSummary.byType).toEqual({});
    });

    it('counts only applied dispatches', () => {
      const dispatches = [
        { dispatchId: '1', type: 'lesson', applied: true },
        { dispatchId: '2', type: 'lesson', applied: true },
        { dispatchId: '3', type: 'strategy', applied: true },
        { dispatchId: '4', type: 'configuration', applied: false },
      ];
      fs.writeFileSync(
        path.join(stateDir, 'state', 'dispatches.json'),
        JSON.stringify(dispatches),
      );

      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.appliedDispatchSummary.count).toBe(3);
      expect(snapshot.appliedDispatchSummary.byType).toEqual({ lesson: 2, strategy: 1 });
    });

    it('handles dispatches wrapped in object', () => {
      const data = {
        dispatches: [
          { dispatchId: '1', type: 'lesson', applied: true },
        ],
      };
      fs.writeFileSync(
        path.join(stateDir, 'state', 'dispatches.json'),
        JSON.stringify(data),
      );

      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.appliedDispatchSummary.count).toBe(1);
    });
  });

  // ── build() — General ─────────────────────────────────────────────

  describe('build() general', () => {
    it('includes generatedAt timestamp', () => {
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.generatedAt).toBeTruthy();
      expect(new Date(snapshot.generatedAt).toISOString()).toBe(snapshot.generatedAt);
    });

    it('produces a complete snapshot with all fields', () => {
      // Set up all sources
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent\n\nA test agent.\n\n## Intent\n\nHelp people.');
      fs.writeFileSync(path.join(stateDir, 'state', 'autonomy-profile.json'), JSON.stringify({ profile: 'autonomous' }));
      const entries = [{ timestamp: '2026-03-01T00:00:00Z', sessionId: 's1', decision: 'Test' }];
      fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'));

      const builder = makeBuilder();
      const snapshot = builder.build();

      expect(snapshot.identity.name).toBe('TestAgent');
      expect(snapshot.identity.description).toBe('A test agent.');
      expect(snapshot.identity.intent).toBe('Help people.');
      expect(snapshot.autonomyLevel).toBe('autonomous');
      expect(snapshot.recentDecisions).toHaveLength(1);
      expect(snapshot.generatedAt).toBeTruthy();
    });
  });

  // ── Caching ───────────────────────────────────────────────────────

  describe('caching', () => {
    it('returns cached snapshot within TTL', () => {
      const builder = makeBuilder({ cacheTtlMs: 60000 });
      const first = builder.build();
      const second = builder.build();
      expect(first).toBe(second); // Same object reference
    });

    it('rebuilds snapshot after cache invalidation', () => {
      const builder = makeBuilder({ cacheTtlMs: 60000 });
      const first = builder.build();
      builder.invalidateCache();
      const second = builder.build();
      expect(first).not.toBe(second); // Different object references
    });

    it('invalidateCache causes new object to be returned', () => {
      const builder = makeBuilder({ cacheTtlMs: 60000 });
      const first = builder.build();
      // Verify cached returns same reference
      expect(builder.build()).toBe(first);
      // Invalidate and verify different reference
      builder.invalidateCache();
      const second = builder.build();
      expect(first).not.toBe(second);
    });
  });

  // ── renderForPrompt() ─────────────────────────────────────────────

  describe('renderForPrompt()', () => {
    it('renders basic snapshot as text', () => {
      const builder = makeBuilder();
      const text = builder.renderForPrompt();
      expect(text).toContain('Agent: TestAgent');
      expect(text).toContain('Autonomy: supervised');
    });

    it('includes description and intent when present', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent\n\nA helpful bot.\n\n## Intent\n\nAssist developers.');
      const builder = makeBuilder();
      const text = builder.renderForPrompt();
      expect(text).toContain('Description: A helpful bot.');
      expect(text).toContain('Intent: Assist developers.');
    });

    it('includes platforms and features in detailed mode', () => {
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
        messaging: [{ type: 'telegram', enabled: true }],
        feedback: { enabled: true },
      }));
      const builder = makeBuilder({ detailLevel: 'detailed' });
      const text = builder.renderForPrompt();
      expect(text).toContain('Platforms: telegram');
      expect(text).toContain('Features: feedback');
    });

    it('omits platforms and features in concise mode', () => {
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
        messaging: [{ type: 'telegram', enabled: true }],
      }));
      const builder = makeBuilder({ detailLevel: 'concise' });
      const text = builder.renderForPrompt();
      expect(text).not.toContain('Platforms:');
    });

    it('includes active jobs summary', () => {
      const jobsFile = path.join(tmpDir, 'jobs.json');
      fs.writeFileSync(jobsFile, JSON.stringify([
        { slug: 'daily-report', name: 'Daily', description: 'Report' },
        { slug: 'cleanup', name: 'Cleanup', description: 'Clean' },
      ]));
      const builder = new ContextSnapshotBuilder(
        { projectName: 'Test', projectDir, stateDir, jobsFile },
      );
      const text = builder.renderForPrompt();
      expect(text).toContain('Active jobs (2): daily-report, cleanup');
    });

    it('includes applied dispatch summary', () => {
      fs.writeFileSync(
        path.join(stateDir, 'state', 'dispatches.json'),
        JSON.stringify([
          { dispatchId: '1', type: 'lesson', applied: true },
          { dispatchId: '2', type: 'lesson', applied: true },
          { dispatchId: '3', type: 'strategy', applied: true },
        ]),
      );
      const builder = makeBuilder();
      const text = builder.renderForPrompt();
      expect(text).toContain('Applied dispatches: 3');
    });

    it('includes recent decisions in detailed mode', () => {
      const entries = Array.from({ length: 8 }, (_, i) => ({
        timestamp: new Date().toISOString(),
        sessionId: `s${i}`,
        decision: `Decision ${i}`,
        principle: i % 2 === 0 ? 'safety-first' : undefined,
      }));
      fs.writeFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n'),
      );
      const builder = makeBuilder({ detailLevel: 'detailed' });
      const text = builder.renderForPrompt();
      expect(text).toContain('Recent decisions (8)');
      expect(text).toContain('Decision 0');
      expect(text).toContain('... and 3 more'); // Shows 5, then "and 3 more"
    });

    it('accepts a pre-built snapshot', () => {
      const builder = makeBuilder();
      const snapshot = builder.build();
      const text = builder.renderForPrompt(snapshot);
      expect(text).toContain('Agent: TestAgent');
    });
  });

  // ── buildExternalSnapshot() ───────────────────────────────────────

  describe('buildExternalSnapshot()', () => {
    it('strips sensitive data', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Agent\n\nPublic desc.\n\n## Intent\n\nSecret intent.');
      const entries = [{ timestamp: new Date().toISOString(), sessionId: 's1', decision: 'Secret decision' }];
      fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'));

      const builder = makeBuilder();
      const external = builder.buildExternalSnapshot();

      // Should have identity but without intent
      expect(external.identity!.name).toBe('TestAgent');
      expect(external.identity!.description).toBe('Public desc.');
      expect((external.identity as any).intent).toBeUndefined();

      // Should not have decisions or jobs
      expect(external).not.toHaveProperty('recentDecisions');
      expect(external).not.toHaveProperty('activeJobs');

      // Should have capabilities but empty disabledFeatures
      expect(external.capabilities!.disabledFeatures).toEqual([]);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles completely empty state directory', () => {
      // Remove state dir entirely
      // safe-git-allow: incremental-migration
      fs.rmSync(stateDir, { recursive: true, force: true });
      const builder = makeBuilder();
      const snapshot = builder.build();

      expect(snapshot.identity.name).toBe('TestAgent');
      expect(snapshot.autonomyLevel).toBe('supervised');
      expect(snapshot.recentDecisions).toEqual([]);
      expect(snapshot.activeJobs).toEqual([]);
      expect(snapshot.appliedDispatchSummary.count).toBe(0);
    });

    it('handles all sources being corrupt', () => {
      fs.writeFileSync(path.join(stateDir, 'state', 'autonomy-profile.json'), 'bad');
      fs.writeFileSync(path.join(stateDir, 'state', 'dispatches.json'), 'bad');
      fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), 'bad\nbad');

      const builder = makeBuilder();
      const snapshot = builder.build();

      // Should still produce a valid snapshot with defaults
      expect(snapshot.identity.name).toBe('TestAgent');
      expect(snapshot.autonomyLevel).toBe('supervised');
      expect(snapshot.recentDecisions).toEqual([]);
      expect(snapshot.appliedDispatchSummary.count).toBe(0);
    });

    it('handles empty AGENT.md', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '');
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.identity.description).toBe('');
      expect(snapshot.identity.intent).toBeUndefined();
    });

    it('handles AGENT.md with only headers', () => {
      fs.writeFileSync(path.join(projectDir, 'AGENT.md'), '# Title\n\n## Section\n\n## Another');
      const builder = makeBuilder();
      const snapshot = builder.build();
      expect(snapshot.identity.description).toBe('');
    });
  });
});
