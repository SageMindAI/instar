#!/usr/bin/env node
/**
 * lint-no-direct-destructive.js — refuses direct destructive git/fs callsites.
 *
 * Implements AC-3 / AC-5 / AC-6 / AC-7 from
 * docs/specs/COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md.
 *
 * The funnels (`src/core/SafeGitExecutor.ts`, `src/core/SafeFsExecutor.ts`)
 * are the only modules in the codebase allowed to call:
 *   - `child_process.execFileSync('git', ...)` / `execSync('git ...')` /
 *     `spawn('git', ...)` / `spawnSync('git', ...)` / `exec('git ...')`
 *   - `fs.rm` / `fs.rmSync` / `fs.unlink` / `fs.unlinkSync` / `fs.rmdir` /
 *     `fs.rmdirSync` (and their `fs/promises` counterparts)
 *   - `simpleGit(...)` from the `simple-git` package
 *
 * This script AST-walks every `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs` file in
 * `src/`, `tests/`, `scripts/` (configurable via CLI args) and flags
 * violations.
 *
 * It also greps `.sh` files and the `scripts` section of `package.json`
 * for direct destructive `git <verb>` invocations (closed verb list).
 *
 * Exit codes:
 *   0 — no violations.
 *   1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-no-direct-destructive.js                # full repo
 *   node scripts/lint-no-direct-destructive.js --staged       # staged files only
 *   node scripts/lint-no-direct-destructive.js path1 path2    # specific files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Avoid importing typescript at module top — it's a heavy dep. We require it
// only when a TS file actually needs parsing.
let _ts = null;
function ts() {
  if (_ts) return _ts;
  _ts = require('typescript');
  return _ts;
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ── Allowlist (closed) ─────────────────────────────────────────────

/**
 * Files that may legitimately call destructive git/fs primitives directly.
 * Adding entries requires a spec change.
 */
const ALLOWLIST = new Set([
  'src/core/SafeGitExecutor.ts',
  'src/core/SafeFsExecutor.ts',
  'tests/unit/SafeGitExecutor.test.ts',
  'tests/unit/SafeFsExecutor.test.ts',
  // Transitional: tracked under commitment://incremental-migration (due
  // 2026-05-03). PR #2 migrates these fs.unlinkSync calls through
  // SafeFsExecutor and removes them from this list.
  'src/messaging/imessage/IMessageAdapter.ts',
  'src/messaging/imessage/NativeBackend.ts',
  // The shim runs `git <verb> --dry-run` first to count files, then re-invokes
  // for real. Both invocations route through SafeGitExecutor, but the shim's
  // own implementation file must be allowed to import the executor.
  // The shim itself uses SafeGitExecutor — no direct execFileSync needed. If
  // the shim ever needs direct access it gets added here.
]);

/**
 * Allow `// safe-git-allow: <reason>` as a per-file escape on the FIRST
 * non-empty line of the file. Used by SafeGitExecutor.ts itself and the
 * test files. Other callers must be on the closed allowlist.
 */
function hasAllowComment(text) {
  const lines = text.split('\n').slice(0, 5);
  for (const line of lines) {
    if (/^\s*\/\/\s*safe-git-allow:/.test(line)) return true;
    if (/^\s*\/\*[\s\S]*?safe-git-allow:/m.test(line)) return true;
  }
  return false;
}

// ── Violation reporting ────────────────────────────────────────────

const violations = [];

/**
 * Per-callsite marker: `// safe-git-allow: incremental-migration` placed on
 * the line immediately above (or at end of) a flagged callsite suppresses
 * that single violation. Used during the transitional period before
 * commitment://incremental-migration lands (PR #2). Expires 2026-05-03.
 *
 * NEW callsites cannot use this marker — only pre-existing callsites that
 * were stamped in PR #1 by scripts/add-migration-marker.js. After PR #2,
 * zero markers should remain.
 */
const MIGRATION_MARKER_EXPIRY = new Date('2026-05-03T00:00:00Z');
const MIGRATION_MARKER_RE = /\/\/\s*safe-git-allow:\s*incremental-migration\b/;

function hasLineMarker(text, line) {
  // line is 1-based. Check the line itself (trailing comment) and the
  // line immediately above it.
  const lines = text.split('\n');
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return false;
  if (MIGRATION_MARKER_RE.test(lines[idx])) return true;
  if (idx - 1 >= 0 && MIGRATION_MARKER_RE.test(lines[idx - 1])) return true;
  // Also allow the marker two lines above to tolerate blank-line spacing.
  if (idx - 2 >= 0 && /^\s*$/.test(lines[idx - 1]) && MIGRATION_MARKER_RE.test(lines[idx - 2])) return true;
  return false;
}

