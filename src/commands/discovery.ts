/**
 * Agent Discovery — comprehensive scanning for existing agents.
 *
 * Scans four sources (priority order):
 *   1. Local filesystem (~/.instar/agents/ + CWD/.instar/)
 *   2. Local registry (~/.instar/registry.json) — with zombie validation
 *   3. GitHub personal repos (paginated via gh api)
 *   4. GitHub org repos (parallel, paginated, capped)
 *
 * Returns a structured SetupDiscoveryContext for the wizard.
 *
 * Security: All GitHub data is treated as untrusted.
 * Names are validated, URLs are checked, and output is delimited.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';

// ── Types ──────────────────────────────────────────────────────────

export interface DiscoveredGitHubAgent {
  name: string;           // agent name (e.g., "ai-guy")
  repo: string;           // full repo path (e.g., "JKHeadley/instar-ai-guy")
  owner: string;          // owner login (e.g., "SageMindAI")
  ownerType: 'user' | 'org';
  cloneUrl: string;       // Clone URL (HTTPS or SSH based on user preference)
  sshUrl: string;         // SSH clone URL (always populated as fallback)
}

export interface LocalAgent {
  name: string;
  path: string;
  type: 'project-bound' | 'standalone';
  status: 'running' | 'stopped';
  port?: number;
  userCount?: number;
  machineCount?: number;
}

export interface MergedAgent {
  name: string;
  path?: string;
  type?: 'project-bound' | 'standalone';
  status?: 'running' | 'stopped';
  port?: number;
  userCount?: number;
  machineCount?: number;
  repo?: string;
  owner?: string;
  ownerType?: 'user' | 'org';
  cloneUrl?: string;
  sshUrl?: string;
  source: 'local' | 'github' | 'both';
}

export interface SetupDiscoveryContext {
  local_agents: Array<{
    name: string;
    path: string;
    type: 'project-bound' | 'standalone';
    status: 'running' | 'stopped';
    port?: number;
    userCount?: number;
    machineCount?: number;
  }>;
  github_agents: Array<{
    name: string;
    repo: string;
    owner: string;
    ownerType: 'user' | 'org';
    cloneUrl: string;
    sshUrl: string;
  }>;
  merged_agents: MergedAgent[];
  current_dir_agent: {
    exists: boolean;
    name?: string;
    users?: string[];
    machines?: number;
  } | null;
  gh_status: 'ready' | 'auth-needed' | 'unavailable' | 'declined';
  scan_errors: string[];
  zombie_entries: string[];
}

type GhStatusInput = 'ready' | 'auth-needed' | 'unavailable';
type GhStatusFull = 'ready' | 'auth-needed' | 'unavailable' | 'declined';

export interface SetupScenarioContext {
  // Detection results
  isInsideGitRepo: boolean;
  existingAgentInCWD: boolean;
  existingUserCount: number;
  existingMachineCount: number;
  telegramConfigured: boolean;
  githubBackupsFound: boolean;
  localAgentsFound: boolean;

  // Resolved from detection + questions
  isMultiUser: boolean | null;
  isMultiMachine: boolean | null;
  resolvedScenario: number | null;

  // Entry point
  entryPoint: 'fresh' | 'existing' | 'restore' | 'reconfigure';
}

// ── Validation ─────────────────────────────────────────────────────

/** Agent name: alphanumeric, underscore, hyphen */
const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

/** Org name: alphanumeric, underscore, hyphen, dot */
const VALID_ORG = /^[a-zA-Z0-9_.-]+$/;

/** Clone URL: only GitHub HTTPS or SSH */
function isValidCloneUrl(url: string): boolean {
  return (
    url.startsWith('https://github.com/') ||
    url.startsWith('git@github.com:')
  );
}

// ── Registry Validation ────────────────────────────────────────────

interface RegistryValidationResult {
  validAgents: LocalAgent[];
  zombieEntries: string[];
}

/**
 * Validate registry entries against the filesystem.
 * Rejects zombie entries (path doesn't exist) and path traversal attempts.
 */
