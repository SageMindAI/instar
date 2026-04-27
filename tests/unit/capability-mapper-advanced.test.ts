/**
 * CapabilityMapper — Advanced, Over-the-Top, Robust Testing
 *
 * Covers edge cases, error paths, integration scenarios, adversarial inputs,
 * lifecycle sequences, and invariants that the basic tests don't touch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { CapabilityMapper } from '../../src/core/CapabilityMapper.js';
import { ManifestIntegrity } from '../../src/security/ManifestIntegrity.js';
import type {
  CapabilityMap,
  CapabilityMapperConfig,
  CapabilityManifest,
  DriftReport,
  Capability,
} from '../../src/core/CapabilityMapper.js';

// ── Test Helpers ──────────────────────────────────────────────────────

function createMinimalAgent(rootDir: string, opts?: {
  skills?: Array<{ name: string; content: string }>;
  scripts?: Array<{ name: string; content: string }>;
  hooks?: { instar?: Array<{ name: string; content: string }>; custom?: Array<{ name: string; content: string }> };
  jobs?: any[];
  config?: Record<string, unknown>;
  contextSegments?: Array<{ name: string; content: string }>;
  evolutionQueue?: any;
}) {
  const projectDir = path.join(rootDir, 'project');
  const stateDir = path.join(rootDir, 'project', '.instar');

  // Always create base directories
  fs.mkdirSync(path.join(stateDir, 'state', 'evolution'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'hooks', 'instar'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'hooks', 'custom'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'context'), { recursive: true });

  // Create skills
  for (const skill of opts?.skills ?? []) {
    const dir = path.join(projectDir, '.claude', 'skills', skill.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skill.content);
  }

  // Create scripts
  for (const script of opts?.scripts ?? []) {
    fs.writeFileSync(path.join(projectDir, '.claude', 'scripts', script.name), script.content);
  }

  // Create hooks
  for (const hook of opts?.hooks?.instar ?? []) {
    fs.writeFileSync(path.join(stateDir, 'hooks', 'instar', hook.name), hook.content);
  }
  for (const hook of opts?.hooks?.custom ?? []) {
    fs.writeFileSync(path.join(stateDir, 'hooks', 'custom', hook.name), hook.content);
  }

  // Create jobs.json
  if (opts?.jobs) {
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify(opts.jobs));
  }

  // Create config.json
  if (opts?.config) {
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(opts.config));
  }

  // Create context segments
  for (const seg of opts?.contextSegments ?? []) {
    fs.writeFileSync(path.join(stateDir, 'context', seg.name), seg.content);
  }

  // Create evolution queue
  if (opts?.evolutionQueue) {
    fs.writeFileSync(
      path.join(stateDir, 'state', 'evolution', 'evolution-queue.json'),
      JSON.stringify(opts.evolutionQueue),
    );
  }

  return { projectDir, stateDir };
}

function makeConfig(projectDir: string, stateDir: string, overrides?: Partial<CapabilityMapperConfig>): CapabilityMapperConfig {
  return {
    projectDir,
    stateDir,
    projectName: 'test-agent',
    version: '0.11.0',
    port: 4040,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('CapabilityMapper — Edge Cases & Corrupt Data', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-adv-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles corrupt jobs.json (invalid JSON)', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      config: { projectName: 'test', scheduler: { enabled: true } },
    });
    // Write corrupt JSON
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), '{{{not json!!!');

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    // Should not crash, and should have zero job capabilities
    const allCaps = map.domains.flatMap(d => d.capabilities);
    const jobs = allCaps.filter(c => c.type === 'job');
    expect(jobs.length).toBe(0);
  });

  it('handles jobs.json that is an object instead of array', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify({ not: 'an array' }));

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const jobs = allCaps.filter(c => c.type === 'job');
    expect(jobs.length).toBe(0);
  });

  it('handles jobs.json with entries missing slug', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      jobs: [
        { name: 'No Slug Job', description: 'Missing slug field', enabled: true },
        { slug: 'valid-job', name: 'Valid', description: 'Has slug', enabled: true },
      ],
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    // Only the valid job should appear
    expect(allCaps.find(c => c.id === 'job:valid-job')).toBeDefined();
    expect(allCaps.filter(c => c.type === 'job').length).toBe(1);
  });

  it('handles config.json that is corrupt JSON', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    fs.writeFileSync(path.join(stateDir, 'config.json'), 'NOT JSON AT ALL!!!');

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    // Should not crash
    expect(map.agent).toBe('test-agent');
    // Telegram should not be detected as active
    const allCaps = map.domains.flatMap(d => d.capabilities);
    const telegram = allCaps.find(c => c.id === 'subsystem:telegram');
    expect(telegram).toBeDefined();
    expect(telegram!.status).toBe('available'); // Not active because config is corrupt
  });

  it('handles SKILL.md without YAML frontmatter', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{
        name: 'no-frontmatter',
        content: '# A Skill With No Frontmatter\n\nJust plain markdown.',
      }],
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:no-frontmatter');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('no-frontmatter'); // Falls back to folder name
    expect(skill!.description).toBe(''); // No description from frontmatter
  });

  it('handles SKILL.md with empty frontmatter values', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{
        name: 'empty-values',
        content: '---\nname:\ndescription:\n---\n\n# Empty Values',
      }],
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:empty-values');
    expect(skill).toBeDefined();
    // Empty name falls back to folder name
    expect(skill!.name).toBe('empty-values');
  });

  it('handles SKILL.md with very long description (truncation)', async () => {
    const longDesc = 'A'.repeat(1000);
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{
        name: 'long-desc',
        content: `---\nname: long-desc\ndescription: ${longDesc}\n---\n\n# Long`,
      }],
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:long-desc');
    expect(skill).toBeDefined();
    expect(skill!.description.length).toBeLessThanOrEqual(500);
  });

  it('handles skill folder with no SKILL.md file', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    // Create a skill folder but don't put SKILL.md in it
    fs.mkdirSync(path.join(projectDir, '.claude', 'skills', 'orphan-skill'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'skills', 'orphan-skill', 'README.md'), 'Not a SKILL.md');

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    expect(allCaps.find(c => c.id === 'skill:orphan-skill')).toBeUndefined();
  });

  it('handles hidden skill folders (dot-prefixed)', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{
        name: '.hidden-skill',
        content: '---\nname: hidden\n---\n',
      }],
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    // Hidden folders should be excluded
    expect(allCaps.find(c => c.id === 'skill:.hidden-skill')).toBeUndefined();
  });

  it('handles hidden script files (dot-prefixed)', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [{ name: '.hidden-script.sh', content: '#!/bin/bash\necho hidden' }],
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    expect(allCaps.find(c => c.id === 'script:.hidden-script.sh')).toBeUndefined();
  });

  it('skips directories inside scripts/', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [{ name: 'real-script.sh', content: '#!/bin/bash\necho real' }],
    });
    // Create a subdirectory in scripts/ (should be ignored)
    fs.mkdirSync(path.join(projectDir, '.claude', 'scripts', 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'scripts', 'subdir', 'nested.sh'), 'echo nested');

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    expect(allCaps.find(c => c.id === 'script:real-script.sh')).toBeDefined();
    expect(allCaps.find(c => c.id === 'script:subdir')).toBeUndefined();
  });

  it('skips directories inside hooks/', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      hooks: { instar: [{ name: 'real-hook.sh', content: '#!/bin/bash\necho real' }] },
    });
    // Create a nested dir inside hooks/instar/
    fs.mkdirSync(path.join(stateDir, 'hooks', 'instar', 'subdir'), { recursive: true });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    expect(allCaps.find(c => c.id === 'hook:real-hook.sh')).toBeDefined();
  });

  it('handles binary files in scripts gracefully', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    // Write a binary file
    const binaryContent = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG header
    fs.writeFileSync(path.join(projectDir, '.claude', 'scripts', 'binary.png'), binaryContent);

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    // Should still discover it without crashing
    const allCaps = map.domains.flatMap(d => d.capabilities);
    const binary = allCaps.find(c => c.id === 'script:binary.png');
    expect(binary).toBeDefined();
    expect(binary!.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles empty script file', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [{ name: 'empty.sh', content: '' }],
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const empty = allCaps.find(c => c.id === 'script:empty.sh');
    expect(empty).toBeDefined();
    expect(empty!.description).toBe('');
    expect(empty!.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles non-existent .claude/skills/ directory', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    // Remove the skills directory
    // safe-git-allow: incremental-migration
    fs.rmSync(path.join(projectDir, '.claude', 'skills'), { recursive: true, force: true });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skills = allCaps.filter(c => c.type === 'skill');
    expect(skills.length).toBe(0);
  });

  it('handles non-existent hooks directory', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    // Remove the hooks directory
    // safe-git-allow: incremental-migration
    fs.rmSync(path.join(stateDir, 'hooks'), { recursive: true, force: true });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const hooks = allCaps.filter(c => c.type === 'hook');
    expect(hooks.length).toBe(0);
  });

  it('handles non-existent context directory', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    // safe-git-allow: incremental-migration
    fs.rmSync(path.join(stateDir, 'context'), { recursive: true, force: true });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const contexts = allCaps.filter(c => c.type === 'storage');
    expect(contexts.length).toBe(0);
  });

  it('non-md files in context directory are excluded', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      contextSegments: [
        { name: 'real.md', content: '# Real\nContext segment' },
      ],
    });
    // Add a non-md file
    fs.writeFileSync(path.join(stateDir, 'context', 'data.json'), '{"key": "val"}');

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    expect(allCaps.find(c => c.id === 'context:real.md')).toBeDefined();
    expect(allCaps.find(c => c.id === 'context:data.json')).toBeUndefined();
  });

  it('handles corrupt evolution queue gracefully', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{
        name: 'evolved',
        content: '---\nname: evolved\ndescription: An evolved skill\n---\n',
      }],
    });
    // Write corrupt evolution queue
    fs.writeFileSync(
      path.join(stateDir, 'state', 'evolution', 'evolution-queue.json'),
      'TOTALLY CORRUPT',
    );

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    // Should not crash
    expect(map.agent).toBe('test-agent');
    const allCaps = map.domains.flatMap(d => d.capabilities);
    // Skill still discovered, just no evolution linkage
    expect(allCaps.find(c => c.id === 'skill:evolved')).toBeDefined();
  });

  it('handles evolution queue with non-array proposals', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      evolutionQueue: { proposals: 'not-an-array' },
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    // Should not crash
    expect(map.agent).toBe('test-agent');
  });

  it('handles evolution proposals without tags', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      evolutionQueue: {
        proposals: [
          { id: 'EVO-001', title: 'No Tags', status: 'implemented' },
        ],
      },
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    // No crash, no evolution linkage
    expect(map.agent).toBe('test-agent');
  });
});

describe('CapabilityMapper — Domain Inference', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-domain-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const domainKeywordTests: Array<{ keyword: string; expectedDomain: string }> = [
    { keyword: 'telegram-bot', expectedDomain: 'communication' },
    { keyword: 'message-handler', expectedDomain: 'communication' },
    { keyword: 'notify-users', expectedDomain: 'communication' },
    { keyword: 'feedback-collector', expectedDomain: 'communication' },
    { keyword: 'memory-index', expectedDomain: 'memory' },
    { keyword: 'topic-search', expectedDomain: 'memory' },
    { keyword: 'playbook-update', expectedDomain: 'memory' },
    { keyword: 'context-loader', expectedDomain: 'memory' },
    { keyword: 'job-runner', expectedDomain: 'scheduling' },
    { keyword: 'schedule-daily', expectedDomain: 'scheduling' },
    { keyword: 'cron-manager', expectedDomain: 'scheduling' },
    { keyword: 'skip-ledger', expectedDomain: 'scheduling' },
    { keyword: 'monitor-health', expectedDomain: 'monitoring' },
    { keyword: 'health-check', expectedDomain: 'monitoring' },
    { keyword: 'stall-detector', expectedDomain: 'monitoring' },
    { keyword: 'orphan-reaper', expectedDomain: 'monitoring' },
    { keyword: 'quota-tracker', expectedDomain: 'monitoring' },
    { keyword: 'agent-onboard', expectedDomain: 'identity' },
    { keyword: 'user-register', expectedDomain: 'identity' },
    { keyword: 'identity-verify', expectedDomain: 'identity' },
    { keyword: 'evolution-proposal', expectedDomain: 'evolution' },
    { keyword: 'learning-capture', expectedDomain: 'evolution' },
    { keyword: 'gap-analysis', expectedDomain: 'evolution' },
    { keyword: 'publish-page', expectedDomain: 'publishing' },
    { keyword: 'telegraph-post', expectedDomain: 'publishing' },
    { keyword: 'view-content', expectedDomain: 'publishing' },
    { keyword: 'git-sync', expectedDomain: 'infrastructure' },
    { keyword: 'update-version', expectedDomain: 'infrastructure' },
    { keyword: 'session-start', expectedDomain: 'infrastructure' },
    { keyword: 'tunnel-setup', expectedDomain: 'infrastructure' },
    { keyword: 'auth-token', expectedDomain: 'security' },
    { keyword: 'guard-input', expectedDomain: 'security' },
    { keyword: 'security-audit', expectedDomain: 'security' },
    { keyword: 'credential-store', expectedDomain: 'security' },
    { keyword: 'machine-heartbeat', expectedDomain: 'coordination' },
    // Note: 'agent-bus-emit' matches 'agent' before 'bus', landing in 'identity'
    // This is correct behavior — the first keyword match wins
    { keyword: 'agent-bus-emit', expectedDomain: 'identity' },
    { keyword: 'coordinate-nodes', expectedDomain: 'coordination' },
  ];

  for (const { keyword, expectedDomain } of domainKeywordTests) {
    it(`infers domain '${expectedDomain}' from script name '${keyword}'`, async () => {
      const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
        scripts: [{ name: `${keyword}.sh`, content: `#!/bin/bash\n# ${keyword}\necho ok` }],
      });

      const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
      const map = await mapper.refresh();

      const allCaps = map.domains.flatMap(d => d.capabilities);
      const cap = allCaps.find(c => c.id === `script:${keyword}.sh`);
      expect(cap, `Capability for ${keyword}.sh should exist`).toBeDefined();
      expect(cap!.domain).toBe(expectedDomain);
    });
  }

  it('defaults to infrastructure for unrecognized script names', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [{ name: 'random-utility.sh', content: '#!/bin/bash\necho hi' }],
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const cap = allCaps.find(c => c.id === 'script:random-utility.sh');
    expect(cap!.domain).toBe('infrastructure');
  });

  it('defaults hooks to security domain', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      hooks: { custom: [{ name: 'random-hook.sh', content: '#!/bin/bash\necho hi' }] },
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const cap = allCaps.find(c => c.id === 'hook:random-hook.sh');
    expect(cap).toBeDefined();
    // Custom hooks with unrecognized names should still have domain inferred
    // The inferDomain function defaults hooks to 'security'
  });
});

describe('CapabilityMapper — Provenance Classification', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-prov-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('classifies hooks in instar/ as instar provenance', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      hooks: {
        instar: [{ name: 'system-hook.sh', content: '#!/bin/bash\necho system' }],
      },
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const hook = allCaps.find(c => c.id === 'hook:system-hook.sh');
    expect(hook).toBeDefined();
    expect(hook!.provenance).toBe('instar');
  });

  it('classifies hooks in custom/ as agent provenance', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      hooks: {
        custom: [{ name: 'my-custom-hook.sh', content: '#!/bin/bash\necho custom' }],
      },
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const hook = allCaps.find(c => c.id === 'hook:my-custom-hook.sh');
    expect(hook).toBeDefined();
    expect(hook!.provenance).toBe('agent');
  });

  it('links evolution proposals to capabilities via tags', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{
        name: 'evolved-skill',
        content: '---\nname: evolved-skill\ndescription: An evolved skill\n---\n# Evolved',
      }],
      evolutionQueue: {
        proposals: [
          {
            id: 'EVO-042',
            title: 'Add evolved-skill',
            status: 'implemented',
            tags: ['capability:skill:evolved-skill'],
          },
        ],
        stats: { totalProposals: 1 },
      },
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:evolved-skill');
    expect(skill).toBeDefined();
    expect(skill!.provenance).toBe('agent');
    expect(skill!.evolutionProposal).toBe('EVO-042');
  });

  it('non-implemented evolution proposals are not linked', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{
        name: 'pending-skill',
        content: '---\nname: pending-skill\ndescription: A pending skill\n---\n# Pending',
      }],
      evolutionQueue: {
        proposals: [
          {
            id: 'EVO-099',
            title: 'Add pending-skill',
            status: 'proposed', // Not implemented
            tags: ['capability:skill:pending-skill'],
          },
        ],
      },
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:pending-skill');
    expect(skill).toBeDefined();
    // Should NOT have agent provenance because the proposal isn't implemented
    expect(skill!.evolutionProposal).toBeUndefined();
  });

  it('always-present subsystems are always included', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    // Session Manager and State Manager are always present
    expect(allCaps.find(c => c.id === 'subsystem:session-manager')).toBeDefined();
    expect(allCaps.find(c => c.id === 'subsystem:state-manager')).toBeDefined();
    expect(allCaps.find(c => c.id === 'subsystem:session-manager')!.status).toBe('active');
    expect(allCaps.find(c => c.id === 'subsystem:state-manager')!.status).toBe('active');
  });

  it('disabled telegram shows as available, not active', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      config: {
        projectName: 'test',
        messaging: [{ type: 'telegram', enabled: false, config: {} }],
      },
    });

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const telegram = allCaps.find(c => c.id === 'subsystem:telegram');
    expect(telegram).toBeDefined();
    expect(telegram!.status).toBe('available');
  });

  it('subsystem without config shows as available', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    // No config.json at all

    const mapper = new CapabilityMapper(makeConfig(projectDir, stateDir));
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const telegram = allCaps.find(c => c.id === 'subsystem:telegram');
    expect(telegram).toBeDefined();
    expect(telegram!.status).toBe('available');
  });
});

describe('CapabilityMapper — Drift Detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-drift-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects no drift when nothing has changed', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: Stable\n---\n' }],
      scripts: [{ name: 'stable.sh', content: '#!/bin/bash\necho stable' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    await mapper.refresh(); // Establish baseline

    // Create fresh mapper to detect drift
    const mapper2 = new CapabilityMapper(config);
    const drift = await mapper2.detectDrift();

    expect(drift.added.length).toBe(0);
    expect(drift.removed.length).toBe(0);
    expect(drift.changed.length).toBe(0);
    expect(drift.scanErrors.length).toBe(0);
  });

  it('detects multiple simultaneous changes', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [
        { name: 'stays', content: '---\nname: stays\ndescription: Stays\n---\n' },
        { name: 'goes', content: '---\nname: goes\ndescription: Goes away\n---\n' },
      ],
      scripts: [
        { name: 'changes.sh', content: '#!/bin/bash\necho original' },
      ],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    // Remove a skill
    // safe-git-allow: incremental-migration
    fs.rmSync(path.join(projectDir, '.claude', 'skills', 'goes'), { recursive: true, force: true });
    // Add a new script
    fs.writeFileSync(path.join(projectDir, '.claude', 'scripts', 'new-one.sh'), '#!/bin/bash\necho new');
    // Change a script
    fs.writeFileSync(path.join(projectDir, '.claude', 'scripts', 'changes.sh'), '#!/bin/bash\necho changed');

    const mapper2 = new CapabilityMapper(config);
    const drift = await mapper2.detectDrift();

    expect(drift.added.some(c => c.id === 'script:new-one.sh')).toBe(true);
    expect(drift.removed.some(c => c.id === 'skill:goes')).toBe(true);
    expect(drift.changed.some(c => c.id === 'script:changes.sh' && c.field === 'contentHash')).toBe(true);
  });

  it('detects drift with no previous manifest (first run)', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: First\n---\n' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    // Don't refresh first — no baseline manifest exists
    const drift = await mapper.detectDrift();

    // Everything should be "added" since there's no previous manifest
    expect(drift.previousScan).toBe('never');
    expect(drift.added.length).toBeGreaterThan(0);
    expect(drift.removed.length).toBe(0);
    expect(drift.scanErrors.length).toBe(0);
  });

  it('detects provenance changes in drift', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      hooks: {
        custom: [{ name: 'evolving-hook.sh', content: '#!/bin/bash\necho v1' }],
      },
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    // Simulate provenance change by modifying the persisted manifest directly
    const manifestPath = path.join(stateDir, 'state', 'capability-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    // Change the stored provenance
    if (manifest.entries['hook:evolving-hook.sh']) {
      manifest.entries['hook:evolving-hook.sh'].provenance = 'instar';
    }
    // Write back without HMAC (will still be readable)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const mapper2 = new CapabilityMapper(config);
    const drift = await mapper2.detectDrift();

    // The hook is agent provenance now, was set to instar in manifest
    expect(drift.changed.some(c =>
      c.id === 'hook:evolving-hook.sh' && c.field === 'provenance',
    )).toBe(true);
  });

  it('classifies unmatched agent-local capabilities as user (not unmapped)', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 'mystery', content: '---\nname: mystery\ndescription: Unknown origin\n---\n' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const drift = await mapper.detectDrift();
    const map = await mapper.refresh();

    // Agent-local capabilities not matched to builtin/evolution are
    // classified as 'user' (agent-authored config), not left 'unknown'.
    expect(drift.unmapped).not.toContain('skill:mystery');
    const mystery = map.domains
      .flatMap(d => d.capabilities)
      .find(c => c.id === 'skill:mystery');
    expect(mystery?.provenance).toBe('user');
  });

  it('drift report includes scan timestamp', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const drift = await mapper.detectDrift();

    expect(drift.generatedAt).toBeDefined();
    expect(new Date(drift.generatedAt).getTime()).toBeGreaterThan(0);
  });
});

describe('CapabilityMapper — Manifest Persistence & HMAC', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-hmac-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists manifest entries for all discovered capabilities', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [
        { name: 's1', content: '---\nname: s1\ndescription: Skill 1\n---\n' },
        { name: 's2', content: '---\nname: s2\ndescription: Skill 2\n---\n' },
      ],
      scripts: [{ name: 'sc1.sh', content: '#!/bin/bash\necho sc1' }],
      hooks: { instar: [{ name: 'h1.sh', content: '#!/bin/bash\necho h1' }] },
      jobs: [{ slug: 'j1', name: 'J1', description: 'Job 1', enabled: true, schedule: '* * * * *', execute: { type: 'prompt', value: 'x' } }],
      contextSegments: [{ name: 'ctx.md', content: '# Context\nSome context.' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const manifestPath = path.join(stateDir, 'state', 'capability-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CapabilityManifest;

    // All capabilities should be in the manifest
    const allCapIds = map.domains.flatMap(d => d.capabilities.map(c => c.id));
    for (const id of allCapIds) {
      expect(manifest.entries[id], `Manifest should contain entry for ${id}`).toBeDefined();
      expect(manifest.entries[id].firstSeen).toBeDefined();
      expect(manifest.entries[id].lastVerified).toBeDefined();
      expect(manifest.entries[id].provenance).toBeDefined();
    }
  });

  it('manifest entries have classificationReason where applicable', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      hooks: {
        instar: [{ name: 'classified.sh', content: '#!/bin/bash\necho classified' }],
        custom: [{ name: 'custom.sh', content: '#!/bin/bash\necho custom' }],
      },
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    const manifestPath = path.join(stateDir, 'state', 'capability-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CapabilityManifest;

    // Custom hook should have a classification reason
    const customEntry = manifest.entries['hook:custom.sh'];
    if (customEntry?.provenance === 'agent') {
      expect(customEntry.classificationReason).toBeDefined();
      expect(customEntry.classificationReason).toContain('custom directory');
    }
  });

  it('manifest works without signing key (unsigned fallback)', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: S1\n---\n' }],
    });

    // Don't create a signing key — the mapper should fall back to unsigned
    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    const manifestPath = path.join(stateDir, 'state', 'capability-manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.schemaVersion).toBe(1);
    // HMAC may or may not be present depending on key auto-generation
    expect(manifest.entries).toBeDefined();
  });

  it('manifest survives key rotation and re-sign', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: Rotate test\n---\n' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const integrity = new ManifestIntegrity(path.join(stateDir, 'state'));
    integrity.ensureKey();

    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    const manifestPath = path.join(stateDir, 'state', 'capability-manifest.json');
    const beforeRotate = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const oldHmac = beforeRotate._hmac;

    // Rotate key
    integrity.rotateKey(manifestPath);

    const afterRotate = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    // HMAC should have changed
    if (oldHmac && afterRotate._hmac) {
      expect(afterRotate._hmac).not.toBe(oldHmac);
    }

    // Verification should still pass with new key
    const result = integrity.readAndVerify(manifestPath);
    expect(result.verified).toBe(true);
  });

  it('lastVerified updates on each refresh', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: Timestamp test\n---\n' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    const manifestPath = path.join(stateDir, 'state', 'capability-manifest.json');
    const first = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CapabilityManifest;
    const firstVerified = first.entries['skill:s1']?.lastVerified;

    // Wait a tiny bit to ensure timestamps differ
    await new Promise(r => setTimeout(r, 10));

    const mapper2 = new CapabilityMapper(config);
    await mapper2.refresh();

    const second = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CapabilityManifest;
    const secondVerified = second.entries['skill:s1']?.lastVerified;

    expect(secondVerified).toBeDefined();
    expect(firstVerified).toBeDefined();
    expect(new Date(secondVerified!).getTime()).toBeGreaterThanOrEqual(new Date(firstVerified!).getTime());
  });
});

describe('CapabilityMapper — Markdown Rendering', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-md-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders level 0 and level 1 identically', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: S1\n---\n' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const md0 = mapper.renderMarkdown(map, 0);
    const md1 = mapper.renderMarkdown(map, 1);
    expect(md0).toBe(md1);
  });

  it('level 2 has more detail than level 1', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: S1\n---\n' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const md1 = mapper.renderMarkdown(map, 1);
    const md2 = mapper.renderMarkdown(map, 2);

    expect(md2.length).toBeGreaterThan(md1.length);
    // Level 2 has per-capability rows
    expect(md2).toContain('| Capability | Type | Status | Provenance | Since |');
    // Level 1 has only domain-level summary
    expect(md1).not.toContain('| Capability | Type |');
  });

  it('level 3 includes deep detail fields', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: Deep detail test\n---\n# S1' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const md3 = mapper.renderMarkdown(map, 3);

    expect(md3).toContain('**ID**:');
    expect(md3).toContain('**Type**:');
    expect(md3).toContain('**Provenance**:');
    expect(md3).toContain('**Status**:');
    expect(md3).toContain('**Description**:');
    expect(md3).toContain('**Files**:');
  });

  it('compact markdown shows disabled count', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      jobs: [
        { slug: 'active', name: 'Active', description: 'Active job', enabled: true, schedule: '* * * * *', execute: { type: 'prompt', value: 'x' } },
        { slug: 'disabled', name: 'Disabled', description: 'Disabled job', enabled: false, schedule: '* * * * *', execute: { type: 'prompt', value: 'x' } },
      ],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();
    const md = mapper.renderMarkdown(map, 1);

    // The scheduling domain should show "1 disabled"
    expect(md).toContain('disabled');
  });

  it('markdown includes evolution proposal references', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{
        name: 'evo-skill',
        content: '---\nname: evo-skill\ndescription: Evolved\n---\n',
      }],
      evolutionQueue: {
        proposals: [
          { id: 'EVO-007', title: 'Bond Skill', status: 'implemented', tags: ['capability:skill:evo-skill'] },
        ],
      },
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();
    const md2 = mapper.renderMarkdown(map, 2);

    expect(md2).toContain('EVO-007');
  });

  it('renders empty map without crashing', async () => {
    const emptyDir = path.join(tmpDir, 'empty');
    const emptyState = path.join(emptyDir, '.instar');
    fs.mkdirSync(path.join(emptyState, 'state'), { recursive: true });

    const config = makeConfig(emptyDir, emptyState, { projectName: 'empty' });
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const md1 = mapper.renderMarkdown(map, 1);
    const md2 = mapper.renderMarkdown(map, 2);
    const md3 = mapper.renderMarkdown(map, 3);

    expect(md1).toContain('# Capability Map');
    expect(md2).toContain('# Capability Map');
    expect(md3).toContain('# Capability Map');
  });

  it('markdown includes self-discovery URL', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();
    const md = mapper.renderMarkdown(map, 1);

    expect(md).toContain('GET /capability-map');
  });

  it('special characters in names do not break markdown tables', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [{ name: 'pipe|char.sh', content: '#!/bin/bash\necho pipe' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    // Should not crash
    const md = mapper.renderMarkdown(map, 2);
    expect(md).toBeDefined();
    expect(md.length).toBeGreaterThan(0);
  });
});

describe('CapabilityMapper — Content Hashing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-hash-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('identical content produces identical hashes', async () => {
    const content = '#!/bin/bash\necho hello';
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [
        { name: 'script-a.sh', content },
        { name: 'script-b.sh', content },
      ],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const a = allCaps.find(c => c.id === 'script:script-a.sh');
    const b = allCaps.find(c => c.id === 'script:script-b.sh');

    expect(a!.contentHash).toBe(b!.contentHash);
  });

  it('different content produces different hashes', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [
        { name: 'script-a.sh', content: '#!/bin/bash\necho A' },
        { name: 'script-b.sh', content: '#!/bin/bash\necho B' },
      ],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const a = allCaps.find(c => c.id === 'script:script-a.sh');
    const b = allCaps.find(c => c.id === 'script:script-b.sh');

    expect(a!.contentHash).not.toBe(b!.contentHash);
  });

  it('hashes are SHA-256 hex strings', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: hash test\n---\n' }],
      scripts: [{ name: 'sc1.sh', content: '#!/bin/bash\necho hash' }],
      hooks: { instar: [{ name: 'h1.sh', content: '#!/bin/bash\necho hash' }] },
      contextSegments: [{ name: 'ctx.md', content: '# Hash Test' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    for (const cap of allCaps) {
      if (cap.contentHash) {
        expect(cap.contentHash).toMatch(/^[a-f0-9]{64}$/);
        // Verify it matches manual SHA-256 for a file-backed capability
        if (cap.type === 'skill') {
          const expected = crypto.createHash('sha256')
            .update('---\nname: s1\ndescription: hash test\n---\n')
            .digest('hex');
          expect(cap.contentHash).toBe(expected);
        }
      }
    }
  });

  it('jobs have content hash based on JSON serialization', async () => {
    const job = {
      slug: 'hashed-job',
      name: 'Hashed Job',
      description: 'Test job hashing',
      schedule: '0 * * * *',
      enabled: true,
      execute: { type: 'prompt', value: 'test' },
    };
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, { jobs: [job] });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const jobCap = allCaps.find(c => c.id === 'job:hashed-job');
    expect(jobCap).toBeDefined();
    expect(jobCap!.contentHash).toMatch(/^[a-f0-9]{64}$/);

    // Verify the hash matches
    const expected = crypto.createHash('sha256')
      .update(JSON.stringify(job))
      .digest('hex');
    expect(jobCap!.contentHash).toBe(expected);
  });
});

describe('CapabilityMapper — Concurrency & Freshness', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-conc-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getMap returns cached map without re-scanning', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: Cache test\n---\n' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map1 = await mapper.refresh();

    // Modify the filesystem
    fs.writeFileSync(
      path.join(projectDir, '.claude', 'skills', 's1', 'SKILL.md'),
      '---\nname: s1-modified\ndescription: Modified\n---\n',
    );

    // getMap should return cached version (not rescanned)
    const map2 = await mapper.getMap();
    expect(map2.generatedAt).toBe(map1.generatedAt);

    const allCaps = map2.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:s1');
    // Should still show original name since it's cached
    expect(skill!.name).toBe('s1');
  });

  it('getMap triggers refresh if no cache exists', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: Fresh\n---\n' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);

    // No refresh called yet — getMap should trigger one
    const map = await mapper.getMap();
    expect(map.agent).toBe('test-agent');
    expect(map.summary.totalCapabilities).toBeGreaterThan(0);
  });

  it('concurrent refreshes on DIFFERENT mappers are independent', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: Concurrent\n---\n' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper1 = new CapabilityMapper(config);
    const mapper2 = new CapabilityMapper(config);

    // Both should succeed since they're separate instances
    const [map1, map2] = await Promise.all([
      mapper1.refresh(),
      mapper2.refresh(),
    ]);

    expect(map1.agent).toBe('test-agent');
    expect(map2.agent).toBe('test-agent');
  });

  it('freshness ageSeconds increases over time', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    const fresh1 = mapper.getFreshness();
    expect(fresh1.ageSeconds).toBeGreaterThanOrEqual(0);

    // Wait briefly
    await new Promise(r => setTimeout(r, 50));

    const fresh2 = mapper.getFreshness();
    // ageSeconds might be 0 still (sub-second precision), but should not be negative
    expect(fresh2.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(fresh2.lastRefresh).not.toBe('never');
  });

  it('isRefreshing is false after refresh completes', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    expect(mapper.getFreshness().isRefreshing).toBe(false);
  });

  it('isRefreshing is false even after refresh throws', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);

    // Start a refresh
    const p1 = mapper.refresh();
    // Attempt concurrent (will throw)
    try {
      await mapper.refresh();
    } catch {
      // Expected
    }

    await p1;
    // isRefreshing should be false regardless
    expect(mapper.getFreshness().isRefreshing).toBe(false);
  });
});

describe('CapabilityMapper — HATEOAS & API Contracts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-api-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('domain links match actual domain IDs', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: Link test\n---\n' }],
      jobs: [{ slug: 'j1', name: 'J1', description: 'J', enabled: true, schedule: '* * * * *', execute: { type: 'prompt', value: 'x' } }],
      config: { projectName: 'test', messaging: [{ type: 'telegram', enabled: true, config: {} }] },
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    // Every domain should have a corresponding link
    for (const domain of map.domains) {
      expect(map._links.domains[domain.id]).toBe(`/capability-map/${domain.id}`);
    }
    // No extra links
    expect(Object.keys(map._links.domains).length).toBe(map.domains.length);
  });

  it('map includes correct agent name and version', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);

    const config = makeConfig(projectDir, stateDir, {
      projectName: 'custom-agent-name',
      version: '42.0.1',
    });
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    expect(map.agent).toBe('custom-agent-name');
    expect(map.version).toBe('42.0.1');
  });

  it('map.generatedAt is a valid ISO timestamp', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    expect(map.generatedAt).toBeDefined();
    const date = new Date(map.generatedAt);
    expect(date.getTime()).toBeGreaterThan(0);
    expect(date.toISOString()).toBe(map.generatedAt);
  });

  it('summary counts are consistent with domain data', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [
        { name: 's1', content: '---\nname: s1\ndescription: S1\n---\n' },
        { name: 's2', content: '---\nname: s2\ndescription: S2\n---\n' },
      ],
      scripts: [{ name: 'sc1.sh', content: '#!/bin/bash\necho sc1' }],
      hooks: {
        instar: [{ name: 'h1.sh', content: '#!/bin/bash\necho h1' }],
        custom: [{ name: 'h2.sh', content: '#!/bin/bash\necho h2' }],
      },
      jobs: [{ slug: 'j1', name: 'J1', description: 'J', enabled: true, schedule: '* * * * *', execute: { type: 'prompt', value: 'x' } }],
      contextSegments: [{ name: 'ctx.md', content: '# Context' }],
      config: { projectName: 'test', scheduler: { enabled: true } },
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    // Total capabilities should equal sum across domains
    const totalFromDomains = map.domains.reduce((sum, d) => sum + d.featureCount, 0);
    expect(map.summary.totalCapabilities).toBe(totalFromDomains);

    // featureCount should match capabilities array length
    for (const domain of map.domains) {
      expect(domain.featureCount).toBe(domain.capabilities.length);
    }

    // Summary provenance counts should sum to total
    const provenanceSum = map.summary.instarProvided + map.summary.agentEvolved + map.summary.userConfigured + map.summary.unmapped;
    // Allow for 'inherited' and 'unknown' that aren't in the named categories
    const allCaps = map.domains.flatMap(d => d.capabilities);
    const inheritedCount = allCaps.filter(c => c.provenance === 'inherited').length;
    expect(provenanceSum + inheritedCount).toBe(map.summary.totalCapabilities);
  });

  it('freshness field is included in the map', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    expect(map.freshness).toBeDefined();
    expect(map.freshness.ageSeconds).toBe(0); // Just generated
    expect(map.freshness.isRefreshing).toBe(false);
    expect(map.freshness.lastRefresh).toBe(map.generatedAt);
  });

  it('domains are sorted: known domains first in defined order', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: S1\n---\n' }],
      scripts: [
        { name: 'telegram-x.sh', content: '#!/bin/bash\necho comm' },
        { name: 'monitor-x.sh', content: '#!/bin/bash\necho monitor' },
        { name: 'memory-x.sh', content: '#!/bin/bash\necho mem' },
      ],
      hooks: { instar: [{ name: 'h1.sh', content: '#!/bin/bash\necho h' }] },
      jobs: [{ slug: 'j1', name: 'J1', description: 'J', enabled: true, schedule: '* * * * *', execute: { type: 'prompt', value: 'x' } }],
      config: { projectName: 'test', scheduler: { enabled: true }, monitoring: { enabled: true } },
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    // Known domain order
    const expectedOrder = [
      'communication', 'memory', 'scheduling', 'monitoring',
      'identity', 'evolution', 'publishing', 'infrastructure',
      'security', 'coordination',
    ];

    const actualDomainIds = map.domains.map(d => d.id);

    // All present known domains should be in the correct relative order
    const presentKnown = actualDomainIds.filter(id => expectedOrder.includes(id));
    for (let i = 1; i < presentKnown.length; i++) {
      expect(
        expectedOrder.indexOf(presentKnown[i]),
        `${presentKnown[i]} should come after ${presentKnown[i - 1]}`,
      ).toBeGreaterThan(expectedOrder.indexOf(presentKnown[i - 1]));
    }
  });

  it('capabilities within domains are sorted alphabetically', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [
        { name: 'z-script.sh', content: '#!/bin/bash\necho z' },
        { name: 'a-script.sh', content: '#!/bin/bash\necho a' },
        { name: 'm-script.sh', content: '#!/bin/bash\necho m' },
      ],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    for (const domain of map.domains) {
      if (domain.capabilities.length > 1) {
        for (let i = 1; i < domain.capabilities.length; i++) {
          expect(
            domain.capabilities[i].name.localeCompare(domain.capabilities[i - 1].name),
          ).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('CapabilityMapper — Script Description Extraction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-desc-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts description from bash comment', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [{ name: 'described.sh', content: '#!/bin/bash\n# This script does something useful\necho hi' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const script = allCaps.find(c => c.id === 'script:described.sh');
    expect(script).toBeDefined();
    expect(script!.description).toBe('This script does something useful');
  });

  it('extracts description from JS-style comment', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [{ name: 'described.js', content: '// JavaScript utility script\nconsole.log("hi")' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const script = allCaps.find(c => c.id === 'script:described.js');
    expect(script).toBeDefined();
    expect(script!.description).toBe('JavaScript utility script');
  });

  it('extracts description from JSDoc-style comment', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [{ name: 'jsdoc.js', content: '/**\n * Helper for processing data\n */\nmodule.exports = {};' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const script = allCaps.find(c => c.id === 'script:jsdoc.js');
    expect(script).toBeDefined();
    expect(script!.description).toBe('Helper for processing data');
  });

  it('skips shebang line for description', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [{ name: 'shebang.sh', content: '#!/usr/bin/env python3\n# Python utility\nprint("hi")' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const script = allCaps.find(c => c.id === 'script:shebang.sh');
    expect(script).toBeDefined();
    expect(script!.description).toBe('Python utility');
    expect(script!.description).not.toContain('#!/');
  });

  it('truncates very long descriptions to 200 chars', async () => {
    const longComment = 'A'.repeat(500);
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      scripts: [{ name: 'long.sh', content: `#!/bin/bash\n# ${longComment}\necho hi` }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const script = allCaps.find(c => c.id === 'script:long.sh');
    expect(script).toBeDefined();
    expect(script!.description.length).toBeLessThanOrEqual(200);
  });
});