function migrationMarkerExpired() {
  return new Date() >= MIGRATION_MARKER_EXPIRY;
}

function migrationMarkerDisabled() {
  // Internal flag used by scripts/add-migration-marker.js to collect ALL
  // pre-existing violations (including ones that already carry the marker)
  // so it can re-stamp idempotently.
  return process.env.INSTAR_DISABLE_MIGRATION_MARKER === '1';
}

function report(file, line, col, msg, ctx) {
  // Honor per-callsite incremental-migration marker (transitional period).
  if (
    ctx &&
    ctx.text &&
    !migrationMarkerDisabled() &&
    !migrationMarkerExpired() &&
    hasLineMarker(ctx.text, line)
  ) {
    return;
  }
  violations.push({ file, line, col, msg });
}

// ── AST scan: TS / JS files ────────────────────────────────────────

const DESTRUCTIVE_FS_NAMES = new Set([
  'rm',
  'rmSync',
  'unlink',
  'unlinkSync',
  'rmdir',
  'rmdirSync',
]);

const CHILD_PROCESS_FNS = new Set([
  'execFileSync',
  'execSync',
  'spawn',
  'spawnSync',
  'exec',
  'execFile',
]);

const CHILD_PROCESS_MODULE_NAMES = new Set([
  'child_process',
  'node:child_process',
]);

const FS_MODULE_NAMES = new Set([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
]);

/**
 * Walk a TypeScript SourceFile AST, collecting violations.
 *
 * Rules:
 *   1. Direct call to one of CHILD_PROCESS_FNS where the first arg is the
 *      string literal 'git' OR a string literal starting with 'git ' — flag.
 *   2. Member access on an identifier known to alias the child_process or
 *      fs module — same rule applies.
 *   3. Named import of `simpleGit` from `simple-git` — flag.
 *   4. Named import of one of DESTRUCTIVE_FS_NAMES from fs / fs/promises — flag.
 *   5. Namespace import of fs / fs/promises followed by member-access
 *      to a destructive name — flag.
 *   6. require('child_process').execFileSync('git', ...) and equivalents — flag.
 *   7. Dynamic property access used to evade the rule (`fs['rm' + 'Sync']`) — flag.
 */
