/**
 * TreeTriage — Two-stage relevance scoring for self-knowledge queries.
 *
 * Stage 1: Layer-level scoring (which broad categories are relevant?)
 * Stage 2: Node-level scoring (which specific nodes within those layers?)
 *
 * Primary: Rule-based keyword matching (fast, zero token cost).
 * Fallback: Haiku LLM call for ambiguous queries where rules return low confidence.
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 * Updated: Phase 0 — Two-stage triage for per-node loading
 */

import type { IntelligenceProvider } from '../core/types.js';
import type { SelfKnowledgeLayer, SelfKnowledgeNode, TriageResult } from './types.js';

const DEFAULT_THRESHOLD = 0.4;
const NODE_THRESHOLD = 0.3;
const MAX_QUERY_LENGTH = 500;

// ── Layer keyword rules (Stage 1) ──────────────────────────────

const LAYER_KEYWORDS: Record<string, string[]> = {
  identity: ['who', 'am i', 'name', 'values', 'voice', 'personality', 'identity', 'relationship', 'people'],
  experience: ['learn', 'lesson', 'experience', 'decision', 'knowledge', 'remember', 'history', 'past', 'pattern'],
  capabilities: ['can', 'tool', 'platform', 'skill', 'able', 'capability', 'do', 'feature', 'dispatch'],
  state: ['job', 'running', 'health', 'status', 'current', 'now', 'active', 'session', 'process'],
  evolution: ['goal', 'growth', 'growing', 'improve', 'evolve', 'future', 'next', 'trajectory', 'progress', 'autonomy'],
};

// ── Node keyword rules (Stage 2) ───────────────────────────────
// Maps node ID prefixes/patterns to keywords for fine-grained matching.
// These are generated from node descriptions and capability names.