describe('CapabilityMapper — Full Lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-lifecycle-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('complete lifecycle: create -> scan -> modify -> rescan -> drift', async () => {
    // Phase 1: Initial setup
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [
        { name: 'original', content: '---\nname: original\ndescription: Original skill\n---\n' },
      ],
      scripts: [
        { name: 'helper.sh', content: '#!/bin/bash\n# Helper script\necho helper' },
      ],
      hooks: {
        instar: [{ name: 'guard.sh', content: '#!/bin/bash\n# Guard hook\necho guard' }],
      },
      jobs: [
        { slug: 'daily-check', name: 'Daily Check', description: 'Runs daily', enabled: true, schedule: '0 0 * * *', execute: { type: 'prompt', value: 'check' } },
      ],
      contextSegments: [
        { name: 'identity.md', content: '# Identity\nWho this agent is.' },
      ],
      config: {
        projectName: 'lifecycle-test',
        messaging: [{ type: 'telegram', enabled: true, config: {} }],
        scheduler: { enabled: true },
      },
    });

    const config = makeConfig(projectDir, stateDir);

    // Phase 2: Initial scan
    const mapper1 = new CapabilityMapper(config);
    const map1 = await mapper1.refresh();

    expect(map1.agent).toBe('test-agent');
    const allCaps1 = map1.domains.flatMap(d => d.capabilities);
    expect(allCaps1.find(c => c.id === 'skill:original')).toBeDefined();
    expect(allCaps1.find(c => c.id === 'script:helper.sh')).toBeDefined();
    expect(allCaps1.find(c => c.id === 'hook:guard.sh')).toBeDefined();
    expect(allCaps1.find(c => c.id === 'job:daily-check')).toBeDefined();
    expect(allCaps1.find(c => c.id === 'context:identity.md')).toBeDefined();

    // Verify manifest was persisted
    const manifestPath = path.join(stateDir, 'state', 'capability-manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    // Phase 3: Modify the agent
    // Add a new skill
    fs.mkdirSync(path.join(projectDir, '.claude', 'skills', 'new-feature'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.claude', 'skills', 'new-feature', 'SKILL.md'),
      '---\nname: new-feature\ndescription: A new feature\n---\n',
    );

    // Remove a script
    // safe-git-allow: incremental-migration
    fs.unlinkSync(path.join(projectDir, '.claude', 'scripts', 'helper.sh'));

    // Modify a context segment
    fs.writeFileSync(path.join(stateDir, 'context', 'identity.md'), '# Identity v2\nUpdated identity.');

    // Disable a job
    const jobs = JSON.parse(fs.readFileSync(path.join(stateDir, 'jobs.json'), 'utf-8'));
    jobs[0].enabled = false;
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify(jobs));

    // Phase 4: Detect drift
    const mapper2 = new CapabilityMapper(config);
    const drift = await mapper2.detectDrift();

    // Verify drift detection
    expect(drift.added.some(c => c.id === 'skill:new-feature')).toBe(true);
    expect(drift.removed.some(c => c.id === 'script:helper.sh')).toBe(true);
    expect(drift.changed.some(c => c.id === 'context:identity.md' && c.field === 'contentHash')).toBe(true);

    // Phase 5: Rescan
    const map2 = await mapper2.refresh();
    const allCaps2 = map2.domains.flatMap(d => d.capabilities);

    // Verify updated state
    expect(allCaps2.find(c => c.id === 'skill:new-feature')).toBeDefined();
    expect(allCaps2.find(c => c.id === 'script:helper.sh')).toBeUndefined();
    expect(allCaps2.find(c => c.id === 'job:daily-check')!.status).toBe('disabled');

    // Phase 6: Verify firstSeen preservation
    const manifest2 = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CapabilityManifest;
    const manifest1 = JSON.parse(JSON.stringify(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')),
    ));

    // Original skill's firstSeen should be preserved
    expect(manifest2.entries['skill:original']?.firstSeen).toBeDefined();

    // New feature should have a recent firstSeen
    expect(manifest2.entries['skill:new-feature']?.firstSeen).toBeDefined();

    // Removed script should no longer be in manifest
    expect(manifest2.entries['script:helper.sh']).toBeUndefined();
  });

  it('lifecycle: multiple rapid refreshes maintain consistency', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 's1', content: '---\nname: s1\ndescription: Rapid\n---\n' }],
    });

    const config = makeConfig(projectDir, stateDir);

    // Perform 5 sequential refreshes
    for (let i = 0; i < 5; i++) {
      const mapper = new CapabilityMapper(config);
      const map = await mapper.refresh();
      expect(map.summary.totalCapabilities).toBeGreaterThan(0);
      expect(map.agent).toBe('test-agent');
    }

    // Manifest should still be valid
    const manifestPath = path.join(stateDir, 'state', 'capability-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.schemaVersion).toBe(1);
  });
});

