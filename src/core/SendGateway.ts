/**
 * SendGateway — Central review point for all outbound messages.
 *
 * Four-stage pipeline:
 *   1. PEL — Credential/PII/auth token detection (fail-closed)
 *   2. Convergence — 7 heuristic quality checks (fail-open)
 *   3. GroundingValidator — Deterministic URL/entity cross-reference against canonical registry
 *   4. CoherenceGate — LLM specialist reviewers (fail-open, optional)
 *
 * All outbound channels must register and call review() before sending.
 * Unregistered channels are blocked by default.
 */

import { PolicyEnforcementLayer } from './PolicyEnforcementLayer.js';
import type { PELContext } from './PolicyEnforcementLayer.js';
import { checkConvergence } from './ConvergenceChecker.js';
import { CanonicalState } from './CanonicalState.js';
import type { CoherenceGate } from './CoherenceGate.js';

// ── Types ────────────────────────────────────────────────────────────

export interface OutboundChannel {
  channelId: string;
  isExternalFacing: boolean;
  defaultRecipientType: PELContext['recipientType'];
}

export interface ReviewRequest {
  message: string;
  channelId: string;
  /** Override channel default */
  isExternalFacing?: boolean;
  /** Override channel default */
  recipientType?: PELContext['recipientType'];
  /** For CoherenceGate retry tracking */
  sessionId?: string;
  /** System messages get PEL-only */
  messageOrigin?: 'agent' | 'system' | 'bridge';
  /** Additional context for LLM review */
  context?: Record<string, unknown>;
}

export interface ReviewResult {
  pass: boolean;
  reason?: string;
  blockedBy?: 'pel' | 'convergence' | 'grounding' | 'coherence-gate' | 'unregistered';
  warnings?: string[];
  durationMs: number;
}

// ── Stats tracking ──────────────────────────────────────────────────

interface ChannelStats {
  reviewed: number;
  passed: number;
  blocked: number;
  warnings: number;
}

// ── Implementation ──────────────────────────────────────────────────

export class SendGateway {
  private pel: PolicyEnforcementLayer;
  private coherenceGate: CoherenceGate | null;
  private canonicalState: CanonicalState;
  private channels = new Map<string, OutboundChannel>();
  private stats = new Map<string, ChannelStats>();
  private stateDir: string;

  constructor(config: { stateDir: string; coherenceGate?: CoherenceGate }) {
    this.stateDir = config.stateDir;
    this.pel = new PolicyEnforcementLayer(config.stateDir);
    this.coherenceGate = config.coherenceGate ?? null;
    this.canonicalState = new CanonicalState({ stateDir: `${config.stateDir}/state` });
  }

  /** Register an outbound channel. Must be called before review() for that channel. */
  register(channel: OutboundChannel): void {
    this.channels.set(channel.channelId, channel);
    if (!this.stats.has(channel.channelId)) {
      this.stats.set(channel.channelId, { reviewed: 0, passed: 0, blocked: 0, warnings: 0 });
    }
  }

