/**
 * OpenClawSkillManifest — Generates the OpenClaw skill manifest for publishing
 * Threadline as an OpenClaw skill on ClawHub.
 *
 * Part of Threadline Protocol Phase 6D. The manifest describes the skill's
 * actions, providers, evaluators, and configuration in the format expected
 * by OpenClaw's skill registry.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  actions: Array<{
    name: string;
    description: string;
    examples: Array<Array<{ user: string; content: { text: string } }>>;
  }>;
  providers: Array<{ name: string; description: string }>;
  evaluators: Array<{ name: string; description: string }>;
  configuration: Record<string, {
    type: string;
    description: string;
    required: boolean;
    default?: string;
  }>;
}

// ── Constants ────────────────────────────────────────────────────────

const SKILL_NAME = '@threadline/openclaw-skill';
const SKILL_DESCRIPTION =
  'Threadline Protocol skill for OpenClaw — enables persistent thread-based ' +
  'conversations with Ed25519 cryptographic identity, trust management, and ' +
  'compute metering across the Threadline agent mesh.';
const SKILL_AUTHOR = 'SageMindAI';
const SKILL_LICENSE = 'MIT';
const DEFAULT_VERSION = '0.1.0';

// ── Implementation ───────────────────────────────────────────────────

/**
 * Generate the OpenClaw skill manifest for the Threadline skill.
 *
 * @param version - Manifest version. Defaults to 0.1.0.
 * @returns The complete skill manifest ready for publishing to ClawHub.
 */
export function generateSkillManifest(version?: string): SkillManifest {
  return {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    version: version ?? DEFAULT_VERSION,
    author: SKILL_AUTHOR,
    license: SKILL_LICENSE,

    actions: [
      {
        name: 'THREADLINE_SEND',
        description:
          'Send a message to a Threadline agent. The message is routed through ' +
          'the Threadline protocol with trust verification and compute metering. ' +
          'Automatically maps OpenClaw rooms to Threadline threads.',
        examples: [
          [
            { user: '{{user1}}', content: { text: 'Send a message to the research agent: What papers have you found on multi-agent coordination?' } },
          ],
          [
            { user: '{{user1}}', content: { text: 'Tell the analysis agent to summarize the latest results' } },
          ],
        ],
      },
      {
        name: 'THREADLINE_DISCOVER',
        description:
          'Discover available Threadline agents and their capabilities. Returns ' +
          'a list of agents with their trust levels and supported operations.',
        examples: [
          [
            { user: '{{user1}}', content: { text: 'What agents are available on the Threadline network?' } },
          ],
          [
            { user: '{{user1}}', content: { text: 'Discover Threadline agents' } },
          ],
        ],
      },
      {
        name: 'THREADLINE_HISTORY',
        description:
          'Get conversation history from a Threadline thread. Retrieves recent ' +
          'messages from an ongoing conversation with a remote agent.',
        examples: [
          [
            { user: '{{user1}}', content: { text: 'Show me the conversation history with the research agent' } },
          ],
          [
            { user: '{{user1}}', content: { text: 'Get the last 5 messages from this thread' } },
          ],
        ],
      },
      {
        name: 'THREADLINE_STATUS',
        description:
          'Check the status of Threadline connections, including active thread ' +
          'state, compute budget remaining, trust levels, and bridge metrics.',
        examples: [
          [
            { user: '{{user1}}', content: { text: 'What is the status of my Threadline connection?' } },
          ],
          [
            { user: '{{user1}}', content: { text: 'Check Threadline status' } },
          ],
        ],
      },
    ],

    providers: [
      {
        name: 'threadline-context',
        description:
          'Provides Threadline context to the agent, including active threads, ' +
          'trust profiles of known agents, and recent conversation summaries. ' +
          'Injected into the agent state on each evaluation cycle.',
      },
      {
        name: 'threadline-identity',
        description:
          'Provides the agent\'s Threadline identity information, including its ' +
          'Ed25519 public key, agent name, and network capabilities.',
      },
    ],

    evaluators: [
      {
        name: 'threadline-trust',
        description:
          'Evaluates incoming messages against Threadline trust policies. Checks ' +
          'whether the sending agent has sufficient trust level for the requested ' +
          'operation and whether compute budgets are within limits.',
      },
      {
        name: 'threadline-coherence',
        description:
          'Evaluates conversation coherence across thread boundaries. Detects ' +
          'when a conversation has drifted from its original topic or when a ' +
          'thread should be forked into a new conversation.',
      },
    ],

    configuration: {
      THREADLINE_STATE_DIR: {
        type: 'string',
        description: 'Directory for Threadline state files (thread maps, trust profiles, compute meters).',
        required: true,
      },
      THREADLINE_AGENT_NAME: {
        type: 'string',
        description: 'The agent\'s name in the Threadline network. Used for identity resolution.',
        required: true,
      },
      THREADLINE_TRUST_DEFAULT: {
        type: 'string',
        description: 'Default trust level for unknown agents. One of: untrusted, verified, trusted, autonomous.',
        required: false,
        default: 'untrusted',
      },
      THREADLINE_HOURLY_TOKEN_LIMIT: {
        type: 'number',
        description: 'Override for the hourly token budget. If not set, uses the default for the agent\'s trust level.',
        required: false,
      },
      THREADLINE_DAILY_TOKEN_LIMIT: {
        type: 'number',
        description: 'Override for the daily token budget. If not set, uses the default for the agent\'s trust level.',
        required: false,
      },
      THREADLINE_DISCOVERY_ENDPOINT: {
        type: 'string',
        description: 'URL of the Threadline agent discovery endpoint. If not set, discovery returns only locally known agents.',
        required: false,
      },
    },
  };
}
