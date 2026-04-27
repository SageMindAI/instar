import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SelfKnowledgeTree } from '../../src/knowledge/SelfKnowledgeTree.js';
import type { SelfKnowledgeTreeConfig, GroundingResult } from '../../src/knowledge/types.js';

describe('Engagement Grounding (Phase 2)', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engagement-ground-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectDir, 'AGENT.md'),
      `# TestBot

I am TestBot, an AI assistant focused on testing and quality.

## Values

Reliability above all. Truth over comfort.

## Voice

Direct, technical, precise. I don't embellish.

## Tools

- vitest for testing
- TypeScript for everything

## Goals

Improve test coverage. Catch regressions early.
`,
    );
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(): SelfKnowledgeTreeConfig {
    return {
      version: '1.0',
      agentName: 'TestBot',
      budget: { maxLlmCalls: 10, maxSeconds: 30, model: 'haiku' },
      layers: [
        {
          id: 'identity',
          name: 'Identity',
          description: 'Who the agent is, values, voice',
          children: [
            {
              id: 'identity.core',
              name: 'Core Identity',
              alwaysInclude: true,
              managed: true,
              depth: 'shallow',
              maxTokens: 500,
              sensitivity: 'public',
              sources: [{ type: 'file', path: 'AGENT.md' }],
            },
            {
              id: 'identity.values',
              name: 'Values',
              alwaysInclude: true,
              managed: true,
              depth: 'shallow',
              maxTokens: 300,
              sensitivity: 'public',
              sources: [{ type: 'file_section', path: 'AGENT.md', section: 'Values' }],
            },
          ],
        },
        {
          id: 'capabilities',
          name: 'Capabilities',
          description: 'What the agent can do',
          children: [
            {
              id: 'capabilities.tools',
              name: 'Tools',
              alwaysInclude: false,
              managed: true,
              depth: 'shallow',
              maxTokens: 300,
              sensitivity: 'public',
              sources: [{ type: 'file_section', path: 'AGENT.md', section: 'Tools' }],
            },
          ],
        },
        {
          id: 'state',
          name: 'State',
          description: 'Current operational state',
          children: [
            {
              id: 'state.internal_data',
              name: 'Internal Metrics',
              alwaysInclude: false,
              managed: true,
              depth: 'shallow',
              maxTokens: 200,
              sensitivity: 'internal',
              sources: [{ type: 'file', path: 'AGENT.md' }],
            },
          ],
        },
        {
          id: 'evolution',
          name: 'Evolution',
          description: 'Growth trajectory',
          children: [
            {
              id: 'evolution.goals',
              name: 'Goals',
              alwaysInclude: false,
              managed: true,
              depth: 'shallow',
              maxTokens: 300,
              sensitivity: 'public',
              sources: [{ type: 'file_section', path: 'AGENT.md', section: 'Goals' }],
            },
          ],
        },
      ],
      groundingQuestions: ['What is relevant?'],
    };
  }

  function writeConfig(config: SelfKnowledgeTreeConfig) {
    fs.writeFileSync(
      path.join(stateDir, 'self-knowledge-tree.json'),
      JSON.stringify(config, null, 2),
    );
  }

  function createTree(intelligence?: { evaluate: ReturnType<typeof vi.fn> }) {
    return new SelfKnowledgeTree({
      projectDir,
      stateDir,
      intelligence: intelligence ?? null,
    });
  }

  // ── Gate Test 2.1: ground() returns structured grounding context ──

  it('2.1: ground() returns GroundingResult with identity fragments', async () => {
    writeConfig(makeConfig());
    const tree = createTree();

    const result = await tree.ground('testing quality');

    expect(result).toBeDefined();
    expect(result.topic).toBe('testing quality');
    expect(result.fragments.length).toBeGreaterThanOrEqual(1);

    // Identity fragments always present (alwaysInclude: true)
    const identityFragments = result.fragments.filter(f => f.layerId === 'identity');
    expect(identityFragments.length).toBeGreaterThanOrEqual(1);
    expect(identityFragments.some(f => f.content.includes('TestBot'))).toBe(true);
  });

  // ── Gate Test 2.2: ground() filters internal-only nodes ──

  it('2.2: ground() excludes sensitivity:internal nodes', async () => {
    writeConfig(makeConfig());
    const tree = createTree();

    const result = await tree.ground('system state');

    // Internal nodes should NOT appear in grounding output
    const internalFragments = result.fragments.filter(f => f.sensitivity === 'internal');
    expect(internalFragments).toHaveLength(0);

    // Public nodes should appear
    const publicFragments = result.fragments.filter(f => f.sensitivity === 'public');
    expect(publicFragments.length).toBeGreaterThanOrEqual(1);
  });

  // ── Gate Test 2.3: ground() uses synthesis cache (10-min window) ──

  it('2.3: ground() returns cached result on second call', async () => {
    writeConfig(makeConfig());
    const tree = createTree();

    const first = await tree.ground('testing');
    expect(first.cached).toBe(false);

    const second = await tree.ground('testing');
    expect(second.cached).toBe(true);
    expect(second.fragments).toEqual(first.fragments);
  });

  // ── Gate Test 2.4: ground() invalidates cache after 10 minutes ──

  it('2.4: ground() cache expires and triggers fresh search', async () => {
    writeConfig(makeConfig());
    const tree = createTree();

    // First call
    await tree.ground('testing');

    // Manually invalidate to simulate expiry (testing the mechanism)
    tree.invalidateGroundingCache();

    const fresh = await tree.ground('testing');
    expect(fresh.cached).toBe(false);
  });

  // ── Gate Test 2.5: ground() produces richer output than AGENT.md alone ──

  it('2.5: ground() includes content beyond raw AGENT.md', async () => {
    const config = makeConfig();
    // Add a non-AGENT.md source to show richness
    fs.writeFileSync(path.join(projectDir, 'learnings.md'), 'I learned that TDD catches 80% of regressions before they reach production.');
    config.layers.push({
      id: 'experience',
      name: 'Experience',
      description: 'What the agent has learned',
      children: [
        {
          id: 'experience.lessons',
          name: 'Lessons',
          alwaysInclude: true, // alwaysInclude ensures this loads regardless of triage
          managed: true,
          depth: 'medium',
          maxTokens: 500,
          sensitivity: 'public',
          sources: [{ type: 'file', path: 'learnings.md' }],
        },
      ],
    });
    writeConfig(config);

    const mockLLM = {
      evaluate: vi.fn()
        .mockResolvedValueOnce('{"identity": 0.9, "capabilities": 0.2, "experience": 0.8}') // layer triage
        .mockResolvedValueOnce('{"identity.core": 0.9, "identity.internal": 0.3, "experience.lessons": 0.9}') // node triage
        .mockResolvedValueOnce('I am TestBot. I value reliability and have learned that TDD catches 80% of regressions.'), // synthesis
    };
    const tree = createTree(mockLLM);

    const result = await tree.ground('who am I and what have I learned?');

    // Should have fragments from multiple layers (identity.core + experience.lessons via alwaysInclude)
    const layerIds = new Set(result.fragments.map(f => f.layerId));
    expect(layerIds.size).toBeGreaterThanOrEqual(2);

    // Should include experience content not in AGENT.md
    const rawAgentMd = fs.readFileSync(path.join(projectDir, 'AGENT.md'), 'utf-8');
    const experienceFragment = result.fragments.find(f => f.layerId === 'experience');
    expect(experienceFragment).toBeDefined();
    expect(experienceFragment!.content).toContain('TDD');
    expect(rawAgentMd).not.toContain('TDD'); // Not in AGENT.md
  });

  // ── Gate Test 2.6: Engagement skill receives grounding and uses it ──

  it('2.6: mock engagement skill can consume GroundingResult', async () => {
    writeConfig(makeConfig());
    const tree = createTree();

    const result = await tree.ground('AI consciousness', 'moltbook');

    // Simulate what an engagement skill does with the result
    const identityContext = result.fragments
      .filter(f => f.layerId === 'identity')
      .map(f => f.content)
      .join('\n');

    const topicContext = result.fragments
      .filter(f => f.layerId !== 'identity')
      .map(f => f.content)
      .join('\n');

    // The skill should be able to extract usable context
    expect(identityContext.length).toBeGreaterThan(0);
    expect(identityContext).toContain('TestBot');

    // Platform is passed through
    expect(result.platform).toBe('moltbook');

    // Result has all fields the skill needs
    expect(result).toHaveProperty('topic');
    expect(result).toHaveProperty('platform');
    expect(result).toHaveProperty('fragments');
    expect(result).toHaveProperty('synthesis');
    expect(result).toHaveProperty('degraded');
    expect(result).toHaveProperty('elapsedMs');
    expect(result).toHaveProperty('cached');
  });

  // ── Gate Test 2.7: ground() works in degraded mode ──

  it('2.7: ground() returns useful result when LLM unavailable', async () => {
    writeConfig(makeConfig());
    const tree = createTree(); // No intelligence provider — rule-based triage is primary

    const result = await tree.ground('testing');

    // Rule-based triage is the primary mode, not degraded
    expect(result.degraded).toBe(false);
    expect(result.synthesis).toBeNull(); // No LLM for synthesis

    // alwaysInclude fragments still present
    const identityFragments = result.fragments.filter(f => f.layerId === 'identity');
    expect(identityFragments.length).toBeGreaterThanOrEqual(1);
    expect(identityFragments[0].content).toContain('TestBot');
  });

  // ── Gate Test 2.8: Grounding trace appears in observability log ──

  it('2.8: ground() produces trace log entry', async () => {
    writeConfig(makeConfig());
    const tree = createTree();

    await tree.ground('testing');

    const tracePath = path.join(stateDir, 'logs', 'tree-trace.jsonl');
    expect(fs.existsSync(tracePath)).toBe(true);

    const content = fs.readFileSync(tracePath, 'utf-8').trim();
    const entry = JSON.parse(content);
    expect(entry.query).toBe('testing');
    expect(entry.nodesSearched).toBeDefined();
    expect(entry.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  // ── Extreme Tests ──

  // X2.1: Sensitivity-unaware cache key
  it('X2.1: public grounding never serves internal-only content', async () => {
    writeConfig(makeConfig());
    const tree = createTree();

    // ground() always uses publicOnly:true
    const result = await tree.ground('state metrics');

    // Even if state.internal_data exists, it should not appear
    const internalFragments = result.fragments.filter(f => f.sensitivity === 'internal');
    expect(internalFragments).toHaveLength(0);
  });

  // X2.2: Identity file changes during cache window
  it('X2.2: AGENT.md change invalidates grounding cache', async () => {
    writeConfig(makeConfig());
    const tree = createTree();

    // First grounding
    const first = await tree.ground('identity');
    expect(first.cached).toBe(false);

    // Modify AGENT.md (changes mtime)
    const agentMdPath = path.join(projectDir, 'AGENT.md');
    const originalContent = fs.readFileSync(agentMdPath, 'utf-8');
    // Ensure mtime actually changes — some filesystems have 1s resolution
    await new Promise(r => setTimeout(r, 50));
    fs.writeFileSync(agentMdPath, originalContent + '\n## Updated\n\nNew section added.');

    // Second grounding should NOT be cached (mtime changed)
    const second = await tree.ground('identity');
    expect(second.cached).toBe(false);
  });

  // X2.3: LLM failure during grounding — rule-based triage still works
  it('X2.3: LLM failure still produces useful grounding via rule-based triage', async () => {
    writeConfig(makeConfig());
    const failLLM = {
      evaluate: vi.fn().mockRejectedValue(new Error('rate limited')),
    };
    const tree = createTree(failLLM);

    const result = await tree.ground('testing');

    // Rule-based triage is primary — LLM failure doesn't cause degradation
    expect(result.degraded).toBe(false);
    // Synthesis is null because LLM failed
    expect(result.synthesis).toBeNull();
    // Still has fragments from alwaysInclude nodes
    expect(result.fragments.length).toBeGreaterThanOrEqual(1);
  });

  // X2.4: publicOnly physically excludes internal fragments from synthesis
  it('X2.4: internal fragments never reach synthesis prompt', async () => {
    writeConfig(makeConfig());

    const synthesisPrompts: string[] = [];
    const mockLLM = {
      evaluate: vi.fn().mockImplementation(async (prompt: string) => {
        if (prompt.includes('Score each')) {
          return '{"identity": 0.9, "capabilities": 0.5, "state": 0.9, "evolution": 0.3}';
        }
        synthesisPrompts.push(prompt);
        return 'I am TestBot, focused on testing.';
      }),
    };

    const tree = createTree(mockLLM);
    await tree.ground('state and identity');

    // If synthesis was called, verify internal node content is absent
    if (synthesisPrompts.length > 0) {
      for (const prompt of synthesisPrompts) {
        expect(prompt).not.toContain('state.internal_data');
      }
    }
  });

  // X2.7: Thundering herd protection
  it('X2.7: concurrent ground() calls share single search', async () => {
    writeConfig(makeConfig());
    let searchCount = 0;
    const originalSearch = SelfKnowledgeTree.prototype.search;

    const tree = createTree();
    const originalSearchFn = tree.search.bind(tree);
    vi.spyOn(tree, 'search').mockImplementation(async (...args) => {
      searchCount++;
      return originalSearchFn(...args);
    });

    // Launch 5 concurrent grounding calls for same topic
    const results = await Promise.all([
      tree.ground('testing'),
      tree.ground('testing'),
      tree.ground('testing'),
      tree.ground('testing'),
      tree.ground('testing'),
    ]);

    // First call triggers search, rest should hit in-progress lock or cache
    // At most 1 actual search should happen
    expect(searchCount).toBeLessThanOrEqual(1);

    // All results should be equivalent
    for (const result of results) {
      expect(result.fragments.length).toBeGreaterThanOrEqual(1);
    }
  });

  // X2.8: Absurdly long topic string
  it('X2.8: long topic is truncated and cached safely', async () => {
    writeConfig(makeConfig());
    const tree = createTree();

    const longTopic = 'a'.repeat(72_000);
    const result = await tree.ground(longTopic);

    // Topic should be truncated
    expect(result.topic.length).toBeLessThanOrEqual(500);

    // Should still produce valid fragments
    expect(result.fragments.length).toBeGreaterThanOrEqual(1);

    // Cached version should work
    const cached = await tree.ground(longTopic);
    expect(cached.cached).toBe(true);
  });
});
