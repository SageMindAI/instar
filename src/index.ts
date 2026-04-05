/**
 * instar — Persistent autonomy infrastructure for AI agents.
 *
 * Public API for programmatic usage.
 */

// Core
export { SessionManager } from './core/SessionManager.js';
export type { SessionDiagnostic, SessionDiagnostics, MemoryPressure } from './core/SessionManager.js';
export { StateManager } from './core/StateManager.js';
export { RelationshipManager } from './core/RelationshipManager.js';
export { ClaudeCliIntelligenceProvider } from './core/ClaudeCliIntelligenceProvider.js';
export { AnthropicIntelligenceProvider } from './core/AnthropicIntelligenceProvider.js';
export { ANTHROPIC_MODELS, CLI_MODEL_FLAGS, resolveModelId, resolveCliFlag, getValidTiers, isValidTier } from './core/models.js';
export type { ModelTierName, AnthropicModelId } from './core/models.js';
export { FeedbackManager } from './core/FeedbackManager.js';
export type { FeedbackQualityResult } from './core/FeedbackManager.js';
export { EvolutionManager } from './core/EvolutionManager.js';
export { DecisionJournal } from './core/DecisionJournal.js';
export type { DecisionJournalStats } from './core/DecisionJournal.js';
export { DispatchDecisionJournal } from './core/DispatchDecisionJournal.js';
export type { DispatchDecisionStats, DispatchDecisionQueryOptions } from './core/DispatchDecisionJournal.js';
export { ContextSnapshotBuilder } from './core/ContextSnapshotBuilder.js';
export type { ContextSnapshotConfig } from './core/ContextSnapshotBuilder.js';
export { DispatchVerifier } from './core/DispatchVerifier.js';
export type { SignedDispatch, VerificationResult as DispatchVerificationResult, DispatchVerifierConfig } from './core/DispatchVerifier.js';
export { RelevanceFilter } from './core/RelevanceFilter.js';
export type { RelevanceFilterResult, RelevanceFilterConfig } from './core/RelevanceFilter.js';
export { ContextualEvaluator } from './core/ContextualEvaluator.js';
export type { ContextualEvaluation, ContextualEvaluatorConfig } from './core/ContextualEvaluator.js';
export { DeferredDispatchTracker } from './core/DeferredDispatchTracker.js';
export type { DeferredDispatchState, DeferredDispatchTrackerConfig, DeferralResult } from './core/DeferredDispatchTracker.js';
export { AdaptationValidator } from './core/AdaptationValidator.js';
export type { AdaptationScopeCheck, AdaptationValidatorConfig } from './core/AdaptationValidator.js';
export { ExecutionJournal } from './core/ExecutionJournal.js';
export type { ExecutionJournalStats } from './core/ExecutionJournal.js';
export { PatternAnalyzer } from './core/PatternAnalyzer.js';
export type {
  PatternType,
  PatternConfidence,
  DetectedPattern,
  PatternReport,
  PatternAnalyzerOptions,
} from './core/PatternAnalyzer.js';
export { ReflectionConsolidator } from './core/ReflectionConsolidator.js';
export type {
  ConsolidationResult,
  JobConsolidationSummary,
  ConsolidatorOptions,
} from './core/ReflectionConsolidator.js';
export { JobReflector } from './core/JobReflector.js';
export type {
  ReflectionInsight,
  JobReflectorConfig,
} from './core/JobReflector.js';
export { IntentDriftDetector } from './core/IntentDriftDetector.js';
export type { DriftWindow, DriftSignal, DriftAnalysis, AlignmentScore } from './core/IntentDriftDetector.js';
export { OrgIntentManager } from './core/OrgIntentManager.js';
export type { OrgConstraint, OrgGoal, ParsedOrgIntent, IntentConflict, IntentValidationResult } from './core/OrgIntentManager.js';
export { DispatchManager } from './core/DispatchManager.js';
export { UpdateChecker } from './core/UpdateChecker.js';
export type { RollbackResult, UpdateCheckerConfig } from './core/UpdateChecker.js';
export { UpgradeNotifyManager } from './core/UpgradeNotifyManager.js';
export type { UpgradeNotifyConfig, UpgradeNotifyResult, SessionSpawner, SessionCompletionChecker, ActivityLogger } from './core/UpgradeNotifyManager.js';
export { PostUpdateMigrator } from './core/PostUpdateMigrator.js';
export type { MigrationResult, MigratorConfig } from './core/PostUpdateMigrator.js';
export { loadConfig, detectTmuxPath, detectClaudePath, detectProjectDir, ensureStateDir, resolveAgentDir, standaloneAgentsDir } from './core/Config.js';
export { LiveConfig } from './config/LiveConfig.js';
export type { ConfigChange, LiveConfigOptions } from './config/LiveConfig.js';
export { BackupManager } from './core/BackupManager.js';
export {
  loadRegistry,
  saveRegistry,
  registerAgent,
  unregisterAgent,
  updateStatus,
  heartbeat as agentHeartbeat,
  startHeartbeat as startAgentHeartbeat,
  listAgents,
  getAgent,
  allocatePort,
  validateAgentName,
  listInstances,
  forceRemoveRegistryLock,
} from './core/AgentRegistry.js';
export { MachineIdentityManager, generateSigningKeyPair, generateEncryptionKeyPair, generateMachineId, sign, verify, ensureGitignore, base64ToSigningPem, base64ToEncryptionPem } from './core/MachineIdentity.js';
export { SecurityLog } from './core/SecurityLog.js';
export type { SecurityEvent, SecurityEventType } from './core/SecurityLog.js';
export {
  generatePairingCode,
  comparePairingCodes,
  deriveSAS,
  generateEphemeralKeyPair,
  deriveSessionKey,
  encrypt,
  decrypt,
  createPairingSession,
  isPairingSessionValid,
  validatePairingCode,
} from './core/PairingProtocol.js';
export type { PairingSession, EphemeralKeyPair } from './core/PairingProtocol.js';
export { NonceStore } from './core/NonceStore.js';
export type { NonceStoreConfig } from './core/NonceStore.js';
export { HeartbeatManager } from './core/HeartbeatManager.js';
export type { Heartbeat, FailoverConfig, FailoverState, HeartbeatCheckResult } from './core/HeartbeatManager.js';
export { MultiMachineCoordinator } from './core/MultiMachineCoordinator.js';
export type { CoordinatorConfig, CoordinatorEvents } from './core/MultiMachineCoordinator.js';
export { SecretStore, MasterKeyManager, encryptForSync, decryptFromSync } from './core/SecretStore.js';
export type { SecretStoreConfig, Secrets, EncryptedSecretPayload } from './core/SecretStore.js';
export { migrateSecrets, mergeConfigWithSecrets } from './core/SecretMigrator.js';
export { GitSyncManager, mergeRelationship } from './core/GitSync.js';
export type { GitSyncConfig, SyncResult } from './core/GitSync.js';
export { LLMConflictResolver } from './core/LLMConflictResolver.js';
export type {
  ConflictFile, ResolutionResult, EscalationContext,
  ResolutionEvent, LLMConflictResolverConfig,
} from './core/LLMConflictResolver.js';
export { FileClassifier } from './core/FileClassifier.js';
export type {
  FileClass, MergeStrategy, ClassificationResult, FileClassifierConfig,
} from './core/FileClassifier.js';
export { WorkLedger } from './core/WorkLedger.js';
export type {
  LedgerEntry, LedgerEntryStatus, MachineLedger,
  OverlapTier, OverlapWarning, WorkLedgerConfig,
} from './core/WorkLedger.js';
export { BranchManager } from './core/BranchManager.js';
export type {
  TaskBranch, BranchStatus, BranchManagerConfig,
  MergeResult, BranchWarning,
} from './core/BranchManager.js';
export { OverlapGuard } from './core/OverlapGuard.js';
export type {
  OverlapAction, OverlapNotificationConfig, ArchitecturalConflict,
  OverlapCheckResult, OverlapGuardConfig,
} from './core/OverlapGuard.js';
export { HandoffManager } from './core/HandoffManager.js';
export type {
  HandoffNote, HandoffReason, HandoffWorkItem,
  HandoffResult, ResumeResult, HandoffManagerConfig,
} from './core/HandoffManager.js';
export type { MigrationResult as SecretMigrationResult } from './core/SecretMigrator.js';
export { GitStateManager } from './core/GitStateManager.js';
export { ProjectMapper } from './core/ProjectMapper.js';
export type { ProjectMapConfig, ProjectMap, ProjectMapEntry } from './core/ProjectMapper.js';
export { CapabilityMapper } from './core/CapabilityMapper.js';
export type { CapabilityMap, CapabilityDomain, Capability, CapabilityType, CapabilityStatus, Provenance, CapabilityMapperConfig, DriftReport } from './core/CapabilityMapper.js';
export { ScopeVerifier } from './core/ScopeVerifier.js';
export type { ScopeVerifierConfig, ScopeVerificationResult, ScopeCheck, TopicProjectBinding, HighRiskAction } from './core/ScopeVerifier.js';
export { CoherenceGate } from './core/CoherenceGate.js';
export type { CoherenceGateOptions, EvaluateRequest, EvaluateResponse, AuditViolation, ResearchTriggerContext } from './core/CoherenceGate.js';
export { CapabilityRegistryGenerator } from './core/CapabilityRegistryGenerator.js';
export type { StoredCapabilityRegistry } from './core/CapabilityRegistryGenerator.js';
export { BlockerLearningLoop } from './core/BlockerLearningLoop.js';
export type { BlockerResolution, LearningLoopConfig, ReuseSummary } from './core/BlockerLearningLoop.js';
export { ResearchRateLimiter } from './core/ResearchRateLimiter.js';
export type { ResearchRateLimiterConfig, RateLimitDecision } from './core/ResearchRateLimiter.js';
export { ContextHierarchy } from './core/ContextHierarchy.js';
export type { ContextSegment, ContextHierarchyConfig, ContextDispatchTable } from './core/ContextHierarchy.js';
export { CanonicalState } from './core/CanonicalState.js';
export type { QuickFact, AntiPattern, ProjectEntry, CanonicalStateConfig } from './core/CanonicalState.js';
export { PlatformActivityRegistry } from './core/PlatformActivityRegistry.js';
export type {
  PlatformAction, PlatformActionType, PlatformActionStatus,
  PlatformActivityQuery, PlatformActivitySummary, PlatformActivityRegistryConfig,
} from './core/PlatformActivityRegistry.js';
export { TemporalCoherenceChecker } from './core/TemporalCoherenceChecker.js';
export type {
  TemporalSeverity, TemporalAssessment, TemporalIssueType,
  TemporalIssue, TemporalCoherenceResult, TemporalCoherenceConfig,
} from './core/TemporalCoherenceChecker.js';
export { ExternalOperationGate, computeRiskLevel, scopeFromCount, AUTONOMY_PROFILES } from './core/ExternalOperationGate.js';
export type {
  OperationMutability, OperationReversibility, OperationScope, RiskLevel,
  GateAction, TrustLevel, TrustSource, AutonomyBehavior,
  OperationClassification, GateDecision, CheckpointConfig,
  ServicePermissions, ExternalOperationGateConfig, OperationLogEntry,
} from './core/ExternalOperationGate.js';
export { MessageSentinel } from './core/MessageSentinel.js';
export type {
  SentinelCategory, SentinelClassification, SentinelAction,
  MessageSentinelConfig, SentinelStats,
} from './core/MessageSentinel.js';
export { AdaptiveTrust } from './core/AdaptiveTrust.js';
export type {
  TrustProfile, ServiceTrust, TrustEntry, TrustHistory,
  TrustChangeEvent, AdaptiveTrustConfig, TrustElevationSuggestion,
} from './core/AdaptiveTrust.js';
export { AutonomyProfileManager } from './core/AutonomyProfileManager.js';
export { TrustElevationTracker } from './core/TrustElevationTracker.js';
export type {
  ApprovalEvent, RubberStampSignal, EvolutionAcceptanceStats,
  ElevationOpportunity, TrustElevationState, TrustElevationConfig,
} from './core/TrustElevationTracker.js';
export { AutonomousEvolution } from './core/AutonomousEvolution.js';
export type {
  ReviewDecision, ReviewResult, ScopeClassification,
  ProposedJobChange, EvolutionNotification, AutonomousEvolutionConfig,
} from './core/AutonomousEvolution.js';
export { DispatchScopeEnforcer } from './core/DispatchScopeEnforcer.js';
export type {
  DispatchScopeTier, ScopeCheckResult,
} from './core/DispatchScopeEnforcer.js';
export { TrustRecovery } from './core/TrustRecovery.js';
export type {
  IncidentRecord, RecoverySuggestion, TrustRecoveryConfig,
} from './core/TrustRecovery.js';
export { AutonomySkill } from './core/AutonomySkill.js';
export type { AutonomySkillDeps, AutonomyResponse } from './core/AutonomySkill.js';
export { SecretRedactor } from './core/SecretRedactor.js';
export type {
  SecretType, RedactionEntry, RedactionResult, RestorationResult,
  FileExclusionResult, SecretRedactorConfig, SecretPattern,
} from './core/SecretRedactor.js';
export { PromptGuard } from './core/PromptGuard.js';
export type {
  InjectionThreatLevel, ContentScanResult, InjectionMatch,
  OutputValidationResult, PromptBoundary, PromptGuardConfig, InjectionPattern,
} from './core/PromptGuard.js';
export { LedgerAuth } from './core/LedgerAuth.js';
export type {
  AuthScenario, VerificationStatus, SigningResult,
  VerificationResult, KeyInfo, LedgerAuthConfig,
} from './core/LedgerAuth.js';
export { AccessControl } from './core/AccessControl.js';
export type {
  UserRole, Permission, AccessCheckResult,
  UserRoleEntry, AccessControlConfig,
} from './core/AccessControl.js';
export { AuditTrail } from './core/AuditTrail.js';
export type {
  AuditEventType, AuditEntry, AuditQuery,
  AuditIntegrityResult, AuditStats, AuditTrailConfig,
} from './core/AuditTrail.js';
export { AgentBus } from './core/AgentBus.js';
export type {
  MessageType, DeliveryStatus, AgentMessage, TransportAdapter,
  AgentBusConfig, AgentBusEvents, ReplayProtectionConfig,
} from './core/AgentBus.js';
export { CoordinationProtocol } from './core/CoordinationProtocol.js';
export type {
  FileAvoidanceRequest, FileAvoidanceResponse, WorkAnnouncement,
  StatusQuery, StatusResponse, LeadershipState, AvoidanceEntry,
  CoordinationProtocolConfig, CoordinationEvents,
} from './core/CoordinationProtocol.js';
export { ConflictNegotiator } from './core/ConflictNegotiator.js';
export type {
  NegotiationStatus, ResolutionStrategy, NegotiationProposal,
  SectionClaim, NegotiationResponse, NegotiationSession,
  NegotiationResult, ConflictNegotiatorConfig,
} from './core/ConflictNegotiator.js';
export { SyncOrchestrator } from './core/SyncOrchestrator.js';
export type {
  SyncPhase, SyncOrchestratorConfig, OrchestratedSyncResult,
  TaskCompletionResult, TransitionResult, SyncLock,
} from './core/SyncOrchestrator.js';

