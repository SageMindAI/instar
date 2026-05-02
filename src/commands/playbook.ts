/**
 * `instar playbook` — Context engineering for autonomous AI agents.
 *
 * Wraps the Playbook Python scripts via execFileSync. All Python invocations
 * use array arguments (never shell interpolation) for injection safety.
 *
 * Commands:
 *   instar playbook init                       Initialize playbook for this project
 *   instar playbook doctor                     Validate Python, venv, config integrity
 *   instar playbook status                     Show manifest health and item counts
 *   instar playbook list [--tag TAG]           List manifest items
 *   instar playbook read ITEM_ID               Display a single manifest item
 *   instar playbook add --content "..."        Add a new context item
 *   instar playbook search QUERY               Search items by content/tags
 *   instar playbook assemble [--tags "..."]    Assemble context for a session
 *   instar playbook evaluate SESSION_LOG       Evaluate session context usage
 *   instar playbook lifecycle [--dry-run]      Run full lifecycle pass
 *   instar playbook validate                   Validate manifest schema + integrity
 *   instar playbook mount PATH --name NAME     Mount external manifest overlay
 *   instar playbook unmount NAME               Remove a mount
 *   instar playbook export [--format json|md]  Export manifest
 *   instar playbook import FILE                Import items (validated)
 *   instar playbook eject [script|--all]       Copy scripts for customization
 *   instar playbook user-export USER_ID        DSAR: export user data
 *   instar playbook user-delete USER_ID        DSAR: delete user data
 *   instar playbook user-audit USER_ID         DSAR: audit trail for user
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';

// ── Types ──────────────────────────────────────────────────────────

interface PlaybookOptions {
  dir?: string;
  json?: boolean;
  debug?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

interface PlaybookListOptions extends PlaybookOptions {
  tag?: string;
  type?: string;
}

interface PlaybookAddOptions extends PlaybookOptions {
  content?: string;
  contentFile?: string;
  tags?: string;
  type?: string;
  category?: string;
}

interface PlaybookSearchOptions extends PlaybookOptions {
  limit?: number;
}

interface PlaybookAssembleOptions extends PlaybookOptions {
  tags?: string;
  budget?: number;
  triggers?: string;
}

interface PlaybookLifecycleOptions extends PlaybookOptions {
  dryRun?: boolean;
}

interface PlaybookExportOptions extends PlaybookOptions {
  format?: string;
}

interface PlaybookMountOptions extends PlaybookOptions {
  name: string;
}

interface PlaybookEjectOptions extends PlaybookOptions {
  all?: boolean;
}

interface PlaybookUserOptions extends PlaybookOptions {
  confirm?: boolean;
}

// ── Python Resolution ──────────────────────────────────────────────

interface PythonInfo {
  interpreter: string;
  version: string;
  isVenv: boolean;
}

/**
 * Resolve the Python interpreter to use.
 *
 * Resolution order:
 * 1. INSTAR_PYTHON env var (explicit override)
 * 2. Project venv (.instar/playbook/.venv/bin/python3)
 * 3. System python3
 * 4. System python (if >= 3.10)
 */
function resolvePython(stateDir: string): PythonInfo {
  // 1. Env var override
  const envPython = process.env.INSTAR_PYTHON;
  if (envPython) {
    const version = getPythonVersion(envPython);
    if (version) {
      return { interpreter: envPython, version, isVenv: false };
    }
    throw new Error(
      `INSTAR_PYTHON=${envPython} is not a valid Python interpreter`
    );
  }

  // 2. Project venv
  const venvPython = path.join(stateDir, 'playbook', '.venv', 'bin', 'python3');
  if (fs.existsSync(venvPython)) {
    const version = getPythonVersion(venvPython);
    if (version) {
      return { interpreter: venvPython, version, isVenv: true };
    }
  }

  // 3. System python3
  try {
    const version = getPythonVersion('python3');
    if (version) {
      return { interpreter: 'python3', version, isVenv: false };
    }
  } catch {
    // Not found, try python
  }

  // 4. System python
  try {
    const version = getPythonVersion('python');
    if (version && isVersionAtLeast(version, '3.10')) {
      return { interpreter: 'python', version, isVenv: false };
    }
  } catch {
    // Not found
  }

  throw new Error(
    'Python 3.10+ not found. Install Python or set INSTAR_PYTHON env var.\n' +
    '  macOS: brew install python3\n' +
    '  Ubuntu: sudo apt install python3\n' +
    '  Or: export INSTAR_PYTHON=/path/to/python3'
  );
}

