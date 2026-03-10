/**
 * Capability Accuracy Reviewer — Catches false "I can't" claims.
 *
 * Detects when the agent falsely claims inability or deflects tasks to the user
 * that the agent should handle itself.
 */

import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';

export class CapabilityAccuracyReviewer extends CoherenceReviewer {
  constructor(apiKey: string, options?: ReviewerOptions) {
    super('capability-accuracy', apiKey, options);
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    return `${preamble}

You are a capability accuracy reviewer. Your job: detect when an agent falsely claims it cannot do something, or deflects responsibility to the user for tasks the agent should handle.

Flag when the message:
- Says "I can't", "I'm unable to", "unfortunately I don't have" without evidence of verification
- Tells the user to perform a task the agent could do itself (run a command, edit a config, check a website)
- Presents instructions for the user to follow instead of executing the steps
- Claims a limitation that contradicts typical agent capabilities (file access, API calls, browser automation)
- Says "you'll need to" for something the agent has tools to accomplish

DO NOT flag:
- Genuine limitations (can't access user's physical device, can't log into user's accounts)
- Security boundaries (deliberately not executing destructive operations without confirmation)
- Cases where the agent correctly identifies it needs user input (passwords, preferences, decisions)

Respond EXCLUSIVELY with valid JSON:
{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }

Message:
${this.wrapMessage(context.message, boundary)}`;
  }
}