// Memory
export { SemanticMemory } from './memory/SemanticMemory.js';
export { MemoryExporter } from './memory/MemoryExporter.js';
export type { MemoryExporterConfig, ExportResult, WriteResult } from './memory/MemoryExporter.js';
export { EpisodicMemory } from './memory/EpisodicMemory.js';
export type { ActivityDigest, SessionSynthesis, BoundarySignal, SentinelState } from './memory/EpisodicMemory.js';
export { ActivityPartitioner } from './memory/ActivityPartitioner.js';
export type { TelegramLogEntry, ActivityUnit, PartitionInput } from './memory/ActivityPartitioner.js';
export { chunkMarkdown, chunkJson, chunkJsonl, estimateTokens } from './memory/Chunker.js';
export type { Chunk } from './memory/Chunker.js';

// Users
export { UserManager } from './users/UserManager.js';
export {
  generateVerificationCode,
  generateConnectCode,
  hashCode,
  generateRecoveryKey,
  hashRecoveryKey,
  buildConsentDisclosure,
  buildCondensedConsentDisclosure,
  createConsentRecord,
  createDataManifest,
  VerificationManager,
  JoinRequestManager,
  buildUserProfile,
  getDefaultAutonomyConfig,
} from './users/UserOnboarding.js';

export { UserPropagator } from './users/UserPropagator.js';
export type {
  UserPropagationPayload, UserPropagatorConfig, UserPropagatorEvents,
} from './users/UserPropagator.js';