function getPythonVersion(interpreter: string): string | null {
  try {
    const output = execFileSync(interpreter, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // "Python 3.12.0" -> "3.12.0"
    const match = output.match(/Python\s+(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function isVersionAtLeast(version: string, minimum: string): boolean {
  const [vMaj, vMin] = version.split('.').map(Number);
  const [mMaj, mMin] = minimum.split('.').map(Number);
  return vMaj > mMaj || (vMaj === mMaj && vMin >= mMin);
}

// ── Script Resolution ──────────────────────────────────────────────

/**
 * Resolve the path to a playbook Python script.
 *
 * Resolution order:
 * 1. Ejected scripts in project (.instar/playbook/scripts/)
 * 2. Bundled scripts (resolved from playbook-config.json or default location)
 */
function resolveScript(stateDir: string, scriptName: string): string {
  // 1. Ejected script
  const ejected = path.join(stateDir, 'playbook', 'scripts', scriptName);
  if (fs.existsSync(ejected)) return ejected;

  // 2. Bundled — check playbook-config.json for scripts_dir
  const configPath = path.join(stateDir, 'playbook', 'playbook-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const scriptsDir = config?.paths?.scripts_dir;
      if (scriptsDir) {
        const bundled = path.join(scriptsDir, scriptName);
        if (fs.existsSync(bundled)) return bundled;
      }
    } catch {
      // Fall through to default
    }
  }

  // 3. Default bundled location (Instar package)
  const packageDir = getPackageDir();
  const bundled = path.join(packageDir, 'playbook-scripts', scriptName);
  if (fs.existsSync(bundled)) return bundled;

  throw new Error(
    `Playbook script not found: ${scriptName}\n` +
    `  Searched: ${ejected}\n` +
    `  And bundled location.\n` +
    `  Run 'instar playbook doctor' to diagnose.`
  );
}

function getPackageDir(): string {
  // Walk up from this file to find the package root
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'instar') return dir;
      } catch {
        // Continue searching
      }
    }
    dir = path.dirname(dir);
  }
  return dir;
}

// ── Playbook Environment ───────────────────────────────────────────

/**
 * Build the environment variables needed for playbook Python scripts.
 *
 * Sets PLAYBOOK_CONFIG so Python scripts can locate the playbook-config.json
 * and resolve manifest/data paths correctly, regardless of cwd or script
 * bundling location.
 *
 * Without this, Python scripts fall back to using their script directory's
 * parent as playbook_root — pointing to the Instar package, not the agent's
 * .instar/playbook directory.
 */
function makePlaybookEnv(stateDir: string): Record<string, string> {
  const configPath = path.join(stateDir, 'playbook', 'playbook-config.json');
  if (fs.existsSync(configPath)) {
    return { PLAYBOOK_CONFIG: configPath };
  }
  return {};
}

// ── Python Execution ───────────────────────────────────────────────

interface ExecResult {
  stdout: string;
  exitCode: number;
}

/**
 * Execute a playbook Python script safely.
 *
 * Uses execFileSync with array arguments — never shell interpolation.
 * Maps exit codes to user-friendly messages.
 */
function execPython(
  interpreter: string,
  scriptPath: string,
  args: string[],
  opts: PlaybookOptions = {},
  env?: Record<string, string>,
): ExecResult {
  const execEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
  };

  // Proxy required env vars
  if (!execEnv.PLAYBOOK_PROJECT_DIR && opts.dir) {
    execEnv.PLAYBOOK_PROJECT_DIR = opts.dir;
  }

  try {
    const stdout = execFileSync(interpreter, [scriptPath, ...args], {
      encoding: 'utf-8',
      timeout: 120_000, // 2 minute timeout for lifecycle operations
      stdio: ['pipe', 'pipe', 'pipe'],
      env: execEnv,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'status' in err) {
      const execErr = err as { status: number; stdout?: string; stderr?: string };
      const exitCode = execErr.status ?? 1;
      const stderr = execErr.stderr?.trim() ?? '';
      const stdout = execErr.stdout?.trim() ?? '';

      if (opts.debug) {
        console.error(pc.dim(stderr));
      }

      return { stdout, exitCode };
    }
    throw err;
  }
}

/**
 * Translate a Python exit code to a user-friendly error message.
 */
