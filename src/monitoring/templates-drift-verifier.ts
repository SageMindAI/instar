/**
 * TemplatesDriftVerifier — Layer 7 of telegram-delivery-robustness.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 7 "Scope additions
 * from review".
 *
 * Scans deployed instar template files across all agents on the host,
 * computes SHA-256 of each on-disk copy, and compares against the
 * canonical SHA history. Drifted templates → DegradationReporter event
 * with dedup. Default-on; the kill switch
 * `config.monitoring.templatesDriftVerifier.enabled = false` is for
 * operators who intentionally customize their relay scripts.
 *
 * Three deployment paths are scanned per agent:
 *   1. `~/.instar/agents/<id>/.claude/scripts/`     (per-agent CLI install)
 *   2. `<projectDir>/.claude/scripts/`              (per-project install)
 *   3. `<projectDir>/.instar/scripts/`              (legacy/alt layout)
 *
 * Per spec § 7:
 *   - Findings route to `DegradationReporter` (the operator-visible channel).
 *   - Each `(template-path, current-SHA)` pair is reported at most once via
 *     a small persistent `.instar/state/drift-verifier-seen.jsonl` log so
 *     a long-running drift produces ONE event, not 365.
 *   - Default-on. The kill switch lives in `config.monitoring
 *     .templatesDriftVerifier.enabled` for operators with intentional
 *     customizations.
 *
 * The verifier never modifies on-disk content. Migration to a `.new`
 * candidate is the migrator's job (PostUpdateMigrator.migrateReplyScript
 * ToPortConfig); the verifier is a read-only signal layer that surfaces
 * drift between scheduled `instar update` runs.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DegradationReporter } from './DegradationReporter.js';
import { PostUpdateMigrator } from '../core/PostUpdateMigrator.js';

/**
 * Locate the bundled `src/templates/` directory regardless of whether
 * the verifier runs from source (tsx) or from the compiled `dist/`
 * tree. From `src/monitoring/templates-drift-verifier.ts` the path
 * relative-walks two segments up; from `dist/monitoring/...` the same
 * relative path resolves because `dist/` mirrors `src/`. The runtime
 * also exports an injection point for tests (`opts.templatesDir`).
 */
function defaultTemplatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/monitoring/foo.ts → src/templates  (walk up one, then into templates)
  const candidate = path.resolve(here, '..', 'templates');
  if (fs.existsSync(candidate)) return candidate;
  // dist/monitoring/foo.js → dist/templates? — unlikely (templates aren't
  // bundled into dist by default). Fall back to the package-root copy.
  const pkgRoot = path.resolve(here, '..', '..', 'src', 'templates');
  return pkgRoot;
}

/**
 * Canonical templates the verifier knows about. Each entry maps a
 * deployed-relative path (under an agent's `.claude/scripts/` or
 * equivalent) to its bundled-source basename.
 *
 * Adding a template here means: any agent with that file deployed will
 * have its on-disk SHA compared against the canonical content + the
 * prior-shipped SHA set. To extend: add the deployed path here, and (if
 * applicable) a prior-shipped SHA set on PostUpdateMigrator.
 */
interface TemplateSpec {
  /** Deployed file basename under `.claude/scripts/`. */
  readonly deployedBasename: string;
  /** Source-side relative path under `src/templates/`. */
  readonly sourceRelPath: string;
  /** Optional set of historical-shipped SHAs (dedup'd against current). */
  readonly priorShas: ReadonlySet<string>;
}

const KNOWN_TEMPLATES: readonly TemplateSpec[] = [
  {
    deployedBasename: 'telegram-reply.sh',
    sourceRelPath: 'scripts/telegram-reply.sh',
    priorShas: PostUpdateMigrator.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS,
  },
  {
    deployedBasename: 'slack-reply.sh',
    sourceRelPath: 'scripts/slack-reply.sh',
    // No prior-shipped tracking yet for slack — current-only verification.
    priorShas: new Set<string>(),
  },
  {
    deployedBasename: 'whatsapp-reply.sh',
    sourceRelPath: 'scripts/whatsapp-reply.sh',
    priorShas: new Set<string>(),
  },
  {
    deployedBasename: 'imessage-reply.sh',
    sourceRelPath: 'scripts/imessage-reply.sh',
    priorShas: new Set<string>(),
  },
];