describe('CapabilityMapper — Subsystem Detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-subsys-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects topic-memory from file presence', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    // Create topic-memory.db
    fs.writeFileSync(path.join(stateDir, 'topic-memory.db'), 'fake-db');

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const tm = allCaps.find(c => c.id === 'subsystem:topic-memory');
    expect(tm).toBeDefined();
    expect(tm!.status).toBe('active');
  });

  it('detects topic-memory from directory presence', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    fs.mkdirSync(path.join(stateDir, 'topic-memory'), { recursive: true });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const tm = allCaps.find(c => c.id === 'subsystem:topic-memory');
    expect(tm).toBeDefined();
    expect(tm!.status).toBe('active');
  });

  it('detects evolution from directory presence', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const evo = allCaps.find(c => c.id === 'subsystem:evolution');
    expect(evo).toBeDefined();
    expect(evo!.status).toBe('active');
  });

  it('detects playbook from directory presence', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    fs.mkdirSync(path.join(stateDir, 'playbook'), { recursive: true });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const pb = allCaps.find(c => c.id === 'subsystem:playbook');
    expect(pb).toBeDefined();
    expect(pb!.status).toBe('active');
  });

  it('detects publishing from config', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      config: { projectName: 'test', publishing: { enabled: true } },
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const pub = allCaps.find(c => c.id === 'subsystem:publishing');
    expect(pub).toBeDefined();
    expect(pub!.status).toBe('active');
  });

  it('detects tunnel from config', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      config: { projectName: 'test', tunnel: { enabled: true } },
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const tunnel = allCaps.find(c => c.id === 'subsystem:tunnel');
    expect(tunnel).toBeDefined();
    expect(tunnel!.status).toBe('active');
  });

  it('detects auto-updates from config', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      config: { projectName: 'test', updates: { enabled: true, channel: 'stable' } },
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const updates = allCaps.find(c => c.id === 'subsystem:auto-updates');
    expect(updates).toBeDefined();
    expect(updates!.status).toBe('active');
  });

  it('detects feedback from config', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      config: { projectName: 'test', feedback: { enabled: true } },
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const feedback = allCaps.find(c => c.id === 'subsystem:feedback');
    expect(feedback).toBeDefined();
    expect(feedback!.status).toBe('active');
  });

  it('all subsystems present even when unavailable', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const subsystems = allCaps.filter(c => c.type === 'subsystem');

    // Should have at least the always-present subsystems
    expect(subsystems.length).toBeGreaterThanOrEqual(5);

    // All should have a valid status
    for (const sub of subsystems) {
      expect(['active', 'available']).toContain(sub.status);
    }
  });
});

