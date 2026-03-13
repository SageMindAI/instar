/**
 * File viewer API routes for the dashboard.
 *
 * Phase 1: List directories and read files within allowed paths.
 * Phase 2: Inline editing with optimistic concurrency and audit logging.
 *
 * All paths are relative to the project root. Security is defense-in-depth:
 * normalize, reject absolute, reject .., check allowedPaths, symlink resolution,
 * blocked filenames, never-editable enforcement.
 */

import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { InstarConfig, FileViewerConfig } from '../core/types.js';

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_FILE_VIEWER_CONFIG: FileViewerConfig = {
  enabled: true,
  allowedPaths: ['.claude/', 'docs/'],
  editablePaths: [],
  maxFileSize: 1_048_576, // 1MB
  maxEditableFileSize: 204_800, // 200KB
  blockedFilenames: [
    '.env', '.env.*', '*.key', '*.pem', '*.p12', 'secrets.*',
    'credentials.*', '*.secret', 'id_rsa', 'id_ed25519', '*.pfx',
    '*.jks', 'token.json',
  ],
};

// ── Blocked filename matching ────────────────────────────────────────

/**
 * Check if a filename matches any blocked pattern.
 * Supports: exact match, prefix glob (*.ext), suffix glob (prefix.*), combined (prefix.*)
 */
function isBlockedFilename(filename: string, patterns: string[]): boolean {
  const lower = filename.toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (p === lower) return true;
    if (p.startsWith('*.')) {
      // *.ext — match any file ending with that extension
      const ext = p.slice(1); // e.g., ".key"
      if (lower.endsWith(ext)) return true;
    } else if (p.endsWith('.*')) {
      // prefix.* — match any file starting with that prefix followed by a dot
      const prefix = p.slice(0, -1); // e.g., ".env."
      if (lower.startsWith(prefix)) return true;
    }
  }
  return false;
}

// ── Binary detection ─────────────────────────────────────────────────

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flac', '.wav', '.ogg',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.sqlite', '.db', '.sqlite3',
]);

function isBinaryFile(filePath: string, buffer?: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  // Check first 512 bytes for null bytes
  if (buffer) {
    const check = buffer.subarray(0, 512);
    for (let i = 0; i < check.length; i++) {
      if (check[i] === 0) return true;
    }
  }
  return false;
}

// ── Path validation (6-layer defense) ────────────────────────────────

interface PathValidationResult {
  valid: boolean;
  error?: string;
  status?: number;
  resolvedPath?: string; // absolute path after validation
}

async function validatePath(
  requestedPath: string,
  projectDir: string,
  config: FileViewerConfig,
): Promise<PathValidationResult> {
  // Layer 1: Normalize
  const normalized = path.normalize(requestedPath);

  // Layer 2: Reject absolute paths
  if (path.isAbsolute(normalized)) {
    return { valid: false, error: 'Absolute paths are not allowed', status: 403 };
  }

  // Layer 3: Reject path traversal
  if (normalized.includes('..')) {
    return { valid: false, error: 'Path traversal not allowed', status: 403 };
  }

  // Layer 4: Check against allowedPaths
  const allowed = config.allowedPaths.some(ap => {
    const normalizedAllowed = path.normalize(ap);
    return normalized === normalizedAllowed ||
           normalized.startsWith(normalizedAllowed.endsWith('/') ? normalizedAllowed : normalizedAllowed + '/');
  });
  if (!allowed) {
    return { valid: false, error: 'Path not in allowed directories', status: 403 };
  }

  // Layer 5: Symlink resolution
  const absolutePath = path.resolve(projectDir, normalized);
  try {
    // 5a: Check if it exists
    await fs.promises.lstat(absolutePath);
    // 5b: Resolve all symlinks
    const realPath = await fs.promises.realpath(absolutePath);
    // 5c: Post-dereference project root check
    const realProjectDir = await fs.promises.realpath(projectDir);
    if (!realPath.startsWith(realProjectDir + path.sep) && realPath !== realProjectDir) {
      return { valid: false, error: 'Path resolves outside project root', status: 403 };
    }
    // 5d: Post-dereference re-check against allowedPaths
    const relativAfterResolve = path.relative(realProjectDir, realPath);
    const allowedAfterResolve = config.allowedPaths.some(ap => {
      const normalizedAllowed = path.normalize(ap);
      return relativAfterResolve === normalizedAllowed.replace(/\/$/, '') ||
             relativAfterResolve.startsWith(normalizedAllowed.endsWith('/') ? normalizedAllowed : normalizedAllowed + '/') ||
             // Handle exact match with the allowed path itself (e.g. listing .claude/)
             (normalizedAllowed.replace(/\/$/, '') === relativAfterResolve);
    });
    if (!allowedAfterResolve) {
      return { valid: false, error: 'Resolved path not in allowed directories', status: 403 };
    }
    return { valid: true, resolvedPath: realPath };
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { valid: false, error: 'Path not found', status: 404 };
    }
    return { valid: false, error: 'Path validation failed', status: 500 };
  }
}

