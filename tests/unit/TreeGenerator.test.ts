import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TreeGenerator } from '../../src/knowledge/TreeGenerator.js';

describe('TreeGenerator', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;
  let generator: TreeGenerator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-gen-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    generator = new TreeGenerator();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgentMd(content: string) {
    fs.writeFileSync(path.join(projectDir, 'AGENT.md'), content);
  }

  // Gate Tests 1.1-1.3: Generate valid trees from different AGENT.md files
  describe('tree generation from AGENT.md', () => {
    it('generates valid tree from a full AGENT.md', () => {
      writeAgentMd(`# AI Guy

A helpful AI assistant.

## Values

Be helpful. Be honest.

## Voice

Friendly and professional.

## Tools

- MCP servers
- CLI tools

## Goals

Improve conversation quality.
`);

      const config = generator.generate({
        projectDir,
        stateDir,
        agentName: 'AI Guy',
        platforms: ['telegram', 'moltbook'],
        hasMemory: true,
        hasKnowledge: true,
        hasDecisionJournal: true,
        hasJobs: true,
        hasEvolution: true,
        hasAutonomyProfile: true,
      });

      // 5 layers
      expect(config.layers).toHaveLength(5);
      expect(config.layers.map(l => l.id)).toEqual([
        'identity', 'experience', 'capabilities', 'state', 'evolution',
      ]);

      // ≥15 nodes total
      const totalNodes = config.layers.reduce((sum, l) => sum + l.children.length, 0);
      expect(totalNodes).toBeGreaterThanOrEqual(15);

      // All managed:true
      for (const layer of config.layers) {
        for (const node of layer.children) {
          expect(node.managed).toBe(true);
        }
      }

      // Valid schema
      expect(config.version).toBe('1.0');
      expect(config.agentName).toBe('AI Guy');
      expect(config.budget.model).toBe('haiku');
      expect(config.budget.maxLlmCalls).toBe(10);

      // JSON-serializable
      expect(() => JSON.parse(JSON.stringify(config))).not.toThrow();
    });

    it('generates tree from minimal AGENT.md', () => {
      writeAgentMd('# DeepSignal\n\nA monitoring agent.');

      const config = generator.generate({
        projectDir,
        stateDir,
        agentName: 'DeepSignal',
        platforms: ['telegram'],
        hasMemory: true,
        hasDecisionJournal: true,
        hasJobs: true,
      });

      expect(config.layers).toHaveLength(5);
      expect(config.agentName).toBe('DeepSignal');
      // Fewer nodes because fewer capabilities detected
      const totalNodes = config.layers.reduce((sum, l) => sum + l.children.length, 0);
      expect(totalNodes).toBeGreaterThanOrEqual(10);
    });

    it('generates tree from agent with different capabilities', () => {
      writeAgentMd(`# SageMind

An AI consulting agent.

## Values

Professionalism and accuracy.

## Relationships

Manages client relationships.
`);

      const config = generator.generate({
        projectDir,
        stateDir,
        agentName: 'SageMind',
        platforms: ['moltbook', 'reddit', 'discord'],
        hasMemory: true,
        hasKnowledge: true,
        skills: ['consulting', 'research'],
      });

      expect(config.layers).toHaveLength(5);
      expect(config.agentName).toBe('SageMind');

      // Should have platform-specific state nodes
      const stateLayer = config.layers.find(l => l.id === 'state')!;
      const platformNodes = stateLayer.children.filter(n => n.id.startsWith('state.'));
      expect(platformNodes.length).toBeGreaterThanOrEqual(3);

      // Should have relationships node
      const identityLayer = config.layers.find(l => l.id === 'identity')!;
      expect(identityLayer.children.some(n => n.id === 'identity.relationships')).toBe(true);
    });
  });

  // Gate Test X1.7: Empty AGENT.md
  it('handles empty AGENT.md', () => {
    writeAgentMd('');

    const config = generator.generate({
      projectDir,
      stateDir,
      agentName: 'EmptyAgent',
      hasJobs: true,
    });

    expect(config.layers).toHaveLength(5);
    // Should still have core identity node
    const identityLayer = config.layers.find(l => l.id === 'identity')!;
    expect(identityLayer.children.some(n => n.id === 'identity.core')).toBe(true);
  });

  // Gate Test 1.28: Managed flag preserved on tree regeneration
  it('preserves managed:false nodes on regeneration', () => {
    writeAgentMd('# TestAgent\n\nA test agent.');

    // Generate initial tree
    const initial = generator.generate({
      projectDir,
      stateDir,
      agentName: 'TestAgent',
      hasMemory: true,
    });

    // Add a custom (unmanaged) node
    initial.layers[0].children.push({
      id: 'identity.custom',
      name: 'Custom Node',
      alwaysInclude: false,
      managed: false, // Agent-evolved
      depth: 'medium',
      maxTokens: 400,
      sensitivity: 'public',
      sources: [{ type: 'file', path: 'custom.md' }],
      description: 'Agent-created custom identity node',
    });

    // Save it
    generator.save(initial, stateDir);

    // Regenerate — should preserve managed:false
    const regenerated = generator.generate({
      projectDir,
      stateDir,
      agentName: 'TestAgent',
      hasMemory: true,
    });

    const identityLayer = regenerated.layers.find(l => l.id === 'identity')!;
    const customNode = identityLayer.children.find(n => n.id === 'identity.custom');
    expect(customNode).toBeDefined();
    expect(customNode!.managed).toBe(false);
    expect(customNode!.sources[0]).toEqual({ type: 'file', path: 'custom.md' });
  });

  // Save and load
  it('saves and loads tree config', () => {
    writeAgentMd('# TestAgent\n\nA test agent.');

    const config = generator.generate({
      projectDir,
      stateDir,
      agentName: 'TestAgent',
    });

    generator.save(config, stateDir);

    const loaded = generator.loadExisting(stateDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.agentName).toBe('TestAgent');
    expect(loaded!.layers).toHaveLength(5);
  });

  it('returns null when no tree exists', () => {
    const loaded = generator.loadExisting(stateDir);
    expect(loaded).toBeNull();
  });
});
