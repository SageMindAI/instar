import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CapabilityMapper } from '../../src/core/CapabilityMapper.js';
import type { CapabilityMap, CapabilityMapperConfig, DriftReport } from '../../src/core/CapabilityMapper.js';

/** Create a temporary directory structure that mimics an Instar agent */
function createTestAgent(rootDir: string) {
  const projectDir = path.join(rootDir, 'project');
  const stateDir = path.join(rootDir, 'project', '.instar');

  // Create directories
  fs.mkdirSync(path.join(projectDir, '.claude', 'skills', 'test-skill'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'hooks', 'instar'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'hooks', 'custom'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'evolution'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'context'), { recursive: true });

  // Create a SKILL.md
  fs.writeFileSync(path.join(projectDir, '.claude', 'skills', 'test-skill', 'SKILL.md'), `---
name: test-skill
description: A test skill for testing capability mapping
metadata:
  author: test-agent
  version: "1.0"
---

# Test Skill

This is a test skill.
`);

  // Create a script
  fs.writeFileSync(path.join(projectDir, '.claude', 'scripts', 'test-script.sh'), `#!/bin/bash
# Test script for capability mapping
echo "hello"
`);

  // Create hooks
  fs.writeFileSync(path.join(stateDir, 'hooks', 'instar', 'test-hook.sh'), `#!/bin/bash
# Test instar hook
echo "hook"
`);
  fs.writeFileSync(path.join(stateDir, 'hooks', 'custom', 'custom-hook.sh'), `#!/bin/bash
# Custom agent hook
echo "custom"
`);

  // Create jobs.json
  fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify([
    {
      slug: 'test-job',
      name: 'Test Job',
      description: 'A test job',
      schedule: '0 */4 * * *',
      enabled: true,
      execute: { type: 'prompt', value: 'test' },
    },
    {
      slug: 'disabled-job',
      name: 'Disabled Job',
      description: 'A disabled job',
      schedule: '0 0 * * *',
      enabled: false,
      execute: { type: 'prompt', value: 'test' },
    },
  ]));

  // Create config.json for subsystem detection
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    projectName: 'test-agent',
    messaging: [{ type: 'telegram', enabled: true, config: {} }],
    scheduler: { enabled: true },
    monitoring: { enabled: true },
    relationships: { relationshipsDir: path.join(stateDir, 'relationships') },
  }));

  // Create a context segment
  fs.writeFileSync(path.join(stateDir, 'context', 'communication.md'), '# Communication Context\n\nHow this agent communicates.');

  // Create evolution queue
  fs.writeFileSync(path.join(stateDir, 'state', 'evolution', 'evolution-queue.json'), JSON.stringify({
    proposals: [
      { id: 'EVO-001', title: 'Test', status: 'implemented', tags: ['capability:skill:evolved-skill'] },
    ],
    stats: { totalProposals: 1, byStatus: { implemented: 1 }, byType: {}, lastUpdated: new Date().toISOString() },
  }));

  return { projectDir, stateDir };
}