// Layer 6: Blocked filename check (applied separately for files)
function checkBlockedFilename(filePath: string, config: FileViewerConfig): string | null {
  const basename = path.basename(filePath);
  if (isBlockedFilename(basename, config.blockedFilenames)) {
    return 'Access to this file is blocked for security reasons';
  }
  return null;
}

// ── Check if a path is editable ──────────────────────────────────────

function isEditable(relativePath: string, config: FileViewerConfig): boolean {
  const normalized = path.normalize(relativePath);
  return config.editablePaths.some(ep => {
    const normalizedEditable = path.normalize(ep);
    return normalized === normalizedEditable ||
           normalized.startsWith(normalizedEditable.endsWith('/') ? normalizedEditable : normalizedEditable + '/');
  });
}

// ── Never-editable paths (security invariant) ────────────────────────

/**
 * Paths that are NEVER editable regardless of config.
 * A PIN compromise must never result in arbitrary code execution.
 */
const NEVER_EDITABLE_PREFIXES = [
  '.claude/hooks/',
  '.claude/scripts/',
  'node_modules/',
];

function isNeverEditable(relativePath: string): boolean {
  const normalized = path.normalize(relativePath);
  return NEVER_EDITABLE_PREFIXES.some(prefix =>
    normalized.startsWith(prefix) || normalized === prefix.replace(/\/$/, ''),
  );
}

// ── Audit log ────────────────────────────────────────────────────────