export interface VerifierOptions {
  /** Override `~` expansion (testing only). */
  homeDir?: string;
  /**
   * Override `src/templates/` source root (testing only). When omitted,
   * resolves from the verifier's own module location.
   */
  templatesDir?: string;
  /**
   * Explicit list of agent root directories to scan. When omitted, the
   * verifier enumerates `<homeDir>/.instar/agents/*` and stops there.
   * Tests pass an explicit list to avoid touching the user's real home.
   */
  agentRoots?: string[];
  /**
   * Persistent dedup log. When omitted, the verifier writes one alongside
   * the first agent root discovered (so production daily runs share dedup
   * state across runs).
   */
  seenLogPath?: string;
  /**
   * Kill-switch override. When `false`, returns immediately with a
   * `disabled: true` flag. Production callers read `config.monitoring
   * .templatesDriftVerifier.enabled` and pass that here.
   */
  enabled?: boolean;
  /**
   * DegradationReporter instance to report into. Defaults to the global
   * singleton. Tests pass a freshly-reset reporter for isolation.
   */
  reporter?: DegradationReporter;
}

export interface VerifierResult {
  /** Total deployed-template files inspected (read-and-hashed). */
  scanned: number;
  /** Drifted files where SHA matches neither current nor prior-shipped. */
  drifted: number;
  /** Drifted files whose `(path, sha)` was already in the dedup log. */
  suppressed: number;
  /** Read errors (permission denied, vanished agent, etc.). */
  errors: string[];
  /** Did the kill-switch short-circuit the run? */
  disabled?: true;
}

interface SeenEntry {
  path: string;
  sha: string;
  ts: string;
}

/**
 * Read the dedup log. Best-effort — corrupt lines are skipped silently.
 */
function readSeenLog(seenPath: string): Set<string> {
  const seen = new Set<string>();
  if (!fs.existsSync(seenPath)) return seen;
  let raw: string;
  try {
    raw = fs.readFileSync(seenPath, 'utf-8');
  } catch {
    return seen;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as SeenEntry;
      if (entry?.path && entry?.sha) {
        seen.add(`${entry.path}::${entry.sha}`);
      }
    } catch {
      // skip
    }
  }
  return seen;
}

/**
 * Append a `(path, sha)` pair to the dedup log atomically (best-effort
 * — failures are surfaced via the `errors` channel of the result).
 */
function appendSeenLog(seenPath: string, entry: SeenEntry): void {
  fs.mkdirSync(path.dirname(seenPath), { recursive: true });
  fs.appendFileSync(seenPath, `${JSON.stringify(entry)}\n`, { mode: 0o644 });
}

/**
 * Compute SHA-256 hex of a file's contents.
 */
function sha256OfFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Enumerate candidate deployment directories under one agent root.
 *
 * For an agent root `<root>` (e.g. `~/.instar/agents/echo` or a project
 * directory with a `.instar/`), this yields:
 *   - `<root>/.claude/scripts/`
 *   - `<root>/.instar/scripts/`
 *   - `<root>/scripts/`        (only when the root itself is `.instar/`)
 *
 * The verifier is tolerant of missing directories; agents may have any
 * subset of these layouts. Symlinks are followed exactly once via
 * `realpathSync` so a recursive symlink loop cannot wedge the scanner.
 */
function deploymentDirsForAgent(agentRoot: string): string[] {
  const dirs: string[] = [];
  const candidates = [
    path.join(agentRoot, '.claude', 'scripts'),
    path.join(agentRoot, '.instar', 'scripts'),
  ];
  // If the root itself looks like a `.instar/` directory, also include
  // its `scripts/` child directly. This covers projects that point us
  // at `<project>/.instar/` rather than `<project>/`.
  if (path.basename(agentRoot) === '.instar') {
    candidates.push(path.join(agentRoot, 'scripts'));
  }
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        dirs.push(fs.realpathSync(candidate));
      }
    } catch {
      // missing or unreadable — skip
    }
  }
  return dirs;
}

/**
 * Enumerate the set of agent-root directories the verifier should scan.
 *
 * Production: `~/.instar/agents/*` only. (Per-project deployments are
 * surfaced indirectly via the agent registry — but enumerating
 * `~/Documents/Projects/*` would slow the scan to a crawl on hosts with
 * thousands of unrelated projects.) Tests pass an explicit list.
 */