export function validateRegistry(projectDir: string): RegistryValidationResult {
  const registryPath = path.join(os.homedir(), '.instar', 'registry.json');
  const validAgents: LocalAgent[] = [];
  const zombieEntries: string[] = [];

  if (!fs.existsSync(registryPath)) {
    return { validAgents, zombieEntries };
  }

  let registry: { version: number; entries: Array<Record<string, unknown>> };
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  } catch {
    return { validAgents, zombieEntries };
  }

  if (!Array.isArray(registry.entries)) {
    return { validAgents, zombieEntries };
  }

  const allowedPrefixes = [
    path.join(os.homedir(), '.instar', 'agents'),
    projectDir,
  ];

  for (const entry of registry.entries) {
    const entryPath = String(entry.path || '');
    const entryName = String(entry.name || 'unknown');

    // Path traversal protection
    const resolvedPath = path.resolve(entryPath);
    const isAllowed = allowedPrefixes.some(prefix =>
      resolvedPath.startsWith(prefix)
    );

    if (!isAllowed) {
      zombieEntries.push(`${entryName} (${entryPath}) — outside allowed directories`);
      continue;
    }

    // Check path exists
    if (!fs.existsSync(entryPath)) {
      zombieEntries.push(`${entryName} (${entryPath}) — directory missing`);
      continue;
    }

    // Check for config.json
    const configPath = path.join(entryPath, '.instar', 'config.json');
    if (!fs.existsSync(configPath)) {
      zombieEntries.push(`${entryName} (${entryPath}) — no config.json`);
      continue;
    }

    // Read agent details
    let userCount = 0;
    let machineCount = 0;
    try {
      const usersPath = path.join(entryPath, '.instar', 'users.json');
      if (fs.existsSync(usersPath)) {
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
        userCount = Array.isArray(users) ? users.length : 0;
      }
    } catch { /* non-fatal */ }

    try {
      const machinesPath = path.join(entryPath, '.instar', 'machines', 'registry.json');
      if (fs.existsSync(machinesPath)) {
        const machines = JSON.parse(fs.readFileSync(machinesPath, 'utf-8'));
        machineCount = Object.keys(machines.machines || {}).filter(
          (k: string) => machines.machines[k].status === 'active'
        ).length;
      }
    } catch { /* non-fatal */ }

    validAgents.push({
      name: entryName,
      path: entryPath,
      type: (entry.type as 'standalone' | 'project-bound') || 'standalone',
      status: (entry.status as 'running' | 'stopped') || 'stopped',
      port: typeof entry.port === 'number' ? entry.port : undefined,
      userCount,
      machineCount,
    });
  }

  return { validAgents, zombieEntries };
}

// ── Local Filesystem Scanning ──────────────────────────────────────

/**
 * Scan for standalone agents in ~/.instar/agents/
 */
export function scanLocalAgents(): LocalAgent[] {
  const agentsDir = path.join(os.homedir(), '.instar', 'agents');
  const agents: LocalAgent[] = [];

  if (!fs.existsSync(agentsDir)) return agents;

  try {
    for (const name of fs.readdirSync(agentsDir)) {
      const agentDir = path.join(agentsDir, name);
      const configPath = path.join(agentDir, '.instar', 'config.json');

      if (!fs.existsSync(configPath)) continue;

      let userCount = 0;
      let machineCount = 0;

      try {
        const usersPath = path.join(agentDir, '.instar', 'users.json');
        if (fs.existsSync(usersPath)) {
          const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
          userCount = Array.isArray(users) ? users.length : 0;
        }
      } catch { /* non-fatal */ }

      try {
        const machinesPath = path.join(agentDir, '.instar', 'machines', 'registry.json');
        if (fs.existsSync(machinesPath)) {
          const machines = JSON.parse(fs.readFileSync(machinesPath, 'utf-8'));
          machineCount = Object.keys(machines.machines || {}).filter(
            (k: string) => machines.machines[k].status === 'active'
          ).length;
        }
      } catch { /* non-fatal */ }

      agents.push({
        name,
        path: agentDir,
        type: 'standalone',
        status: 'stopped', // Will be updated by registry merge
        userCount,
        machineCount,
      });
    }
  } catch { /* non-fatal */ }

  return agents;
}

// ── GitHub Scanning ────────────────────────────────────────────────

const MAX_ORGS = 10;
const CONCURRENCY = 5;
const GLOBAL_TIMEOUT = 15_000;

export interface GitHubScanResult {
  status: 'ready' | 'auth-needed' | 'unavailable' | 'declined';
  agents: DiscoveredGitHubAgent[];
  errors: string[];
  orgsTruncated: boolean;
  totalOrgs: number;
}

/**
 * Comprehensive GitHub scanning.
 * Scans personal repos + all orgs (paginated, parallel, capped).
 */
