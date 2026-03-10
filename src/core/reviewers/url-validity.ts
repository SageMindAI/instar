/**
 * URL Validity Reviewer — Catches fabricated or constructed URLs.
 *
 * Only receives extracted URLs and channel context (data minimization).
 * Detects URLs that appear to be guessed from project names rather than
 * retrieved from actual tool output.
 */

import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';

/** Regex to extract URLs from message text. */
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

export class UrlValidityReviewer extends CoherenceReviewer {
  constructor(apiKey: string, options?: ReviewerOptions) {
    super('url-validity', apiKey, options);
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    // Extract URLs from message or use pre-extracted ones
    const urls = context.extractedUrls ?? extractUrls(context.message);

    const toolContext = context.toolOutputContext
      ? `Recent tool output (for URL cross-referencing):\n${context.toolOutputContext}`
      : 'No tool output context available.';

    return `${preamble}

You are a URL validity reviewer. Your job: detect URLs in agent messages that appear to be constructed/guessed rather than retrieved from actual data.

Flag when the message contains URLs where:
- The domain appears derived from the project name (project "deep-signal" \u2192 "deepsignal.xyz")
- The URL follows a plausible pattern but wasn't quoted from tool output
- Dashboard, deployment, or service URLs that could be guessed from conventions
- Any URL containing a custom domain that isn't a well-known service

SAFE (do not flag):
- Well-known domains ONLY when the URL was present in recent tool output (see context below)
- URLs that are clearly labeled as examples
- localhost URLs when channel is "direct" (flag localhost on ALL external channels \u2014 Telegram, WhatsApp, email, etc. \u2014 suggest tunnel URL instead)
- URLs the agent says it's going to visit/fetch (intent, not claim)

SUSPICIOUS (flag as warn):
- URLs on well-known domains (github.com, vercel.app, npmjs.com) that do NOT appear in recent tool output \u2014 these may be fabricated using domain conventions
- Constructed URLs that follow plausible patterns (project-name.vercel.app) without tool verification

Channel: ${context.channel}

${toolContext}

Respond EXCLUSIVELY with valid JSON:
{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }

URLs extracted from message:
${this.wrapMessage(JSON.stringify(urls), boundary)}`;
  }
}

/**
 * Extract URLs from a text string.
 */
export function extractUrls(text: string): string[] {
  return Array.from(text.matchAll(URL_REGEX), (m) => m[0]);
}