// Scheduler
export { JobScheduler } from './scheduler/JobScheduler.js';
export { IntegrationGate } from './scheduler/IntegrationGate.js';
export type { IntegrationGateConfig, GateContext, GateResult } from './scheduler/IntegrationGate.js';
export { SkipLedger } from './scheduler/SkipLedger.js';
export { loadJobs, validateJob, validateCommonBlockers } from './scheduler/JobLoader.js';
export { JobClaimManager } from './scheduler/JobClaimManager.js';
export type {
  JobClaimPayload, JobCompletePayload, JobClaim,
  JobClaimManagerConfig, JobClaimManagerEvents,
} from './scheduler/JobClaimManager.js';

// Server
export { AgentServer } from './server/AgentServer.js';
export { createRoutes, formatUptime } from './server/routes.js';
export type { RouteContext } from './server/routes.js';
export { corsMiddleware, authMiddleware, rateLimiter, requestTimeout, errorHandler } from './server/middleware.js';
export { machineAuthMiddleware, signRequest, ChallengeStore } from './server/machineAuth.js';
export type { MachineAuthContext, MachineAuthDeps, SignedHeaders, Challenge } from './server/machineAuth.js';
export { createMachineRoutes } from './server/machineRoutes.js';
export type { MachineRouteContext } from './server/machineRoutes.js';

