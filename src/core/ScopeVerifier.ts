/**
 * ScopeVerifier — Pre-action scope verification for agents.
 *
 * Before high-risk actions (deployment, git push, external API calls),
 * the agent pauses to verify: "Am I in the right project? Does this
 * action match my identity and mission?"
 *
 * Born from the Luna incident (2026-02-25): An agent deployed to the
 * wrong production target because nothing validated that the intended
 * action matched the agent's current context.
 *
 * Design principle: Not a dumb pattern match — an intelligent
 * self-verification that gives the agent the ability to step back,
 * review what it's doing, and catch incoherence before it manifests.
 *
 * Three verification levels:
 * 1. Structural — git remote, working directory, project name match
 * 2. Contextual — action aligns with current topic/conversation scope
 * 3. Intent — action aligns with stated mission/boundaries in AGENT.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ScopeVerificationResult {
  /** Whether the action passed all coherence checks */
  passed: boolean;
  /** Individual check results */
  checks: ScopeCheck[];
  /** Human-readable summary */
  summary: string;
  /** Recommended action: proceed, warn, or block */
  recommendation: 'proceed' | 'warn' | 'block';
  /** Timestamp */
  checkedAt: string;
}

export interface ScopeCheck {
  /** Check name */
  name: string;
  /** Whether this check passed */
  passed: boolean;
  /** What was expected */
  expected: string;
  /** What was found */
  actual: string;
  /** Severity if failed: error blocks, warning alerts */
  severity: 'error' | 'warning' | 'info';
  /** Human-readable message */
  message: string;
}

export interface ScopeVerifierConfig {
  /** Project root directory */
  projectDir: string;
  /** Instar state directory */
  stateDir: string;
  /** Expected project name (from config) */
  projectName: string;
  /** Expected git remote (if known) */
  expectedGitRemote?: string;
  /** Topic-project bindings */
  topicProjects?: Record<string, TopicProjectBinding>;
}

export interface TopicProjectBinding {
  /** Human-readable project name */
  projectName: string;
  /** Path to the project directory */
  projectDir: string;
  /** Expected git remote URL */
  gitRemote?: string;
  /** Deployment target URLs */
  deploymentTargets?: string[];
  /** Description of this project */
  description?: string;
}

/** Actions that trigger coherence checking */
export type HighRiskAction =
  | 'deploy'
  | 'git-push'
  | 'external-api'
  | 'file-modify-outside-project'
  | 'production-change';

export class ScopeVerifier {
  private config: ScopeVerifierConfig;

  constructor(config: ScopeVerifierConfig) {
    this.config = config;
  }

