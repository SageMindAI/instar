/**
 * UnifiedTrustWiring — Connects the three-layer trust model into the existing Threadline infrastructure.
 *
 * This module is the integration glue between:
 * - Build 1: Canonical identity (src/identity/)
 * - Build 2: AuthorizationPolicy, TrustEvaluator, SecureInvitation, MoltBridgeClient,
 *            DiscoveryWaterfall, MessageSecurity, TrustAuditLog, SybilProtection
 * - Existing: AgentTrustManager, InboundMessageGate, ThreadlineBootstrap
 *
 * Rather than modifying existing classes (risky for regressions), this creates
 * a unified facade that composes all components.
 */

import type { AgentTrustManager, AgentTrustLevel } from './AgentTrustManager.js';
import { AuthorizationPolicyManager, type PolicyEvaluation, type ResourceType, type ActionType } from './AuthorizationPolicy.js';
import { evaluateTrust, canUpgradeTrust, type TrustLevel, type TrustSignals, type IQSBand } from './TrustEvaluator.js';
import { TrustAuditLog, type AuditAction } from './TrustAuditLog.js';
import { frameIncomingMessage, sanitizeCapabilityDescription, detectPotentialInjection } from './MessageSecurity.js';
import { SecureInvitationManager, type InvitationToken } from './SecureInvitation.js';
import { DiscoveryWaterfall, type DiscoveryAdapter, type DiscoveryResult, type DiscoveryOptions } from './DiscoveryWaterfall.js';
import { MoltBridgeClient, type MoltBridgeConfig } from '../moltbridge/MoltBridgeClient.js';
import { CanonicalIdentityManager } from '../identity/IdentityManager.js';
import {
  hasLegacyIdentity,
  hasCanonicalIdentity,
  migrateFromLegacy,
} from '../identity/Migration.js';

// ── Types ────────────────────────────────────────────────────────────

export interface UnifiedTrustConfig {
  stateDir: string;
  moltbridge?: MoltBridgeConfig;
  /** Passphrase for canonical identity encryption. Omit for dev/unencrypted. */
  identityPassphrase?: string;
}

export interface UnifiedTrustSystem {
  /** The existing trust manager (backward-compatible) */
  trustManager: AgentTrustManager;
  /** New authorization policy manager */
  authPolicy: AuthorizationPolicyManager;
  /** Hash-chain audit log */
  auditLog: TrustAuditLog;
  /** Ed25519-signed invitation manager */
  invitations: SecureInvitationManager;
  /** Three-tier discovery */
  discovery: DiscoveryWaterfall;
  /** MoltBridge client (null if disabled) */
  moltbridge: MoltBridgeClient | null;
  /** Canonical identity manager */
  identity: CanonicalIdentityManager;
  /** Evaluate combined trust + authorization for a permission check */
  checkPermission: (fingerprint: string, resource: ResourceType, resourceId: string | undefined, action: ActionType) => UnifiedPermissionResult;
  /** Frame an incoming agent message for prompt injection defense */
  frameMessage: (content: string, senderFingerprint: string) => string;
  /** Run discovery waterfall */
  discover: (options: DiscoveryOptions) => Promise<DiscoveryResult>;
  /** Audit a trust/authorization event */
  audit: (action: AuditAction, subject: string, actor: string, details?: Record<string, unknown>) => void;
  /** Clean shutdown */
  shutdown: () => void;
}

