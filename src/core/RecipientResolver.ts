/**
 * RecipientResolver — Resolves recipient context for review decisions.
 *
 * Queries RelationshipManager and AdaptiveTrust for known contacts and agents.
 * Extracts ONLY structured metadata (communicationStyle, significance, themes,
 * trustLevel, formality) — never free-text fields like notes or descriptions.
 *
 * Trust boundary: Fields allowed in reviewer prompts are strictly limited.
 * See RecipientContext for the full allow-list.
 */

export interface RecipientContext {
  recipientType: 'primary-user' | 'secondary-user' | 'agent' | 'external-contact';
  /** Communication style preference (formal, casual, technical) */
  communicationStyle?: string;
  /** Relationship significance (high, medium, low) */
  significance?: string;
  /** Recurring conversation themes */
  themes?: string[];
  /** Trust level for agent recipients */
  trustLevel?: string;
  /** Formality preference */
  formality?: string;
}

export interface RecipientResolverOptions {
  stateDir: string;
  relationships?: {
    getContextForPerson(id: string): string | null;
  } | null;
  adaptiveTrust?: {
    getProfile(): any;
  } | null;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Extract the text content of an XML-like tag from a string. */
function extractTag(xml: string, tagName: string): string | null {
  // Tags in RelationshipManager context use "Key: value" format on separate lines,
  // not actual XML elements. e.g. "Communication style: casual"
  const pattern = new RegExp(`^${escapeRegExp(tagName)}:\\s*(.+)$`, 'mi');
  const match = xml.match(pattern);
  return match ? match[1].trim() : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Map a numeric significance (1-10) to a human-readable level. */
function significanceLevel(numStr: string): string {
  const n = parseInt(numStr, 10);
  if (Number.isNaN(n)) return 'medium';
  if (n >= 7) return 'high';
  if (n >= 4) return 'medium';
  return 'low';
}

/** Map a trust floor string to a simple trust level label. */
function trustFloorToLevel(floor: string): string {
  if (floor === 'supervised') return 'supervised';
  if (floor === 'collaborative') return 'collaborative';
  return 'untrusted';
}

// ── Default contexts per recipient type ────────────────────────────

const DEFAULTS: Record<string, Omit<RecipientContext, 'recipientType'>> = {
  'primary-user': { communicationStyle: 'conversational', significance: 'high' },
  'secondary-user': { communicationStyle: 'professional', significance: 'medium' },
  'agent': { communicationStyle: 'technical', trustLevel: 'untrusted' },
  'external-contact': { communicationStyle: 'professional', significance: 'low', formality: 'high' },
};

// ── Implementation ─────────────────────────────────────────────────

export class RecipientResolver {
  private options: RecipientResolverOptions;

  constructor(options: RecipientResolverOptions) {
    this.options = options;
  }

  /**
   * Resolve recipient context for a given recipient.
   *
   * If recipientId is provided and a RelationshipManager is available,
   * queries for structured metadata. Otherwise returns conservative defaults
   * based on recipientType.
   */
  resolve(recipientId?: string, recipientType?: string): RecipientContext {
    const type = (recipientType ?? 'external-contact') as RecipientContext['recipientType'];
    const defaults = DEFAULTS[type] ?? DEFAULTS['external-contact'];
    const base: RecipientContext = { recipientType: type, ...defaults };

    // Attempt to enrich from RelationshipManager
    if (recipientId && this.options.relationships) {
      const xmlContext = this.options.relationships.getContextForPerson(recipientId);
      if (xmlContext) {
        return this.parseRelationshipContext(xmlContext, base);
      }
    }

    // For agent recipients, attempt to resolve trust level from AdaptiveTrust
    if (type === 'agent' && this.options.adaptiveTrust) {
      const trustLevel = this.resolveTrustLevel();
      if (trustLevel) {
        base.trustLevel = trustLevel;
      }
    }

    return base;
  }

  /**
   * Parse the XML context string from RelationshipManager.
   * Extracts ONLY structured metadata — never free-text fields.
   */
  private parseRelationshipContext(xml: string, base: RecipientContext): RecipientContext {
    const result: RecipientContext = { recipientType: base.recipientType };

    // Communication style
    const commStyle = extractTag(xml, 'Communication style');
    result.communicationStyle = commStyle ?? base.communicationStyle;

    // Significance (numeric → high/medium/low)
    const sigRaw = extractTag(xml, 'Significance');
    if (sigRaw) {
      // Format is "N/10" — extract the number
      const numMatch = sigRaw.match(/^(\d+)/);
      result.significance = numMatch ? significanceLevel(numMatch[1]) : base.significance;
    } else {
      result.significance = base.significance;
    }

    // Themes
    const themesRaw = extractTag(xml, 'Key themes');
    if (themesRaw) {
      result.themes = themesRaw.split(',').map((t) => t.trim()).filter(Boolean);
    }

    // Formality — infer from communication style if not explicit
    if (result.communicationStyle) {
      const style = result.communicationStyle.toLowerCase();
      if (style === 'formal' || style === 'professional') {
        result.formality = 'high';
      } else if (style === 'casual' || style === 'conversational') {
        result.formality = 'low';
      }
    }

    // For agent recipients, also resolve trust level
    if (base.recipientType === 'agent' && this.options.adaptiveTrust) {
      const trustLevel = this.resolveTrustLevel();
      if (trustLevel) {
        result.trustLevel = trustLevel;
      }
    }

    return result;
  }

  /**
   * Resolve trust level from AdaptiveTrust profile.
   */
  private resolveTrustLevel(): string | null {
    if (!this.options.adaptiveTrust) return null;

    try {
      const profile = this.options.adaptiveTrust.getProfile();
      if (profile?.global?.floor) {
        return trustFloorToLevel(profile.global.floor);
      }
    } catch {
      // Trust resolution failure should not break recipient resolution
    }

    return null;
  }
}