  /**
   * Run a full coherence check for a proposed action.
   */
  check(action: HighRiskAction, context?: {
    targetUrl?: string;
    targetPath?: string;
    topicId?: number;
    description?: string;
  }): ScopeVerificationResult {
    const checks: ScopeCheck[] = [];

    // Check 1: Working directory matches expected project
    checks.push(this.checkWorkingDirectory());

    // Check 2: Git remote matches expected project
    checks.push(this.checkGitRemote());

    // Check 3: If topic is specified, verify topic-project alignment
    if (context?.topicId) {
      checks.push(this.checkTopicProjectAlignment(context.topicId));
    }

    // Check 4: If deploying, verify deployment target
    if ((action === 'deploy' || action === 'production-change') && context?.targetUrl) {
      checks.push(this.checkDeploymentTarget(context.targetUrl, context.topicId));
    }

    // Check 5: If modifying files, verify path is within project scope
    if (context?.targetPath) {
      checks.push(this.checkPathScope(context.targetPath));
    }

    // Check 6: Agent identity consistency
    checks.push(this.checkAgentIdentity());

    // Determine overall result
    const hasErrors = checks.some(c => !c.passed && c.severity === 'error');
    const hasWarnings = checks.some(c => !c.passed && c.severity === 'warning');
    const passed = !hasErrors;

    const recommendation = hasErrors ? 'block' : hasWarnings ? 'warn' : 'proceed';

    const failedChecks = checks.filter(c => !c.passed);
    const summary = passed
      ? `All ${checks.length} coherence checks passed.`
      : `${failedChecks.length}/${checks.length} checks failed: ${failedChecks.map(c => c.message).join('; ')}`;

    return {
      passed,
      checks,
      summary,
      recommendation,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Generate a self-verification prompt for the agent to reflect before acting.
   * This is the "step back and review" mechanism.
   */
  generateReflectionPrompt(action: HighRiskAction, context?: {
    targetUrl?: string;
    targetPath?: string;
    topicId?: number;
    topicName?: string;
    description?: string;
  }): string {
    const result = this.check(action, context);
    const lines: string[] = [];

    lines.push('=== PRE-ACTION COHERENCE CHECK ===');
    lines.push('');
    lines.push('Before proceeding, verify these assertions are correct:');
    lines.push('');

    // Identity
    lines.push(`1. I am working on: ${this.config.projectName}`);
    lines.push(`   Project directory: ${this.config.projectDir}`);

    // Git
    const gitRemote = this.detectGitRemote();
    if (gitRemote) {
      lines.push(`   Git remote: ${gitRemote}`);
    }

    // Topic context
    if (context?.topicId && context?.topicName) {
      const binding = this.getTopicBinding(context.topicId);
      if (binding) {
        lines.push(`2. This topic (${context.topicName}) is for: ${binding.projectName}`);
        lines.push(`   Expected project dir: ${binding.projectDir}`);
      } else {
        lines.push(`2. This topic (${context.topicName}) has NO project binding.`);
        lines.push(`   WARNING: Verify which project this topic is for before proceeding.`);
      }
    }

    // Action
    lines.push('');
    lines.push(`Action: ${action}`);
    if (context?.description) {
      lines.push(`Description: ${context.description}`);
    }
    if (context?.targetUrl) {
      lines.push(`Target URL: ${context.targetUrl}`);
    }
    if (context?.targetPath) {
      lines.push(`Target path: ${context.targetPath}`);
    }

    // Check results
    if (!result.passed) {
      lines.push('');
      lines.push('WARNING — COHERENCE ISSUES DETECTED:');
      for (const check of result.checks.filter(c => !c.passed)) {
        const icon = check.severity === 'error' ? '[BLOCK]' : '[WARN]';
        lines.push(`  ${icon} ${check.message}`);
        lines.push(`    Expected: ${check.expected}`);
        lines.push(`    Found: ${check.actual}`);
      }
    }

    lines.push('');
    lines.push('If any of the above is incorrect, STOP and verify before proceeding.');
    lines.push('=== END COHERENCE CHECK ===');

    return lines.join('\n');
  }

  /**
   * Get the topic-project binding for a specific topic.
   */
  getTopicBinding(topicId: number): TopicProjectBinding | null {
    return this.config.topicProjects?.[String(topicId)] ?? null;
  }

  /**
   * Register a topic-to-project binding.
   */
  setTopicBinding(topicId: number, binding: TopicProjectBinding): void {
    if (!this.config.topicProjects) {
      this.config.topicProjects = {};
    }
    this.config.topicProjects[String(topicId)] = binding;
    this.saveTopicBindings();
  }

  /**
   * Load topic-project bindings from disk.
   */
  loadTopicBindings(): Record<string, TopicProjectBinding> {
    const bindingsPath = path.join(this.config.stateDir, 'topic-project-bindings.json');
    try {
      if (fs.existsSync(bindingsPath)) {
        const data = JSON.parse(fs.readFileSync(bindingsPath, 'utf-8'));
        this.config.topicProjects = data;
        return data;
      }
    } catch {
      // @silent-fallback-ok — corrupt bindings, empty map
    }
    return {};
  }

  /**
   * Save topic-project bindings to disk.
   */
  private saveTopicBindings(): void {
    const bindingsPath = path.join(this.config.stateDir, 'topic-project-bindings.json');
    fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
    fs.writeFileSync(bindingsPath, JSON.stringify(this.config.topicProjects || {}, null, 2));
  }

  // ── Individual Checks ──────────────────────────────────────────

  private checkWorkingDirectory(): ScopeCheck {
    let cwd: string;
    try {
      cwd = process.cwd();
    } catch {
      cwd = 'unknown';
    }

    const expected = this.config.projectDir;
    const isWithin = cwd.startsWith(expected);

    return {
      name: 'working-directory',
      passed: isWithin,
      expected: `Within ${expected}`,
      actual: cwd,
      severity: 'warning',
      message: isWithin
        ? `Working directory is within project scope`
        : `Working directory (${cwd}) is outside project scope (${expected})`,
    };
  }

  private checkGitRemote(): ScopeCheck {
    const actual = this.detectGitRemote();
    const expected = this.config.expectedGitRemote;

    // If no expected remote configured, just report what we found
    if (!expected) {
      return {
        name: 'git-remote',
        passed: true,
        expected: 'any (no expected remote configured)',
        actual: actual || 'no git remote',
        severity: 'info',
        message: actual ? `Git remote: ${actual}` : 'No git remote detected',
      };
    }

    const matches = actual !== null && this.normalizeGitUrl(actual) === this.normalizeGitUrl(expected);

    return {
      name: 'git-remote',
      passed: matches,
      expected,
      actual: actual || 'no git remote',
      severity: 'error',
      message: matches
        ? `Git remote matches expected project`
        : `Git remote MISMATCH: expected ${expected}, found ${actual || 'none'}`,
    };
  }

  private checkTopicProjectAlignment(topicId: number): ScopeCheck {
    const binding = this.getTopicBinding(topicId);

    if (!binding) {
      return {
        name: 'topic-project-alignment',
        passed: false,
        expected: `Topic ${topicId} bound to a specific project`,
        actual: 'No topic-project binding exists',
        severity: 'warning',
        message: `Topic ${topicId} has no project binding — verify which project this topic is for`,
      };
    }

    // Check if current project matches the topic's expected project
    const currentProject = this.config.projectDir;
    const expectedProject = binding.projectDir;
    const matches = this.normalizePath(currentProject) === this.normalizePath(expectedProject);

    return {
      name: 'topic-project-alignment',
      passed: matches,
      expected: `${binding.projectName} (${expectedProject})`,
      actual: `${this.config.projectName} (${currentProject})`,
      severity: 'error',
      message: matches
        ? `Topic is correctly bound to ${binding.projectName}`
        : `WRONG PROJECT: Topic ${topicId} is for ${binding.projectName} but current project is ${this.config.projectName}`,
    };
  }

  private checkDeploymentTarget(targetUrl: string, topicId?: number): ScopeCheck {
    // If we have a topic binding with deployment targets, check against those
    if (topicId) {
      const binding = this.getTopicBinding(topicId);
      if (binding?.deploymentTargets && binding.deploymentTargets.length > 0) {
        const allowed = binding.deploymentTargets.some(t =>
          targetUrl.includes(t) || t.includes(targetUrl),
        );

        return {
          name: 'deployment-target',
          passed: allowed,
          expected: binding.deploymentTargets.join(', '),
          actual: targetUrl,
          severity: 'error',
          message: allowed
            ? `Deployment target matches project configuration`
            : `WRONG DEPLOY TARGET: ${targetUrl} is not in allowed targets for ${binding.projectName}`,
        };
      }
    }

    // No specific check possible without bindings
    return {
      name: 'deployment-target',
      passed: true,
      expected: 'any (no deployment targets configured)',
      actual: targetUrl,
      severity: 'warning',
      message: `Deploying to ${targetUrl} — no deployment target restrictions configured`,
    };
  }

  private checkPathScope(targetPath: string): ScopeCheck {
    const resolvedPath = path.resolve(targetPath);
    const projectDir = path.resolve(this.config.projectDir);
    const isWithin = resolvedPath.startsWith(projectDir);

    return {
      name: 'path-scope',
      passed: isWithin,
      expected: `Within ${projectDir}`,
      actual: resolvedPath,
      severity: 'error',
      message: isWithin
        ? `Target path is within project scope`
        : `PATH OUTSIDE PROJECT: ${resolvedPath} is outside ${projectDir}`,
    };
  }

  private checkAgentIdentity(): ScopeCheck {
    const agentMdPath = path.join(this.config.stateDir, 'AGENT.md');

    if (!fs.existsSync(agentMdPath)) {
      return {
        name: 'agent-identity',
        passed: false,
        expected: 'AGENT.md exists with identity',
        actual: 'AGENT.md not found',
        severity: 'warning',
        message: 'No AGENT.md found — agent identity not established',
      };
    }

    try {
      const content = fs.readFileSync(agentMdPath, 'utf-8');
      const hasName = /^#\s+.+/m.test(content);
      const hasIntent = /##\s+Intent/i.test(content);

      return {
        name: 'agent-identity',
        passed: hasName,
        expected: 'AGENT.md with name and intent',
        actual: `Name: ${hasName ? 'yes' : 'no'}, Intent: ${hasIntent ? 'yes' : 'no'}`,
        severity: hasName ? 'info' : 'warning',
        message: hasName
          ? `Agent identity established${hasIntent ? ' with intent section' : ''}`
          : 'AGENT.md exists but has no agent name',
      };
    } catch {
      return {
        name: 'agent-identity',
        passed: false,
        expected: 'Readable AGENT.md',
        actual: 'Failed to read AGENT.md',
        severity: 'warning',
        message: 'Failed to read AGENT.md',
      };
    }
  }

  // ── Helpers ──────────────────────────────────────────

  private detectGitRemote(): string | null {
    try {
      // safe-git-allow: incremental-migration
      return execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: this.config.projectDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim() || null;
    } catch {
      // @silent-fallback-ok — git remote detection
      return null;
    }
  }

  private normalizeGitUrl(url: string): string {
    return url
      .replace(/\.git$/, '')
      .replace(/^https:\/\/github\.com\//, '')
      .replace(/^git@github\.com:/, '')
      .toLowerCase();
  }

  private normalizePath(p: string): string {
    return path.resolve(p).replace(/\/+$/, '');
  }
}