const NODE_KEYWORDS: Record<string, string[]> = {
  // Capabilities layer nodes
  'capabilities.feedback': ['feedback', 'bug', 'feature request', 'report', 'improvement', 'issue'],
  'capabilities.jobs': ['job', 'scheduler', 'schedule', 'cron', 'periodic', 'recurring', 'trigger'],
  'capabilities.sessions': ['session', 'spawn', 'claude code', 'subprocess'],
  'capabilities.publishing': ['publish', 'telegraph', 'public', 'share', 'private viewer', 'view', 'page'],
  'capabilities.tunnel': ['tunnel', 'cloudflare', 'remote', 'expose', 'url', 'trycloudflare'],
  'capabilities.attention': ['attention', 'queue', 'notify', 'alert', 'priority', 'signal'],
  'capabilities.skip_ledger': ['skip', 'ledger', 'workload', 'already processed', 'dedup'],
  'capabilities.handoff': ['handoff', 'notes', 'next run', 'continuity', 'between runs'],
  'capabilities.dispatches': ['dispatch', 'behavioral', 'guidance', 'instructions', 'auto-dispatch'],
  'capabilities.updates': ['update', 'upgrade', 'version', 'rollback', 'auto-update', 'npm'],
  'capabilities.ci': ['ci', 'github actions', 'build', 'pipeline', 'continuous integration', 'test'],
  'capabilities.telegram_api': ['telegram', 'message', 'topic', 'chat', 'send message', 'reply'],
  'capabilities.quota': ['quota', 'usage', 'api usage', 'rate limit', 'tokens used'],
  'capabilities.triage': ['stall', 'triage', 'stuck', 'recover', 'session recovery'],
  'capabilities.dashboard': ['dashboard', 'file viewer', 'files tab', 'pin', 'mobile', 'browser'],
  'capabilities.backups': ['backup', 'snapshot', 'restore', 'state backup'],
  'capabilities.memory_search': ['memory search', 'search memory', 'fts', 'full text', 'remember'],
  'capabilities.git_sync': ['git sync', 'git push', 'git pull', 'synchronize', 'multi-machine'],
  'capabilities.agent_registry': ['agent registry', 'other agents', 'agents on machine', 'discover agents'],
  'capabilities.events': ['event', 'sse', 'server-sent', 'stream', 'real-time'],
  'capabilities.web_fetch': ['web', 'fetch', 'url', 'download', 'smart-fetch', 'llms.txt', 'markdown'],
  'capabilities.browser': ['browser', 'playwright', 'chrome', 'automation', 'popup', 'extension'],
  'capabilities.building': ['build', 'new capability', 'create', 'extend', 'self-modification'],
  'capabilities.skills': ['skill', 'slash command', '/command', 'reusable', 'behavioral'],
  'capabilities.scripts': ['script', '.claude/scripts', 'reusable', 'bash'],
  'capabilities.secrets': ['secret', 'secret drop', 'password', 'api key', 'token', 'credential', 'secure', 'share secret', 'collect secret', 'one-time link'],
  'capabilities.self_discovery': ['self-discovery', 'capabilities endpoint', 'what can i do'],
  'capabilities.registry_first': ['registry', 'state files', 'source of truth', 'check first'],
  'capabilities.architecture': ['architecture', 'how does it work', 'endpoints', 'multi-user', 'multi-machine'],
  'capabilities.canonical_identity': ['identity', 'canonical id', 'fingerprint', 'ed25519', 'keypair', 'identity.json', 'recovery phrase', 'key rotation', 'revocation'],
  'capabilities.trust_model': ['trust', 'trust level', 'untrusted', 'verified', 'trusted', 'trust decay', 'trust evaluator', 'three-layer', 'trust baseline'],
  'capabilities.authorization': ['authorization', 'permission', 'grant', 'deny', 'allow', 'delegation', 'policy', 'scoped', 'time-bounded'],
  'capabilities.invitations': ['invitation', 'invite', 'token', 'secure invitation', 'ed25519 invitation', 'recipient binding'],
  'capabilities.sybil_protection': ['sybil', 'proof of work', 'pow', 'ip rate limit', 'identity aging', 'anti-spam', 'relay protection'],
  'capabilities.discovery_waterfall': ['discovery', 'waterfall', 'discover agents', 'find agents', 'local discovery', 'relay discovery', 'moltbridge discovery'],
  'capabilities.message_security': ['message security', 'framing', 'prompt injection', 'injection detection', 'sanitization', 'role separation'],
  'capabilities.audit_log': ['audit', 'audit log', 'hash chain', 'tamper detection', 'trust audit', 'integrity verification'],
  'capabilities.moltbridge': ['moltbridge', 'trust network', 'iqs', 'attestation', 'capability vocabulary', 'network trust', 'reputation'],

  // Existing default nodes
  'capabilities.platforms': ['platform', 'integration', 'telegram', 'messaging'],
  'capabilities.tools': ['tool', 'script', 'skill', 'command'],
  'capabilities.edges': ['limitation', 'edge', 'boundary', 'constraint', 'cannot'],

  // Identity layer nodes
  'identity.core': ['who', 'name', 'identity', 'values', 'personality', 'voice', 'relationship'],
  'identity.execution_context': ['permission', 'access', 'sandbox', 'autonomous', 'security'],
  'identity.remote_control': ['remote', 'control', 'monitor', 'claude.ai'],

  // Experience layer nodes
  'experience.lessons': ['lesson', 'learned', 'insight', 'pattern', 'mistake'],
  'experience.decisions': ['decision', 'tradeoff', 'chose', 'alternative'],
  'experience.sessions': ['recent session', 'conversation', 'last time'],
  'experience.principles': ['principle', 'rule', 'guideline', 'approach'],
  'experience.anti_patterns': ['anti-pattern', 'avoid', 'trap', 'pitfall', 'don\'t'],
  'experience.gravity_wells': ['gravity well', 'persistent trap', 'recurring mistake'],
  'experience.proactivity': ['proactive', 'suggest', 'initiative', 'when to'],
  'experience.tone': ['tone', 'conversational', 'communication', 'how to talk'],

  // State layer nodes
  'state.active_jobs': ['active jobs', 'running jobs', 'scheduled', 'cron'],
  'state.session': ['current session', 'active session', 'running'],
  'state.health': ['health', 'server', 'uptime', 'system status'],

  // Evolution layer nodes
  'evolution.growth_edges': ['growth', 'improve', 'capability gap', 'evolve'],
  'evolution.dispatch_patterns': ['dispatch', 'behavioral update', 'instruction'],
  'evolution.pending': ['pending', 'todo', 'next', 'backlog'],
  'evolution.system': ['evolution system', 'proposal', 'learning registry', 'action queue'],
  'evolution.intent': ['intent', 'mission', 'tradeoff', 'boundary', 'journal'],
  'evolution.playbook': ['playbook', 'context engineering', 'manifest', 'adaptive'],
  'evolution.innovation': ['innovation', 'upstream', 'share', 'generalizable'],
  'evolution.self_diagnosis': ['diagnosis', 'self-diagnosis', 'qa', 'bug report', 'detect issue'],
  'evolution.feedback_loop': ['feedback loop', 'rising tide', 'downstream', 'auto-updater'],
};