function handleExitCode(exitCode: number, stderr?: string, opts?: PlaybookOptions): void {
  if (exitCode === 0) return;

  const messages: Record<number, string> = {
    1: 'General error',
    2: 'Validation failure',
    3: 'Missing dependency',
    4: 'Configuration error',
  };

  const msg = messages[exitCode] || `Unknown error (exit code ${exitCode})`;
  console.error(pc.red(`\n  Error: ${msg}`));

  if (stderr && (opts?.debug || opts?.verbose)) {
    console.error(pc.dim(stderr));
  }

  process.exit(exitCode);
}

// ── Playbook Dir Check ─────────────────────────────────────────────

function getPlaybookDir(opts: PlaybookOptions): string {
  const config = loadConfig(opts.dir);
  return config.stateDir;
}

function ensurePlaybookInitialized(stateDir: string): void {
  const playbookDir = path.join(stateDir, 'playbook');
  if (!fs.existsSync(playbookDir)) {
    console.error(pc.red('\n  Playbook not initialized.'));
    console.error(pc.dim('  Run: instar playbook init\n'));
    process.exit(4);
  }
}

// ── Command Handlers ───────────────────────────────────────────────

export async function playbookInit(opts: PlaybookOptions): Promise<void> {
  try {
    const config = loadConfig(opts.dir);
    const stateDir = config.stateDir;
    const playbookDir = path.join(stateDir, 'playbook');

    console.log(pc.bold('\n  Initializing Playbook...\n'));

    // Step 1: Detect Python
    let python: PythonInfo;
    try {
      python = resolvePython(stateDir);
    } catch (err) {
      console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
      process.exit(3);
      return; // unreachable but satisfies TS
    }

    if (!isVersionAtLeast(python.version, '3.10')) {
      console.error(pc.red(`  Python ${python.version} found, but 3.10+ is required.`));
      console.error(pc.dim(`  Interpreter: ${python.interpreter}`));
      process.exit(3);
      return;
    }

    console.log(`  ${pc.green('✓')} Python ${python.version} (${python.isVenv ? 'venv' : 'system'})`);
    console.log(pc.dim(`    ${python.interpreter}`));

    // Step 2: Create directory structure
    const dirs = [
      playbookDir,
      path.join(playbookDir, 'sessions'),
      path.join(playbookDir, 'archive'),
      path.join(playbookDir, 'scripts'),
      path.join(playbookDir, 'mounts'),
      path.join(playbookDir, 'users'),
    ];

    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }
    console.log(`  ${pc.green('✓')} Directory structure created`);

    // Step 3: Create venv if not exists
    const venvDir = path.join(playbookDir, '.venv');
    if (!fs.existsSync(venvDir)) {
      console.log(pc.dim('    Creating Python venv...'));
      try {
        execFileSync(python.interpreter, ['-m', 'venv', venvDir], {
          encoding: 'utf-8',
          timeout: 30_000,
          stdio: 'pipe',
        });
        console.log(`  ${pc.green('✓')} Python venv created`);
      } catch (err) {
        console.error(pc.yellow(`  ⚠ Could not create venv: ${err instanceof Error ? err.message : String(err)}`));
        console.error(pc.dim('    Playbook will use system Python.'));
      }
    } else {
      console.log(`  ${pc.green('✓')} Python venv exists`);
    }

    // Step 4: Initialize config
    const configPath = path.join(playbookDir, 'playbook-config.json');
    if (!fs.existsSync(configPath)) {
      const defaultConfig = {
        version: 1,
        engine_version: '4.0.0',
        paths: {
          playbook_root: playbookDir,
          manifest: path.join(playbookDir, 'context-manifest.json'),
          governance: path.join(playbookDir, 'context-governance.json'),
          history: path.join(playbookDir, 'playbook-history.jsonl'),
          scripts_dir: null, // Use bundled scripts
        },
        backend: {
          type: 'filesystem',
        },
        features: {
          delta_validation: true,
          hmac_signing: false,
          schema_validation: true,
          pii_screening: false,
          semantic_dedup: false,
          reflector: false,
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + '\n');
      console.log(`  ${pc.green('✓')} Config created`);
    } else {
      console.log(`  ${pc.green('✓')} Config exists`);
    }

    // Step 5: Initialize manifest
    const manifestPath = path.join(playbookDir, 'context-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      // Copy bootstrap manifest if available
      const bootstrapPath = path.join(getPackageDir(), 'playbook-scripts', 'bootstrap-manifest.json');
      if (fs.existsSync(bootstrapPath)) {
        fs.copyFileSync(bootstrapPath, manifestPath);
        console.log(`  ${pc.green('✓')} Manifest initialized (from bootstrap template)`);
      } else {
        const emptyManifest = {
          version: 1,
          schema_version: '2.0.0',
          items: [],
        };
        fs.writeFileSync(manifestPath, JSON.stringify(emptyManifest, null, 2) + '\n');
        console.log(`  ${pc.green('✓')} Manifest initialized (empty)`);
      }
    } else {
      console.log(`  ${pc.green('✓')} Manifest exists`);
    }

    // Step 6: Initialize governance
    const govPath = path.join(playbookDir, 'context-governance.json');
    if (!fs.existsSync(govPath)) {
      const defaultGovernance = {
        version: 1,
        policy: {
          max_items: 500,
          max_tokens_total: 50000,
          retirement_threshold_days: 90,
          confidence_threshold: 0.6,
          rate_limit: { max_deltas_per_hour: 30, max_deltas_per_session: 100 },
        },
      };
      fs.writeFileSync(govPath, JSON.stringify(defaultGovernance, null, 2) + '\n');
      console.log(`  ${pc.green('✓')} Governance policy created`);
    } else {
      console.log(`  ${pc.green('✓')} Governance exists`);
    }

    console.log(pc.green('\n  Playbook initialized successfully!'));
    console.log(pc.dim(`  Location: ${playbookDir}`));
    console.log(pc.dim('  Run `instar playbook doctor` to verify the setup.\n'));
  } catch (err) {
    console.error(pc.red(`\n  Init failed: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }
}

export async function playbookDoctor(opts: PlaybookOptions): Promise<void> {
  try {
    const stateDir = getPlaybookDir(opts);
    const playbookDir = path.join(stateDir, 'playbook');
    let issues = 0;
    let warnings = 0;

    console.log(pc.bold('\n  Playbook Doctor\n'));

    // Check 1: Directory structure
    if (fs.existsSync(playbookDir)) {
      console.log(`  ${pc.green('✓')} Playbook directory exists`);
    } else {
      console.log(`  ${pc.red('✗')} Playbook directory missing`);
      console.log(pc.dim('    Run: instar playbook init'));
      issues++;
    }

    // Check 2: Python interpreter
    try {
      const python = resolvePython(stateDir);
      if (isVersionAtLeast(python.version, '3.10')) {
        console.log(`  ${pc.green('✓')} Python ${python.version} ${python.isVenv ? '(venv)' : '(system)'}`);
      } else {
        console.log(`  ${pc.red('✗')} Python ${python.version} — need 3.10+`);
        issues++;
      }
    } catch {
      console.log(`  ${pc.red('✗')} Python not found`);
      issues++;
    }

    // Check 3: Venv
    const venvPython = path.join(playbookDir, '.venv', 'bin', 'python3');
    if (fs.existsSync(venvPython)) {
      console.log(`  ${pc.green('✓')} Python venv active`);
    } else {
      console.log(`  ${pc.yellow('⚠')} No venv — using system Python`);
      warnings++;
    }

    // Check 4: Config
    const configPath = path.join(playbookDir, 'playbook-config.json');
    if (fs.existsSync(configPath)) {
      try {
        JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        console.log(`  ${pc.green('✓')} Config valid JSON`);
      } catch {
        console.log(`  ${pc.red('✗')} Config is invalid JSON`);
        issues++;
      }
    } else {
      console.log(`  ${pc.yellow('⚠')} No playbook-config.json`);
      warnings++;
    }

    // Check 5: Manifest
    const manifestPath = path.join(playbookDir, 'context-manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const itemCount = manifest.items?.length ?? 0;
        console.log(`  ${pc.green('✓')} Manifest: ${itemCount} items`);
      } catch {
        console.log(`  ${pc.red('✗')} Manifest is invalid JSON`);
        issues++;
      }
    } else {
      console.log(`  ${pc.yellow('⚠')} No manifest`);
      warnings++;
    }

    // Check 6: Governance
    const govPath = path.join(playbookDir, 'context-governance.json');
    if (fs.existsSync(govPath)) {
      console.log(`  ${pc.green('✓')} Governance policy exists`);
    } else {
      console.log(`  ${pc.yellow('⚠')} No governance policy`);
      warnings++;
    }

    // Check 7: Scripts accessibility
    try {
      const testScript = resolveScript(stateDir, 'playbook-manifest.py');
      console.log(`  ${pc.green('✓')} Scripts accessible`);
      if (opts.verbose) {
        console.log(pc.dim(`    ${testScript}`));
      }
    } catch {
      console.log(`  ${pc.red('✗')} Playbook scripts not found`);
      console.log(pc.dim('    Check scripts_dir in playbook-config.json'));
      issues++;
    }

    // Check 8: Lock file
    const lockPath = path.join(playbookDir, '.lock');
    if (fs.existsSync(lockPath)) {
      try {
        const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        const pid = lockData.pid;
        // Check if PID is still running
        try {
          process.kill(pid, 0);
          console.log(`  ${pc.yellow('⚠')} Lock held by PID ${pid}`);
          warnings++;
        } catch {
          console.log(`  ${pc.yellow('⚠')} Stale lock from PID ${pid} — safe to remove`);
          warnings++;
        }
      } catch {
        // Lock file exists but not valid JSON — probably stale
        console.log(`  ${pc.yellow('⚠')} Lock file exists but may be stale`);
        warnings++;
      }
    }

    // Summary
    console.log();
    if (issues === 0 && warnings === 0) {
      console.log(pc.green('  All checks passed!\n'));
    } else if (issues === 0) {
      console.log(pc.yellow(`  ${warnings} warning${warnings === 1 ? '' : 's'} — playbook is functional.\n`));
    } else {
      console.log(pc.red(`  ${issues} issue${issues === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} — fix issues before using playbook.\n`));
      process.exit(1);
    }
  } catch (err) {
    console.error(pc.red(`\n  Doctor failed: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }
}

export async function playbookStatus(opts: PlaybookOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-dashboard.py');

  const args = ['status'];
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    handleExitCode(result.exitCode, result.stdout, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(`\n${result.stdout}`);
  }
}

export async function playbookList(opts: PlaybookListOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-manifest.py');

  const args = ['list'];
  if (opts.tag) args.push('--tag', opts.tag);
  if (opts.type) args.push('--type', opts.type);
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    handleExitCode(result.exitCode, result.stdout, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(`\n${result.stdout}`);
  }
}

export async function playbookRead(itemId: string, opts: PlaybookOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-manifest.py');

  const args = ['read', itemId];
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    handleExitCode(result.exitCode, result.stdout, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(`\n${result.stdout}`);
  }
}

export async function playbookAdd(opts: PlaybookAddOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-manifest.py');

  // Build args
  const args = ['add'];

  // Content source
  if (opts.contentFile) {
    // Read content from file
    if (!fs.existsSync(opts.contentFile)) {
      console.error(pc.red(`\n  File not found: ${opts.contentFile}\n`));
      process.exit(1);
    }
    const content = fs.readFileSync(opts.contentFile, 'utf-8').trim();
    args.push('--content', content);
  } else if (opts.content) {
    args.push('--content', opts.content);
  } else {
    console.error(pc.red('\n  Either --content or --content-file is required.\n'));
    process.exit(1);
    return;
  }

  if (opts.tags) args.push('--tags', opts.tags);
  if (opts.type) args.push('--type', opts.type);
  if (opts.category) args.push('--category', opts.category);
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode === 2) {
    console.error(pc.yellow('\n  Validation failed:'));
    console.error(pc.dim(`  ${result.stdout.trim()}\n`));
    process.exit(2);
    return;
  }
  if (result.exitCode !== 0) {
    handleExitCode(result.exitCode, result.stdout, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(pc.green(`\n  ${result.stdout.trim()}\n`));
  }
}

export async function playbookSearch(query: string, opts: PlaybookSearchOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-manifest.py');

  const args = ['search', query];
  if (opts.limit) args.push('--limit', String(opts.limit));
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    handleExitCode(result.exitCode, result.stdout, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(`\n${result.stdout}`);
  }
}

export async function playbookAssemble(opts: PlaybookAssembleOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-assemble.py');

  const args: string[] = [];
  if (opts.tags) args.push('--tags', opts.tags);
  if (opts.budget) args.push('--budget', String(opts.budget));
  if (opts.triggers) args.push('--triggers', opts.triggers);
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    handleExitCode(result.exitCode, result.stdout, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(`\n${result.stdout}`);
  }
}

export async function playbookEvaluate(sessionLog: string, opts: PlaybookOptions & { demo?: boolean }): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-eval-log.py');

  const args: string[] = [];
  if (opts.demo) {
    args.push('--demo');
  } else {
    args.push(sessionLog);
  }
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    handleExitCode(result.exitCode, result.stdout, opts);
    return;
  }

  console.log(`\n${result.stdout}`);
}

