/**
 * Integration test — fresh project creation via `instar init <name>`.
 *
 * Tests the complete fresh install journey:
 *   init with project name → directory created → all files scaffolded →
 *   config valid → identity files present → hooks installed → git initialized
 */

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../src/commands/init.js';

describe('Fresh install: instar init <project-name>', () => {
  const testBase = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fresh-'));
  const projectName = 'test-agent';
  const projectDir = path.join(testBase, projectName);

  afterAll(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(testBase, { recursive: true, force: true });
  });

  it('creates project directory and all required files', async () => {
    // Change cwd temporarily so init creates the project relative to testBase
    const originalCwd = process.cwd();
    process.chdir(testBase);

    try {
      await initProject({ name: projectName, port: 4444, skipPrereqs: true });
    } finally {
      process.chdir(originalCwd);
    }

    // Verify project directory exists
    expect(fs.existsSync(projectDir)).toBe(true);
  });

  it('creates CLAUDE.md at project root', () => {
    const claudeMd = path.join(projectDir, 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(true);

    const content = fs.readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('test-agent');
    expect(content).toContain('Agent Infrastructure');
    expect(content).toContain('Initiative Hierarchy');
  });

  it('creates .instar directory structure', () => {
    const stateDir = path.join(projectDir, '.instar');
    expect(fs.existsSync(stateDir)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state', 'sessions'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state', 'jobs'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'relationships'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'logs'))).toBe(true);
  });

  it('creates AGENT.md with identity', () => {
    const agentMd = path.join(projectDir, '.instar', 'AGENT.md');
    expect(fs.existsSync(agentMd)).toBe(true);

    const content = fs.readFileSync(agentMd, 'utf-8');
    expect(content).toContain('# Test-agent'); // Capitalized
    expect(content).toContain('Who I Am');
    expect(content).toContain('My Principles');
  });

  it('creates USER.md', () => {
    const userMd = path.join(projectDir, '.instar', 'USER.md');
    expect(fs.existsSync(userMd)).toBe(true);

    const content = fs.readFileSync(userMd, 'utf-8');
    expect(content).toContain('Communication Preferences');
  });

  it('creates MEMORY.md', () => {
    const memoryMd = path.join(projectDir, '.instar', 'MEMORY.md');
    expect(fs.existsSync(memoryMd)).toBe(true);

    const content = fs.readFileSync(memoryMd, 'utf-8');
    expect(content).toContain('Memory');
    expect(content).toContain('persists across sessions');
  });

  it('creates valid config.json', () => {
    const configPath = path.join(projectDir, '.instar', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.projectName).toBe('test-agent');
    expect(config.port).toBe(4444);
    expect(config.authToken).toBeTruthy();
    expect(config.sessions.maxSessions).toBe(10);
    expect(config.scheduler.enabled).toBe(true); // Enabled by default for fresh
    expect(config.relationships.maxRecentInteractions).toBe(20);
    expect(config.updates).toBeDefined();
    expect(config.updates.autoApply).toBe(true); // Auto-apply updates by default
  });

  it('writes config.json with restrictive permissions (0o600)', () => {
    const configPath = path.join(projectDir, '.instar', 'config.json');
    const stats = fs.statSync(configPath);
    // Config contains auth token — must be owner-only read/write
    const permissions = stats.mode & 0o777;
    expect(permissions).toBe(0o600);
  });

  it('creates jobs.json with default coherence jobs', () => {
    const jobsPath = path.join(projectDir, '.instar', 'jobs.json');
    expect(fs.existsSync(jobsPath)).toBe(true);

    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    expect(jobs.length).toBe(26);

    const slugs = jobs.map((j: any) => j.slug);
    // Core jobs
    expect(slugs).toContain('health-check');
    expect(slugs).toContain('reflection-trigger');
    expect(slugs).toContain('relationship-maintenance');
    expect(slugs).toContain('feedback-retry');
    expect(slugs).toContain('insight-harvest');
    expect(slugs).toContain('evolution-overdue-check');
    expect(slugs).toContain('project-map-refresh');
    expect(slugs).toContain('coherence-audit');
    // 5 guardian network jobs
    expect(slugs).toContain('degradation-digest');
    expect(slugs).toContain('state-integrity-check');
    expect(slugs).toContain('memory-hygiene');
    expect(slugs).toContain('guardian-pulse');
    expect(slugs).toContain('session-continuity-check');
    // Maintenance jobs
    expect(slugs).toContain('memory-export');
    // Infrastructure jobs
    expect(slugs).toContain('git-sync');
    // Capability audit
    expect(slugs).toContain('capability-audit');
    // Identity review
    expect(slugs).toContain('identity-review');
    // Evolution jobs
    expect(slugs).toContain('evolution-proposal-evaluate');
    expect(slugs).toContain('evolution-proposal-implement');
    // Commitment detection
    expect(slugs).toContain('commitment-detection');
    // Dashboard
    expect(slugs).toContain('dashboard-link-refresh');
    // Overseer jobs
    expect(slugs).toContain('overseer-guardian');
    expect(slugs).toContain('overseer-learning');
    expect(slugs).toContain('overseer-maintenance');
    expect(slugs).toContain('overseer-infrastructure');
    expect(slugs).toContain('overseer-development');
  });

  it('installs behavioral hooks', () => {
    const hooksDir = path.join(projectDir, '.instar', 'hooks', 'instar');
    expect(fs.existsSync(hooksDir)).toBe(true);

    const hooks = fs.readdirSync(hooksDir);
    expect(hooks).toContain('session-start.sh');
    expect(hooks).toContain('dangerous-command-guard.sh');
    expect(hooks).toContain('grounding-before-messaging.sh');
    expect(hooks).toContain('compaction-recovery.sh');

    // Verify hooks are executable
    for (const hook of hooks) {
      const stats = fs.statSync(path.join(hooksDir, hook));
      expect(stats.mode & 0o111).toBeGreaterThan(0); // Has execute bit
    }

    // Verify custom hooks directory exists
    const customHooksDir = path.join(projectDir, '.instar', 'hooks', 'custom');
    expect(fs.existsSync(customHooksDir)).toBe(true);
  });

  it('creates .claude/settings.json with hook config', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
  });

  it('registers autonomous stop hook in settings.json', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    const stopHooks = settings.hooks?.Stop as Array<{ hooks?: Array<{ command?: string }> }>;
    expect(stopHooks).toBeDefined();

    const hasAutonomousHook = stopHooks.some(entry =>
      entry.hooks?.some(h => h.command?.includes('autonomous-stop-hook')),
    );
    expect(hasAutonomousHook).toBe(true);
  });

  it('installs autonomous skill with hooks directory', () => {
    const hookScript = path.join(projectDir, '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
    expect(fs.existsSync(hookScript)).toBe(true);

    // Must be executable
    const stats = fs.statSync(hookScript);
    expect(stats.mode & 0o111).toBeGreaterThan(0);
  });

  it('creates .claude/scripts/health-watchdog.sh', () => {
    const watchdogPath = path.join(projectDir, '.claude', 'scripts', 'health-watchdog.sh');
    expect(fs.existsSync(watchdogPath)).toBe(true);

    const stats = fs.statSync(watchdogPath);
    expect(stats.mode & 0o111).toBeGreaterThan(0);
  });

  it('installs convergence-check.sh in .instar/scripts/', () => {
    const checkPath = path.join(projectDir, '.instar', 'scripts', 'convergence-check.sh');
    expect(fs.existsSync(checkPath)).toBe(true);

    const stats = fs.statSync(checkPath);
    expect(stats.mode & 0o111).toBeGreaterThan(0); // executable

    const content = fs.readFileSync(checkPath, 'utf-8');
    expect(content).toContain('CONVERGENCE CHECK');
    expect(content).toContain('URL_PROVENANCE'); // URL provenance check present
    expect(content).toContain('EXPERIENTIAL'); // experiential fabrication check present
  });

  it('grounding-before-messaging.sh calls convergence check', () => {
    const hookPath = path.join(projectDir, '.instar', 'hooks', 'instar', 'grounding-before-messaging.sh');
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('convergence-check.sh'); // references convergence check
    expect(content).toContain('PRE-MESSAGE GROUNDING'); // identity injection phase
    expect(content).toContain('AGENT.md'); // injects identity
  });

  it('creates .gitignore with state exclusions', () => {
    const gitignorePath = path.join(projectDir, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('.instar/state/');
    expect(content).toContain('.instar/logs/');
  });

  it('initializes a git repository', () => {
    const gitDir = path.join(projectDir, '.git');
    expect(fs.existsSync(gitDir)).toBe(true);
  });
});

