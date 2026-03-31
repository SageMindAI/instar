/**
 * Post-Update Migrator — the "intelligence download" layer.
 *
 * When an agent installs a new version of instar, updating the npm
 * package only changes the server code. But the agent's local awareness
 * lives in project files: CLAUDE.md, hooks, scripts.
 *
 * This migrator bridges that gap. After every successful update, it:
 *   1. Re-installs hooks with the latest templates (behavioral upgrades)
 *   2. Patches CLAUDE.md with any new sections (awareness upgrades)
 *   3. Installs any new scripts (capability upgrades)
 *   4. Returns a human-readable migration report
 *
 * Design principles:
 *   - Additive only: never remove or modify existing user customizations
 *   - Hooks are overwritten (they're generated infrastructure, not user-edited)
 *   - CLAUDE.md sections are appended only if missing (check by heading)
 *   - Scripts are installed only if missing (never overwrite user modifications)
 */
export interface MigrationResult {
    /** What was upgraded */
    upgraded: string[];
    /** What was already up to date */
    skipped: string[];
    /** Any errors that occurred (non-fatal) */
    errors: string[];
}
export interface MigratorConfig {
    projectDir: string;
    stateDir: string;
    port: number;
    hasTelegram: boolean;
    projectName: string;
}
export declare class PostUpdateMigrator {
    private config;
    constructor(config: MigratorConfig);
    /**
     * Run all post-update migrations. Safe to call multiple times —
     * each migration is idempotent.
     */
    migrate(): MigrationResult;
    /**
     * Re-install hooks with the latest templates.
     * Built-in hooks in instar/ are always overwritten.
     * Custom hooks in custom/ are never touched.
     */
    private migrateHooks;
    /**
     * Migrate hooks from flat .instar/hooks/ layout to .instar/hooks/instar/ subdirectory.
     * Detects agent-modified built-in hooks by comparing content hashes and moves them
     * to .instar/hooks/custom/ with provenance 'inherited'.
     */
    private migrateHookLayout;
    /**
     * Migrate settings.json hook command paths from .instar/hooks/X to .instar/hooks/instar/X.
     * This handles the transition for agents that already have hooks configured.
     */
    private migrateSettingsHookPaths;
    /**
     * Migrate HTTP hook URLs to include INSTAR_SESSION_ID query parameter.
     * This enables the server to map Claude Code's session_id to the instar session,
     * which is required for subagent-aware zombie cleanup (prevents killing sessions
     * that are waiting for subagent results).
     *
     * Finds HTTP hooks with URLs ending in /hooks/events (no query params) and
     * appends ?instar_sid=${INSTAR_SESSION_ID}. Also adds INSTAR_SESSION_ID to
     * allowedEnvVars if missing.
     */
    private migrateHttpHookSessionId;
    /**
     * Ensure HTTP hooks from the template exist in settings.json.
     * Previous migrations only patched existing HTTP hooks (adding instar_sid param)
     * but never added them from scratch. Agents initialized before HTTP hooks were
     * introduced have no HTTP hooks at all, causing claudeSessionId to never be
     * populated — which breaks session resume (falls back to mtime cross-contamination).
     */
    private ensureHttpHooksExist;
    /**
     * Ensure PermissionRequest auto-approve hook exists in settings.json.
     * Subagents spawned via the Agent tool don't inherit --dangerously-skip-permissions,
     * so without this catch-all hook they prompt for every tool use and block jobs.
     * Real safety is in PreToolUse hooks — permission prompts are duplicative friction.
     */
    private ensurePermissionAutoApprove;
    /**
     * Ensure autonomous stop hook is registered and the skill files are deployed.
     * This is the structural enforcement for /autonomous mode — without it,
     * sessions exit normally after each response instead of looping on the task list.
     */
    private ensureAutonomousStopHook;
    /**
     * Replace HTTP hooks with command hooks that use hook-event-reporter.js.
     * Claude Code HTTP hooks (type: "http") silently fail to fire as of v2.1.78.
     * This migration converts them to command hooks which reliably fire.
     * Also installs the hook-event-reporter.js script if missing.
     */
    private migrateHttpHooksToCommandHooks;
    private getHookEventReporterScript;
    /**
     * Patch CLAUDE.md with any new sections that don't exist yet.
     * Only adds — never modifies or removes existing content.
     */
    private migrateClaudeMd;
    /**
     * Install any new scripts that don't exist yet.
     * Never overwrites existing scripts (user may have customized them).
     */
    private migrateScripts;
    /**
     * Ensure .claude/settings.json has required MCP servers and correct hook wiring.
     * Migrates legacy PostToolUse/Notification hooks to proper SessionStart type.
     */
    private migrateSettings;
    /**
     * Migrate the agent's config.json with sensible defaults for new features.
     * Only adds missing fields — never overwrites existing user customizations.
     */
    private migrateConfig;
    /**
     * Fix gitignore entries that shouldn't exclude shared state.
     * Removes relationships/ from gitignore so multi-machine agents share awareness.
     */
    /**
     * Generate self-knowledge tree for agents that don't have one.
     * Uses managed/unmanaged merge if one already exists.
     */
    private migrateSelfKnowledgeTree;
    private migrateGitignore;
    private removeGitignoreEntry;
    /**
     * Opt-in soul.md migration for existing agents.
     * Does NOT auto-create soul.md — adds config flag and queues notification.
     */
    private migrateSoulMd;
    /**
     * Add Self-Observations and Identity History sections to existing AGENT.md.
     */
    private migrateAgentMdSections;
    /**
     * Get the content of a named hook template.
     * Used by init.ts to share canonical hook content without duplication.
     */
    getHookContent(name: 'session-start' | 'compaction-recovery' | 'external-operation-gate' | 'deferral-detector' | 'post-action-reflection' | 'external-communication-guard' | 'scope-coherence-collector' | 'scope-coherence-checkpoint' | 'claim-intercept' | 'claim-intercept-response' | 'telegram-topic-context' | 'response-review' | 'auto-approve-permissions'): string;
    /** Public accessor for grounding-before-messaging hook content (used by init.ts) */
    getGroundingBeforeMessagingPublic(): string;
    /** Public accessor for convergence-check script content (used by init.ts) */
    getConvergenceCheckPublic(): string;
    private getSessionStartHook;
    private getDangerousCommandGuard;
    private getGroundingBeforeMessaging;
    private getConvergenceCheckInline;
    private getTelegramTopicContextHook;
    private getCompactionRecovery;
    private getDeferralDetectorHook;
    private getPostActionReflectionHook;
    private getExternalCommunicationGuardHook;
    private getExternalOperationGateHook;
    private getTelegramReplyScript;
    private getHealthWatchdog;
    private getConvergenceCheck;
    private getScopeCoherenceCollectorHook;
    private getScopeCoherenceCheckpointHook;
    private getFreeTextGuardHook;
    private getClaimInterceptHook;
    private getResponseReviewHook;
    private getClaimInterceptResponseHook;
    private getAutoApprovePermissionsHook;
}
//# sourceMappingURL=PostUpdateMigrator.d.ts.map