export async function playbookLifecycle(opts: PlaybookLifecycleOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-lifecycle.py');

  const args: string[] = [];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.json) args.push('--json');

  console.log(pc.dim('\n  Running lifecycle pass...'));
  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    handleExitCode(result.exitCode, result.stdout, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(`\n${result.stdout}`);
  }
}

export async function playbookValidate(opts: PlaybookOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);

  console.log(pc.bold('\n  Validating Playbook...\n'));

  // Step 1: Schema validation
  let schemaOk = true;
  try {
    const schemaScript = resolveScript(stateDir, 'playbook-schema-validate.py');
    const schemaResult = execPython(python.interpreter, schemaScript, [], opts, makePlaybookEnv(stateDir));
    if (schemaResult.exitCode === 0) {
      console.log(`  ${pc.green('✓')} Schema validation passed`);
    } else {
      console.log(`  ${pc.red('✗')} Schema validation failed`);
      if (schemaResult.stdout.trim()) {
        console.log(pc.dim(`    ${schemaResult.stdout.trim()}`));
      }
      schemaOk = false;
    }
  } catch {
    console.log(`  ${pc.yellow('⚠')} Schema validation script not found`);
  }

  // Step 2: Chain integrity
  let integrityOk = true;
  try {
    const verifyScript = resolveScript(stateDir, 'playbook-verify.py');
    const verifyResult = execPython(python.interpreter, verifyScript, [], opts, makePlaybookEnv(stateDir));
    if (verifyResult.exitCode === 0) {
      console.log(`  ${pc.green('✓')} Chain integrity passed`);
    } else {
      console.log(`  ${pc.red('✗')} Chain integrity failed`);
      if (verifyResult.stdout.trim()) {
        console.log(pc.dim(`    ${verifyResult.stdout.trim()}`));
      }
      integrityOk = false;
    }
  } catch {
    console.log(`  ${pc.yellow('⚠')} Verify script not found`);
  }

  console.log();
  if (schemaOk && integrityOk) {
    console.log(pc.green('  All validations passed!\n'));
  } else {
    console.log(pc.red('  Validation failed — see above.\n'));
    process.exit(2);
  }
}

