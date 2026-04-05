/**
 * MoltBridge module — Public API.
 *
 * Wraps the published `moltbridge` SDK for instar integration.
 * Includes rich agent profile compilation and management.
 */

export {
  MoltBridgeClient,
  type MoltBridgeConfig,
  type MoltBridgeAgent,
  type DiscoveryResult,
  type AttestationPayload,
  type RegistrationResult,
  type IQSBand,
} from './MoltBridgeClient.js';

export {
  createMoltBridgeRoutes,
  type MoltBridgeRouteDeps,
} from './routes.js';

export {
  ProfileCompiler,
  type ProfileCompilerConfig,
} from './ProfileCompiler.js';

export type {
  RichProfilePayload,
  DiscoveryCard,
  Specialization,
  TrackRecordEntry,
  StructuredSignals,
  ProfileDraft,
  ProfileFreshnessState,
  FieldVisibility,
} from './types.js';

export { PROFILE_LIMITS } from './types.js';