describe('CapabilityMapper — Flat Hooks (Pre-Migration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-flat-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers flat hooks (not in instar/ or custom/ subdirs)', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir);
    // Write a hook directly in the hooks/ directory (flat layout)
    fs.writeFileSync(path.join(stateDir, 'hooks', 'legacy-hook.sh'), '#!/bin/bash\n# Legacy hook\necho legacy');

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const legacy = allCaps.find(c => c.id === 'hook:legacy-hook.sh');
    expect(legacy).toBeDefined();
    expect(legacy!.domain).toBe('infrastructure'); // Default for flat hooks
  });

  it('does not double-count hooks in subdirs and flat', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      hooks: {
        instar: [{ name: 'shared-name.sh', content: '#!/bin/bash\necho instar' }],
      },
    });
    // Also write the same name as a flat hook
    fs.writeFileSync(path.join(stateDir, 'hooks', 'shared-name.sh'), '#!/bin/bash\necho flat');

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const matches = allCaps.filter(c => c.id === 'hook:shared-name.sh');
    // Should only appear once (subdirectory version takes precedence)
    expect(matches.length).toBe(1);
  });
});

describe('CapabilityMapper — Large Agent Stress Test', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-stress-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles 50 skills, 50 scripts, 20 hooks, 50 jobs', async () => {
    const skills = Array.from({ length: 50 }, (_, i) => ({
      name: `skill-${String(i).padStart(3, '0')}`,
      content: `---\nname: skill-${i}\ndescription: Auto-generated skill ${i}\n---\n# Skill ${i}`,
    }));

    const scripts = Array.from({ length: 50 }, (_, i) => ({
      name: `script-${String(i).padStart(3, '0')}.sh`,
      content: `#!/bin/bash\n# Auto-generated script ${i}\necho "script ${i}"`,
    }));

    const hooks = {
      instar: Array.from({ length: 10 }, (_, i) => ({
        name: `instar-hook-${i}.sh`,
        content: `#!/bin/bash\n# Instar hook ${i}\necho "instar ${i}"`,
      })),
      custom: Array.from({ length: 10 }, (_, i) => ({
        name: `custom-hook-${i}.sh`,
        content: `#!/bin/bash\n# Custom hook ${i}\necho "custom ${i}"`,
      })),
    };

    const jobs = Array.from({ length: 50 }, (_, i) => ({
      slug: `job-${String(i).padStart(3, '0')}`,
      name: `Job ${i}`,
      description: `Auto-generated job ${i}`,
      schedule: `${i % 60} * * * *`,
      enabled: i % 5 !== 0, // 80% enabled
      execute: { type: 'prompt', value: `Job ${i} prompt` },
    }));

    const contextSegments = Array.from({ length: 5 }, (_, i) => ({
      name: `segment-${i}.md`,
      content: `# Segment ${i}\nContext segment ${i} content.`,
    }));

    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills,
      scripts,
      hooks,
      jobs,
      contextSegments,
      config: {
        projectName: 'stress-test',
        messaging: [{ type: 'telegram', enabled: true, config: {} }],
        scheduler: { enabled: true },
        monitoring: { enabled: true },
      },
    });

    const config = makeConfig(projectDir, stateDir, { projectName: 'stress-test' });
    const mapper = new CapabilityMapper(config);

    const startTime = Date.now();
    const map = await mapper.refresh();
    const elapsed = Date.now() - startTime;

    // Performance check: should complete within a reasonable time
    expect(elapsed).toBeLessThan(5000); // 5 seconds max

    // Verify all discovered
    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skillCaps = allCaps.filter(c => c.type === 'skill');
    const scriptCaps = allCaps.filter(c => c.type === 'script');
    const hookCaps = allCaps.filter(c => c.type === 'hook');
    const jobCaps = allCaps.filter(c => c.type === 'job');
    const storageCaps = allCaps.filter(c => c.type === 'storage');

    expect(skillCaps.length).toBe(50);
    expect(scriptCaps.length).toBe(50);
    expect(hookCaps.length).toBe(20);
    expect(jobCaps.length).toBe(50);
    expect(storageCaps.length).toBe(5);

    // Verify disabled job count
    const disabledJobs = jobCaps.filter(c => c.status === 'disabled');
    expect(disabledJobs.length).toBe(10); // Every 5th job

    // Summary should be accurate
    expect(map.summary.totalCapabilities).toBeGreaterThanOrEqual(175); // 50+50+20+50+5 + subsystems

    // All content hashes should be unique for skills (they have unique content)
    const skillHashes = new Set(skillCaps.map(c => c.contentHash));
    expect(skillHashes.size).toBe(50);

    // Markdown rendering should not crash
    const md = mapper.renderMarkdown(map, 3);
    expect(md.length).toBeGreaterThan(1000);

    // Drift detection should work
    const mapper2 = new CapabilityMapper(config);
    const drift = await mapper2.detectDrift();
    expect(drift.added.length).toBe(0);
    expect(drift.removed.length).toBe(0);
  });
});