// ── Mount Commands ─────────────────────────────────────────────────

export async function playbookMount(mountPath: string, opts: PlaybookMountOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-mount.py');

  if (!opts.name) {
    console.error(pc.red('\n  --name is required for mount.\n'));
    process.exit(1);
    return;
  }

  const args = ['mount', path.resolve(mountPath), '--name', opts.name];
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    if (result.stdout.trim()) {
      if (opts.json) {
        console.log(result.stdout);
      } else {
        console.error(pc.red(`\n  ${result.stdout.trim()}\n`));
      }
    }
    handleExitCode(result.exitCode, undefined, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(pc.green(`\n  ${result.stdout.trim()}\n`));
  }
}

export async function playbookUnmount(name: string, opts: PlaybookOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-mount.py');

  const args = ['unmount', name];
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    if (result.stdout.trim()) {
      console.error(pc.red(`\n  ${result.stdout.trim()}\n`));
    }
    handleExitCode(result.exitCode, undefined, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(pc.green(`\n  ${result.stdout.trim()}\n`));
  }
}

// ── Export / Import ────────────────────────────────────────────────

export async function playbookExport(opts: PlaybookExportOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);

  const manifestPath = path.join(stateDir, 'playbook', 'context-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(pc.red('\n  No manifest to export.\n'));
    process.exit(1);
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const format = opts.format || 'json';

  if (format === 'json') {
    console.log(JSON.stringify(manifest, null, 2));
  } else if (format === 'md') {
    // Markdown export
    const items = manifest.items || [];
    const lines = [`# Playbook Export`, ``, `**Items**: ${items.length}`, ``];
    for (const item of items) {
      lines.push(`## ${item.id}`);
      lines.push(`- **Category**: ${item.category || 'unknown'}`);
      lines.push(`- **Tags**: ${(item.tags || []).join(', ') || 'none'}`);
      if (item.content) lines.push(`\n${item.content}\n`);
      lines.push('---');
    }
    console.log(lines.join('\n'));
  } else {
    console.error(pc.red(`\n  Unknown format: ${format}. Use json or md.\n`));
    process.exit(1);
  }
}