async function appendAuditLog(
  projectDir: string,
  entry: { operation: string; path: string; sourceIp: string; size: number; success: boolean },
): Promise<void> {
  const logDir = path.join(projectDir, '.instar');
  const logPath = path.join(logDir, 'file-viewer-audit.jsonl');
  try {
    await fs.promises.mkdir(logDir, { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    await fs.promises.appendFile(logPath, line);
  } catch {
    // Audit log failure must not block the save operation
  }
}

// ── Route factory ────────────────────────────────────────────────────

export function createFileRoutes(options: { config: InstarConfig; liveConfig?: { set(path: string, value: unknown): void } }): Router {
  const router = Router();
  const projectDir = options.config.projectDir;
  const config: FileViewerConfig = {
    ...DEFAULT_FILE_VIEWER_CONFIG,
    ...options.config.dashboard?.fileViewer,
  };

  const liveConfig = options.liveConfig ?? null;

  // If file viewer is disabled, return empty router
  if (!config.enabled) return router;

  // ── GET /api/files/list ────────────────────────────────────────

  router.get('/api/files/list', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';

    // If no path specified, return the root allowed directories
    if (!requestedPath) {
      const roots: Array<{ name: string; type: string }> = [];
      for (const ap of config.allowedPaths) {
        const normalizedAp = path.normalize(ap).replace(/\/$/, '');
        const absPath = path.resolve(projectDir, normalizedAp);
        try {
          const stat = await fs.promises.lstat(absPath);
          if (stat.isDirectory()) {
            roots.push({ name: normalizedAp, type: 'directory' });
          }
        } catch {
          // Silently skip non-existent allowed paths
        }
      }
      res.json({ path: '', entries: roots });
      return;
    }

    // Validate the requested path
    const validation = await validatePath(requestedPath, projectDir, config);
    if (!validation.valid) {
      res.status(validation.status || 403).json({ error: validation.error });
      return;
    }

    const absPath = validation.resolvedPath!;

    try {
      const stat = await fs.promises.stat(absPath);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' });
        return;
      }

      const entries: Array<{
        name: string;
        type: 'file' | 'directory';
        size?: number;
        modified?: string;
      }> = [];

      const dirEntries = await fs.promises.readdir(absPath, { withFileTypes: true });

      // Sort: directories first, then alphabetically
      const sorted = dirEntries.sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1;
        const bDir = b.isDirectory() ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name);
      });

      // Limit to 500 entries
      const limited = sorted.slice(0, 500);

      for (const entry of limited) {
        // Skip blocked filenames
        if (isBlockedFilename(entry.name, config.blockedFilenames)) continue;
        // Skip hidden files starting with . (except specifically allowed like .claude)
        // Actually, don't skip — let the user see what's there within allowed dirs

        const entryRelPath = path.join(path.normalize(requestedPath), entry.name);

        if (entry.isDirectory()) {
          entries.push({ name: entry.name, type: 'directory' });
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          try {
            const entryAbsPath = path.join(absPath, entry.name);
            const entryStat = await fs.promises.stat(entryAbsPath);
            entries.push({
              name: entry.name,
              type: 'file',
              size: entryStat.size,
              modified: entryStat.mtime.toISOString(),
            });
          } catch {
            // Skip entries we can't stat
          }
        }
      }

      const result: Record<string, unknown> = {
        path: path.normalize(requestedPath),
        entries,
      };

      if (sorted.length > 500) {
        result.truncated = true;
        result.totalEntries = sorted.length;
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list directory' });
    }
  });

  // ── GET /api/files/read ────────────────────────────────────────

  router.get('/api/files/read', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    // Validate the path
    const validation = await validatePath(requestedPath, projectDir, config);
    if (!validation.valid) {
      res.status(validation.status || 403).json({ error: validation.error });
      return;
    }

    // Check blocked filenames
    const blocked = checkBlockedFilename(requestedPath, config);
    if (blocked) {
      res.status(403).json({ error: blocked });
      return;
    }

    const absPath = validation.resolvedPath!;

    try {
      const stat = await fs.promises.stat(absPath);

      if (stat.isDirectory()) {
        res.status(400).json({ error: 'Path is a directory, use /api/files/list instead' });
        return;
      }

      // Size check
      if (stat.size > config.maxFileSize) {
        res.status(413).json({
          error: 'File too large',
          size: stat.size,
          maxSize: config.maxFileSize,
        });
        return;
      }

      // Read initial bytes for binary detection
      const buffer = await fs.promises.readFile(absPath);

      if (isBinaryFile(absPath, buffer)) {
        res.json({
          path: path.normalize(requestedPath),
          binary: true,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
        return;
      }

      const content = buffer.toString('utf-8');
      const editable = isEditable(requestedPath, config);

      res.json({
        path: path.normalize(requestedPath),
        content,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        editable,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read file' });
    }
  });

  // ── POST /api/files/save ─────────────────────────────────────

  router.post('/api/files/save', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    // CSRF protection: require custom header
    if (req.headers['x-instar-request'] !== '1') {
      res.status(403).json({ error: 'Missing CSRF header' });
      return;
    }

    const { path: requestedPath, content, expectedModified } = req.body || {};
    const sourceIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';

    if (typeof requestedPath !== 'string' || !requestedPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Missing content parameter' });
      return;
    }

    // Check content size against editable limit
    const contentSize = Buffer.byteLength(content, 'utf-8');
    if (contentSize > config.maxEditableFileSize) {
      res.status(413).json({
        error: 'Content too large for editing',
        size: contentSize,
        maxSize: config.maxEditableFileSize,
      });
      return;
    }

    // Validate path (same 6-layer defense as read)
    const validation = await validatePath(requestedPath, projectDir, config);
    if (!validation.valid) {
      res.status(validation.status || 403).json({ error: validation.error });
      return;
    }

    // Check blocked filenames
    const blocked = checkBlockedFilename(requestedPath, config);
    if (blocked) {
      res.status(403).json({ error: blocked });
      return;
    }

    // Never-editable enforcement (security invariant)
    if (isNeverEditable(requestedPath)) {
      res.status(403).json({ error: 'This path is never editable for security reasons' });
      return;
    }

    // Editable path check
    if (!isEditable(requestedPath, config)) {
      res.status(403).json({ error: 'This file is not in an editable path' });
      return;
    }

    const absPath = validation.resolvedPath!;

    try {
      const stat = await fs.promises.stat(absPath);

      if (stat.isDirectory()) {
        res.status(400).json({ error: 'Cannot write to a directory' });
        return;
      }

      // Binary check
      if (isBinaryFile(absPath)) {
        res.status(400).json({ error: 'Cannot edit binary files' });
        return;
      }

      // Optimistic concurrency: check if file was modified since client loaded it
      if (typeof expectedModified === 'string') {
        const currentModified = stat.mtime.toISOString();
        if (currentModified !== expectedModified) {
          await appendAuditLog(projectDir, {
            operation: 'write_conflict',
            path: requestedPath,
            sourceIp,
            size: contentSize,
            success: false,
          });
          res.status(409).json({
            error: 'File was modified since you loaded it',
            currentModified,
            expectedModified,
          });
          return;
        }
      }

      // Write the file
      await fs.promises.writeFile(absPath, content, 'utf-8');

      // Get updated stats
      const newStat = await fs.promises.stat(absPath);

      await appendAuditLog(projectDir, {
        operation: 'write',
        path: requestedPath,
        sourceIp,
        size: contentSize,
        success: true,
      });

      res.json({
        path: path.normalize(requestedPath),
        size: newStat.size,
        modified: newStat.mtime.toISOString(),
        success: true,
      });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File was deleted between validation and write — create it
        try {
          await fs.promises.writeFile(absPath, content, 'utf-8');
          const newStat = await fs.promises.stat(absPath);
          await appendAuditLog(projectDir, {
            operation: 'create',
            path: requestedPath,
            sourceIp,
            size: contentSize,
            success: true,
          });
          res.json({
            path: path.normalize(requestedPath),
            size: newStat.size,
            modified: newStat.mtime.toISOString(),
            success: true,
          });
        } catch {
          await appendAuditLog(projectDir, {
            operation: 'write',
            path: requestedPath,
            sourceIp,
            size: contentSize,
            success: false,
          });
          res.status(500).json({ error: 'Failed to save file' });
        }
        return;
      }
      await appendAuditLog(projectDir, {
        operation: 'write',
        path: requestedPath,
        sourceIp,
        size: contentSize,
        success: false,
      });
      res.status(500).json({ error: 'Failed to save file' });
    }
  });

  // ── GET /api/files/config ──────────────────────────────────────

  router.get('/api/files/config', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      enabled: config.enabled,
      allowedPaths: config.allowedPaths,
      editablePaths: config.editablePaths,
      maxFileSize: config.maxFileSize,
      maxEditableFileSize: config.maxEditableFileSize,
    });
  });

  // ── PATCH /api/files/config ─────────────────────────────────────
  // Phase 3: Conversational config updates — agent can add/remove paths

  router.patch('/api/files/config', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    if (req.headers['x-instar-request'] !== '1') {
      res.status(403).json({ error: 'Missing CSRF header' });
      return;
    }

    if (!liveConfig) {
      res.status(501).json({ error: 'Config updates not available (no LiveConfig)' });
      return;
    }

    const { allowedPaths, editablePaths } = req.body || {};

    // Validate allowedPaths
    if (allowedPaths !== undefined) {
      if (!Array.isArray(allowedPaths) || !allowedPaths.every((p: unknown) => typeof p === 'string')) {
        res.status(400).json({ error: 'allowedPaths must be an array of strings' });
        return;
      }
      // Reject paths that try to escape project root
      for (const p of allowedPaths) {
        const normalized = path.normalize(p);
        if (normalized.startsWith('/') || normalized.includes('..')) {
          res.status(400).json({ error: `Invalid path: ${p} — must be relative without ..` });
          return;
        }
      }
    }

    // Validate editablePaths
    if (editablePaths !== undefined) {
      if (!Array.isArray(editablePaths) || !editablePaths.every((p: unknown) => typeof p === 'string')) {
        res.status(400).json({ error: 'editablePaths must be an array of strings' });
        return;
      }
      for (const p of editablePaths) {
        const normalized = path.normalize(p);
        if (normalized.startsWith('/') || normalized.includes('..')) {
          res.status(400).json({ error: `Invalid path: ${p} — must be relative without ..` });
          return;
        }
        // Never-editable enforcement
        if (isNeverEditable(normalized)) {
          res.status(400).json({ error: `Path ${p} is never editable for security reasons` });
          return;
        }
      }
    }

    // Apply updates
    if (allowedPaths !== undefined) {
      config.allowedPaths = allowedPaths;
      liveConfig.set('dashboard.fileViewer.allowedPaths', allowedPaths);
    }
    if (editablePaths !== undefined) {
      config.editablePaths = editablePaths;
      liveConfig.set('dashboard.fileViewer.editablePaths', editablePaths);
    }

    res.json({
      allowedPaths: config.allowedPaths,
      editablePaths: config.editablePaths,
      updated: true,
    });
  });

  // ── GET /api/files/link ─────────────────────────────────────────
  // Phase 3: Generate a deep link URL for a file in the dashboard

  router.get('/api/files/link', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    // Validate path is within allowed directories
    const normalized = path.normalize(filePath);
    const inAllowed = config.allowedPaths.some(ap => {
      const normalizedAllowed = path.normalize(ap);
      return normalized.startsWith(normalizedAllowed) || normalized === normalizedAllowed.replace(/\/$/, '');
    });

    if (!inAllowed) {
      res.status(403).json({ error: 'Path not in allowed directories' });
      return;
    }

    const encodedPath = encodeURIComponent(normalized);
    const relativePath = `/dashboard?tab=files&path=${encodedPath}`;

    res.json({
      path: normalized,
      relative: relativePath,
      editable: isEditable(normalized, config),
    });
  });

  return router;
}