describe('Existing project: instar init (no project name)', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-existing-'));

  afterAll(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('adds .instar/ to an existing directory without CLAUDE.md', async () => {
    // Create a minimal existing project
    fs.writeFileSync(path.join(testDir, 'index.ts'), '// existing code');

    await initProject({ dir: testDir, port: 5555, skipPrereqs: true });

    // Verify .instar was created
    expect(fs.existsSync(path.join(testDir, '.instar', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.instar', 'AGENT.md'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.instar', 'USER.md'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.instar', 'MEMORY.md'))).toBe(true);

    // Verify existing file wasn't touched
    const existingContent = fs.readFileSync(path.join(testDir, 'index.ts'), 'utf-8');
    expect(existingContent).toBe('// existing code');

    // Verify scheduler is disabled for existing projects (conservative default)
    const config = JSON.parse(fs.readFileSync(path.join(testDir, '.instar', 'config.json'), 'utf-8'));
    expect(config.scheduler.enabled).toBe(false);
  });

  it('appends to existing CLAUDE.md without overwriting', async () => {
    const anotherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-existing2-'));
    const existingContent = '# My Project\n\nThis is my project.\n';
    fs.writeFileSync(path.join(anotherDir, 'CLAUDE.md'), existingContent);

    await initProject({ dir: anotherDir, skipPrereqs: true });

    const result = fs.readFileSync(path.join(anotherDir, 'CLAUDE.md'), 'utf-8');
    expect(result).toContain('# My Project');
    expect(result).toContain('This is my project.');
    expect(result).toContain('## Agent Infrastructure');

    // safe-git-allow: incremental-migration
    fs.rmSync(anotherDir, { recursive: true, force: true });
  });

  it('does not re-append if already initialized', async () => {
    const anotherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-existing3-'));
    const existingContent = '# My Project\n\n## Agent Infrastructure\n\nAlready here.\n';
    fs.writeFileSync(path.join(anotherDir, 'CLAUDE.md'), existingContent);

    await initProject({ dir: anotherDir, skipPrereqs: true });

    const result = fs.readFileSync(path.join(anotherDir, 'CLAUDE.md'), 'utf-8');
    // Should only have one instance of Agent Infrastructure
    const count = (result.match(/## Agent Infrastructure/g) || []).length;
    expect(count).toBe(1);

    // safe-git-allow: incremental-migration
    fs.rmSync(anotherDir, { recursive: true, force: true });
  });
});
