/**
 * Threadline Protocol — Session coherence, autonomy-gated visibility,
 * and cryptographic inter-agent handshake.
 *
 * Phase 1: Session resume for threaded agent-to-agent conversations.
 * Phase 2: Autonomy-gated visibility — user involvement scales with trust level.
 * Phase 3: Threadline endpoints, Ed25519/X25519 handshake, relay tokens.
 */

export { ThreadResumeMap } from './ThreadResumeMap.js';
export type { ThreadResumeEntry, ThreadState } from './ThreadResumeMap.js';

export { ThreadlineRouter } from './ThreadlineRouter.js';
export type { ThreadlineRouterConfig, ThreadlineHandleResult } from './ThreadlineRouter.js';

export { AutonomyGate } from './AutonomyGate.js';
export type { GateDecision, GateResult, ThreadlineNotifier } from './AutonomyGate.js';

export { ApprovalQueue } from './ApprovalQueue.js';
export type { ApprovalQueueEntry } from './ApprovalQueue.js';

export { DigestCollector } from './DigestCollector.js';
export type { DigestEntry, DigestState } from './DigestCollector.js';

export {
  generateIdentityKeyPair,
  generateEphemeralKeyPair,
  sign,
  verify,
  ecdh,
  deriveRelayToken,
  computeChallengeResponse,
} from './ThreadlineCrypto.js';
export type { KeyPair } from './ThreadlineCrypto.js';

export { HandshakeManager } from './HandshakeManager.js';
export type { HandshakeState, HelloPayload, ConfirmPayload } from './HandshakeManager.js';

export { createThreadlineRoutes } from './ThreadlineEndpoints.js';
export type { ThreadlineError, ThreadlineEndpointsConfig } from './ThreadlineEndpoints.js';

export { AgentDiscovery } from './AgentDiscovery.js';
export type { ThreadlineAgentInfo, AgentInfoFile, HttpFetcher } from './AgentDiscovery.js';

export { AgentTrustManager } from './AgentTrustManager.js';
export type {
  AgentTrustLevel,
  AgentTrustSource,
  AgentTrustHistory,
  AgentTrustProfile,
  TrustAuditEntry,
  TrustChangeNotification,
  TrustChangeCallback,
  InteractionStats,
} from './AgentTrustManager.js';

export { CircuitBreaker } from './CircuitBreaker.js';
export type {
  CircuitStateValue,
  CircuitState,
} from './CircuitBreaker.js';

export { RateLimiter, DEFAULT_RATE_LIMITS } from './RateLimiter.js';
export type {
  RateLimitConfig,
  RateLimitType,
  RateLimitResult,
  RateLimitStatus,
} from './RateLimiter.js';

export { MCPAuth } from './MCPAuth.js';
export type {
  MCPTokenScope,
  MCPTokenInfo,
  MCPTokenCreateResult,
} from './MCPAuth.js';

export { ThreadlineMCPServer } from './ThreadlineMCPServer.js';
export type {
  ThreadlineMCPServerConfig,
  ThreadlineMCPDeps,
  SendMessageParams,
  SendMessageResult,
  ThreadHistoryMessage,
  ThreadHistoryResult,
} from './ThreadlineMCPServer.js';

// Phase 6A: A2A Gateway
export { AgentCard } from './AgentCard.js';
export type {
  AgentCardConfig,
  AgentCardSkill,
  GeneratedAgentCard,
} from './AgentCard.js';

export { ContextThreadMap } from './ContextThreadMap.js';
export type {
  ContextThreadMapping,
  ContextThreadMapConfig,
} from './ContextThreadMap.js';

export { ComputeMeter } from './ComputeMeter.js';
export type {
  ComputeBudget,
  ComputeMeterConfig,
  MeterCheckResult,
} from './ComputeMeter.js';

export { SessionLifecycle } from './SessionLifecycle.js';
export type {
  SessionState,
  SessionEntry,
  SessionLifecycleConfig,
  SessionCapacityResult,
  SessionStats,
} from './SessionLifecycle.js';

export { A2AGateway, A2A_ERROR_CODES } from './A2AGateway.js';
export type {
  A2AGatewayConfig,
  A2AGatewayDeps,
  GatewaySendParams,
  GatewayResponse,
  GatewayHistoryMessage,
  A2AErrorResponse,
  A2AMetrics,
  AuditEntry,
} from './A2AGateway.js';

// Phase 6C: Trust Bootstrap & Directory
export { DNSVerifier } from './DNSVerifier.js';
export type {
  DNSVerifyResult,
  DNSResolverFn,
  DNSVerifierConfig,
} from './DNSVerifier.js';

export { InvitationManager } from './InvitationManager.js';
export type {
  InvitationCreateOptions,
  Invitation,
  InvitationStatus,
  InvitationValidateResult,
} from './InvitationManager.js';

export { TrustBootstrap } from './TrustBootstrap.js';
export type {
  TrustBootstrapStrategy,
  TrustBootstrapConfig,
  BootstrapEvidence,
  BootstrapResult,
} from './TrustBootstrap.js';
