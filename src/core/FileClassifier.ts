/**
 * FileClassifier — Routes files to appropriate merge strategies before LLM resolution.
 *
 * Not all files can be text-merged. Lockfiles need regeneration, binaries need
 * ours/theirs selection, and generated artifacts should be excluded entirely.
 * This classifier prevents wasting LLM tokens on files that have deterministic
 * resolution strategies.
 *
 * From INTELLIGENT_SYNC_SPEC Section 12 — File Classification and Special Handling.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export type FileClass =
  | 'structured-data'
  | 'source-code'
  | 'documentation'
  | 'lockfile'
  | 'binary'
  | 'generated'
  | 'large-file'
  | 'secret';

export type MergeStrategy =
  | 'programmatic'     // Tier 0: field-merge, newer-wins, union-by-id
  | 'llm'             // Tier 1→2→3: LLM escalation
  | 'regenerate'      // Delete + regenerate via package manager
  | 'ours-theirs'     // Binary: pick one side based on hash divergence
  | 'exclude'         // Generated: skip entirely
  | 'never-sync';     // Secrets: should not exist in repo

export interface ClassificationResult {
  /** The classified file type. */
  fileClass: FileClass;
  /** The recommended merge strategy. */
  strategy: MergeStrategy;
  /** For lockfiles: regeneration commands [strict, fallback]. */
  regenCommands?: string[];
  /** For lockfiles: the associated manifest file (e.g., package.json). */
  manifestFile?: string;
  /** Human-readable reason for this classification. */
  reason: string;
}

export interface FileClassifierConfig {
  /** Project directory (repo root). */
  projectDir: string;
  /** Custom lockfile patterns to add. */
  extraLockfilePatterns?: string[];
  /** Custom lockfile regeneration commands. */
  extraRegenCommands?: Record<string, string[]>;
  /** Custom binary extensions to add. */
  extraBinaryExtensions?: string[];
  /** Custom generated artifact patterns to add. */
  extraExcludePatterns?: string[];
  /** Custom secret patterns to add. */
  extraSecretPatterns?: string[];
}

// ── Default Patterns ─────────────────────────────────────────────────

const DEFAULT_LOCKFILE_PATTERNS: string[] = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
];

/** Regen commands: first = strict/deterministic, second = fallback. */
const DEFAULT_REGEN_COMMANDS: Record<string, string[]> = {
  'package-lock.json': ['npm ci', 'npm install --package-lock-only'],
  'pnpm-lock.yaml': ['pnpm install --frozen-lockfile', 'pnpm install'],
  'yarn.lock': ['yarn install --frozen-lockfile', 'yarn install'],
  'Cargo.lock': ['cargo generate-lockfile'],
  'poetry.lock': ['poetry lock --no-update'],
  'Gemfile.lock': ['bundle install'],
  'composer.lock': ['composer install'],
  'go.sum': ['go mod tidy'],
};

const DEFAULT_LOCKFILE_MANIFESTS: Record<string, string> = {
  'package-lock.json': 'package.json',
  'pnpm-lock.yaml': 'package.json',
  'yarn.lock': 'package.json',
  'Cargo.lock': 'Cargo.toml',
  'poetry.lock': 'pyproject.toml',
  'Gemfile.lock': 'Gemfile',
  'composer.lock': 'composer.json',
  'go.sum': 'go.mod',
};

const DEFAULT_BINARY_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.tiff',
  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // Audio/Video
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // Databases
  '.sqlite', '.db', '.sqlite3',
  // Design
  '.psd', '.ai', '.sketch', '.fig',
  // Compiled
  '.wasm', '.dylib', '.so', '.dll', '.exe', '.o', '.a',
  // Other
  '.bin', '.dat',
]);

const DEFAULT_GENERATED_PATTERNS = [
  'dist/', 'build/', '.next/', 'out/',
  'node_modules/', '__pycache__/', '.pytest_cache/',
  '*.min.js', '*.min.css', '*.map',
  'coverage/', '.nyc_output/',
  'target/',  // Rust/Java
  // Integrated-Being v1 — per-machine ledger, never synced across machines.
  // If this ever ends up in a merge, prefer ours and exclude from LLM conflict
  // resolution. See docs/specs/integrated-being-ledger-v1.md §Multi-machine.
  '.instar/shared-state.jsonl',
  '.instar/shared-state.jsonl.*',
];

const DEFAULT_SECRET_PATTERNS = [
  '.env', '.env.*',
  '*.pem', '*.key', '*.p12', '*.pfx',
  '*credentials*', '*secret*',
  'id_rsa', 'id_ed25519', 'id_ecdsa',
  '.npmrc',  // may contain tokens
];

const SOURCE_CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.rs', '.go', '.java', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rb', '.php', '.swift', '.m',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.gql',
  '.r', '.R', '.jl',
  '.lua', '.zig', '.nim', '.v',
  '.css', '.scss', '.sass', '.less', '.styl',
  '.html', '.htm', '.xml', '.xsl',
  '.vue', '.svelte', '.astro',
  '.prisma', '.proto', '.thrift',
  '.toml', '.yaml', '.yml', '.ini', '.cfg',
]);

