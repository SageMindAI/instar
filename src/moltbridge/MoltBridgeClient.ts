/**
 * MoltBridgeClient — Wraps the published MoltBridge SDK for instar integration.
 *
 * Uses the real `moltbridge` npm package with proper Ed25519 auth,
 * proof-of-AI verification, and correct endpoint paths.
 *
 * Adds:
 * - Circuit breaker for resilience
 * - IQS band caching (1-hour TTL)
 * - Identity bridging (instar Ed25519 key → MoltBridge SDK signer)
 */

import { MoltBridge, Ed25519Signer } from 'moltbridge';
import type { CanonicalIdentity } from '../identity/types.js';

// ── Types ────────────────────────────────────────────────────────────

export interface MoltBridgeConfig {
  enabled: boolean;
  apiUrl: string;                // e.g. "https://api.moltbridge.ai"
  autoRegister?: boolean;        // default false
  enrichmentMode?: 'manual' | 'cached-only' | 'auto';
  /** Agent name for registration (defaults to 'instar-agent') */
  agentName?: string;
  /** Platform identifier for registration (defaults to 'instar') */
  platform?: string;
}

export interface MoltBridgeAgent {
  agentId: string;
  agentName: string;
  capabilities: string[];
  trustScore: number;
  matchScore?: number;
}

export interface DiscoveryResult {
  agents: MoltBridgeAgent[];
  source: 'moltbridge';
  queryTimeMs: number;
  cached: boolean;
}

export interface AttestationPayload {
  targetAgentId: string;
  attestationType: 'CAPABILITY' | 'IDENTITY' | 'INTERACTION';
  capabilityTag?: string;
  confidence: number;
}

export interface RegistrationResult {
  agent: Record<string, unknown>;
  consentsGranted: string[];
}

export type IQSBand = 'high' | 'medium' | 'low' | 'unknown';

// ── Circuit Breaker ──────────────────────────────────────────────────

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  open: boolean;
  openedAt: number;
}

const CB_THRESHOLD = 3;
const CB_RESET_MS = 5 * 60 * 1000; // 5 minutes

// ── Client ───────────────────────────────────────────────────────────

export class MoltBridgeClient {
  private config: MoltBridgeConfig;
  private sdk: MoltBridge | null = null;
  private circuitBreaker: CircuitBreakerState = {
    failures: 0, lastFailure: 0, open: false, openedAt: 0,
  };
  private iqsCache: Map<string, { band: IQSBand; cachedAt: number }> = new Map();
  private readonly IQS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  private verificationToken: string | null = null;

