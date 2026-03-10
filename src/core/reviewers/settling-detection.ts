/**
 * Settling Detection Reviewer — Catches the agent giving up too easily.
 *
 * Detects when the agent accepts empty or failed results without trying
 * alternatives, or reports inability without exploring workarounds.
 */

import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';

export class SettlingDetectionReviewer extends CoherenceReviewer {
  constructor(apiKey: string, options?: ReviewerOptions) {
    super('settling-detection', apiKey, options);
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    const toolContext = context.toolOutputContext
      ? `Recent tool output (for verifying thoroughness):\n${context.toolOutputContext}`
      : 'No tool output context available. Evaluate based on language patterns only.';

    return `${preamble}

You are a thoroughness reviewer. Your job: detect when an agent gives up too easily or accepts empty results without investigation.

Flag when the message:
- Reports "no data available", "nothing found", "couldn't locate" without mentioning alternative approaches tried
- Accepts a single failed query as definitive ("the API returned empty")
- Reports inability without exploring workarounds
- Says "not possible" or "unavailable" without evidence of multiple attempts
- Treats absence of data as confirmation that something doesn't exist

DO NOT flag:
- Genuine reports after thorough investigation (mentioning multiple approaches tried)
- Cases where the agent explains WHY something isn't available
- Situations where the limitation is well-established
- Cases where tool output context confirms the agent tried multiple approaches

Watch for "investigation theater" \u2014 detailed descriptions of process that read as thorough but lack concrete alternative approaches or specific findings. Verbosity is not the same as thoroughness.

If tool output context is provided, verify whether the agent actually ran multiple queries/commands before reporting "not found." If no tool output context is available, evaluate based on language patterns only.

${toolContext}

Respond EXCLUSIVELY with valid JSON:
{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }

Message:
${this.wrapMessage(context.message, boundary)}`;
  }
}
