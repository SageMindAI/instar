/**
 * Auto-detection and configuration management.
 *
 * Finds tmux, Claude CLI, and project structure automatically.
 * Adapted from dawn-server's config.ts — the battle-tested version.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mergeConfigWithSecrets } from './SecretMigrator.js';
import os from 'node:os';
import type { InstarConfig, SessionManagerConfig, JobSchedulerConfig, FeedbackConfig, AgentType, SemanticMemoryConfig } from './types.js';

const DEFAULT_PORT = 4040;
const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_MAX_PARALLEL_JOBS = 2;

export function getInstarVersion(): string {
  try {
    // Walk up from this file to find package.json
    let dir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'instar') return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // @silent-fallback-ok — version detection defaults to 0.0.0
  }
  return '0.0.0';
}

export function detectGitPath(): string | null {
  const candidates = [
    '/usr/bin/git',
    '/opt/homebrew/bin/git',  // macOS ARM (Homebrew)
    '/usr/local/bin/git',     // macOS Intel / Linux
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback: check PATH
  try {
    const result = execFileSync('which', ['git'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // @silent-fallback-ok — git path detection
  }

  return null;
}

export function detectGhPath(): string | null {
  const candidates = [
    '/opt/homebrew/bin/gh',   // macOS ARM (Homebrew)
    '/usr/local/bin/gh',      // macOS Intel / Linux
    '/usr/bin/gh',            // Linux system
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback: check PATH
  try {
    const result = execFileSync('which', ['gh'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // @silent-fallback-ok — gh path detection
  }

  return null;
}

export function detectTmuxPath(): string | null {
  const candidates = [
    '/opt/homebrew/bin/tmux',  // macOS ARM (Homebrew)
    '/usr/local/bin/tmux',     // macOS Intel / Linux
    '/usr/bin/tmux',           // Linux system
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback: check PATH
  try {
    const result = execFileSync('which', ['tmux'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // @silent-fallback-ok — tmux path detection loop
  }

  return null;
}

export function detectClaudePath(): string | null {
  const home = process.env.HOME || '';
  const candidates = [
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];

  // Also check npm global bin directory (where `npm install -g` puts things)
  try {
    const npmPrefix = execFileSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (npmPrefix) {
      candidates.push(path.join(npmPrefix, 'bin', 'claude'));
    }
  } catch {
    // @silent-fallback-ok — claude path detection loop
  }

  // Check nvm/fnm managed paths
  if (process.env.NVM_BIN) {
    candidates.push(path.join(process.env.NVM_BIN, 'claude'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback: check PATH
  try {
    const result = execFileSync('which', ['claude'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // @silent-fallback-ok — claude path detection loop
  }

  return null;
}

export function detectProjectDir(startDir?: string): string {
  let dir = startDir || process.cwd();

  // Walk up to find a directory with CLAUDE.md or .git
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'CLAUDE.md')) || fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return process.cwd();
}

/**
 * Get the path to the standalone agents directory.
 */
export function standaloneAgentsDir(): string {
  return path.join(os.homedir(), '.instar', 'agents');
}

/**
 * Resolve an agent directory from a name or path.
 *
 * Resolution order:
 * 1. If nameOrPath is an absolute path under ~/.instar/agents/ or cwd, use it
 * 2. If nameOrPath matches a standalone agent name, return ~/.instar/agents/<name>/
 * 3. If no argument, use detectProjectDir() (existing behavior)
 */