function defaultAgentRoots(homeDir: string): string[] {
  const root = path.join(homeDir, '.instar', 'agents');
  if (!fs.existsSync(root)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = path.join(root, name);
    try {
      if (fs.statSync(full).isDirectory()) out.push(full);
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Run the verifier. Pure function over the filesystem — never mutates
 * deployed scripts. Produces DegradationReporter events for novel
 * drift; deduped via the persistent seen-log.
 */
export async function runVerifier(opts: VerifierOptions = {}): Promise<VerifierResult> {
  const result: VerifierResult = {
    scanned: 0,
    drifted: 0,
    suppressed: 0,
    errors: [],
  };

  if (opts.enabled === false) {
    return { ...result, disabled: true };
  }

  const homeDir = opts.homeDir ?? os.homedir();
  const templatesDir = opts.templatesDir ?? defaultTemplatesDir();
  const agentRoots = opts.agentRoots ?? defaultAgentRoots(homeDir);
  const seenLogPath =
    opts.seenLogPath ??
    path.join(homeDir, '.instar', 'state', 'drift-verifier-seen.jsonl');
  const reporter = opts.reporter ?? DegradationReporter.getInstance();

  // Pre-compute canonical (current-template) SHAs for every known template.
  // Missing source-side templates are recorded as errors but don't abort
  // the run — a partial install shouldn't blind the verifier on the rest.
  const canonical: Map<string, { currentSha: string; priorShas: ReadonlySet<string>; sourceRelPath: string }> = new Map();
  for (const spec of KNOWN_TEMPLATES) {
    const sourcePath = path.join(templatesDir, spec.sourceRelPath);
    try {
      const sha = sha256OfFile(sourcePath);
      canonical.set(spec.deployedBasename, {
        currentSha: sha,
        priorShas: spec.priorShas,
        sourceRelPath: spec.sourceRelPath,
      });
    } catch (err) {
      result.errors.push(
        `canonical template missing: ${spec.sourceRelPath} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  if (canonical.size === 0) {
    return result;
  }

  const seen = readSeenLog(seenLogPath);

  for (const agentRoot of agentRoots) {
    const deployDirs = deploymentDirsForAgent(agentRoot);
    for (const deployDir of deployDirs) {
      for (const [basename, ref] of canonical) {
        const deployedPath = path.join(deployDir, basename);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(deployedPath);
        } catch {
          continue; // template not deployed at this path
        }
        if (!stat.isFile()) continue;

        let foundSha: string;
        try {
          foundSha = sha256OfFile(deployedPath);
        } catch (err) {
          result.errors.push(
            `${deployedPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        result.scanned++;

        if (foundSha === ref.currentSha) continue; // up to date
        if (ref.priorShas.has(foundSha)) continue; // known-prior, migrator handles upgrade

        // Drift: SHA matches neither current nor any prior-shipped.
        // Either user-modified or a damaged file. Either way: signal,
        // don't auto-overwrite.
        result.drifted++;
        const dedupKey = `${deployedPath}::${foundSha}`;
        if (seen.has(dedupKey)) {
          result.suppressed++;
          continue;
        }

        const expectedShas = [ref.currentSha, ...ref.priorShas];
        const reasonShort =
          `${path.relative(homeDir, deployedPath)} sha256:${foundSha.slice(0, 12)}…` +
          ` does not match any known-shipped instar version of ${basename}.`;

        // Emit ONE degradation event per (path, sha). Future runs with the
        // same SHA on the same path will be suppressed.
        try {
          reporter.report({
            feature: 'template-drift-detected',
            primary: 'deployed instar template matches a known-shipped SHA',
            fallback:
              'kept the on-disk script untouched; operator review required to ' +
              'reconcile against the bundled template',
            reason: reasonShort,
            impact:
              `If this drift is unintentional (e.g., partial upgrade or file ` +
              `corruption) the affected agent may be running outdated relay ` +
              `behavior; if intentional (operator customization), set ` +
              `config.monitoring.templatesDriftVerifier.enabled = false to ` +
              `silence further reports. Expected SHAs: ${expectedShas.map(s => s.slice(0, 12) + '…').join(', ')}.`,
          });
        } catch (err) {
          result.errors.push(
            `report ${deployedPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        try {
          appendSeenLog(seenLogPath, {
            path: deployedPath,
            sha: foundSha,
            ts: new Date().toISOString(),
          });
          seen.add(dedupKey);
        } catch (err) {
          result.errors.push(
            `seen-log write ${seenLogPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  return result;
}

/**
 * Test-only export — surfaces the canonical template list so tests can
 * assert coverage (every shipped relay script is registered) without
 * importing the private `KNOWN_TEMPLATES` symbol.
 */
export function getKnownTemplatesForTesting(): readonly TemplateSpec[] {
  return KNOWN_TEMPLATES;
}
