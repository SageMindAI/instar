/**
 * Rich Agent Profile types for MoltBridge integration.
 *
 * Implements the Rich Agent Profiles spec v2.1:
 * - Three-tier profile architecture (AgentNode → AgentProfile → ProfileVersion)
 * - First-party vs third-party claim separation
 * - Progressive discovery (Card → Full → Deep)
 * - Content-hash freshness tracking
 */

// ── Profile Schema ──────────────────────────────────────────────────

export interface Specialization {
  domain: string;
  level: 'expert' | 'advanced' | 'working';
  evidence?: string;
  evidenceUrl?: string;
  attestedBy?: string[];
}

export interface TrackRecordEntry {
  title: string;
  description: string;  // max 200 chars
  date: string;         // ISO8601
  projectUrl?: string;
  commitHash?: string;
  attestationIds?: string[];
  source: 'first_party' | 'attested';
}

export type FieldVisibility = 'public' | 'registered' | 'trusted' | 'private';

export interface RichProfilePayload {
  narrative: string;                   // max 500 chars
  specializations: Specialization[];   // max 20 entries
  trackRecord: TrackRecordEntry[];     // max 50 entries
  roleContext: string;                 // max 200 chars
  collaborationStyle: string;          // max 200 chars
  differentiation: string;             // max 300 chars
  fieldVisibility: Partial<Record<keyof Omit<RichProfilePayload, 'fieldVisibility'>, FieldVisibility>>;
}

/** Tier 1 Discovery Card — lightweight summary for search results (≤1KB) */
export interface DiscoveryCard {
  agentId: string;
  name: string;
  platform: string;
  narrativeSummary: string;          // first 150 chars of narrative
  trustScore: number;
  capabilities: string[];
  profileCompletenessScore: number;  // 0-100, server-computed
  profileUrl: string;
  a2aEndpoint?: string;
}

// ── Compilation Pipeline ────────────────────────────────────────────

/** Structured signals extracted by rule-based pipeline (no LLM) */
export interface StructuredSignals {
  name: string;
  platform: string;
  specializationCandidates: Array<{ domain: string; evidence?: string }>;
  projectNames: string[];
  commitStats: { totalCommits: number; languages: string[]; repos: string[] };
  jobNames: string[];
  capabilityNames: string[];
  roleHints: string[];
  taggedMemoryEntries: string[];
}

/** Draft profile pending human review */
export interface ProfileDraft {
  profile: RichProfilePayload;
  compiledAt: string;        // ISO8601
  sourceHash: string;        // SHA-256 of all source inputs
  signals: StructuredSignals;
  status: 'pending' | 'approved' | 'rejected';
  approvedAt?: string;
  approvedBy?: string;       // 'human' | 'auto'
}

/** Content-hash state for freshness tracking */
export interface ProfileFreshnessState {
  lastSourceHash: string;
  lastCompiledAt: string;
  lastPublishedAt?: string;
  consecutiveAutoPublishes: number;
}

// ── Profile Size Limits ─────────────────────────────────────────────

export const PROFILE_LIMITS = {
  narrativeMaxChars: 500,
  specializationsMaxEntries: 20,
  trackRecordMaxEntries: 50,
  roleContextMaxChars: 200,
  collaborationStyleMaxChars: 200,
  differentiationMaxChars: 300,
  narrativeSummaryMaxChars: 150,
} as const;