export function resolveAgentDir(nameOrPath?: string): string {
  if (!nameOrPath) {
    return detectProjectDir();
  }

  // Absolute path — verify it's under a known location
  if (path.isAbsolute(nameOrPath)) {
    const resolved = fs.realpathSync(nameOrPath);
    const agentsDir = standaloneAgentsDir();
    if (resolved.startsWith(agentsDir) || resolved === process.cwd() || resolved.startsWith(process.cwd())) {
      return resolved;
    }
    // Allow any existing directory with .instar in it
    if (fs.existsSync(path.join(resolved, '.instar', 'config.json'))) {
      return resolved;
    }
    throw new Error(`Path "${nameOrPath}" does not appear to be a valid agent directory.`);
  }

  // Check if it's a standalone agent name
  const agentDir = path.join(standaloneAgentsDir(), nameOrPath);
  if (fs.existsSync(path.join(agentDir, '.instar', 'config.json'))) {
    return agentDir;
  }

  // Check global registry for the name (dynamic import to avoid circular deps)
  try {
    const registryPath = path.join(os.homedir(), '.instar', 'registry.json');
    if (fs.existsSync(registryPath)) {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const entry = entries.find((e: { name: string }) => e.name === nameOrPath);
      if (entry?.path) return entry.path;
    }
  } catch { /* registry may not exist yet */ }

  throw new Error(
    `Agent "${nameOrPath}" not found. Check standalone agents at ${standaloneAgentsDir()}/ ` +
    `or use an absolute path.`
  );
}

