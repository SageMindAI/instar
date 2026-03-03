/**
 * UserContextBuilder — builds a bounded per-user context block for session injection.
 *
 * Implements Gap 8 from the User-Agent Topology Spec:
 *   "No mechanism to inject user-specific context (preferences, relationship history,
 *    communication style, permissions) into session prompts."
 *
 * Design:
 *   - Bounded: respects maxContextTokens (default 500, ~4 chars/token estimate)
 *   - Structured: permissions are injected as structured data the LLM cannot override
 *   - Progressive: richer profiles produce richer context; minimal profiles still work
 *   - Deterministic: same profile always produces same context block
 *
 * Token budget allocation (default 500 tokens):
 *   - Header + permissions: ~50 tokens (always included)
 *   - Preferences: ~30 tokens
 *   - Bio: ~50 tokens (truncated if needed)
 *   - Interests: ~30 tokens
 *   - Relationship: ~40 tokens
 *   - Custom fields: ~50 tokens
 *   - Context (history summary): remaining budget
 */

import type {
  UserProfile,
  UserContextBlock,
  OnboardingConfig,
} from '../core/types.js';

// ── Constants ────────────────────────────────────────────────────

/** Default max tokens for user context. From spec: "bounded to max 500 tokens" */
const DEFAULT_MAX_CONTEXT_TOKENS = 500;

/** Rough chars-per-token estimate for English text */
const CHARS_PER_TOKEN = 4;

// ── Context Builder ──────────────────────────────────────────────

/**
 * Build a UserContextBlock from a UserProfile.
 * This is the structured representation — use formatUserContextForSession()
 * for the text that gets injected into the prompt.
 */
export function buildUserContextBlock(profile: UserProfile): UserContextBlock {
  const block: UserContextBlock = {
    name: profile.name,
    userId: profile.id,
    permissions: [...profile.permissions],
  };

  // Preferences (only include non-empty)
  const prefs: UserContextBlock['preferences'] = {};
  if (profile.preferences.style) prefs.style = profile.preferences.style;
  if (profile.preferences.autonomyLevel) prefs.autonomyLevel = profile.preferences.autonomyLevel;
  if (profile.preferences.timezone) prefs.timezone = profile.preferences.timezone;
  if (Object.keys(prefs).length > 0) block.preferences = prefs;

  // Rich profile fields
  if (profile.bio) block.bio = profile.bio;
  if (profile.interests && profile.interests.length > 0) block.interests = [...profile.interests];
  if (profile.relationshipContext) block.relationshipContext = profile.relationshipContext;
  if (profile.context) block.context = profile.context;
  if (profile.customFields && Object.keys(profile.customFields).length > 0) {
    block.customFields = { ...profile.customFields };
  }

  return block;
}

/**
 * Format a UserProfile into a text block for session prompt injection.
 *
 * The output is structured text that the LLM reads but CANNOT override.
 * Permissions are marked as [SYSTEM-ENFORCED] to signal they are not negotiable.
 *
 * Respects maxContextTokens budget via truncation of lower-priority fields.
 */
export function formatUserContextForSession(
  profile: UserProfile,
  opts?: {
    maxContextTokens?: number;
    onboardingConfig?: OnboardingConfig;
  },
): string {
  const maxTokens = opts?.onboardingConfig?.maxContextTokens
    ?? opts?.maxContextTokens
    ?? DEFAULT_MAX_CONTEXT_TOKENS;

  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // Build sections in priority order (highest first)
  const sections: string[] = [];

  // Section 1: Header + Permissions (ALWAYS included, highest priority)
  sections.push(`[USER CONTEXT — ${profile.name} (${profile.id})]`);
  sections.push(`[SYSTEM-ENFORCED PERMISSIONS: ${profile.permissions.join(', ')}]`);

  // Section 2: Preferences
  const prefParts: string[] = [];
  if (profile.preferences.style) prefParts.push(`Style: ${profile.preferences.style}`);
  if (profile.preferences.autonomyLevel) prefParts.push(`Autonomy: ${profile.preferences.autonomyLevel}`);
  if (profile.preferences.timezone) prefParts.push(`Timezone: ${profile.preferences.timezone}`);
  if (prefParts.length > 0) {
    sections.push(`Preferences: ${prefParts.join(' | ')}`);
  }

  // Section 3: Relationship context
  if (profile.relationshipContext) {
    sections.push(`Relationship: ${profile.relationshipContext}`);
  }

  // Section 4: Bio
  if (profile.bio) {
    sections.push(`Bio: ${profile.bio}`);
  }

  // Section 5: Interests
  if (profile.interests && profile.interests.length > 0) {
    sections.push(`Interests: ${profile.interests.join(', ')}`);
  }

  // Section 6: Custom fields
  if (profile.customFields && Object.keys(profile.customFields).length > 0) {
    const fieldParts = Object.entries(profile.customFields)
      .map(([k, v]) => `${k}: ${v}`);
    sections.push(`Profile: ${fieldParts.join(' | ')}`);
  }

  // Section 7: Interaction history summary (lowest priority, gets truncated first)
  if (profile.context) {
    sections.push(`History: ${profile.context}`);
  }

  // Assemble and enforce budget
  let result = sections.join('\n');

  if (result.length > maxChars) {
    result = truncateToTokenBudget(sections, maxChars);
  }

  return result;
}

/**
 * Check whether a profile has enough data to warrant context injection.
 * Returns false for truly empty profiles (only name + default permissions).
 */
export function hasUserContext(profile: UserProfile): boolean {
  return !!(
    profile.preferences.style ||
    profile.preferences.timezone ||
    profile.preferences.autonomyLevel !== 'confirm-destructive' ||
    profile.bio ||
    (profile.interests && profile.interests.length > 0) ||
    profile.relationshipContext ||
    profile.context ||
    (profile.customFields && Object.keys(profile.customFields).length > 0) ||
    profile.permissions.includes('admin')
  );
}

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Truncate sections to fit within a character budget.
 * Removes lowest-priority sections first (from the end),
 * then truncates the last remaining section if still over budget.
 */
function truncateToTokenBudget(sections: string[], maxChars: number): string {
  // Always keep at least the header (first 2 sections: name + permissions)
  const minSections = 2;

  // Try including sections from highest to lowest priority
  let result = '';
  let includedCount = 0;

  for (let i = 0; i < sections.length; i++) {
    const candidate = i === 0
      ? sections[0]
      : result + '\n' + sections[i];

    if (candidate.length <= maxChars) {
      result = candidate;
      includedCount = i + 1;
    } else if (i < minSections) {
      // Header sections must be included — truncate if necessary
      result = candidate.slice(0, maxChars);
      includedCount = i + 1;
    } else {
      // This section would exceed budget — try truncating it
      const remaining = maxChars - result.length - 1; // -1 for newline
      if (remaining > 20) {
        // Enough room for a meaningful truncation
        result += '\n' + sections[i].slice(0, remaining - 3) + '...';
      }
      break;
    }
  }

  return result;
}
