/**
 * ProfileCompiler — Compiles rich agent profiles from instar agent data.
 *
 * Implements the spec v2.1 compilation pipeline:
 * 1. Rule-based extraction from AGENT.md, tagged MEMORY.md, git stats, jobs, capabilities
 * 2. LLM narrative synthesis (Haiku-class) from StructuredSignals only
 * 3. Content-hash freshness tracking (max 1 recompilation per 24 hours)
 * 4. Human review gate (drafts must be approved before publishing)
 *
 * Security: USER.md is NEVER read. MEMORY.md only contributes #profile-safe entries.
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import type {
  StructuredSignals,
  RichProfilePayload,
  ProfileDraft,
  ProfileFreshnessState,
  Specialization,
  TrackRecordEntry,
} from './types.js';
import { PROFILE_LIMITS } from './types.js';

export interface ProfileCompilerConfig {
  /** Path to the agent's state directory (e.g., .instar/) */
  stateDir: string;
  /** Path to the project root (for git stats) */
  projectRoot: string;
  /** Optional LLM synthesis function. If not provided, uses rule-based narrative. */
  llmSynthesize?: (signals: StructuredSignals) => Promise<string>;
  /** Agent's capability list from server config */
  capabilities?: string[];
  /** Agent's job names from job scheduler */
  jobNames?: string[];
}

const RECOMPILE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CONSECUTIVE_AUTO_PUBLISHES = 3;

export class ProfileCompiler {
  private config: ProfileCompilerConfig;
  private currentDraft: ProfileDraft | null = null;
  private freshnessState: ProfileFreshnessState = {
    lastSourceHash: '',
    lastCompiledAt: '',
    consecutiveAutoPublishes: 0,
  };

  constructor(config: ProfileCompilerConfig) {
    this.config = config;
  }

  /**
   * Compile a rich profile from the agent's data sources.
   * Returns a draft pending human approval.
   */
  async compile(): Promise<ProfileDraft> {
    const signals = await this.extractSignals();
    const sourceHash = this.computeSourceHash(signals);

    // Check freshness — don't recompile if nothing changed
    if (sourceHash === this.freshnessState.lastSourceHash && this.freshnessState.lastCompiledAt) {
      const lastCompiled = new Date(this.freshnessState.lastCompiledAt).getTime();
      if (Date.now() - lastCompiled < RECOMPILE_COOLDOWN_MS) {
        if (this.currentDraft) return this.currentDraft;
      }
    }

    const profile = await this.buildProfile(signals);

    this.currentDraft = {
      profile,
      compiledAt: new Date().toISOString(),
      sourceHash,
      signals,
      status: 'pending',
    };

    this.freshnessState.lastSourceHash = sourceHash;
    this.freshnessState.lastCompiledAt = this.currentDraft.compiledAt;

    return this.currentDraft;
  }

  /**
   * Check if recompilation is needed based on source changes.
   */
  async needsRecompile(): Promise<boolean> {
    const signals = await this.extractSignals();
    const currentHash = this.computeSourceHash(signals);
    return currentHash !== this.freshnessState.lastSourceHash;
  }

  /**
   * Get the current draft (if any).
   */
  getCurrentDraft(): ProfileDraft | null {
    return this.currentDraft;
  }

  /**
   * Mark the current draft as published and update freshness state.
   */
  markPublished(): void {
    if (this.currentDraft) {
      this.freshnessState.lastPublishedAt = new Date().toISOString();
      if (this.currentDraft.approvedBy === 'auto') {
        this.freshnessState.consecutiveAutoPublishes++;
      } else {
        this.freshnessState.consecutiveAutoPublishes = 0;
      }
    }
  }

  /**
   * Check if auto-publish is allowed (max 3 consecutive without human review).
   */
  canAutoPublish(): boolean {
    return this.freshnessState.consecutiveAutoPublishes < MAX_CONSECUTIVE_AUTO_PUBLISHES;
  }

  /** Get freshness state for external inspection. */
  getFreshnessState(): ProfileFreshnessState {
    return { ...this.freshnessState };
  }

  // ── Step 1: Rule-Based Extraction ─────────────────────────────────

