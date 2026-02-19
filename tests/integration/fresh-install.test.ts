/**
 * Integration test — fresh project creation via `agent-kit init <name>`.
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

describe('Fresh install: agent-kit init <project-name>', () => {
  const testBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-fresh-'));
  const projectName = 'test-agent';
  const projectDir = path.join(testBase, projectName);

  afterAll(() => {
    fs.rmSync(testBase, { recursive: true, force: true });
  });

  it('creates project directory and all required files', async () => {
    // Change cwd temporarily so init creates the project relative to testBase
    const originalCwd = process.cwd();
    process.chdir(testBase);

    try {
      await initProject({ name: projectName, port: 4444 });
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

  it('creates .agent-kit directory structure', () => {
    const stateDir = path.join(projectDir, '.agent-kit');
    expect(fs.existsSync(stateDir)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state', 'sessions'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state', 'jobs'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'relationships'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'logs'))).toBe(true);
  });

  it('creates AGENT.md with identity', () => {
    const agentMd = path.join(projectDir, '.agent-kit', 'AGENT.md');
    expect(fs.existsSync(agentMd)).toBe(true);

    const content = fs.readFileSync(agentMd, 'utf-8');
    expect(content).toContain('# Test-agent'); // Capitalized
    expect(content).toContain('Who I Am');
    expect(content).toContain('My Principles');
  });

  it('creates USER.md', () => {
    const userMd = path.join(projectDir, '.agent-kit', 'USER.md');
    expect(fs.existsSync(userMd)).toBe(true);

    const content = fs.readFileSync(userMd, 'utf-8');
    expect(content).toContain('Communication Preferences');
  });

  it('creates MEMORY.md', () => {
    const memoryMd = path.join(projectDir, '.agent-kit', 'MEMORY.md');
    expect(fs.existsSync(memoryMd)).toBe(true);

    const content = fs.readFileSync(memoryMd, 'utf-8');
    expect(content).toContain('Memory');
    expect(content).toContain('persists across sessions');
  });

  it('creates valid config.json', () => {
    const configPath = path.join(projectDir, '.agent-kit', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.projectName).toBe('test-agent');
    expect(config.port).toBe(4444);
    expect(config.authToken).toBeTruthy();
    expect(config.sessions.maxSessions).toBe(3);
    expect(config.scheduler.enabled).toBe(true); // Enabled by default for fresh
    expect(config.relationships.maxRecentInteractions).toBe(20);
  });

  it('creates jobs.json with default coherence jobs', () => {
    const jobsPath = path.join(projectDir, '.agent-kit', 'jobs.json');
    expect(fs.existsSync(jobsPath)).toBe(true);

    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    expect(jobs.length).toBe(3);

    const slugs = jobs.map((j: any) => j.slug);
    expect(slugs).toContain('health-check');
    expect(slugs).toContain('reflection-trigger');
    expect(slugs).toContain('relationship-maintenance');
  });

  it('installs behavioral hooks', () => {
    const hooksDir = path.join(projectDir, '.agent-kit', 'hooks');
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
  });

  it('creates .claude/settings.json with hook config', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
  });

  it('creates .claude/scripts/health-watchdog.sh', () => {
    const watchdogPath = path.join(projectDir, '.claude', 'scripts', 'health-watchdog.sh');
    expect(fs.existsSync(watchdogPath)).toBe(true);

    const stats = fs.statSync(watchdogPath);
    expect(stats.mode & 0o111).toBeGreaterThan(0);
  });

  it('creates .gitignore with state exclusions', () => {
    const gitignorePath = path.join(projectDir, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('.agent-kit/state/');
    expect(content).toContain('.agent-kit/logs/');
  });

  it('initializes a git repository', () => {
    const gitDir = path.join(projectDir, '.git');
    expect(fs.existsSync(gitDir)).toBe(true);
  });
});

describe('Existing project: agent-kit init (no project name)', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-existing-'));

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('adds .agent-kit/ to an existing directory without CLAUDE.md', async () => {
    // Create a minimal existing project
    fs.writeFileSync(path.join(testDir, 'index.ts'), '// existing code');

    await initProject({ dir: testDir, port: 5555 });

    // Verify .agent-kit was created
    expect(fs.existsSync(path.join(testDir, '.agent-kit', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.agent-kit', 'AGENT.md'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.agent-kit', 'USER.md'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.agent-kit', 'MEMORY.md'))).toBe(true);

    // Verify existing file wasn't touched
    const existingContent = fs.readFileSync(path.join(testDir, 'index.ts'), 'utf-8');
    expect(existingContent).toBe('// existing code');

    // Verify scheduler is disabled for existing projects (conservative default)
    const config = JSON.parse(fs.readFileSync(path.join(testDir, '.agent-kit', 'config.json'), 'utf-8'));
    expect(config.scheduler.enabled).toBe(false);
  });

  it('appends to existing CLAUDE.md without overwriting', async () => {
    const anotherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-existing2-'));
    const existingContent = '# My Project\n\nThis is my project.\n';
    fs.writeFileSync(path.join(anotherDir, 'CLAUDE.md'), existingContent);

    await initProject({ dir: anotherDir });

    const result = fs.readFileSync(path.join(anotherDir, 'CLAUDE.md'), 'utf-8');
    expect(result).toContain('# My Project');
    expect(result).toContain('This is my project.');
    expect(result).toContain('## Agent Infrastructure');

    fs.rmSync(anotherDir, { recursive: true, force: true });
  });

  it('does not re-append if already initialized', async () => {
    const anotherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-existing3-'));
    const existingContent = '# My Project\n\n## Agent Infrastructure\n\nAlready here.\n';
    fs.writeFileSync(path.join(anotherDir, 'CLAUDE.md'), existingContent);

    await initProject({ dir: anotherDir });

    const result = fs.readFileSync(path.join(anotherDir, 'CLAUDE.md'), 'utf-8');
    // Should only have one instance of Agent Infrastructure
    const count = (result.match(/## Agent Infrastructure/g) || []).length;
    expect(count).toBe(1);

    fs.rmSync(anotherDir, { recursive: true, force: true });
  });
});