  constructor(config: MoltBridgeConfig) {
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get enrichmentMode(): string {
    return this.config.enrichmentMode ?? 'manual';
  }

  /**
   * Initialize the SDK with an instar identity.
   * Must be called before any API operations.
   */
  initializeWithIdentity(identity: CanonicalIdentity): void {
    const seedHex = identity.privateKey.toString('hex');
    this.sdk = new MoltBridge({
      agentId: identity.canonicalId,
      signingKey: seedHex,
      baseUrl: this.config.apiUrl,
      timeout: 30_000,
      maxRetries: 3,
    });
  }

  /**
   * Check if the SDK has been initialized with an identity.
   */
  get initialized(): boolean {
    return this.sdk !== null;
  }

  /**
   * Verify with MoltBridge (proof-of-AI challenge).
   * Required before registration.
   */
  async verify(): Promise<{ verified: boolean; token: string }> {
    this.requireSDK();
    this.checkCircuitBreaker();

    try {
      const result = await this.sdk!.verify();
      this.recordSuccess();
      this.verificationToken = result.token;
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Register this agent with MoltBridge.
   * Automatically runs verification if no token is cached.
   */
  async register(
    identity: CanonicalIdentity,
    capabilities: string[] = [],
    displayName?: string,
  ): Promise<RegistrationResult> {
    this.requireSDK();
    this.checkCircuitBreaker();

    try {
      // Run verification if we don't have a token
      if (!this.verificationToken) {
        const verification = await this.sdk!.verify();
        this.verificationToken = verification.token;
      }

      const response = await this.sdk!.register({
        agentId: identity.canonicalId,
        name: displayName ?? this.config.agentName ?? 'instar-agent',
        platform: this.config.platform ?? 'instar',
        pubkey: identity.publicKey.toString('base64url'),
        capabilities,
        verificationToken: this.verificationToken,
        omniscienceAcknowledged: true,
        article22Consent: true,
      });

      this.recordSuccess();
      this.verificationToken = null; // consumed

      return {
        agent: (response as any).agent ?? response,
        consentsGranted: (response as any).consents_granted ?? [],
      };
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Discover agents by capability.
   */
  async discover(
    capability: string,
    limit = 10,
  ): Promise<DiscoveryResult> {
    this.requireSDK();
    this.checkCircuitBreaker();

    const startTime = Date.now();
    try {
      const response = await this.sdk!.discoverCapability({
        needs: [capability],
        maxResults: limit,
      });
      this.recordSuccess();

      const results = (response as any).results ?? [];
      return {
        agents: results.map((r: any) => ({
          agentId: r.agent_id,
          agentName: r.agent_name,
          capabilities: r.matched_capabilities ?? [],
          trustScore: r.trust_score ?? 0,
          matchScore: r.match_score,
        })),
        source: 'moltbridge',
        queryTimeMs: Date.now() - startTime,
        cached: false,
      };
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Get IQS band for an agent (cached).
   * Returns null on error (graceful degradation).
   */
  async getIQSBand(targetId: string): Promise<IQSBand | null> {
    // Check cache first
    const cached = this.iqsCache.get(targetId);
    if (cached && Date.now() - cached.cachedAt < this.IQS_CACHE_TTL_MS) {
      return cached.band;
    }

    this.requireSDK();
    this.checkCircuitBreaker();

    try {
      const response = await this.sdk!.evaluateIqs({ targetId });
      this.recordSuccess();

      const band = ((response as any).band ?? 'unknown') as IQSBand;
      this.iqsCache.set(targetId, { band, cachedAt: Date.now() });
      return band;
    } catch (err) {
      this.recordFailure();
      return null; // graceful degradation
    }
  }

  /**
   * Submit a peer attestation.
   */
  async submitAttestation(attestation: AttestationPayload): Promise<boolean> {
    this.requireSDK();
    this.checkCircuitBreaker();

    try {
      await this.sdk!.attest({
        targetAgentId: attestation.targetAgentId,
        attestationType: attestation.attestationType,
        capabilityTag: attestation.capabilityTag,
        confidence: attestation.confidence,
      });
      this.recordSuccess();
      return true;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Check server health (unauthenticated).
   */
  async health(): Promise<{ status: string; neo4j: { connected: boolean } }> {
    this.requireSDK();

    try {
      const result = await this.sdk!.health();
      return result as any;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Check if the circuit breaker is currently open.
   */
  get isCircuitBreakerOpen(): boolean {
    if (!this.circuitBreaker.open) return false;
    if (Date.now() - this.circuitBreaker.openedAt > CB_RESET_MS) {
      this.circuitBreaker.open = false;
      this.circuitBreaker.failures = 0;
      return false;
    }
    return true;
  }

  // ── Private ─────────────────────────────────────────────────────

  private requireSDK(): void {
    if (!this.sdk) {
      throw new Error('MoltBridgeClient not initialized — call initializeWithIdentity() first');
    }
  }

  private checkCircuitBreaker(): void {
    if (this.isCircuitBreakerOpen) {
      throw new Error('MoltBridge circuit breaker is open — service temporarily unavailable');
    }
  }

  private recordSuccess(): void {
    this.circuitBreaker.failures = 0;
  }

  private recordFailure(): void {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = Date.now();
    if (this.circuitBreaker.failures >= CB_THRESHOLD) {
      this.circuitBreaker.open = true;
      this.circuitBreaker.openedAt = Date.now();
    }
  }
}
