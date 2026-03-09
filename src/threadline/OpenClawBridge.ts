/**
 * OpenClawBridge — Adapter between OpenClaw's session model and Threadline's
 * thread-based model.
 *
 * Part of Threadline Protocol Phase 6D. OpenClaw (formerly ElizaOS) uses a
 * session-based agent model with skills (plugins) that define actions,
 * providers, and evaluators. This bridge translates between that model and
 * Threadline's thread-based persistent conversations.
 *
 * Key mappings:
 * - OpenClaw roomId → Threadline threadId (via ContextThreadMap)
 * - OpenClaw userId → Threadline agent identity
 * - OpenClaw actions → Threadline operations (send, discover, history, status)
 *
 * No external SDK dependency — OpenClaw interfaces are defined locally and
 * all dependencies are injected via config.
 */

import type { AgentTrustManager, AgentTrustLevel } from './AgentTrustManager.js';
import type { ComputeMeter, MeterCheckResult } from './ComputeMeter.js';
import type { ContextThreadMap } from './ContextThreadMap.js';

// ── OpenClaw Interface Types ──────────────────────────────────────────
// These match OpenClaw's API patterns without requiring the SDK as a dependency.

export interface OpenClawMessage {
  userId: string;
  roomId: string;
  content: { text: string };
  metadata?: Record<string, unknown>;
}

export interface OpenClawRuntime {
  agentId: string;
  character: { name: string; description?: string };
  getSetting(key: string): string | undefined;
  messageManager: {
    createMemory(memory: unknown): Promise<void>;
    getMemories(opts: { roomId: string; count?: number }): Promise<unknown[]>;
  };
}

export interface OpenClawAction {
  name: string;
  description: string;
  validate: (runtime: OpenClawRuntime, message: OpenClawMessage) => Promise<boolean>;
  handler: (runtime: OpenClawRuntime, message: OpenClawMessage, state?: unknown) => Promise<unknown>;
  examples: Array<Array<{ user: string; content: { text: string } }>>;
}

// ── Bridge Types ──────────────────────────────────────────────────────

export interface BridgeSendParams {
  fromAgent: string;
  threadId: string;
  message: string;
  isNewThread: boolean;
}

export interface BridgeResponse {
  message: string;
  tokenCount?: number;
}

export interface BridgeAgentInfo {
  name: string;
  description?: string;
  trustLevel?: AgentTrustLevel;
  capabilities?: string[];
}

export interface BridgeHistoryMessage {
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
}

export interface OpenClawBridgeConfig {
  stateDir: string;
  /** Callback to send message through Threadline */
  sendMessage: (params: BridgeSendParams) => Promise<BridgeResponse>;
  /** Callback to discover agents */
  discoverAgents?: () => Promise<BridgeAgentInfo[]>;
  /** Callback to get thread history */
  getHistory?: (threadId: string, limit?: number) => Promise<BridgeHistoryMessage[]>;
  /** Trust manager for checking agent trust levels */
  trustManager?: AgentTrustManager;
  /** Compute meter for tracking usage */
  computeMeter?: ComputeMeter;
  /** Context-thread mapping */
  contextThreadMap?: ContextThreadMap;
}

export interface OpenClawBridgeMetrics {
  messagesProcessed: number;
  threadsActive: number;
  errors: number;
}

// ── Constants ──────────────────────────────────────────────────────────

/** Default trust level for agents arriving via OpenClaw */
const DEFAULT_TRUST_LEVEL: AgentTrustLevel = 'untrusted';

/** Default token estimate per message when actual count is unavailable */
const DEFAULT_TOKEN_ESTIMATE = 500;

// ── Implementation ─────────────────────────────────────────────────────

export class OpenClawBridge {
  private readonly config: OpenClawBridgeConfig;
  private readonly roomToThread: Map<string, string>;
  private metrics: OpenClawBridgeMetrics;

  constructor(config: OpenClawBridgeConfig) {
    this.config = config;
    this.roomToThread = new Map();
    this.metrics = {
      messagesProcessed: 0,
      threadsActive: 0,
      errors: 0,
    };
  }