  async extractSignals(): Promise<StructuredSignals> {
    const [agentMd, taggedMemory, gitStats] = await Promise.all([
      this.readAgentMd(),
      this.readTaggedMemory(),
      this.getGitStats(),
    ]);

    const name = this.extractName(agentMd);
    const roleHints = this.extractRoleHints(agentMd);
    const specializationCandidates = this.extractSpecializations(agentMd, taggedMemory, gitStats);

    return {
      name,
      platform: 'instar',
      specializationCandidates,
      projectNames: gitStats.repos,
      commitStats: gitStats,
      jobNames: this.config.jobNames ?? [],
      capabilityNames: this.config.capabilities ?? [],
      roleHints,
      taggedMemoryEntries: taggedMemory,
    };
  }

  private async readAgentMd(): Promise<string> {
    const path = `${this.config.stateDir}/AGENT.md`;
    if (!existsSync(path)) return '';
    try {
      return await readFile(path, 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Read ONLY #profile-safe tagged entries from MEMORY.md.
   * USER.md is NEVER read (contains human PII).
   */
  private async readTaggedMemory(): Promise<string[]> {
    const path = `${this.config.stateDir}/MEMORY.md`;
    if (!existsSync(path)) return [];
    try {
      const content = await readFile(path, 'utf-8');
      const entries: string[] = [];
      // Extract entries tagged with #profile-safe
      const lines = content.split('\n');
      let currentEntry = '';
      let isTagged = false;

      for (const line of lines) {
        if (line.startsWith('## ') || line.startsWith('- ')) {
          if (isTagged && currentEntry.trim()) {
            entries.push(currentEntry.trim());
          }
          currentEntry = line;
          isTagged = line.includes('#profile-safe');
        } else {
          currentEntry += '\n' + line;
          if (line.includes('#profile-safe')) isTagged = true;
        }
      }
      if (isTagged && currentEntry.trim()) {
        entries.push(currentEntry.trim());
      }
      return entries;
    } catch {
      return [];
    }
  }

  private getGitStats(): { totalCommits: number; languages: string[]; repos: string[] } {
    try {
      // safe-git-allow: incremental-migration
      const commitCount = execSync(
        'git log --oneline 2>/dev/null | wc -l',
        { cwd: this.config.projectRoot, encoding: 'utf-8', timeout: 5000 },
      ).trim();

      // Get languages from file extensions
      // safe-git-allow: incremental-migration
      const files = execSync(
        'git ls-files 2>/dev/null | head -500',
        { cwd: this.config.projectRoot, encoding: 'utf-8', timeout: 5000 },
      ).trim();

      const extensions = new Set<string>();
      for (const file of files.split('\n')) {
        const ext = file.split('.').pop()?.toLowerCase();
        if (ext && ['ts', 'js', 'py', 'go', 'rs', 'tsx', 'jsx', 'css', 'html', 'sh'].includes(ext)) {
          extensions.add(ext === 'ts' || ext === 'tsx' ? 'TypeScript' :
            ext === 'js' || ext === 'jsx' ? 'JavaScript' :
            ext === 'py' ? 'Python' :
            ext === 'go' ? 'Go' :
            ext === 'rs' ? 'Rust' :
            ext === 'sh' ? 'Shell' : ext);
        }
      }

      // Get repo name from remote
      // safe-git-allow: incremental-migration
      const remote = execSync(
        'git remote get-url origin 2>/dev/null || echo "local"',
        { cwd: this.config.projectRoot, encoding: 'utf-8', timeout: 5000 },
      ).trim();
      const repoName = remote.split('/').pop()?.replace('.git', '') ?? 'unknown';

      return {
        totalCommits: parseInt(commitCount) || 0,
        languages: [...extensions],
        repos: [repoName],
      };
    } catch {
      return { totalCommits: 0, languages: [], repos: [] };
    }
  }

  private extractName(agentMd: string): string {
    const match = agentMd.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim() ?? 'Unknown Agent';
  }

  private extractRoleHints(agentMd: string): string[] {
    const hints: string[] = [];
    // Look for role-like statements
    const rolePatterns = [
      /I am (?:the )?(.+?)(?:\.|,|\n)/i,
      /(?:primary|lead|main) (\w+ (?:developer|engineer|builder|maintainer))/i,
    ];
    for (const pattern of rolePatterns) {
      const match = agentMd.match(pattern);
      if (match?.[1]) hints.push(match[1].trim());
    }
    return hints;
  }

  private extractSpecializations(
    agentMd: string,
    taggedMemory: string[],
    gitStats: { languages: string[] },
  ): Array<{ domain: string; evidence?: string }> {
    const specs: Array<{ domain: string; evidence?: string }> = [];

    // From git languages
    for (const lang of gitStats.languages) {
      specs.push({ domain: `${lang} development`, evidence: `Active contributor in ${lang}` });
    }

    // From AGENT.md keywords
    const domainKeywords = [
      'cryptographic', 'security', 'agent', 'protocol', 'identity',
      'testing', 'deployment', 'infrastructure', 'API', 'SDK',
    ];
    for (const keyword of domainKeywords) {
      if (agentMd.toLowerCase().includes(keyword.toLowerCase())) {
        specs.push({ domain: `${keyword} systems` });
      }
    }

    // From tagged memory
    for (const entry of taggedMemory) {
      const domainMatch = entry.match(/(?:specializ|expert|skill|proficien)\w*\s+(?:in\s+)?(.+?)(?:\.|,|\n|$)/i);
      if (domainMatch?.[1]) {
        specs.push({ domain: domainMatch[1].trim(), evidence: 'From agent memory' });
      }
    }

    // Deduplicate by domain
    const seen = new Set<string>();
    return specs.filter(s => {
      const key = s.domain.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, PROFILE_LIMITS.specializationsMaxEntries);
  }

  // ── Step 2: Profile Construction ──────────────────────────────────

  private async buildProfile(signals: StructuredSignals): Promise<RichProfilePayload> {
    // LLM synthesis for narrative (if available), otherwise rule-based
    let narrative: string;
    if (this.config.llmSynthesize) {
      try {
        narrative = await this.config.llmSynthesize(signals);
      } catch {
        narrative = this.buildRuleBasedNarrative(signals);
      }
    } else {
      narrative = this.buildRuleBasedNarrative(signals);
    }

    const specializations: Specialization[] = signals.specializationCandidates.map(s => ({
      domain: s.domain,
      level: 'working' as const,
      evidence: s.evidence,
    }));

    const trackRecord: TrackRecordEntry[] = signals.projectNames.map(name => ({
      title: `Contributor to ${name}`,
      description: `Active contributor with ${signals.commitStats.totalCommits} commits`,
      date: new Date().toISOString().split('T')[0],
      source: 'first_party' as const,
    }));

    const roleContext = signals.roleHints[0]
      ? signals.roleHints.slice(0, 2).join('. ')
      : `${signals.name} agent on ${signals.platform}`;

    return {
      narrative: narrative.slice(0, PROFILE_LIMITS.narrativeMaxChars),
      specializations: specializations.slice(0, PROFILE_LIMITS.specializationsMaxEntries),
      trackRecord: trackRecord.slice(0, PROFILE_LIMITS.trackRecordMaxEntries),
      roleContext: roleContext.slice(0, PROFILE_LIMITS.roleContextMaxChars),
      collaborationStyle: '',
      differentiation: '',
      fieldVisibility: {
        narrative: 'public',
        specializations: 'public',
        trackRecord: 'registered',
        roleContext: 'public',
        collaborationStyle: 'registered',
        differentiation: 'public',
      },
    };
  }

  private buildRuleBasedNarrative(signals: StructuredSignals): string {
    const parts: string[] = [];

    parts.push(`${signals.name} is an ${signals.platform} agent`);

    if (signals.roleHints.length > 0) {
      parts.push(signals.roleHints[0]);
    }

    if (signals.specializationCandidates.length > 0) {
      const domains = signals.specializationCandidates.slice(0, 3).map(s => s.domain);
      parts.push(`specializing in ${domains.join(', ')}`);
    }

    if (signals.commitStats.totalCommits > 0) {
      parts.push(`with ${signals.commitStats.totalCommits} commits across ${signals.commitStats.repos.join(', ')}`);
    }

    if (signals.jobNames.length > 0) {
      parts.push(`running ${signals.jobNames.length} scheduled jobs`);
    }

    return parts.join('. ') + '.';
  }

  // ── Content Hash ──────────────────────────────────────────────────

  private computeSourceHash(signals: StructuredSignals): string {
    const content = JSON.stringify(signals, Object.keys(signals).sort());
    return createHash('sha256').update(content).digest('hex');
  }
}
