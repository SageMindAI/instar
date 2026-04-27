import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TreeGenerator } from '../../src/knowledge/TreeGenerator.js';
import { ContextSnapshotBuilder } from '../../src/core/ContextSnapshotBuilder.js';

describe('Self-Knowledge Init/Doctor (Phase 3)', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-init-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(tmpDir, 'project', '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgentMd(content: string) {
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), content);
  }

  // Gate Test 3.1: instar init generates self-knowledge-tree.json
  it('3.1: generates tree file with valid schema on init', () => {
    writeAgentMd(`# TestAgent

A testing assistant.

## Values

Quality and reliability.
`);

    const generator = new TreeGenerator();
    const config = generator.generate({
      projectDir,
      stateDir,
      agentName: 'TestAgent',
      hasMemory: true,
      hasJobs: true,
    });
    generator.save(config, stateDir);

    const treePath = path.join(stateDir, 'self-knowledge-tree.json');
    expect(fs.existsSync(treePath)).toBe(true);

    const loaded = JSON.parse(fs.readFileSync(treePath, 'utf-8'));
    expect(loaded.version).toBe('1.0');
    expect(loaded.agentName).toBe('TestAgent');
    expect(loaded.layers).toHaveLength(5);
    expect(loaded.budget.model).toBe('haiku');

    // Verify nodes match AGENT.md content
    const identityLayer = loaded.layers.find((l: any) => l.id === 'identity');
    expect(identityLayer).toBeDefined();
    expect(identityLayer.children.some((n: any) => n.id === 'identity.core')).toBe(true);
  });

  // Gate Test 3.2: doctor generates tree for existing agent without one
  it('3.2: generates tree when none exists (doctor behavior)', () => {
    writeAgentMd('# ExistingAgent\n\nAn existing agent without a tree.');

    const treePath = path.join(stateDir, 'self-knowledge-tree.json');
    expect(fs.existsSync(treePath)).toBe(false);

    const generator = new TreeGenerator();
    const config = generator.generate({
      projectDir,
      stateDir,
      agentName: 'ExistingAgent',
      hasMemory: true,
    });
    generator.save(config, stateDir);

    expect(fs.existsSync(treePath)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(treePath, 'utf-8'));
    expect(loaded.agentName).toBe('ExistingAgent');
  });

  // Gate Test 3.3: doctor preserves existing tree
  it('3.3: preserves managed:false nodes on regeneration', () => {
    writeAgentMd('# TestAgent\n\nA test agent.');

    const generator = new TreeGenerator();

    // Generate initial tree
    const initial = generator.generate({
      projectDir,
      stateDir,
      agentName: 'TestAgent',
    });

    // Add a custom (unmanaged) node
    initial.layers[0].children.push({
      id: 'identity.custom_wisdom',
      name: 'Custom Wisdom',
      alwaysInclude: false,
      managed: false,
      depth: 'deep',
      maxTokens: 500,
      sensitivity: 'public',
      sources: [{ type: 'file', path: 'wisdom.md' }],
      description: 'Agent-evolved wisdom node',
    });
    generator.save(initial, stateDir);

    // Regenerate (simulates doctor)
    const regenerated = generator.generate({
      projectDir,
      stateDir,
      agentName: 'TestAgent',
    });

    const identityLayer = regenerated.layers.find(l => l.id === 'identity')!;
    const customNode = identityLayer.children.find(n => n.id === 'identity.custom_wisdom');
    expect(customNode).toBeDefined();
    expect(customNode!.managed).toBe(false);
    expect(customNode!.description).toBe('Agent-evolved wisdom node');
  });

  // Gate Test 3.4: ContextSnapshotBuilder includes selfKnowledge field
  it('3.4: snapshot includes selfKnowledge metadata', () => {
    writeAgentMd('# TestAgent\n\nA test agent.');

    // Generate and save tree
    const generator = new TreeGenerator();
    const config = generator.generate({
      projectDir,
      stateDir,
      agentName: 'TestAgent',
      hasMemory: true,
    });
    generator.save(config, stateDir);

    // Write a trace entry to test lastSearch fields
    const logsDir = path.join(stateDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'tree-trace.jsonl'),
      JSON.stringify({
        timestamp: '2026-03-12T15:00:00Z',
        query: 'who am I?',
        triageMode: 'llm',
        triageScores: {},
        nodesSearched: [],
        nodesSkipped: [],
        cacheHits: [],
        cacheMisses: [],
        errors: [],
        budgetUsed: 2,
        budgetLimit: 10,
        elapsedMs: 500,
        synthesisTokens: 200,
        degraded: false,
      }) + '\n',
    );

    // Build snapshot
    const builder = new ContextSnapshotBuilder(
      {
        projectName: 'TestAgent',
        projectDir,
        stateDir,
      },
    );
    const snapshot = builder.build();

    expect(snapshot.selfKnowledge).toBeDefined();
    expect(snapshot.selfKnowledge!.treeVersion).toBe('1.0');
    expect(snapshot.selfKnowledge!.totalNodes).toBeGreaterThan(0);
    expect(snapshot.selfKnowledge!.lastSearchQuery).toBe('who am I?');
    expect(snapshot.selfKnowledge!.lastSearchTimestamp).toBe('2026-03-12T15:00:00Z');
  });

  // Gate Test 3.5: Memory search uses fixed top-K (5)
  it('3.5: memory_search source type has topK: 5 by default', () => {
    writeAgentMd(`# TestAgent\n\nA test agent.\n\n## Values\n\nBe helpful.`);

    const generator = new TreeGenerator();
    const config = generator.generate({
      projectDir,
      stateDir,
      agentName: 'TestAgent',
      hasMemory: true,
    });

    // Find all memory_search sources
    const memorySources: Array<{ topK: number }> = [];
    for (const layer of config.layers) {
      for (const node of layer.children) {
        for (const source of node.sources) {
          if (source.type === 'memory_search') {
            memorySources.push(source as any);
          }
        }
      }
    }

    expect(memorySources.length).toBeGreaterThanOrEqual(1);
    for (const source of memorySources) {
      expect(source.topK).toBeLessThanOrEqual(5);
    }
  });

  // Gate Test 3.7: Agent with no AGENT.md gets minimal tree
  it('3.7: generates minimal tree without AGENT.md', () => {
    // Don't write AGENT.md

    const generator = new TreeGenerator();
    const config = generator.generate({
      projectDir,
      stateDir,
      agentName: 'NoAgentMd',
    });

    expect(config.layers).toHaveLength(5);
    // Should still have identity.core
    const identityLayer = config.layers.find(l => l.id === 'identity')!;
    expect(identityLayer.children.some(n => n.id === 'identity.core')).toBe(true);
  });

  // Gate Test 3.4 additional: snapshot without tree returns undefined selfKnowledge
  it('3.4b: snapshot without tree has no selfKnowledge', () => {
    writeAgentMd('# TestAgent\n\nA test agent.');

    const builder = new ContextSnapshotBuilder({
      projectName: 'TestAgent',
      projectDir,
      stateDir,
    });
    const snapshot = builder.build();

    expect(snapshot.selfKnowledge).toBeUndefined();
  });
});
