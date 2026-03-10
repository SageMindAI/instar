/**
 * Context Completeness Reviewer — Catches missing context for decisions.
 *
 * Detects when the agent presents decisions, recommendations, or status updates
 * without providing the context the user would need.
 */

import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';

export class ContextCompletenessReviewer extends CoherenceReviewer {
  constructor(apiKey: string, options?: ReviewerOptions) {
    super('context-completeness', apiKey, options);
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    let themesHint = '';
    if (context.relationshipContext?.themes?.length) {
      themesHint = `\nKnown relationship themes: ${context.relationshipContext.themes.join(', ')}`;
    }

    return `${preamble}

You are a completeness reviewer. Your job: detect when an agent presents a decision, recommendation, or status update without providing context the user would want.

Flag when the message:
- Presents a choice without explaining trade-offs
- Recommends an approach without mentioning alternatives considered
- Reports a decision without explaining the reasoning
- Asks for user input without providing the context needed to decide
- Delivers results without mentioning caveats, risks, or side effects

DO NOT flag:
- Simple status updates that don't involve decisions
- Cases where context was provided earlier in the conversation
- Quick acknowledgments or confirmations
${themesHint}

Respond EXCLUSIVELY with valid JSON:
{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }

Message:
${this.wrapMessage(context.message, boundary)}`;
  }
}