  /** Get all registered channel IDs. */
  getRegisteredChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  /** Check if a channel is registered. */
  isRegistered(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  /** Get review stats per channel. */
  getStats(): Record<string, ChannelStats> {
    const result: Record<string, ChannelStats> = {};
    for (const [id, s] of this.stats) {
      result[id] = { ...s };
    }
    return result;
  }

  /**
   * Review an outbound message through the three-stage pipeline.
   *
   * Stage 1 (PEL): Always runs. hard_block → fail-closed.
   * Stage 2 (Convergence): Skipped for system/bridge messages. Fail-open.
   * Stage 3 (CoherenceGate): Only for external, agent messages >50 chars
   *   when CoherenceGate is configured. Fail-open.
   */
  async review(request: ReviewRequest): Promise<ReviewResult> {
    const start = Date.now();

    // ── Unregistered channel check ────────────────────────────────
    const channel = this.channels.get(request.channelId);
    if (!channel) {
      return {
        pass: false,
        reason: `Channel "${request.channelId}" is not registered with SendGateway`,
        blockedBy: 'unregistered',
        durationMs: Date.now() - start,
      };
    }

    const channelStats = this.stats.get(request.channelId)!;
    channelStats.reviewed++;

    const isExternal = request.isExternalFacing ?? channel.isExternalFacing;
    const recipientType = request.recipientType ?? channel.defaultRecipientType;
    const origin = request.messageOrigin ?? 'agent';
    const warnings: string[] = [];

    // ── Stage 1: PEL (always runs, fail-closed) ──────────────────
    try {
      const pelResult = this.pel.enforce(request.message, {
        channel: request.channelId,
        isExternalFacing: isExternal,
        recipientType,
        stateDir: this.stateDir,
      });

      if (pelResult.outcome === 'hard_block') {
        channelStats.blocked++;
        const violations = pelResult.violations
          .filter(v => v.severity === 'hard_block')
          .map(v => v.detail);
        return {
          pass: false,
          reason: `PEL blocked: ${violations.join('; ')}`,
          blockedBy: 'pel',
          durationMs: Date.now() - start,
        };
      }

      if (pelResult.outcome === 'warn') {
        for (const v of pelResult.violations) {
          warnings.push(`[PEL] ${v.detail}`);
        }
      }
    } catch (err) {
      // PEL errors are fail-open (the PEL itself is designed to be safe)
      warnings.push(`[PEL] Error during enforcement: ${err instanceof Error ? err.message : String(err)}`);
    }

    // System and bridge messages: PEL-only
    if (origin === 'system' || origin === 'bridge') {
      if (warnings.length > 0) channelStats.warnings++;
      else channelStats.passed++;
      return {
        pass: true,
        warnings: warnings.length > 0 ? warnings : undefined,
        durationMs: Date.now() - start,
      };
    }

    // ── Stage 2: Convergence (fail-open) ─────────────────────────
    try {
      const convergence = checkConvergence(request.message);
      if (!convergence.pass) {
        for (const issue of convergence.issues) {
          warnings.push(`[convergence:${issue.category}] ${issue.detail}`);
        }
      }
    } catch (err) {
      warnings.push(`[convergence] Error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Stage 3: GroundingValidator (deterministic, external only) ──
    // Fast check: any URL in the message that doesn't match known projects?
    if (isExternal) {
      try {
        const groundingResult = this.validateGrounding(request.message);
        if (!groundingResult.pass) {
          channelStats.blocked++;
          return {
            pass: false,
            reason: `Grounding check failed: ${groundingResult.reason}`,
            blockedBy: 'grounding',
            warnings: warnings.length > 0 ? warnings : undefined,
            durationMs: Date.now() - start,
          };
        }
        if (groundingResult.warnings) {
          for (const w of groundingResult.warnings) {
            warnings.push(`[grounding] ${w}`);
          }
        }
      } catch (err) {
        // Grounding validator errors are fail-open (it's a heuristic)
        warnings.push(`[grounding] Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Stage 4: CoherenceGate LLM review (fail-open, conditional) ──
    // Run LLM review for external messages that are either >50 chars OR contain URLs.
    // The URL check closes a gap where short messages with fabricated URLs bypassed review.
    const containsUrl = /https?:\/\/\S+/.test(request.message);
    const shouldRunLLM = (
      this.coherenceGate &&
      isExternal &&
      (request.message.length > 50 || containsUrl)
    );

    if (shouldRunLLM) {
      try {
        const evalResult = await this.coherenceGate!.evaluate({
          message: request.message,
          sessionId: request.sessionId || 'send-gateway',
          stopHookActive: false,
          context: {
            channel: request.channelId,
            isExternalFacing: isExternal,
            recipientType,
            ...request.context as Record<string, unknown>,
          },
        });

        if (!evalResult.pass) {
          channelStats.blocked++;
          return {
            pass: false,
            reason: `CoherenceGate blocked: ${evalResult.feedback || 'Review failed'}`,
            blockedBy: 'coherence-gate',
            warnings: warnings.length > 0 ? warnings : undefined,
            durationMs: Date.now() - start,
          };
        }

        if (evalResult.warnings && evalResult.warnings.length > 0) {
          warnings.push(`[coherence-gate] ${evalResult.warnings.join('; ')}`);
        }
      } catch (err) {
        // CoherenceGate errors are fail-open
        warnings.push(`[coherence-gate] Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Result ───────────────────────────────────────────────────
    if (warnings.length > 0) channelStats.warnings++;
    else channelStats.passed++;

    return {
      pass: true,
      warnings: warnings.length > 0 ? warnings : undefined,
      durationMs: Date.now() - start,
    };
  }

  // ── GroundingValidator ─────────────────────────────────────────────

  /** Well-known domains that don't need registry verification. */
  private static WELL_KNOWN_DOMAINS = new Set([
    'github.com', 'gitlab.com', 'npmjs.com', 'google.com', 'stackoverflow.com',
    'youtube.com', 'twitter.com', 'x.com', 'linkedin.com', 'reddit.com',
    'medium.com', 'substack.com', 'anthropic.com', 'openai.com', 'localhost',
    'vercel.com', 'netlify.com', 'cloudflare.com', 'aws.amazon.com',
    'docs.google.com', 'drive.google.com', 'notion.so', 'figma.com',
  ]);

  /**
   * Deterministic grounding check — no LLM needed.
   * Extracts URLs from the message and cross-references against the canonical
   * project registry. Flags custom-domain URLs that don't match any known project.
   */
  private validateGrounding(message: string): { pass: boolean; reason?: string; warnings?: string[] } {
    const urlRegex = /https?:\/\/([^\s/<>"')\]]+)/g;
    const matches = [...message.matchAll(urlRegex)];
    if (matches.length === 0) return { pass: true };

    const projects = this.canonicalState.getProjects();
    const knownDomains = new Set<string>();

    // Build set of known domains from project registry
    for (const project of projects) {
      if (project.deploymentTargets) {
        for (const target of project.deploymentTargets) {
          try {
            const domain = new URL(target).hostname;
            knownDomains.add(domain);
          } catch {
            // Non-URL deployment target (e.g., "vercel" shorthand)
            knownDomains.add(target);
          }
        }
      }
      if (project.gitRemote) {
        try {
          const domain = new URL(project.gitRemote).hostname;
          knownDomains.add(domain);
        } catch { /* ignore */ }
      }
    }

    const warnings: string[] = [];
    const unknownUrls: string[] = [];

    for (const match of matches) {
      const fullDomain = match[1].split('/')[0].split(':')[0]; // Strip port and path
      const domain = fullDomain.replace(/^www\./, '');

      // Skip well-known domains
      if (SendGateway.WELL_KNOWN_DOMAINS.has(domain)) continue;
      // Skip known project domains
      if (knownDomains.has(domain)) continue;
      // Skip subdomains of well-known domains
      const parentDomain = domain.split('.').slice(-2).join('.');
      if (SendGateway.WELL_KNOWN_DOMAINS.has(parentDomain)) continue;

      unknownUrls.push(match[0]);
    }

    if (unknownUrls.length > 0) {
      // If we have project registry entries to check against, unrecognized URLs are suspicious
      if (projects.length > 0) {
        warnings.push(`Unrecognized URL(s) not in project registry: ${unknownUrls.join(', ')}`);
      }
      // Don't hard-block on grounding alone — the LLM reviewers will make the final call
      // with the canonical context. But warn so the CoherenceGate reviewers are primed.
    }

    return { pass: true, warnings: warnings.length > 0 ? warnings : undefined };
  }

  /** Clean up resources. */
  destroy(): void {
    this.pel.destroy();
  }
}
