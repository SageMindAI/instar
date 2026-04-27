import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TreeTraversal } from '../../src/knowledge/TreeTraversal.js';
import { ProbeRegistry } from '../../src/knowledge/ProbeRegistry.js';
import type { SelfKnowledgeNode } from '../../src/knowledge/types.js';

describe('TreeTraversal', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;
  let probeRegistry: ProbeRegistry;
  let traversal: TreeTraversal;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-traversal-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Create test files
    fs.writeFileSync(
      path.join(projectDir, 'AGENT.md'),
      '# Test Agent\n\nI am a test agent.\n\n## Values\n\nI value testing.\n\n## Voice\n\nI speak concisely.',
    );

    probeRegistry = new ProbeRegistry();
    traversal = new TreeTraversal({
      projectDir,
      stateDir,
      probeRegistry,
    });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Gate Test 1.12: File source reads AGENT.md correctly
  it('reads file source correctly', async () => {
    const node: SelfKnowledgeNode = {
      id: 'identity.core',
      name: 'Core Identity',
      alwaysInclude: true,
      managed: true,
      depth: 'shallow',
      maxTokens: 500,
      sensitivity: 'public',
      sources: [{ type: 'file', path: 'AGENT.md' }],
    };

    const { fragments, errors } = await traversal.gather(
      [node],
      { identity: 0.9 },
    );

    expect(fragments).toHaveLength(1);
    expect(fragments[0].content).toContain('Test Agent');
    expect(fragments[0].nodeId).toBe('identity.core');
    expect(errors).toHaveLength(0);
  });

  // Gate Test 1.15: Per-source timeout isolation
  it('isolates per-source timeouts', async () => {
    // Register a slow probe that will timeout
    probeRegistry.register(
      'slow',
      async () => {
        await new Promise(r => setTimeout(r, 60_000));
        return { content: '', truncated: false, elapsedMs: 0 };
      },
      { timeoutMs: 100 },
    );

    const nodes: SelfKnowledgeNode[] = [
      {
        id: 'state.health',
        name: 'Health',
        alwaysInclude: false,
        managed: true,
        depth: 'shallow',
        maxTokens: 200,
        sensitivity: 'internal',
        sources: [{ type: 'probe', name: 'slow' }],
      },
      {
        id: 'identity.core',
        name: 'Core',
        alwaysInclude: true,
        managed: true,
        depth: 'shallow',
        maxTokens: 500,
        sensitivity: 'public',
        sources: [{ type: 'file', path: 'AGENT.md' }],
      },
    ];

    const { fragments } = await traversal.gather(nodes, { identity: 0.9, state: 0.5 });

    // The file source should still succeed even though the probe timed out
    const fileFragment = fragments.find(f => f.nodeId === 'identity.core');
    expect(fileFragment).toBeDefined();
    expect(fileFragment!.content).toContain('Test Agent');
  }, 10_000);

  // Gate Test 1.20: Synthesis respects maxTokens per node
  it('truncates content at maxTokens', async () => {
    // Create a large file
    fs.writeFileSync(path.join(projectDir, 'big.md'), 'word '.repeat(5000));

    const node: SelfKnowledgeNode = {
      id: 'identity.big',
      name: 'Big Node',
      alwaysInclude: false,
      managed: true,
      depth: 'deep',
      maxTokens: 100, // ~400 chars
      sensitivity: 'public',
      sources: [{ type: 'file', path: 'big.md' }],
    };

    const { fragments } = await traversal.gather([node], { identity: 0.9 });
    expect(fragments).toHaveLength(1);
    // maxTokens * 4 chars/token = 400 chars, content should be truncated
    expect(fragments[0].content.length).toBeLessThanOrEqual(420); // 400 + "\n[truncated]"
    expect(fragments[0].content).toContain('[truncated]');
  });

  // Gate Test 1.16/1.17: Caching behavior
  describe('caching', () => {
    it('returns cached content on second call', async () => {
      const node: SelfKnowledgeNode = {
        id: 'identity.core',
        name: 'Core',
        alwaysInclude: true,
        managed: true,
        depth: 'shallow',
        maxTokens: 500,
        sensitivity: 'public',
        sources: [{ type: 'file', path: 'AGENT.md' }],
      };

      // First call — cache miss
      const first = await traversal.gather([node], { identity: 0.9 });
      expect(first.fragments[0].cached).toBe(false);

      // Second call — cache hit
      const second = await traversal.gather([node], { identity: 0.9 });
      expect(second.fragments[0].cached).toBe(true);
      expect(second.fragments[0].content).toBe(first.fragments[0].content);
    });

    it('cache stats track hits and misses', async () => {
      const node: SelfKnowledgeNode = {
        id: 'identity.core',
        name: 'Core',
        alwaysInclude: true,
        managed: true,
        depth: 'shallow',
        maxTokens: 500,
        sensitivity: 'public',
        sources: [{ type: 'file', path: 'AGENT.md' }],
      };

      await traversal.gather([node], { identity: 0.9 });
      await traversal.gather([node], { identity: 0.9 });

      const stats = traversal.cacheStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    it('invalidateTier clears tier-specific entries', async () => {
      const node: SelfKnowledgeNode = {
        id: 'identity.core',
        name: 'Core',
        alwaysInclude: true,
        managed: true,
        depth: 'shallow',
        maxTokens: 500,
        sensitivity: 'public',
        sources: [{ type: 'file', path: 'AGENT.md' }],
      };

      await traversal.gather([node], { identity: 0.9 });
      traversal.invalidateTier('identity');

      const after = await traversal.gather([node], { identity: 0.9 });
      expect(after.fragments[0].cached).toBe(false);
    });
  });

  // Gate Test 1.27: Sensitivity filtering
  it('skips internal nodes when publicOnly', async () => {
    const nodes: SelfKnowledgeNode[] = [
      {
        id: 'identity.core',
        name: 'Core',
        alwaysInclude: true,
        managed: true,
        depth: 'shallow',
        maxTokens: 500,
        sensitivity: 'public',
        sources: [{ type: 'file', path: 'AGENT.md' }],
      },
      {
        id: 'identity.internal',
        name: 'Internal',
        alwaysInclude: false,
        managed: true,
        depth: 'shallow',
        maxTokens: 500,
        sensitivity: 'internal',
        sources: [{ type: 'file', path: 'AGENT.md' }],
      },
    ];

    const { fragments } = await traversal.gather(nodes, { identity: 0.9 }, { publicOnly: true });
    expect(fragments).toHaveLength(1);
    expect(fragments[0].nodeId).toBe('identity.core');
  });

  // Gate Test 1.24/1.25: Missing/empty source file handling
  it('handles missing source files gracefully', async () => {
    const node: SelfKnowledgeNode = {
      id: 'identity.ghost',
      name: 'Ghost',
      alwaysInclude: false,
      managed: true,
      depth: 'shallow',
      maxTokens: 500,
      sensitivity: 'public',
      sources: [{ type: 'file', path: 'nonexistent.md' }],
    };

    const { fragments } = await traversal.gather([node], { identity: 0.9 });
    // No fragments because source returned null
    expect(fragments).toHaveLength(0);
  });

  // Path traversal security (X1.12)
  it('rejects path traversal attempts', async () => {
    const node: SelfKnowledgeNode = {
      id: 'identity.evil',
      name: 'Evil',
      alwaysInclude: false,
      managed: true,
      depth: 'shallow',
      maxTokens: 500,
      sensitivity: 'public',
      sources: [{ type: 'file', path: '../../../../etc/passwd' }],
    };

    const { fragments } = await traversal.gather([node], { identity: 0.9 });
    expect(fragments).toHaveLength(0);
  });

  // File section reading
  it('reads file sections correctly', async () => {
    const node: SelfKnowledgeNode = {
      id: 'identity.values',
      name: 'Values',
      alwaysInclude: false,
      managed: true,
      depth: 'shallow',
      maxTokens: 500,
      sensitivity: 'public',
      sources: [{ type: 'file_section', path: 'AGENT.md', section: 'Values' }],
    };

    const { fragments } = await traversal.gather([node], { identity: 0.9 });
    expect(fragments).toHaveLength(1);
    expect(fragments[0].content).toContain('testing');
    expect(fragments[0].content).not.toContain('concisely'); // From Voice section, should not be included
  });

  // State file reading
  it('reads state files', async () => {
    fs.writeFileSync(
      path.join(stateDir, 'session-history.json'),
      JSON.stringify({ recent: ['session-1', 'session-2'] }),
    );

    const node: SelfKnowledgeNode = {
      id: 'experience.sessions',
      name: 'Sessions',
      alwaysInclude: false,
      managed: true,
      depth: 'shallow',
      maxTokens: 500,
      sensitivity: 'internal',
      sources: [{ type: 'state_file', key: 'session-history' }],
    };

    const { fragments } = await traversal.gather([node], { experience: 0.8 });
    expect(fragments).toHaveLength(1);
    expect(fragments[0].content).toContain('session-1');
  });
});