export function loadConfig(projectDir?: string): InstarConfig {
  const resolvedProjectDir = projectDir || detectProjectDir();
  const configPath = path.join(resolvedProjectDir, '.instar', 'config.json');
  const stateDir = path.join(resolvedProjectDir, '.instar');

  // Load config file if it exists
  let fileConfig: Partial<InstarConfig> = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      throw new Error(
        `Failed to parse ${configPath}: ${err instanceof Error ? err.message : err}\n` +
        `Check that .instar/config.json contains valid JSON.`
      );
    }
  }

  // Merge encrypted secrets into config (replaces { "secret": true } placeholders)
  // This is transparent — single-machine users without a SecretStore see no change.
  try {
    fileConfig = mergeConfigWithSecrets(fileConfig as Record<string, unknown>, stateDir) as Partial<InstarConfig>;
  } catch {
    // Non-fatal — config works without secrets (just missing the secret values)
  }

  const tmuxPath = fileConfig.sessions?.tmuxPath || detectTmuxPath();
  const claudePath = fileConfig.sessions?.claudePath || detectClaudePath();

  if (!tmuxPath) {
    throw new Error('tmux not found. Install with: brew install tmux (macOS) or apt install tmux (Linux)');
  }
  if (!claudePath) {
    throw new Error('Claude CLI not found. Install from: https://docs.anthropic.com/en/docs/claude-code');
  }

  const projectName = fileConfig.projectName || path.basename(resolvedProjectDir);

  const sessions: SessionManagerConfig = {
    tmuxPath,
    claudePath,
    projectDir: resolvedProjectDir,
    maxSessions: fileConfig.sessions?.maxSessions ?? DEFAULT_MAX_SESSIONS,
    protectedSessions: fileConfig.sessions?.protectedSessions || [`${projectName}-server`],
    completionPatterns: fileConfig.sessions?.completionPatterns || [
      'has been automatically paused',
      'Session ended',
      'Interrupted by user',
    ],
    authToken: fileConfig.authToken as string | undefined,
    port: (fileConfig.port as number | undefined) ?? 4040,
    anthropicApiKey: fileConfig.sessions?.anthropicApiKey as string | undefined,
    anthropicBaseUrl: fileConfig.sessions?.anthropicBaseUrl as string | undefined,
  };

  const scheduler: JobSchedulerConfig = {
    jobsFile: fileConfig.scheduler?.jobsFile || path.join(stateDir, 'jobs.json'),
    enabled: fileConfig.scheduler?.enabled ?? false,
    maxParallelJobs: fileConfig.scheduler?.maxParallelJobs ?? DEFAULT_MAX_PARALLEL_JOBS,
    quotaThresholds: fileConfig.scheduler?.quotaThresholds || {
      normal: 75,
      elevated: 85,
      critical: 92,
      shutdown: 95,
    },
    authToken: fileConfig.authToken as string | undefined,
  };

  // Auto-generate contextSigningKey if not present (persists to config file)
  let contextSigningKey = fileConfig.contextSigningKey as string | undefined;
  if (!contextSigningKey && fs.existsSync(configPath)) {
    contextSigningKey = crypto.randomBytes(32).toString('hex');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      raw.contextSigningKey = contextSigningKey;
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
    } catch {
      // Non-fatal — integrity verification will be skipped if key can't be persisted
      contextSigningKey = undefined;
    }
  }

  const host = fileConfig.host || '127.0.0.1';

  // Warn if binding to a non-loopback address without auth token
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !fileConfig.authToken) {
    console.warn(
      `[Config] WARNING: Server binding to ${host} without authToken configured. ` +
      `This exposes the API without authentication. Set authToken in .instar/config.json.`
    );
  }

  return {
    // Spread fileConfig as base so all optional fields (safety, evolution,
    // agentAutonomy, externalOperations, autonomyProfile, notifications,
    // responseReview, inputGuard, dashboard, moltbridge, etc.) pass through.
    // Explicitly constructed fields below override the spread.
    ...fileConfig,
    projectName,
    projectDir: resolvedProjectDir,
    stateDir,
    port: fileConfig.port || DEFAULT_PORT,
    host,
    version: getInstarVersion(),
    sessions,
    scheduler,
    users: fileConfig.users || [],
    messaging: fileConfig.messaging || [],
    monitoring: {
      quotaTracking: true,
      memoryMonitoring: true,
      healthCheckIntervalMs: 30000,
      ...fileConfig.monitoring,
      // Watchdog default-enabled so compaction-idle detection runs everywhere.
      // Cost is ~free (30s poll cadence with structural process check first).
      // Without this, sessions that compact via Telegram/Slack go dead silently.
      watchdog: fileConfig.monitoring?.watchdog ?? { enabled: true },
      // Telemetry defaults: strictly opt-in
      telemetry: fileConfig.monitoring?.telemetry ?? { enabled: false },
    },
    authToken: fileConfig.authToken,
    dashboardPin: fileConfig.dashboardPin,
    relationships: fileConfig.relationships || {
      relationshipsDir: path.join(stateDir, 'relationships'),
      maxRecentInteractions: 20,
    },
    feedback: {
      enabled: true,
      webhookUrl: 'https://dawn.bot-me.ai/api/instar/feedback',
      feedbackFile: path.join(stateDir, 'feedback.json'),
      ...fileConfig.feedback,
    },
    dispatches: fileConfig.dispatches,
    updates: fileConfig.updates,
    publishing: fileConfig.publishing,
    tunnel: fileConfig.tunnel,
    threadline: fileConfig.threadline,
    agentType: resolvedProjectDir.startsWith(standaloneAgentsDir())
      ? 'standalone'
      : (fileConfig as Record<string, unknown>).agentType as AgentType | undefined || 'project-bound',
    contextSigningKey,
    memory: (fileConfig as Record<string, unknown>).memory as Partial<InstarConfig['memory']> || undefined,
  };
}

/**
 * Ensure the state directory structure exists.
 */
export function ensureStateDir(stateDir: string): void {
  const dirs = [
    stateDir,
    path.join(stateDir, 'state'),
    path.join(stateDir, 'state', 'sessions'),
    path.join(stateDir, 'state', 'jobs'),
    path.join(stateDir, 'relationships'),
    path.join(stateDir, 'views'),
    path.join(stateDir, 'logs'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Build a SemanticMemoryConfig from an InstarConfig.
 *
 * Reads user overrides from config.memory (loaded from .instar/config.json "memory" key)
 * and falls back to sensible defaults. This centralizes the values that were previously
 * hardcoded across commands/knowledge.ts, commands/memory.ts, commands/semantic.ts,
 * and commands/server.ts.
 */
export function getSemanticMemoryConfig(config: InstarConfig): SemanticMemoryConfig {
  const mem = config.memory || {};
  return {
    dbPath: mem.dbPath || path.join(config.stateDir, 'semantic.db'),
    decayHalfLifeDays: mem.decayHalfLifeDays ?? 30,
    lessonDecayHalfLifeDays: mem.lessonDecayHalfLifeDays ?? 90,
    staleThreshold: mem.staleThreshold ?? 0.2,
  };
}