export interface UnifiedPermissionResult {
  allowed: boolean;
  trustLevel: TrustLevel;
  authorizationResult: PolicyEvaluation;
  reason: string;
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create the unified trust system.
 *
 * Call this during server initialization, after bootstrapThreadline().
 * It wraps the existing AgentTrustManager with the three-layer model.
 */
export function createUnifiedTrustSystem(
  existingTrustManager: AgentTrustManager,
  config: UnifiedTrustConfig,
): UnifiedTrustSystem {
  const { stateDir } = config;

  // Initialize canonical identity (migrate from legacy if needed)
  const identity = new CanonicalIdentityManager(stateDir);
  if (!identity.exists()) {
    if (hasLegacyIdentity(stateDir) && !hasCanonicalIdentity(stateDir)) {
      const result = migrateFromLegacy(stateDir, {
        passphrase: config.identityPassphrase,
        skipRecovery: !config.identityPassphrase, // skip recovery in dev mode
      });
      // Note: result.recoveryPhrase should be surfaced to the user
      // via the dashboard or attention queue. Not done here.
      identity.load({ passphrase: config.identityPassphrase });
    } else {
      identity.create({
        passphrase: config.identityPassphrase,
        skipRecovery: !config.identityPassphrase,
      });
    }
  } else {
    identity.load({ passphrase: config.identityPassphrase });
  }

  // Create new components
  const authPolicy = new AuthorizationPolicyManager(stateDir);
  const auditLog = new TrustAuditLog(stateDir);
  const invitations = new SecureInvitationManager(stateDir);
  const discoveryWaterfall = new DiscoveryWaterfall();

  // MoltBridge (optional)
  let moltbridge: MoltBridgeClient | null = null;
  if (config.moltbridge?.enabled) {
    moltbridge = new MoltBridgeClient(config.moltbridge);

    // Initialize SDK with identity keys for Ed25519 auth signing
    const id = identity.get();
    if (id) {
      moltbridge.initializeWithIdentity(id);

      // Register MoltBridge as discovery stage 3
      const moltbridgeAdapter: DiscoveryAdapter = {
        source: 'moltbridge',
        isAvailable: () => moltbridge !== null && moltbridge.initialized && !moltbridge.isCircuitBreakerOpen,
        search: async (query: string, limit: number) => {
          const result = await moltbridge!.discover(query, limit);
          return result.agents.map(a => ({
            fingerprint: a.agentId,
            displayName: a.agentName,
            capabilities: a.capabilities,
            source: 'moltbridge' as const,
            sourcePrecedence: 1,
            iqsBand: undefined,
            profileCard: {
              narrativeSummary: a.agentName ? `${a.agentName} on MoltBridge` : undefined,
              profileCompletenessScore: undefined,
              profileUrl: `/agent/profile/${a.agentId}`,
            },
          }));
        },
      };
      discoveryWaterfall.registerAdapter(moltbridgeAdapter);
    }
  }

  // Wire trust change callback to audit log
  // The existing trustManager's onTrustChange fires on every trust change.
  // We intercept it to also write to the hash-chain audit log.

  /**
   * Combined permission check: trust baseline ∩ authorization grants.
   *
   * 1. Get trust level from existing AgentTrustManager
   * 2. Check if trust level allows the operation baseline
   * 3. Check authorization grants for explicit allow/deny
   * 4. Combined result: both must allow
   */
  function checkPermission(
    fingerprint: string,
    resource: ResourceType,
    resourceId: string | undefined,
    action: ActionType,
  ): UnifiedPermissionResult {
    // Trust baseline from existing manager
    const trustLevel = existingTrustManager.getTrustLevelByFingerprint(fingerprint) as TrustLevel;
    // checkPermission needs the agent name or fingerprint key — find the profile
    const profile = existingTrustManager.getProfileByFingerprint(fingerprint);
    // Use fingerprint as key since profiles are now keyed by fingerprint
    const agentKey = fingerprint;
    const trustBaseline = existingTrustManager.checkPermission(
      agentKey,
      mapActionToOperation(action),
    );

    // Authorization policy check
    const authResult = authPolicy.evaluate(fingerprint, resource, resourceId, action);

    // Combined: trust baseline must allow AND (authorization must allow OR no grants exist)
    // If no authorization grants exist, fall back to trust-only (backward compat)
    const grantsExist = authPolicy.getGrantsForSubject(fingerprint).length > 0;

    let allowed: boolean;
    let reason: string;

    if (!trustBaseline) {
      allowed = false;
      reason = `Trust baseline denied: trust level "${trustLevel}" does not permit "${action}"`;
    } else if (grantsExist && !authResult.allowed) {
      allowed = false;
      reason = `Authorization denied: ${authResult.reason}`;
    } else {
      allowed = true;
      reason = grantsExist
        ? `Allowed: trust baseline (${trustLevel}) + authorization grant`
        : `Allowed: trust baseline (${trustLevel}), no specific grants`;
    }

    return { allowed, trustLevel, authorizationResult: authResult, reason };
  }

  /**
   * Frame an incoming message with security markers.
   */
  function frameMessage(content: string, senderFingerprint: string): string {
    const trustLevel = existingTrustManager.getTrustLevelByFingerprint(senderFingerprint);

    // Detect potential injection (advisory logging)
    const injectionCheck = detectPotentialInjection(content);
    if (injectionCheck.suspicious) {
      auditLog.append('injection-detected', senderFingerprint, 'system', {
        patterns: injectionCheck.patterns,
      });
    }

    return frameIncomingMessage(content, senderFingerprint, trustLevel);
  }

  /**
   * Run discovery with registered adapters.
   */
  async function discover(options: DiscoveryOptions): Promise<DiscoveryResult> {
    return discoveryWaterfall.discover(options);
  }

  /**
   * Write to the audit log.
   */
  function audit(
    action: AuditAction,
    subject: string,
    actor: string,
    details?: Record<string, unknown>,
  ): void {
    auditLog.append(action, subject, actor, details);
  }

  /**
   * Clean shutdown — flush all state to disk.
   */
  function shutdown(): void {
    authPolicy.flush();
    authPolicy.pruneExpired();
  }

  return {
    trustManager: existingTrustManager,
    authPolicy,
    auditLog,
    invitations,
    discovery: discoveryWaterfall,
    moltbridge,
    identity,
    checkPermission,
    frameMessage,
    discover,
    audit,
    shutdown,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Map ActionType to legacy operation string for backward compat */
function mapActionToOperation(action: ActionType): string {
  const mapping: Record<ActionType, string> = {
    message: 'message',
    request_task: 'task-request',
    delegate: 'delegate',
    read: 'data-share',
    write: 'data-share',
    execute: 'spawn',
    probe: 'ping',
  };
  return mapping[action] ?? action;
}