// Monitoring
export { HealthChecker } from './monitoring/HealthChecker.js';
export { QuotaTracker } from './monitoring/QuotaTracker.js';
export type { RemoteQuotaResult } from './monitoring/QuotaTracker.js';
export { classifySessionDeath, detectContextExhaustion } from './monitoring/QuotaExhaustionDetector.js';
export { AccountSwitcher } from './monitoring/AccountSwitcher.js';
export { QuotaNotifier } from './monitoring/QuotaNotifier.js';
export { KeychainCredentialProvider, ClaudeConfigCredentialProvider, createDefaultProvider, redactToken, redactEmail } from './monitoring/CredentialProvider.js';
export type { CredentialProvider, ClaudeCredentials, AccountInfo, SecurityLevel } from './monitoring/CredentialProvider.js';
export { SessionCredentialManager } from './monitoring/SessionCredentialManager.js';
export type { SessionCredentialAssignment } from './monitoring/SessionCredentialManager.js';
export { QuotaCollector, RetryHelper, RequestBudget, ConcurrencyLimiter, AdaptivePoller, JsonlParser, classifyToken } from './monitoring/QuotaCollector.js';
export type { CollectorConfig, RetryConfig, CollectionResult, OAuthUsageResponse, OAuthProfileResponse, PollingState, JsonlTokenCounts, TokenState } from './monitoring/QuotaCollector.js';
export { SessionMigrator } from './monitoring/SessionMigrator.js';
export type { SessionMigratorConfig, SessionMigratorDeps, MigrationThresholds, MigrationEvent, HaltableSession, AccountSnapshot } from './monitoring/SessionMigrator.js';
export { QuotaManager } from './monitoring/QuotaManager.js';
export type { QuotaManagerConfig, QuotaThresholdEvent, QuotaMigrationEvent, AccountSwitchEvent, PollingStatus } from './monitoring/QuotaManager.js';
export { StallTriageNurse } from './monitoring/StallTriageNurse.js';
export type { StallTriageConfig, TreatmentAction, TriageDiagnosis, TriageContext, TriageResult, TriageRecord, TriageEvents, TriageDeps } from './monitoring/StallTriageNurse.types.js';
export { TriageOrchestrator } from './monitoring/TriageOrchestrator.js';
export type { TriageOrchestratorConfig, TriageOrchestratorDeps, TriageOrchestratorEvents, TriageState, TriageEvidence, TriageDecision, TriageAction, TriageClassification, TriageTrigger } from './monitoring/TriageOrchestrator.js';
export type { TriageResult as TriageOrchestratorResult } from './monitoring/TriageOrchestrator.js';
export { FeedbackAnomalyDetector } from './monitoring/FeedbackAnomalyDetector.js';
export type { AnomalyDetectorConfig, AnomalyCheckResult } from './monitoring/FeedbackAnomalyDetector.js';
export { SessionMonitor } from './monitoring/SessionMonitor.js';
export type { SessionMonitorConfig, SessionMonitorDeps, SessionMonitorEvents } from './monitoring/SessionMonitor.js';
export { CoherenceMonitor } from './monitoring/CoherenceMonitor.js';
export type { CoherenceCheckResult as CoherenceMonitorCheckResult, CoherenceReport, CoherenceMonitorConfig } from './monitoring/CoherenceMonitor.js';
export { CommitmentTracker } from './monitoring/CommitmentTracker.js';
export type { Commitment, CommitmentType, CommitmentStatus, CommitmentStore, CommitmentVerificationReport, CommitmentTrackerConfig } from './monitoring/CommitmentTracker.js';
export { CommitmentSentinel } from './monitoring/CommitmentSentinel.js';
export type { CommitmentSentinelConfig } from './monitoring/CommitmentSentinel.js';
export { SessionActivitySentinel } from './monitoring/SessionActivitySentinel.js';
export type { SentinelConfig, SentinelReport, SynthesisReport } from './monitoring/SessionActivitySentinel.js';
export { HookEventReceiver } from './monitoring/HookEventReceiver.js';
export type { HookEventPayload, StoredHookEvent, SessionEventSummary, HookEventReceiverConfig } from './monitoring/HookEventReceiver.js';
export { WorktreeMonitor } from './monitoring/WorktreeMonitor.js';
export type { Worktree, WorktreeReport, WorktreeWithDiff, WorktreeMonitorConfig } from './monitoring/WorktreeMonitor.js';
export { SubagentTracker } from './monitoring/SubagentTracker.js';
export type { SubagentRecord, SubagentTrackerConfig } from './monitoring/SubagentTracker.js';
export { InstructionsVerifier } from './monitoring/InstructionsVerifier.js';
export type { InstructionLoadRecord, VerificationResult as InstructionsVerificationResult, InstructionsVerifierConfig } from './monitoring/InstructionsVerifier.js';
export { TelemetryHeartbeat } from './monitoring/TelemetryHeartbeat.js';
export type { TelemetryHeartbeatConfig, HeartbeatPayload } from './monitoring/TelemetryHeartbeat.js';
export { HTTP_HOOK_TEMPLATES, buildHttpHookSettings } from './data/http-hook-templates.js';
export type { HttpHookTemplate } from './data/http-hook-templates.js';
export { SleepWakeDetector } from './core/SleepWakeDetector.js';

