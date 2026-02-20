/**
 * Auto-detection and configuration management.
 *
 * Finds tmux, Claude CLI, and project structure automatically.
 * Adapted from dawn-server's config.ts — the battle-tested version.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKitConfig, SessionManagerConfig, JobSchedulerConfig, FeedbackConfig } from './types.js';

const DEFAULT_PORT = 4040;
const DEFAULT_MAX_SESSIONS = 3;
const DEFAULT_MAX_PARALLEL_JOBS = 2;

function getInstarVersion(): string {
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
  } catch { /* ignore */ }
  return '0.0.0';
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
    const result = execSync('which tmux', { encoding: 'utf-8' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // tmux not found
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
    const npmPrefix = execSync('npm config get prefix', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (npmPrefix) {
      candidates.push(path.join(npmPrefix, 'bin', 'claude'));
    }
  } catch { /* ignore */ }

  // Check nvm/fnm managed paths
  if (process.env.NVM_BIN) {
    candidates.push(path.join(process.env.NVM_BIN, 'claude'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback: check PATH
  try {
    const result = execSync('which claude', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // claude not found
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

export function loadConfig(projectDir?: string): AgentKitConfig {
  const resolvedProjectDir = projectDir || detectProjectDir();
  const configPath = path.join(resolvedProjectDir, '.instar', 'config.json');
  const stateDir = path.join(resolvedProjectDir, '.instar');

  // Load config file if it exists
  let fileConfig: Partial<AgentKitConfig> = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  const tmuxPath = detectTmuxPath();
  const claudePath = detectClaudePath();

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
  };

  const scheduler: JobSchedulerConfig = {
    jobsFile: fileConfig.scheduler?.jobsFile || path.join(stateDir, 'jobs.json'),
    enabled: fileConfig.scheduler?.enabled ?? false,
    maxParallelJobs: fileConfig.scheduler?.maxParallelJobs ?? DEFAULT_MAX_PARALLEL_JOBS,
    quotaThresholds: fileConfig.scheduler?.quotaThresholds || {
      normal: 50,
      elevated: 70,
      critical: 85,
      shutdown: 95,
    },
  };

  return {
    projectName,
    projectDir: resolvedProjectDir,
    stateDir,
    port: fileConfig.port || DEFAULT_PORT,
    host: fileConfig.host || '127.0.0.1',
    version: getInstarVersion(),
    sessions,
    scheduler,
    users: fileConfig.users || [],
    messaging: fileConfig.messaging || [],
    monitoring: fileConfig.monitoring || {
      quotaTracking: true,
      memoryMonitoring: true,
      healthCheckIntervalMs: 30000,
    },
    authToken: fileConfig.authToken,
    relationships: fileConfig.relationships || {
      relationshipsDir: path.join(stateDir, 'relationships'),
      maxRecentInteractions: 20,
    },
    feedback: fileConfig.feedback || {
      enabled: false,
      webhookUrl: 'https://dawn.bot-me.ai/api/instar/feedback',
      feedbackFile: path.join(stateDir, 'feedback.json'),
    },
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
    path.join(stateDir, 'logs'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
