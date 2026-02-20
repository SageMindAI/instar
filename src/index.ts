/**
 * instar — Persistent autonomy infrastructure for AI agents.
 *
 * Public API for programmatic usage.
 */

// Core
export { SessionManager } from './core/SessionManager.js';
export { StateManager } from './core/StateManager.js';
export { RelationshipManager } from './core/RelationshipManager.js';
export { FeedbackManager } from './core/FeedbackManager.js';
export { DispatchManager } from './core/DispatchManager.js';
export { UpdateChecker } from './core/UpdateChecker.js';
export { loadConfig, detectTmuxPath, detectClaudePath, detectProjectDir, ensureStateDir } from './core/Config.js';

// Users
export { UserManager } from './users/UserManager.js';

// Scheduler
export { JobScheduler } from './scheduler/JobScheduler.js';
export { loadJobs, validateJob } from './scheduler/JobLoader.js';

// Server
export { AgentServer } from './server/AgentServer.js';
export { createRoutes, formatUptime } from './server/routes.js';
export type { RouteContext } from './server/routes.js';
export { corsMiddleware, authMiddleware, rateLimiter, requestTimeout, errorHandler } from './server/middleware.js';

// Monitoring
export { HealthChecker } from './monitoring/HealthChecker.js';
export { QuotaTracker } from './monitoring/QuotaTracker.js';
export { SleepWakeDetector } from './core/SleepWakeDetector.js';

// Messaging
export { TelegramAdapter } from './messaging/TelegramAdapter.js';
export type { TelegramConfig } from './messaging/TelegramAdapter.js';

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
  HealthStatus,
  ComponentHealth,
  ActivityEvent,
  InstarConfig,
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
} from './core/types.js';
export type { Dispatch, DispatchCheckResult, DispatchEvaluation, EvaluationDecision, DispatchFeedback, DispatchStats } from './core/DispatchManager.js';
