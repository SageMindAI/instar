/**
 * MoltBridge module — Public API.
 *
 * Wraps the published `moltbridge` SDK for instar integration.
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