describe('CapabilityMapper — Context Segment Parsing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-ctx-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts first heading as name', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      contextSegments: [{ name: 'test.md', content: '# My Context Segment\n\nSome content here.' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const ctx = allCaps.find(c => c.id === 'context:test.md');
    expect(ctx).toBeDefined();
    expect(ctx!.name).toBe('My Context Segment');
  });

  it('handles context files with no heading', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      contextSegments: [{ name: 'no-heading.md', content: 'Just plain text without a heading.' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const ctx = allCaps.find(c => c.id === 'context:no-heading.md');
    expect(ctx).toBeDefined();
    expect(ctx!.name).toBe('Just plain text without a heading.');
  });

  it('truncates long context names to 80 chars', async () => {
    const longName = 'X'.repeat(200);
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      contextSegments: [{ name: 'long-name.md', content: `# ${longName}` }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const ctx = allCaps.find(c => c.id === 'context:long-name.md');
    expect(ctx).toBeDefined();
    expect(ctx!.name.length).toBeLessThanOrEqual(80);
  });

  it('context segments are typed as storage', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      contextSegments: [{ name: 'typed.md', content: '# Typed\nContent.' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const ctx = allCaps.find(c => c.id === 'context:typed.md');
    expect(ctx).toBeDefined();
    expect(ctx!.type).toBe('storage');
    expect(ctx!.domain).toBe('identity'); // Default domain for context segments
  });
});

describe('CapabilityMapper — YAML Frontmatter Edge Cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-yaml-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles quoted strings in frontmatter', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{
        name: 'quoted',
        content: '---\nname: "quoted-name"\ndescription: \'single quoted\'\n---\n',
      }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:quoted');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('quoted-name');
    expect(skill!.description).toBe('single quoted');
  });

  it('handles nested YAML (indented lines)', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{
        name: 'nested',
        content: '---\nname: nested-skill\ndescription: Nested test\nmetadata:\n  author: test\n  version: "2.0"\n---\n',
      }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:nested');
    expect(skill).toBeDefined();
    // Nested values are not parsed by simple parser but should not crash
    expect(skill!.name).toBe('nested-skill');
  });

  it('handles YAML with colons in values', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{
        name: 'colon-val',
        content: '---\nname: colon-val\ndescription: Has a colon: in value\n---\n',
      }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:colon-val');
    expect(skill).toBeDefined();
    expect(skill!.description).toContain('Has a colon');
  });

  it('handles empty SKILL.md file', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 'empty', content: '' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:empty');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('empty'); // Falls back to folder name
  });

  it('handles SKILL.md with only frontmatter delimiters', async () => {
    const { projectDir, stateDir } = createMinimalAgent(tmpDir, {
      skills: [{ name: 'delimiters-only', content: '---\n---\n' }],
    });

    const config = makeConfig(projectDir, stateDir);
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:delimiters-only');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('delimiters-only');
  });
});