describe('CapabilityMapper', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;
  let config: CapabilityMapperConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capmap-test-'));
    const dirs = createTestAgent(tmpDir);
    projectDir = dirs.projectDir;
    stateDir = dirs.stateDir;
    config = {
      projectDir,
      stateDir,
      projectName: 'test-agent',
      version: '0.11.0',
      port: 4040,
    };
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scans and returns a capability map', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    expect(map.agent).toBe('test-agent');
    expect(map.version).toBe('0.11.0');
    expect(map.summary.totalCapabilities).toBeGreaterThan(0);
    expect(map.summary.domains).toBeGreaterThan(0);
    expect(map.domains).toBeInstanceOf(Array);
    expect(map.domains.length).toBeGreaterThan(0);
  });

  it('discovers skills from .claude/skills/', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:test-skill');

    expect(skill).toBeDefined();
    expect(skill!.type).toBe('skill');
    expect(skill!.name).toBe('test-skill');
    expect(skill!.status).toBe('active');
    expect(skill!.description).toContain('test skill');
  });

  it('discovers scripts from .claude/scripts/', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const script = allCaps.find(c => c.id === 'script:test-script.sh');

    expect(script).toBeDefined();
    expect(script!.type).toBe('script');
  });

  it('discovers hooks from both instar/ and custom/ directories', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const instarHook = allCaps.find(c => c.id === 'hook:test-hook.sh');
    const customHook = allCaps.find(c => c.id === 'hook:custom-hook.sh');

    expect(instarHook).toBeDefined();
    expect(instarHook!.type).toBe('hook');
    expect(instarHook!.provenance).toBe('instar'); // In instar/ directory

    expect(customHook).toBeDefined();
    expect(customHook!.type).toBe('hook');
    expect(customHook!.provenance).toBe('agent'); // In custom/ directory
  });

  it('discovers jobs from jobs.json', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const activeJob = allCaps.find(c => c.id === 'job:test-job');
    const disabledJob = allCaps.find(c => c.id === 'job:disabled-job');

    expect(activeJob).toBeDefined();
    expect(activeJob!.status).toBe('active');

    expect(disabledJob).toBeDefined();
    expect(disabledJob!.status).toBe('disabled');
  });

  it('discovers subsystems from config', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const telegram = allCaps.find(c => c.id === 'subsystem:telegram');
    const scheduler = allCaps.find(c => c.id === 'subsystem:scheduler');

    expect(telegram).toBeDefined();
    expect(telegram!.status).toBe('active');

    expect(scheduler).toBeDefined();
    expect(scheduler!.status).toBe('active');
  });

  it('discovers context segments', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const context = allCaps.find(c => c.id === 'context:communication.md');

    expect(context).toBeDefined();
    expect(context!.type).toBe('storage');
  });

  it('generates content hashes', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:test-skill');

    expect(skill!.contentHash).toBeDefined();
    expect(skill!.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('provides HATEOAS links', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    expect(map._links.self).toBe('/capability-map');
    expect(map._links.compact).toBe('/capability-map?format=compact');
    expect(map._links.drift).toBe('/capability-map/drift');
    expect(map._links.refresh).toBe('/capability-map/refresh');
    expect(Object.keys(map._links.domains).length).toBe(map.domains.length);
  });

  it('renders compact markdown (Level 0-1)', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();
    const md = mapper.renderMarkdown(map, 1);

    expect(md).toContain('# Capability Map — test-agent');
    expect(md).toContain('capabilities across');
    expect(md).toContain('| Domain |');
    expect(md).toContain('Self-discovery:');
  });

  it('renders domain markdown (Level 2)', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();
    const md = mapper.renderMarkdown(map, 2);

    expect(md).toContain('# Capability Map — test-agent');
    expect(md).toContain('| Capability | Type | Status | Provenance | Since |');
    expect(md).toContain('test-skill');
  });

  it('renders full markdown (Level 3)', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();
    const md = mapper.renderMarkdown(map, 3);

    expect(md).toContain('**ID**:');
    expect(md).toContain('**Type**:');
    expect(md).toContain('**Provenance**:');
  });

  it('detects drift — added capabilities', async () => {
    const mapper = new CapabilityMapper(config);

    // First refresh to establish baseline
    await mapper.refresh();

    // Add a new skill
    fs.mkdirSync(path.join(projectDir, '.claude', 'skills', 'new-skill'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'skills', 'new-skill', 'SKILL.md'), `---
name: new-skill
description: A newly added skill
---

# New Skill
`);

    // Create fresh mapper to simulate next scan
    const mapper2 = new CapabilityMapper(config);
    const drift = await mapper2.detectDrift();

    expect(drift.added.some(c => c.id === 'skill:new-skill')).toBe(true);
  });

  it('detects drift — removed capabilities', async () => {
    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    // Remove a skill
    // safe-git-allow: incremental-migration
    fs.rmSync(path.join(projectDir, '.claude', 'skills', 'test-skill'), { recursive: true, force: true });

    const mapper2 = new CapabilityMapper(config);
    const drift = await mapper2.detectDrift();

    expect(drift.removed.some(r => r.id === 'skill:test-skill')).toBe(true);
  });

  it('detects drift — changed capabilities', async () => {
    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    // Modify a script
    fs.writeFileSync(path.join(projectDir, '.claude', 'scripts', 'test-script.sh'), `#!/bin/bash
# Modified script
echo "modified"
`);

    const mapper2 = new CapabilityMapper(config);
    const drift = await mapper2.detectDrift();

    expect(drift.changed.some(c => c.id === 'script:test-script.sh' && c.field === 'contentHash')).toBe(true);
  });

  it('persists manifest to disk', async () => {
    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    const manifestPath = path.join(stateDir, 'state', 'capability-manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.entries).toBeDefined();
    expect(Object.keys(manifest.entries).length).toBeGreaterThan(0);
  });

  it('preserves firstSeen across refreshes', async () => {
    const mapper = new CapabilityMapper(config);
    await mapper.refresh();

    const manifestPath = path.join(stateDir, 'state', 'capability-manifest.json');
    const firstManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const firstSeen = firstManifest.entries['skill:test-skill']?.firstSeen;
    expect(firstSeen).toBeDefined();

    // Second refresh
    const mapper2 = new CapabilityMapper(config);
    await mapper2.refresh();

    const secondManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(secondManifest.entries['skill:test-skill'].firstSeen).toBe(firstSeen);
  });

  it('rejects concurrent refreshes', async () => {
    const mapper = new CapabilityMapper(config);

    // Start first refresh
    const p1 = mapper.refresh();
    // Attempt second refresh immediately
    await expect(mapper.refresh()).rejects.toThrow('REFRESH_IN_PROGRESS');

    await p1; // Clean up
  });

  it('returns cached map on getMap after refresh', async () => {
    const mapper = new CapabilityMapper(config);
    const map1 = await mapper.refresh();
    const map2 = await mapper.getMap();

    expect(map2.generatedAt).toBe(map1.generatedAt);
  });

  it('includes summary counts', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    expect(map.summary.totalCapabilities).toBeGreaterThan(5);
    expect(map.summary.domains).toBeGreaterThan(0);
    // Some capabilities should be classified
    const total = map.summary.instarProvided + map.summary.agentEvolved + map.summary.userConfigured + map.summary.unmapped;
    // Total from summary categories should account for all capabilities
    // (Note: 'inherited' is counted in instarProvided context in compact view but tracked separately in data)
    expect(total).toBeLessThanOrEqual(map.summary.totalCapabilities + 10); // Allow for inherited caps
  });

  it('handles empty project gracefully', async () => {
    const emptyDir = path.join(tmpDir, 'empty');
    const emptyState = path.join(emptyDir, '.instar');
    fs.mkdirSync(path.join(emptyState, 'state'), { recursive: true });

    const emptyMapper = new CapabilityMapper({
      projectDir: emptyDir,
      stateDir: emptyState,
      projectName: 'empty',
      version: '0.0.0',
      port: 4040,
    });

    const map = await emptyMapper.refresh();

    // Should still have subsystems (some are always detected)
    expect(map.domains).toBeInstanceOf(Array);
    expect(map.summary.totalCapabilities).toBeGreaterThanOrEqual(0);
  });

  it('classifies hooks in custom/ as agent provenance', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const customHook = allCaps.find(c => c.id === 'hook:custom-hook.sh');

    expect(customHook).toBeDefined();
    expect(customHook!.provenance).toBe('agent');
  });

  it('parses YAML frontmatter from SKILL.md', async () => {
    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const skill = allCaps.find(c => c.id === 'skill:test-skill');

    expect(skill!.name).toBe('test-skill');
    expect(skill!.description).toContain('test skill for testing');
  });

  it('infers domains from capability names', async () => {
    // Add a telegram-related script
    fs.writeFileSync(path.join(projectDir, '.claude', 'scripts', 'telegram-notify.sh'), `#!/bin/bash
# Telegram notification script
echo "notify"
`);

    const mapper = new CapabilityMapper(config);
    const map = await mapper.refresh();

    const allCaps = map.domains.flatMap(d => d.capabilities);
    const script = allCaps.find(c => c.id === 'script:telegram-notify.sh');

    expect(script).toBeDefined();
    expect(script!.domain).toBe('communication');
  });

  it('getFreshness reports correct state', async () => {
    const mapper = new CapabilityMapper(config);

    // Before any refresh
    const before = mapper.getFreshness();
    expect(before.lastRefresh).toBe('never');
    expect(before.isRefreshing).toBe(false);

    // After refresh
    await mapper.refresh();
    const after = mapper.getFreshness();
    expect(after.lastRefresh).not.toBe('never');
    expect(after.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(after.isRefreshing).toBe(false);
  });
});
