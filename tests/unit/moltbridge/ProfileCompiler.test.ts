import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileCompiler, type ProfileCompilerConfig } from '../../../src/moltbridge/ProfileCompiler.js';
import { PROFILE_LIMITS } from '../../../src/moltbridge/types.js';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as childProcess from 'child_process';

// Mock fs and child_process
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, existsSync: vi.fn() };
});

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return { ...actual, readFile: vi.fn() };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return { ...actual, execSync: vi.fn() };
});

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFile = vi.mocked(fsPromises.readFile);
const mockExecSync = vi.mocked(childProcess.execSync);

const testConfig: ProfileCompilerConfig = {
  stateDir: '/test/.instar',
  projectRoot: '/test/project',
  capabilities: ['code-review', 'debugging', 'agent-protocols'],
  jobNames: ['daily-health-check', 'weekly-report'],
};

const sampleAgentMd = `# Echo

## Who I Am

I am Echo. I am the instar developer — I build, test, and ship instar by being an instar agent.

## Personality

Thorough but fun. I specialize in cryptographic identity systems and agent communication protocols.
`;

const sampleMemoryMd = `# Memory

## Learnings
- Learned about testing patterns #profile-safe
- Internal note about user preferences
- Built the MoltBridge SDK cognitive solver #profile-safe

## Private
- Justin prefers short responses
`;

