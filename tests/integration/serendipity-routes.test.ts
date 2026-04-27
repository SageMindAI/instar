/**
 * Integration tests for the Serendipity Protocol.
 *
 * Tests:
 * - GET /serendipity/stats — stats endpoint with pending/processed/invalid counts
 * - GET /serendipity/findings — list pending findings
 * - WorktreeMonitor.copySerendipityFindings — copy-back from worktrees
 * - Session-start hook serendipity injection
 * - installSerendipityCapture — script installation during init
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { WorktreeMonitor } from '../../src/monitoring/WorktreeMonitor.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

// ── Test Helpers ────────────────────────────────────────────────

function createTestFinding(id: string, overrides: Partial<{
  title: string;
  category: string;
  readiness: string;
  sessionId: string;
}> = {}): object {
  return {
    schemaVersion: 1,
    id: `srdp-${id}`,
    hmac: 'test-hmac-' + id,
    createdAt: new Date().toISOString(),
    source: {
      sessionId: overrides.sessionId || 'test-session',
      taskDescription: 'unit testing',
      agentType: 'general-purpose',
    },
    discovery: {
      title: overrides.title || `Test finding ${id}`,
      description: `Description of finding ${id}`,
      category: overrides.category || 'improvement',
      rationale: `Rationale for finding ${id}`,
    },
    readiness: overrides.readiness || 'idea-only',
    status: 'pending',
  };
}

function writeTestFinding(dir: string, id: string, overrides = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `srdp-${id}.json`;
  fs.writeFileSync(
    path.join(dir, filename),
    JSON.stringify(createTestFinding(id, overrides), null, 2),
  );
  return filename;
}

// ── Server Route Tests ──────────────────────────────────────────

describe('Serendipity routes', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let serendipityDir: string;

  beforeAll(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    serendipityDir = path.join(project.stateDir, 'state', 'serendipity');

    const config: InstarConfig = {
      projectName: 'test-serendipity',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      sessions: {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/claude',
        projectDir: project.dir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: [],
      },
      scheduler: {
        jobsFile: path.join(project.stateDir, 'jobs.json'),
        enabled: false,
        maxParallelJobs: 2,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      users: [],
      messaging: [],
      monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
    } as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  beforeEach(() => {
    // Clean serendipity directory
    if (fs.existsSync(serendipityDir)) {
      // safe-git-allow: incremental-migration
      fs.rmSync(serendipityDir, { recursive: true, force: true });
    }
  });

  describe('GET /serendipity/stats', () => {
    it('returns zeros when no findings exist', async () => {
      const res = await request(app).get('/serendipity/stats');
      expect(res.status).toBe(200);
      expect(res.body.pending).toBe(0);
      expect(res.body.processed).toBe(0);
      expect(res.body.invalid).toBe(0);
      expect(res.body.total).toBe(0);
      expect(res.body.pendingFindings).toEqual([]);
    });

    it('counts pending findings', async () => {
      writeTestFinding(serendipityDir, 'aaa11111');
      writeTestFinding(serendipityDir, 'bbb22222');

      const res = await request(app).get('/serendipity/stats');
      expect(res.status).toBe(200);
      expect(res.body.pending).toBe(2);
      expect(res.body.total).toBe(2);
    });

    it('counts processed and invalid separately', async () => {
      writeTestFinding(serendipityDir, 'pending1');
      writeTestFinding(path.join(serendipityDir, 'processed'), 'proc1');
      writeTestFinding(path.join(serendipityDir, 'processed'), 'proc2');
      writeTestFinding(path.join(serendipityDir, 'invalid'), 'inv1');

      const res = await request(app).get('/serendipity/stats');
      expect(res.status).toBe(200);
      expect(res.body.pending).toBe(1);
      expect(res.body.processed).toBe(2);
      expect(res.body.invalid).toBe(1);
      expect(res.body.total).toBe(4);
    });

    it('includes finding details in pendingFindings', async () => {
      writeTestFinding(serendipityDir, 'detail01', {
        title: 'Security vulnerability in auth',
        category: 'security',
        readiness: 'implementation-complete',
      });

      const res = await request(app).get('/serendipity/stats');
      expect(res.body.pendingFindings.length).toBe(1);
      expect(res.body.pendingFindings[0].id).toBe('srdp-detail01');
      expect(res.body.pendingFindings[0].title).toBe('Security vulnerability in auth');
      expect(res.body.pendingFindings[0].category).toBe('security');
      expect(res.body.pendingFindings[0].readiness).toBe('implementation-complete');
    });

    it('ignores .tmp files', async () => {
      writeTestFinding(serendipityDir, 'real0001');
      fs.writeFileSync(
        path.join(serendipityDir, 'srdp-temp.json.tmp'),
        '{"partial": true}',
      );

      const res = await request(app).get('/serendipity/stats');
      expect(res.body.pending).toBe(1);
    });
  });

  describe('GET /serendipity/findings', () => {
    it('returns empty array when no findings', async () => {
      const res = await request(app).get('/serendipity/findings');
      expect(res.status).toBe(200);
      expect(res.body.findings).toEqual([]);
    });

    it('returns all pending findings', async () => {
      writeTestFinding(serendipityDir, 'find0001', { title: 'First' });
      writeTestFinding(serendipityDir, 'find0002', { title: 'Second' });

      const res = await request(app).get('/serendipity/findings');
      expect(res.body.findings.length).toBe(2);
      const titles = res.body.findings.map((f: any) => f.discovery.title);
      expect(titles).toContain('First');
      expect(titles).toContain('Second');
    });

    it('does not include processed findings', async () => {
      writeTestFinding(serendipityDir, 'active01', { title: 'Active' });
      writeTestFinding(path.join(serendipityDir, 'processed'), 'done01', { title: 'Done' });

      const res = await request(app).get('/serendipity/findings');
      expect(res.body.findings.length).toBe(1);
      expect(res.body.findings[0].discovery.title).toBe('Active');
    });
  });
});

// ── WorktreeMonitor Copy-Back Tests ─────────────────────────────

describe('WorktreeMonitor serendipity copy-back', () => {
  let mainProject: TempProject;
  let worktreePath: string;
  let monitor: WorktreeMonitor;
  let mainSerendipityDir: string;
  let worktreeSerendipityDir: string;

  beforeAll(() => {
    mainProject = createTempProject();
    worktreePath = path.join(mainProject.dir, 'worktree-test');
    fs.mkdirSync(worktreePath, { recursive: true });

    mainSerendipityDir = path.join(mainProject.stateDir, 'state', 'serendipity');
    worktreeSerendipityDir = path.join(worktreePath, '.instar', 'state', 'serendipity');

    monitor = new WorktreeMonitor({
      projectDir: mainProject.dir,
      stateDir: mainProject.stateDir,
    });
  });

  afterAll(() => {
    mainProject.cleanup();
  });

  beforeEach(() => {
    // Clean both directories
    for (const dir of [mainSerendipityDir, worktreeSerendipityDir]) {
      if (fs.existsSync(dir)) {
        // safe-git-allow: incremental-migration
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('copies findings from worktree to main tree', () => {
    writeTestFinding(worktreeSerendipityDir, 'wt000001', { title: 'From worktree' });

    // Access the private method via any cast
    const copied = (monitor as any).copySerendipityFindings(worktreePath);

    expect(copied).toBe(1);
    expect(fs.existsSync(path.join(mainSerendipityDir, 'srdp-wt000001.json'))).toBe(true);

    const finding = JSON.parse(fs.readFileSync(path.join(mainSerendipityDir, 'srdp-wt000001.json'), 'utf-8'));
    expect(finding.discovery.title).toBe('From worktree');
  });

  it('copies associated patch files', () => {
    writeTestFinding(worktreeSerendipityDir, 'wtpatch1', { title: 'With patch' });
    fs.writeFileSync(
      path.join(worktreeSerendipityDir, 'srdp-wtpatch1.patch'),
      '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n',
    );

    const copied = (monitor as any).copySerendipityFindings(worktreePath);

    expect(copied).toBe(2); // .json + .patch
    expect(fs.existsSync(path.join(mainSerendipityDir, 'srdp-wtpatch1.json'))).toBe(true);
    expect(fs.existsSync(path.join(mainSerendipityDir, 'srdp-wtpatch1.patch'))).toBe(true);
  });

  it('skips when no serendipity directory exists in worktree', () => {
    const copied = (monitor as any).copySerendipityFindings(worktreePath);
    expect(copied).toBe(0);
  });

  it('skips duplicate findings (same filename already in main)', () => {
    writeTestFinding(worktreeSerendipityDir, 'dup00001', { title: 'Worktree version' });
    writeTestFinding(mainSerendipityDir, 'dup00001', { title: 'Main version' });

    const copied = (monitor as any).copySerendipityFindings(worktreePath);
    expect(copied).toBe(0);

    // Verify main version is unchanged
    const finding = JSON.parse(fs.readFileSync(path.join(mainSerendipityDir, 'srdp-dup00001.json'), 'utf-8'));
    expect(finding.discovery.title).toBe('Main version');
  });

  it('rejects symlinks in worktree serendipity directory', () => {
    fs.mkdirSync(worktreeSerendipityDir, { recursive: true });

    // Create a real file and a symlink to it
    const realFile = path.join(worktreeSerendipityDir, 'real-data.txt');
    fs.writeFileSync(realFile, 'sensitive data');
    fs.symlinkSync(realFile, path.join(worktreeSerendipityDir, 'srdp-symlink1.json'));

    const copied = (monitor as any).copySerendipityFindings(worktreePath);
    expect(copied).toBe(0);
    expect(fs.existsSync(path.join(mainSerendipityDir, 'srdp-symlink1.json'))).toBe(false);
  });

  it('rejects files over 100KB', () => {
    fs.mkdirSync(worktreeSerendipityDir, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeSerendipityDir, 'srdp-bigfile1.json'),
      'x'.repeat(102_401),
    );

    const copied = (monitor as any).copySerendipityFindings(worktreePath);
    expect(copied).toBe(0);
  });

  it('only copies .json and .patch files', () => {
    fs.mkdirSync(worktreeSerendipityDir, { recursive: true });
    writeTestFinding(worktreeSerendipityDir, 'valid001');
    fs.writeFileSync(path.join(worktreeSerendipityDir, 'notes.txt'), 'not a finding');
    fs.writeFileSync(path.join(worktreeSerendipityDir, 'script.sh'), '#!/bin/bash');

    const copied = (monitor as any).copySerendipityFindings(worktreePath);
    expect(copied).toBe(1); // Only the .json
    expect(fs.existsSync(path.join(mainSerendipityDir, 'notes.txt'))).toBe(false);
    expect(fs.existsSync(path.join(mainSerendipityDir, 'script.sh'))).toBe(false);
  });

  it('skips .tmp files', () => {
    fs.mkdirSync(worktreeSerendipityDir, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeSerendipityDir, 'srdp-temp0001.json.tmp'),
      '{"partial": true}',
    );

    const copied = (monitor as any).copySerendipityFindings(worktreePath);
    expect(copied).toBe(0);
  });

  it('copies multiple findings in one pass', () => {
    writeTestFinding(worktreeSerendipityDir, 'multi001', { title: 'First', category: 'bug' });
    writeTestFinding(worktreeSerendipityDir, 'multi002', { title: 'Second', category: 'security' });
    writeTestFinding(worktreeSerendipityDir, 'multi003', { title: 'Third', category: 'pattern' });

    const copied = (monitor as any).copySerendipityFindings(worktreePath);
    expect(copied).toBe(3);
  });
});

// ── installSerendipityCapture Tests ─────────────────────────────

describe('installSerendipityCapture', () => {
  let project: TempProject;

  beforeAll(async () => {
    project = createTempProject();
  });

  afterAll(() => {
    project.cleanup();
  });

  it('installs the capture script from template', async () => {
    // Dynamically import the init module to get the function
    // Since it's not exported, we test via the file system effect
    const scriptsDir = path.join(project.stateDir, 'scripts');
    const scriptPath = path.join(scriptsDir, 'serendipity-capture.sh');

    // We can't easily call the private function, but we can verify the template exists
    const templatePath = path.resolve(__dirname, '../../src/templates/scripts/serendipity-capture.sh');
    expect(fs.existsSync(templatePath)).toBe(true);

    // Verify it's a valid bash script
    const content = fs.readFileSync(templatePath, 'utf-8');
    expect(content).toMatch(/^#!/);
    expect(content).toContain('serendipity-capture.sh');
    expect(content).toContain('HMAC');
    expect(content).toContain('secret');
    expect(content).toContain('rate limit');
  });

  it('template script has correct structure', () => {
    const templatePath = path.resolve(__dirname, '../../src/templates/scripts/serendipity-capture.sh');
    const content = fs.readFileSync(templatePath, 'utf-8');

    // Verify all expected validation sections
    expect(content).toContain('VALID_CATEGORIES=');
    expect(content).toContain('VALID_READINESS=');
    expect(content).toContain('MAX_PER_SESSION=');
    expect(content).toContain('MAX_TITLE_LEN=');
    expect(content).toContain('MAX_DESC_LEN=');
    expect(content).toContain('MAX_RATIONALE_LEN=');
    expect(content).toContain('MAX_PATCH_SIZE=');

    // Verify security checks
    expect(content).toContain('SECRET_PATTERNS=');
    expect(content).toContain('symlink');
    expect(content).toContain('path traversal');

    // Verify HMAC signing
    expect(content).toContain('serendipity-v1:');
    expect(content).toContain('hmac');
    expect(content).toContain('sha256');

    // Verify atomic write
    expect(content).toContain('.tmp');
    expect(content).toContain('os.rename');
  });
});

// ── CLAUDE.md Template Tests ────────────────────────────────────

describe('CLAUDE.md template includes serendipity section', () => {
  it('includes the Serendipity Protocol section', async () => {
    const { generateClaudeMd } = await import('../../src/scaffold/templates.js');
    const content = generateClaudeMd('test-project', 'TestAgent', 4042, false);

    expect(content).toContain('### Serendipity Protocol');
    expect(content).toContain('serendipity-capture.sh');
    expect(content).toContain('--category');
    expect(content).toContain('--readiness');
    expect(content).toContain('idea-only');
    expect(content).toContain('--patch-file');
  });

  it('mentions rate limiting in serendipity section', async () => {
    const { generateClaudeMd } = await import('../../src/scaffold/templates.js');
    const content = generateClaudeMd('test-project', 'TestAgent', 4042, false);

    expect(content).toContain('rate-limited');
  });

  it('mentions secret scanning in serendipity section', async () => {
    const { generateClaudeMd } = await import('../../src/scaffold/templates.js');
    const content = generateClaudeMd('test-project', 'TestAgent', 4042, false);

    expect(content).toContain('Secret scanning');
  });
});
