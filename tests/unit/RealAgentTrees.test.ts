import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TreeGenerator } from '../../src/knowledge/TreeGenerator.js';
import { SelfKnowledgeTree } from '../../src/knowledge/SelfKnowledgeTree.js';

/**
 * Gate Test 3.6: Test tree generation with real agent state directories.
 * These tests read real agent AGENT.md files and configs to verify
 * the tree generates sensibly for production agents.
 */
describe('Real Agent Tree Generation (Gate Test 3.6)', () => {
  const agents = [
    {
      name: 'AI Guy',
      projectDir: '/Users/justin/Documents/Projects/ai-guy',
      stateDir: '/Users/justin/Documents/Projects/ai-guy/.instar',
    },
    {
      name: 'DeepSignal',
      projectDir: '/Users/justin/Documents/Projects/deep-signal',
      stateDir: '/Users/justin/Documents/Projects/deep-signal/.instar',
    },
    {
      name: 'SageMind',
      projectDir: '/Users/justin/Documents/Projects/sagemind',
      stateDir: '/Users/justin/Documents/Projects/sagemind/.instar',
    },
  ];

  for (const agent of agents) {
    const agentMdExists = fs.existsSync(path.join(agent.stateDir, 'AGENT.md'));

    it.skipIf(!agentMdExists)(`generates valid tree for ${agent.name}`, () => {
      const generator = new TreeGenerator();

      // Detect platforms from config
      let platforms: string[] = [];
      const configPath = path.join(agent.stateDir, 'config.json');
      if (fs.existsSync(configPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (Array.isArray(cfg.messaging)) {
            platforms = cfg.messaging
              .filter((m: any) => m.enabled !== false && m.type)
              .map((m: any) => m.type);
          }
        } catch { /* skip */ }
      }

      const config = generator.generate({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        agentName: agent.name,
        hasMemory: true,
        hasJobs: true,
        hasDecisionJournal: true,
        platforms,
      });

      // Basic structure
      expect(config.version).toBe('1.0');
      expect(config.agentName).toBe(agent.name);
      expect(config.layers).toHaveLength(5);

      // Must have all 5 layers
      const layerIds = config.layers.map(l => l.id);
      expect(layerIds).toContain('identity');
      expect(layerIds).toContain('experience');
      expect(layerIds).toContain('capabilities');
      expect(layerIds).toContain('state');
      expect(layerIds).toContain('evolution');

      // Identity layer must have core node
      const identityLayer = config.layers.find(l => l.id === 'identity')!;
      expect(identityLayer.children.some(n => n.id === 'identity.core')).toBe(true);

      // Total nodes should be reasonable (10-30 for a typical agent)
      const totalNodes = config.layers.reduce((s, l) => s + l.children.length, 0);
      expect(totalNodes).toBeGreaterThanOrEqual(5);
      expect(totalNodes).toBeLessThanOrEqual(50);

      // All nodes must have valid structure
      for (const layer of config.layers) {
        for (const node of layer.children) {
          expect(node.id).toBeTruthy();
          expect(node.name).toBeTruthy();
          expect(node.sources).toBeDefined();
          expect(node.sources.length).toBeGreaterThanOrEqual(1);
          expect(node.maxTokens).toBeGreaterThan(0);
          expect(['public', 'internal']).toContain(node.sensitivity);
        }
      }

      // Platform nodes should exist if platforms were detected
      if (platforms.length > 0) {
        const stateLayer = config.layers.find(l => l.id === 'state')!;
        for (const platform of platforms) {
          const hasNode = stateLayer.children.some(
            n => n.id === `state.${platform.toLowerCase()}`,
          );
          expect(hasNode).toBe(true);
        }
      }

      console.log(`  ${agent.name}: ${totalNodes} nodes, platforms: [${platforms.join(', ')}]`);
    });

    it.skipIf(!agentMdExists)(`${agent.name} tree validates without errors`, () => {
      const tree = new SelfKnowledgeTree({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        intelligence: null,
      });

      // Generate tree (don't save — we don't want to modify real agent dirs)
      const generator = new TreeGenerator();
      generator.generate({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        agentName: agent.name,
        hasMemory: true,
      });

      // Note: We can't run validate() without saving the tree file.
      // Instead, verify the generator output is structurally valid.
      const config = generator.generate({
        projectDir: agent.projectDir,
        stateDir: agent.stateDir,
        agentName: agent.name,
        hasMemory: true,
      });

      // No duplicate node IDs
      const allNodeIds = config.layers.flatMap(l => l.children.map(n => n.id));
      const uniqueIds = new Set(allNodeIds);
      expect(uniqueIds.size).toBe(allNodeIds.length);

      // Budget should use haiku
      expect(config.budget.model).toBe('haiku');
      expect(config.budget.maxLlmCalls).toBeGreaterThan(0);
    });
  }
});