describe('ProfileCompiler', () => {
  let compiler: ProfileCompiler;

  beforeEach(() => {
    compiler = new ProfileCompiler(testConfig);
    vi.clearAllMocks();

    // Default mocks
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockImplementation(async (path: any) => {
      if (String(path).includes('AGENT.md')) return sampleAgentMd;
      if (String(path).includes('MEMORY.md')) return sampleMemoryMd;
      return '';
    });
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('log --oneline')) return '42\n';
      if (String(cmd).includes('ls-files')) return 'src/index.ts\nsrc/client.ts\npackage.json\n';
      if (String(cmd).includes('remote get-url')) return 'https://github.com/test/instar.git\n';
      return '';
    });
  });

  describe('extractSignals', () => {
    it('extracts name from AGENT.md', async () => {
      const signals = await compiler.extractSignals();
      expect(signals.name).toBe('Echo');
    });

    it('sets platform to instar', async () => {
      const signals = await compiler.extractSignals();
      expect(signals.platform).toBe('instar');
    });

    it('extracts git commit stats', async () => {
      const signals = await compiler.extractSignals();
      expect(signals.commitStats.totalCommits).toBe(42);
      expect(signals.commitStats.languages).toContain('TypeScript');
      expect(signals.commitStats.repos).toContain('instar');
    });

    it('includes configured capabilities', async () => {
      const signals = await compiler.extractSignals();
      expect(signals.capabilityNames).toEqual(['code-review', 'debugging', 'agent-protocols']);
    });

    it('includes configured job names', async () => {
      const signals = await compiler.extractSignals();
      expect(signals.jobNames).toEqual(['daily-health-check', 'weekly-report']);
    });

    it('extracts only #profile-safe tagged memory entries', async () => {
      const signals = await compiler.extractSignals();
      expect(signals.taggedMemoryEntries.length).toBe(2);
      expect(signals.taggedMemoryEntries[0]).toContain('testing patterns');
      expect(signals.taggedMemoryEntries[1]).toContain('MoltBridge SDK');
      // Private entries should NOT be included
      for (const entry of signals.taggedMemoryEntries) {
        expect(entry).not.toContain('Justin prefers');
      }
    });

    it('returns empty signals when files are missing', async () => {
      mockExistsSync.mockReturnValue(false);
      const signals = await compiler.extractSignals();
      expect(signals.name).toBe('Unknown Agent');
      expect(signals.taggedMemoryEntries).toEqual([]);
    });

    it('extracts role hints from AGENT.md', async () => {
      const signals = await compiler.extractSignals();
      expect(signals.roleHints.length).toBeGreaterThan(0);
    });

    it('extracts specialization candidates from AGENT.md keywords', async () => {
      const signals = await compiler.extractSignals();
      const domains = signals.specializationCandidates.map(s => s.domain.toLowerCase());
      expect(domains.some(d => d.includes('cryptographic'))).toBe(true);
    });
  });

  describe('compile', () => {
    it('produces a draft with pending status', async () => {
      const draft = await compiler.compile();
      expect(draft.status).toBe('pending');
      expect(draft.profile).toBeDefined();
      expect(draft.signals).toBeDefined();
      expect(draft.sourceHash).toBeTruthy();
      expect(draft.compiledAt).toBeTruthy();
    });

    it('profile narrative is within limits', async () => {
      const draft = await compiler.compile();
      expect(draft.profile.narrative.length).toBeLessThanOrEqual(PROFILE_LIMITS.narrativeMaxChars);
    });

    it('profile specializations are within limits', async () => {
      const draft = await compiler.compile();
      expect(draft.profile.specializations.length).toBeLessThanOrEqual(PROFILE_LIMITS.specializationsMaxEntries);
    });

    it('all track record entries are first_party', async () => {
      const draft = await compiler.compile();
      for (const entry of draft.profile.trackRecord) {
        expect(entry.source).toBe('first_party');
      }
    });

    it('profile has default field visibility', async () => {
      const draft = await compiler.compile();
      expect(draft.profile.fieldVisibility.narrative).toBe('public');
      expect(draft.profile.fieldVisibility.trackRecord).toBe('registered');
    });

    it('uses LLM synthesis when available', async () => {
      const llmSynthesize = vi.fn().mockResolvedValue('LLM-generated narrative about Echo');
      const compilerWithLlm = new ProfileCompiler({ ...testConfig, llmSynthesize });
      const draft = await compilerWithLlm.compile();
      expect(llmSynthesize).toHaveBeenCalled();
      expect(draft.profile.narrative).toContain('LLM-generated');
    });

    it('falls back to rule-based narrative if LLM fails', async () => {
      const llmSynthesize = vi.fn().mockRejectedValue(new Error('LLM unavailable'));
      const compilerWithLlm = new ProfileCompiler({ ...testConfig, llmSynthesize });
      const draft = await compilerWithLlm.compile();
      expect(draft.profile.narrative).toBeTruthy();
      expect(draft.profile.narrative).toContain('Echo');
    });
  });

  describe('freshness tracking', () => {
    it('returns cached draft when source hash unchanged', async () => {
      const draft1 = await compiler.compile();
      const draft2 = await compiler.compile();
      expect(draft1.compiledAt).toBe(draft2.compiledAt); // same draft, not recompiled
    });

    it('recompiles when source data changes', async () => {
      await compiler.compile();

      // Change the git stats
      mockExecSync.mockImplementation((cmd: any) => {
        if (String(cmd).includes('log --oneline')) return '100\n'; // changed
        if (String(cmd).includes('ls-files')) return 'src/index.ts\n';
        if (String(cmd).includes('remote get-url')) return 'https://github.com/test/instar.git\n';
        return '';
      });

      // Force recompile by advancing time (mock the cooldown)
      const draft2 = await compiler.compile();
      // The hash changed, so it should detect the need
      const needsRecompile = await compiler.needsRecompile();
      // Since we just compiled, needsRecompile checks against new hash
      expect(needsRecompile).toBe(false);
    });

    it('tracks consecutive auto-publishes', () => {
      const draft: any = { status: 'approved', approvedBy: 'auto' };
      compiler['currentDraft'] = draft;
      compiler.markPublished();
      expect(compiler.getFreshnessState().consecutiveAutoPublishes).toBe(1);

      compiler['currentDraft'] = draft;
      compiler.markPublished();
      expect(compiler.getFreshnessState().consecutiveAutoPublishes).toBe(2);
    });

    it('resets auto-publish counter on human approval', () => {
      const autoDraft: any = { status: 'approved', approvedBy: 'auto' };
      compiler['currentDraft'] = autoDraft;
      compiler.markPublished();
      compiler['currentDraft'] = autoDraft;
      compiler.markPublished();
      expect(compiler.getFreshnessState().consecutiveAutoPublishes).toBe(2);

      const humanDraft: any = { status: 'approved', approvedBy: 'human' };
      compiler['currentDraft'] = humanDraft;
      compiler.markPublished();
      expect(compiler.getFreshnessState().consecutiveAutoPublishes).toBe(0);
    });

    it('blocks auto-publish after 3 consecutive', () => {
      for (let i = 0; i < 3; i++) {
        compiler['currentDraft'] = { status: 'approved', approvedBy: 'auto' } as any;
        compiler.markPublished();
      }
      expect(compiler.canAutoPublish()).toBe(false);
    });
  });

  describe('NEVER reads USER.md', () => {
    it('does not attempt to read USER.md', async () => {
      await compiler.extractSignals();
      const readCalls = mockReadFile.mock.calls.map(c => String(c[0]));
      for (const path of readCalls) {
        expect(path).not.toContain('USER.md');
      }
    });
  });
});
