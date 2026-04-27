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
 *   4. Deploys missing built-in skills (exec:skill job support)
 *   5. Returns a human-readable migration report
 *
 * Design principles:
 *   - Additive only: never remove or modify existing user customizations
 *   - Hooks are overwritten (they're generated infrastructure, not user-edited)
 *   - CLAUDE.md sections are appended only if missing (check by heading)
 *   - Scripts are installed only if missing (never overwrite user modifications)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TreeGenerator } from '../knowledge/TreeGenerator.js';
import { HTTP_HOOK_TEMPLATES, buildHttpHookSettings } from '../data/http-hook-templates.js';
import { getMigrationDefaults, applyDefaults } from '../config/ConfigDefaults.js';
import { installBuiltinSkills } from '../commands/init.js';
import {
  ELIGIBILITY_SCHEMA_SQL,
  ELIGIBILITY_SCHEMA_SQL_SHA256,
  PUSH_GATE_SH,
  PUSH_GATE_SH_SHA256,
  INSTAR_PR_GATE_WORKFLOW_YML,
  INSTAR_PR_GATE_WORKFLOW_YML_SHA256,
  PR_GATE_SETUP_MD,
  PR_GATE_SETUP_MD_SHA256,
} from '../data/pr-gate-artifacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

export class PostUpdateMigrator {
  private config: MigratorConfig;

  constructor(config: MigratorConfig) {
    this.config = config;
  }

  /**
   * Run all post-update migrations. Safe to call multiple times —
   * each migration is idempotent.
   */
  migrate(): MigrationResult {
    const result: MigrationResult = {
      upgraded: [],
      skipped: [],
      errors: [],
    };

    this.migrateHooks(result);
    this.migrateClaudeMd(result);
    this.migrateScripts(result);
    this.migrateSettings(result);
    this.migrateConfig(result);
    this.migratePrPipelineArtifacts(result);
    this.migrateBackupManifest(result);
    this.migrateGitignore(result);
    this.migrateBuiltinSkills(result);
    this.migrateSkillPortHardcoding(result);
    this.migrateSelfKnowledgeTree(result);
    this.migrateSoulMd(result);
    this.migrateAgentMdSections(result);
    this.migrateContextDeathAntiPattern(result);

    return result;
  }

