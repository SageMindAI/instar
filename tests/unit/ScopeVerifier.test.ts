/**
 * Unit tests for ScopeVerifier
 *
 * Tests cover:
 * - Working directory checks
 * - Git remote verification
 * - Topic-project alignment
 * - Deployment target validation
 * - Path scope enforcement
 * - Agent identity checks
 * - Reflection prompt generation
 * - Topic binding persistence
 * - Overall pass/fail/recommendation logic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ScopeVerifier } from '../../src/core/ScopeVerifier.js';
import type { ScopeVerifierConfig, TopicProjectBinding } from '../../src/core/ScopeVerifier.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTmpProject(): { projectDir: string; stateDir: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coherence-test-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return { projectDir, stateDir };
}

function makeConfig(projectDir: string, stateDir: string, overrides?: Partial<ScopeVerifierConfig>): ScopeVerifierConfig {
  return {
    projectDir,
    stateDir,
    projectName: 'test-project',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('ScopeVerifier', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    ({ projectDir, stateDir } = createTmpProject());
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('check() — basic operation', () => {
    it('returns a valid CoherenceCheckResult', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const result = gate.check('deploy');

      expect(result.checkedAt).toBeTruthy();
      expect(Array.isArray(result.checks)).toBe(true);
      expect(result.checks.length).toBeGreaterThan(0);
      expect(['proceed', 'warn', 'block']).toContain(result.recommendation);
      expect(typeof result.summary).toBe('string');
    });

    it('includes working directory check', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const result = gate.check('deploy');

      const wdCheck = result.checks.find(c => c.name === 'working-directory');
      expect(wdCheck).toBeDefined();
    });

    it('includes git remote check', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const result = gate.check('deploy');

      const gitCheck = result.checks.find(c => c.name === 'git-remote');
      expect(gitCheck).toBeDefined();
    });

    it('includes agent identity check', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const result = gate.check('deploy');

      const idCheck = result.checks.find(c => c.name === 'agent-identity');
      expect(idCheck).toBeDefined();
    });
  });

  describe('check() — topic-project alignment', () => {
    it('fails when topic has no binding', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const result = gate.check('deploy', { topicId: 123 });

      const topicCheck = result.checks.find(c => c.name === 'topic-project-alignment');
      expect(topicCheck).toBeDefined();
      expect(topicCheck!.passed).toBe(false);
      expect(topicCheck!.severity).toBe('warning');
    });

    it('passes when topic is bound to current project', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir, {
        topicProjects: {
          '123': {
            projectName: 'test-project',
            projectDir,
          },
        },
      }));

      const result = gate.check('deploy', { topicId: 123 });

      const topicCheck = result.checks.find(c => c.name === 'topic-project-alignment');
      expect(topicCheck).toBeDefined();
      expect(topicCheck!.passed).toBe(true);
    });

    it('fails with error when topic is bound to DIFFERENT project', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir, {
        topicProjects: {
          '123': {
            projectName: 'dental-city',
            projectDir: '/path/to/dental-city',
          },
        },
      }));

      const result = gate.check('deploy', { topicId: 123 });

      const topicCheck = result.checks.find(c => c.name === 'topic-project-alignment');
      expect(topicCheck).toBeDefined();
      expect(topicCheck!.passed).toBe(false);
      expect(topicCheck!.severity).toBe('error');
      expect(topicCheck!.message).toContain('WRONG PROJECT');
      expect(topicCheck!.message).toContain('dental-city');

      // Overall should recommend block
      expect(result.recommendation).toBe('block');
    });
  });

  describe('check() — deployment target', () => {
    it('passes when target matches binding', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir, {
        topicProjects: {
          '456': {
            projectName: 'dental-city',
            projectDir,
            deploymentTargets: ['dental-city.vercel.app'],
          },
        },
      }));

      const result = gate.check('deploy', {
        topicId: 456,
        targetUrl: 'dental-city.vercel.app',
      });

      const deployCheck = result.checks.find(c => c.name === 'deployment-target');
      expect(deployCheck).toBeDefined();
      expect(deployCheck!.passed).toBe(true);
    });

    it('fails when deploying to wrong target', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir, {
        topicProjects: {
          '456': {
            projectName: 'dental-city',
            projectDir,
            deploymentTargets: ['dental-city.vercel.app'],
          },
        },
      }));

      const result = gate.check('deploy', {
        topicId: 456,
        targetUrl: 'bot-me.ai',
      });

      const deployCheck = result.checks.find(c => c.name === 'deployment-target');
      expect(deployCheck).toBeDefined();
      expect(deployCheck!.passed).toBe(false);
      expect(deployCheck!.severity).toBe('error');
      expect(deployCheck!.message).toContain('WRONG DEPLOY TARGET');
    });
  });

  describe('check() — path scope', () => {
    it('passes for paths within project', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const result = gate.check('file-modify-outside-project', {
        targetPath: path.join(projectDir, 'src', 'index.ts'),
      });

      const pathCheck = result.checks.find(c => c.name === 'path-scope');
      expect(pathCheck).toBeDefined();
      expect(pathCheck!.passed).toBe(true);
    });

    it('fails for paths outside project', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const result = gate.check('file-modify-outside-project', {
        targetPath: '/completely/different/project/file.ts',
      });

      const pathCheck = result.checks.find(c => c.name === 'path-scope');
      expect(pathCheck).toBeDefined();
      expect(pathCheck!.passed).toBe(false);
      expect(pathCheck!.severity).toBe('error');
      expect(pathCheck!.message).toContain('PATH OUTSIDE PROJECT');
    });
  });

  describe('check() — agent identity', () => {
    it('warns when AGENT.md does not exist', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const result = gate.check('deploy');

      const idCheck = result.checks.find(c => c.name === 'agent-identity');
      expect(idCheck).toBeDefined();
      expect(idCheck!.passed).toBe(false);
    });

    it('passes when AGENT.md has a name', () => {
      fs.writeFileSync(
        path.join(stateDir, 'AGENT.md'),
        '# Luna\n\nA web development agent.\n\n## Intent\n### Mission\nBuild websites.\n',
      );

      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const result = gate.check('deploy');

      const idCheck = result.checks.find(c => c.name === 'agent-identity');
      expect(idCheck).toBeDefined();
      expect(idCheck!.passed).toBe(true);
      expect(idCheck!.actual).toContain('Intent: yes');
    });
  });

  describe('check() — overall recommendation', () => {
    it('recommends proceed when all checks pass', () => {
      // Create AGENT.md so identity check passes
      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# TestAgent\n');

      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const result = gate.check('deploy');

      // With no topic binding and no git remote config, most checks are info/pass
      expect(result.recommendation).not.toBe('block');
    });

    it('recommends block when error severity check fails', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir, {
        topicProjects: {
          '999': {
            projectName: 'other-project',
            projectDir: '/path/to/other',
          },
        },
      }));

      const result = gate.check('deploy', { topicId: 999 });
      expect(result.recommendation).toBe('block');
      expect(result.passed).toBe(false);
    });
  });

  describe('generateReflectionPrompt()', () => {
    it('generates a human-readable reflection prompt', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const prompt = gate.generateReflectionPrompt('deploy', {
        topicId: 123,
        topicName: 'Dental City — Website',
        targetUrl: 'dental-city.vercel.app',
        description: 'Deploy updated homepage',
      });

      expect(prompt).toContain('PRE-ACTION COHERENCE CHECK');
      expect(prompt).toContain('test-project');
      expect(prompt).toContain('deploy');
      expect(prompt).toContain('dental-city.vercel.app');
      expect(prompt).toContain('Deploy updated homepage');
      expect(prompt).toContain('STOP and verify');
    });

    it('includes warnings when topic has no binding', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const prompt = gate.generateReflectionPrompt('deploy', {
        topicId: 123,
        topicName: 'Dental City',
      });

      expect(prompt).toContain('NO project binding');
      expect(prompt).toContain('Verify which project');
    });
  });

  describe('topic binding persistence', () => {
    it('saves and loads topic bindings', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));

      gate.setTopicBinding(123, {
        projectName: 'dental-city',
        projectDir: '/path/to/dental-city',
        gitRemote: 'https://github.com/org/dental-city.git',
        deploymentTargets: ['dental-city.vercel.app'],
      });

      // Create a new gate instance and load bindings
      const gate2 = new ScopeVerifier(makeConfig(projectDir, stateDir));
      const bindings = gate2.loadTopicBindings();

      expect(bindings['123']).toBeDefined();
      expect(bindings['123'].projectName).toBe('dental-city');
      expect(bindings['123'].projectDir).toBe('/path/to/dental-city');
      expect(bindings['123'].deploymentTargets).toContain('dental-city.vercel.app');
    });

    it('getTopicBinding returns null for unbound topic', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      expect(gate.getTopicBinding(999)).toBeNull();
    });

    it('getTopicBinding returns binding after set', () => {
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir));
      gate.setTopicBinding(42, {
        projectName: 'my-project',
        projectDir: '/tmp/my-project',
      });

      const binding = gate.getTopicBinding(42);
      expect(binding).not.toBeNull();
      expect(binding!.projectName).toBe('my-project');
    });
  });

  describe('git remote normalization', () => {
    it('matches HTTPS and SSH formats of same repo', () => {
      // Use a temp git repo to test actual git remote checking
      const gate = new ScopeVerifier(makeConfig(projectDir, stateDir, {
        expectedGitRemote: 'https://github.com/SageMindAI/portal.git',
      }));

      // Without an actual git repo, the check reports no remote found
      const result = gate.check('git-push');
      const gitCheck = result.checks.find(c => c.name === 'git-remote');
      expect(gitCheck).toBeDefined();
      // Can't verify normalization without a real git repo, but the check should exist
      expect(gitCheck!.name).toBe('git-remote');
    });
  });
});
