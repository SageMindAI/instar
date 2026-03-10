/**
 * Gate Reviewer — Fast triage to determine if a response needs full review.
 *
 * Returns a GateResult instead of the standard ReviewResult.
 * Includes the "Simple Acknowledgment Loophole" fix: short messages expressing
 * inability ALWAYS need review.
 */

import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewResult, ReviewerOptions } from '../CoherenceReviewer.js';

export interface GateResult {
  needsReview: boolean;
  reason: string;
  reviewer: string;
  latencyMs: number;
}

export class GateReviewer extends CoherenceReviewer {
  constructor(apiKey: string, options?: ReviewerOptions) {
    super('gate', apiKey, options);
  }

  async review(context: ReviewContext): Promise<ReviewResult> {
    const start = Date.now();
    try {
      const prompt = this.buildPrompt(context);
      const timeoutMs = this.options.timeoutMs ?? 5_000;

      const raw = await Promise.race([
        this.callApi(prompt),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Gate timeout')), timeoutMs),
        ),
      ]);

      const parsed = this.parseGateResponse(raw);
      const latencyMs = Date.now() - start;
      this.metrics.totalLatencyMs += latencyMs;

      if (parsed.needsReview) {
        this.metrics.failCount++;
      } else {
        this.metrics.passCount++;
      }

      // Map gate result to ReviewResult: pass=true means "no review needed" (skip)
      return {
        pass: !parsed.needsReview,
        severity: 'warn',
        issue: parsed.needsReview ? parsed.reason : '',
        suggestion: '',
        reviewer: this.name,
        latencyMs,
      };
    } catch {
      // Fail-open for gate: if gate fails, assume review IS needed (conservative)
      const latencyMs = Date.now() - start;
      this.metrics.totalLatencyMs += latencyMs;
      this.metrics.errorCount++;
      return {
        pass: false,
        severity: 'warn',
        issue: 'Gate reviewer error — defaulting to full review',
        suggestion: '',
        reviewer: this.name,
        latencyMs,
      };
    }
  }

  /**
   * Gate-specific response: full review is needed. Conservative fail-open.
   */
  async reviewAsGate(context: ReviewContext): Promise<GateResult> {
    const result = await this.review(context);
    return {
      needsReview: !result.pass,
      reason: result.issue,
      reviewer: result.reviewer,
      latencyMs: result.latencyMs,
    };
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    return `${preamble}

You are a message triage system. Given an agent's draft response to a user, determine whether it needs detailed quality review.

Respond with JSON: { "needsReview": boolean, "reason": "brief explanation" }

NEEDS REVIEW when the message:
- Is more than 2-3 sentences
- Contains specific claims, data points, URLs, or status reports
- References system state, configurations, or technical details
- Makes commitments or promises
- Reports on work completed or findings
- Is being sent to an external channel (Telegram, WhatsApp, email, or any non-CLI channel)

DOES NOT NEED REVIEW when the message:
- Is a simple POSITIVE acknowledgment ("Got it", "On it", "Done") with no substantive claims
- Is a short clarifying question that makes no assertions
- Is a brief status update with no specific claims
- Contains no technical content AND no negative assertions

ALWAYS NEEDS REVIEW even if short:
- Any message expressing inability ("I can't", "I'm unable to", "not possible")
- Any message reporting failure or empty results ("nothing found", "couldn't locate", "no data")
- Any message containing URLs, numbers, or specific data points
- Any message on an external channel (Telegram, WhatsApp, email, or any non-CLI channel) regardless of length
- Any message that makes definitive negative statements

Channel: ${context.channel}
Is external: ${context.isExternalFacing}

Message to evaluate:
<<<${boundary}>>>
${JSON.stringify(context.message)}
<<<${boundary}>>>`;
  }

  private parseGateResponse(raw: string): { needsReview: boolean; reason: string } {
    const failOpen = { needsReview: true, reason: 'Failed to parse gate response' };

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.metrics.jsonParseErrors++;
        return failOpen;
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      if (typeof parsed['needsReview'] !== 'boolean') {
        this.metrics.jsonParseErrors++;
        return failOpen;
      }

      return {
        needsReview: parsed['needsReview'] as boolean,
        reason: typeof parsed['reason'] === 'string' ? (parsed['reason'] as string) : '',
      };
    } catch {
      this.metrics.jsonParseErrors++;
      return failOpen;
    }
  }
}