export async function playbookImport(filePath: string, opts: PlaybookOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);

  // Validate file exists
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(pc.red(`\n  File not found: ${absPath}\n`));
    process.exit(1);
    return;
  }

  // Route through delta validator — import MUST NOT bypass validation
  const validatorScript = resolveScript(stateDir, 'playbook-delta-validator.py');
  const args = ['import', absPath];
  if (opts.json) args.push('--json');

  console.log(pc.dim(`\n  Importing from ${absPath}...`));
  const result = execPython(python.interpreter, validatorScript, args, opts, makePlaybookEnv(stateDir));

  if (result.exitCode === 2) {
    console.error(pc.yellow('\n  Some items failed validation:'));
    console.error(pc.dim(`  ${result.stdout.trim()}\n`));
    process.exit(2);
    return;
  }
  if (result.exitCode !== 0) {
    handleExitCode(result.exitCode, result.stdout, opts);
    return;
  }

  console.log(pc.green(`\n  ${result.stdout.trim()}\n`));
}

// ── Eject ──────────────────────────────────────────────────────────

export async function playbookEject(scriptName: string | undefined, opts: PlaybookEjectOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);

  const packageDir = getPackageDir();
  const bundledScriptsDir = path.join(packageDir, 'playbook-scripts');
  const localScriptsDir = path.join(stateDir, 'playbook', 'scripts');

  if (!fs.existsSync(bundledScriptsDir)) {
    console.error(pc.red('\n  Bundled scripts directory not found.\n'));
    process.exit(1);
    return;
  }

  fs.mkdirSync(localScriptsDir, { recursive: true });

  if (opts.all) {
    // Eject all scripts
    const scripts = fs.readdirSync(bundledScriptsDir).filter(f => f.endsWith('.py'));
    for (const script of scripts) {
      const src = path.join(bundledScriptsDir, script);
      const dst = path.join(localScriptsDir, script);
      fs.copyFileSync(src, dst);
    }
    console.log(pc.green(`\n  Ejected ${scripts.length} scripts to ${localScriptsDir}\n`));
  } else if (scriptName) {
    const src = path.join(bundledScriptsDir, scriptName);
    if (!fs.existsSync(src)) {
      console.error(pc.red(`\n  Script not found: ${scriptName}\n`));
      // List available scripts
      const available = fs.readdirSync(bundledScriptsDir).filter(f => f.endsWith('.py'));
      console.log(pc.dim(`  Available: ${available.join(', ')}\n`));
      process.exit(1);
      return;
    }
    const dst = path.join(localScriptsDir, scriptName);
    fs.copyFileSync(src, dst);
    console.log(pc.green(`\n  Ejected ${scriptName} to ${dst}\n`));
  } else {
    console.error(pc.red('\n  Specify a script name or use --all.\n'));
    process.exit(1);
  }
}