  // ── Actions ───────────────────────────────────────────────────────

  /**
   * Get all OpenClaw-compatible actions that this bridge provides.
   * These can be registered as actions in an OpenClaw skill.
   */
  getActions(): OpenClawAction[] {
    return [
      this.createSendAction(),
      this.createDiscoverAction(),
      this.createHistoryAction(),
      this.createStatusAction(),
    ];
  }

  // ── Message Processing ────────────────────────────────────────────

  /**
   * Process an incoming OpenClaw message through the Threadline bridge.
   * Maps the OpenClaw roomId to a Threadline threadId, checks trust and
   * compute budgets, then forwards via the sendMessage callback.
   */
  async processMessage(runtime: OpenClawRuntime, message: OpenClawMessage): Promise<string> {
    try {
      const agentIdentity = this.resolveAgentIdentity(runtime, message);
      const trustLevel = this.getAgentTrustLevel(agentIdentity);

      // Check trust — untrusted agents can only ping/health, not message
      if (this.config.trustManager) {
        const allowed = this.config.trustManager.checkPermission(agentIdentity, 'message');
        if (!allowed) {
          this.metrics.errors++;
          return `[bridge-error] Agent "${agentIdentity}" does not have permission to send messages. Current trust level: ${trustLevel}`;
        }
      }

      // Check compute budget
      if (this.config.computeMeter) {
        const tokenEstimate = DEFAULT_TOKEN_ESTIMATE;
        const check = this.config.computeMeter.check(agentIdentity, trustLevel, tokenEstimate);
        if (!check.allowed) {
          this.metrics.errors++;
          const retryMsg = check.retryAfterSeconds
            ? ` Retry after ${check.retryAfterSeconds} seconds.`
            : '';
          return `[bridge-error] Compute budget exceeded: ${check.reason}.${retryMsg}`;
        }
      }

      // Resolve thread
      const { threadId, isNewThread } = this.resolveThread(message.roomId, agentIdentity);

      // Send through Threadline
      const response = await this.config.sendMessage({
        fromAgent: agentIdentity,
        threadId,
        message: message.content.text,
        isNewThread,
      });

      // Record compute usage
      if (this.config.computeMeter) {
        const tokenCount = response.tokenCount ?? DEFAULT_TOKEN_ESTIMATE;
        this.config.computeMeter.record(agentIdentity, trustLevel, tokenCount);
      }

      // Record interaction
      if (this.config.trustManager) {
        this.config.trustManager.recordMessageReceived(agentIdentity);
        this.config.trustManager.recordInteraction(agentIdentity, true);
      }

      this.metrics.messagesProcessed++;
      return response.message;
    } catch (err) {
      this.metrics.errors++;

      // Record failed interaction
      const agentIdentity = this.resolveAgentIdentity(runtime, message);
      if (this.config.trustManager) {
        this.config.trustManager.recordInteraction(agentIdentity, false, String(err));
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      return `[bridge-error] Failed to process message: ${errorMessage}`;
    }
  }

  // ── Thread Mapping ────────────────────────────────────────────────

  /**
   * Get the Threadline threadId for an OpenClaw roomId + agentId pair.
   * Returns null if no mapping exists.
   */
  getThreadId(roomId: string, agentId: string): string | null {
    // Check ContextThreadMap first (persistent, identity-bound)
    if (this.config.contextThreadMap) {
      return this.config.contextThreadMap.getThreadId(roomId, agentId);
    }

    // Fall back to in-memory map
    const key = `${roomId}::${agentId}`;
    return this.roomToThread.get(key) ?? null;
  }

  // ── Metrics ───────────────────────────────────────────────────────

  /**
   * Get current bridge metrics.
   */
  getMetrics(): OpenClawBridgeMetrics {
    return { ...this.metrics };
  }

  // ── Private: Action Builders ──────────────────────────────────────

  private createSendAction(): OpenClawAction {
    const bridge = this;

    return {
      name: 'THREADLINE_SEND',
      description: 'Send a message to a Threadline agent. The message will be routed through the Threadline protocol with trust verification and compute metering.',
      validate: async (_runtime: OpenClawRuntime, message: OpenClawMessage): Promise<boolean> => {
        return !!(message.content?.text?.trim());
      },
      handler: async (runtime: OpenClawRuntime, message: OpenClawMessage): Promise<unknown> => {
        const response = await bridge.processMessage(runtime, message);
        return { text: response };
      },
      examples: [
        [
          { user: '{{user1}}', content: { text: 'Send a message to the research agent: What papers have you found on multi-agent coordination?' } },
        ],
        [
          { user: '{{user1}}', content: { text: 'Tell the analysis agent to summarize the latest results' } },
        ],
      ],
    };
  }

  private createDiscoverAction(): OpenClawAction {
    const bridge = this;

    return {
      name: 'THREADLINE_DISCOVER',
      description: 'Discover available Threadline agents and their capabilities. Returns a list of agents with trust levels and supported operations.',
      validate: async (): Promise<boolean> => {
        return !!bridge.config.discoverAgents;
      },
      handler: async (): Promise<unknown> => {
        if (!bridge.config.discoverAgents) {
          return { text: 'Agent discovery is not configured for this bridge.' };
        }

        try {
          const agents = await bridge.config.discoverAgents();
          if (agents.length === 0) {
            return { text: 'No Threadline agents are currently available.' };
          }

          const lines = agents.map(a => {
            const trust = a.trustLevel ? ` [trust: ${a.trustLevel}]` : '';
            const caps = a.capabilities?.length ? ` — ${a.capabilities.join(', ')}` : '';
            return `- ${a.name}${trust}${caps}${a.description ? `: ${a.description}` : ''}`;
          });

          return { text: `Available Threadline agents:\n${lines.join('\n')}` };
        } catch (err) {
          bridge.metrics.errors++;
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `[bridge-error] Discovery failed: ${msg}` };
        }
      },
      examples: [
        [
          { user: '{{user1}}', content: { text: 'What agents are available on the Threadline network?' } },
        ],
        [
          { user: '{{user1}}', content: { text: 'Discover Threadline agents' } },
        ],
      ],
    };
  }