  // ── Context-death anti-pattern (PR1 — context-death-pitfall-
  //    prevention spec § (a)) ────────────────────────────────────────
  //
  // Injects the "Context-Death Self-Stop" anti-pattern marker block
  // into CLAUDE.md (under "Critical Anti-Patterns") and AGENT.md
  // (under "My Principles") when absent. Idempotent: if the marker
  // is already present, nothing happens. Honors .instar/identity-
  // pins.json — if an entry exists for the marker id, the block is
  // skipped (user has customized).
  //
  // The marker is a literal HTML comment pair:
  //   <!-- INSTAR:ANTI-PATTERN-CONTEXT-DEATH -->
  //   ...content...
  //   <!-- /INSTAR:ANTI-PATTERN-CONTEXT-DEATH -->
  //
  // Pin file format (local, agent-side only):
  //   { "INSTAR:ANTI-PATTERN-CONTEXT-DEATH": { "contentHash": "sha256...",
  //                                             "pinnedAt": "<ISO>" } }
  private migrateContextDeathAntiPattern(result: MigrationResult): void {
    const markerId = 'INSTAR:ANTI-PATTERN-CONTEXT-DEATH';
    const pins = this.readIdentityPins();

    if (pins[markerId]) {
      result.skipped.push(`${markerId}: pinned in .instar/identity-pins.json — skip`);
      return;
    }

    const claudeBlock = [
      `<!-- ${markerId} -->`,
      '**"Context-Death Self-Stop"** — Do not self-terminate mid-plan citing context preservation, context-window concerns, or "let\'s continue in a fresh session" when durable artifacts for the plan exist on disk (committed code, plan files, ledger rows). Compaction-recovery re-injects identity, memory, and recent context automatically; worst case is a ~30s re-read of the plan file. Legitimate stops: real design questions, missing information only the user can provide, genuine errors, completion. Context-preservation is NOT a legitimate stop reason on its own. If you catch yourself reaching for it, check the durable artifact instead and keep going.',
      `<!-- /${markerId} -->`,
    ].join('\n');

    const agentBlock = [
      `<!-- ${markerId} -->`,
      '**No context-death self-stops.** I do not self-terminate mid-plan citing context preservation, context-window concerns, or "let\'s continue in a fresh session" when durable artifacts (committed code, plan files, ledger rows) exist on disk. Compaction-recovery re-injects my identity, memory, and recent context automatically — worst case is a ~30s re-read of the plan file. Legitimate stops are real design questions, missing information only the user can provide, genuine errors, or completion. Context preservation is not a legitimate stop reason on its own. If I catch myself reaching for that rationalization, I verify the durable artifact exists and keep going.',
      `<!-- /${markerId} -->`,
    ].join('\n');

    // ── CLAUDE.md — insert inside "Critical Anti-Patterns" section ──
    const claudeMdPath = path.join(this.config.projectDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      try {
        let content = fs.readFileSync(claudeMdPath, 'utf-8');
        if (!content.includes(markerId)) {
          // Anchor: end of "Critical Anti-Patterns" (just before next
          // `## ` heading) — falls back to append if section absent.
          const antiPatternsIdx = content.indexOf('## Critical Anti-Patterns');
          if (antiPatternsIdx >= 0) {
            // Find the next top-level heading after Critical Anti-Patterns.
            const afterHeader = antiPatternsIdx + '## Critical Anti-Patterns'.length;
            const nextHeadingIdx = content.indexOf('\n## ', afterHeader);
            const insertAt = nextHeadingIdx >= 0 ? nextHeadingIdx : content.length;
            content = content.slice(0, insertAt) + '\n' + claudeBlock + '\n' + content.slice(insertAt);
          } else {
            content += '\n\n## Critical Anti-Patterns\n\n' + claudeBlock + '\n';
          }
          fs.writeFileSync(claudeMdPath, content);
          result.upgraded.push(`CLAUDE.md: added ${markerId} marker block`);
        } else {
          result.skipped.push(`CLAUDE.md: ${markerId} marker already present`);
        }
      } catch (err) {
        result.errors.push(`CLAUDE.md ${markerId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── AGENT.md — append the block inside "My Principles" section ──
    const agentMdPath = path.join(this.config.stateDir, 'AGENT.md');
    if (fs.existsSync(agentMdPath)) {
      try {
        let content = fs.readFileSync(agentMdPath, 'utf-8');
        if (!content.includes(markerId)) {
          const principlesIdx = content.indexOf('## My Principles');
          if (principlesIdx >= 0) {
            const afterHeader = principlesIdx + '## My Principles'.length;
            const nextHeadingIdx = content.indexOf('\n## ', afterHeader);
            const insertAt = nextHeadingIdx >= 0 ? nextHeadingIdx : content.length;
            content = content.slice(0, insertAt) + '\n' + agentBlock + '\n' + content.slice(insertAt);
          } else {
            content += '\n\n## My Principles\n\n' + agentBlock + '\n';
          }
          fs.writeFileSync(agentMdPath, content);
          result.upgraded.push(`AGENT.md: added ${markerId} marker block`);
        } else {
          result.skipped.push(`AGENT.md: ${markerId} marker already present`);
        }
      } catch (err) {
        result.errors.push(`AGENT.md ${markerId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Read `.instar/identity-pins.json` if present. Returns an object
   * keyed by marker id; missing file or malformed JSON yields `{}`
   * (soft-fail — a broken pin file shouldn't block every migration).
   */
  private readIdentityPins(): Record<string, { contentHash?: string; pinnedAt?: string }> {
    const pinsPath = path.join(this.config.stateDir, 'identity-pins.json');
    if (!fs.existsSync(pinsPath)) return {};
    try {
      const raw = fs.readFileSync(pinsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
      return {};
    } catch {
      return {};
    }
  }

  /**
   * Upgrade built-in skills that hardcoded a localhost port at install time
   * to use a runtime-expandable ${INSTAR_PORT:-PORT} pattern.
   *
   * Background: installBuiltinSkills used to template the port at install.
   * Users who later changed their server port ended up with stale URLs in
   * their skills. This migration rewrites `http://localhost:NNNN/` to
   * `http://localhost:${INSTAR_PORT:-NNNN}/` in the known-default skill set.
   *
   * Idempotent: skips files that already use the dynamic pattern.
   * Scoped: only touches skills from the installBuiltinSkills set — custom
   * skills are never modified.
   */
  private migrateSkillPortHardcoding(result: MigrationResult): void {
    const defaultSkills = [
      'evolve', 'learn', 'gaps', 'commit-action', 'feedback',
      'triage-findings', 'reflect', 'coherence-audit', 'degradation-digest',
      'state-integrity-check', 'memory-hygiene', 'guardian-pulse',
      'session-continuity-check', 'git-sync',
    ];
    const skillsDir = path.join(this.config.projectDir, '.claude', 'skills');
    const hardcodedRe = /http:\/\/localhost:(\d+)\//g;
    const dynamicMarker = '${INSTAR_PORT:-';

    for (const name of defaultSkills) {
      const skillFile = path.join(skillsDir, name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      try {
        const original = fs.readFileSync(skillFile, 'utf8');
        if (original.includes(dynamicMarker)) continue;
        if (!hardcodedRe.test(original)) continue;
        hardcodedRe.lastIndex = 0;
        const updated = original.replace(hardcodedRe, (_m, p) => `http://localhost:\${INSTAR_PORT:-${p}}/`);
        if (updated !== original) {
          fs.writeFileSync(skillFile, updated);
          result.upgraded.push(`skills/${name}/SKILL.md (hardcoded port -> \${INSTAR_PORT:-NNNN})`);
        }
      } catch (err) {
        result.errors.push(`skills/${name}/SKILL.md port migration: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Deploy any missing built-in skills (e.g., guardian job skills added after initial setup).
   * Non-destructive — only writes SKILL.md files that don't already exist.
   */
  private migrateBuiltinSkills(result: MigrationResult): void {
    try {
      const skillsDir = path.join(this.config.projectDir, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      installBuiltinSkills(skillsDir, this.config.port);
      result.skipped.push('built-in skills: checked (non-destructive)');
    } catch (err) {
      result.errors.push(`built-in skills: ${err}`);
    }
  }

  /**
   * Re-install hooks with the latest templates.
   * Built-in hooks in instar/ are always overwritten.
   * Custom hooks in custom/ are never touched.
   */
  private migrateHooks(result: MigrationResult): void {
    const hooksDir = path.join(this.config.stateDir, 'hooks');
    const instarHooksDir = path.join(hooksDir, 'instar');
    const customHooksDir = path.join(hooksDir, 'custom');
    fs.mkdirSync(instarHooksDir, { recursive: true });
    fs.mkdirSync(customHooksDir, { recursive: true });

    // Migrate from flat layout to directory layout if needed
    this.migrateHookLayout(hooksDir, instarHooksDir, result);

    try {
      // Session start hook — the most important one for self-discovery
      fs.writeFileSync(path.join(instarHooksDir, 'session-start.sh'), this.getSessionStartHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/session-start.sh (capability awareness)');
    } catch (err) {
      result.errors.push(`session-start.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'dangerous-command-guard.sh'), this.getDangerousCommandGuard(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/dangerous-command-guard.sh');
    } catch (err) {
      result.errors.push(`dangerous-command-guard.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'grounding-before-messaging.sh'), this.getGroundingBeforeMessaging(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/grounding-before-messaging.sh');
    } catch (err) {
      result.errors.push(`grounding-before-messaging.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'compaction-recovery.sh'), this.getCompactionRecovery(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/compaction-recovery.sh');
    } catch (err) {
      result.errors.push(`compaction-recovery.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'telegram-topic-context.sh'), this.getTelegramTopicContextHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/telegram-topic-context.sh (per-message unanswered detection)');
    } catch (err) {
      result.errors.push(`telegram-topic-context.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'external-operation-gate.js'), this.getExternalOperationGateHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/external-operation-gate.js (MCP tool safety gate)');
    } catch (err) {
      result.errors.push(`external-operation-gate.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'deferral-detector.js'), this.getDeferralDetectorHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/deferral-detector.js (anti-deferral checklist)');
    } catch (err) {
      result.errors.push(`deferral-detector.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'post-action-reflection.js'), this.getPostActionReflectionHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/post-action-reflection.js (evolution awareness)');
    } catch (err) {
      result.errors.push(`post-action-reflection.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'external-communication-guard.js'), this.getExternalCommunicationGuardHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/external-communication-guard.js (identity grounding)');
    } catch (err) {
      result.errors.push(`external-communication-guard.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'scope-coherence-collector.js'), this.getScopeCoherenceCollectorHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/scope-coherence-collector.js (implementation depth tracking)');
    } catch (err) {
      result.errors.push(`scope-coherence-collector.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'scope-coherence-checkpoint.js'), this.getScopeCoherenceCheckpointHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/scope-coherence-checkpoint.js (scope zoom-out checkpoint)');
    } catch (err) {
      result.errors.push(`scope-coherence-checkpoint.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'free-text-guard.sh'), this.getFreeTextGuardHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/free-text-guard.sh (blocks AskUserQuestion for passwords/credentials)');
    } catch (err) {
      result.errors.push(`free-text-guard.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'claim-intercept.js'), this.getClaimInterceptHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/claim-intercept.js (false claim detection on tool output)');
    } catch (err) {
      result.errors.push(`claim-intercept.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'claim-intercept-response.js'), this.getClaimInterceptResponseHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/claim-intercept-response.js (false claim detection on responses)');
    } catch (err) {
      result.errors.push(`claim-intercept-response.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'response-review.js'), this.getResponseReviewHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/response-review.js (coherence gate response review pipeline)');
    } catch (err) {
      result.errors.push(`response-review.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'auto-approve-permissions.js'), this.getAutoApprovePermissionsHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/auto-approve-permissions.js (subagent permission unblocking)');
    } catch (err) {
      result.errors.push(`auto-approve-permissions.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'skill-usage-telemetry.sh'), this.getSkillUsageTelemetryHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/skill-usage-telemetry.sh (skill invocation tracking)');
    } catch (err) {
      result.errors.push(`skill-usage-telemetry.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Build stop hook — structural enforcement for /build pipeline.
    // Previously only installed once by init.ts, so existing agents that initialized
    // before it was added never received the file, yet settings.json references it
    // (registered by the /build skill). Result: silent "No such file or directory"
    // errors on every Stop event. Overwrite on every upgrade to match the pattern
    // used for every other instar-owned hook.
    try {
      fs.writeFileSync(path.join(instarHooksDir, 'build-stop-hook.sh'), this.getBuildStopHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/build-stop-hook.sh (/build pipeline structural enforcement)');
    } catch (err) {
      result.errors.push(`build-stop-hook.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Hook event reporter — always overwrite (built-in infrastructure).
    // Previously only installed-if-missing by migrateHttpHooksToCommandHooks, which left
    // agents stuck on a broken template (the old template used CommonJS `require('http')`,
    // which throws in ESM hosts where package.json has "type": "module").
    try {
      fs.writeFileSync(path.join(instarHooksDir, 'hook-event-reporter.js'), this.getHookEventReporterScript(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/hook-event-reporter.js (ESM-compatible http import)');
    } catch (err) {
      result.errors.push(`hook-event-reporter.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Validate settings.json hook references exist on disk. Structural invariant:
    // every `command:` in settings.json hooks that resolves to a file under
    // .instar/hooks/ must exist, otherwise every firing of that hook emits
    // "No such file or directory" with no user-facing signal.
    this.validateHookReferences(hooksDir, result);
  }

  /**
   * Scan .claude/settings.json for hook `command:` entries that reference files
   * under the instar hooks tree, and report any that don't exist on disk.
   *
   * Structural invariant check — runs at upgrade time, emits into result.errors
   * so the upgrade log surfaces the drift. Not fatal: unknown hooks may be
   * agent-custom (lives under .instar/hooks/custom/) and we don't want to wedge
   * an upgrade on a reference we don't own.
   */
  validateHookReferences(hooksDir: string, result: MigrationResult): void {
    const settingsPath = path.join(this.config.projectDir, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return;

    let settings: unknown;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (err) {
      result.errors.push(`settings.json parse (hook-reference validation): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const hooksSection = (settings as { hooks?: Record<string, unknown> }).hooks;
    if (!hooksSection || typeof hooksSection !== 'object') return;

    const missing: string[] = [];
    for (const [event, entries] of Object.entries(hooksSection)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries as Array<{ hooks?: Array<{ command?: string }> }>) {
        const hookList = Array.isArray(entry?.hooks) ? entry.hooks : [];
        for (const hook of hookList) {
          const cmd = typeof hook?.command === 'string' ? hook.command : '';
          if (!cmd) continue;
          // Extract a path that looks like `.instar/hooks/...` from the command.
          // Matches bash .instar/hooks/instar/foo.sh, node .instar/hooks/instar/foo.js,
          // or any direct reference to a file path under the hooks tree. Custom hooks
          // live under .instar/hooks/custom/ and are skipped — the agent owns them.
          const match = cmd.match(/(?:^|\s)(\.instar\/hooks\/instar\/[^\s"]+)/);
          if (!match) continue;
          const relPath = match[1];
          const abs = path.join(this.config.projectDir, relPath);
          if (!fs.existsSync(abs)) {
            missing.push(`${event}: ${relPath} (referenced in settings.json, not found on disk)`);
          }
        }
      }
    }

    if (missing.length > 0) {
      for (const m of missing) {
        result.errors.push(`hook-reference-missing — ${m}`);
      }
    }
  }

  /**
   * Migrate hooks from flat .instar/hooks/ layout to .instar/hooks/instar/ subdirectory.
   * Detects agent-modified built-in hooks by comparing content hashes and moves them
   * to .instar/hooks/custom/ with provenance 'inherited'.
   */
  private migrateHookLayout(hooksDir: string, instarHooksDir: string, result: MigrationResult): void {
    // List of known built-in hook filenames
    const builtinHooks = [
      'session-start.sh', 'dangerous-command-guard.sh', 'grounding-before-messaging.sh',
      'compaction-recovery.sh', 'external-operation-gate.js', 'deferral-detector.js',
      'post-action-reflection.js', 'external-communication-guard.js',
      'scope-coherence-collector.js', 'scope-coherence-checkpoint.js',
      'instructions-loaded-tracker.js', 'subagent-start-tracker.js',
      'free-text-guard.sh', 'claim-intercept.js', 'claim-intercept-response.js', 'response-review.js',
      'auto-approve-permissions.js',
    ];

    // Check if we're still on the old flat layout (hooks directly in .instar/hooks/)
    const hasOldLayout = builtinHooks.some(name => {
      const oldPath = path.join(hooksDir, name);
      return fs.existsSync(oldPath) && !fs.statSync(oldPath).isDirectory();
    });

    if (!hasOldLayout) return;

    // Already migrated or fresh install — instar/ dir has the hooks
    if (fs.existsSync(path.join(instarHooksDir, 'session-start.sh'))) return;

    const customHooksDir = path.join(hooksDir, 'custom');

    for (const hookName of builtinHooks) {
      const oldPath = path.join(hooksDir, hookName);
      if (!fs.existsSync(oldPath)) continue;

      try {
        // Move built-in hooks to instar/ — they'll be overwritten by the current
        // migrateHooks() call anyway, but cleaning up the old location is important
        // safe-git-allow: incremental-migration
        fs.unlinkSync(oldPath);
      } catch {
        // If we can't remove, it's not critical — the new hooks will be written
        // to instar/ regardless
      }
    }

    // Check for any non-builtin hooks in the old flat directory (agent-created)
    try {
      const remaining = fs.readdirSync(hooksDir).filter(name => {
        const fullPath = path.join(hooksDir, name);
        return !fs.statSync(fullPath).isDirectory() && !builtinHooks.includes(name);
      });

      for (const customHook of remaining) {
        const oldPath = path.join(hooksDir, customHook);
        const newPath = path.join(customHooksDir, customHook);
        try {
          fs.renameSync(oldPath, newPath);
          result.upgraded.push(`hooks: migrated custom hook ${customHook} to hooks/custom/`);
        } catch (err) {
          result.errors.push(`hook migration ${customHook}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch {
      // Directory read failed — not critical
    }

    result.upgraded.push('hooks: migrated from flat layout to instar/custom/ directory structure');
  }

  /**
   * Migrate settings.json hook command paths from .instar/hooks/X to .instar/hooks/instar/X.
   * This handles the transition for agents that already have hooks configured.
   */
  private migrateSettingsHookPaths(hookEntries: unknown[], result: MigrationResult): void {
    const oldPrefix = '.instar/hooks/';
    const newPrefix = '.instar/hooks/instar/';

    for (const entry of hookEntries) {
      if (typeof entry !== 'object' || entry === null) continue;

      // Handle entries with nested hooks arrays (matcher-based entries)
      const entryObj = entry as Record<string, unknown>;
      if (Array.isArray(entryObj.hooks)) {
        for (const hook of entryObj.hooks) {
          if (typeof hook === 'object' && hook !== null) {
            const hookObj = hook as Record<string, unknown>;
            if (typeof hookObj.command === 'string') {
              const cmd = hookObj.command;
              // Only migrate paths that point to flat layout (not already in instar/ or custom/)
              if (cmd.includes(oldPrefix) && !cmd.includes(newPrefix) && !cmd.includes('.instar/hooks/custom/')) {
                hookObj.command = cmd.replace(oldPrefix, newPrefix);
              }
            }
          }
        }
      }

      // Handle direct hook entries (not nested)
      if (typeof entryObj.command === 'string') {
        const cmd = entryObj.command;
        if (cmd.includes(oldPrefix) && !cmd.includes(newPrefix) && !cmd.includes('.instar/hooks/custom/')) {
          entryObj.command = cmd.replace(oldPrefix, newPrefix);
        }
      }
    }
  }

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
  private migrateHttpHookSessionId(
    hooks: Record<string, unknown[]>,
    result: MigrationResult,
  ): boolean {
    let patched = false;

    for (const hookEntries of Object.values(hooks)) {
      if (!Array.isArray(hookEntries)) continue;

      for (const entry of hookEntries) {
        if (typeof entry !== 'object' || entry === null) continue;
        const entryObj = entry as Record<string, unknown>;

        // Handle entries with nested hooks arrays (matcher-based entries)
        if (Array.isArray(entryObj.hooks)) {
          for (const hook of entryObj.hooks) {
            if (typeof hook !== 'object' || hook === null) continue;
            const hookObj = hook as Record<string, unknown>;

            if (hookObj.type !== 'http' || typeof hookObj.url !== 'string') continue;

            // Update URL: add ?instar_sid= if the URL hits /hooks/events without it
            if (hookObj.url.includes('/hooks/events') && !hookObj.url.includes('instar_sid')) {
              hookObj.url = hookObj.url.replace(
                '/hooks/events',
                '/hooks/events?instar_sid=${INSTAR_SESSION_ID}',
              );
              patched = true;
            }

            // Add INSTAR_SESSION_ID to allowedEnvVars if missing
            if (Array.isArray(hookObj.allowedEnvVars)) {
              const envVars = hookObj.allowedEnvVars as string[];
              if (!envVars.includes('INSTAR_SESSION_ID')) {
                envVars.push('INSTAR_SESSION_ID');
                patched = true;
              }
            }
          }
        }

        // Handle direct hook entries (not nested)
        if (entryObj.type === 'http' && typeof entryObj.url === 'string') {
          if (entryObj.url.includes('/hooks/events') && !entryObj.url.includes('instar_sid')) {
            entryObj.url = (entryObj.url as string).replace(
              '/hooks/events',
              '/hooks/events?instar_sid=${INSTAR_SESSION_ID}',
            );
            patched = true;
          }
          if (Array.isArray(entryObj.allowedEnvVars)) {
            const envVars = entryObj.allowedEnvVars as string[];
            if (!envVars.includes('INSTAR_SESSION_ID')) {
              envVars.push('INSTAR_SESSION_ID');
              patched = true;
            }
          }
        }
      }
    }

    if (patched) {
      result.upgraded.push('.claude/settings.json: added INSTAR_SESSION_ID to HTTP hook URLs (subagent-aware zombie cleanup)');
    }

    return patched;
  }

  /**
   * Ensure HTTP hooks from the template exist in settings.json.
   * Previous migrations only patched existing HTTP hooks (adding instar_sid param)
   * but never added them from scratch. Agents initialized before HTTP hooks were
   * introduced have no HTTP hooks at all, causing claudeSessionId to never be
   * populated — which breaks session resume (falls back to mtime cross-contamination).
   */
  private ensureHttpHooksExist(
    hooks: Record<string, unknown[]>,
    result: MigrationResult,
  ): boolean {
    const serverUrl = `http://localhost:${this.config.port}`;

    // Check if ANY event reporter hook already exists (HTTP or command-based)
    const hasEventReporterHook = Object.values(hooks).some(entries => {
      if (!Array.isArray(entries)) return false;
      return entries.some(entry => {
        if (typeof entry !== 'object' || entry === null) return false;
        const e = entry as Record<string, unknown>;
        if (Array.isArray(e.hooks)) {
          return (e.hooks as Array<Record<string, unknown>>).some(h => {
            // Check for command hook (new style)
            if (h.type === 'command' && typeof h.command === 'string' && (h.command as string).includes('hook-event-reporter')) return true;
            // Check for HTTP hook (old style, with valid URL)
            if (h.type === 'http' && typeof h.url === 'string' && !(h.url as string).includes('${INSTAR_SERVER_URL}')) return true;
            return false;
          });
        }
        // Check direct entry
        if (e.type === 'command' && typeof e.command === 'string' && (e.command as string).includes('hook-event-reporter')) return true;
        if (e.type === 'http' && typeof e.url === 'string' && !(e.url as string).includes('${INSTAR_SERVER_URL}')) return true;
        return false;
      });
    });

    if (hasEventReporterHook) return false;

    // Remove any existing broken HTTP hooks (with unresolved template vars)
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      hooks[event] = entries.filter(entry => {
        if (typeof entry !== 'object' || entry === null) return true;
        const e = entry as Record<string, unknown>;
        if (Array.isArray(e.hooks)) {
          const hooksArr = e.hooks as Array<Record<string, unknown>>;
          return !hooksArr.some(h =>
            h.type === 'http' && typeof h.url === 'string' && (h.url as string).includes('${INSTAR_SERVER_URL}'),
          );
        }
        return !(e.type === 'http' && typeof e.url === 'string' && (e.url as string).includes('${INSTAR_SERVER_URL}'));
      });
      // Clean up empty arrays
      if ((hooks[event] as unknown[]).length === 0) {
        delete hooks[event];
      }
    }

    // Add HTTP hooks using the resolved localhost URL
    const httpHookSettings = buildHttpHookSettings(serverUrl);
    for (const [event, entries] of Object.entries(httpHookSettings)) {
      if (!hooks[event]) {
        hooks[event] = [];
      }
      (hooks[event] as unknown[]).push(...entries);
    }

    result.upgraded.push(
      `.claude/settings.json: added ${HTTP_HOOK_TEMPLATES.length} HTTP hooks for observability (url: ${serverUrl}/hooks/events)`,
    );
    return true;
  }

  /**
   * Ensure PermissionRequest auto-approve hook exists in settings.json.
   * Subagents spawned via the Agent tool don't inherit --dangerously-skip-permissions,
   * so without this catch-all hook they prompt for every tool use and block jobs.
   * Real safety is in PreToolUse hooks — permission prompts are duplicative friction.
   */
  private ensurePermissionAutoApprove(
    hooks: Record<string, unknown[]>,
    result: MigrationResult,
  ): boolean {
    // Check if PermissionRequest hook already exists
    if (hooks.PermissionRequest) {
      const entries = hooks.PermissionRequest as Array<{ hooks?: Array<{ command?: string }> }>;
      const hasAutoApprove = entries.some(e =>
        e.hooks?.some(h => h.command?.includes('auto-approve-permissions')),
      );
      if (hasAutoApprove) return false;
    }

    if (!hooks.PermissionRequest) {
      hooks.PermissionRequest = [];
    }

    (hooks.PermissionRequest as unknown[]).push({
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/auto-approve-permissions.js',
        timeout: 5000,
      }],
    });

    result.upgraded.push('.claude/settings.json: added PermissionRequest auto-approve (subagent unblocking)');
    return true;
  }

  /**
   * Ensure autonomous stop hook is registered and the skill files are deployed.
   * This is the structural enforcement for /autonomous mode — without it,
   * sessions exit normally after each response instead of looping on the task list.
   */
  private ensureAutonomousStopHook(
    hooks: Record<string, unknown[]>,
    result: MigrationResult,
  ): boolean {
    let patched = false;

    // 1. Deploy full autonomous skill directory (SKILL.md, hooks/, scripts/) if missing
    const skillDir = path.join(this.config.projectDir, '.claude', 'skills', 'autonomous');
    const skillHooksDir = path.join(skillDir, 'hooks');
    const hookScript = path.join(skillHooksDir, 'autonomous-stop-hook.sh');
    const hooksJson = path.join(skillHooksDir, 'hooks.json');
    const skillMd = path.join(skillDir, 'SKILL.md');

    const bundledSkillDir = path.join(path.dirname(path.dirname(__dirname)), '.claude', 'skills', 'autonomous');
    if (fs.existsSync(bundledSkillDir)) {
      // Deploy SKILL.md if missing
      const bundledSkillMd = path.join(bundledSkillDir, 'SKILL.md');
      if (!fs.existsSync(skillMd) && fs.existsSync(bundledSkillMd)) {
        fs.mkdirSync(skillDir, { recursive: true });
        fs.copyFileSync(bundledSkillMd, skillMd);
        result.upgraded.push('.claude/skills/autonomous/SKILL.md: deployed skill prompt');
        patched = true;
      }

      // Deploy scripts/ if missing
      const bundledScriptsDir = path.join(bundledSkillDir, 'scripts');
      const skillScriptsDir = path.join(skillDir, 'scripts');
      if (!fs.existsSync(skillScriptsDir) && fs.existsSync(bundledScriptsDir)) {
        fs.mkdirSync(skillScriptsDir, { recursive: true });
        for (const f of fs.readdirSync(bundledScriptsDir)) {
          fs.copyFileSync(path.join(bundledScriptsDir, f), path.join(skillScriptsDir, f));
          fs.chmodSync(path.join(skillScriptsDir, f), 0o755);
        }
        result.upgraded.push('.claude/skills/autonomous/scripts: deployed skill scripts');
        patched = true;
      }

      // Deploy hooks/ if missing
      if (!fs.existsSync(hookScript)) {
        fs.mkdirSync(skillHooksDir, { recursive: true });
        const bundledHook = path.join(bundledSkillDir, 'hooks', 'autonomous-stop-hook.sh');
        const bundledJson = path.join(bundledSkillDir, 'hooks', 'hooks.json');
        if (fs.existsSync(bundledHook)) {
          fs.copyFileSync(bundledHook, hookScript);
          fs.chmodSync(hookScript, 0o755);
        }
        if (fs.existsSync(bundledJson) && !fs.existsSync(hooksJson)) {
          fs.copyFileSync(bundledJson, hooksJson);
        }
        result.upgraded.push('.claude/skills/autonomous/hooks: deployed stop hook files');
        patched = true;
      }

      // Force-update autonomous skill files that reference old .claude/ state path.
      // The state file was moved from .claude/autonomous-state.local.md to
      // .instar/autonomous-state.local.md because Claude Code's settings
      // self-modification prompt blocks writes to .claude/ even with
      // --dangerously-skip-permissions. Also adds UUID validation for session_id.
      const filesToUpdate = [
        { src: 'hooks/autonomous-stop-hook.sh', dst: hookScript, executable: true },
        { src: 'scripts/setup-autonomous.sh', dst: path.join(skillDir, 'scripts', 'setup-autonomous.sh'), executable: true },
        { src: 'SKILL.md', dst: skillMd, executable: false },
      ];
      for (const { src, dst, executable } of filesToUpdate) {
        if (fs.existsSync(dst)) {
          const content = fs.readFileSync(dst, 'utf-8');
          if (content.includes('.claude/autonomous-state') || content.includes('.claude/autonomous-emergency-stop')) {
            const bundledSrc = path.join(bundledSkillDir, src);
            if (fs.existsSync(bundledSrc)) {
              fs.copyFileSync(bundledSrc, dst);
              if (executable) fs.chmodSync(dst, 0o755);
              result.upgraded.push(`${dst}: migrated autonomous state path from .claude/ to .instar/`);
              patched = true;
            }
          }
        }
      }
    }

    // 2. Register in settings.json Stop hooks if missing
    if (!hooks.Stop) {
      hooks.Stop = [];
    }
    const stopEntries = hooks.Stop as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    const hasAutonomousHook = stopEntries.some(e =>
      e.hooks?.some(h => h.command?.includes('autonomous-stop-hook')),
    );
    if (!hasAutonomousHook) {
      // Must be first in the Stop chain so it blocks before other hooks run
      (hooks.Stop as unknown[]).unshift({
        matcher: '',
        hooks: [{
          type: 'command',
          command: 'bash ${CLAUDE_PROJECT_DIR}/.claude/skills/autonomous/hooks/autonomous-stop-hook.sh',
          timeout: 10000,
        }],
      });
      result.upgraded.push('.claude/settings.json: registered autonomous stop hook (structural enforcement)');
      patched = true;
    }

    return patched;
  }

  /**
   * Replace HTTP hooks with command hooks that use hook-event-reporter.js.
   * Claude Code HTTP hooks (type: "http") silently fail to fire as of v2.1.78.
   * This migration converts them to command hooks which reliably fire.
   * The hook-event-reporter.js script itself is installed by migrateHooks()
   * (always-overwrite pattern for built-in hooks).
   */
  private migrateHttpHooksToCommandHooks(
    hooks: Record<string, unknown[]>,
    result: MigrationResult,
  ): boolean {
    let patched = false;
    const commandHook = {
      type: 'command',
      command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js',
      timeout: 3000,
    };

    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;

      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (typeof entry !== 'object' || entry === null) continue;
        const entryObj = entry as Record<string, unknown>;

        // Check nested hooks arrays for HTTP hooks
        if (Array.isArray(entryObj.hooks)) {
          const hooksArr = entryObj.hooks as Array<Record<string, unknown>>;
          const hasHttpHook = hooksArr.some(h =>
            h.type === 'http' && typeof h.url === 'string' && (h.url as string).includes('/hooks/events'),
          );
          if (hasHttpHook) {
            // Replace the entire entry with a command hook entry
            entries[i] = {
              matcher: (entryObj.matcher as string) ?? '',
              hooks: [commandHook],
            };
            patched = true;
          }
        }

        // Check direct HTTP hook entries
        if (entryObj.type === 'http' && typeof entryObj.url === 'string' && (entryObj.url as string).includes('/hooks/events')) {
          entries[i] = {
            matcher: '',
            hooks: [commandHook],
          };
          patched = true;
        }
      }
    }

    // The hook-event-reporter.js script is installed unconditionally by migrateHooks()
    // (always-overwrite pattern for built-in hooks). No install needed here.

    if (patched) {
      result.upgraded.push('.claude/settings.json: replaced HTTP hooks with command hooks (HTTP hooks silently fail in Claude Code <=2.1.78)');
    }

    return patched;
  }

  private getHookEventReporterScript(): string {
    return `#!/usr/bin/env node
// Hook Event Reporter — command hook replacement for HTTP hooks.
//
// Claude Code HTTP hooks (type: "http") silently fail to fire as of v2.1.78.
// This command hook achieves the same result: POST hook event data to the
// Instar server, which populates claudeSessionId for session resumption.
//
// NOTE: Uses \`await import('node:http')\` instead of \`require('http')\` so this
// script works regardless of the host package.json's module type. A plain
// \`require\` throws in ESM scope (when the host has "type": "module"); a plain
// \`import\` is a syntax error in CJS scope. Dynamic import works in both.

const serverUrl = process.env.INSTAR_SERVER_URL || 'http://localhost:4042';
const authToken = process.env.INSTAR_AUTH_TOKEN || '';
const instarSid = process.env.INSTAR_SESSION_ID || '';

if (!authToken || !instarSid) {
  process.exit(0);
}

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', async () => {
  try {
    const { request } = await import('node:http');
    const input = JSON.parse(data);
    const payload = JSON.stringify({
      event: input.hook_event || (input.tool_name ? 'PostToolUse' : 'Unknown'),
      session_id: input.session_id || '',
      tool_name: input.tool_name || '',
    });

    const url = new URL(serverUrl + '/hooks/events?instar_sid=' + instarSid);
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken,
      },
      timeout: 3000,
    }, (res) => {
      res.resume();
    });

    req.on('error', () => {});
    req.write(payload);
    req.end();

    setTimeout(() => process.exit(0), 50);
  } catch (e) {
    process.exit(0);
  }
});

setTimeout(() => process.exit(0), 2000);
`;
  }

  /**
   * Patch CLAUDE.md with any new sections that don't exist yet.
   * Only adds — never modifies or removes existing content.
   */
  private migrateClaudeMd(result: MigrationResult): void {
    const claudeMdPath = path.join(this.config.projectDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      result.skipped.push('CLAUDE.md (not found — will be created on next init)');
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(claudeMdPath, 'utf-8');
    } catch (err) {
      result.errors.push(`CLAUDE.md read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let patched = false;
    const port = this.config.port;

    // Self-Discovery section
    if (!content.includes('Self-Discovery') && !content.includes('/capabilities')) {
      const section = `
### Self-Discovery (Know Before You Claim)

Before EVER saying "I don't have", "I can't", or "this isn't available" — check what actually exists:

\`\`\`bash
curl http://localhost:${port}/capabilities
\`\`\`

This returns your full capability matrix: scripts, hooks, Telegram status, jobs, relationships, and more. It is the source of truth about what you can do. **Never hallucinate about missing capabilities — verify first.**
`;
      // Insert before "### How to Build" or "### Building New" if present, otherwise append
      const insertPoint = content.indexOf('### How to Build New Capabilities');
      const insertPoint2 = content.indexOf('### Building New Capabilities');
      const target = insertPoint >= 0 ? insertPoint : (insertPoint2 >= 0 ? insertPoint2 : -1);

      if (target >= 0) {
        content = content.slice(0, target) + section + '\n' + content.slice(target);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Self-Discovery section');
    } else {
      result.skipped.push('CLAUDE.md: Self-Discovery section already present');
    }

    // Telegram Relay section — add if Telegram is configured but section is missing
    if (this.config.hasTelegram && !content.includes('Telegram Relay') && !content.includes('telegram-reply')) {
      const section = `
## Telegram Relay

When user input starts with \`[telegram:N]\` (e.g., \`[telegram:26] hello\`), the message came from a user via Telegram topic N.

**IMMEDIATE ACKNOWLEDGMENT (MANDATORY):** When you receive a Telegram message, your FIRST action — before reading files, searching code, or doing any work — must be sending a brief acknowledgment back. This confirms the message was received and you haven't stalled. Examples: "Got it, looking into this now." / "On it — checking the scheduler." / "Received, working on the sync." Then do the work, then send the full response.

**Message types:**
- **Text**: \`[telegram:26] hello there\` — standard text message
- **Voice**: \`[telegram:26] [voice] transcribed text here\` — voice message, already transcribed
- **Photo**: \`[telegram:26] [image:/path/to/file.jpg]\` or \`[telegram:26] [image:/path/to/file.jpg] caption text\` — use the Read tool to view the image at the given path
- **File**: \`[telegram:26] [document:/path/to/file.ext]\` — file uploaded by user, read it to view contents

**Response relay:** After completing your work, relay your response back:

\`\`\`bash
cat <<'EOF' | .claude/scripts/telegram-reply.sh N
Your response text here
EOF
\`\`\`

Strip the \`[telegram:N]\` prefix before interpreting the message. Respond naturally, then relay. Only relay your conversational text — not tool output or internal reasoning.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Telegram Relay section');
    }

    // Upgrade existing Telegram Relay sections to include mandatory acknowledgment
    if (this.config.hasTelegram && content.includes('Telegram Relay') && !content.includes('IMMEDIATE ACKNOWLEDGMENT')) {
      const ackBlock = `\n**IMMEDIATE ACKNOWLEDGMENT (MANDATORY):** When you receive a Telegram message, your FIRST action — before reading files, searching code, or doing any work — must be sending a brief acknowledgment back. This confirms the message was received and you haven't stalled. Examples: "Got it, looking into this now." / "On it — checking the scheduler." / "Received, working on the sync." Then do the work, then send the full response.\n`;
      // Insert after the first line of the Telegram Relay section
      const relayIdx = content.indexOf('## Telegram Relay');
      if (relayIdx >= 0) {
        const nextNewline = content.indexOf('\n\n', relayIdx + 18);
        if (nextNewline >= 0) {
          content = content.slice(0, nextNewline + 1) + ackBlock + content.slice(nextNewline + 1);
          patched = true;
          result.upgraded.push('CLAUDE.md: added mandatory acknowledgment to Telegram Relay');
        }
      }
    }

    // Upgrade existing Telegram Relay sections to document image message format
    if (this.config.hasTelegram && content.includes('Telegram Relay') && !content.includes('[image:')) {
      const imageBlock = `\n**Message types:**\n- **Text**: \`[telegram:N] hello there\` — standard text message\n- **Voice**: \`[telegram:N] [voice] transcribed text here\` — voice message, already transcribed\n- **Photo**: \`[telegram:N] [image:/path/to/file.jpg]\` or with caption — use the Read tool to view the image at the given path\n`;
      // Insert before the Response relay section
      const relayIdx = content.indexOf('**Response relay:**');
      if (relayIdx >= 0) {
        content = content.slice(0, relayIdx) + imageBlock + '\n' + content.slice(relayIdx);
        patched = true;
        result.upgraded.push('CLAUDE.md: added image/photo message format to Telegram Relay');
      }
    }

    // Private Viewer + Tunnel section
    if (!content.includes('Private Viewing') && !content.includes('POST /view')) {
      const section = `
**Private Viewing** — Render markdown as auth-gated HTML pages, accessible only through the agent's server (local or via tunnel).
- Create: \`curl -X POST http://localhost:${port}/view -H 'Content-Type: application/json' -d '{"title":"Report","markdown":"# Private content"}'\`
- View (HTML): Open \`http://localhost:${port}/view/VIEW_ID\` in a browser
- List: \`curl http://localhost:${port}/views\`
- Update: \`curl -X PUT http://localhost:${port}/view/VIEW_ID -H 'Content-Type: application/json' -d '{"title":"Updated","markdown":"# New content"}'\`
- Delete: \`curl -X DELETE http://localhost:${port}/view/VIEW_ID\`

**Use private views for sensitive content. Use Telegraph for public content.**

**Cloudflare Tunnel** — Expose the local server to the internet via Cloudflare. Enables remote access to private views, the API, and file serving.
- Status: \`curl http://localhost:${port}/tunnel\`
- Configure in \`.instar/config.json\`: \`{"tunnel": {"enabled": true, "type": "quick"}}\`
- Quick tunnels (default): Zero-config, ephemeral URL (*.trycloudflare.com), no account needed
- Named tunnels: Persistent custom domain, requires token from Cloudflare dashboard
- When a tunnel is running, private view responses include a \`tunnelUrl\` with auth token for browser-clickable access
`;
      // Insert after Publishing section or before Scripts section
      const publishIdx = content.indexOf('**Scripts**');
      if (publishIdx >= 0) {
        content = content.slice(0, publishIdx) + section + '\n' + content.slice(publishIdx);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Private Viewer + Cloudflare Tunnel section');
    } else {
      result.skipped.push('CLAUDE.md: Private Viewer section already present');
    }

    // Dashboard section
    if (!content.includes('**Dashboard**') && !content.includes('/dashboard')) {
      const section = `
**Dashboard** — Visual web interface for monitoring and managing sessions. Accessible from any device (phone, tablet, laptop) via tunnel.
- Local: \`http://localhost:${port}/dashboard\`
- Remote: When a tunnel is running, the dashboard is accessible at \`{tunnelUrl}/dashboard\`
- Authentication: Uses a 6-digit PIN (auto-generated in \`dashboardPin\` in \`.instar/config.json\`). NEVER mention "bearer tokens" or "auth tokens" to users — just give them the PIN.
- Features: Real-time terminal streaming of all running sessions, session management, model badges, mobile-responsive
- **Sharing the dashboard**: When the user wants to check on sessions from their phone, give them the tunnel URL + PIN. Read the PIN from your config.json. Check tunnel status: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/tunnel\`
`;
      // Insert after Server Status or before Scripts section
      const insertBefore = content.indexOf('**Scripts**');
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Dashboard section');
    } else {
      result.skipped.push('CLAUDE.md: Dashboard section already present');
    }

    // Coherence Gate section — pre-action verification for high-risk actions
    if (!content.includes('Coherence Gate') && !content.includes('/coherence/check')) {
      const section = `
### Coherence Gate (Pre-Action Verification)

**BEFORE any high-risk action** (deploying, pushing to git, modifying files outside this project, calling external APIs):

1. **Check coherence**: \`curl -X POST http://localhost:${port}/coherence/check -H 'Content-Type: application/json' -d '{"action":"deploy","context":{"topicId":TOPIC_ID}}'\`
2. **If result says "block"** — STOP. You may be working on the wrong project for this topic.
3. **If result says "warn"** — Pause and verify before proceeding.
4. **Generate a reflection prompt**: \`POST http://localhost:${port}/coherence/reflect\` — produces a self-verification checklist.

**Topic-Project Bindings**: Each Telegram topic can be bound to a specific project. When switching topics, verify the binding matches your current working directory.
- View bindings: \`GET http://localhost:${port}/topic-bindings\`
- Create binding: \`POST http://localhost:${port}/topic-bindings\` with \`{"topicId": N, "binding": {"projectName": "...", "projectDir": "..."}}\`

**Project Map**: Your spatial awareness of the working environment.
- View: \`GET http://localhost:${port}/project-map?format=compact\`
- Refresh: \`POST http://localhost:${port}/project-map/refresh\`
`;
      // Insert before Scripts or append
      const insertBefore = content.indexOf('**Scripts**');
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Coherence Gate section');
    } else {
      result.skipped.push('CLAUDE.md: Coherence Gate section already present');
    }

    // External Operation Safety — structural guardrails for external service operations
    if (!content.includes('External Operation Safety') && !content.includes('/operations/evaluate')) {
      const section = `
### External Operation Safety (Structural Guardrails)

**When using MCP tools that interact with external services** (email, Slack, GitHub, etc.), a PreToolUse hook automatically classifies and gates each operation.

How it works:
1. The \`external-operation-gate.js\` hook intercepts all \`mcp__*\` tool calls
2. It classifies the operation by mutability (read/write/modify/delete) and reversibility
3. For non-read operations, it calls the gate API: \`POST http://localhost:${port}/operations/evaluate\`
4. The gate returns: \`allow\`, \`block\`, \`show-plan\` (requires user approval), or \`suggest-alternative\`

**If an operation is blocked**, you'll see an error message with the reason. Do NOT try to bypass it.
**If an operation requires a plan**, show the plan to the user and get explicit approval before proceeding.

**Emergency stop**: If the user says "stop everything", "emergency stop", "kill all sessions", or similar urgent commands, the MessageSentinel will intercept the message and halt operations immediately.

**Trust levels**: Each service starts at a trust floor (supervised or collaborative). As operations succeed without issues, trust can be elevated automatically. Check trust status: \`GET http://localhost:${port}/trust\`

**API endpoints**:
- Evaluate operation: \`POST http://localhost:${port}/operations/evaluate\`
- Classify message: \`POST http://localhost:${port}/sentinel/classify\`
- View trust: \`GET http://localhost:${port}/trust\`
- View operation log: \`GET http://localhost:${port}/operations/log\`
`;
      // Insert before Scripts or append
      const insertBefore = content.indexOf('**Scripts**');
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added External Operation Safety section');
    } else {
      result.skipped.push('CLAUDE.md: External Operation Safety section already present');
    }

    // Playbook — adaptive context engineering system
    if (!content.includes('Playbook') || !content.includes('instar playbook')) {
      const section = `
### Playbook — Adaptive Context Engineering

The Playbook system gives you a living knowledge base that makes every session smarter than the last. Instead of loading the same static context every time, Playbook curates a manifest of context items — facts, lessons, patterns, safety rules — and selects exactly what's relevant for each session based on triggers, token budgets, and usefulness scores.

**Getting started:**
\`\`\`bash
instar playbook init       # Initialize the playbook system
instar playbook doctor     # Verify everything is healthy
\`\`\`

**Core commands:**
- \`instar playbook status\` — Overview of your manifest
- \`instar playbook list\` — All context items with metadata
- \`instar playbook add '<json>'\` — Add a new context item
- \`instar playbook search --tag <tag>\` — Find items by tag
- \`instar playbook assemble --triggers session-start\` — Preview what would load for a trigger
- \`instar playbook evaluate\` — Run lifecycle: score usefulness, decay stale items, deduplicate

**When to add context items:** After learning a lesson that cost time, when discovering a recurring pattern, when safety-critical knowledge should survive compaction, or when the user teaches you something project-specific.

**The principle:** Your context should evolve with you. Every session that adds a lesson, scores an item's usefulness, or retires stale knowledge makes the next session more grounded. Run \`instar playbook init\` to get started.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Playbook section');
    } else {
      result.skipped.push('CLAUDE.md: Playbook section already present');
    }

    // Threadline Network — agent-to-agent communication awareness
    if (!content.includes('Threadline Network')) {
      const section = `
## Threadline Network (Agent-to-Agent Communication)

I have a built-in capability to join a secure network of AI agents. When enabled, I can:
- **Discover** other agents on the network in real time
- **Send and receive messages** to/from other agents by name (e.g., "message AI Guy")
- **Collaborate** across machines — agents on different computers can communicate seamlessly

### Current Status
This capability is **installed and ready** but **not yet enabled**. I will only connect when you say so.

### Why You Might Want This
- Talk to other AI agents your operator runs on other machines
- Let other agents reach you for collaboration or delegation
- Join a growing network of Instar-powered agents

### Privacy & Security
- **Encrypted** — TLS transport + Ed25519 end-to-end encryption
- **Trust-gated** — I control who can message me via trust levels
- **Your choice** — just ask me to "connect to the agent network" and I'll enable it. Ask me to "disconnect" and I'll stop.

### How to Enable
Just tell me: "connect to the agent network" or "enable Threadline relay." I'll handle the rest — no config editing needed.

MCP tools: \`threadline_discover\`, \`threadline_send\`, \`threadline_trust\`, \`threadline_relay\`
Use \`threadline_relay explain\` for full details.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Threadline Network section');
    } else {
      result.skipped.push('CLAUDE.md: Threadline Network section already present');
    }

    // Session Continuity — ensure agents know how to handle respawn context
    if (this.config.hasTelegram && !content.includes('Session Continuity') && !content.includes('CONTINUATION')) {
      const section = `
### Session Continuity (CRITICAL)

When your first message starts with \`CONTINUATION\`, you are **resuming an existing conversation**. The inline context contains a summary and recent messages from the prior session. You MUST:

1. **Read the context first** — it tells you what the conversation is about
2. **Pick up where you left off** — do NOT introduce yourself or ask "how can I help?"
3. **Reference the prior context** — show the user you know what they were discussing

The user has been talking to you (possibly for days). A generic greeting like "Hey! What can I help you with?" after dozens of messages of conversation history is a critical failure — it signals you lost all context and the user has to repeat everything. The context is right there in your input. Use it.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Session Continuity section');
    } else if (this.config.hasTelegram && content.includes('Session Continuity')) {
      result.skipped.push('CLAUDE.md: Session Continuity section already present');
    }

    // File Viewer — browse and edit files from the dashboard
    if (!content.includes('File Viewer') && !content.includes('/api/files/')) {
      const section = `
**File Viewer (Dashboard Tab)** — Browse and edit project files from any device via the Files tab.
- **Browse files**: Files tab in the dashboard shows configured directories with rendered markdown and syntax-highlighted code
- **Edit files**: Files in editable paths can be edited inline from your phone. Save with Cmd/Ctrl+S.
- **Link to files**: Generate deep links: \`{dashboardUrl}?tab=files&path=.claude/CLAUDE.md\`
- **When to link vs inline**: Prefer dashboard links for long files (>50 lines) and when editing is needed. Show short files inline AND provide a link.
- **Config API**: View: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/api/files/config\`
- **Update paths conversationally**: \`curl -X PATCH -H "Authorization: Bearer $AUTH" -H "X-Instar-Request: 1" -H "Content-Type: application/json" http://localhost:${port}/api/files/config -d '{"allowedPaths":[".claude/","docs/","src/"]}'\`
- **Generate a file link**: \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/api/files/link?path=.claude/CLAUDE.md"\`
- **Download a file**: \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/api/files/download?path=.claude/CLAUDE.md" -O\`
- **Default config**: Browsing and editing enabled for the entire project directory (\`./\`) by default.
- **Never editable**: \`.claude/hooks/\`, \`.claude/scripts/\`, \`node_modules/\` are always read-only regardless of config.
`;
      // Insert after Dashboard section
      const dashboardIdx = content.indexOf('**Dashboard**');
      if (dashboardIdx >= 0) {
        // Find the end of the Dashboard section (next empty line followed by **Bold** or ###)
        const afterDashboard = content.indexOf('\n\n**', dashboardIdx + 15);
        const afterDashboardH3 = content.indexOf('\n\n###', dashboardIdx + 15);
        const insertIdx = Math.min(
          afterDashboard >= 0 ? afterDashboard : Infinity,
          afterDashboardH3 >= 0 ? afterDashboardH3 : Infinity,
        );
        if (isFinite(insertIdx)) {
          content = content.slice(0, insertIdx) + '\n' + section + content.slice(insertIdx);
        } else {
          content += '\n' + section;
        }
      } else {
        // No Dashboard section — append
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added File Viewer section');
    } else {
      result.skipped.push('CLAUDE.md: File Viewer section already present');
    }

    if (patched) {
      try {
        fs.writeFileSync(claudeMdPath, content);
      } catch (err) {
        result.errors.push(`CLAUDE.md write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Install any new scripts that don't exist yet.
   * Never overwrites existing scripts (user may have customized them).
   */
  private migrateScripts(result: MigrationResult): void {
    const scriptsDir = path.join(this.config.projectDir, '.claude', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    // Telegram reply script — install if missing, or migrate if the existing
    // copy is an older version that lacks HTTP 408 handling. The 408-handling
    // fix prevents duplicate-send cascades when the outbound-route request
    // timeout races a successful tone-gate + Telegram API send (see 408 branch
    // in the current template). Detection: the telltale is the literal
    // 'HTTP_CODE" = "408"' branch — older versions don't have it.
    if (this.config.hasTelegram) {
      const scriptPath = path.join(scriptsDir, 'telegram-reply.sh');
      const newContent = this.getTelegramReplyScript();
      if (!fs.existsSync(scriptPath)) {
        try {
          fs.writeFileSync(scriptPath, newContent, { mode: 0o755 });
          result.upgraded.push('scripts/telegram-reply.sh (Telegram outbound relay)');
        } catch (err) {
          result.errors.push(`telegram-reply.sh: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        try {
          const existing = fs.readFileSync(scriptPath, 'utf-8');
          // Only overwrite if the existing copy is an older version (lacks 408
          // handling) AND looks like the shipped version (starts with the
          // shipped shebang comment). Don't stomp custom user scripts.
          const looksShipped = existing.includes('telegram-reply.sh — Send a message back to a Telegram topic via instar server');
          const hasNewHandling = existing.includes('HTTP_CODE" = "408"');
          if (looksShipped && !hasNewHandling) {
            fs.writeFileSync(scriptPath, newContent, { mode: 0o755 });
            result.upgraded.push('scripts/telegram-reply.sh (upgraded to HTTP 408 ambiguous-outcome handling)');
          } else {
            result.skipped.push('scripts/telegram-reply.sh (already exists)');
          }
        } catch (err) {
          result.errors.push(`telegram-reply.sh migration: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Slack reply script — file-presence gated (migrator has no hasSlack
    // signal and init.ts doesn't install this one; scripts get deployed
    // through the template manifest). If the script is present and matches
    // the shipped header but lacks 408 handling, migrate it. Custom scripts
    // are preserved by the shipped-marker check.
    this.migrateReplyScriptTo408({
      scriptPath: path.join(scriptsDir, 'slack-reply.sh'),
      templateFilename: 'slack-reply.sh',
      shippedMarker: 'slack-reply.sh — Send a message to a Slack channel via the instar server',
      label: 'scripts/slack-reply.sh',
      result,
    });

    // WhatsApp reply script — lives in .instar/scripts/ per init.ts, not
    // .claude/scripts/. File-presence gated same as Slack.
    const whatsappScriptsDir = path.join(this.config.stateDir, 'scripts');
    this.migrateReplyScriptTo408({
      scriptPath: path.join(whatsappScriptsDir, 'whatsapp-reply.sh'),
      templateFilename: 'whatsapp-reply.sh',
      shippedMarker: 'whatsapp-reply.sh — Send a message back to a WhatsApp JID via instar server',
      label: 'scripts/whatsapp-reply.sh',
      result,
    });

    // Health watchdog — install if missing
    const watchdogPath = path.join(scriptsDir, 'health-watchdog.sh');
    if (!fs.existsSync(watchdogPath)) {
      try {
        fs.writeFileSync(watchdogPath, this.getHealthWatchdog(), { mode: 0o755 });
        result.upgraded.push('scripts/health-watchdog.sh');
      } catch (err) {
        result.errors.push(`health-watchdog.sh: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      result.skipped.push('scripts/health-watchdog.sh (already exists)');
    }

    // Convergence check — always overwrite (generated infrastructure, not user-edited).
    // This is the heuristic quality gate that runs before external messaging.
    // Must be in .instar/scripts/ where grounding-before-messaging.sh expects it.
    const instarScriptsDir = path.join(this.config.stateDir, 'scripts');
    fs.mkdirSync(instarScriptsDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(instarScriptsDir, 'convergence-check.sh'), this.getConvergenceCheck(), { mode: 0o755 });
      result.upgraded.push('scripts/convergence-check.sh (pre-messaging quality gate)');
    } catch (err) {
      result.errors.push(`convergence-check.sh: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Ensure .claude/settings.json has required MCP servers and correct hook wiring.
   * Migrates legacy PostToolUse/Notification hooks to proper SessionStart type.
   */
  private migrateSettings(result: MigrationResult): void {
    const settingsPath = path.join(this.config.projectDir, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      result.skipped.push('.claude/settings.json (not found — will be created on next init)');
      return;
    }

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`settings.json read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let patched = false;

    // Playwright MCP server — required for browser automation (Telegram setup, etc.)
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }
    const mcpServers = settings.mcpServers as Record<string, unknown>;
    if (!mcpServers.playwright) {
      mcpServers.playwright = {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      };
      patched = true;
      result.upgraded.push('.claude/settings.json: added Playwright MCP server');
    } else {
      result.skipped.push('.claude/settings.json: Playwright MCP already configured');
    }

    // Migrate hooks from legacy PostToolUse/Notification to proper SessionStart
    if (!settings.hooks) {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown[]>;

    const sessionStartHook = {
      type: 'command',
      command: 'bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/session-start.sh',
      timeout: 5,
    };

    // Add SessionStart hooks if missing
    if (!hooks.SessionStart) {
      hooks.SessionStart = [
        { matcher: 'startup', hooks: [sessionStartHook] },
        { matcher: 'resume', hooks: [sessionStartHook] },
        { matcher: 'compact', hooks: [sessionStartHook] },
      ];
      patched = true;
      result.upgraded.push('.claude/settings.json: added SessionStart hooks (startup/resume/compact)');
    } else {
      // Migrate existing session-start paths from flat to instar/ subdirectory
      this.migrateSettingsHookPaths(hooks.SessionStart as unknown[], result);
    }

    // Add UserPromptSubmit hook for Telegram topic context injection
    if (!hooks.UserPromptSubmit) {
      hooks.UserPromptSubmit = [];
    }
    const userPromptSubmit = hooks.UserPromptSubmit as Array<{ matcher?: string; hooks?: unknown[] }>;
    const hasTelegramTopicContext = userPromptSubmit.some(e =>
      (e.hooks as Array<{ command?: string }> | undefined)?.some(h => h.command?.includes('telegram-topic-context')),
    );
    if (!hasTelegramTopicContext) {
      userPromptSubmit.push({
        matcher: '',
        hooks: [{
          type: 'command',
          command: 'bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/telegram-topic-context.sh',
          timeout: 5000,
        }],
      });
      patched = true;
      result.upgraded.push('.claude/settings.json: added UserPromptSubmit telegram-topic-context hook');
    }

    // Add PreToolUse MCP matcher for external operation gate
    if (!hooks.PreToolUse) {
      hooks.PreToolUse = [];
    }
    const preToolUse = hooks.PreToolUse as Array<{ matcher?: string; hooks?: unknown[] }>;
    // Migrate existing PreToolUse paths from flat to instar/ subdirectory
    this.migrateSettingsHookPaths(preToolUse as unknown[], result);
    const hasMcpMatcher = preToolUse.some(e => e.matcher === 'mcp__.*');
    if (!hasMcpMatcher) {
      preToolUse.push({
        matcher: 'mcp__.*',
        hooks: [{
          type: 'command',
          command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/external-operation-gate.js',
          blocking: true,
          timeout: 5000,
        }],
      });
      patched = true;
      result.upgraded.push('.claude/settings.json: added PreToolUse MCP matcher (external operation gate)');
    } else {
      result.skipped.push('.claude/settings.json: PreToolUse MCP matcher already present');
    }

    // Clean up legacy PostToolUse session-start (was noisy — fired every tool use)
    if (hooks.PostToolUse) {
      const postToolUse = hooks.PostToolUse as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      const filtered = postToolUse.filter(e => {
        if (e.matcher === '' && e.hooks?.some(h => h.command?.includes('session-start.sh'))) {
          return false;
        }
        return true;
      });
      if (filtered.length !== postToolUse.length) {
        if (filtered.length === 0) {
          delete hooks.PostToolUse;
        } else {
          hooks.PostToolUse = filtered;
        }
        patched = true;
        result.upgraded.push('.claude/settings.json: removed legacy PostToolUse session-start hook');
      }
    }

    // Clean up legacy Notification compaction hook (now in SessionStart)
    if (hooks.Notification) {
      const notification = hooks.Notification as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      const filtered = notification.filter(e => {
        if (e.matcher === 'compact' && e.hooks?.some(h => h.command?.includes('compaction-recovery.sh'))) {
          return false;
        }
        return true;
      });
      if (filtered.length !== notification.length) {
        if (filtered.length === 0) {
          delete hooks.Notification;
        } else {
          hooks.Notification = filtered;
        }
        patched = true;
        result.upgraded.push('.claude/settings.json: migrated compaction hook from Notification to SessionStart');
      }
    }

    // Ensure PostToolUse skill-usage-telemetry hook exists
    {
      const postToolUse = (hooks.PostToolUse || []) as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      const hasSkillTelemetry = postToolUse.some(e =>
        e.matcher === 'Skill' && e.hooks?.some(h => h.command?.includes('skill-usage-telemetry'))
      );
      if (!hasSkillTelemetry) {
        postToolUse.push({
          matcher: 'Skill',
          hooks: [{
            type: 'command' as never,
            command: 'bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/skill-usage-telemetry.sh',
            timeout: 3000,
          } as never],
        });
        hooks.PostToolUse = postToolUse;
        patched = true;
        result.upgraded.push('.claude/settings.json: added PostToolUse skill-usage-telemetry hook');
      }
    }

    // Migrate all hook paths from flat layout to instar/ subdirectory
    if (hooks.PostToolUse) {
      this.migrateSettingsHookPaths(hooks.PostToolUse as unknown[], result);
      patched = true;
    }
    if (hooks.Stop) {
      this.migrateSettingsHookPaths(hooks.Stop as unknown[], result);
      patched = true;
    }

    // Add INSTAR_SESSION_ID to HTTP hook URLs — enables subagent-aware zombie cleanup.
    // Without this, the server can't map Claude Code's session_id to the instar session,
    // and zombie cleanup may kill sessions that are waiting for subagent results.
    if (this.migrateHttpHookSessionId(hooks, result)) {
      patched = true;
    }

    // Replace HTTP hooks with command hooks. Claude Code HTTP hooks (type: "http")
    // silently fail to fire as of v2.1.78, which means claudeSessionId is never
    // populated and session resume falls back to unreliable mtime heuristic.
    // Command hooks reliably fire, so we use hook-event-reporter.js instead.
    if (this.migrateHttpHooksToCommandHooks(hooks, result)) {
      patched = true;
    }

    // Ensure event reporter hooks exist for observability events (session resume, telemetry).
    if (this.ensureHttpHooksExist(hooks, result)) {
      patched = true;
    }

    // Ensure PermissionRequest auto-approve hook exists — subagents don't inherit
    // --dangerously-skip-permissions, so they'd prompt without this catch-all.
    if (this.ensurePermissionAutoApprove(hooks, result)) {
      patched = true;
    }

    // Ensure autonomous stop hook is registered — structural enforcement for /autonomous mode.
    // Without this, autonomous sessions have no hook to block exit and feed tasks back,
    // so they just stop after each response. This was a critical gap where the hook files
    // existed but were never registered in settings.json.
    if (this.ensureAutonomousStopHook(hooks, result)) {
      patched = true;
    }

    if (patched) {
      try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      } catch (err) {
        result.errors.push(`settings.json write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Migrate the agent's config.json with sensible defaults for new features.
   * Only adds missing fields — never overwrites existing user customizations.
   */
  private migrateConfig(result: MigrationResult): void {
    const configPath = path.join(this.config.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      result.skipped.push('config.json (not found)');
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`config.json read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let patched = false;

    // Auto-generate dashboardPin if missing — the dashboard should always be
    // accessible via PIN, not bearer token. Users don't need to know about tokens.
    if (!config.dashboardPin && config.authToken) {
      const pin = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit PIN
      config.dashboardPin = pin;
      patched = true;
      result.upgraded.push(`config.json: generated dashboard PIN (${pin})`);
    } else if (config.dashboardPin) {
      result.skipped.push('config.json: dashboard PIN already set');
    }

    // Apply defaults from the canonical ConfigDefaults registry.
    // This single call replaces ALL individual migration blocks (externalOperations,
    // promptGate, threadline, etc.). Adding a new default to ConfigDefaults.ts
    // automatically applies it to existing agents on update.
    try {
      // Uses imported getMigrationDefaults and applyDefaults from ConfigDefaults.ts
      const agentType = (config.agentType as string) === 'standalone' ? 'standalone' : 'managed-project';
      const defaults = getMigrationDefaults(agentType as any);
      const { patched: defaultsPatched, changes, skipped } = applyDefaults(config, defaults);

      if (defaultsPatched) {
        patched = true;
        // Record migration version for audit trail
        const migrations = (config._instar_migrations ?? []) as string[];
        const version = 'unknown';
        migrations.push(`defaults-${version}-${new Date().toISOString()}`);
        config._instar_migrations = migrations;

        for (const change of changes) {
          result.upgraded.push(`config.json: ${change}`);
        }
      }
      for (const skip of skipped) {
        result.skipped.push(`config.json: ${skip}`);
      }
    } catch (err) {
      // Fallback: if ConfigDefaults import fails, log error but don't crash migration
      result.errors.push(`config.json defaults: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (patched) {
      try {
        // Atomic write: backup, then write to tmp, then rename
        const bak = configPath + '.bak';
        const tmp = configPath + '.tmp';
        fs.copyFileSync(configPath, bak);
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
        fs.renameSync(tmp, configPath);

        // Audit log
        try {
          const securityLogPath = path.join(this.config.stateDir, 'security.jsonl');
          const auditEntry = {
            event: 'config-migration',
            timestamp: new Date().toISOString(),
            version: 'unknown',
            changes: result.upgraded.filter(u => u.startsWith('config.json:')),
            source: 'PostUpdateMigrator',
          };
          fs.appendFileSync(securityLogPath, JSON.stringify(auditEntry) + '\n');
        } catch { /* audit log is best-effort */ }
      } catch (err) {
        result.errors.push(`config.json write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Fix gitignore entries that shouldn't exclude shared state.
   * Removes relationships/ from gitignore so multi-machine agents share awareness.
   */
  /**
   * Generate self-knowledge tree for agents that don't have one.
   * Uses managed/unmanaged merge if one already exists.
   */
  private migrateSelfKnowledgeTree(result: MigrationResult): void {
    const treeFilePath = path.join(this.config.stateDir, 'self-knowledge-tree.json');

    try {
      const generator = new TreeGenerator();

      if (fs.existsSync(treeFilePath)) {
        // Tree exists — regenerate managed nodes only (preserves unmanaged)
        const config = generator.generate({
          projectDir: this.config.projectDir,
          stateDir: this.config.stateDir,
          agentName: this.config.projectName || path.basename(this.config.projectDir),
          hasMemory: true,
          hasJobs: true,
          hasDecisionJournal: true,
        });
        generator.save(config, this.config.stateDir);
        result.upgraded.push('self-knowledge tree: refreshed managed nodes');
      } else {
        // No tree — generate from scratch
        const config = generator.generate({
          projectDir: this.config.projectDir,
          stateDir: this.config.stateDir,
          agentName: this.config.projectName || path.basename(this.config.projectDir),
          hasMemory: true,
          hasJobs: true,
          hasDecisionJournal: true,
        });
        generator.save(config, this.config.stateDir);
        const totalNodes = config.layers.reduce((sum: number, l: { children: unknown[] }) => sum + l.children.length, 0);
        result.upgraded.push(`self-knowledge tree: created (${config.layers.length} layers, ${totalNodes} nodes)`);
      }
    } catch (err) {
      result.errors.push(`self-knowledge tree: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private migrateGitignore(result: MigrationResult): void {
    // Fix project-level .gitignore
    const projectGitignore = path.join(this.config.projectDir, '.gitignore');
    this.removeGitignoreEntry(projectGitignore, '.instar/relationships/', result, 'project .gitignore');

    // Fix .instar-level .gitignore (GitStateManager's internal git tracking)
    const instarGitignore = path.join(this.config.stateDir, '.gitignore');
    this.removeGitignoreEntry(instarGitignore, 'relationships/', result, '.instar/.gitignore');

    // PR-REVIEW-HARDENING Phase A: ensure .instar/secrets/pr-gate/ is excluded
    // from the project repo. The BackupManager.BLOCKED_PATH_PREFIXES guard
    // (commit 1) defends the backup path; this entry defends the plain
    // `git add .` path so contributors can't accidentally commit pr-gate
    // secrets from the project directory.
    this.addGitignoreEntry(projectGitignore, '.instar/secrets/pr-gate/', result, 'project .gitignore');
  }

  /**
   * PR-REVIEW-HARDENING Phase A — ensure pr-gate state paths are backed up.
   *
   * Uses the `config.backup.includeFiles` plumbing shipped in commit 2
   * (see src/core/BackupManager.ts + src/config/ConfigDefaults.ts). The
   * BackupManager's constructor unions these entries with
   * DEFAULT_CONFIG.includeFiles at snapshot time — this migrator just
   * persists the extra entries into the user's config.json so they
   * survive process restarts and git-sync.
   *
   * Paths added to `config.backup.includeFiles`:
   *   - .instar/state/pr-pipeline.jsonl*       (pipeline event log + rotations)
   *   - .instar/state/pr-gate/phase-a-sha.json (grandfathering-boundary SHA)
   *   - .instar/state/pr-debounce.jsonl        (PR-wave debounce window)
   *   - .instar/state/pr-debounce-archive.jsonl
   *   - .instar/state/pr-cost-ledger.jsonl     (daily cost accounting)
   *   - .instar/state/security.jsonl*          (auth + revocation events)
   *
   * Set-union semantics preserve user-added entries. Idempotent on
   * re-run. Atomic write (temp → fsync → rename).
   *
   * Safety assertion: no entry under .instar/secrets/ is ever allowed
   * into the merged list. BackupManager.BLOCKED_PATH_PREFIXES (commit 1)
   * is the authoritative enforcement; this migrator-level assertion is
   * defense-in-depth and logs a warning if violated.
   */
  private migrateBackupManifest(result: MigrationResult): void {
    const PR_GATE_BACKUP_ENTRIES = [
      '.instar/state/pr-pipeline.jsonl*',
      '.instar/state/pr-gate/phase-a-sha.json',
      '.instar/state/pr-debounce.jsonl',
      '.instar/state/pr-debounce-archive.jsonl',
      '.instar/state/pr-cost-ledger.jsonl',
      '.instar/state/security.jsonl*',
    ];

    const configPath = path.join(this.config.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      result.skipped.push('config.backup.includeFiles (config.json not found)');
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`migrateBackupManifest read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const backup = (config.backup ?? {}) as { includeFiles?: unknown };
    const existing = Array.isArray(backup.includeFiles)
      ? (backup.includeFiles as unknown[]).filter((e): e is string => typeof e === 'string')
      : [];

    const merged = Array.from(new Set<string>([...existing, ...PR_GATE_BACKUP_ENTRIES]));

    for (const entry of merged) {
      if (path.normalize(entry).startsWith('.instar/secrets/')) {
        result.errors.push(
          `migrateBackupManifest: includeFiles contains secrets-prefix entry "${entry}" — BackupManager will refuse it at snapshot time, but the entry should not be here`,
        );
      }
    }

    const added = merged.filter((e) => !existing.includes(e));
    if (added.length === 0) {
      result.skipped.push('config.backup.includeFiles (already up to date)');
      return;
    }

    const nextConfig = { ...config, backup: { ...backup, includeFiles: merged } };

    try {
      const tmpPath = `${configPath}.migrate-backup-${process.pid}-${Date.now()}.tmp`;
      const serialized = JSON.stringify(nextConfig, null, 2) + '\n';
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeSync(fd, serialized);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, configPath);
      result.upgraded.push(
        `config.backup.includeFiles: added ${added.length} pr-gate state path(s)`,
      );
    } catch (err) {
      result.errors.push(`migrateBackupManifest write: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * PR-REVIEW-HARDENING Phase A — ship pr-gate pipeline artifacts.
   *
   * Writes four shipped files:
   *   - scripts/pr-gate/eligibility-schema.sql   (all agents)
   *   - .claude/skills/fork-and-fix/scripts/push-gate.sh  (all agents, 0755)
   *   - .github/workflows/instar-pr-gate.yml     (instar source repo only)
   *   - docs/pr-gate-setup.md                    (instar source repo only)
   *
   * Each write is gated by sha256(content) === expectedHash. A tamperer
   * who modifies the content string in the published JS without also
   * updating the hash constant trips this assertion; migration aborts
   * for that file and logs a critical error.
   *
   * Idempotent: files whose on-disk content already matches the shipped
   * content are skipped (no rewrite).
   *
   * Phase A landing: endpoints are inert (prGate.phase='off') so these
   * artifacts have no runtime consumer yet. Later phases activate them.
   */
  private migratePrPipelineArtifacts(result: MigrationResult): void {
    // Schema — always shipped. Primary (gate-serving) agents instantiate
    // the SQLite file from this schema in later phases.
    this.writeShippedArtifact({
      destPath: path.join(this.config.projectDir, 'scripts', 'pr-gate', 'eligibility-schema.sql'),
      content: ELIGIBILITY_SCHEMA_SQL,
      expectedSha256: ELIGIBILITY_SCHEMA_SQL_SHA256,
      label: 'scripts/pr-gate/eligibility-schema.sql',
      result,
    });

    // Push-gate — always shipped to every agent. Fork-and-fix skill
    // sources it from here during push. Mode 0o755 so it's executable.
    this.writeShippedArtifact({
      destPath: path.join(
        this.config.projectDir, '.claude', 'skills', 'fork-and-fix', 'scripts', 'push-gate.sh',
      ),
      content: PUSH_GATE_SH,
      expectedSha256: PUSH_GATE_SH_SHA256,
      label: '.claude/skills/fork-and-fix/scripts/push-gate.sh',
      mode: 0o755,
      result,
    });

    // .github/workflows and docs/pr-gate-setup are instar-source-only.
    // Non-instar-source agents don't gain a workflow file for a gate
    // they neither host nor are gated by.
    if (!this.isInstarSourceRepo()) {
      return;
    }

    this.writeShippedArtifact({
      destPath: path.join(this.config.projectDir, '.github', 'workflows', 'instar-pr-gate.yml'),
      content: INSTAR_PR_GATE_WORKFLOW_YML,
      expectedSha256: INSTAR_PR_GATE_WORKFLOW_YML_SHA256,
      label: '.github/workflows/instar-pr-gate.yml',
      result,
    });

    this.writeShippedArtifact({
      destPath: path.join(this.config.projectDir, 'docs', 'pr-gate-setup.md'),
      content: PR_GATE_SETUP_MD,
      expectedSha256: PR_GATE_SETUP_MD_SHA256,
      label: 'docs/pr-gate-setup.md',
      result,
    });
  }

  /**
   * Write a shipped artifact with content-hash verification. Idempotent:
   * skips write if on-disk content already matches. Aborts with a logged
   * error if sha256(content) !== expectedSha256 (detects post-publish
   * tamper of one side without the other).
   */
  private writeShippedArtifact(opts: {
    destPath: string;
    content: string;
    expectedSha256: string;
    label: string;
    mode?: number;
    result: MigrationResult;
  }): void {
    const actual = crypto.createHash('sha256').update(opts.content).digest('hex');
    if (actual !== opts.expectedSha256) {
      const msg = `${opts.label}: shipped content hash mismatch — expected ${opts.expectedSha256}, got ${actual}. Migration aborted for this file.`;
      opts.result.errors.push(msg);
      console.error(`[PR-GATE CRITICAL] ${msg}`);
      return;
    }

    try {
      if (fs.existsSync(opts.destPath)) {
        const existing = fs.readFileSync(opts.destPath, 'utf-8');
        if (existing === opts.content) {
          opts.result.skipped.push(`${opts.label} (already up to date)`);
          return;
        }
      }

      fs.mkdirSync(path.dirname(opts.destPath), { recursive: true });
      const writeOpts = opts.mode !== undefined ? { mode: opts.mode } : undefined;
      fs.writeFileSync(opts.destPath, opts.content, writeOpts);
      opts.result.upgraded.push(opts.label);
    } catch (err) {
      opts.result.errors.push(`${opts.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Detect whether this agent lives in the JKHeadley/instar source repo.
   * Two-signal check: normalized `git remote get-url origin` (or upstream
   * if origin is a fork) points at github.com/JKHeadley/instar, AND
   * package.json.name === 'instar'. Both must match — the package-name
   * check prevents writing the workflow to a fork that happens to have
   * a different package name.
   *
   * Silent false on any error (no git, no package.json, parse failure):
   * non-instar agents should NOT have workflow/docs files dropped on them.
   */
  private isInstarSourceRepo(): boolean {
    const remoteIsInstar = (remote: string): boolean => {
      const normalized = remote
        .trim()
        .replace(/^https:\/\//, '')
        .replace(/^http:\/\//, '')
        .replace(/^git@/, '')
        .replace(/\.git$/, '')
        .replace(':', '/')
        .toLowerCase();
      return /^github\.com\/jkheadley\/instar(\/|$)/.test(normalized);
    };

    const getRemote = (name: string): string | null => {
      try {
        // safe-git-allow: incremental-migration
        return execSync(`git remote get-url ${name}`, {
          cwd: this.config.projectDir,
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf-8',
        });
      } catch {
        return null;
      }
    };

    const origin = getRemote('origin');
    const upstream = getRemote('upstream');
    const remoteOk =
      (origin !== null && remoteIsInstar(origin)) ||
      (upstream !== null && remoteIsInstar(upstream));
    if (!remoteOk) return false;

    try {
      const pkgPath = path.join(this.config.projectDir, 'package.json');
      if (!fs.existsSync(pkgPath)) return false;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
      return pkg.name === 'instar';
    } catch {
      return false;
    }
  }

  /**
   * Idempotently add a .gitignore entry. No-op if the entry is already
   * present as an active (non-comment, non-blank) line. Creates the file
   * if it doesn't exist. A comment line that happens to contain the entry
   * text is NOT treated as present — only exact-match active lines count.
   */
  private addGitignoreEntry(gitignorePath: string, entry: string, result: MigrationResult, label: string): void {
    try {
      let content = '';
      if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, 'utf-8');
      }

      const alreadyPresent = content.split('\n').some((line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) return false;
        return trimmed === entry;
      });
      if (alreadyPresent) return;

      let nextContent = content;
      if (nextContent.length > 0 && !nextContent.endsWith('\n')) {
        nextContent += '\n';
      }
      nextContent += entry + '\n';

      const dir = path.dirname(gitignorePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(gitignorePath, nextContent);
      result.upgraded.push(`${label}: added ${entry}`);
    } catch (err) {
      result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private removeGitignoreEntry(gitignorePath: string, entry: string, result: MigrationResult, label: string): void {
    if (!fs.existsSync(gitignorePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      if (!content.includes(entry)) {
        return;
      }

      // Remove the entry and any associated comment line above it
      const lines = content.split('\n');
      const filtered = lines.filter((line, i) => {
        if (line.trim() === entry) return false;
        // Remove comment line directly above the entry if it mentions "relationships" or "PII" or "Privacy"
        if (i < lines.length - 1 && lines[i + 1]?.trim() === entry &&
            line.startsWith('#') && /relationship|PII|Privacy/i.test(line)) {
          return false;
        }
        return true;
      });

      // Clean up double blank lines left behind
      const cleaned = filtered.join('\n').replace(/\n{3,}/g, '\n\n');
      fs.writeFileSync(gitignorePath, cleaned);
      result.upgraded.push(`${label}: un-ignored ${entry} (shared state for multi-machine)`);
    } catch (err) {
      result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Opt-in soul.md migration for existing agents.
   * Does NOT auto-create soul.md — adds config flag and queues notification.
   */
  private migrateSoulMd(result: MigrationResult): void {
    const soulPath = path.join(this.config.stateDir, 'soul.md');
    const configPath = path.join(this.config.stateDir, 'config.json');

    // Skip if soul.md already exists
    if (fs.existsSync(soulPath)) {
      return;
    }

    // Add identity.soulEnabled flag to config if not present
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.identity?.soulEnabled === undefined) {
          config.identity = config.identity || {};
          config.identity.soulEnabled = false;
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          result.upgraded.push('config: added identity.soulEnabled flag (opt-in, default false)');
        }
      }
    } catch (err) {
      result.errors.push(`soul.md config migration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Add Self-Observations and Identity History sections to existing AGENT.md.
   */
  private migrateAgentMdSections(result: MigrationResult): void {
    const agentMdPath = path.join(this.config.stateDir, 'AGENT.md');
    if (!fs.existsSync(agentMdPath)) return;

    try {
      let content = fs.readFileSync(agentMdPath, 'utf-8');
      let modified = false;

      if (!content.includes('## Self-Observations')) {
        // Add before ## Growth if it exists, otherwise append
        const growthIdx = content.indexOf('## Growth');
        if (growthIdx !== -1) {
          content = content.substring(0, growthIdx)
            + '## Self-Observations\n\n_Behavioral patterns I\'ve noticed in myself. Strengths, weaknesses, tendencies._\n\n<!-- Populated as the agent observes their own patterns across sessions. -->\n\n'
            + content.substring(growthIdx);
        } else {
          content += '\n\n## Self-Observations\n\n_Behavioral patterns I\'ve noticed in myself. Strengths, weaknesses, tendencies._\n\n<!-- Populated as the agent observes their own patterns across sessions. -->\n';
        }
        modified = true;
      }

      if (!content.includes('## Identity History')) {
        content += '\n\n## Identity History\n\n_When and why I changed this file._\n\n| Date | Change |\n|------|--------|\n<!-- Updated when the agent modifies their own identity. -->\n';
        modified = true;
      }

      if (modified) {
        fs.writeFileSync(agentMdPath, content);
        result.upgraded.push('AGENT.md: added Self-Observations and Identity History sections');
      }
    } catch (err) {
      result.errors.push(`AGENT.md migration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Hook Templates ─────────────────────────────────────────────────

  /**
   * Get the content of a named hook template.
   * Used by init.ts to share canonical hook content without duplication.
   */
  getHookContent(name: 'session-start' | 'compaction-recovery' | 'external-operation-gate' | 'deferral-detector' | 'post-action-reflection' | 'external-communication-guard' | 'scope-coherence-collector' | 'scope-coherence-checkpoint' | 'claim-intercept' | 'claim-intercept-response' | 'telegram-topic-context' | 'response-review' | 'auto-approve-permissions' | 'skill-usage-telemetry' | 'build-stop-hook'): string {
    switch (name) {
      case 'session-start': return this.getSessionStartHook();
      case 'compaction-recovery': return this.getCompactionRecovery();
      case 'external-operation-gate': return this.getExternalOperationGateHook();
      case 'deferral-detector': return this.getDeferralDetectorHook();
      case 'post-action-reflection': return this.getPostActionReflectionHook();
      case 'external-communication-guard': return this.getExternalCommunicationGuardHook();
      case 'scope-coherence-collector': return this.getScopeCoherenceCollectorHook();
      case 'scope-coherence-checkpoint': return this.getScopeCoherenceCheckpointHook();
      case 'claim-intercept': return this.getClaimInterceptHook();
      case 'claim-intercept-response': return this.getClaimInterceptResponseHook();
      case 'telegram-topic-context': return this.getTelegramTopicContextHook();
      case 'response-review': return this.getResponseReviewHook();
      case 'auto-approve-permissions': return this.getAutoApprovePermissionsHook();
      case 'skill-usage-telemetry': return this.getSkillUsageTelemetryHook();
      case 'build-stop-hook': return this.getBuildStopHook();
    }
  }

  /** Public accessor for grounding-before-messaging hook content (used by init.ts) */
  getGroundingBeforeMessagingPublic(): string {
    return this.getGroundingBeforeMessaging();
  }

  /** Public accessor for convergence-check script content (used by init.ts) */
  getConvergenceCheckPublic(): string {
    return this.getConvergenceCheck();
  }

  private getSessionStartHook(): string {
    return `#!/bin/bash
# Session start hook — injects identity context on session lifecycle events.
# Fires on: startup, resume, clear, compact (via SessionStart hook type)
#
# On startup/resume: outputs a compact identity summary
# On compact: delegates to compaction-recovery.sh for full injection
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
EVENT="\${CLAUDE_HOOK_MATCHER:-startup}"

# On compaction, delegate to the dedicated recovery hook
if [ "\$EVENT" = "compact" ]; then
  if [ -x "$INSTAR_DIR/hooks/compaction-recovery.sh" ]; then
    exec bash "$INSTAR_DIR/hooks/compaction-recovery.sh"
  fi
fi

# For startup/resume/clear — output a compact orientation
echo "=== SESSION START ==="

# TOPIC CONTEXT (loaded FIRST — highest priority context)
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  CONFIG_FILE="$INSTAR_DIR/config.json"
  if [ -f "\$CONFIG_FILE" ]; then
    PORT=\$(grep -o '"port":[0-9]*' "\$CONFIG_FILE" | head -1 | cut -d':' -f2)
    if [ -n "\$PORT" ]; then
      TOPIC_CTX=\$(curl -s "http://localhost:\${PORT}/topic/context/\${TOPIC_ID}?recent=30" 2>/dev/null)
      if [ -n "\$TOPIC_CTX" ] && echo "\$TOPIC_CTX" | grep -q '"totalMessages"'; then
        TOTAL=\$(echo "\$TOPIC_CTX" | grep -o '"totalMessages":[0-9]*' | cut -d':' -f2)
        TOPIC_NAME=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('topicName') or 'Unknown')" 2>/dev/null || echo "Unknown")
        echo ""
        echo "--- CONVERSATION CONTEXT (Topic: \${TOPIC_NAME}, \${TOTAL} total messages) ---"
        echo ""
        SUMMARY=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('summary'); print(s if s else '')" 2>/dev/null)
        if [ -n "\$SUMMARY" ]; then
          echo "SUMMARY OF CONVERSATION SO FAR:"
          echo "\$SUMMARY"
          echo ""
        fi
        echo "RECENT MESSAGES:"
        echo "\$TOPIC_CTX" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for m in d.get('recentMessages', []):
    sender = 'User' if m.get('fromUser') else 'Agent'
    ts = m.get('timestamp', '')[:16].replace('T', ' ')
    text = m.get('text', '')
    if len(text) > 500:
        text = text[:500] + '...'
    print(f'[{ts}] {sender}: {text}')
" 2>/dev/null
        echo ""
        echo "Search past conversations: curl http://localhost:\${PORT}/topic/search?topic=\${TOPIC_ID}&q=QUERY"
        echo "--- END CONVERSATION CONTEXT ---"
        echo ""
      fi
    fi
  fi
fi

# INTEGRATED-BEING LEDGER — cross-session observations (see docs/specs/integrated-being-ledger-v1.md)
# Fetches /shared-state/render and injects it if non-empty. Silent on absence /
# auth failure — endpoint returns 503 when disabled, empty body when enabled
# but has no entries. Either way we only echo when content is present.
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=\${PORT:-\$(grep -o '"port":[0-9]*' "$INSTAR_DIR/config.json" | head -1 | cut -d':' -f2)}
  TOKEN=\$(grep -o '"authToken":"[^"]*"' "$INSTAR_DIR/config.json" | head -1 | sed 's/"authToken":"//;s/"$//')
  if [ -n "\$PORT" ] && [ -n "\$TOKEN" ]; then
    SHARED_STATE=\$(curl -sf -H "Authorization: Bearer \$TOKEN" "http://localhost:\${PORT}/shared-state/render?limit=50" 2>/dev/null)
    if [ -n "\$SHARED_STATE" ]; then
      echo ""
      echo "--- INTEGRATED-BEING (cross-session observations) ---"
      echo "\$SHARED_STATE"
      echo "--- END INTEGRATED-BEING ---"
      echo ""
    fi
  fi
fi

# BEGIN integrated-being-v2
# INTEGRATED-BEING V2 — session-write binding (see docs/specs/integrated-being-ledger-v2.md §3)
# Generates a session UUID, registers with /shared-state/session-bind, writes the
# token file with mode 0o600 + atomic rename, writes .ready marker, confirms via
# session-bind-confirm. Silent on 503 (v2Enabled=false) — v1 behavior preserved.
# Section bounded by markers for inject-mode migration to re-update in place.
if [ -f "$INSTAR_DIR/config.json" ] && [ -n "\$PORT" ] && [ -n "\$TOKEN" ]; then
  SID=\$(python3 -c "import uuid; print(str(uuid.uuid4()))" 2>/dev/null)
  if [ -n "\$SID" ]; then
    BIND_RESP=\$(curl -sf -X POST -H "Authorization: Bearer \$TOKEN" -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"\$SID\\"}" \\
      "http://localhost:\${PORT}/shared-state/session-bind" 2>/dev/null)
    if [ -n "\$BIND_RESP" ] && echo "\$BIND_RESP" | grep -q '"token"'; then
      LEDGER_TOKEN=\$(echo "\$BIND_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)
      if [ -n "\$LEDGER_TOKEN" ]; then
        BIND_DIR="$INSTAR_DIR/session-binding"
        # Create dir under umask 077 to avoid a mode-race window where
        # a concurrent process could stat/listdir before chmod lands.
        ( umask 077; mkdir -p "\$BIND_DIR" )
        chmod 0700 "\$BIND_DIR" 2>/dev/null
        TOK_FILE="\$BIND_DIR/\${SID}.token"
        TMP_FILE="\${TOK_FILE}.tmp.\$\$"
        # Atomic write: umask-safe 0o600 mode, explicit chmod, fsync, rename.
        ( umask 077; printf '%s' "\$LEDGER_TOKEN" > "\$TMP_FILE" )
        chmod 0600 "\$TMP_FILE" 2>/dev/null
        python3 -c "import os,sys; fd=os.open('\$TMP_FILE', os.O_RDONLY); os.fsync(fd); os.close(fd)" 2>/dev/null
        mv "\$TMP_FILE" "\$TOK_FILE"
        chmod 0600 "\$TOK_FILE" 2>/dev/null
        # Mode verification — fail-CLOSED on anything other than 0600.
        MODE=\$(python3 -c "import os,stat; print(oct(stat.S_IMODE(os.stat('\$TOK_FILE').st_mode))[-4:])" 2>/dev/null)
        if [ "\$MODE" = "0600" ]; then
          touch "\$BIND_DIR/\${SID}.ready"
          chmod 0600 "\$BIND_DIR/\${SID}.ready" 2>/dev/null
          curl -sf -X POST -H "Authorization: Bearer \$TOKEN" -H "Content-Type: application/json" \\
            -d "{\\"sessionId\\":\\"\$SID\\"}" \\
            "http://localhost:\${PORT}/shared-state/session-bind-confirm" -o /dev/null 2>/dev/null || true
          export INSTAR_LEDGER_SESSION_ID="\$SID"
          export INSTAR_LEDGER_TOKEN_PATH="\$TOK_FILE"
        else
          # Mode mismatch → deny for this session's lifetime, clean up evidence.
          echo "[integrated-being-v2] token file mode \$MODE != 0600; denying session-write for this session" >&2
          rm -f "\$TOK_FILE"
        fi
      fi
    fi
  fi
fi
# END integrated-being-v2

# Identity summary (first 20 lines of AGENT.md — enough for name + role)
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  echo ""
  AGENT_NAME=\$(head -1 "$INSTAR_DIR/AGENT.md" | sed 's/^# //')
  echo "Identity: \$AGENT_NAME"
  # Output personality and principles sections
  sed -n '/^## Personality/,/^## [^P]/p' "$INSTAR_DIR/AGENT.md" 2>/dev/null | head -10
fi

# PROJECT MAP — spatial awareness of the working environment
if [ -f "$INSTAR_DIR/project-map.json" ]; then
  echo ""
  echo "--- PROJECT CONTEXT ---"
  python3 -c "
import json, sys
try:
    m = json.load(open('$INSTAR_DIR/project-map.json'))
    print(f'Project: {m[\"projectName\"]} ({m[\"projectType\"]})')
    print(f'Path: {m[\"projectDir\"]}')
    r = m.get('gitRemote')
    b = m.get('gitBranch')
    if r: print(f'Git: {r}' + (f' [{b}]' if b else ''))
    t = m.get('deploymentTargets', [])
    if t: print(f'Deploy targets: {(\", \").join(t)}')
    d = m.get('directories', [])
    print(f'Files: {m[\"totalFiles\"]} across {len(d)} directories')
    for dd in d[:6]:
        print(f'  {dd[\"name\"]}/ ({dd[\"fileCount\"]}) — {dd[\"description\"]}')
    if len(d) > 6: print(f'  ... and {len(d) - 6} more')
except Exception as e:
    print(f'(project map load failed: {e})', file=sys.stderr)
" 2>/dev/null
  echo "--- END PROJECT CONTEXT ---"
fi

# COHERENCE SCOPE — before ANY high-risk action, verify alignment
if [ -f "$INSTAR_DIR/config.json" ]; then
  echo ""
  echo "--- COHERENCE SCOPE ---"
  echo "BEFORE deploying, pushing, or modifying files outside this project:"
  echo "  1. Verify you are in the RIGHT project for the current topic/task"
  echo "  2. Check: curl -X POST http://localhost:\${PORT:-4040}/coherence/check \\\\"
  echo "       -H 'Content-Type: application/json' \\\\"
  echo "       -d '{\"action\":\"deploy\",\"context\":{\"topicId\":N}}'"
  echo "  3. If the check says BLOCK — STOP. You may be in the wrong project."
  echo "  4. Read the full reflection: POST /coherence/reflect"
  echo "--- END COHERENCE SCOPE ---"
fi

# Key files
echo ""
echo "Key files:"
[ -f "$INSTAR_DIR/AGENT.md" ] && echo "  .instar/AGENT.md — Your identity (read for full context)"
[ -f "$INSTAR_DIR/USER.md" ] && echo "  .instar/USER.md — Your collaborator"
[ -f "$INSTAR_DIR/MEMORY.md" ] && echo "  .instar/MEMORY.md — Persistent learnings"
[ -f "$INSTAR_DIR/project-map.md" ] && echo "  .instar/project-map.md — Project structure map"

# Relationship count
if [ -d "$INSTAR_DIR/relationships" ]; then
  REL_COUNT=\$(ls -1 "$INSTAR_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
  [ "\$REL_COUNT" -gt "0" ] && echo "  \${REL_COUNT} tracked relationships in .instar/relationships/"
fi

# Server status + self-discovery + feature awareness
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=\$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
  if [ "\$HEALTH" = "200" ]; then
    echo ""
    echo "Instar server: RUNNING on port \${PORT}"
    # Reset scope coherence state — prevents accumulated counts from prior sessions
    # leaking into this session and causing false-positive hook triggers.
    # Endpoint: POST /scope-coherence/reset (routes.ts)
    curl -s -X POST "http://localhost:\${PORT}/scope-coherence/reset" -o /dev/null 2>/dev/null || true
    # Load full capabilities for tunnel + feature guide
    CAPS=\$(curl -s "http://localhost:\${PORT}/capabilities" 2>/dev/null)
    TUNNEL_URL=\$(echo "\$CAPS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tunnel',{}).get('url',''))" 2>/dev/null)
    [ -n "\$TUNNEL_URL" ] && echo "Cloudflare Tunnel active: \$TUNNEL_URL"
    # Inject feature guide — proactive capability awareness at every session start
    if echo "\$CAPS" | grep -q '"featureGuide"'; then
      echo ""
      echo "--- YOUR CAPABILITIES (use these proactively when context matches) ---"
      echo "\$CAPS" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    guide = d.get('featureGuide', {})
    triggers = guide.get('triggers', [])
    if triggers:
        for t in triggers:
            print(f'  When: {t[\"context\"]}')
            print(f'  Do:   {t[\"action\"]}')
            print()
except: pass
" 2>/dev/null
      echo "--- END CAPABILITIES ---"
    fi

    # Context dispatch table — structural "when X, look at Y" routing
    # Structure > Willpower: instead of burying this in a 600-line CLAUDE.md,
    # inject it at session start so the agent sees it before doing anything.
    DISPATCH_FILE="$INSTAR_DIR/context/DISPATCH.md"
    if [ -f "\$DISPATCH_FILE" ]; then
      echo ""
      echo "--- CONTEXT DISPATCH (when X arises, read Y) ---"
      cat "\$DISPATCH_FILE" | head -20
      echo "--- END CONTEXT DISPATCH ---"
    fi
  else
    echo ""
    echo "Instar server: NOT RUNNING (port \${PORT})"
  fi
fi

echo ""
echo "IMPORTANT: To report bugs or request features, use POST /feedback on your local server."

# Working Memory — surface relevant knowledge from SemanticMemory + EpisodicMemory
# Right context at the right moment: query-driven, not a full dump.
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=\$(grep -o '"port":[0-9]*' "$INSTAR_DIR/config.json" | head -1 | cut -d':' -f2)
  if [ -n "\$PORT" ]; then
    AUTH_TOKEN=\$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('authToken',''))" 2>/dev/null)
    HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
    if [ "\$HEALTH" = "200" ]; then
      # Build query from available context signals
      QUERY_PARTS=""
      [ -n "\$INSTAR_TELEGRAM_TOPIC" ] && QUERY_PARTS="topic:\${INSTAR_TELEGRAM_TOPIC} "
      WM_PROMPT=\$(echo "\${QUERY_PARTS}\${CLAUDE_SESSION_GOAL:-session-start}" | python3 -c "import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read()[:300].strip()))" 2>/dev/null)
      WORKING_MEM=\$(curl -s -H "Authorization: Bearer \${AUTH_TOKEN}" \
        "http://localhost:\${PORT}/context/working-memory?prompt=\${WM_PROMPT}&limit=8" 2>/dev/null)
      if [ -n "\$WORKING_MEM" ]; then
        WM_CONTEXT=\$(echo "\$WORKING_MEM" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ctx = data.get('context', '').strip()
    tokens = data.get('estimatedTokens', 0)
    sources = data.get('sources', [])
    if ctx and tokens > 0:
        src_summary = ', '.join(f'{s[\"count\"]} {s[\"name\"]}' for s in sources if s.get('count', 0) > 0)
        print(f'[{tokens} tokens from: {src_summary}]')
        print()
        print(ctx)
except Exception:
    pass
" 2>/dev/null)
        if [ -n "\$WM_CONTEXT" ]; then
          echo ""
          echo "--- WORKING MEMORY (relevant knowledge for this session) ---"
          echo "\$WM_CONTEXT"
          echo "--- END WORKING MEMORY ---"
        fi
      fi
    fi
  fi
fi

# Telegram relay instructions (structural — ensures EVERY Telegram session knows how to respond)
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  RELAY_SCRIPT=""
  [ -f "$INSTAR_DIR/scripts/telegram-reply.sh" ] && RELAY_SCRIPT=".instar/scripts/telegram-reply.sh"
  [ -z "\$RELAY_SCRIPT" ] && [ -f "\${CLAUDE_PROJECT_DIR:-.}/.claude/scripts/telegram-reply.sh" ] && RELAY_SCRIPT=".claude/scripts/telegram-reply.sh"
  echo ""
  echo "--- TELEGRAM SESSION (topic \${TOPIC_ID}) ---"
  echo "MANDATORY: After EVERY response, relay conversational text back to Telegram:"
  echo "  cat <<'EOF' | \${RELAY_SCRIPT:-'.instar/scripts/telegram-reply.sh'} \${TOPIC_ID}"
  echo "  Your response text here"
  echo "  EOF"
  echo "Strip the [telegram:\${TOPIC_ID}] prefix before interpreting messages."
  echo "If a thread history file is referenced, READ IT FIRST before responding."
  echo "--- END TELEGRAM SESSION ---"
fi

# Pending upgrade guide — inject knowledge from the latest update
GUIDE_FILE="$INSTAR_DIR/state/pending-upgrade-guide.md"
if [ -f "\$GUIDE_FILE" ]; then
  echo ""
  echo "=== UPGRADE GUIDE (ACTION REQUIRED) ==="
  echo ""
  echo "A new version of Instar was installed with upgrade instructions."
  echo "You MUST do the following:"
  echo ""
  echo "1. Read the full upgrade guide below"
  echo "2. Take any suggested actions that apply to YOUR situation"
  echo "3. MESSAGE YOUR USER about what's new:"
  echo "   - Compose a brief, personalized message highlighting the features"
  echo "     that matter most to THEM and their specific use case"
  echo "   - Explain what each feature means in practical terms — how they"
  echo "     can take advantage of it, what it changes for them"
  echo "   - Skip internal plumbing details — focus on what the user will"
  echo "     notice, benefit from, or need to configure"
  echo "   - Send this message to the user via Telegram (Agent Updates topic)"
  echo "   - NEVER send updates to Agent Attention — that's for critical/blocking items only"
  echo "   - Use your knowledge of your user to personalize — you know their"
  echo "     workflow, their priorities, what they care about"
  echo "4. UPDATE YOUR MEMORY with the new capabilities:"
  echo "   - Read the upgrade guide's 'Summary of New Capabilities' section"
  echo "   - Add the relevant capabilities to your .instar/MEMORY.md file"
  echo "   - Focus on WHAT you can now do and HOW to use it"
  echo "   - If similar notes exist in MEMORY.md, update rather than duplicate"
  echo "   - This ensures you KNOW about these capabilities in every future session"
  echo "5. After messaging the user and updating memory, run: instar upgrade-ack"
  echo ""
  echo "--- UPGRADE GUIDE CONTENT ---"
  echo ""
  cat "\$GUIDE_FILE"
  echo ""
  echo "--- END UPGRADE GUIDE CONTENT ---"
  echo "=== END UPGRADE GUIDE ==="
fi

echo "=== END SESSION START ==="
`;
  }

  private getDangerousCommandGuard(): string {
    return `#!/bin/bash
# Dangerous command guard — safety infrastructure for autonomous agents.
# Supports safety.level in .instar/config.json:
#   Level 1 (default): Block and ask user. Level 2: Agent self-verifies.
INPUT="$1"
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"

# Read safety level from config
SAFETY_LEVEL=1
if [ -f "$INSTAR_DIR/config.json" ]; then
  SAFETY_LEVEL=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('safety', {}).get('level', 1))" 2>/dev/null || echo "1")
fi

# ALWAYS blocked (catastrophic, irreversible)
for pattern in "rm -rf /" "rm -rf ~" "> /dev/sda" "mkfs\\." "dd if=" ":(){:|:&};:"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    echo "BLOCKED: Catastrophic command detected: $pattern" >&2
    echo "Always blocked regardless of safety level. User must execute directly." >&2
    exit 2
  fi
done

# Deployment/push commands — check coherence gate first
for pattern in "vercel deploy" "vercel --prod" "git push" "npm publish" "npx wrangler deploy" "fly deploy" "railway up"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    if [ -f "$INSTAR_DIR/config.json" ]; then
      PORT=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
      TOPIC_ID="\${INSTAR_TELEGRAM_TOPIC:-}"
      ACTION="deploy"
      echo "$INPUT" | grep -qi "git push" && ACTION="git-push"
      echo "$INPUT" | grep -qi "npm publish" && ACTION="git-push"
      CTX="{}"
      [ -n "$TOPIC_ID" ] && CTX="{\\\"topicId\\\": $TOPIC_ID}"
      CHECK=$(curl -s -X POST "http://localhost:$PORT/coherence/check" -H 'Content-Type: application/json' -d "{\\\"action\\\":\\\"$ACTION\\\",\\\"context\\\":$CTX}" 2>/dev/null)
      if echo "$CHECK" | grep -q '"recommendation":"block"'; then
        SUMMARY=$(echo "$CHECK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary','Coherence check failed'))" 2>/dev/null || echo "Coherence check failed")
        echo "BLOCKED: Coherence gate blocked this action." >&2
        echo "$SUMMARY" >&2
        echo "Run POST /coherence/reflect for a detailed self-verification checklist." >&2
        exit 2
      fi
    fi
  fi
done

# Risky commands — behavior depends on safety level
for pattern in "rm -rf \\." "git push --force" "git push -f" "git reset --hard" "git clean -fd" "DROP TABLE" "DROP DATABASE" "TRUNCATE" "DELETE FROM"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    if [ "$SAFETY_LEVEL" -eq 1 ]; then
      echo "BLOCKED: Potentially destructive command detected: $pattern" >&2
      echo "Authorization required: Ask the user whether to proceed with this operation." >&2
      echo "Once they confirm, YOU execute the command — never ask the user to run it themselves." >&2
      exit 2
    else
      IDENTITY=""
      if [ -f "$INSTAR_DIR/AGENT.md" ]; then
        IDENTITY=$(head -20 "$INSTAR_DIR/AGENT.md" | tr '\\n' ' ')
      fi
      echo "{\\"decision\\":\\"approve\\",\\"additionalContext\\":\\"=== SELF-VERIFICATION REQUIRED ===\\\\nDestructive command detected: $pattern\\\\n\\\\n1. Is this necessary for the current task?\\\\n2. What are the consequences if this goes wrong?\\\\n3. Is there a safer alternative?\\\\n4. Does this align with your principles?\\\\n\\\\nIdentity: $IDENTITY\\\\n\\\\nIf ALL checks pass, proceed. If ANY fails, stop.\\\\n=== END SELF-VERIFICATION ===\\"}"
      exit 0
    fi
  fi
done
`;
  }

  private getGroundingBeforeMessaging(): string {
    return `#!/bin/bash
# Grounding before messaging — ensures the agent is grounded and message is
# quality-checked before sending any external communication.
#
# Three-phase defense:
# 1. Identity injection — re-ground the agent in who they are
# 2. Convergence check — heuristic quality gate on the message content
# 3. URL provenance — verify URLs aren't fabricated
#
# Structure > Willpower: these checks run automatically before
# external messaging, not when the agent remembers to do them.
#
# The 164th Lesson (Dawn): Advisory hooks are insufficient.
# Grounding must be automatic — content injected, not pointed to.
#
# Installed by instar during setup. Runs as a Claude Code PreToolUse hook on Bash.

INPUT="$1"

# Detect messaging commands (telegram-reply, email sends, API message posts, etc.)
if echo "$INPUT" | grep -qE "(telegram-reply|send-email|send-message|POST.*/telegram/reply|POST.*/message|/reply)"; then
  INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
  SCRIPTS_DIR="$INSTAR_DIR/scripts"

  # Phase 1: Identity injection (Structure > Willpower — output content, not pointers)
  if [ -f "$INSTAR_DIR/AGENT.md" ]; then
    echo "=== PRE-MESSAGE GROUNDING ==="
    echo ""
    echo "--- YOUR IDENTITY ---"
    cat "$INSTAR_DIR/AGENT.md"
    echo ""
    echo "--- END IDENTITY ---"
    echo ""
  fi

  # Phase 2: Convergence check (heuristic quality gate)
  if [ -f "$SCRIPTS_DIR/convergence-check.sh" ]; then
    # Pipe the full tool input through the convergence check.
    # The check looks for common agent failure modes (capability claims,
    # sycophancy, settling, experiential fabrication, commitment overreach,
    # URL provenance).
    CHECK_RESULT=$(echo "$INPUT" | bash "$SCRIPTS_DIR/convergence-check.sh" 2>&1)
    CHECK_EXIT=$?

    if [ "$CHECK_EXIT" -ne "0" ]; then
      echo "$CHECK_RESULT"
      echo ""
      echo "=== MESSAGE BLOCKED — Review and revise before sending. ==="
      exit 2
    fi
  fi

  echo "=== GROUNDED — Proceed with message. ==="
fi
`;
  }

  private getConvergenceCheckInline(): string {
    // Inline fallback — used if template file can't be found.
    // The primary getConvergenceCheck() reads from the template file.
    const script = [
      '#!/bin/bash',
      '# Lightweight convergence check — heuristic content quality gate before messaging.',
      '# No LLM calls. Fast. Catches the most common agent failure modes.',
      '#',
      '# Usage: echo "message content" | bash .instar/scripts/convergence-check.sh',
      '# Exit codes: 0 = converged (safe to send), 1 = issues found (review needed)',
      '#',
      '# Checks 7 criteria via pattern matching:',
      '#',
      '# 1. capability_claims — Claims about what the agent can\'t do (may be wrong)',
      '# 2. commitment_overreach — Promises the agent may not be able to keep',
      '# 3. settling — Accepting empty/failed results without investigation',
      '# 4. experiential_fabrication — Claiming to see/read/feel without verification',
      '# 5. sycophancy — Reflexive agreement, excessive apology, capitulation',
      '# 6. url_provenance — URLs with unfamiliar domains that may be fabricated',
      '# 7. temporal_staleness — Language suggesting outdated perspective or stale draft',
      '#',
      '# This is Structure > Willpower: the check runs automatically before',
      '# external messaging, not when the agent remembers to do it.',
      '',
      'CONTENT=$(cat)',
      'ISSUES=()',
      'ISSUE_COUNT=0',
      '',
      '# 1. CAPABILITY CLAIMS — Watch for "I can\'t" / "I don\'t have" / "not available"',
      'if echo "$CONTENT" | grep -qiE "(unfortunately.{0,20}(i can.t|i.m unable|not (possible|available|supported))|i don.t have (the ability|access|a way)|this (isn.t|is not) (possible|available|supported))"; then',
      '  ISSUES+=("CAPABILITY: You\'re claiming a limitation. Did you check /capabilities first? Many \'I can\'t\' statements are wrong — verify before sending.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# 2. COMMITMENT OVERREACH — Promises that may not survive session boundaries',
      'if echo "$CONTENT" | grep -qiE "(i.ll (make sure|ensure|guarantee|always|never forget)|i (promise|commit to|will always)|you can count on me to|i.ll remember (to|this)|from now on i.ll)"; then',
      '  ISSUES+=("COMMITMENT: You\'re making a promise that may not survive context compaction or session end. Can your infrastructure actually keep this commitment? If not, reframe as intent rather than guarantee.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# 3. SETTLING — Accepting empty results without digging deeper',
      'if echo "$CONTENT" | grep -qiE "(no (data|results|information) (available|found|exists)|nothing (to report|happened|was found)|there (is|are) no|could(n.t| not) find (any|the)|appears to be empty|no (relevant|matching|applicable))"; then',
      '  ISSUES+=("SETTLING: You\'re reporting nothing found. Did you check multiple sources? Could the data source be stale or the search terms wrong? Empty results deserve investigation, not acceptance.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# 4. EXPERIENTIAL FABRICATION — Claiming first-person experience without tool verification',
      'if echo "$CONTENT" | grep -qiE "(i (can see|noticed|observed|felt|sensed|perceived) (that |the |a |an )|looking at (this|the|your)|from what i.ve (seen|read|observed)|i.ve (reviewed|examined|analyzed|inspected) (the|your|this))"; then',
      '  ISSUES+=("EXPERIENTIAL: You\'re claiming a first-person experience. Did you actually access this data with a tool in THIS session, or are you completing a social script? Verify before claiming.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# 5. SYCOPHANCY — Reflexive agreement, excessive apology',
      'if echo "$CONTENT" | grep -qiE "(you.re (absolutely|totally|completely) right|i (completely|totally|fully) (agree|understand)|great (question|point|observation)|i apologize for|sorry.{0,20}(mistake|confusion|error|oversight)|that.s (a |an )?(excellent|great|wonderful|fantastic) (point|question|idea|suggestion))"; then',
      '  ISSUES+=("SYCOPHANCY: You may be reflexively agreeing or over-apologizing. If you genuinely agree, state why. If you don\'t fully agree, say what you actually think. Politeness is not a substitute for honesty.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# 6. URL PROVENANCE — URLs with unfamiliar domains may be fabricated',
      '# Common confabulation: agent constructs plausible URL from project name',
      '# (e.g., "deepsignal.xyz" from project "deep-signal"). Catch and require verification.',
      'URLS_IN_MSG=$(echo "$CONTENT" | grep -oE \'https?://[^ )"' + "'" + '>]+\' 2>/dev/null || true)',
      'if [ -n "$URLS_IN_MSG" ]; then',
      '  UNFAMILIAR_URLS=""',
      '  while IFS= read -r url; do',
      '    [ -z "$url" ] && continue',
      '    # Skip well-known service domains',
      '    if echo "$url" | grep -qE \'(github\\.com|vercel\\.app|vercel\\.com|netlify\\.app|netlify\\.com|npmjs\\.com|npmjs\\.org|cloudflare\\.com|google\\.com|twitter\\.com|x\\.com|youtube\\.com|reddit\\.com|discord\\.com|discord\\.gg|telegram\\.org|t\\.me|localhost|127\\.0\\.0\\.1|stackoverflow\\.com|developer\\.mozilla\\.org|docs\\.anthropic\\.com|anthropic\\.com|openai\\.com|claude\\.ai|notion\\.so|linear\\.app|fly\\.io|render\\.com|railway\\.app|heroku\\.com|amazonaws\\.com|azure\\.com|gitlab\\.com|bitbucket\\.org|docker\\.com|hub\\.docker\\.com|pypi\\.org|crates\\.io|rubygems\\.org|pkg\\.go\\.dev|wikipedia\\.org|medium\\.com|substack\\.com|circle\\.so|ghost\\.io|telegraph\\.ph)\'; then',
      '      continue',
      '    fi',
      '    UNFAMILIAR_URLS="$UNFAMILIAR_URLS  $url\\n"',
      '  done <<< "$URLS_IN_MSG"',
      '',
      '  if [ -n "$UNFAMILIAR_URLS" ]; then',
      '    ISSUES+=("URL_PROVENANCE: Your message contains URLs with unfamiliar domains:\\n${UNFAMILIAR_URLS}Before including a URL, verify it appeared in actual tool output in THIS session OR confirm it resolves with curl. A common confabulation: constructing domains from project names (e.g., \'deepsignal.xyz\' from project \'deep-signal\').")',
      '    ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      '  fi',
      'fi',
      '',
      '# 7. TEMPORAL STALENESS — Language suggesting outdated perspective or stale draft',
      'if echo "$CONTENT" | grep -qiE "(i used to (think|believe|feel|assume)|back when i (first|started|was new)|at (that|the) time i|my (early|earlier|initial|original|first) (understanding|thinking|view|perspective|approach)|i didn.t yet understand|before i (learned|realized|discovered|knew)|i (once|previously) (thought|believed|felt)|this was (before|when) i)"; then',
      '  ISSUES+=("TEMPORAL: Your message references past understanding or earlier perspectives. Is this content from an older draft? If your thinking has evolved since writing this, revise to reflect your current understanding before publishing.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# Output results',
      'if [ "$ISSUE_COUNT" -gt "0" ]; then',
      '  echo "=== CONVERGENCE CHECK: ${ISSUE_COUNT} ISSUE(S) FOUND ==="',
      '  echo ""',
      '  for ISSUE in "${ISSUES[@]}"; do',
      '    echo "  - $ISSUE"',
      '    echo ""',
      '  done',
      '  echo "Review and revise before sending. Re-run this check after revision."',
      '  echo "=== END CONVERGENCE CHECK ==="',
      '  exit 1',
      'else',
      '  exit 0',
      'fi',
    ].join('\n');
    return script;
  }

  private getTelegramTopicContextHook(): string {
    return `#!/bin/bash
# UserPromptSubmit Hook: Auto-inject Telegram topic history context.
#
# When a user prompt contains [telegram:N], this hook reads the recent
# conversation history for that topic and injects it as context. Also
# detects unanswered user messages and surfaces them with directives.
#
# This prevents the "what are we talking about?" failure after compaction
# or session restart — where the agent receives a message without
# conversation context and responds with a generic greeting.

# Read the user prompt from stdin (Claude Code pipes JSON with { prompt: "..." })
USER_PROMPT=\$(python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('prompt', ''))
except:
    print('')
" 2>/dev/null)

# Check for [telegram:N] prefix
TOPIC_ID=\$(echo "\$USER_PROMPT" | python3 -c "
import sys, re
line = sys.stdin.read()
m = re.search(r'\\\\[telegram:(\\\\d+)', line)
if m:
    print(m.group(1))
" 2>/dev/null)

if [ -z "\$TOPIC_ID" ]; then
  exit 0
fi

# Get server port from config
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
CONFIG_FILE="\$INSTAR_DIR/config.json"

if [ ! -f "\$CONFIG_FILE" ]; then
  exit 0
fi

PORT=\$(grep -o '"port":[0-9]*' "\$CONFIG_FILE" | head -1 | cut -d':' -f2)
if [ -z "\$PORT" ]; then
  exit 0
fi

# Check server health
HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
if [ "\$HEALTH" != "200" ]; then
  exit 0
fi

# Fetch recent messages for this topic
AUTH_TOKEN=\$(python3 -c "import json; print(json.load(open('\$CONFIG_FILE')).get('authToken',''))" 2>/dev/null)
if [ -n "\$AUTH_TOKEN" ]; then
  RECENT_MSGS=\$(curl -s \\
    -H "Authorization: Bearer \${AUTH_TOKEN}" \\
    "http://localhost:\${PORT}/telegram/topics/\${TOPIC_ID}/messages?limit=15" 2>/dev/null)
else
  RECENT_MSGS=\$(curl -s \\
    "http://localhost:\${PORT}/telegram/topics/\${TOPIC_ID}/messages?limit=15" 2>/dev/null)
fi

# Format and output context with unanswered message detection
echo "\$RECENT_MSGS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    msgs = data.get('messages', [])
    if not msgs:
        sys.exit(0)

    print('TOPIC \${TOPIC_ID} RECENT HISTORY (auto-injected):')

    for m in msgs:
        ts = m.get('timestamp', '')[:16].replace('T', ' ')
        from_user = m.get('fromUser', m.get('direction', 'in') == 'in')
        text = m.get('text', '').strip()
        sender = 'User' if from_user else 'Agent'
        if len(text) > 300:
            text = text[:297] + '...'
        print(f'  [{ts}] {sender}: {text}')

    # Detect unanswered user messages
    pending_user = []
    for m in msgs:
        text = m.get('text', '').strip()
        if not text:
            continue
        from_user = m.get('fromUser', m.get('direction', 'in') == 'in')
        if from_user:
            pending_user.append(m)
        else:
            pending_user = []

    if pending_user:
        print()
        print('*** UNANSWERED MESSAGE(S) FROM USER ***')
        for pm in pending_user:
            pm_text = pm.get('text', '')[:200]
            pm_ts = pm.get('timestamp', '')[:16].replace('T', ' ')
            print(f'  [{pm_ts}] \\\\\\\"{pm_text}\\\\\\\"')
        print()
        print('You MUST address these messages substantively. Do NOT respond with just')
        print('a greeting or generic reply. Read the conversation history above and')
        print('respond to what the user actually said. If the current message is a')
        print('follow-up like \\\\\\\"hello?\\\\\\\" or \\\\\\\"please respond\\\\\\\", address the EARLIER')
        print('unanswered message — that is what the user is waiting for.')
except Exception:
    pass
" 2>/dev/null

exit 0
`;
  }

  private getCompactionRecovery(): string {
    return `#!/bin/bash
# Compaction recovery — re-injects identity AND topic context when Claude's context compresses.
# Born from Dawn's 164th Lesson: "Advisory hooks get ignored. Automatic content
# injection removes the compliance gap entirely."
#
# This hook OUTPUTS identity content directly into context rather than just
# pointing to files. After compaction, the agent needs to KNOW who it is
# AND what conversation it's in — not be told where to look.
#
# Context priority (same as session-start):
#   1. Topic context (summary + recent messages) — what are we working on?
#   2. Identity (AGENT.md) — who am I?
#   3. Memory (MEMORY.md) — what have I learned?
#   4. Telegram relay — how do I respond?
#   5. Capabilities — what can I do?
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"

echo "=== IDENTITY RECOVERY (post-compaction) ==="

# ── 1. TOPIC CONTEXT (highest priority — what are we working on?) ──
# After compaction, the conversation history is lost. Re-inject it from TopicMemory.
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  CONFIG_FILE="\$INSTAR_DIR/config.json"
  if [ -f "\$CONFIG_FILE" ]; then
    PORT=\$(grep -o '"port":[0-9]*' "\$CONFIG_FILE" | head -1 | cut -d':' -f2)
    if [ -n "\$PORT" ]; then
      TOPIC_CTX=\$(curl -s "http://localhost:\${PORT}/topic/context/\${TOPIC_ID}?recent=20" 2>/dev/null)
      if [ -n "\$TOPIC_CTX" ] && echo "\$TOPIC_CTX" | grep -q '"totalMessages"'; then
        TOTAL=\$(echo "\$TOPIC_CTX" | grep -o '"totalMessages":[0-9]*' | cut -d':' -f2)
        TOPIC_NAME=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('topicName') or 'Unknown')" 2>/dev/null || echo "Unknown")

        echo ""
        echo "--- CONVERSATION CONTEXT (Topic: \${TOPIC_NAME}, \${TOTAL} total messages) ---"
        echo ""

        SUMMARY=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('summary'); print(s if s else '')" 2>/dev/null)
        if [ -n "\$SUMMARY" ]; then
          echo "SUMMARY OF CONVERSATION SO FAR:"
          echo "\$SUMMARY"
          echo ""
        fi

        echo "RECENT MESSAGES:"
        echo "\$TOPIC_CTX" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = d.get('recentMessages', [])
for m in msgs:
    sender = 'User' if m.get('fromUser') else 'Agent'
    ts = m.get('timestamp', '')[:16].replace('T', ' ')
    text = m.get('text', '')
    if len(text) > 500:
        text = text[:500] + '...'
    print(f'[{ts}] {sender}: {text}')

# Detect unanswered user messages
pending_user = []
for m in msgs:
    text = m.get('text', '').strip()
    if not text:
        continue
    if m.get('fromUser'):
        pending_user.append(m)
    else:
        pending_user = []

if pending_user:
    print()
    print('!' * 60)
    print('UNANSWERED MESSAGE(S) FROM USER:')
    for pm in pending_user:
        pm_text = pm.get('text', '')[:200]
        pm_ts = pm.get('timestamp', '')[:16].replace('T', ' ')
        print(f'  [{pm_ts}] \\\"{pm_text}\\\"')
    print()
    print('You MUST address these messages substantively. Do NOT respond')
    print('with just a greeting or generic reply. If the latest message')
    print('is a follow-up like \\\"hello?\\\" or \\\"please respond\\\", address')
    print('the EARLIER unanswered message — that is what the user is')
    print('waiting for.')
    print('!' * 60)
" 2>/dev/null
        echo ""
        echo "Search past conversations: curl http://localhost:\${PORT}/topic/search?topic=\${TOPIC_ID}&q=QUERY"
        echo "--- END CONVERSATION CONTEXT ---"
        echo ""
      fi
    fi
  fi
fi

# ── 2. IDENTITY (full AGENT.md — who am I?) ──
if [ -f "\$INSTAR_DIR/AGENT.md" ]; then
  echo ""
  echo "--- Your Identity (from .instar/AGENT.md) ---"
  cat "\$INSTAR_DIR/AGENT.md"
  echo ""
  echo "--- End Identity ---"
fi

# ── 2b. PROJECT CONTEXT (where am I working?) ──
if [ -f "\$INSTAR_DIR/project-map.json" ]; then
  echo ""
  echo "--- PROJECT CONTEXT ---"
  python3 -c "
import json, sys
try:
    m = json.load(open('\$INSTAR_DIR/project-map.json'))
    print(f'Project: {m[\"projectName\"]} ({m[\"projectType\"]})')
    print(f'Path: {m[\"projectDir\"]}')
    r = m.get('gitRemote')
    b = m.get('gitBranch')
    if r: print(f'Git: {r}' + (f' [{b}]' if b else ''))
    t = m.get('deploymentTargets', [])
    if t: print(f'Deploy targets: {(\", \").join(t)}')
    print(f'Files: {m[\"totalFiles\"]} across {len(m.get(\"directories\", []))} directories')
except Exception as e:
    print(f'(project map load failed: {e})', file=sys.stderr)
" 2>/dev/null
  echo "--- END PROJECT CONTEXT ---"
fi

# ── 3. MEMORY (first 50 lines — what have I learned?) ──
if [ -f "\$INSTAR_DIR/MEMORY.md" ]; then
  LINES=\$(wc -l < "\$INSTAR_DIR/MEMORY.md" | tr -d ' ')
  echo ""
  echo "--- Your Memory (.instar/MEMORY.md — \${LINES} lines, showing first 50) ---"
  head -50 "\$INSTAR_DIR/MEMORY.md"
  if [ "\$LINES" -gt 50 ]; then
    echo "... (\$((LINES - 50)) more lines — read full file if needed)"
  fi
  echo "--- End Memory ---"
fi

# ── 4. TELEGRAM RELAY (how do I respond?) ──
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  RELAY_SCRIPT=""
  if [ -f "\$INSTAR_DIR/scripts/telegram-reply.sh" ]; then
    RELAY_SCRIPT=".instar/scripts/telegram-reply.sh"
  elif [ -f "\${CLAUDE_PROJECT_DIR:-.}/.claude/scripts/telegram-reply.sh" ]; then
    RELAY_SCRIPT=".claude/scripts/telegram-reply.sh"
  fi

  echo ""
  echo "--- TELEGRAM SESSION (topic \${TOPIC_ID}) ---"
  echo "This session is connected to Telegram topic \${TOPIC_ID}."
  echo "Messages arrive prefixed with [telegram:\${TOPIC_ID}]. Strip prefix before interpreting."
  echo "After EVERY response, relay your text back:"
  if [ -n "\$RELAY_SCRIPT" ]; then
    echo "  cat <<'EOF' | \${RELAY_SCRIPT} \${TOPIC_ID}"
  else
    echo "  cat <<'EOF' | .instar/scripts/telegram-reply.sh \${TOPIC_ID}"
  fi
  echo "  Your response text here"
  echo "  EOF"
  echo "--- END TELEGRAM SESSION ---"
fi

# ── 5. SERVER STATUS + CAPABILITIES ──
CONFIG_FILE="\$INSTAR_DIR/config.json"
if [ -f "\$CONFIG_FILE" ]; then
  PORT=\$(python3 -c "import json; print(json.load(open('\$CONFIG_FILE')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
  if [ "\$HEALTH" = "200" ]; then
    echo ""
    echo "Instar server: RUNNING on port \${PORT}"
    CAPS=\$(curl -s "http://localhost:\${PORT}/capabilities" 2>/dev/null)
    if echo "\$CAPS" | grep -q '"featureGuide"' 2>/dev/null; then
      echo ""
      echo "--- YOUR CAPABILITIES ---"
      echo "\$CAPS" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    guide = d.get('featureGuide', {})
    for t in guide.get('triggers', []):
        print(f'  When: {t[\"context\"]}')
        print(f'  Do:   {t[\"action\"]}')
        print()
except: pass
" 2>/dev/null
      echo "--- END CAPABILITIES ---"
    fi

    # Context dispatch table — structural "when X, read Y" routing
    DISPATCH_FILE="\$INSTAR_DIR/context/DISPATCH.md"
    if [ -f "\$DISPATCH_FILE" ]; then
      echo ""
      echo "--- CONTEXT DISPATCH (when X arises, read Y) ---"
      cat "\$DISPATCH_FILE" | head -20
      echo "--- END CONTEXT DISPATCH ---"
    fi
  else
    echo ""
    echo "Instar server: NOT RUNNING (port \${PORT})"
  fi
fi

echo ""

# Working Memory — surface relevant knowledge after compaction
# This restores what you knew before compaction that's relevant now.
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=\$(grep -o '"port":[0-9]*' "$INSTAR_DIR/config.json" | head -1 | cut -d':' -f2)
  if [ -n "\$PORT" ]; then
    AUTH_TOKEN=\$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('authToken',''))" 2>/dev/null)
    HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
    if [ "\$HEALTH" = "200" ]; then
      WM_QUERY=\$(python3 -c "import urllib.parse; print(urllib.parse.quote('compaction-recovery context-restoration'))" 2>/dev/null)
      WORKING_MEM=\$(curl -s -H "Authorization: Bearer \${AUTH_TOKEN}" \
        "http://localhost:\${PORT}/context/working-memory?prompt=\${WM_QUERY}&limit=6" 2>/dev/null)
      if [ -n "\$WORKING_MEM" ]; then
        WM_CONTEXT=\$(echo "\$WORKING_MEM" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ctx = data.get('context', '').strip()
    tokens = data.get('estimatedTokens', 0)
    sources = data.get('sources', [])
    if ctx and tokens > 0:
        src_summary = ', '.join(f'{s[\\\"count\\\"]} {s[\\\"name\\\"]}' for s in sources if s.get('count', 0) > 0)
        print(f'[{tokens} tokens from: {src_summary}]')
        print()
        print(ctx)
except Exception:
    pass
" 2>/dev/null)
        if [ -n "\$WM_CONTEXT" ]; then
          echo "--- WORKING MEMORY RESTORED ---"
          echo "\$WM_CONTEXT"
          echo "--- END WORKING MEMORY ---"
          echo ""
        fi
      fi
    fi
  fi
fi

echo "=== END IDENTITY RECOVERY ==="
`;
  }

  private getDeferralDetectorHook(): string {
    return `#!/usr/bin/env node
// Deferral detector — catches agents deferring work they could do themselves.
// PreToolUse hook for Bash commands. Scans outgoing messages for deferral patterns.
// When detected, injects a due diligence checklist (does NOT block).
//
// Born from an agent saying "This is credential input I cannot do myself"
// when it already had the token available via CLI tools.

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Only check communication commands (messages to humans)
    const commPatterns = [
      /telegram-reply/i, /send-email/i, /send-message/i,
      /POST.*\\/telegram\\/reply/i, /slack.*send/i
    ];
    if (!commPatterns.some(p => p.test(command))) process.exit(0);

    // Exempt: genuinely human-only actions
    if (/password|captcha|legal|billing|payment credential/i.test(command)) process.exit(0);

    // Deferral patterns
    const patterns = [
      { re: /(?:I |i )(?:can'?t|cannot|am (?:not |un)able to)/i, type: 'inability_claim' },
      { re: /(?:this |it )(?:requires|needs) (?:your|human|manual) (?:input|intervention|action)/i, type: 'human_required' },
      { re: /you(?:'ll| will)? need to (?:do|handle|complete|input|enter|run|execute|click)/i, type: 'directing_human' },
      { re: /(?:you (?:can|could|should|might want to) )(?:run|execute|navigate|open|click)/i, type: 'suggesting_human_action' },
      { re: /(?:want me to|should I|shall I|would you like me to) (?:proceed|continue|go ahead)/i, type: 'permission_seeking' },
      { re: /(?:blocker|blocking issue|can'?t proceed (?:without|until))/i, type: 'claimed_blocker' },
    ];

    const matches = patterns.filter(p => p.re.test(command));
    if (matches.length === 0) process.exit(0);

    const checklist = [
      'DEFERRAL DETECTED — Before claiming you cannot do something, verify:',
      '',
      '1. Did you check --help or docs for the tool you are using?',
      '2. Did you search for a token/API-based alternative to interactive auth?',
      '3. Do you already have credentials/tokens that might work? (env vars, CLI auth, saved configs)',
      '4. Can you use browser automation to complete interactive flows?',
      '5. Is this GENUINELY beyond your access? (e.g., typing a password, solving a CAPTCHA)',
      '',
      'If ANY check might work — try it first.',
      'The pattern: You are DESCRIBING work instead of DOING work.',
      '',
      'Detected: ' + matches.map(m => m.type).join(', '),
    ].join('\\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: checklist }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
`;
  }

  private getPostActionReflectionHook(): string {
    return `#!/usr/bin/env node
// Post-action reflection — evolution awareness after significant actions.
// PostToolUse hook for Bash. When the agent commits, deploys, or
// completes a task, captures the step for Living Skills and injects
// a brief reminder to capture learnings.
//
// "Every action is an opportunity to learn. Most of that learning is lost
// because nobody paused to ask: what did this teach me?"

const fs = require('node:fs');
const pathMod = require('node:path');

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Significant action patterns — moments worth reflecting on
    const significantPatterns = [
      /git\\s+commit/i,
      /git\\s+push/i,
      /npm\\s+publish/i,
      /curl/i,
      /docker/i,
      /deploy/i,
      /prisma/i,
      /psql/i,
      /npm\\s+run\\s+build/i,
      /npm\\s+test/i,
      /instar\\s+server\\s+restart/i,
    ];

    const isSignificant = significantPatterns.some(p => p.test(command));

    // Living Skills: capture step to pending journal if enabled
    const cwd = input.cwd || process.cwd();
    const sessionId = process.env.INSTAR_SESSION_ID || '';
    const jobSlug = process.env.INSTAR_JOB_SLUG || '';

    if (isSignificant && sessionId && jobSlug) {
      // Check for sentinel file (created by JobScheduler when livingSkills.enabled)
      const instarDir = process.env.INSTAR_STATE_DIR || pathMod.join(cwd, '.instar');
      const sentinelPath = pathMod.join(instarDir, 'state', 'execution-journal', '_ls-enabled-' + jobSlug);

      try {
        if (fs.existsSync(sentinelPath)) {
          // Sanitize command before writing
          const REDACT = [
            /Bearer\\s+[A-Za-z0-9\\-._~+\\/]+=*/gi,
            /Authorization:\\s*[^\\s"']*/gi,
            /(api[_-]?key|apikey|api_secret)\\s*[:=]\\s*\\S+/gi,
            /(password|passwd|secret|token)\\s*[:=]\\s*\\S+/gi,
            /sk-[A-Za-z0-9]{20,}/g,
            /ghp_[A-Za-z0-9]{36}/g,
            /xox[baprs]-[A-Za-z0-9\\-]+/g,
          ];
          let sanitized = command;
          for (const p of REDACT) { p.lastIndex = 0; sanitized = sanitized.replace(p, '[REDACTED]'); }
          sanitized = sanitized.slice(0, 500);

          const pendingFile = pathMod.join(instarDir, 'state', 'execution-journal', '_pending.' + sessionId + '.jsonl');
          fs.mkdirSync(pathMod.dirname(pendingFile), { recursive: true });
          const entry = {
            sessionId,
            jobSlug,
            timestamp: new Date().toISOString(),
            command: sanitized,
            source: 'hook',
          };
          fs.appendFileSync(pendingFile, JSON.stringify(entry) + '\\n');
        }
      } catch { /* Living Skills capture failure is non-critical */ }
    }

    // Only show reflection reminder for the most significant actions
    const reflectionPatterns = [
      /git\\s+commit/i,
      /git\\s+push/i,
      /npm\\s+publish/i,
      /curl\\s+-X\\s+POST.*\\/deploy/i,
      /instar\\s+server\\s+restart/i,
    ];

    if (!reflectionPatterns.some(p => p.test(command))) process.exit(0);

    const reminder = [
      'POST-ACTION REFLECTION — Quick evolution check:',
      '',
      'Before moving on, consider:',
      '- Did this teach you something worth recording? → /learn',
      '- Did you notice a gap in your capabilities? → /gaps',
      '- Did you discover an improvement opportunity? → /evolve',
      '- Did you make a commitment to follow up? → /commit-action',
      '',
      'Skip if nothing notable. The value is in the pause, not the output.',
    ].join('\\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: reminder }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
`;
  }

  private getExternalCommunicationGuardHook(): string {
    return `#!/usr/bin/env node
// External communication guard — identity grounding before external posting.
// PreToolUse hook for Bash. Detects external posting commands (curl POST, API calls,
// CLI tools that post to external services). Injects identity re-read reminder.
//
// "An agent that knows itself is harder to compromise."
// "An agent that forgets itself posts things it shouldn't."

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Patterns that indicate external posting
    const postingPatterns = [
      /curl\\s.*-X\\s+POST/i,
      /curl\\s.*-X\\s+PUT/i,
      /curl\\s.*-X\\s+PATCH/i,
      /curl\\s.*-d\\s+['"]/i,
      /curl\\s.*--data/i,
      /gh\\s+issue\\s+(?:comment|create)/i,
      /gh\\s+pr\\s+(?:comment|create|review)/i,
      /gh\\s+api\\s+graphql.*mutation/i,
      /sendgrid|mailgun|ses\\.amazonaws.*send/i,
      /telegram-reply/i,
      /send-email/i,
      /slack.*(?:chat\\.postMessage|send)/i,
    ];

    if (!postingPatterns.some(p => p.test(command))) process.exit(0);

    // Exempt: localhost, internal APIs, health checks
    if (/localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0/i.test(command)) process.exit(0);
    if (/curl\\s+-s\\s+https?:\\/\\/[^\\s]+\\s*$/i.test(command)) process.exit(0);  // Simple GET
    if (/heartbeat|keepalive|health/i.test(command)) process.exit(0);

    const reminder = [
      'EXTERNAL COMMUNICATION DETECTED — Identity grounding check:',
      '',
      'Before posting externally, verify:',
      '1. Have you read .instar/AGENT.md recently in this session?',
      '2. Does this message represent who you are and your principles?',
      '3. Are you posting something you would stand behind across sessions?',
      '4. Is the tone and content consistent with your identity?',
      '',
      'Security Through Identity: An agent that knows itself is harder to compromise.',
    ].join('\\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: reminder }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
`;
  }

  private getExternalOperationGateHook(): string {
    return `#!/usr/bin/env node
// External operation gate — structural safety for external service operations.
// PreToolUse hook. Intercepts MCP tool calls to external services and evaluates
// risk before allowing execution. Structure > Willpower.
//
// Born from the OpenClaw email deletion incident: an agent deleted 200+ emails
// because nothing distinguished safe reads from destructive bulk deletes.
//
// Uses global fetch() (Node.js 18+) — no CommonJS imports needed.

// Read tool input from stdin
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || '';

    // Only intercept MCP tools (external service calls)
    if (!toolName.startsWith('mcp__')) {
      process.exit(0); // Not an MCP tool — pass through
    }

    // Extract service name from mcp__<service>__<action>
    const parts = toolName.split('__');
    if (parts.length < 3) {
      process.exit(0); // Malformed MCP tool name — pass through
    }

    const service = parts[1];
    const action = parts.slice(2).join('_');

    // Classify mutability from action name
    let mutability = 'read';
    if (/^(delete|remove|trash|purge|destroy|drop|clear)/.test(action)) {
      mutability = 'delete';
    } else if (/^(send|create|post|write|add|insert|new|compose|publish)/.test(action)) {
      mutability = 'write';
    } else if (/^(update|modify|edit|patch|rename|move|change|set|toggle|enable|disable)/.test(action)) {
      mutability = 'modify';
    }
    // Everything else defaults to 'read' (get, list, search, fetch, check, etc.)

    // Read operations are always safe — fast-path
    if (mutability === 'read') {
      process.exit(0);
    }

    // Classify reversibility
    let reversibility = 'reversible';
    if (/^(send|publish|post|destroy|purge|drop)/.test(action)) {
      reversibility = 'irreversible';
    } else if (/^(delete|remove|trash)/.test(action)) {
      reversibility = 'partially-reversible';
    }

    // Estimate item count from tool_input
    const toolInput = input.tool_input || {};
    let itemCount = 1;
    for (const key of Object.keys(toolInput)) {
      const val = toolInput[key];
      if (Array.isArray(val)) {
        itemCount = Math.max(itemCount, val.length);
      }
    }

    // Build description
    const description = action.replace(/_/g, ' ') + ' on ' + service;

    // Read config (port + auth token) via dynamic import to stay ESM-compatible
    let port = 4321;
    let authToken = '';
    try {
      const nodeFs = await import('node:fs');
      const configPath = (process.env.CLAUDE_PROJECT_DIR || '.') + '/.instar/config.json';
      const raw = nodeFs.readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      port = cfg.port || 4321;
      authToken = cfg.authToken || '';
    } catch { /* use defaults */ }

    // Call the gate API using global fetch (Node 18+)
    const postData = JSON.stringify({
      service,
      mutability,
      reversibility,
      description,
      itemCount,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch('http://127.0.0.1:' + port + '/operations/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken,
        },
        body: postData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const decision = await res.json();

      if (decision.action === 'block') {
        process.stderr.write('BLOCKED: External operation gate denied this action.\\n');
        process.stderr.write('Reason: ' + (decision.reason || 'Operation not permitted') + '\\n');
        process.stderr.write('Service: ' + service + ', Action: ' + action + '\\n');
        process.exit(2);
      }

      if (decision.action === 'show-plan') {
        const ctx = [
          '=== EXTERNAL OPERATION GATE: APPROVAL REQUIRED ===',
          'Operation: ' + description,
          'Risk: ' + (decision.riskLevel || 'unknown'),
          decision.plan ? 'Plan: ' + decision.plan : '',
          decision.checkpoint ? 'Checkpoint: pause after ' + decision.checkpoint.afterCount + ' items' : '',
          '',
          'Show this plan to the user and get explicit approval before proceeding.',
          'If the user has not approved this specific operation, DO NOT PROCEED.',
          '=== END GATE ===',
        ].filter(Boolean).join('\\n');

        process.stdout.write(JSON.stringify({
          decision: 'approve',
          additionalContext: ctx,
        }));
        process.exit(0);
      }

      if (decision.action === 'suggest-alternative' && decision.alternative) {
        process.stdout.write(JSON.stringify({
          decision: 'approve',
          additionalContext: 'External Operation Gate suggests: ' + decision.alternative,
        }));
        process.exit(0);
      }

      // Identity grounding for external write/send/publish operations.
      // Dawn pattern (grounding-enforcement): agents must be grounded in
      // identity before any public-facing action. The gate approved the
      // operation — now inject identity context so the agent writes as itself.
      if ((mutability === 'write' || mutability === 'modify') && reversibility === 'irreversible') {
        const nodeFs = await import('node:fs');
        const agentMdPath = (process.env.CLAUDE_PROJECT_DIR || '.') + '/.instar/AGENT.md';
        let identitySnippet = '';
        try {
          const content = nodeFs.readFileSync(agentMdPath, 'utf-8');
          // Extract first 500 chars of identity for context injection
          identitySnippet = content.slice(0, 500).trim();
        } catch { /* AGENT.md not found — skip identity injection */ }

        if (identitySnippet) {
          const groundingCtx = [
            '=== IDENTITY GROUNDING (pre-' + action.replace(/_/g, ' ') + ') ===',
            '',
            identitySnippet,
            identitySnippet.length >= 500 ? '...' : '',
            '',
            'Verify: Does this ' + action.replace(/_/g, ' ') + ' represent who you are?',
            '=== END GROUNDING ===',
          ].filter(Boolean).join('\\n');

          process.stdout.write(JSON.stringify({
            decision: 'approve',
            additionalContext: groundingCtx,
          }));
          process.exit(0);
        }
      }

      process.exit(0);
    } catch {
      clearTimeout(timeout);
      process.exit(0); // Server unreachable or timeout — fail open
    }
  } catch {
    process.exit(0); // Parse error — fail open
  }
});
`;
  }

  /**
   * Apply the HTTP 408 ambiguous-outcome migration to an existing reply script
   * if and only if:
   *   - the file exists (we never install these from here — only upgrade),
   *   - its header matches the shipped version (so we don't stomp custom scripts),
   *   - and it does NOT already handle HTTP 408.
   *
   * Used by migrateScripts() for slack-reply.sh and whatsapp-reply.sh. The
   * telegram-reply.sh migration uses similar logic inline because it ALSO
   * installs on first run (hasTelegram gate); these two are upgrade-only.
   */
  private migrateReplyScriptTo408(opts: {
    scriptPath: string;
    templateFilename: string;
    shippedMarker: string;
    label: string;
    result: MigrationResult;
  }): void {
    if (!fs.existsSync(opts.scriptPath)) return; // Not installed — not our responsibility here
    try {
      const existing = fs.readFileSync(opts.scriptPath, 'utf-8');
      const looksShipped = existing.includes(opts.shippedMarker);
      const hasNewHandling = existing.includes('HTTP_CODE" = "408"');
      if (!looksShipped || hasNewHandling) {
        opts.result.skipped.push(`${opts.label} (already up to date or customized)`);
        return;
      }
      const template = this.loadRelayTemplate(opts.templateFilename);
      if (!template) {
        opts.result.errors.push(`${opts.label}: template file not found`);
        return;
      }
      fs.writeFileSync(opts.scriptPath, template, { mode: 0o755 });
      opts.result.upgraded.push(`${opts.label} (upgraded to HTTP 408 ambiguous-outcome handling)`);
    } catch (err) {
      opts.result.errors.push(`${opts.label} migration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Read a reply-script template from src/templates/scripts/.
   * Returns null if the template file cannot be located (shouldn't happen in
   * a healthy install). The caller is responsible for handling the null case.
   */
  private loadRelayTemplate(filename: string): string | null {
    const modDir = path.dirname(new URL(import.meta.url).pathname);
    const candidates = [
      path.resolve(modDir, '..', 'templates', 'scripts', filename),
      path.resolve(modDir, '..', '..', 'src', 'templates', 'scripts', filename),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf-8');
      }
    }
    return null;
  }

  private getTelegramReplyScript(): string {
    // Read the canonical template from the templates directory. Keeping this
    // in sync with src/commands/init.ts (scaffold-time installer) matters —
    // both paths must ship the same HTTP 408 handling, or an upgraded agent
    // would still duplicate-send if it re-ran init after the upgrade.
    // Same pattern as getConvergenceCheck() above.
    const template = this.loadRelayTemplate('telegram-reply.sh');
    if (template !== null) {
      return template;
    }
    // Fallback: minimal inline version that still handles HTTP 408 correctly.
    // Used only if template file isn't found (shouldn't happen in a healthy
    // install). The full-featured version — auth header, 422 tone-gate UX,
    // 408 ambiguous-outcome — lives in src/templates/scripts/telegram-reply.sh.
    const port = this.config.port;
    return `#!/bin/bash
# telegram-reply.sh — fallback version (template file not found).
TOPIC_ID="$1"
shift
MSG="\${*:-$(cat)}"
PORT="\${INSTAR_PORT:-${port}}"
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/telegram/reply/\${TOPIC_ID}" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"text\\":\${JSON_MSG}}")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to topic $TOPIC_ID"
elif [ "$HTTP_CODE" = "408" ]; then
  echo "AMBIGUOUS (HTTP 408): server timed out; send may have completed — verify before retrying." >&2
  echo "AMBIGUOUS (HTTP 408): outcome unknown — verify in conversation before retrying"
  exit 0
else
  echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
`;
  }

  private getHealthWatchdog(): string {
    const port = this.config.port;
    const projectName = this.config.projectName;
    const escapedProjectDir = this.config.projectDir.replace(/'/g, "'\\''");
    return `#!/bin/bash
# health-watchdog.sh — Monitor instar server and auto-recover.
# Install as cron: */5 * * * * '${path.join(this.config.projectDir, '.claude/scripts/health-watchdog.sh').replace(/'/g, "'\\''")}'

PORT="${port}"
SERVER_SESSION="${projectName}-server"
PROJECT_DIR='${escapedProjectDir}'
TMUX_PATH=$(which tmux 2>/dev/null || echo "/opt/homebrew/bin/tmux")

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then exit 0; fi

echo "[\$(date -Iseconds)] Server not responding. Restarting..."
$TMUX_PATH kill-session -t "=\${SERVER_SESSION}" 2>/dev/null
sleep 2
cd "$PROJECT_DIR" && npx instar server start
echo "[\$(date -Iseconds)] Server restart initiated"
`;
  }

  private getConvergenceCheck(): string {
    // Read the convergence check template from the templates directory.
    // This file is the heuristic quality gate that runs before external messaging.
    const modDir = path.dirname(new URL(import.meta.url).pathname);
    // In dev: src/core/ → ../../src/templates/scripts/convergence-check.sh
    // In dist: dist/core/ → ../templates/scripts/convergence-check.sh
    const candidates = [
      path.resolve(modDir, '..', 'templates', 'scripts', 'convergence-check.sh'),
      path.resolve(modDir, '..', '..', 'src', 'templates', 'scripts', 'convergence-check.sh'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf-8');
      }
    }
    // Fallback: use inline version so migration doesn't fail
    return this.getConvergenceCheckInline();
  }

  // ── Scope Coherence Hooks ─────────────────────────────────────────

  private getScopeCoherenceCollectorHook(): string {
    const port = this.config.port;
    return `#!/usr/bin/env node
// Scope Coherence Collector — PostToolUse hook
// Tracks implementation depth (Edit/Write/Bash) vs scope-checking actions (Read docs).
// The 232nd Lesson: Implementation depth narrows scope.
//
// This hook records each tool action locally. Fast path — no network call.
// State persists in .instar/state/scope-coherence.json via the server API.

// CJS imports — this is a standalone hook script, not an ESM module
const _r = require;
const fs = _r('fs');
const path = _r('path');

const STATE_FILE = path.join('.instar', 'state', 'scope-coherence.json');
const SCOPE_DOC_PATTERNS = [
  'docs/', 'specs/', 'SPEC', 'PROPOSAL', 'DESIGN', 'ARCHITECTURE',
  'README', '.instar/AGENT.md', '.instar/USER.md', '.claude/context/',
  '.claude/grounding/', 'CLAUDE.md'
];
const SCOPE_DOC_EXTENSIONS = ['.md', '.txt', '.rst'];
const QUERY_PREFIXES = [
  'git status', 'git log', 'git diff', 'ls ', 'cat ', 'grep ',
  'echo ', 'which ', 'head ', 'tail ', 'wc ', 'pwd', 'date'
];
const GROUNDING_SKILLS = ['grounding', 'dawn', 'reflect', 'introspect', 'session-bootstrap'];

function isScopeDoc(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  if (SCOPE_DOC_PATTERNS.some(p => lower.includes(p.toLowerCase()))) return true;
  const parts = filePath.split('/');
  const name = parts[parts.length - 1] || '';
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const ext = name.slice(dot);
    const stem = name.slice(0, dot);
    if (SCOPE_DOC_EXTENSIONS.includes(ext) && stem === stem.toUpperCase() && stem.length > 3) return true;
  }
  return false;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return {
    implementationDepth: 0, lastScopeCheck: null, lastCheckpointPrompt: null,
    sessionDocsRead: [], checkpointsDismissed: 0, lastImplementationTool: null, sessionStart: null
  };
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};
    const agentId = input.agent_id || null;
    const agentType = input.agent_type || null;
    const state = loadState();
    const now = new Date().toISOString();
    if (!state.sessionStart) state.sessionStart = now;
    // Track agent context (M4: Claude Code now enriches all hook events)
    if (agentId) {
      if (!state.agentActivity) state.agentActivity = {};
      if (!state.agentActivity[agentId]) state.agentActivity[agentId] = { type: agentType, actions: 0 };
      state.agentActivity[agentId].actions++;
    }

    if (toolName === 'Edit' || toolName === 'Write') {
      state.implementationDepth += 1;
      state.lastImplementationTool = toolName + ':' + now;
    } else if (toolName === 'Bash') {
      const cmd = (toolInput.command || '').trim();
      const isQuery = QUERY_PREFIXES.some(p => cmd.startsWith(p));
      if (!isQuery && cmd.length > 10) {
        state.implementationDepth += 1;
        state.lastImplementationTool = 'Bash:' + now;
      }
    } else if (toolName === 'Read') {
      const fp = toolInput.file_path || '';
      if (isScopeDoc(fp)) {
        state.implementationDepth = Math.max(0, state.implementationDepth - 10);
        state.lastScopeCheck = now;
        if (!state.sessionDocsRead.includes(fp)) {
          state.sessionDocsRead.push(fp);
          if (state.sessionDocsRead.length > 20) state.sessionDocsRead = state.sessionDocsRead.slice(-20);
        }
      }
    } else if (toolName === 'Skill') {
      const skill = toolInput.skill || '';
      if (GROUNDING_SKILLS.includes(skill)) {
        state.implementationDepth = 0;
        state.lastScopeCheck = now;
      }
    }

    saveState(state);
  } catch {}
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
});
`;
  }

  private getScopeCoherenceCheckpointHook(): string {
    const port = this.config.port;
    return `#!/usr/bin/env node
// Scope Coherence Checkpoint — Stop hook
// The structural zoom-out. Forces agents to step back and check the big picture
// when they've been deep in implementation without reading design docs.
//
// The 232nd Lesson: Implementation depth narrows scope.
// "See code -> wire it -> declare done" vs "read spec -> understand scope -> build right thing"
//
// Calls the Instar server for active job context to make the checkpoint actionable.

// CJS imports — this is a standalone hook script, not an ESM module
const _r = require;
const fs = _r('fs');
const path = _r('path');
const http = _r('http');

const STATE_FILE = path.join('.instar', 'state', 'scope-coherence.json');
const DEPTH_THRESHOLD = 20;
const COOLDOWN_MS = 30 * 60 * 1000;  // 30 minutes
const MIN_AGE_MS = 5 * 60 * 1000;    // 5 minutes

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return { implementationDepth: 0 };
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function fetchActiveJob() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:${port}/context/active-job', { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', async () => {
  try {
    // Never block headless/job sessions — no human to dismiss the block.
    // INSTAR_SESSION_ID is set for all server-spawned sessions.
    if (process.env.INSTAR_SESSION_ID && !process.env.TERM_PROGRAM) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
      return;
    }

    const state = loadState();
    const now = Date.now();
    const depth = state.implementationDepth || 0;

    if (depth < DEPTH_THRESHOLD) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
      return;
    }

    // Check cooldown
    if (state.lastCheckpointPrompt) {
      const elapsed = now - new Date(state.lastCheckpointPrompt).getTime();
      if (elapsed < COOLDOWN_MS) {
        process.stdout.write(JSON.stringify({ decision: 'approve' }));
        process.exit(0);
        return;
      }
    }

    // Check minimum session age
    if (state.sessionStart) {
      const age = now - new Date(state.sessionStart).getTime();
      if (age < MIN_AGE_MS) {
        process.stdout.write(JSON.stringify({ decision: 'approve' }));
        process.exit(0);
        return;
      }
    }

    // Fetch active job context from server
    const jobData = await fetchActiveJob();
    const dismissed = state.checkpointsDismissed || 0;
    const docsRead = state.sessionDocsRead || [];

    let jobContext = '';
    if (jobData && jobData.active && jobData.job) {
      jobContext = '\\nYou are running the **' + jobData.job.name + '** job.\\n' +
        'Scope: ' + (jobData.job.description || 'No description') + '\\n' +
        'Are you still within the job\\'s boundaries?\\n';
    }

    let docsContext = '';
    if (docsRead.length > 0) {
      const recent = docsRead.slice(-5).map(d => d.split('/').pop());
      docsContext = '\\nDocs read this session: ' + recent.join(', ');
    } else {
      docsContext = '\\nNo design docs, specs, or proposals have been read this session.';
    }

    let escalation = '';
    if (dismissed >= 3) {
      escalation = '\\n\\nYou\\'ve dismissed ' + dismissed + ' scope checkpoints. ' +
        'Dismissing scope checks during deep implementation is how scope collapse happens.';
    }

    const reason = 'SCOPE COHERENCE CHECK\\n\\n' +
      'You\\'ve been deep in implementation for ' + depth + ' actions without reading design documents.\\n' +
      'Implementation depth narrows perception.\\n' +
      jobContext +
      '\\nStep back and ask yourself:\\n' +
      '\\n1. WHO AM I? What role am I filling right now?\\n' +
      '2. WHAT AM I WORKING ON? What\\'s the full scope? Is there a spec or proposal?\\n' +
      '3. BIG PICTURE — How does this fit into the larger system?\\n' +
      '4. HIGHER-LEVEL ELEMENTS — What architectural or cross-system aspects am I missing?\\n' +
      '5. COMPLETENESS — Am I considering all elements, or have I collapsed the scope?\\n' +
      docsContext + escalation +
      '\\n\\nOptions: Read the relevant spec/proposal, confirm scope awareness, or /grounding';

    // Record that we prompted
    state.lastCheckpointPrompt = new Date().toISOString();
    state.checkpointsDismissed = dismissed + 1;
    saveState(state);

    process.stdout.write(JSON.stringify({ decision: 'block', reason: reason }));
  } catch {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
  }
  process.exit(0);
});
`;
  }

  private getFreeTextGuardHook(): string {
    // Read the hook from the templates directory instead of inline generation.
    // This avoids multi-layer escaping issues (TypeScript -> bash -> Python -> regex).
    const hookPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates', 'hooks', 'free-text-guard.sh');
    return fs.readFileSync(hookPath, 'utf-8');
  }

  private getClaimInterceptHook(): string {
    return `#!/usr/bin/env node
// Claim Intercept — PostToolUse hook for catching false operational claims.
//
// The Proprioceptive Stack for Instar agents.
// Agents sometimes falsely deny capabilities they actually have.
// This hook cross-checks denial claims against Canonical State
// (quick-facts.json, project-registry.json) and injects corrections.
//
// Architecture: Two-layer detection
//   Layer 1: Regex fast-path (<1ms) — catches explicit denial patterns
//   Layer 2: Canonical State cross-check — verifies claims against ground truth
//
// Design principles:
//   - Never blocks — injects warnings via additionalContext
//   - Reads canonical state files directly (no server dependency)
//   - Only checks topically relevant output (skip pure code, grep, cat)
//   - Rate-limited to prevent latency stacking

const _r = require;
const fs = _r('fs');
const path = _r('path');

const STATE_DIR = path.join('.instar', 'state');
const RATE_FILE = path.join(STATE_DIR, '.claim-intercept-last.tmp');
const RATE_LIMIT_MS = 10000; // 10 seconds between checks
const LOG_FILE = path.join(STATE_DIR, 'claim-intercept.log');

// ── Denial pattern templates ───────────────────────────────────
// These catch explicit claims of inability or missing capability.

const DENIAL_PATTERNS = [
  /(?:I |i )(?:can'?t|cannot|am (?:not |un)able to)\\s+(.{5,80})/i,
  /(?:don'?t|do not) have (?:access|credentials|a?n? ?(?:api|token|key|tool|script|capability))\\s*(?:for|to)?\\s*(.{3,60})?/i,
  /(?:no |not )(?:available|configured|set up|installed|deployed|running|accessible)\\b/i,
  /(?:isn'?t|is not|aren'?t|are not) (?:available|configured|set up|working|running|accessible)\\b/i,
  /(?:blocked|unavailable|disabled|suspended|broken|offline|unreachable)\\b/i,
  /(?:need|require)s? (?:the user|human|manual|someone) to/i,
  /(?:outside|beyond) (?:my|the agent'?s?) (?:capabilities|scope|access|authority)/i,
  /(?:no |don'?t have (?:a |any )?)(?:way|mechanism|method|means) to/i,
  /(?:not |never )(?:been )?(?:set up|configured|registered|deployed)/i,
];

// ── Topic relevance filter ─────────────────────────────────────
// Skip pure code output, file reads, grep results.

const EXEMPT_PATTERNS = [
  /^\\s*\\d+[:\\|]/m,                   // Line-numbered output (cat -n, grep -n)
  /^diff --git/m,                     // Git diffs
  /^\\+\\+\\+|^---/m,                    // Diff headers
  /^commit [a-f0-9]{40}/m,            // Git log
  /node_modules\\//,                   // Node modules paths
  /\\.test\\.[jt]s/,                    // Test file output
];

function isExempt(text) {
  return EXEMPT_PATTERNS.some(p => p.test(text));
}

// ── Rate limiter ───────────────────────────────────────────────

function checkRateLimit() {
  try {
    if (fs.existsSync(RATE_FILE)) {
      const mtime = fs.statSync(RATE_FILE).mtimeMs;
      if (Date.now() - mtime < RATE_LIMIT_MS) return false;
    }
    fs.mkdirSync(path.dirname(RATE_FILE), { recursive: true });
    fs.writeFileSync(RATE_FILE, '');
    return true;
  } catch { return true; }
}

// ── Canonical State loader ─────────────────────────────────────

function loadCanonicalState() {
  const state = { facts: [], projects: [], antiPatterns: [] };
  try {
    const factsPath = path.join(STATE_DIR, 'quick-facts.json');
    if (fs.existsSync(factsPath)) {
      state.facts = JSON.parse(fs.readFileSync(factsPath, 'utf-8'));
    }
  } catch {}
  try {
    const projPath = path.join(STATE_DIR, 'project-registry.json');
    if (fs.existsSync(projPath)) {
      state.projects = JSON.parse(fs.readFileSync(projPath, 'utf-8'));
    }
  } catch {}
  try {
    const apPath = path.join(STATE_DIR, 'anti-patterns.json');
    if (fs.existsSync(apPath)) {
      state.antiPatterns = JSON.parse(fs.readFileSync(apPath, 'utf-8'));
    }
  } catch {}
  return state;
}

// ── Cross-check claims against canonical state ─────────────────

function findContradictions(text, state) {
  const contradictions = [];
  const textLower = text.toLowerCase();

  // Check if any denied capability contradicts a quick fact
  for (const fact of state.facts) {
    const answerWords = fact.answer.toLowerCase().split(/\\s+/).filter(w => w.length > 3);
    const questionWords = fact.question.toLowerCase().split(/\\s+/).filter(w => w.length > 3);
    const allWords = [...answerWords, ...questionWords];

    // If the denial text mentions something related to a known fact
    for (const word of allWords) {
      if (textLower.includes(word)) {
        // Check if the text contains a denial near this word
        const wordIdx = textLower.indexOf(word);
        const context = textLower.substring(Math.max(0, wordIdx - 100), Math.min(textLower.length, wordIdx + 100));
        if (DENIAL_PATTERNS.some(p => p.test(context))) {
          contradictions.push({
            claim: 'Denied capability related to: ' + word,
            fact: fact.question + ' → ' + fact.answer,
            source: 'quick-facts.json (verified: ' + (fact.lastVerified || 'unknown') + ')',
          });
          break; // One contradiction per fact is enough
        }
      }
    }
  }

  // Check if denial mentions a registered project
  for (const proj of state.projects) {
    const projName = proj.name.toLowerCase();
    if (textLower.includes(projName)) {
      const nameIdx = textLower.indexOf(projName);
      const context = textLower.substring(Math.max(0, nameIdx - 100), Math.min(textLower.length, nameIdx + 100));
      if (DENIAL_PATTERNS.some(p => p.test(context))) {
        contradictions.push({
          claim: 'Denied access/capability for project: ' + proj.name,
          fact: proj.name + ' is registered at ' + proj.dir + (proj.deploymentTargets ? ' (deploys to: ' + proj.deploymentTargets.join(', ') + ')' : ''),
          source: 'project-registry.json',
        });
      }
    }
  }

  return contradictions;
}

// ── Main ───────────────────────────────────────────────────────

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || '';

    // Only check Bash, Write, Edit output
    if (!['Bash', 'Write', 'Edit'].includes(toolName)) process.exit(0);

    // Extract text content
    let text = '';
    if (toolName === 'Bash') {
      text = (input.tool_input || {}).command || '';
      // Also check stdout if available
      const result = input.tool_result || '';
      if (typeof result === 'string') text += ' ' + result;
    } else if (toolName === 'Write') {
      text = (input.tool_input || {}).content || '';
    } else if (toolName === 'Edit') {
      text = (input.tool_input || {}).new_string || '';
    }

    if (!text || text.length < 40) process.exit(0);
    if (isExempt(text)) process.exit(0);

    // Quick scan: does the text even contain a denial pattern?
    const hasDenial = DENIAL_PATTERNS.some(p => p.test(text));
    if (!hasDenial) process.exit(0);

    // Rate limit before loading canonical state
    if (!checkRateLimit()) process.exit(0);

    // Cross-check against canonical state
    const state = loadCanonicalState();
    if (state.facts.length === 0 && state.projects.length === 0) process.exit(0);

    const contradictions = findContradictions(text, state);
    if (contradictions.length === 0) process.exit(0);

    // Build warning message
    const details = contradictions.map(c =>
      '  CLAIM: ' + c.claim + '\\n' +
      '  FACT:  ' + c.fact + '\\n' +
      '  FROM:  ' + c.source
    ).join('\\n\\n');

    const warning = 'CLAIM-INTERCEPT: CONTRADICTION DETECTED\\n\\n' +
      'Your output contains claims that contradict canonical state:\\n\\n' +
      details + '\\n\\n' +
      'Do NOT repeat false claims. Revise your statement to match operational reality.\\n' +
      'Canonical state is compiled from verified registries. If you believe it is wrong,\\n' +
      'verify with: GET /state/quick-facts or check .instar/state/ files directly.';

    // Log the interception
    try {
      const logEntry = '[' + new Date().toISOString() + '] ' +
        'tool=' + toolName + ' | ' +
        'contradictions=' + contradictions.length + ' | ' +
        'claims=' + contradictions.map(c => c.claim.substring(0, 50)).join('; ') + '\\n';
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, logEntry);
    } catch {}

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: warning }));
  } catch {}
  process.exit(0);
});
`;
  }

  private getResponseReviewHook(): string {
    const port = this.config.port;
    return `#!/usr/bin/env node
// Response Review — Stop hook for the Coherence Gate response review pipeline.
//
// Thin client: reads stdin JSON, posts to the Instar server's /review/evaluate
// endpoint, and returns the verdict. All review logic lives server-side.
//
// Unlike other stop hooks, this does NOT skip when stop_hook_active is true.
// The CoherenceGate handles retry tracking and exhaustion internally.
// The hook always passes the stopHookActive flag so the server can decide.

const _r = require;
const fs = _r('fs');
const path = _r('path');
const http = _r('http');

// Read config for port and auth token
let serverPort = ${port};
let authToken = '';
try {
  const configPath = path.join(process.env.CLAUDE_PROJECT_DIR || '.', '.instar', 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const cfg = JSON.parse(raw);
  serverPort = cfg.port || ${port};
  authToken = cfg.authToken || '';
} catch {}

// Check if response review is enabled in config
let reviewEnabled = false;
try {
  const configPath = path.join(process.env.CLAUDE_PROJECT_DIR || '.', '.instar', 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const cfg = JSON.parse(raw);
  reviewEnabled = cfg.responseReview && cfg.responseReview.enabled;
} catch {}

if (!reviewEnabled) {
  process.exit(0);
}

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(data);
    const message = input.last_assistant_message || '';

    // Skip empty or very short messages (greetings, etc.)
    if (!message || message.length < 20) {
      process.exit(0);
    }

    // Determine channel from environment
    const topicId = process.env.INSTAR_TELEGRAM_TOPIC;
    const sessionId = process.env.INSTAR_SESSION_ID || 'unknown';
    const channel = topicId ? 'telegram' : 'direct';
    const isExternalFacing = !!topicId; // Telegram = external

    // Build the review request
    const body = JSON.stringify({
      message,
      sessionId,
      stopHookActive: !!input.stop_hook_active,
      context: {
        channel,
        topicId: topicId ? parseInt(topicId, 10) : undefined,
        recipientType: 'primary-user',
        isExternalFacing,
      },
    });

    // Call the review endpoint with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch('http://127.0.0.1:' + serverPort + '/review/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        // Server error — fail open (approve)
        process.exit(0);
      }

      const result = await res.json();

      if (!result.pass) {
        // BLOCK — return feedback to the agent for revision
        const reason = result.feedback || 'Response did not pass coherence review.';
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason,
        }));
        process.exit(2);
      }

      // PASS — optionally include warnings
      if (result.warnings && result.warnings.length > 0) {
        process.stderr.write('[response-review] Warnings: ' + result.warnings.join('; ') + '\\n');
      }

      process.exit(0);
    } catch {
      // Network error or timeout — fail open
      clearTimeout(timeout);
      process.exit(0);
    }
  } catch {
    // JSON parse error on stdin — fail open
    process.exit(0);
  }
});
`;
  }

  private getClaimInterceptResponseHook(): string {
    return `#!/usr/bin/env node
// Claim Intercept — Stop hook for catching false claims in direct responses.
//
// Complements the PostToolUse claim-intercept hook by checking the agent's
// direct text responses (the words between tool calls). This closes the gap
// where tool output is checked but conversational text goes unchecked.
//
// Architecture:
//   Stop hook — fires when the agent finishes a response turn.
//   Receives last_assistant_message from stdin.
//   Cross-checks against Canonical State.
//   If contradiction found: BLOCKS the stop (exit 2) to force correction.
//
// Guard against infinite loops:
//   If stop_hook_active is true, we're in a correction continuation — skip.

const _r = require;
const fs = _r('fs');
const path = _r('path');

const STATE_DIR = path.join('.instar', 'state');
const RATE_FILE = path.join(STATE_DIR, '.claim-intercept-last.tmp');
const RATE_LIMIT_MS = 10000;
const LOG_FILE = path.join(STATE_DIR, 'claim-intercept.log');

// Same denial patterns as PostToolUse hook
const DENIAL_PATTERNS = [
  /(?:I |i )(?:can'?t|cannot|am (?:not |un)able to)\\s+(.{5,80})/i,
  /(?:don'?t|do not) have (?:access|credentials|a?n? ?(?:api|token|key|tool|script|capability))\\s*(?:for|to)?\\s*(.{3,60})?/i,
  /(?:no |not )(?:available|configured|set up|installed|deployed|running|accessible)\\b/i,
  /(?:isn'?t|is not|aren'?t|are not) (?:available|configured|set up|working|running|accessible)\\b/i,
  /(?:blocked|unavailable|disabled|suspended|broken|offline|unreachable)\\b/i,
  /(?:need|require)s? (?:the user|human|manual|someone) to/i,
  /(?:outside|beyond) (?:my|the agent'?s?) (?:capabilities|scope|access|authority)/i,
  /(?:no |don'?t have (?:a |any )?)(?:way|mechanism|method|means) to/i,
  /(?:not |never )(?:been )?(?:set up|configured|registered|deployed)/i,
];

function checkRateLimit() {
  try {
    if (fs.existsSync(RATE_FILE)) {
      const mtime = fs.statSync(RATE_FILE).mtimeMs;
      if (Date.now() - mtime < RATE_LIMIT_MS) return false;
    }
    fs.mkdirSync(path.dirname(RATE_FILE), { recursive: true });
    fs.writeFileSync(RATE_FILE, '');
    return true;
  } catch { return true; }
}

function loadCanonicalState() {
  const state = { facts: [], projects: [] };
  try {
    const factsPath = path.join(STATE_DIR, 'quick-facts.json');
    if (fs.existsSync(factsPath)) {
      state.facts = JSON.parse(fs.readFileSync(factsPath, 'utf-8'));
    }
  } catch {}
  try {
    const projPath = path.join(STATE_DIR, 'project-registry.json');
    if (fs.existsSync(projPath)) {
      state.projects = JSON.parse(fs.readFileSync(projPath, 'utf-8'));
    }
  } catch {}
  return state;
}

function findContradictions(text, state) {
  const contradictions = [];
  const textLower = text.toLowerCase();

  for (const fact of state.facts) {
    const answerWords = fact.answer.toLowerCase().split(/\\s+/).filter(w => w.length > 3);
    const questionWords = fact.question.toLowerCase().split(/\\s+/).filter(w => w.length > 3);
    const allWords = [...answerWords, ...questionWords];

    for (const word of allWords) {
      if (textLower.includes(word)) {
        const wordIdx = textLower.indexOf(word);
        const context = textLower.substring(Math.max(0, wordIdx - 100), Math.min(textLower.length, wordIdx + 100));
        if (DENIAL_PATTERNS.some(p => p.test(context))) {
          contradictions.push({
            claim: 'Denied capability related to: ' + word,
            fact: fact.question + ' → ' + fact.answer,
            source: 'quick-facts.json',
          });
          break;
        }
      }
    }
  }

  for (const proj of state.projects) {
    const projName = proj.name.toLowerCase();
    if (textLower.includes(projName)) {
      const nameIdx = textLower.indexOf(projName);
      const context = textLower.substring(Math.max(0, nameIdx - 100), Math.min(textLower.length, nameIdx + 100));
      if (DENIAL_PATTERNS.some(p => p.test(context))) {
        contradictions.push({
          claim: 'Denied access/capability for project: ' + proj.name,
          fact: proj.name + ' is registered at ' + proj.dir,
          source: 'project-registry.json',
        });
      }
    }
  }

  return contradictions;
}

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);

    // Guard: if we're already in a Stop hook continuation, skip
    if (input.stop_hook_active) process.exit(0);

    const message = input.last_assistant_message || '';
    if (!message || message.length < 80) process.exit(0);

    // Quick scan for denial patterns
    const hasDenial = DENIAL_PATTERNS.some(p => p.test(message));
    if (!hasDenial) process.exit(0);

    // Rate limit
    if (!checkRateLimit()) process.exit(0);

    // Cross-check against canonical state
    const state = loadCanonicalState();
    if (state.facts.length === 0 && state.projects.length === 0) process.exit(0);

    const contradictions = findContradictions(message, state);
    if (contradictions.length === 0) process.exit(0);

    // Build correction prompt
    const details = contradictions.map(c =>
      '  CLAIM: ' + c.claim + '\\n' +
      '  FACT:  ' + c.fact + '\\n' +
      '  FROM:  ' + c.source
    ).join('\\n\\n');

    const reason = 'CLAIM-INTERCEPT (Response-Level): FALSE CLAIM DETECTED\\n\\n' +
      'Your last response contained claims that contradict canonical state:\\n\\n' +
      details + '\\n\\n' +
      'You MUST correct this. Issue a brief correction acknowledging the error.\\n' +
      'Do NOT repeat the false claim. State what is actually true.\\n' +
      'Canonical state: .instar/state/quick-facts.json, project-registry.json';

    // Log the interception
    try {
      const logEntry = '[' + new Date().toISOString() + '] ' +
        'RESPONSE-LEVEL | contradictions=' + contradictions.length + ' | ' +
        'claims=' + contradictions.map(c => c.claim.substring(0, 50)).join('; ') + '\\n';
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, logEntry);
    } catch {}

    // BLOCK the stop — force the agent to correct itself
    process.stdout.write(JSON.stringify({ decision: 'block', reason: reason }));
    process.exit(2);
  } catch {}
  process.exit(0);
});
`;
  }

  private getSkillUsageTelemetryHook(): string {
    return `#!/bin/bash
# Skill Usage Telemetry — PostToolUse hook for Skill tool.
#
# Logs every skill invocation to .instar/skill-telemetry.jsonl
# for future pattern detection (which skills are used, when, how often).
#
# Cross-pollinated from Dawn's Portal project (2026-04-09).
# Lightweight: appends one JSONL line, no network calls.

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
if [ "$TOOL_NAME" != "Skill" ]; then
  exit 0
fi

INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
TELEMETRY_FILE="$INSTAR_DIR/skill-telemetry.jsonl"

SKILL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('skill','unknown'))" 2>/dev/null)
SKILL_ARGS=$(echo "$INPUT" | python3 -c "import json,sys; a=json.load(sys.stdin).get('tool_input',{}).get('args',''); print(a[:200])" 2>/dev/null)
OUTPUT_LEN=$(echo "$INPUT" | python3 -c "import json,sys; print(len(str(json.load(sys.stdin).get('tool_output',''))))" 2>/dev/null)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

SESSION_ID="\${INSTAR_SESSION_ID:-}"

mkdir -p "$INSTAR_DIR"
echo "{\\"timestamp\\":\\"$TIMESTAMP\\",\\"skill\\":\\"$SKILL_NAME\\",\\"args\\":\\"$SKILL_ARGS\\",\\"session_id\\":\\"$SESSION_ID\\",\\"output_length\\":$OUTPUT_LEN}" >> "$TELEMETRY_FILE"
`;
  }

  private getBuildStopHook(): string {
    // Canonical source: src/templates/hooks/build-stop-hook.sh
    // If you edit either, keep them byte-identical — tests assert equality.
    return `#!/bin/bash
# Build Stop Hook — Structural enforcement for the /build pipeline.
#
# Prevents premature exit during active builds. Graduated protection:
#   SMALL  (light):  3 reinforcements
#   STANDARD (medium): 5 reinforcements
#   LARGE  (heavy):  10 reinforcements
#
# Reads state from .instar/state/build/build-state.json.

STATE_FILE=".instar/state/build/build-state.json"

# No state file = no active build = allow exit
if [ ! -f "\$STATE_FILE" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# Read state
PHASE=\$(python3 -c "import json; d=json.load(open('\$STATE_FILE')); print(d.get('phase','idle'))" 2>/dev/null)

# Terminal phases — allow exit
if [ "\$PHASE" = "complete" ] || [ "\$PHASE" = "failed" ] || [ "\$PHASE" = "escalated" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# Check and update reinforcement counter
RESULT=\$(python3 -c "
import json, sys
with open('\$STATE_FILE') as f:
    state = json.load(f)

protection = state.get('protection', {})
max_r = protection.get('reinforcements', 5)
used = state.get('reinforcementsUsed', 0)

if used >= max_r:
    print(json.dumps({'decision': 'approve'}))
    sys.exit(0)

state['reinforcementsUsed'] = used + 1
with open('\$STATE_FILE', 'w') as f:
    json.dump(state, f, indent=2)

phase = state.get('phase', 'idle')
task = state.get('task', 'unknown')
label = protection.get('label', '?')
steps = state.get('steps', [])
total_tests = state.get('totalTests', 0)
wt = state.get('worktree')

prompts = {
    'idle': 'Build initialized. Begin with Phase 0 (CLARIFY) or Phase 1 (PLAN).',
    'clarify': 'In CLARIFY phase. Resolve ambiguity, then transition to PLAN.',
    'planning': 'In PLAN phase. Complete plan with test strategy, then EXECUTE.',
    'executing': 'In EXECUTE phase. Complete current step: code, tests, verify.',
    'verifying': 'In VERIFY phase. Run independent verification and real-world tests.',
    'fixing': 'In FIXING phase. Address findings, return to VERIFY.',
    'hardening': 'In HARDEN phase. Complete observability checklists.',
}

hint = prompts.get(phase, 'Continue with current phase.')
steps_info = ' | %d steps, %d tests' % (len(steps), total_tests) if steps else ''
wt_info = ' | worktree: %s' % wt['path'] if wt else ''

reason = (
    '/build active. Phase: %s (%s, %d/%d reinforcements)%s%s\\n\\n'
    'Task: %s\\n\\n%s\\n\\n'
    'Use \\\`python3 playbook-scripts/build-state.py status\\\` to check state.\\n'
    'Use \\\`python3 playbook-scripts/build-state.py transition <phase>\\\` to advance.\\n\\n'
    'The build pipeline is not complete. Continue working.'
) % (phase, label, state['reinforcementsUsed'], max_r, steps_info, wt_info, task, hint)

print(json.dumps({'decision': 'block', 'reason': reason}))
" 2>/dev/null)

echo "\$RESULT"
exit 0
`;
  }

  private getAutoApprovePermissionsHook(): string {
    return `#!/usr/bin/env node
// Auto-approve ALL PermissionRequest hooks.
//
// Subagents spawned via the Agent tool don't inherit --dangerously-skip-permissions
// from the parent session. Without this hook, subagents prompt for every tool use,
// blocking autonomous sessions and jobs.
//
// Real safety is enforced by PreToolUse hooks (dangerous-command-guard.sh,
// external-communication-guard.js, external-operation-gate.js). Permission prompts
// are duplicative friction, not protection.

process.stdin.resume();
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    }
  }));
});

// Timeout safety
setTimeout(() => {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    }
  }));
  process.exit(0);
}, 2000);
`;
  }
}
