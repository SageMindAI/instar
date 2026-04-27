import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SelfKnowledgeTree } from '../../src/knowledge/SelfKnowledgeTree.js';
import { TreeGenerator } from '../../src/knowledge/TreeGenerator.js';
import { CoverageAuditor } from '../../src/knowledge/CoverageAuditor.js';

describe('Coverage Audit + Evolution (Phase 4)', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-audit-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(tmpDir, 'project', '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Write AGENT.md
    fs.writeFileSync(
      path.join(stateDir, 'AGENT.md'),
      '# TestBot\n\nA testing assistant.\n\n## Values\n\nQuality.',
    );
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTree(platforms: string[] = []): SelfKnowledgeTree {
    const generator = new TreeGenerator();
    const config = generator.generate({
      projectDir,
      stateDir,
      agentName: 'TestBot',
      hasMemory: true,
      hasJobs: true,
      platforms,
    });
    generator.save(config, stateDir);

    return new SelfKnowledgeTree({
      projectDir,
      stateDir,
      intelligence: null,
    });
  }

  function writeTraceEntries(entries: Array<Record<string, unknown>>): void {
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'logs', 'tree-trace.jsonl'), lines);
  }

  // Gate Test 4.1: doctor reports tree health summary
  it('4.1: health summary includes total nodes, coverage, cache rate, latency, errors', () => {
    const tree = createTree();
    const config = tree.getConfig()!;
    const validation = tree.validate();
    const auditor = new CoverageAuditor(projectDir, stateDir);

    // Write some trace entries
    writeTraceEntries([
      {
        timestamp: '2026-03-12T15:00:00Z',
        query: 'who am I?',
        triageMode: 'rule-based',
        triageScores: {},
        nodesSearched: ['identity.core'],
        nodesSkipped: [],
        cacheHits: ['identity.core'],
        cacheMisses: [],
        errors: [],
        budgetUsed: 1,
        budgetLimit: 10,
        elapsedMs: 200,
        synthesisTokens: 100,
        degraded: false,
      },
      {
        timestamp: '2026-03-12T15:01:00Z',
        query: 'what can I do?',
        triageMode: 'rule-based',
        triageScores: {},
        nodesSearched: ['capabilities.platforms'],
        nodesSkipped: [],
        cacheHits: [],
        cacheMisses: ['capabilities.platforms'],
        errors: [{ nodeId: 'state.health', message: 'file not found' }],
        budgetUsed: 2,
        budgetLimit: 10,
        elapsedMs: 400,
        synthesisTokens: 150,
        degraded: false,
      },
    ]);

    const health = auditor.healthSummary();

    expect(health.searchCount).toBe(2);
    expect(health.cacheHitRate).toBe(0.5); // 1 hit / 2 total
    expect(health.avgLatencyMs).toBe(300); // (200+400)/2
    expect(health.errorRate).toBe(0.5); // 1 error / 2 searches

    // Coverage score comes from validation
    const totalNodes = config.layers.reduce((s, l) => s + l.children.length, 0);
    expect(totalNodes).toBeGreaterThan(0);
    expect(validation.coverageScore).toBeGreaterThanOrEqual(0);
    expect(validation.coverageScore).toBeLessThanOrEqual(1);
  });

  // Gate Test 4.2: coverage audit detects missing platform nodes
  it('4.2: detects missing platform node when agent has binding', () => {
    // Create tree WITHOUT telegram platform nodes
    const tree = createTree();
    const config = tree.getConfig()!;
    const validation = tree.validate();

    const auditor = new CoverageAuditor(projectDir, stateDir);

    // Agent has Telegram binding but tree doesn't have state.telegram
    const audit = auditor.audit(config, validation, ['telegram']);

    const telegramGap = audit.gaps.find(g => g.suggestedNodeId === 'state.telegram');
    expect(telegramGap).toBeDefined();
    expect(telegramGap!.description).toContain('telegram');
    expect(telegramGap!.layerId).toBe('state');
  });

  // Gate Test 4.2b: no false positive when platform node exists
  it('4.2b: no gap when platform node exists', () => {
    // Create tree WITH telegram platform nodes
    const tree = createTree(['telegram']);
    const config = tree.getConfig()!;
    const validation = tree.validate();

    const auditor = new CoverageAuditor(projectDir, stateDir);
    const audit = auditor.audit(config, validation, ['telegram']);

    const telegramGap = audit.gaps.find(g => g.suggestedNodeId === 'state.telegram');
    expect(telegramGap).toBeUndefined();
  });

  // Gate Test 4.3: coverage audit reports content coverage score
  it('4.3: coverage score reflects valid/total ratio', () => {
    const tree = createTree();
    const config = tree.getConfig()!;
    const validation = tree.validate();

    const auditor = new CoverageAuditor(projectDir, stateDir);
    const audit = auditor.audit(config, validation);

    // Score is ratio of valid nodes
    expect(audit.coverageScore).toBeGreaterThanOrEqual(0);
    expect(audit.coverageScore).toBeLessThanOrEqual(1);
    expect(audit.totalNodes).toBeGreaterThan(0);
    expect(audit.validNodes).toBeLessThanOrEqual(audit.totalNodes);
  });

  // Gate Test 4.4: evolution can add a node
  it('4.4: evolution proposal adds managed:false node', () => {
    const tree = createTree();

    const result = tree.acceptEvolutionProposal('identity', {
      id: 'identity.evolved_wisdom',
      name: 'Evolved Wisdom',
      alwaysInclude: false,
      managed: true, // Should be forced to false
      depth: 'deep',
      maxTokens: 500,
      sensitivity: 'internal',
      sources: [{ type: 'inline', content: 'Hard-won insight from experience' }],
      description: 'Agent-evolved wisdom node',
    });

    expect(result.accepted).toBe(true);

    // Verify it's in the tree as managed:false
    const config = tree.getConfig()!;
    const identityLayer = config.layers.find(l => l.id === 'identity')!;
    const node = identityLayer.children.find(n => n.id === 'identity.evolved_wisdom');
    expect(node).toBeDefined();
    expect(node!.managed).toBe(false);
  });

  // Gate Test 4.5: evolution cannot add probe source for unregistered probe
  it('4.5: rejects proposal with unregistered probe', () => {
    const tree = createTree();

    const result = tree.acceptEvolutionProposal('capabilities', {
      id: 'capabilities.magic',
      name: 'Magic Powers',
      alwaysInclude: false,
      managed: false,
      depth: 'summary',
      maxTokens: 200,
      sensitivity: 'internal',
      sources: [{ type: 'probe', name: 'nonexistent_probe' }],
      description: 'A magical capability',
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('not registered');
  });

  // Gate Test 4.6: evolution-added nodes survive regeneration
  it('4.6: managed:false nodes survive tree regeneration', () => {
    const tree = createTree();

    // Add evolution node
    tree.acceptEvolutionProposal('identity', {
      id: 'identity.evolved_wisdom',
      name: 'Evolved Wisdom',
      alwaysInclude: false,
      managed: false,
      depth: 'deep',
      maxTokens: 500,
      sensitivity: 'internal',
      sources: [{ type: 'inline', content: 'Wisdom from experience' }],
      description: 'Agent-evolved wisdom',
    });

    // Regenerate tree (simulates doctor/update)
    tree.generateTree({ hasMemory: true, hasJobs: true });

    const config = tree.getConfig()!;
    const identityLayer = config.layers.find(l => l.id === 'identity')!;
    const node = identityLayer.children.find(n => n.id === 'identity.evolved_wisdom');
    expect(node).toBeDefined();
    expect(node!.managed).toBe(false);
    expect(node!.description).toBe('Agent-evolved wisdom');
  });

  // Gate Test 4.7: tree health trends visible over time
  it('4.7: multiple searches produce trace log trends', () => {
    createTree();
    const auditor = new CoverageAuditor(projectDir, stateDir);

    // Write trace entries showing improving performance over time
    writeTraceEntries([
      {
        timestamp: '2026-03-12T15:00:00Z', query: 'q1',
        triageMode: 'rule-based', triageScores: {},
        nodesSearched: ['identity.core'], nodesSkipped: [],
        cacheHits: [], cacheMisses: ['identity.core'],
        errors: [], budgetUsed: 2, budgetLimit: 10,
        elapsedMs: 500, synthesisTokens: 200, degraded: false,
      },
      {
        timestamp: '2026-03-12T15:05:00Z', query: 'q2',
        triageMode: 'rule-based', triageScores: {},
        nodesSearched: ['identity.core'], nodesSkipped: [],
        cacheHits: ['identity.core'], cacheMisses: [],
        errors: [], budgetUsed: 1, budgetLimit: 10,
        elapsedMs: 100, synthesisTokens: 150, degraded: false,
      },
      {
        timestamp: '2026-03-12T15:10:00Z', query: 'q3',
        triageMode: 'rule-based', triageScores: {},
        nodesSearched: ['identity.core', 'capabilities.platforms'], nodesSkipped: [],
        cacheHits: ['identity.core', 'capabilities.platforms'], cacheMisses: [],
        errors: [], budgetUsed: 1, budgetLimit: 10,
        elapsedMs: 50, synthesisTokens: 100, degraded: false,
      },
    ]);

    const health = auditor.healthSummary();

    expect(health.searchCount).toBe(3);
    expect(health.cacheHitRate).toBeCloseTo(3 / 4); // 3 hits / 4 total ops
    expect(health.avgLatencyMs).toBeCloseTo((500 + 100 + 50) / 3);
    expect(health.errorRate).toBe(0);
    expect(health.degradedSearches).toBe(0);
  });

  // Gate Test 4.4b: duplicate evolution proposal rejected
  it('4.4b: rejects duplicate node proposal', () => {
    const tree = createTree();

    // First proposal succeeds
    const result1 = tree.acceptEvolutionProposal('identity', {
      id: 'identity.evolved',
      name: 'Evolved',
      alwaysInclude: false,
      managed: false,
      depth: 'summary',
      maxTokens: 200,
      sensitivity: 'internal',
      sources: [{ type: 'inline', content: 'v1' }],
      description: 'First version',
    });
    expect(result1.accepted).toBe(true);

    // Second proposal with same ID rejected
    const result2 = tree.acceptEvolutionProposal('identity', {
      id: 'identity.evolved',
      name: 'Evolved v2',
      alwaysInclude: false,
      managed: false,
      depth: 'summary',
      maxTokens: 200,
      sensitivity: 'internal',
      sources: [{ type: 'inline', content: 'v2' }],
      description: 'Duplicate',
    });
    expect(result2.accepted).toBe(false);
    expect(result2.reason).toContain('already exists');
  });
});