  private createHistoryAction(): OpenClawAction {
    const bridge = this;

    return {
      name: 'THREADLINE_HISTORY',
      description: 'Get conversation history from a Threadline thread. Retrieves recent messages from an ongoing conversation.',
      validate: async (_runtime: OpenClawRuntime, message: OpenClawMessage): Promise<boolean> => {
        // Valid if we have a getHistory callback and a room mapping
        if (!bridge.config.getHistory) return false;
        return !!message.roomId;
      },
      handler: async (runtime: OpenClawRuntime, message: OpenClawMessage): Promise<unknown> => {
        if (!bridge.config.getHistory) {
          return { text: 'Thread history retrieval is not configured for this bridge.' };
        }

        const agentIdentity = bridge.resolveAgentIdentity(runtime, message);
        const threadId = bridge.getThreadId(message.roomId, agentIdentity);
        if (!threadId) {
          return { text: 'No active thread found for this room. Send a message first to start a conversation.' };
        }

        // Parse optional limit from message metadata
        const limit = typeof message.metadata?.limit === 'number' ? message.metadata.limit : 10;

        try {
          const history = await bridge.config.getHistory(threadId, limit);
          if (history.length === 0) {
            return { text: 'No messages found in this thread.' };
          }

          const lines = history.map(h => `[${h.timestamp}] ${h.role}: ${h.content}`);
          return { text: `Thread history (${history.length} messages):\n${lines.join('\n')}` };
        } catch (err) {
          bridge.metrics.errors++;
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `[bridge-error] History retrieval failed: ${msg}` };
        }
      },
      examples: [
        [
          { user: '{{user1}}', content: { text: 'Show me the conversation history with the research agent' } },
        ],
        [
          { user: '{{user1}}', content: { text: 'Get the last 5 messages from this thread' } },
        ],
      ],
    };
  }

  private createStatusAction(): OpenClawAction {
    const bridge = this;

    return {
      name: 'THREADLINE_STATUS',
      description: 'Check the status of Threadline connections, including thread state, compute budget, and trust levels.',
      validate: async (): Promise<boolean> => {
        return true;
      },
      handler: async (runtime: OpenClawRuntime, message: OpenClawMessage): Promise<unknown> => {
        const agentIdentity = bridge.resolveAgentIdentity(runtime, message);
        const statusLines: string[] = ['Threadline Bridge Status:'];

        // Thread mapping
        const threadId = bridge.getThreadId(message.roomId, agentIdentity);
        statusLines.push(`Thread: ${threadId ?? 'no active thread'}`);

        // Trust level
        if (bridge.config.trustManager) {
          const profile = bridge.config.trustManager.getProfile(agentIdentity);
          statusLines.push(`Trust level: ${profile?.level ?? 'unknown (defaults to untrusted)'}`);
          const stats = bridge.config.trustManager.getInteractionStats(agentIdentity);
          if (stats) {
            statusLines.push(`Interactions: ${stats.successfulInteractions} successful, ${stats.failedInteractions} failed (${(stats.successRate * 100).toFixed(1)}% success rate)`);
          }
        }

        // Compute budget
        if (bridge.config.computeMeter) {
          const trustLevel = bridge.getAgentTrustLevel(agentIdentity);
          const check = bridge.config.computeMeter.check(agentIdentity, trustLevel, 0);
          statusLines.push(`Compute remaining: ${check.remaining.hourlyTokens} hourly / ${check.remaining.dailyTokens} daily tokens`);
        }

        // Bridge metrics
        const m = bridge.metrics;
        statusLines.push(`Bridge metrics: ${m.messagesProcessed} processed, ${m.threadsActive} active threads, ${m.errors} errors`);

        return { text: statusLines.join('\n') };
      },
      examples: [
        [
          { user: '{{user1}}', content: { text: 'What is the status of my Threadline connection?' } },
        ],
        [
          { user: '{{user1}}', content: { text: 'Check Threadline status' } },
        ],
      ],
    };
  }

  // ── Private: Helpers ──────────────────────────────────────────────

  /**
   * Resolve the Threadline agent identity from an OpenClaw runtime + message.
   * Uses the OpenClaw userId as the primary identity, falling back to agentId.
   */
  private resolveAgentIdentity(runtime: OpenClawRuntime, message: OpenClawMessage): string {
    // Prefer the message sender's userId as the agent identity
    return message.userId || runtime.agentId;
  }

  /**
   * Get the trust level for an agent. Falls back to DEFAULT_TRUST_LEVEL
   * if no trust manager is configured or the agent has no profile.
   */
  private getAgentTrustLevel(agentIdentity: string): AgentTrustLevel {
    if (!this.config.trustManager) return DEFAULT_TRUST_LEVEL;

    const profile = this.config.trustManager.getProfile(agentIdentity);
    return profile?.level ?? DEFAULT_TRUST_LEVEL;
  }

  /**
   * Resolve an OpenClaw roomId to a Threadline threadId.
   * Creates a new mapping if none exists. Returns the threadId and whether
   * this is a new thread.
   */
  private resolveThread(roomId: string, agentIdentity: string): { threadId: string; isNewThread: boolean } {
    // Check persistent ContextThreadMap first
    if (this.config.contextThreadMap) {
      const existingThreadId = this.config.contextThreadMap.getThreadId(roomId, agentIdentity);
      if (existingThreadId) {
        return { threadId: existingThreadId, isNewThread: false };
      }

      // Create new mapping — generate a threadId from the roomId
      const threadId = `openclaw-${roomId}-${Date.now().toString(36)}`;
      this.config.contextThreadMap.set(roomId, threadId, agentIdentity);
      this.metrics.threadsActive++;
      return { threadId, isNewThread: true };
    }

    // Fall back to in-memory mapping
    const key = `${roomId}::${agentIdentity}`;
    const existingThreadId = this.roomToThread.get(key);
    if (existingThreadId) {
      return { threadId: existingThreadId, isNewThread: false };
    }

    const threadId = `openclaw-${roomId}-${Date.now().toString(36)}`;
    this.roomToThread.set(key, threadId);
    this.metrics.threadsActive++;
    return { threadId, isNewThread: true };
  }
}