const DOC_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.adoc', '.org',
]);

// ── Classifier ───────────────────────────────────────────────────────

export class FileClassifier {
  private projectDir: string;
  private lockfilePatterns: string[];
  private regenCommands: Record<string, string[]>;
  private binaryExtensions: Set<string>;
  private generatedPatterns: string[];
  private secretPatterns: string[];

  constructor(config: FileClassifierConfig) {
    this.projectDir = config.projectDir;
    this.lockfilePatterns = [
      ...DEFAULT_LOCKFILE_PATTERNS,
      ...(config.extraLockfilePatterns ?? []),
    ];
    this.regenCommands = {
      ...DEFAULT_REGEN_COMMANDS,
      ...(config.extraRegenCommands ?? {}),
    };
    this.binaryExtensions = new Set([
      ...DEFAULT_BINARY_EXTENSIONS,
      ...(config.extraBinaryExtensions ?? []),
    ]);
    this.generatedPatterns = [
      ...DEFAULT_GENERATED_PATTERNS,
      ...(config.extraExcludePatterns ?? []),
    ];
    this.secretPatterns = [
      ...DEFAULT_SECRET_PATTERNS,
      ...(config.extraSecretPatterns ?? []),
    ];
  }

  /**
   * Classify a file and determine its merge strategy.
   */
  classify(filePath: string): ClassificationResult {
    const relPath = path.relative(this.projectDir, filePath);
    const basename = path.basename(relPath);
    const ext = path.extname(relPath).toLowerCase();

    // Check in priority order (most specific → most general)

    // 1. Secrets — never sync
    if (this.isSecret(relPath, basename)) {
      return {
        fileClass: 'secret',
        strategy: 'never-sync',
        reason: `Secret file detected: ${basename}`,
      };
    }

    // 2. Generated artifacts — exclude from sync
    if (this.isGenerated(relPath)) {
      return {
        fileClass: 'generated',
        strategy: 'exclude',
        reason: `Generated artifact: ${relPath}`,
      };
    }

    // 3. Lockfiles — regenerate, never text-merge
    const lockfileMatch = this.isLockfile(basename);
    if (lockfileMatch) {
      return {
        fileClass: 'lockfile',
        strategy: 'regenerate',
        regenCommands: this.regenCommands[lockfileMatch] ?? [],
        manifestFile: DEFAULT_LOCKFILE_MANIFESTS[lockfileMatch],
        reason: `Lockfile: ${basename} (regenerate via package manager)`,
      };
    }

    // 4. Binary files — ours/theirs
    if (this.binaryExtensions.has(ext)) {
      return {
        fileClass: 'binary',
        strategy: 'ours-theirs',
        reason: `Binary file: ${basename} (${ext})`,
      };
    }

    // 5. Structured data (.instar/ JSON/YAML) — programmatic
    if (this.isStructuredData(relPath, ext)) {
      return {
        fileClass: 'structured-data',
        strategy: 'programmatic',
        reason: `Structured data: ${relPath}`,
      };
    }

    // 6. Documentation — LLM with section-aware context
    if (DOC_EXTENSIONS.has(ext)) {
      return {
        fileClass: 'documentation',
        strategy: 'llm',
        reason: `Documentation: ${basename}`,
      };
    }

    // 7. Source code — LLM escalation
    if (SOURCE_CODE_EXTENSIONS.has(ext)) {
      return {
        fileClass: 'source-code',
        strategy: 'llm',
        reason: `Source code: ${basename} (${ext})`,
      };
    }

    // 8. Unknown — treat as source code (safe default: LLM tries, then human)
    return {
      fileClass: 'source-code',
      strategy: 'llm',
      reason: `Unknown file type: ${basename} — defaulting to LLM resolution`,
    };
  }

  /**
   * Resolve a lockfile conflict by regenerating from manifest.
   * Returns true if regeneration succeeded.
   */
  regenerateLockfile(
    filePath: string,
    classification: ClassificationResult,
  ): { success: boolean; command?: string; error?: string } {
    if (classification.strategy !== 'regenerate' || !classification.regenCommands?.length) {
      return { success: false, error: 'No regeneration commands available' };
    }

    // Accept ours version of the manifest file first
    if (classification.manifestFile) {
      const manifestPath = path.join(this.projectDir, classification.manifestFile);
      if (fs.existsSync(manifestPath)) {
        try {
          // safe-git-allow: incremental-migration
          execFileSync('git', ['checkout', '--ours', classification.manifestFile], {
            cwd: this.projectDir,
            stdio: 'pipe',
          });
          // safe-git-allow: incremental-migration
          execFileSync('git', ['add', classification.manifestFile], {
            cwd: this.projectDir,
            stdio: 'pipe',
          });
        } catch {
          // @silent-fallback-ok — manifest checkout is pre-regen prep; regen will recreate it anyway
        }
      }
    }

    // Try regeneration commands in order (strict → fallback)
    for (const cmd of classification.regenCommands) {
      try {
        const [bin, ...args] = cmd.split(' ');
        execFileSync(bin, args, {
          cwd: this.projectDir,
          stdio: 'pipe',
          timeout: 120_000,
        });

        // Stage the regenerated lockfile
        const relPath = path.relative(this.projectDir, filePath);
        // safe-git-allow: incremental-migration
        execFileSync('git', ['add', relPath], {
          cwd: this.projectDir,
          stdio: 'pipe',
        });

        return { success: true, command: cmd };
      } catch {
        // Try next command
        continue;
      }
    }

    return {
      success: false,
      error: `All regeneration commands failed: ${classification.regenCommands.join(', ')}`,
    };
  }