// ── DSAR Commands ──────────────────────────────────────────────────

export async function playbookUserExport(userId: string, opts: PlaybookOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-dsar.py');

  const args = ['user-export', userId];
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    handleExitCode(result.exitCode, result.stdout, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(`\n${result.stdout}`);
  }
}

export async function playbookUserDelete(userId: string, opts: PlaybookUserOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-dsar.py');

  const args = ['user-delete', userId];
  if (opts.confirm) args.push('--confirm');
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    if (result.stdout.trim()) {
      console.error(pc.red(`\n  ${result.stdout.trim()}\n`));
    }
    handleExitCode(result.exitCode, undefined, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(pc.green(`\n  ${result.stdout.trim()}\n`));
  }
}

export async function playbookUserAudit(userId: string, opts: PlaybookOptions): Promise<void> {
  const stateDir = getPlaybookDir(opts);
  ensurePlaybookInitialized(stateDir);
  const python = resolvePython(stateDir);
  const script = resolveScript(stateDir, 'playbook-dsar.py');

  const args = ['user-audit', userId];
  if (opts.json) args.push('--json');

  const result = execPython(python.interpreter, script, args, opts, makePlaybookEnv(stateDir));
  if (result.exitCode !== 0) {
    handleExitCode(result.exitCode, result.stdout, opts);
    return;
  }

  if (opts.json) {
    console.log(result.stdout);
  } else {
    console.log(`\n${result.stdout}`);
  }
}