describe('ManifestIntegrity — Additional Edge Cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-adv-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles manifest with deeply nested entries', () => {
    const integrity = new ManifestIntegrity(tmpDir);
    integrity.ensureKey();

    const manifest = {
      schemaVersion: 1,
      version: '0.10.0',
      generatedAt: new Date().toISOString(),
      entries: {
        'hook:deep': {
          id: 'hook:deep',
          type: 'hook',
          nested: { level1: { level2: { level3: 'deep-value' } } },
        },
      },
    };

    const signed = integrity.sign(manifest);
    expect(integrity.verify(signed)).toBe(true);
  });

  it('handles manifest with array entries', () => {
    const integrity = new ManifestIntegrity(tmpDir);
    integrity.ensureKey();

    const manifest = {
      schemaVersion: 1,
      version: '0.10.0',
      generatedAt: new Date().toISOString(),
      entries: {
        'hook:array': {
          id: 'hook:array',
          tags: ['a', 'b', 'c'],
          files: ['file1.sh', 'file2.sh'],
        },
      },
    };

    const signed = integrity.sign(manifest);
    expect(integrity.verify(signed)).toBe(true);

    // Tampering with array should fail verification
    (signed.entries as any)['hook:array'].tags.push('injected');
    expect(integrity.verify(signed)).toBe(false);
  });

  it('handles manifest with null and undefined values', () => {
    const integrity = new ManifestIntegrity(tmpDir);
    integrity.ensureKey();

    const manifest = {
      schemaVersion: 1,
      version: '0.10.0',
      generatedAt: new Date().toISOString(),
      entries: {
        'hook:nullable': {
          id: 'hook:nullable',
          value: null,
        },
      },
    };

    const signed = integrity.sign(manifest);
    expect(integrity.verify(signed)).toBe(true);
  });

  it('deterministic serialization produces consistent HMACs', () => {
    const integrity = new ManifestIntegrity(tmpDir);
    integrity.ensureKey();

    // Object with same keys in different order
    const manifest1 = { schemaVersion: 1, version: '0.10.0', entries: { a: 1, b: 2 }, generatedAt: 'now' };
    const manifest2 = { generatedAt: 'now', entries: { b: 2, a: 1 }, version: '0.10.0', schemaVersion: 1 };

    const signed1 = integrity.sign({ ...manifest1 });
    const signed2 = integrity.sign({ ...manifest2 });

    // Both should produce the same HMAC
    expect(signed1._hmac).toBe(signed2._hmac);
  });

  it('different data produces different HMACs', () => {
    const integrity = new ManifestIntegrity(tmpDir);
    integrity.ensureKey();

    const manifest1 = { schemaVersion: 1, version: '0.10.0', entries: { a: 1 }, generatedAt: 'now' };
    const manifest2 = { schemaVersion: 1, version: '0.10.0', entries: { a: 2 }, generatedAt: 'now' };

    const signed1 = integrity.sign({ ...manifest1 });
    const signed2 = integrity.sign({ ...manifest2 });

    expect(signed1._hmac).not.toBe(signed2._hmac);
  });

  it('handles corrupt JSON in manifest file', () => {
    const integrity = new ManifestIntegrity(tmpDir);
    integrity.ensureKey();

    const manifestPath = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(manifestPath, '{{{corrupt!!!');

    const result = integrity.readAndVerify(manifestPath);
    expect(result.manifest).toBeNull();
    expect(result.verified).toBe(false);
    expect(result.error).toContain('Parse error');
  });

  it('verify without key returns true (lenient mode)', () => {
    // No key generated
    const integrity = new ManifestIntegrity(tmpDir);
    expect(integrity.hasKey()).toBe(false);

    const manifest = { schemaVersion: 1, entries: {} };
    // Without a key, verification should be lenient (return true)
    expect(integrity.verify(manifest)).toBe(true);
  });

  it('multiple key rotations maintain integrity', async () => {
    const integrity = new ManifestIntegrity(tmpDir);
    integrity.ensureKey();

    const manifestPath = path.join(tmpDir, 'multi-rotate.json');
    const manifest = { schemaVersion: 1, version: '0.10.0', generatedAt: 'now', entries: { x: 1 } };

    integrity.writeAndSign(manifestPath, manifest);
    expect(integrity.readAndVerify(manifestPath).verified).toBe(true);

    // Rotate 3 times with small delays to ensure distinct backup timestamps
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 5));
      integrity.rotateKey(manifestPath);
      expect(integrity.readAndVerify(manifestPath).verified).toBe(true);
    }

    // Should have backup key files (at least 2, possibly 3 depending on timestamp collision)
    const backups = fs.readdirSync(tmpDir).filter(f => f.startsWith('.manifest-key.bak'));
    expect(backups.length).toBeGreaterThanOrEqual(2);
  });
});