// Messaging — Telegram & Notifications
export { TelegramAdapter, TOPIC_STYLE, selectTopicEmoji } from './messaging/TelegramAdapter.js';
export type { TelegramConfig } from './messaging/TelegramAdapter.js';
export { classifyContent, validateTopicContent, getTopicPurpose } from './messaging/TopicContentValidator.js';
export type { ContentValidationConfig, CategoryKeywords, ValidationResult } from './messaging/TopicContentValidator.js';
export type { ClassificationResult as ContentClassificationResult } from './messaging/TopicContentValidator.js';
export { NotificationBatcher } from './messaging/NotificationBatcher.js';
export type { NotificationTier, BatchedNotification, BatcherConfig, BatcherStats } from './messaging/NotificationBatcher.js';

// Messaging — Inter-Agent Messaging (Phase 1)
// Note: MessageType and AgentMessage are aliased to avoid conflict with AgentBus exports.
// Use InterAgentMessageType/InterAgentMessage for the new messaging system,
// or import directly from 'instar/messaging/types' for unaliased access.
export { MessageStore } from './messaging/MessageStore.js';
export { MessageFormatter } from './messaging/MessageFormatter.js';
export { MessageDelivery } from './messaging/MessageDelivery.js';
export type { TmuxOperations } from './messaging/MessageDelivery.js';
export { MessageRouter, canonicalJSON } from './messaging/MessageRouter.js';
export type { MessageRouterConfig, CrossMachineDeps } from './messaging/MessageRouter.js';
export {
  generateAgentToken,
  getAgentToken,
  verifyAgentToken,
  computeDropHmac,
  verifyDropHmac,
  deleteAgentToken,
  listAgentTokens,
  ensureTokenDir,
} from './messaging/AgentTokenManager.js';
export { pickupDroppedMessages } from './messaging/DropPickup.js';
export type { DropPickupResult } from './messaging/DropPickup.js';
export {
  VALID_TRANSITIONS,
  ALLOWED_INJECTION_PROCESSES,
  DEFAULT_TTL,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RATE_LIMITS,
  THREAD_MAX_DEPTH,
  THREAD_STALE_MINUTES,
  MAX_BODY_SIZE,
  MAX_PAYLOAD_SIZE,
  MAX_SUBJECT_LENGTH,
  PAYLOAD_INLINE_THRESHOLD,
  CLOCK_SKEW_TOLERANCE,
} from './messaging/types.js';
export type {
  MessageType as InterAgentMessageType,
  MessagePriority,
  AgentMessage as InterAgentMessage,
  DeliveryPhase,
  DeliveryTransition,
  DeliveryState,
  BroadcastRecipientState,
  BroadcastState,
  SignedPayload,
  TransportMetadata,
  MessageEnvelope,
  InjectionSafety,
  ThreadStatus,
  MessageThread,
  ThreadParticipant,
  RateLimitConfig,
  SendMessageOptions,
  SendResult,
  MessageFilter,
  MessagingStats,
  MessagingConfig,
  IMessageStore,
  DeliveryResult,
  IMessageDelivery,
  RoutingResult,
  IMessageRouter,
} from './messaging/types.js';

