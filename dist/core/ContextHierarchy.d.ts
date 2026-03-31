/**
 * Context Hierarchy — Tiered context loading for efficient agent awareness.
 *
 * Inspired by Dawn's context dispatch system (PROP-088): right context at
 * the right moment > all context all the time.
 *
 * Three tiers:
 *   Tier 0: Always loaded (identity, project scope, safety rules)
 *   Tier 1: Session boundaries (continuity, compaction recovery, topic context)
 *   Tier 2: On-demand (task-specific depth when context matches)
 *
 * The hierarchy creates a `.instar/context/` directory with structured
 * segment files that hooks and sessions can load selectively.
 *
 * Born from the Luna incident (2026-02-25): An agent had no systematic
 * way to load task-relevant context efficiently. Without a hierarchy,
 * agents either load everything (context bloat) or nothing (incoherence).
 */
export interface ContextSegment {
    /** Unique identifier for this segment */
    id: string;
    /** Human-readable name */
    name: string;
    /** Context tier: 0 = always, 1 = session boundaries, 2 = on-demand */
    tier: 0 | 1 | 2;
    /** When to load this context (for tier 2) */
    triggers: string[];
    /** File path relative to .instar/context/ */
    file: string;
    /** Description of what this context provides */
    description: string;
}
export interface ContextHierarchyConfig {
    /** Instar state directory */
    stateDir: string;
    /** Project root directory */
    projectDir: string;
    /** Project name */
    projectName: string;
}
export interface ContextDispatchTable {
    /** When this task arises... */
    trigger: string;
    /** Load this context file */
    file: string;
    /** Why this context helps */
    reason: string;
}
export declare class ContextHierarchy {
    private config;
    private contextDir;
    constructor(config: ContextHierarchyConfig);
    /**
     * Initialize the context directory with default segment files.
     * Only creates files that don't already exist (additive only).
     */
    initialize(): {
        created: string[];
        skipped: string[];
    };
    /**
     * Get the dispatch table — a mapping of triggers to context files.
     * This is what agents read to know "when X happens, load Y."
     */
    getDispatchTable(): ContextDispatchTable[];
    /**
     * Write the dispatch table to a human-readable file.
     */
    writeDispatchTable(): void;
    /**
     * Load all segments for a given tier.
     * Returns concatenated content suitable for hook injection.
     */
    loadTier(tier: 0 | 1 | 2): string;
    /**
     * Load a specific context segment by ID.
     */
    loadSegment(segmentId: string): string | null;
    /**
     * List all context segments with their status.
     */
    listSegments(): Array<ContextSegment & {
        exists: boolean;
        sizeBytes: number;
    }>;
    /**
     * Get the context directory path.
     */
    getContextDir(): string;
    private generateSegmentTemplate;
    private identityTemplate;
    private safetyTemplate;
    private projectTemplate;
    private sessionTemplate;
    private relationshipsTemplate;
    private developmentTemplate;
    private deploymentTemplate;
    private communicationTemplate;
    private architectureTemplate;
    private researchNavigationTemplate;
}
//# sourceMappingURL=ContextHierarchy.d.ts.map