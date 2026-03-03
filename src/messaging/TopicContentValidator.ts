/**
 * TopicContentValidator — Validates outbound messages against topic purpose.
 *
 * When a session sends a message to its topic, this validator checks if
 * the content matches the topic's declared purpose. Mismatched content
 * is rejected with guidance — never rerouted.
 *
 * Design principles:
 * - One session, one topic. Messages never get rerouted to other topics.
 * - Topics without a declared purpose are permissive (no validation).
 * - System/infrastructure messages bypass validation.
 * - Keyword-based classification — simple, fast, auditable.
 * - Fully configurable — categories, purposes, and compatibility
 *   are defined in instar.config.json, not hardcoded.
 */

// ─── Configuration Types ────────────────────────────────────────────

/** Keyword patterns for a single content category */
export interface CategoryKeywords {
  /** Strong signal — one match is enough */
  primary: string[];
  /** Weaker signal — need 2+ matches to classify */
  secondary: string[];
}

/** Full content validation configuration */
export interface ContentValidationConfig {
  /** Whether content validation is enabled (default: false) */
  enabled: boolean;
  /** Content categories and their keyword patterns */
  categories: Record<string, CategoryKeywords>;
  /** Topic ID → purpose mapping (e.g., { "42": "billing" }) */
  topicPurposes: Record<string, string>;
  /** Purpose compatibility map — which categories are accepted by which purposes.
   * Example: { "billing": ["billing", "support"] } means a "billing" topic
   * also accepts "support" content. */
  compatibility: Record<string, string[]>;
}

// ─── Classification ─────────────────────────────────────────────────

export interface ClassificationResult {
  /** Detected content category (null if no strong match) */
  category: string | null;
  /** Confidence: 'high' (primary keyword match), 'moderate' (2+ secondary), or 'low' */
  confidence: 'high' | 'moderate' | 'low';
  /** Keywords that matched */
  matchedKeywords: string[];
}

/**
 * Classify the content category of a message based on keyword matching.
 * Categories are provided at runtime — nothing is hardcoded.
 */
export function classifyContent(
  text: string,
  categories: Record<string, CategoryKeywords>,
): ClassificationResult {
  const lowerText = text.toLowerCase();
  let bestCategory: string | null = null;
  let bestConfidence: 'high' | 'moderate' | 'low' = 'low';
  let bestMatches: string[] = [];
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(categories)) {
    const primaryMatches = keywords.primary.filter(kw => lowerText.includes(kw.toLowerCase()));
    const secondaryMatches = keywords.secondary.filter(kw => lowerText.includes(kw.toLowerCase()));

    // Score: primary matches worth 3 each, secondary worth 1 each
    const score = primaryMatches.length * 3 + secondaryMatches.length;

    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
      bestMatches = [...primaryMatches, ...secondaryMatches];

      if (primaryMatches.length > 0) {
        bestConfidence = 'high';
      } else if (secondaryMatches.length >= 2) {
        bestConfidence = 'moderate';
      } else {
        bestConfidence = 'low';
      }
    }
  }

  // Only return a category if confidence is at least moderate
  if (bestConfidence === 'low') {
    return { category: null, confidence: 'low', matchedKeywords: [] };
  }

  return {
    category: bestCategory,
    confidence: bestConfidence,
    matchedKeywords: bestMatches,
  };
}

// ─── Validation ─────────────────────────────────────────────────────

export interface ValidationResult {
  /** Whether the message is allowed */
  allowed: boolean;
  /** Reason for rejection (null if allowed) */
  reason: string | null;
  /** Detected content category */
  detectedCategory: string | null;
  /** Topic's declared purpose */
  topicPurpose: string | null;
  /** Suggested action for the caller */
  suggestion: string | null;
}

export interface ValidateOptions {
  /** Skip validation entirely (for system messages) */
  bypass?: boolean;
}

/**
 * Validate whether a message's content matches a topic's declared purpose.
 *
 * Rules:
 * - Topics without a purpose are permissive (always allowed).
 * - Topics with purpose "general" or "interface" accept everything.
 * - Content with no detected category is allowed (can't validate what you can't classify).
 * - Content matching the topic's purpose (or compatible purposes) is allowed.
 * - Mismatched content is rejected with a helpful suggestion.
 */
export function validateTopicContent(
  text: string,
  topicPurpose: string | null,
  config: ContentValidationConfig,
  options?: ValidateOptions,
): ValidationResult {
  // Bypass flag for system messages
  if (options?.bypass) {
    return { allowed: true, reason: null, detectedCategory: null, topicPurpose, suggestion: null };
  }

  // No purpose declared — permissive
  if (!topicPurpose) {
    return { allowed: true, reason: null, detectedCategory: null, topicPurpose: null, suggestion: null };
  }

  const purpose = topicPurpose.toLowerCase();

  // "general" and "interface" topics accept everything
  if (purpose === 'general' || purpose === 'interface') {
    return { allowed: true, reason: null, detectedCategory: null, topicPurpose: purpose, suggestion: null };
  }

  // Classify the content
  const classification = classifyContent(text, config.categories);

  // No category detected — allow (can't validate what you can't classify)
  if (!classification.category) {
    return { allowed: true, reason: null, detectedCategory: null, topicPurpose: purpose, suggestion: null };
  }

  // Check if detected category is compatible with topic purpose
  const compatible = config.compatibility[purpose] || [];
  if (classification.category === purpose || compatible.includes(classification.category)) {
    return {
      allowed: true,
      reason: null,
      detectedCategory: classification.category,
      topicPurpose: purpose,
      suggestion: null,
    };
  }

  // Mismatch — reject with guidance
  return {
    allowed: false,
    reason: `Content appears to be about "${classification.category}" (matched: ${classification.matchedKeywords.slice(0, 3).join(', ')}). This topic's purpose is "${purpose}".`,
    detectedCategory: classification.category,
    topicPurpose: purpose,
    suggestion: `This content doesn't match the topic's purpose. Send to a topic with purpose "${classification.category}" instead, or use the attention queue for cross-domain discoveries.`,
  };
}

/**
 * Get the purpose for a topic from the config.
 * Returns null if no purpose is set (permissive).
 */
export function getTopicPurpose(
  topicId: number,
  config: ContentValidationConfig,
): string | null {
  return config.topicPurposes[String(topicId)]?.toLowerCase() ?? null;
}