// Knowledge
export { KnowledgeManager } from './knowledge/KnowledgeManager.js';
export type { KnowledgeSource, KnowledgeCatalog, IngestOptions, IngestResult } from './knowledge/KnowledgeManager.js';

// Self-Knowledge Tree
export { SelfKnowledgeTree } from './knowledge/SelfKnowledgeTree.js';
export type { SelfKnowledgeTreeOptions } from './knowledge/SelfKnowledgeTree.js';
export { TreeGenerator } from './knowledge/TreeGenerator.js';
export { TreeTriage } from './knowledge/TreeTriage.js';
export { TreeTraversal } from './knowledge/TreeTraversal.js';
export type { TraversalDependencies } from './knowledge/TreeTraversal.js';
export { TreeSynthesis } from './knowledge/TreeSynthesis.js';
export { ProbeRegistry, ProbeExecutionError, ProbeTimeoutError } from './knowledge/ProbeRegistry.js';
export { CoverageAuditor } from './knowledge/CoverageAuditor.js';
export type { CoverageGap, AuditResult, HealthSummary } from './knowledge/CoverageAuditor.js';
export type {
  SelfKnowledgeTreeConfig,
  SelfKnowledgeLayer,
  SelfKnowledgeNode,
  SelfKnowledgeSource,
  SelfKnowledgeResult,
  SelfKnowledgeFragment,
  SearchOptions,
  SearchPlan,
  GroundingResult,
  TriageResult as TreeTriageResult,
  TreeTraceEntry,
  ValidationResult as TreeValidationResult,
  CacheStats,
  ProbeFn,
  ProbeResult,
} from './knowledge/types.js';