function lintTsFile(file, text) {
  const T = ts();
  const sf = T.createSourceFile(file, text, T.ScriptTarget.Latest, true);
  const ctx = { text };
  const r = (f, l, c, m) => report(f, l, c, m, ctx);

  /** module name → local identifier (default + namespace + named) */
  const childProcessIdentifiers = new Set();
  const childProcessNamedImports = new Map(); // localName -> originalName
  const fsNamespaceIdentifiers = new Set();
  const fsNamedDestructiveImports = new Map(); // localName -> originalName
  const simpleGitImports = []; // {localName}
  const requireBindings = new Map(); // localName -> moduleName (if literal)

  function lineCol(node) {
    const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: lc.line + 1, col: lc.character + 1 };
  }

  function visit(node) {
    // ── Imports ────────────────────────────────────────────────
    if (T.isImportDeclaration(node) && node.moduleSpecifier && T.isStringLiteral(node.moduleSpecifier)) {
      const mod = node.moduleSpecifier.text;
      const ic = node.importClause;
      if (!ic) return;
      if (ic.namedBindings) {
        if (T.isNamespaceImport(ic.namedBindings)) {
          const localName = ic.namedBindings.name.text;
          if (CHILD_PROCESS_MODULE_NAMES.has(mod)) {
            childProcessIdentifiers.add(localName);
          } else if (FS_MODULE_NAMES.has(mod)) {
            fsNamespaceIdentifiers.add(localName);
          }
        } else if (T.isNamedImports(ic.namedBindings)) {
          for (const el of ic.namedBindings.elements) {
            const importedName = el.propertyName ? el.propertyName.text : el.name.text;
            const localName = el.name.text;
            if (CHILD_PROCESS_MODULE_NAMES.has(mod) && CHILD_PROCESS_FNS.has(importedName)) {
              childProcessNamedImports.set(localName, importedName);
            } else if (FS_MODULE_NAMES.has(mod) && DESTRUCTIVE_FS_NAMES.has(importedName)) {
              fsNamedDestructiveImports.set(localName, importedName);
            } else if (mod === 'simple-git' && importedName === 'simpleGit') {
              simpleGitImports.push({ localName });
            }
          }
        }
      }
      // Default import — `import fs from 'node:fs'` style.
      if (ic.name) {
        const localName = ic.name.text;
        if (CHILD_PROCESS_MODULE_NAMES.has(mod)) {
          childProcessIdentifiers.add(localName);
        } else if (FS_MODULE_NAMES.has(mod)) {
          fsNamespaceIdentifiers.add(localName);
        } else if (mod === 'simple-git') {
          simpleGitImports.push({ localName });
        }
      }
    }

    // ── require('child_process') / require('fs') ───────────────
    if (T.isVariableDeclaration(node) && node.initializer && T.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if (T.isIdentifier(callee) && callee.text === 'require' && node.initializer.arguments.length === 1) {
        const arg = node.initializer.arguments[0];
        if (T.isStringLiteral(arg)) {
          const mod = arg.text;
          if (T.isIdentifier(node.name)) {
            const localName = node.name.text;
            if (CHILD_PROCESS_MODULE_NAMES.has(mod)) {
              childProcessIdentifiers.add(localName);
              requireBindings.set(localName, mod);
            } else if (FS_MODULE_NAMES.has(mod)) {
              fsNamespaceIdentifiers.add(localName);
              requireBindings.set(localName, mod);
            } else if (mod === 'simple-git') {
              simpleGitImports.push({ localName });
            }
          }
          // Destructured: const { execFileSync } = require('child_process')
          if (T.isObjectBindingPattern(node.name)) {
            for (const el of node.name.elements) {
              const importedName = el.propertyName && T.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : (T.isIdentifier(el.name) ? el.name.text : null);
              const localName = T.isIdentifier(el.name) ? el.name.text : null;
              if (!importedName || !localName) continue;
              if (CHILD_PROCESS_MODULE_NAMES.has(mod) && CHILD_PROCESS_FNS.has(importedName)) {
                childProcessNamedImports.set(localName, importedName);
              } else if (FS_MODULE_NAMES.has(mod) && DESTRUCTIVE_FS_NAMES.has(importedName)) {
                fsNamedDestructiveImports.set(localName, importedName);
              } else if (mod === 'simple-git' && importedName === 'simpleGit') {
                simpleGitImports.push({ localName });
              }
            }
          }
        }
      }
    }

    // ── Inline require('child_process').execFileSync(...) ──────
    if (T.isCallExpression(node) && T.isPropertyAccessExpression(node.expression)) {
      const obj = node.expression.expression;
      const name = node.expression.name.text;
      if (T.isCallExpression(obj) && T.isIdentifier(obj.expression) && obj.expression.text === 'require'
          && obj.arguments.length === 1 && T.isStringLiteral(obj.arguments[0])) {
        const mod = obj.arguments[0].text;
        if (CHILD_PROCESS_MODULE_NAMES.has(mod) && CHILD_PROCESS_FNS.has(name)) {
          if (firstArgIsGit(node)) {
            const lc = lineCol(node);
            r(file, lc.line, lc.col, `Direct require('${mod}').${name}('git', ...) — use SafeGitExecutor.`);
          }
        } else if (FS_MODULE_NAMES.has(mod) && DESTRUCTIVE_FS_NAMES.has(name)) {
          const lc = lineCol(node);
          r(file, lc.line, lc.col, `Direct require('${mod}').${name}(...) — use SafeFsExecutor.`);
        }
      }
    }

    // ── Plain CallExpression of an identifier ──────────────────
    if (T.isCallExpression(node) && T.isIdentifier(node.expression)) {
      const fnName = node.expression.text;
      // Named import alias for execFileSync/etc.
      if (childProcessNamedImports.has(fnName)) {
        if (firstArgIsGit(node)) {
          const lc = lineCol(node);
          r(file, lc.line, lc.col, `Direct ${childProcessNamedImports.get(fnName)}('git', ...) — use SafeGitExecutor.`);
        }
      }
      // Named import alias for rm/etc.
      if (fsNamedDestructiveImports.has(fnName)) {
        const lc = lineCol(node);
        r(file, lc.line, lc.col, `Direct ${fsNamedDestructiveImports.get(fnName)}(...) — use SafeFsExecutor.`);
      }
      // simpleGit() call.
      if (simpleGitImports.some((s) => s.localName === fnName)) {
        const lc = lineCol(node);
        r(file, lc.line, lc.col, `Direct simpleGit(...) — use SafeGitExecutor.`);
      }
    }

    // ── Member call on namespace identifier ────────────────────
    if (T.isCallExpression(node) && T.isPropertyAccessExpression(node.expression)) {
      const obj = node.expression.expression;
      const name = node.expression.name.text;
      if (T.isIdentifier(obj)) {
        const objName = obj.text;
        if (childProcessIdentifiers.has(objName) && CHILD_PROCESS_FNS.has(name)) {
          if (firstArgIsGit(node)) {
            const lc = lineCol(node);
            r(file, lc.line, lc.col, `Direct ${objName}.${name}('git', ...) — use SafeGitExecutor.`);
          }
        }
        if (fsNamespaceIdentifiers.has(objName) && DESTRUCTIVE_FS_NAMES.has(name)) {
          const lc = lineCol(node);
          r(file, lc.line, lc.col, `Direct ${objName}.${name}(...) — use SafeFsExecutor.`);
        }
        // Defense-in-depth: catch fs.promises.rm via fs identifier.
        if (fsNamespaceIdentifiers.has(objName) && name === 'promises') {
          // The next member access in a chained call.
          // Detected via the parent CallExpression where expression is
          // `fs.promises.rm(...)` — the whole chain is this PropertyAccessExpression.
          // We already capture this via the ElementAccessExpression branch below
          // and via deep walking, but most simply: a CallExpression whose
          // callee is `<fs>.promises.<destructive>` deserves a flag.
        }
      }
      // fs.promises.rm(...) — the callee is PropertyAccess(PropertyAccess(fs, promises), rm)
      if (T.isPropertyAccessExpression(obj) && T.isIdentifier(obj.expression)
          && fsNamespaceIdentifiers.has(obj.expression.text)
          && obj.name.text === 'promises'
          && DESTRUCTIVE_FS_NAMES.has(name)) {
        const lc = lineCol(node);
        r(file, lc.line, lc.col, `Direct ${obj.expression.text}.promises.${name}(...) — use SafeFsExecutor.`);
      }
    }

    // ── Dynamic / computed access: fs['rm' + 'Sync'](...) ──────
    if (T.isCallExpression(node) && T.isElementAccessExpression(node.expression)) {
      const obj = node.expression.expression;
      const arg = node.expression.argumentExpression;
      if (T.isIdentifier(obj) && fsNamespaceIdentifiers.has(obj.text)) {
        // Any computed member access on the fs namespace is suspicious;
        // refuse with a clear message.
        const lc = lineCol(node);
        r(file, lc.line, lc.col, `Computed member access on fs (${obj.text}[...]) — refuse, use SafeFsExecutor.`);
      }
      if (T.isIdentifier(obj) && childProcessIdentifiers.has(obj.text)) {
        const lc = lineCol(node);
        r(file, lc.line, lc.col, `Computed member access on child_process (${obj.text}[...]) — refuse, use SafeGitExecutor.`);
      }
    }

    T.forEachChild(node, visit);
  }

  function firstArgIsGit(call) {
    const args = call.arguments;
    if (args.length === 0) return false;
    const first = args[0];
    const T = ts();
    if (T.isStringLiteral(first)) {
      if (first.text === 'git') return true;
      if (first.text.startsWith('git ')) return true;
    }
    if (T.isTemplateExpression(first) || T.isNoSubstitutionTemplateLiteral(first)) {
      // Best-effort: check the head.
      const text = first.getText(sf);
      if (/^[`'"]git[\s'"]/.test(text)) return true;
    }
    return false;
  }

  visit(sf);
}

// ── Shell + package.json grep ──────────────────────────────────────

const DESTRUCTIVE_GIT_VERBS = [
  'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick',
  'clean', 'clone', 'commit', 'fetch', 'gc', 'init', 'merge',
  'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert',
  'rm', 'stash', 'submodule', 'switch', 'tag', 'update-ref',
  'worktree', 'prune', 'notes', 'replace', 'filter-branch',
];
const SHELL_GIT_REGEX = new RegExp(
  String.raw`(?:^|[\s;&|()])git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*(${DESTRUCTIVE_GIT_VERBS.join('|')})\b`,
  'g',
);

const SHELL_ALLOWLIST = new Set([
  'scripts/setup-imessage-hardlink.sh',
  // Transitional: pre-existing template script with destructive git verbs.
  // Tracked under commitment://incremental-migration (due 2026-05-03). PR #2
  // ports this to a Node script that uses SafeGitExecutor and removes this
  // entry.
  'src/templates/scripts/git-sync-gate.sh',
]);

function lintShellFile(file, text) {
  const rel = path.relative(ROOT, path.resolve(file));
  if (SHELL_ALLOWLIST.has(rel)) return;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    const stripped = line.replace(/^\s*#.*$/, '');
    if (!stripped) continue;
    SHELL_GIT_REGEX.lastIndex = 0;
    const m = SHELL_GIT_REGEX.exec(stripped);
    if (m) {
      report(file, i + 1, (m.index || 0) + 1, `Shell script invokes destructive 'git ${m[1]}' — port to a Node script using SafeGitExecutor.`);
    }
  }
}

function lintPackageJsonScripts(file, text) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return;
  }
  const scripts = pkg.scripts || {};
  for (const [name, cmd] of Object.entries(scripts)) {
    if (typeof cmd !== 'string') continue;
    SHELL_GIT_REGEX.lastIndex = 0;
    const m = SHELL_GIT_REGEX.exec(cmd);
    if (m) {
      report(file, 1, 1, `npm script "${name}" runs destructive 'git ${m[1]}' — refuse.`);
    }
  }
}

// ── File enumeration ───────────────────────────────────────────────

const TARGET_DIRS = ['src', 'tests', 'scripts'];
const TARGET_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

function walkDir(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkDir(full, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (TARGET_EXTS.includes(ext)) out.push(full);
      else if (e.name.endsWith('.sh')) out.push(full);
      else if (e.name === 'package.json') out.push(full);
    }
  }
}

function gatherFilesFromArgs(args) {
  const out = [];
  for (const a of args) {
    const full = path.resolve(a);
    if (!fs.existsSync(full)) continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) walkDir(full, out);
    else out.push(full);
  }
  return out;
}

function gatherStagedFiles() {
  // safe-git-allow: incremental-migration
  const stdout = execSync('git diff --cached --name-only --diff-filter=ACMR', {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rel) => path.resolve(ROOT, rel))
    .filter((full) => {
      try {
        return fs.statSync(full).isFile();
      } catch {
        return false;
      }
    });
}

function gatherAll() {
  const out = [];
  for (const d of TARGET_DIRS) {
    walkDir(path.join(ROOT, d), out);
  }
  // Also include package.json at root.
  out.push(path.join(ROOT, 'package.json'));
  return out;
}

// ── Main ───────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  let files;
  if (argv.includes('--staged')) {
    files = gatherStagedFiles();
  } else if (argv.length > 0) {
    files = gatherFilesFromArgs(argv);
  } else {
    files = gatherAll();
  }

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const rel = path.relative(ROOT, file);
    // package.json scripts grep
    if (path.basename(file) === 'package.json' && rel === 'package.json') {
      lintPackageJsonScripts(file, text);
      continue;
    }
    // Shell grep
    if (file.endsWith('.sh')) {
      lintShellFile(file, text);
      continue;
    }
    // Allowlist check (closed)
    if (ALLOWLIST.has(rel)) continue;
    if (hasAllowComment(text)) continue;

    // AST lint for ts/js/mjs/cjs
    try {
      lintTsFile(file, text);
    } catch (err) {
      // Parse failure → emit a soft warning, not a violation.
      process.stderr.write(`[lint-no-direct-destructive] failed to parse ${rel}: ${err.message}\n`);
    }
  }

  if (violations.length === 0) {
    return 0;
  }
  process.stderr.write('\n');
  process.stderr.write('╔════════════════════════════════════════════════════════════════════╗\n');
  process.stderr.write('║  lint-no-direct-destructive — VIOLATIONS                           ║\n');
  process.stderr.write('╚════════════════════════════════════════════════════════════════════╝\n');
  process.stderr.write('\n');
  for (const v of violations) {
    const rel = path.relative(ROOT, v.file);
    process.stderr.write(`  ${rel}:${v.line}:${v.col}\n    ${v.msg}\n\n`);
  }
  process.stderr.write(`Total: ${violations.length} violation(s).\n`);
  process.stderr.write('See docs/specs/COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md for guidance.\n');
  return 1;
}

const code = main();
process.exit(code);