/**
 * Two-stage relevance scoring for self-knowledge queries.
 *
 * Stage 1: Score layers (broad categories)
 * Stage 2: Score nodes within relevant layers (specific topics)
 */
export class TreeTriage {
  private intelligence: IntelligenceProvider | null;
  private threshold: number;
  private nodeThreshold: number;

  constructor(intelligence: IntelligenceProvider | null, threshold?: number) {
    this.intelligence = intelligence;
    this.threshold = threshold ?? DEFAULT_THRESHOLD;
    this.nodeThreshold = NODE_THRESHOLD;
  }

  get relevanceThreshold(): number {
    return this.threshold;
  }

  /**
   * Sanitize query input — prevent injection and enforce limits.
   */
  private sanitizeQuery(query: string): string {
    // Length limit
    let sanitized = query.slice(0, MAX_QUERY_LENGTH);
    // Strip control characters
    sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // Strip HTML tags
    sanitized = sanitized.replace(/<[^>]*>/g, '');
    return sanitized.trim();
  }

  /**
   * Two-stage triage: score layers, then score nodes within relevant layers.
   *
   * Intelligence-first: LLM is the primary path for accurate semantic matching.
   * Rule-based keyword matching is the fallback ONLY when LLM is unavailable.
   *
   * Rationale: String matching silently fails on synonyms, typos, and natural
   * language phrasing. A lightweight model (Haiku) catches what rules miss.
   * "Efficient" means a fast model, not regex.
   */
  async triage(query: string, layers: SelfKnowledgeLayer[]): Promise<TriageResult> {
    const sanitized = this.sanitizeQuery(query);
    const layerIds = layers.map(l => l.id);
    const start = Date.now();

    let layerScores: Record<string, number>;
    let nodeScores: Record<string, number>;
    let mode: 'llm' | 'rule-based';

    if (this.intelligence) {
      // PRIMARY PATH: LLM-powered triage (semantic understanding)
      try {
        // Stage 1: LLM scores layers
        const llmResult = await this.llmTriage(sanitized, layers);
        layerScores = llmResult.scores;

        // Stage 2: LLM scores nodes within relevant layers
        const relevantLayers = layers.filter(l => (layerScores[l.id] ?? 0) >= this.threshold);
        if (relevantLayers.length > 0) {
          nodeScores = await this.llmNodeTriage(sanitized, relevantLayers);
        } else {
          nodeScores = {};
        }
        mode = 'llm';
      } catch {
        // LLM failed — fall back to rule-based
        const fallback = this.ruleBasedFallback(sanitized, layers, layerIds, start);
        layerScores = fallback.layerScores;
        nodeScores = fallback.nodeScores;
        mode = 'rule-based';
      }
    } else {
      // FALLBACK: Rule-based keyword matching (LLM unavailable)
      const fallback = this.ruleBasedFallback(sanitized, layers, layerIds, start);
      layerScores = fallback.layerScores;
      nodeScores = fallback.nodeScores;
      mode = 'rule-based';
    }

    // Ensure alwaysInclude nodes have minimum scores
    for (const layer of layers) {
      for (const node of layer.children) {
        if (node.alwaysInclude) {
          nodeScores[node.id] = Math.max(nodeScores[node.id] ?? 0, 0.5);
        }
      }
    }

    return {
      scores: layerScores,
      nodeScores,
      mode,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * Filter layers by triage scores, returning those above threshold.
   */
  filterRelevantLayers(
    layers: SelfKnowledgeLayer[],
    scores: Record<string, number>,
  ): SelfKnowledgeLayer[] {
    return layers.filter(l => (scores[l.id] ?? 0) >= this.threshold);
  }

  /**
   * Filter nodes by node-level scores, returning those above node threshold.
   * Nodes with alwaysInclude are always returned regardless of score.
   */
  filterRelevantNodes(
    nodes: SelfKnowledgeNode[],
    nodeScores: Record<string, number>,
  ): SelfKnowledgeNode[] {
    return nodes.filter(n => {
      if (n.alwaysInclude) return true;
      return (nodeScores[n.id] ?? 0) >= this.nodeThreshold;
    });
  }

  /**
   * Score individual nodes within the given layers using keyword matching.
   * Returns a map of nodeId → relevance score (0.0-1.0).
   */
  private scoreNodes(
    query: string,
    layers: SelfKnowledgeLayer[],
  ): Record<string, number> {
    const lower = query.toLowerCase();
    const scores: Record<string, number> = {};

    for (const layer of layers) {
      for (const node of layer.children) {
        // Check node-specific keywords
        const keywords = NODE_KEYWORDS[node.id] ?? [];
        let matchCount = 0;

        for (const kw of keywords) {
          if (lower.includes(kw.toLowerCase())) {
            // Multi-word keywords get more weight
            matchCount += kw.includes(' ') ? 2 : 1;
          }
        }

        // Also check against node name and description
        const nameWords = node.name.toLowerCase().split(/\s+/);
        for (const word of nameWords) {
          if (word.length > 2 && lower.includes(word)) {
            matchCount += 0.5;
          }
        }

        if (node.description) {
          const descWords = node.description.toLowerCase().split(/\s+/);
          for (const word of descWords) {
            if (word.length > 3 && lower.includes(word)) {
              matchCount += 0.3;
            }
          }
        }

        // Score: scale by match count, cap at 1.0
        scores[node.id] = Math.min(1, matchCount * 0.25);

        // alwaysInclude nodes get a minimum score
        if (node.alwaysInclude) {
          scores[node.id] = Math.max(scores[node.id], 0.5);
        }
      }
    }

    return scores;
  }

  /**
   * Validate that a set of node IDs are all known in the tree config.
   * Returns only IDs that exist in the provided layers.
   */
  validateNodeIds(nodeIds: string[], layers: SelfKnowledgeLayer[]): string[] {
    const knownIds = new Set<string>();
    for (const layer of layers) {
      for (const node of layer.children) {
        knownIds.add(node.id);
      }
    }
    return nodeIds.filter(id => knownIds.has(id));
  }

  /**
   * Rule-based fallback: combines layer keywords + node keywords + node boost.
   * Used ONLY when LLM intelligence is unavailable.
   */
  private ruleBasedFallback(
    query: string,
    layers: SelfKnowledgeLayer[],
    layerIds: string[],
    startTime: number,
  ): { layerScores: Record<string, number>; nodeScores: Record<string, number> } {
    const ruleResult = this.ruleBasedLayerTriage(query, layerIds, startTime);

    // Score nodes via keyword matching
    const allNodeScores = this.scoreNodes(query, layers);

    // Boost layer scores from node keyword matches
    const boostedLayerScores = { ...ruleResult.scores };
    for (const layer of layers) {
      const layerNodeScores = layer.children
        .map(n => allNodeScores[n.id] ?? 0)
        .filter(s => s > 0);
      if (layerNodeScores.length > 0) {
        const maxNodeScore = Math.max(...layerNodeScores);
        boostedLayerScores[layer.id] = Math.max(
          boostedLayerScores[layer.id] ?? 0,
          maxNodeScore,
        );
      }
    }

    // Filter node scores to relevant layers only
    const relevantLayers = layers.filter(l => (boostedLayerScores[l.id] ?? 0) >= this.threshold);
    const relevantNodeIds = new Set(relevantLayers.flatMap(l => l.children.map(n => n.id)));
    const filteredNodeScores: Record<string, number> = {};
    for (const [nodeId, score] of Object.entries(allNodeScores)) {
      if (relevantNodeIds.has(nodeId)) {
        filteredNodeScores[nodeId] = score;
      }
    }

    return { layerScores: boostedLayerScores, nodeScores: filteredNodeScores };
  }

  /**
   * LLM-powered node-level triage within relevant layers.
   * Single call to score which specific nodes are relevant to the query.
   */
  private async llmNodeTriage(
    query: string,
    relevantLayers: SelfKnowledgeLayer[],
  ): Promise<Record<string, number>> {
    const nodes = relevantLayers.flatMap(l => l.children);
    if (nodes.length === 0) return {};

    // Even for small node sets, use LLM when available — uniform scores
    // defeat the purpose of triage. Fall back to keywords only if LLM fails.

    const nodeDescriptions = nodes
      .map(n => `- ${n.id}: ${n.description ?? n.name}`)
      .join('\n');

    const prompt = `Given the query: "${query}"

Which of these knowledge nodes are relevant? Score each 0.0-1.0 (0 = irrelevant, 1 = highly relevant):
${nodeDescriptions}

Return ONLY valid JSON mapping node IDs to scores.`;

    const response = await this.intelligence!.evaluate(prompt, {
      model: 'fast',
      maxTokens: 500,
      temperature: 0,
    });

    return this.parseNodeTriageResponse(response, nodes.map(n => n.id), query, relevantLayers);
  }

  /**
   * Parse LLM response for node-level scores.
   * Falls back to keyword matching (not uniform scores) when LLM output is unparseable.
   */
  private parseNodeTriageResponse(
    response: string,
    nodeIds: string[],
    query: string,
    layers: SelfKnowledgeLayer[],
  ): Record<string, number> {
    // Use a greedy regex that handles multi-line JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // LLM didn't return JSON — fall back to keyword matching, not uniform scores
      return this.scoreNodes(query, layers);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // Invalid JSON — fall back to keyword matching
      return this.scoreNodes(query, layers);
    }

    const scores: Record<string, number> = {};
    for (const id of nodeIds) {
      const raw = parsed[id];
      if (typeof raw === 'number' && !isNaN(raw)) {
        scores[id] = Math.max(0, Math.min(1, raw));
      } else {
        scores[id] = 0;
      }
    }

    return scores;
  }

  private async llmTriage(query: string, layers: SelfKnowledgeLayer[]): Promise<TriageResult> {
    const start = Date.now();

    const layerDescriptions = layers
      .map(l => `- ${l.id}: ${l.description}`)
      .join('\n');

    const prompt = `Given an agent self-knowledge query: "${query}"

Which self-knowledge layers are relevant? Score each 0.0-1.0:
${layerDescriptions}

Return ONLY valid JSON, no explanation: {"${layers.map(l => l.id).join('": 0.0, "')}": 0.0}`;

    const response = await this.intelligence!.evaluate(prompt, {
      model: 'fast',
      maxTokens: 200,
      temperature: 0,
    });

    const scores = this.parseTriageResponse(response, layers.map(l => l.id));

    return {
      scores,
      mode: 'llm',
      elapsedMs: Date.now() - start,
    };
  }

  private parseTriageResponse(response: string, layerIds: string[]): Record<string, number> {
    // Extract JSON from response (may contain extra text)
    const jsonMatch = response.match(/\{[^}]+\}/);
    if (!jsonMatch) {
      throw new Error(`Triage response contained no JSON: ${response.slice(0, 200)}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error(`Invalid JSON in triage response: ${jsonMatch[0].slice(0, 200)}`);
    }

    // Validate and clamp scores
    const scores: Record<string, number> = {};
    for (const id of layerIds) {
      const raw = parsed[id];
      if (typeof raw === 'number' && !isNaN(raw)) {
        scores[id] = Math.max(0, Math.min(1, raw));
      } else {
        scores[id] = 0;
      }
    }

    return scores;
  }

  private ruleBasedLayerTriage(
    query: string,
    layerIds: string[],
    startTime: number,
  ): TriageResult {
    const lower = query.toLowerCase();
    const scores: Record<string, number> = {};

    for (const id of layerIds) {
      const keywords = LAYER_KEYWORDS[id] ?? [];
      const matches = keywords.filter(kw => lower.includes(kw)).length;
      // Score proportional to keyword matches, capped at 1.0
      scores[id] = Math.min(1, matches * 0.3);
    }

    // If no keywords matched anything, give identity a baseline
    const hasAnyMatch = Object.values(scores).some(s => s >= this.threshold);
    if (!hasAnyMatch) {
      scores['identity'] = 0.5;
    }

    return {
      scores,
      mode: 'rule-based',
      elapsedMs: Date.now() - startTime,
    };
  }
}