  /**
   * Resolve a binary file conflict using hash divergence detection.
   * Returns which side to pick, or 'conflict' if both sides changed.
   */
  resolveBinary(filePath: string): {
    resolution: 'ours' | 'theirs' | 'conflict';
    reason: string;
  } {
    const relPath = path.relative(this.projectDir, filePath);

    try {
      // Get hashes from git stages
      // Stage 1 = merge base, Stage 2 = ours, Stage 3 = theirs
      const baseHash = this.getStageHash(relPath, 1);
      const oursHash = this.getStageHash(relPath, 2);
      const theirsHash = this.getStageHash(relPath, 3);

      if (!baseHash || !oursHash || !theirsHash) {
        return { resolution: 'conflict', reason: 'Could not read git stages for binary file' };
      }

      const oursChanged = oursHash !== baseHash;
      const theirsChanged = theirsHash !== baseHash;

      if (oursChanged && !theirsChanged) {
        return { resolution: 'ours', reason: 'Only our side modified the binary file' };
      }
      if (!oursChanged && theirsChanged) {
        return { resolution: 'theirs', reason: 'Only their side modified the binary file' };
      }
      if (!oursChanged && !theirsChanged) {
        // Both sides identical to base — no real conflict
        return { resolution: 'ours', reason: 'No actual change on either side' };
      }

      // Both sides changed — real conflict
      return {
        resolution: 'conflict',
        reason: 'Both sides modified the binary file — needs human decision',
      };
    } catch {
      return { resolution: 'conflict', reason: 'Error reading git stages for binary file' };
    }
  }

  // ── Private Helpers ────────────────────────────────────────────────

  private isSecret(relPath: string, basename: string): boolean {
    for (const pattern of this.secretPatterns) {
      if (pattern.startsWith('*') && pattern.endsWith('*')) {
        // *pattern* → contains
        const inner = pattern.slice(1, -1);
        if (basename.toLowerCase().includes(inner)) return true;
      } else if (pattern.startsWith('*.')) {
        // *.ext → extension match
        const ext = pattern.slice(1);
        if (basename.endsWith(ext)) return true;
      } else if (pattern.includes('.*')) {
        // .env.* → prefix match
        const prefix = pattern.split('.*')[0];
        if (basename.startsWith(prefix)) return true;
      } else {
        // Exact match
        if (basename === pattern) return true;
      }
    }
    return false;
  }

  private isGenerated(relPath: string): boolean {
    const normalized = relPath.replace(/\\/g, '/');
    for (const pattern of this.generatedPatterns) {
      if (pattern.endsWith('/')) {
        // Directory pattern
        if (normalized.startsWith(pattern) || normalized.includes('/' + pattern)) return true;
      } else if (pattern.startsWith('*.')) {
        // Extension glob
        const ext = pattern.slice(1);
        if (normalized.endsWith(ext)) return true;
      } else {
        if (normalized === pattern || normalized.endsWith('/' + pattern)) return true;
      }
    }
    return false;
  }

  private isLockfile(basename: string): string | null {
    for (const pattern of this.lockfilePatterns) {
      if (basename === pattern) return pattern;
    }
    return null;
  }

  private isStructuredData(relPath: string, ext: string): boolean {
    // .instar/ state files
    if (relPath.startsWith('.instar/') && (ext === '.json' || ext === '.yaml' || ext === '.yml')) {
      return true;
    }
    return false;
  }

  private getStageHash(relPath: string, stage: number): string | null {
    try {
      // safe-git-allow: incremental-migration
      const output = execFileSync(
        'git', ['ls-files', '-s', '--', relPath],
        { cwd: this.projectDir, encoding: 'utf-8', stdio: 'pipe' },
      );
      // Output: "mode hash stage\tfilename" — one line per stage
      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3 && parseInt(parts[2], 10) === stage) {
          return parts[1]; // SHA hash
        }
      }
      return null;
    } catch {
      // @silent-fallback-ok — git ls-files for blob hash lookup; null means stage not available
      return null;
    }
  }
}