export function scanGitHub(ghPath: string): GitHubScanResult {
  const agents: DiscoveredGitHubAgent[] = [];
  const errors: string[] = [];

  // Check auth
  try {
    execFileSync(ghPath, ['auth', 'status'], { stdio: 'pipe', timeout: 5000 });
  } catch {
    return { status: 'auth-needed', agents: [], errors: [], orgsTruncated: false, totalOrgs: 0 };
  }

  // Detect user's preferred git protocol (ssh vs https)
  let gitProtocol = 'https';
  try {
    const proto = execFileSync(ghPath, ['config', 'get', 'git_protocol'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000,
    }).trim();
    if (proto === 'ssh') gitProtocol = 'ssh';
  } catch { /* default to https */ }

  // Get authenticated username
  let username = '';
  try {
    username = execFileSync(ghPath, ['api', 'user', '--jq', '.login'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
  } catch { /* continue without username */ }

  const startTime = Date.now();

  // 1. Personal repos (paginated via gh api)
  console.log(pc.dim('    Scanning your GitHub repos...'));
  try {
    const result = execFileSync(ghPath, [
      'api', 'user/repos', '--paginate',
      '--jq', '.[] | select(.name | startswith("instar-")) | {name, full_name: .full_name, clone_url: .clone_url, ssh_url: .ssh_url}',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }).trim();

    if (result) {
      for (const line of result.split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(line);
          const agentName = String(r.name || '').replace(/^instar-/, '');
          if (!VALID_NAME.test(agentName)) continue;
          const cloneUrl = gitProtocol === 'ssh' ? String(r.ssh_url || '') : String(r.clone_url || '');
          if (!isValidCloneUrl(cloneUrl)) continue;
          agents.push({
            name: agentName,
            repo: String(r.full_name || ''),
            owner: username,
            ownerType: 'user',
            cloneUrl,
            sshUrl: String(r.ssh_url || ''),
          });
        } catch { /* skip malformed entry */ }
      }
    }
  } catch {
    errors.push('Personal repos scan failed');
  }

  // 2. Organizations (paginated)
  let orgs: string[] = [];
  try {
    const orgResult = execFileSync(ghPath, [
      'api', 'user/orgs', '--paginate', '--jq', '.[].login',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }).trim();

    if (orgResult) {
      orgs = orgResult.split('\n').filter(o => Boolean(o) && VALID_ORG.test(o));
    }
  } catch {
    errors.push('Organization listing failed');
  }

  const totalOrgs = orgs.length;
  let orgsTruncated = false;
  if (orgs.length > MAX_ORGS) {
    orgsTruncated = true;
    orgs = orgs.slice(0, MAX_ORGS);
  }

  // Scan orgs in batches with concurrency cap and global timeout
  if (orgs.length > 0) {
    console.log(pc.dim(`    Scanning organizations (${orgs.length})...`));
  }

  for (let i = 0; i < orgs.length; i += CONCURRENCY) {
    if (Date.now() - startTime > GLOBAL_TIMEOUT) {
      errors.push(`Discovery timeout — scanned ${i} of ${orgs.length} organizations`);
      break;
    }

    const batch = orgs.slice(i, i + CONCURRENCY);
    if (orgs.length > CONCURRENCY) {
      console.log(pc.dim(`    Scanning organizations (${i + 1}-${Math.min(i + CONCURRENCY, orgs.length)} of ${orgs.length})...`));
    }

    // Scan each org in the batch (synchronous per-org, batched for progress)
    for (const org of batch) {
      if (Date.now() - startTime > GLOBAL_TIMEOUT) break;

      try {
        const result = execFileSync(ghPath, [
          'api', `orgs/${org}/repos`, '--paginate',
          '--jq', '.[] | select(.name | startswith("instar-")) | {name, full_name: .full_name, clone_url: .clone_url, ssh_url: .ssh_url}',
        ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }).trim();

        if (result) {
          for (const line of result.split('\n').filter(Boolean)) {
            try {
              const r = JSON.parse(line);
              const agentName = String(r.name || '').replace(/^instar-/, '');
              if (!VALID_NAME.test(agentName)) continue;
              const cloneUrl = gitProtocol === 'ssh' ? String(r.ssh_url || '') : String(r.clone_url || '');
              if (!isValidCloneUrl(cloneUrl)) continue;
              agents.push({
                name: agentName,
                repo: String(r.full_name || ''),
                owner: org,
                ownerType: 'org',
                cloneUrl,
                sshUrl: String(r.ssh_url || ''),
              });
            } catch { /* skip malformed entry */ }
          }
        }
      } catch {
        // Redact org name in error (privacy)
        errors.push(`Organization scan failed (${orgs.indexOf(org) + 1} of ${orgs.length})`);
      }
    }
  }

  if (orgsTruncated) {
    errors.push(`Showing agents from first ${MAX_ORGS} organizations. Run 'instar scan --all-orgs' to see all.`);
  }

  // Deduplicate by repo (nameWithOwner)
  const seen = new Set<string>();
  const deduped = agents.filter(a => {
    if (seen.has(a.repo)) return false;
    seen.add(a.repo);
    return true;
  });

  return { status: 'ready', agents: deduped, errors, orgsTruncated, totalOrgs };
}

// ── Discovery Merge ────────────────────────────────────────────────

/**
 * Merge local and GitHub discovery results.
 * Local takes priority when an agent appears in both.
 */
export function mergeDiscoveryResults(
  local: LocalAgent[],
  github: DiscoveredGitHubAgent[],
): MergedAgent[] {
  const merged: MergedAgent[] = [];
  const matchedGithub = new Set<string>();

  // Match by agent name (from repo name minus 'instar-' prefix)
  for (const localAgent of local) {
    const githubMatch = github.find(g =>
      g.name === localAgent.name &&
      !matchedGithub.has(g.repo)
    );

    if (githubMatch) {
      matchedGithub.add(githubMatch.repo);
      merged.push({
        ...localAgent,
        repo: githubMatch.repo,
        owner: githubMatch.owner,
        ownerType: githubMatch.ownerType,
        cloneUrl: githubMatch.cloneUrl,
        sshUrl: githubMatch.sshUrl,
        source: 'both',
      });
    } else {
      merged.push({ ...localAgent, source: 'local' });
    }
  }

  // Unmatched GitHub agents
  for (const g of github) {
    if (!matchedGithub.has(g.repo)) {
      merged.push({
        name: g.name,
        repo: g.repo,
        owner: g.owner,
        ownerType: g.ownerType,
        cloneUrl: g.cloneUrl,
        sshUrl: g.sshUrl,
        source: 'github',
      });
    }
  }

  return merged;
}

// ── Full Discovery Pipeline ────────────────────────────────────────

/**
 * Run the complete discovery pipeline.
 * Returns structured context for the wizard.
 */
export function runDiscovery(
  projectDir: string,
  ghPath: string | null,
  ghStatus: GhStatusInput,
): SetupDiscoveryContext {
  const scanErrors: string[] = [];

  // 1. Scan local filesystem
  const localAgents = scanLocalAgents();

  // 2. Validate registry (adds agents not found by filesystem scan, flags zombies)
  const { validAgents: registryAgents, zombieEntries } = validateRegistry(projectDir);

  // Merge local filesystem scan with registry (registry may have project-bound agents)
  const localPaths = new Set(localAgents.map(a => a.path));
  for (const regAgent of registryAgents) {
    if (!localPaths.has(regAgent.path)) {
      localAgents.push(regAgent);
    } else {
      // Update status from registry (which tracks running state)
      const existing = localAgents.find(a => a.path === regAgent.path);
      if (existing && regAgent.status === 'running') {
        existing.status = 'running';
        existing.port = regAgent.port;
      }
    }
  }

  // 3. Scan GitHub (if available)
  let githubAgents: DiscoveredGitHubAgent[] = [];
  let resolvedGhStatus: GhStatusFull = ghStatus;

  if (ghPath && ghStatus === 'ready') {
    const ghResult = scanGitHub(ghPath);
    resolvedGhStatus = ghResult.status as GhStatusFull;
    githubAgents = ghResult.agents;
    scanErrors.push(...ghResult.errors);
  }

  // 4. Merge results
  const mergedAgents = mergeDiscoveryResults(localAgents, githubAgents);

  // 5. Check current directory for existing agent
  let currentDirAgent: SetupDiscoveryContext['current_dir_agent'] = null;
  const stateDir = path.join(projectDir, '.instar');
  if (fs.existsSync(path.join(stateDir, 'config.json'))) {
    let agentName = 'unknown';
    let users: string[] = [];
    let machines = 0;

    try {
      const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
      agentName = config.projectName || 'unknown';
    } catch { /* use defaults */ }

    try {
      const usersData = JSON.parse(fs.readFileSync(path.join(stateDir, 'users.json'), 'utf-8'));
      users = usersData.map((u: { name: string }) => u.name);
    } catch { /* empty */ }

    try {
      const registry = JSON.parse(fs.readFileSync(path.join(stateDir, 'machines', 'registry.json'), 'utf-8'));
      machines = Object.keys(registry.machines || {}).filter(
        (k: string) => registry.machines[k].status === 'active'
      ).length;
    } catch { /* zero */ }

    currentDirAgent = { exists: true, name: agentName, users, machines };
  }

  return {
    local_agents: localAgents,
    github_agents: githubAgents,
    merged_agents: mergedAgents,
    current_dir_agent: currentDirAgent,
    gh_status: resolvedGhStatus,
    scan_errors: scanErrors,
    zombie_entries: zombieEntries,
  };
}

// ── Scenario Inference ─────────────────────────────────────────────

/**
 * Build scenario context from discovery results + environment detection.
 * The scenario is not fully resolved here — the wizard asks 1-2 questions
 * to narrow down for fresh installs.
 */
export function buildScenarioContext(
  discovery: SetupDiscoveryContext,
  isInsideGitRepo: boolean,
): SetupScenarioContext {
  const existing = discovery.current_dir_agent;
  const hasExisting = existing?.exists || false;

  // Read existing config for Telegram detection
  let telegramConfigured = false;
  if (hasExisting) {
    try {
      const stateDir = path.join(process.cwd(), '.instar');
      const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
      telegramConfigured = config.messaging?.some(
        (m: { type: string; enabled?: boolean }) => m.type === 'telegram' && m.enabled !== false
      ) || false;
    } catch { /* false */ }
  }

  const userCount = existing?.users?.length || 0;
  const machineCount = existing?.machines || 0;

  // Determine entry point
  let entryPoint: SetupScenarioContext['entryPoint'] = 'fresh';
  if (hasExisting && userCount > 0) {
    entryPoint = 'existing';
  } else if (discovery.github_agents.length > 0) {
    entryPoint = 'restore';
  }

  // For existing agents, we can infer multi-user/multi-machine
  let isMultiUser: boolean | null = null;
  let isMultiMachine: boolean | null = null;

  if (hasExisting) {
    isMultiUser = userCount > 1;
    isMultiMachine = machineCount > 1;
  }

  // Resolve scenario for existing agents (fresh installs need wizard questions)
  let resolvedScenario: number | null = null;
  if (hasExisting && isMultiUser !== null && isMultiMachine !== null) {
    resolvedScenario = resolveScenario(isInsideGitRepo, isMultiUser, isMultiMachine);
  }

  return {
    isInsideGitRepo,
    existingAgentInCWD: hasExisting,
    existingUserCount: userCount,
    existingMachineCount: machineCount,
    telegramConfigured,
    githubBackupsFound: discovery.github_agents.length > 0,
    localAgentsFound: discovery.local_agents.length > 0,
    isMultiUser,
    isMultiMachine,
    resolvedScenario,
    entryPoint,
  };
}

/**
 * Resolve scenario number from the three binary axes.
 *
 * | In repo? | Multi-user? | Multi-machine? | Scenario |
 * |----------|-------------|----------------|----------|
 * | No       | No          | No             | 1        |
 * | No       | No          | Yes            | 2        |
 * | Yes      | No          | No             | 3        |
 * | Yes      | No          | Yes            | 4        |
 * | Yes      | Yes         | No             | 5        |
 * | Yes      | Yes         | Yes            | 6        |
 * | No       | Yes         | Yes            | 7        |
 * | No       | Yes         | No             | 8        |
 */
export function resolveScenario(
  isRepo: boolean,
  isMultiUser: boolean,
  isMultiMachine: boolean,
): number {
  if (isRepo) {
    if (!isMultiUser && !isMultiMachine) return 3;
    if (!isMultiUser && isMultiMachine) return 4;
    if (isMultiUser && !isMultiMachine) return 5;
    return 6; // multi-user + multi-machine
  } else {
    if (!isMultiUser && !isMultiMachine) return 1;
    if (!isMultiUser && isMultiMachine) return 2;
    if (isMultiUser && !isMultiMachine) return 8;
    return 7; // multi-user + multi-machine
  }
}

// ── Setup Lock File ────────────────────────────────────────────────

export interface SetupLock {
  startedAt: string;
  agentName: string;
  scenario: number | null;
  phase: string;
  filesCreated: string[];
  reposCreated: string[];
}

const LOCK_PATH = path.join(os.homedir(), '.instar', 'setup-lock.json');

export function readSetupLock(): SetupLock | null {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8'));
    }
  } catch { /* corrupted lock */ }
  return null;
}

export function writeSetupLock(lock: SetupLock): void {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2));
}

export function deleteSetupLock(): void {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      // safe-git-allow: incremental-migration
      fs.unlinkSync(LOCK_PATH);
    }
  } catch { /* non-fatal */ }
}