// Publishing
export { TelegraphService, markdownToNodes, parseInline } from './publishing/TelegraphService.js';
export type { TelegraphConfig, TelegraphNode, TelegraphElement, TelegraphPage, PublishedPage } from './publishing/TelegraphService.js';
export { PrivateViewer } from './publishing/PrivateViewer.js';
export type { PrivateView, PrivateViewerConfig } from './publishing/PrivateViewer.js';

// Tunnel
export { TunnelManager } from './tunnel/TunnelManager.js';
export type { TunnelConfig, TunnelState } from './tunnel/TunnelManager.js';

// Pipeline types — typed contracts for message flow
export type {
  TelegramSender,
  TelegramInbound,
  PipelineMessage,
  InjectionPayload,
  PipelineLogEntry,
} from './types/pipeline.js';
export { toInbound, toPipeline, toInjection, toLogEntry, formatHistoryLine, buildInjectionTag } from './types/pipeline.js';

// Utils
export { maybeRotateJsonl } from './utils/jsonl-rotation.js';
export type { RotationOptions } from './utils/jsonl-rotation.js';

// Types
export type {
  Session,
  SessionStatus,
  SessionManagerConfig,
  ModelTier,
  JobDefinition,
  JobPriority,
  JobExecution,
  JobState,
  JobSchedulerConfig,
  UserProfile,
  UserChannel,
  UserPreferences,
  Message,
  OutgoingMessage,
  MessagingAdapter,
  MessagingAdapterConfig,
  QuotaState,
  AccountQuota,
  SessionDeathCause,
  SessionDeathClassification,
  HealthStatus,
  ComponentHealth,
  ActivityEvent,
  InstarConfig,
  ExternalOperationsConfig,
  ExternalServicePermissions,
  MonitoringConfig,
  RelationshipRecord,
  RelationshipManagerConfig,
  InteractionSummary,
  FeedbackItem,
  FeedbackConfig,
  UpdateInfo,
  UpdateResult,
  DispatchConfig,
  UpdateConfig,
  PublishingConfig,
  TunnelConfigType,
  SkipReason,
  SkipEvent,
  WorkloadSignal,
  AutoTuneState,
  IntelligenceProvider,
  IntelligenceOptions,
  EvolutionProposal,
  EvolutionType,
  EvolutionStatus,
  LearningEntry,
  LearningSource,
  CapabilityGap,
  GapCategory,
  ActionItem,
  EvolutionManagerConfig,
  DecisionJournalEntry,
  DispatchDecisionEntry,
  AgentContextSnapshot,
  MachineIdentity,
  MachineRegistry,
  MachineRegistryEntry,
  MachineStatus,
  MachineRole,
  MachineCapability,
  MultiMachineConfig,
  CoordinationMode,
  AgentAutonomyLevel,
  AutonomyProfileLevel,
  ResolvedAutonomyState,
  NotificationPreferences,
  UserRegistrationPolicy,
  AgentAutonomyCapabilities,
  AgentAutonomyConfig,
  RecoveryKeyConfig,
  ConsentRecord,
  DataCollectedManifest,
  VerificationCode,
  JoinRequest,
  AgentType,
  AgentStatus,
  AgentRegistryEntry,
  AgentRegistry,
  BackupSnapshot,
  BackupConfig,
  GitStateConfig,
  GitLogEntry,
  GitStatus,
  MemorySearchConfig,
  MemorySource,
  MemorySearchResult,
  CommonBlocker,
  CapabilityRegistry,
} from './core/types.js';
export type {
  LivingSkillsConfig,
  DefinedStepConfig,
  ExecutionRecord,
  ExecutionStep,
  ExecutionStepSource,
  ExecutionDeviation,
  PendingStep,
} from './core/types.js';
export type { Dispatch, DispatchCheckResult, DispatchEvaluation, EvaluationDecision, DispatchFeedback, DispatchStats } from './core/DispatchManager.js';
