/**
 * Evolution Manager — the feedback loop that turns running into evolving.
 *
 * Four subsystems, one principle: every interaction is an opportunity
 * to improve. Not during batch reflection hours later, but at the
 * moment the insight is freshest.
 *
 * Subsystems:
 * 1. Evolution Queue — staged self-improvement proposals
 * 2. Learning Registry — structured, searchable insights
 * 3. Capability Gap Tracker — "what am I missing?"
 * 4. Action Queue — commitment tracking with stale detection
 *
 * Born from Portal's engagement pipeline (Steps 8-11) and proven
 * across 100+ evolution proposals and 10 platform engagement skills.
 */
import type { EvolutionProposal, EvolutionType, EvolutionStatus, LearningEntry, LearningSource, CapabilityGap, GapCategory, ActionItem, EvolutionManagerConfig } from './types.js';
import type { TrustElevationTracker } from './TrustElevationTracker.js';
import type { AutonomousEvolution, ReviewResult } from './AutonomousEvolution.js';
import type { AutonomyProfileManager } from './AutonomyProfileManager.js';
interface EvolutionState {
    proposals: EvolutionProposal[];
    stats: {
        totalProposals: number;
        byStatus: Record<string, number>;
        byType: Record<string, number>;
        lastUpdated: string;
    };
}
interface LearningState {
    learnings: LearningEntry[];
    stats: {
        totalLearnings: number;
        applied: number;
        pending: number;
        byCategory: Record<string, number>;
        lastUpdated: string;
    };
}
interface GapState {
    gaps: CapabilityGap[];
    stats: {
        totalGaps: number;
        bySeverity: Record<string, number>;
        byCategory: Record<string, number>;
        addressed: number;
        lastUpdated: string;
    };
}
interface ActionState {
    actions: ActionItem[];
    stats: {
        totalActions: number;
        pending: number;
        completed: number;
        overdue: number;
        lastUpdated: string;
    };
}
export declare class EvolutionManager {
    private stateDir;
    private config;
    private trustElevationTracker;
    private autonomousEvolution;
    private autonomyManager;
    constructor(config: EvolutionManagerConfig);
    /**
     * Wire adaptive autonomy modules for runtime integration.
     * - TrustElevationTracker: receives proposal approval/rejection events
     * - AutonomousEvolution: handles auto-implementation when in autonomous mode
     * - AutonomyProfileManager: provides current autonomy profile state
     */
    setAdaptiveAutonomyModules(modules: {
        trustElevationTracker?: TrustElevationTracker | null;
        autonomousEvolution?: AutonomousEvolution | null;
        autonomyManager?: AutonomyProfileManager | null;
    }): void;
    /**
     * Get the wired TrustElevationTracker (for external access, e.g. routes).
     */
    getTrustElevationTracker(): TrustElevationTracker | null;
    /**
     * Get the wired AutonomousEvolution module (for external access, e.g. routes).
     */
    getAutonomousEvolution(): AutonomousEvolution | null;
    private filePath;
    private readFile;
    private writeFile;
    private now;
    private loadEvolution;
    private saveEvolution;
    private nextProposalId;
    addProposal(opts: {
        title: string;
        source: string;
        description: string;
        type: EvolutionType;
        impact?: 'high' | 'medium' | 'low';
        effort?: 'high' | 'medium' | 'low';
        proposedBy?: string;
        tags?: string[];
    }): EvolutionProposal;
    updateProposalStatus(id: string, status: EvolutionStatus, resolution?: string): boolean;
    /**
     * Process a proposal through the autonomous evolution pipeline.
     * If in autonomous mode and the review approves with safe scope,
     * the proposal is auto-implemented via sidecar pattern.
     *
     * Returns the action taken, or null if autonomous modules aren't wired.
     */
    processProposalAutonomously(proposalId: string, review: ReviewResult): {
        action: string;
        reason: string;
    } | null;
    listProposals(filter?: {
        status?: EvolutionStatus;
        type?: EvolutionType;
    }): EvolutionProposal[];
    getEvolutionStats(): EvolutionState['stats'];
    private loadLearnings;
    private saveLearnings;
    private nextLearningId;
    addLearning(opts: {
        title: string;
        category: string;
        description: string;
        source: LearningSource;
        tags?: string[];
        evolutionRelevance?: string;
    }): LearningEntry;
    markLearningApplied(id: string, appliedTo: string): boolean;
    listLearnings(filter?: {
        category?: string;
        applied?: boolean;
    }): LearningEntry[];
    getLearningStats(): LearningState['stats'];
    private loadGaps;
    private saveGaps;
    private nextGapId;
    addGap(opts: {
        title: string;
        category: GapCategory;
        severity: 'critical' | 'high' | 'medium' | 'low';
        description: string;
        context: string;
        platform?: string;
        session?: string;
        currentState?: string;
        proposedSolution?: string;
    }): CapabilityGap;
    addressGap(id: string, resolution: string): boolean;
    listGaps(filter?: {
        severity?: string;
        category?: GapCategory;
        status?: string;
    }): CapabilityGap[];
    getGapStats(): GapState['stats'];
    private loadActions;
    private saveActions;
    private nextActionId;
    addAction(opts: {
        title: string;
        description: string;
        priority?: 'critical' | 'high' | 'medium' | 'low';
        commitTo?: string;
        dueBy?: string;
        source?: ActionItem['source'];
        tags?: string[];
    }): ActionItem;
    updateAction(id: string, updates: {
        status?: ActionItem['status'];
        resolution?: string;
    }): boolean;
    listActions(filter?: {
        status?: ActionItem['status'];
        priority?: string;
    }): ActionItem[];
    getOverdueActions(): ActionItem[];
    getActionStats(): ActionState['stats'];
    /**
     * Get a full dashboard of evolution health.
     * Useful for session-start orientation and status reporting.
     */
    getDashboard(): {
        evolution: EvolutionState['stats'];
        learnings: LearningState['stats'];
        gaps: GapState['stats'];
        actions: ActionState['stats'];
        highlights: string[];
    };
    /**
     * Detect gaps or proposals that may already be resolved by existing infrastructure.
     *
     * Scans open gaps and proposed items against:
     *   - Implemented proposals (already built)
     *   - Applied learnings (already absorbed)
     *   - Addressed gaps (already resolved)
     *
     * Returns items that appear to have implicit resolutions, with evidence.
     */
    detectImplicitEvolution(): Array<{
        type: 'gap' | 'proposal';
        id: string;
        title: string;
        matchedBy: {
            type: string;
            id: string;
            title: string;
            similarity: string;
        };
    }>;
    /**
     * Simple keyword overlap matching. Returns the best match if overlap
     * exceeds a threshold, or null if no match is strong enough.
     */
    private findKeywordMatch;
    /**
     * Extract meaningful keywords from text, filtering stop words.
     */
    private extractKeywords;
}
export {};
//# sourceMappingURL=EvolutionManager.d.ts.map