import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SelfKnowledgeTree } from '../../src/knowledge/SelfKnowledgeTree.js';
import type { SelfKnowledgeTreeConfig } from '../../src/knowledge/types.js';

describe('SelfKnowledgeTree', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-knowledge-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Create AGENT.md
    fs.writeFileSync(
      path.join(projectDir, 'AGENT.md'),
      `# TestBot

I am a test bot that helps with automated testing.

## Values

Reliability, accuracy, and thoroughness.

## Voice

Direct and technical. I don't waste words.

## Tools

- vitest
- node.js
`,
    );
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTree(intelligence?: { evaluate: ReturnType<typeof vi.fn> }): SelfKnowledgeTree {
    return new SelfKnowledgeTree({
      projectDir,
      stateDir,
      intelligence: intelligence ?? null,
    });
  }

  function writeTreeConfig(config: SelfKnowledgeTreeConfig) {
    fs.writeFileSync(
      path.join(stateDir, 'self-knowledge-tree.json'),
      JSON.stringify(config, null, 2),
    );
  }

  function makeConfig(): SelfKnowledgeTreeConfig {
    return {
      version: '1.0',
      agentName: 'TestBot',
      budget: { maxLlmCalls: 10, maxSeconds: 30, model: 'haiku' },
      layers: [
        {
          id: 'identity',
          name: 'Identity',
          description: 'Who the agent is',
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
              id: 'identity.internal',
              name: 'Internal Data',
              alwaysInclude: false,
              managed: true,
              depth: 'shallow',
              maxTokens: 300,
              sensitivity: 'internal',
              sources: [{ type: 'file', path: 'AGENT.md' }],
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
      ],
      groundingQuestions: ['What is relevant?'],
    };
  }

  // Gate Test 1.22: Full search with rule-based triage (primary mode, no LLM needed)
  it('returns useful result with rule-based triage (no LLM)', async () => {
    const config = makeConfig();
    writeTreeConfig(config);
    const tree = createTree();

    const result = await tree.search('who am I?');

    // Rule-based is now the primary mode, NOT degraded
    expect(result.degraded).toBe(false);
    // Synthesis is null because no LLM provider for synthesis step
    expect(result.synthesis).toBeNull();
    // alwaysInclude nodes should still return fragments
    expect(result.fragments.length).toBeGreaterThanOrEqual(1);
    const coreFragment = result.fragments.find(f => f.nodeId === 'identity.core');
    expect(coreFragment).toBeDefined();
    expect(coreFragment!.content).toContain('TestBot');
    expect(result.triageMethod).toBe('rule-based');
  });

  // Gate Test 1.21-like: Full search with mocked LLM
  it('returns synthesized result with LLM', async () => {
    const config = makeConfig();
    writeTreeConfig(config);

    const mockLLM = {
      evaluate: vi.fn()
        .mockResolvedValueOnce('{"identity": 0.9, "capabilities": 0.3}') // layer triage
        .mockResolvedValueOnce('{"identity.core": 0.9, "identity.internal": 0.3}') // node triage
        .mockResolvedValueOnce('I am TestBot, a testing assistant.'),     // synthesis
    };

    const tree = createTree(mockLLM);
    const result = await tree.search('who am I?');

    expect(result.degraded).toBe(false);
    expect(result.synthesis).toContain('TestBot');
    expect(result.fragments.length).toBeGreaterThanOrEqual(1);
    expect(result.budgetUsed).toBe(2); // triage (layer+node counted as 1) + synthesis
  });

  // Gate Test 1.26: Budget enforcement
  it('respects budget limits', async () => {
    const config = makeConfig();
    config.budget.maxLlmCalls = 2; // Allow 2 LLM calls
    writeTreeConfig(config);

    const mockLLM = {
      evaluate: vi.fn()
        .mockResolvedValueOnce('{"identity": 0.9, "capabilities": 0.3}') // layer triage (1 call)
        .mockResolvedValueOnce('{"identity.core": 0.9, "identity.internal": 0.3}') // node triage (2nd call)
        .mockResolvedValueOnce('synthesis text'), // synthesis (3rd call)
    };

    const tree = createTree(mockLLM);
    // Budget of 1 means only triage can run, synthesis should be skipped
    const result = await tree.search('who am I?', { maxBudget: 1 });

    // Budget exhausted after triage — synthesis should be skipped
    expect(result.synthesis).toBeNull();
    expect(result.budgetUsed).toBe(1);
  });

  // Gate Test 1.27: publicOnly excludes internal nodes
  it('excludes internal nodes with publicOnly', async () => {
    const config = makeConfig();
    writeTreeConfig(config);
    const tree = createTree();

    const result = await tree.search('who am I?', { publicOnly: true });

    const internalFragments = result.fragments.filter(f => f.sensitivity === 'internal');
    expect(internalFragments).toHaveLength(0);

    const publicFragments = result.fragments.filter(f => f.sensitivity === 'public');
    expect(publicFragments.length).toBeGreaterThanOrEqual(1);
  });

  // Gate Test 1.23: Observability trace log
  it('produces trace log entry on search', async () => {
    const config = makeConfig();
    writeTreeConfig(config);
    const tree = createTree();

    await tree.search('test query');

    const tracePath = path.join(stateDir, 'logs', 'tree-trace.jsonl');
    expect(fs.existsSync(tracePath)).toBe(true);

    const content = fs.readFileSync(tracePath, 'utf-8').trim();
    const entry = JSON.parse(content);
    expect(entry.query).toBe('test query');
    expect(entry.triageMode).toBe('rule-based');
    expect(entry.nodesSearched).toBeDefined();
    expect(entry.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(typeof entry.degraded).toBe('boolean');
  });

  // dryRun
  it('dryRun shows plan without executing', async () => {
    const config = makeConfig();
    writeTreeConfig(config);
    const tree = createTree();

    const plan = await tree.dryRun('who am I?');

    expect(plan.query).toBe('who am I?');
    expect(plan.triageMode).toBe('rule-based');
    expect(plan.nodesToSearch.length).toBeGreaterThanOrEqual(1);
    expect(plan.nodesToSearch).toContain('identity.core');
  });

  // generateTree
  it('generates and saves tree config', () => {
    const tree = createTree();
    const config = tree.generateTree({
      hasMemory: true,
      hasJobs: true,
    });

    expect(config.agentName).toBe('TestBot');
    expect(config.layers).toHaveLength(5);

    // Verify file was written
    const filePath = path.join(stateDir, 'self-knowledge-tree.json');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  // addNode / removeNode
  it('adds and removes nodes', () => {
    const config = makeConfig();
    writeTreeConfig(config);
    const tree = createTree();

    tree.addNode('identity', {
      id: 'identity.custom',
      name: 'Custom',
      alwaysInclude: false,
      managed: false,
      depth: 'shallow',
      maxTokens: 200,
      sensitivity: 'public',
      sources: [{ type: 'file', path: 'custom.md' }],
    });

    const loaded = tree.getConfig()!;
    const identityLayer = loaded.layers.find(l => l.id === 'identity')!;
    expect(identityLayer.children.some(n => n.id === 'identity.custom')).toBe(true);

    tree.removeNode('identity.custom');
    const loaded2 = tree.getConfig()!;
    const identityLayer2 = loaded2.layers.find(l => l.id === 'identity')!;
    expect(identityLayer2.children.some(n => n.id === 'identity.custom')).toBe(false);
  });

  // validate
  describe('validate', () => {
    // Gate Test 1.24: Missing source files
    it('detects missing source files', () => {
      const config = makeConfig();
      config.layers[0].children.push({
        id: 'identity.ghost',
        name: 'Ghost',
        alwaysInclude: false,
        managed: true,
        depth: 'shallow',
        maxTokens: 200,
        sensitivity: 'public',
        sources: [{ type: 'file', path: 'nonexistent.md' }],
      });
      writeTreeConfig(config);
      const tree = createTree();

      const result = tree.validate();
      expect(result.warnings.some(w => w.nodeId === 'identity.ghost' && w.type === 'missing_source')).toBe(true);
    });

    // Gate Test 1.25: Empty source files
    it('detects empty source files', () => {
      fs.writeFileSync(path.join(projectDir, 'empty.md'), '');
      const config = makeConfig();
      config.layers[0].children.push({
        id: 'identity.empty',
        name: 'Empty',
        alwaysInclude: false,
        managed: true,
        depth: 'shallow',
        maxTokens: 200,
        sensitivity: 'public',
        sources: [{ type: 'file', path: 'empty.md' }],
      });
      writeTreeConfig(config);
      const tree = createTree();

      const result = tree.validate();
      expect(result.warnings.some(w => w.nodeId === 'identity.empty' && w.type === 'empty_source')).toBe(true);
    });

    it('detects unregistered probes', () => {
      const config = makeConfig();
      config.layers[0].children.push({
        id: 'identity.probe',
        name: 'Probe',
        alwaysInclude: false,
        managed: true,
        depth: 'shallow',
        maxTokens: 200,
        sensitivity: 'public',
        sources: [{ type: 'probe', name: 'unregistered-probe' }],
      });
      writeTreeConfig(config);
      const tree = createTree();

      const result = tree.validate();
      expect(result.errors.some(e => e.type === 'unregistered_probe')).toBe(true);
      expect(result.valid).toBe(false);
    });

    it('returns valid for healthy tree', () => {
      const config = makeConfig();
      writeTreeConfig(config);
      const tree = createTree();

      const result = tree.validate();
      expect(result.valid).toBe(true);
      expect(result.coverageScore).toBeGreaterThan(0);
    });
  });

  // Grounding (Phase 2 preview)
  it('ground() returns structured result', async () => {
    const config = makeConfig();
    writeTreeConfig(config);
    const tree = createTree();

    const result = await tree.ground('testing', 'moltbook');
    expect(result.topic).toBe('testing');
    expect(result.platform).toBe('moltbook');
    expect(result.fragments.length).toBeGreaterThanOrEqual(1);
    expect(result.degraded).toBe(false); // Rule-based triage is normal, not degraded
    expect(typeof result.elapsedMs).toBe('number');
  });

  it('ground() uses cache on subsequent calls', async () => {
    const config = makeConfig();
    writeTreeConfig(config);
    const tree = createTree();

    const first = await tree.ground('testing');
    expect(first.cached).toBe(false);

    const second = await tree.ground('testing');
    expect(second.cached).toBe(true);
  });

  // Empty result when no config
  it('returns error result when tree config missing', async () => {
    const tree = createTree();
    const result = await tree.search('who am I?');

    expect(result.degraded).toBe(true);
    expect(result.fragments).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });
});
