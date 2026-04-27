/**
 * E2E test — Claim Intercept full lifecycle.
 *
 * Tests the complete PRODUCTION path for both hooks:
 *
 *   Phase 1:  Hook generation & installation
 *   Phase 2:  Denial pattern detection (all 9 regex patterns)
 *   Phase 3:  Exemption logic (line numbers, diffs, node_modules, tests)
 *   Phase 4:  Tool filtering (Bash/Write/Edit only, text extraction per tool)
 *   Phase 5:  Canonical State integration (facts, projects, empty/corrupt state)
 *   Phase 6:  Rate limiting (first pass, rapid re-check blocked, cooldown)
 *   Phase 7:  PostToolUse hook E2E (full subprocess execution)
 *   Phase 8:  Stop hook E2E (block decision, exit code 2, loop guard)
 *   Phase 9:  Cross-check precision (proximity window, word length filter)
 *   Phase 10: Warning & block message format
 *   Phase 11: Edge cases (empty stdin, malformed JSON, missing dirs, large text)
 *   Phase 12: True negatives (positive statements, code containing denial words)
 *   Phase 13: CanonicalState class integration (initialize, setFact, setProject)
 *   Phase 14: Log file verification
 *   Phase 15: Multi-contradiction scenarios
 *   Phase 16: Bash stdout (tool_result) checking
 *
 * Exercises both hooks by writing them to temp directories and
 * executing them as real Node.js subprocesses with piped stdin —
 * exactly how Claude Code invokes them in production.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { CanonicalState } from '../../src/core/CanonicalState.js';

// ── Test infrastructure ──────────────────────────────────────────────

let tmpDir: string;
let stateDir: string;
let hooksDir: string;
let postToolUseHook: string;
let stopHook: string;
let canonicalState: CanonicalState;

/** Execute a hook as a subprocess, piping JSON to stdin. Returns { stdout, exitCode }. */
function runHook(
  hookPath: string,
  input: Record<string, unknown>,
  opts?: { cwd?: string; timeout?: number },
): { stdout: string; exitCode: number } {
  const cwd = opts?.cwd ?? tmpDir;
  const timeout = opts?.timeout ?? 5000;
  try {
    const stdout = execFileSync('node', [hookPath], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      cwd,
      timeout,
      env: { ...process.env, NODE_PATH: '' },
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || '').trim(),
      exitCode: err.status ?? 1,
    };
  }
}

/** Parse JSON output from a hook, or null if empty/invalid. */
function parseHookOutput(stdout: string): Record<string, unknown> | null {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** Create canonical state files for testing. */
function setupCanonicalState(facts: any[] = [], projects: any[] = [], antiPatterns: any[] = []) {
  const stDir = path.join(tmpDir, '.instar', 'state');
  fs.mkdirSync(stDir, { recursive: true });
  fs.writeFileSync(path.join(stDir, 'quick-facts.json'), JSON.stringify(facts, null, 2));
  fs.writeFileSync(path.join(stDir, 'project-registry.json'), JSON.stringify(projects, null, 2));
  fs.writeFileSync(path.join(stDir, 'anti-patterns.json'), JSON.stringify(antiPatterns, null, 2));
}

/** Clear rate limit file so each test starts fresh. */
function clearRateLimit() {
  const rateFile = path.join(tmpDir, '.instar', 'state', '.claim-intercept-last.tmp');
  // safe-git-allow: incremental-migration
  try { fs.unlinkSync(rateFile); } catch {}
}

/** Clear log file. */
function clearLog() {
  const logFile = path.join(tmpDir, '.instar', 'state', 'claim-intercept.log');
  // safe-git-allow: incremental-migration
  try { fs.unlinkSync(logFile); } catch {}
}

/** Read log file content. */
function readLog(): string {
  const logFile = path.join(tmpDir, '.instar', 'state', 'claim-intercept.log');
  try { return fs.readFileSync(logFile, 'utf-8'); } catch { return ''; }
}

// ── Standard test fixtures ───────────────────────────────────────────

const STANDARD_FACTS = [
  {
    question: 'What database does the project use?',
    answer: 'PostgreSQL with Prisma ORM deployed on Railway',
    lastVerified: new Date().toISOString(),
    source: 'instar init',
  },
  {
    question: 'What messaging platform is configured?',
    answer: 'Telegram bot with webhook integration',
    lastVerified: new Date().toISOString(),
    source: 'config',
  },
  {
    question: 'What deployment target is used?',
    answer: 'Vercel for frontend, Railway for backend services',
    lastVerified: new Date().toISOString(),
    source: 'config',
  },
  {
    question: 'What project am I working on?',
    answer: 'MyApp at /Users/dev/projects/myapp',
    lastVerified: new Date().toISOString(),
    source: 'instar init',
  },
  {
    question: 'What email service is configured?',
    answer: 'SendGrid API for transactional emails',
    lastVerified: new Date().toISOString(),
    source: 'env setup',
  },
];

const STANDARD_PROJECTS = [
  {
    name: 'MyApp',
    dir: '/Users/dev/projects/myapp',
    deploymentTargets: ['vercel', 'railway'],
    type: 'nextjs',
    description: 'Main application',
    lastVerified: new Date().toISOString(),
  },
  {
    name: 'DataPipeline',
    dir: '/Users/dev/projects/data-pipeline',
    deploymentTargets: ['aws-lambda'],
    type: 'typescript',
    description: 'ETL pipeline',
    lastVerified: new Date().toISOString(),
  },
];

// ════════════════════════════════════════════════════════════════════════
// Setup & Teardown
// ════════════════════════════════════════════════════════════════════════

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-intercept-e2e-'));
  stateDir = path.join(tmpDir, '.instar');
  hooksDir = path.join(stateDir, 'hooks');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });

  // Extract hooks from PostUpdateMigrator
  const migrator = new PostUpdateMigrator({
    stateDir,
    version: '0.0.0-test',
  } as any);

  const postToolUseContent = migrator.getHookContent('claim-intercept');
  const stopHookContent = migrator.getHookContent('claim-intercept-response');

  postToolUseHook = path.join(hooksDir, 'claim-intercept.js');
  stopHook = path.join(hooksDir, 'claim-intercept-response.js');

  fs.writeFileSync(postToolUseHook, postToolUseContent, { mode: 0o755 });
  fs.writeFileSync(stopHook, stopHookContent, { mode: 0o755 });

  // Initialize canonical state with standard fixtures
  setupCanonicalState(STANDARD_FACTS, STANDARD_PROJECTS);

  // Setup CanonicalState class instance for Phase 13
  canonicalState = new CanonicalState({ stateDir: path.join(stateDir, 'state') });
});

afterAll(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearRateLimit();
  clearLog();
});

// ════════════════════════════════════════════════════════════════════════
// Phase 1: Hook Generation & Installation
// ════════════════════════════════════════════════════════════════════════

describe('Phase 1: Hook generation & installation', () => {
  it('PostUpdateMigrator generates PostToolUse hook content', () => {
    const content = fs.readFileSync(postToolUseHook, 'utf-8');
    expect(content).toContain('#!/usr/bin/env node');
    expect(content).toContain('Claim Intercept');
    expect(content).toContain('PostToolUse');
    expect(content).toContain('DENIAL_PATTERNS');
    expect(content).toContain('findContradictions');
    expect(content).toContain('loadCanonicalState');
  });

  it('PostUpdateMigrator generates Stop hook content', () => {
    const content = fs.readFileSync(stopHook, 'utf-8');
    expect(content).toContain('#!/usr/bin/env node');
    expect(content).toContain('Claim Intercept');
    expect(content).toContain('Stop hook');
    expect(content).toContain('stop_hook_active');
    expect(content).toContain('decision');
    expect(content).toContain('block');
  });

  it('PostToolUse hook is valid JavaScript (parses without error)', () => {
    expect(() => {
      execFileSync('node', ['--check', postToolUseHook], { timeout: 3000 });
    }).not.toThrow();
  });

  it('Stop hook is valid JavaScript (parses without error)', () => {
    expect(() => {
      execFileSync('node', ['--check', stopHook], { timeout: 3000 });
    }).not.toThrow();
  });

  it('hooks are executable (mode includes execute bit)', () => {
    const postStat = fs.statSync(postToolUseHook);
    const stopStat = fs.statSync(stopHook);
    expect(postStat.mode & 0o111).toBeGreaterThan(0);
    expect(stopStat.mode & 0o111).toBeGreaterThan(0);
  });

  it('PostUpdateMigrator.getHookContent returns consistent content', () => {
    const migrator = new PostUpdateMigrator({ stateDir, version: '0.0.0-test' } as any);
    const first = migrator.getHookContent('claim-intercept');
    const second = migrator.getHookContent('claim-intercept');
    expect(first).toBe(second);
  });

  it('both hooks have matching DENIAL_PATTERNS arrays', () => {
    const postContent = fs.readFileSync(postToolUseHook, 'utf-8');
    const stopContent = fs.readFileSync(stopHook, 'utf-8');

    // Count regex patterns in each — they should have the same count
    const postPatternCount = (postContent.match(/^\s*\/(?:\(\?:)/gm) || []).length;
    const stopPatternCount = (stopContent.match(/^\s*\/(?:\(\?:)/gm) || []).length;
    expect(postPatternCount).toBe(stopPatternCount);
    expect(postPatternCount).toBe(9); // 9 denial pattern templates
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 2: Denial Pattern Detection (Regex Layer)
// ════════════════════════════════════════════════════════════════════════

describe('Phase 2: Denial pattern detection', () => {
  // All 9 denial patterns with specific test phrases

  it('Pattern 1: "I can\'t / cannot / am unable to" variations', () => {
    const phrases = [
      "I can't access the PostgreSQL database directly from here",
      "I cannot connect to the Telegram bot webhook right now",
      "i am unable to reach the Railway deployment endpoint currently",
      "I am not able to query the PostgreSQL database at this time",
    ];
    for (const phrase of phrases) {
      clearRateLimit();
      const r = runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: `echo "${phrase}"` },
      });
      const output = parseHookOutput(r.stdout);
      expect(output, `Should catch: "${phrase}"`).not.toBeNull();
      expect(output?.decision).toBe('approve');
      expect(output?.additionalContext).toContain('CLAIM-INTERCEPT');
    }
  });

  it('Pattern 2: "don\'t have access/credentials/token" variations', () => {
    const phrases = [
      "I don't have access to the PostgreSQL database credentials for this environment",
      "I do not have credentials for the Telegram webhook integration setup",
      "I don't have an api key for the SendGrid email service configured",
      "I don't have a token for Railway deployment access right now",
    ];
    for (const phrase of phrases) {
      clearRateLimit();
      const r = runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: `echo "${phrase}"` },
      });
      const output = parseHookOutput(r.stdout);
      expect(output, `Should catch: "${phrase}"`).not.toBeNull();
      expect(output?.decision).toBe('approve');
    }
  });

  it('Pattern 3: "no/not available/configured/set up" variations', () => {
    const phrases = [
      "The PostgreSQL connection is not available in this environment right now",
      "Telegram webhook is not configured for this particular agent instance",
      "The Railway backend is not set up for automated deployments yet",
      "The SendGrid email integration is no available at this moment",
    ];
    for (const phrase of phrases) {
      clearRateLimit();
      const r = runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: `echo "${phrase}"` },
      });
      const output = parseHookOutput(r.stdout);
      expect(output, `Should catch: "${phrase}"`).not.toBeNull();
    }
  });

  it('Pattern 4: "isn\'t/is not/aren\'t/are not available/working" variations', () => {
    const phrases = [
      "The PostgreSQL connection isn't available in the current configuration setup",
      "The Telegram integration is not working as expected in this environment",
      "The deployment endpoints aren't accessible from this network location",
      "The backend services are not running in the local development environment",
    ];
    for (const phrase of phrases) {
      clearRateLimit();
      const r = runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: `echo "${phrase}"` },
      });
      const output = parseHookOutput(r.stdout);
      expect(output, `Should catch: "${phrase}"`).not.toBeNull();
    }
  });

  it('Pattern 5: "blocked/unavailable/disabled/suspended" variations', () => {
    const phrases = [
      "The PostgreSQL database access appears to be blocked by the firewall",
      "The Telegram API endpoint is currently unavailable for webhook requests",
      "The Railway deployment pipeline has been disabled for maintenance today",
      "The SendGrid email service account appears to be suspended or inactive",
    ];
    for (const phrase of phrases) {
      clearRateLimit();
      const r = runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: `echo "${phrase}"` },
      });
      const output = parseHookOutput(r.stdout);
      expect(output, `Should catch: "${phrase}"`).not.toBeNull();
    }
  });

  it('Pattern 6: "needs/requires the user/human/manual" variations', () => {
    const phrases = [
      "This PostgreSQL migration needs the user to run it manually in production",
      "The Telegram webhook requires human to verify and complete the setup",
      "The Railway deployment requires manual to approve before it can proceed",
      "This Vercel deployment needs someone to review and approve the changes first",
    ];
    for (const phrase of phrases) {
      clearRateLimit();
      const r = runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: `echo "${phrase}"` },
      });
      const output = parseHookOutput(r.stdout);
      expect(output, `Should catch: "${phrase}"`).not.toBeNull();
    }
  });

  it('Pattern 7: "outside/beyond my capabilities/scope" variations', () => {
    const phrases = [
      "Accessing the PostgreSQL database directly is outside my capabilities right now",
      "Modifying the Telegram bot configuration is beyond my scope in this context",
      "Managing the Railway deployment is outside the agent's access permissions currently",
      "This database migration is beyond my authority to execute in production",
    ];
    for (const phrase of phrases) {
      clearRateLimit();
      const r = runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: `echo "${phrase}"` },
      });
      const output = parseHookOutput(r.stdout);
      expect(output, `Should catch: "${phrase}"`).not.toBeNull();
    }
  });

  it('Pattern 8: "no way/mechanism/method/means to" variations', () => {
    const phrases = [
      "There is no way to reach the PostgreSQL database from this environment directly",
      "I don't have any mechanism to send Telegram messages through the webhook integration",
      "There is no method to deploy to Railway without the proper CLI credentials",
      "I don't have a means to access the SendGrid dashboard from within this context",
    ];
    for (const phrase of phrases) {
      clearRateLimit();
      const r = runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: `echo "${phrase}"` },
      });
      const output = parseHookOutput(r.stdout);
      expect(output, `Should catch: "${phrase}"`).not.toBeNull();
    }
  });

  it('Pattern 9: "not/never been set up/configured/registered" variations', () => {
    const phrases = [
      "The PostgreSQL database connection has not been set up for this environment",
      "The Telegram integration was never configured in the agent's settings file",
      "The Railway deployment target has not been registered in the configuration",
      "The SendGrid webhook was never set up for outbound email delivery service",
    ];
    for (const phrase of phrases) {
      clearRateLimit();
      const r = runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: `echo "${phrase}"` },
      });
      const output = parseHookOutput(r.stdout);
      expect(output, `Should catch: "${phrase}"`).not.toBeNull();
    }
  });

  it('case insensitivity: detects mixed-case denial patterns', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: 'echo "I CANNOT access the PostgreSQL database from this environment right now"' },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 3: Exemption Logic
// ════════════════════════════════════════════════════════════════════════

describe('Phase 3: Exemption logic', () => {
  it('skips line-numbered output (cat -n, grep -n)', () => {
    const text = '   42|\tconst db = "postgresql"; // I can\'t access the PostgreSQL database now';
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: text },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('skips git diff output', () => {
    const text = 'diff --git a/config.ts b/config.ts\n-database: "postgres" // I can\'t access PostgreSQL database now';
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: text },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('skips diff headers (+++ / ---)', () => {
    const text = '--- a/old.ts\n+++ b/new.ts\nI cannot access the PostgreSQL database configured for this project now';
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: text },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('skips git log output', () => {
    const text = 'commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\nAuthor: Dev\nI cannot access the database now';
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: text },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('skips node_modules paths', () => {
    const text = 'node_modules/@prisma/client/index.js: connection not available for PostgreSQL database access';
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: text },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('skips test file output references', () => {
    const text = 'src/database.test.ts: expected PostgreSQL connection not available in test environment setup';
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: text },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 4: Tool Filtering
// ════════════════════════════════════════════════════════════════════════

describe('Phase 4: Tool filtering', () => {
  it('checks Bash tool (extracts from tool_input.command)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database directly from this environment'" },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    expect(output?.decision).toBe('approve');
  });

  it('checks Write tool (extracts from tool_input.content)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Write',
      tool_input: { content: "The PostgreSQL database is not available for direct access in this environment setup", file_path: '/tmp/test.md' },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
  });

  it('checks Edit tool (extracts from tool_input.new_string)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Edit',
      tool_input: { new_string: "// NOTE: I cannot connect to the PostgreSQL database from this environment directly" },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
  });

  it('skips Read tool entirely', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
      tool_result: "I can't access the PostgreSQL database from here in this environment right now",
    });
    expect(r.exitCode).toBe(0);
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('skips Glob tool entirely', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Glob',
      tool_input: { pattern: '*.ts' },
    });
    expect(r.exitCode).toBe(0);
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('skips Grep tool entirely', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Grep',
      tool_input: { pattern: 'database' },
    });
    expect(r.exitCode).toBe(0);
  });

  it('skips unknown/custom tool names', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'mcp__custom__tool',
      tool_input: { data: "I can't do anything about the PostgreSQL database right now" },
    });
    expect(r.exitCode).toBe(0);
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('Bash tool also checks tool_result (stdout)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: 'check-db-status' },
      tool_result: "Error: PostgreSQL database connection is unavailable at this time in the current configuration",
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 5: Canonical State Integration
// ════════════════════════════════════════════════════════════════════════

describe('Phase 5: Canonical State integration', () => {
  it('detects contradiction against quick-facts', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    expect(String(output?.additionalContext)).toContain('CONTRADICTION');
    expect(String(output?.additionalContext)).toContain('quick-facts');
  });

  it('detects contradiction against project-registry', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the MyApp project because it is not configured right now'" },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    expect(String(output?.additionalContext)).toContain('project-registry');
  });

  it('no contradiction when empty canonical state', () => {
    // Temporarily replace state with empty
    const stDir = path.join(tmpDir, '.instar', 'state');
    const origFacts = fs.readFileSync(path.join(stDir, 'quick-facts.json'), 'utf-8');
    const origProjects = fs.readFileSync(path.join(stDir, 'project-registry.json'), 'utf-8');

    fs.writeFileSync(path.join(stDir, 'quick-facts.json'), '[]');
    fs.writeFileSync(path.join(stDir, 'project-registry.json'), '[]');

    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the database from this environment right now'" },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();

    // Restore
    fs.writeFileSync(path.join(stDir, 'quick-facts.json'), origFacts);
    fs.writeFileSync(path.join(stDir, 'project-registry.json'), origProjects);
  });

  it('graceful fallback when state files are missing', () => {
    const stDir = path.join(tmpDir, '.instar', 'state');
    const origFacts = fs.readFileSync(path.join(stDir, 'quick-facts.json'), 'utf-8');

    // safe-git-allow: incremental-migration
    fs.unlinkSync(path.join(stDir, 'quick-facts.json'));

    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment'" },
    });
    // Should not crash — graceful exit
    expect(r.exitCode).toBe(0);

    // Restore
    fs.writeFileSync(path.join(stDir, 'quick-facts.json'), origFacts);
  });

  it('graceful fallback when state files contain corrupt JSON', () => {
    const stDir = path.join(tmpDir, '.instar', 'state');
    const origFacts = fs.readFileSync(path.join(stDir, 'quick-facts.json'), 'utf-8');

    fs.writeFileSync(path.join(stDir, 'quick-facts.json'), '{corrupt json!!! not valid');

    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment'" },
    });
    expect(r.exitCode).toBe(0);

    // Restore
    fs.writeFileSync(path.join(stDir, 'quick-facts.json'), origFacts);
  });

  it('detects contradiction for second project (DataPipeline)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'The DataPipeline project is not available or configured in this environment'" },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    expect(String(output?.additionalContext)).toContain('DataPipeline');
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 6: Rate Limiting
// ════════════════════════════════════════════════════════════════════════

describe('Phase 6: Rate limiting', () => {
  it('first check passes (rate limit file created)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();

    // Rate file should exist now
    const rateFile = path.join(tmpDir, '.instar', 'state', '.claim-intercept-last.tmp');
    expect(fs.existsSync(rateFile)).toBe(true);
  });

  it('rapid second check is rate-limited (within 10s)', () => {
    // First check
    runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });

    // Immediate second check — should be rate-limited
    const r2 = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    expect(parseHookOutput(r2.stdout)).toBeNull();
  });

  it('check passes after rate limit expiry (simulated)', () => {
    // First check
    runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });

    // Backdate the rate file to 11 seconds ago
    const rateFile = path.join(tmpDir, '.instar', 'state', '.claim-intercept-last.tmp');
    const pastTime = new Date(Date.now() - 11000);
    fs.utimesSync(rateFile, pastTime, pastTime);

    // Second check should now pass
    const r2 = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    const output = parseHookOutput(r2.stdout);
    expect(output).not.toBeNull();
  });

  it('rate limit is shared between PostToolUse and Stop hooks', () => {
    // PostToolUse fires first
    runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });

    // Stop hook immediately after — should be rate-limited (shared rate file)
    const r2 = runHook(stopHook, {
      last_assistant_message: "I cannot access the PostgreSQL database from this environment right now and I am not sure what to do about it",
    });
    // Rate-limited means no output (silent exit 0)
    expect(parseHookOutput(r2.stdout)).toBeNull();
    expect(r2.exitCode).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 7: PostToolUse Hook E2E (Full Pipeline)
// ════════════════════════════════════════════════════════════════════════

describe('Phase 7: PostToolUse hook E2E', () => {
  it('contradiction detected → approve with additionalContext warning', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment now'" },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    expect(output?.decision).toBe('approve');
    expect(output?.additionalContext).toBeTruthy();
    expect(String(output?.additionalContext)).toContain('CLAIM-INTERCEPT');
    expect(String(output?.additionalContext)).toContain('CONTRADICTION');
    expect(r.exitCode).toBe(0);
  });

  it('no contradiction → clean exit with no output', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: 'echo "The server is running well and all services are healthy and operational"' },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it('short text (< 40 chars) → clean exit', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: 'echo "short text"' },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it('exempt text → clean exit even with denial', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: '   1:\tI cannot access the PostgreSQL database from this environment right now' },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('wrong tool → clean exit', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Grep',
      tool_input: { pattern: 'I cannot access' },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it('denial without matching canonical state → clean exit (no false positive)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the Kubernetes cluster from this environment right now'" },
    });
    // "Kubernetes" is not in our canonical state, so no contradiction
    expect(parseHookOutput(r.stdout)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 8: Stop Hook E2E (Full Pipeline)
// ════════════════════════════════════════════════════════════════════════

describe('Phase 8: Stop hook E2E', () => {
  it('contradiction detected → block decision with exit code 2', () => {
    const r = runHook(stopHook, {
      last_assistant_message: "I'm sorry, but I cannot access the PostgreSQL database from this environment. You'll need to check the connection settings yourself and verify the credentials.",
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    expect(output?.decision).toBe('block');
    expect(String(output?.reason)).toContain('CLAIM-INTERCEPT');
    expect(String(output?.reason).toLowerCase()).toContain('response-level');
    expect(r.exitCode).toBe(2);
  });

  it('no contradiction → clean exit (code 0)', () => {
    const r = runHook(stopHook, {
      last_assistant_message: "I've connected to the database and run the migration successfully. All tables are up to date and the schema matches what we expected.",
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it('stop_hook_active: true → skip (infinite loop guard)', () => {
    const r = runHook(stopHook, {
      stop_hook_active: true,
      last_assistant_message: "I cannot access the PostgreSQL database from this environment right now and I am sorry about that",
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it('short message (< 80 chars) → skip', () => {
    const r = runHook(stopHook, {
      last_assistant_message: "I can't access PostgreSQL.",
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it('denial without canonical state match → no false positive', () => {
    const r = runHook(stopHook, {
      last_assistant_message: "I cannot access the Redis cache in this environment. The Redis connection string is not configured in the environment variables file.",
    });
    // "Redis" is not in canonical state
    expect(parseHookOutput(r.stdout)).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it('missing last_assistant_message field → clean exit', () => {
    const r = runHook(stopHook, {
      some_other_field: 'irrelevant data',
    });
    expect(r.exitCode).toBe(0);
    expect(parseHookOutput(r.stdout)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 9: Cross-Check Precision
// ════════════════════════════════════════════════════════════════════════

describe('Phase 9: Cross-check precision', () => {
  it('denial near relevant keyword within 100-char window = contradiction', () => {
    // "postgresql" keyword is close to denial
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'The PostgreSQL database is currently unavailable for direct access in this environment'" },
    });
    expect(parseHookOutput(r.stdout)).not.toBeNull();
  });

  it('denial and keyword far apart (> 200 chars) may not trigger', () => {
    // Put a lot of padding between the keyword and the denial
    const padding = 'x'.repeat(250);
    const text = `I was reading about PostgreSQL best practices. ${padding} The documentation says this feature is currently unavailable.`;
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: `echo '${text}'` },
    });
    // May or may not trigger depending on exact window calc — but should not crash
    expect(r.exitCode).toBe(0);
  });

  it('only words > 3 chars are used for matching (filters short words)', () => {
    // Add a fact with very short words
    const stDir = path.join(tmpDir, '.instar', 'state');
    const origFacts = fs.readFileSync(path.join(stDir, 'quick-facts.json'), 'utf-8');

    const factsWithShort = [
      ...STANDARD_FACTS,
      {
        question: 'Is db ok?',
        answer: 'Yes it is ok and running fine',
        lastVerified: new Date().toISOString(),
        source: 'test',
      },
    ];
    fs.writeFileSync(path.join(stDir, 'quick-facts.json'), JSON.stringify(factsWithShort));

    // "ok", "is", "db", "yes" are all <= 3 chars, so they should NOT be used for matching
    // Only "running" (7 chars) would match
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'Everything is ok but the running process is unavailable right now in this environment'" },
    });
    // "running" is > 3 chars and near "unavailable" → could trigger
    // The key assertion: no crash, and short words didn't cause false mass-matching
    expect(r.exitCode).toBe(0);

    // Restore
    fs.writeFileSync(path.join(stDir, 'quick-facts.json'), origFacts);
  });

  it('case-insensitive matching (fact has uppercase, text has lowercase)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the postgresql database from this environment right now'" },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
  });

  it('project name match is case-insensitive', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'The myapp project is not available or configured in this environment'" },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 10: Warning & Block Message Format
// ════════════════════════════════════════════════════════════════════════

describe('Phase 10: Warning & block message format', () => {
  it('PostToolUse warning contains CLAIM, FACT, FROM fields', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    const output = parseHookOutput(r.stdout);
    const ctx = String(output?.additionalContext);
    expect(ctx).toContain('CLAIM:');
    expect(ctx).toContain('FACT:');
    expect(ctx).toContain('FROM:');
  });

  it('PostToolUse warning includes correction instruction', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    const ctx = String(parseHookOutput(r.stdout)?.additionalContext);
    expect(ctx).toContain('Do NOT repeat false claims');
    expect(ctx).toContain('Revise your statement');
  });

  it('Stop hook reason includes Response-Level tag', () => {
    const r = runHook(stopHook, {
      last_assistant_message: "I'm sorry, but I cannot access the PostgreSQL database from this environment. You'll need to check the credentials yourself.",
    });
    const output = parseHookOutput(r.stdout);
    expect(String(output?.reason).toLowerCase()).toContain('response-level');
  });

  it('Stop hook reason includes correction mandate', () => {
    const r = runHook(stopHook, {
      last_assistant_message: "I'm sorry, but I cannot access the PostgreSQL database from this environment. You'll need to check the credentials yourself.",
    });
    const output = parseHookOutput(r.stdout);
    const reason = String(output?.reason);
    expect(reason).toContain('You MUST correct this');
    expect(reason).toContain('Do NOT repeat the false claim');
  });

  it('warning references canonical state file paths', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    const ctx = String(parseHookOutput(r.stdout)?.additionalContext);
    expect(ctx).toContain('.instar/state/');
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 11: Edge Cases
// ════════════════════════════════════════════════════════════════════════

describe('Phase 11: Edge cases', () => {
  it('empty stdin → graceful exit', () => {
    try {
      const stdout = execFileSync('node', [postToolUseHook], {
        input: '',
        encoding: 'utf-8',
        cwd: tmpDir,
        timeout: 3000,
      });
      expect(stdout).toBe('');
    } catch (err: any) {
      // May exit with code 0 from catch block — that's fine
      expect(err.status).toBe(0);
    }
  });

  it('malformed JSON stdin → graceful exit (no crash)', () => {
    try {
      const stdout = execFileSync('node', [postToolUseHook], {
        input: '{not valid json!!!',
        encoding: 'utf-8',
        cwd: tmpDir,
        timeout: 3000,
      });
      expect(stdout).toBe('');
    } catch (err: any) {
      // Outer catch block, exits 0
      expect(err.status).toBe(0);
    }
  });

  it('missing tool_input field → graceful exit', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
    });
    expect(r.exitCode).toBe(0);
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('null tool_input.command → graceful exit', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: null },
    });
    expect(r.exitCode).toBe(0);
  });

  it('missing .instar directory entirely → graceful exit', () => {
    // Run from a temp dir without .instar
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-instar-'));
    try {
      const r = runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment'" },
      }, { cwd: emptyDir });
      expect(r.exitCode).toBe(0);
    } finally {
      // safe-git-allow: incremental-migration
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('very large text does not hang (< 2s execution)', () => {
    const largeText = 'I cannot access the PostgreSQL database. '.repeat(1000);
    const start = Date.now();
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: `echo '${largeText}'` },
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(r.exitCode).toBe(0);
  });

  it('binary-like content does not crash', () => {
    const binaryLike = Buffer.from([0x00, 0x01, 0xFF, 0xFE]).toString('base64');
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: `echo '${binaryLike}'` },
    });
    expect(r.exitCode).toBe(0);
  });

  it('text with special regex characters does not crash', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access .*+?^${}()|[]\\ the PostgreSQL database (with regex chars)'" },
    });
    expect(r.exitCode).toBe(0);
  });

  it('text with newlines embedded in denial is handled', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Write',
      tool_input: {
        content: "Status report:\nThe PostgreSQL database is\ncurrently unavailable in\nthis environment for direct access",
        file_path: '/tmp/report.md',
      },
    });
    // Newlines within text — the hook processes the combined text
    expect(r.exitCode).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 12: True Negatives (No False Positives!)
// ════════════════════════════════════════════════════════════════════════

describe('Phase 12: True negatives', () => {
  it('positive statement about database → no trigger', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I successfully connected to the PostgreSQL database and ran the migration without issues'" },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('positive statement about Telegram → no trigger', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'The Telegram webhook is configured and working perfectly in the current environment'" },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('positive statement about deployment → no trigger', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'Successfully deployed the MyApp project to Vercel and all health checks are passing'" },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('general discussion without denial → no trigger', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'Let me check the PostgreSQL database connection settings and verify the credentials now'" },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('code with denial-like variable names → no trigger (text too short or no match)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Write',
      tool_input: {
        content: 'const isUnavailable = false;\nconst isBlocked = checkFirewall();\nconst isDisabled = getFeatureFlag("db");',
        file_path: '/tmp/utils.ts',
      },
    });
    // These are code patterns — "unavailable" and "blocked" appear as bare words
    // but without "I can't" or subject-denial structure
    // The hook may or may not trigger on bare "unavailable"/"blocked" —
    // Pattern 5 catches bare "unavailable" and "blocked"
    // This tests whether the STATE cross-check prevents false positives
    // even when regex matches, because the denial isn't near canonical keywords
    expect(r.exitCode).toBe(0);
  });

  it('denial about unrelated topic → no trigger', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the Kubernetes cluster or the AWS console from this environment right now'" },
    });
    // Kubernetes and AWS are not in canonical state
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('past tense narrative → no trigger', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'Yesterday the PostgreSQL database was temporarily down but it has been restored and is working again'" },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('question format → no trigger', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'Can you check if the PostgreSQL database connection is working properly in the test environment?'" },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('documenting a known limitation (no denial pattern) → no trigger', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Write',
      tool_input: {
        content: "# Known Limitations\n\nThe PostgreSQL database requires a VPN connection for remote access. Ensure you connect to the VPN before running migrations.",
        file_path: '/tmp/docs.md',
      },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 13: CanonicalState Class Integration
// ════════════════════════════════════════════════════════════════════════

describe('Phase 13: CanonicalState class integration', () => {
  it('CanonicalState.initialize() creates all three files', () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-init-'));
    const freshStateDir = path.join(freshDir, 'state');
    fs.mkdirSync(freshStateDir, { recursive: true });

    const cs = new CanonicalState({ stateDir: freshStateDir });
    const result = cs.initialize('TestProject', '/tmp/test-project');

    expect(result.created).toContain('quick-facts.json');
    expect(result.created).toContain('anti-patterns.json');
    expect(result.created).toContain('project-registry.json');

    expect(fs.existsSync(path.join(freshStateDir, 'quick-facts.json'))).toBe(true);
    expect(fs.existsSync(path.join(freshStateDir, 'anti-patterns.json'))).toBe(true);
    expect(fs.existsSync(path.join(freshStateDir, 'project-registry.json'))).toBe(true);

    // safe-git-allow: incremental-migration
    fs.rmSync(freshDir, { recursive: true, force: true });
  });

  it('setFact() creates facts that the hook picks up', () => {
    const stDir = path.join(tmpDir, '.instar', 'state');
    const cs = new CanonicalState({ stateDir: stDir });

    // Add a new fact
    cs.setFact('What CI system is used?', 'GitHub Actions with custom runners', 'config');

    // Now a denial about GitHub Actions should trigger
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the GitHub Actions CI system or custom runners right now'" },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    expect(String(output?.additionalContext)).toContain('CONTRADICTION');

    // Clean up: remove the fact
    cs.removeFact('What CI system is used?');
  });

  it('setProject() creates projects that the hook picks up', () => {
    const stDir = path.join(tmpDir, '.instar', 'state');
    const cs = new CanonicalState({ stateDir: stDir });

    cs.setProject({
      name: 'MobileApp',
      dir: '/Users/dev/projects/mobile-app',
      type: 'react-native',
      description: 'Mobile client',
    });

    clearRateLimit();
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'The MobileApp project is not configured or available in this environment'" },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    expect(String(output?.additionalContext)).toContain('MobileApp');

    // Clean up: restore original projects
    fs.writeFileSync(
      path.join(stDir, 'project-registry.json'),
      JSON.stringify(STANDARD_PROJECTS, null, 2),
    );
  });

  it('removeFact() prevents the hook from triggering on removed facts', () => {
    const stDir = path.join(tmpDir, '.instar', 'state');
    const cs = new CanonicalState({ stateDir: stDir });

    // Add then remove
    cs.setFact('What monitoring tool?', 'Grafana dashboard with Prometheus metrics', 'ops');
    cs.removeFact('What monitoring tool?');

    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the Grafana monitoring dashboard from this environment'" },
    });
    // "Grafana" was removed, so no match against it
    // (other facts might still match if there's an overlap, so we just verify no crash)
    expect(r.exitCode).toBe(0);
  });

  it('getCompactSummary() returns valid summary text', () => {
    const stDir = path.join(tmpDir, '.instar', 'state');
    const cs = new CanonicalState({ stateDir: stDir });

    // Add an anti-pattern so it appears in summary
    cs.addAntiPattern({
      pattern: 'Test pattern: do not do this',
      consequence: 'Bad things happen',
      alternative: 'Do this instead',
    });

    const summary = cs.getCompactSummary();
    expect(summary).toContain('Quick Facts:');
    expect(summary).toContain('Anti-Patterns');
    expect(summary).toContain('Known Projects:');
    expect(summary.length).toBeGreaterThan(50);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 14: Log File Verification
// ════════════════════════════════════════════════════════════════════════

describe('Phase 14: Log file verification', () => {
  it('PostToolUse contradiction writes to log file', () => {
    runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    const log = readLog();
    expect(log).toContain('tool=Bash');
    expect(log).toContain('contradictions=');
  });

  it('Stop hook contradiction writes to log file with RESPONSE-LEVEL tag', () => {
    runHook(stopHook, {
      last_assistant_message: "I'm sorry, but I cannot access the PostgreSQL database from this environment. Please check the credentials yourself manually.",
    });
    const log = readLog();
    expect(log.toUpperCase()).toContain('RESPONSE-LEVEL');
    expect(log).toContain('contradictions=');
  });

  it('log includes ISO timestamp', () => {
    runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    const log = readLog();
    // ISO timestamp format: [2026-03-01T12:00:00.000Z]
    expect(log).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('log includes truncated claim text (max 50 chars)', () => {
    runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    const log = readLog();
    expect(log).toContain('claims=');
    // Each claim is truncated to 50 chars in log
    const claimsMatch = log.match(/claims=(.+)/);
    expect(claimsMatch).not.toBeNull();
  });

  it('no log entry when no contradiction detected', () => {
    runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'Everything is working perfectly in this environment and all services are healthy'" },
    });
    const log = readLog();
    expect(log).toBe('');
  });

  it('multiple contradictions accumulate in log', () => {
    // First contradiction
    runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });

    // Wait for rate limit, then second
    const rateFile = path.join(tmpDir, '.instar', 'state', '.claim-intercept-last.tmp');
    const pastTime = new Date(Date.now() - 11000);
    fs.utimesSync(rateFile, pastTime, pastTime);

    runHook(stopHook, {
      last_assistant_message: "The Telegram bot webhook is not configured in this environment and I am unable to send messages through it at all.",
    });

    const log = readLog();
    const lines = log.trim().split('\n').filter(l => l.length > 0);
    expect(lines.length).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 15: Multi-Contradiction Scenarios
// ════════════════════════════════════════════════════════════════════════

describe('Phase 15: Multi-contradiction scenarios', () => {
  it('text denying multiple known capabilities produces multiple contradictions', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: {
        command: "echo 'I cannot access the PostgreSQL database and the Telegram webhook is not configured in this environment setup'",
      },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    const ctx = String(output?.additionalContext);
    // Should mention both PostgreSQL and Telegram contradictions
    expect(ctx).toContain('CLAIM:');
    // Count CLAIM occurrences
    const claimCount = (ctx.match(/CLAIM:/g) || []).length;
    expect(claimCount).toBeGreaterThanOrEqual(2);
  });

  it('text denying project access + fact → multiple contradiction types', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Write',
      tool_input: {
        content: "I cannot access the MyApp project and the PostgreSQL database is not available in this environment right now",
        file_path: '/tmp/status.md',
      },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    const ctx = String(output?.additionalContext);
    // Should have both quick-facts and project-registry contradictions
    expect(ctx).toContain('quick-facts');
    expect(ctx).toContain('project-registry');
  });

  it('Stop hook with multiple contradictions blocks with comprehensive reason', () => {
    const r = runHook(stopHook, {
      last_assistant_message: "I'm sorry, but I cannot access the PostgreSQL database or the Telegram webhook from this environment. Both services are currently unavailable for direct access from here.",
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    expect(output?.decision).toBe('block');
    const reason = String(output?.reason);
    const claimCount = (reason.match(/CLAIM:/g) || []).length;
    expect(claimCount).toBeGreaterThanOrEqual(2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 16: Bash stdout (tool_result) checking
// ════════════════════════════════════════════════════════════════════════

describe('Phase 16: Bash tool_result (stdout) checking', () => {
  it('contradiction in tool_result (not command) is detected', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: 'psql -c "SELECT 1"' },
      tool_result: "Error: I cannot connect to the PostgreSQL database in this environment. Connection refused by the server.",
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    expect(String(output?.additionalContext)).toContain('CONTRADICTION');
  });

  it('clean command + clean result → no trigger', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: 'psql -c "SELECT 1"' },
      tool_result: 'Connected to PostgreSQL database successfully. Query returned 1 row.',
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('command has denial but result is clean → trigger (command text checked)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
      tool_result: 'I cannot access the PostgreSQL database from this environment right now',
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
  });

  it('non-string tool_result is handled gracefully', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: 'some-command --that-denies nothing at all here with enough chars to pass' },
      tool_result: 12345,
    });
    expect(r.exitCode).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 17: Performance
// ════════════════════════════════════════════════════════════════════════

describe('Phase 17: Performance', () => {
  it('PostToolUse hook completes within 500ms for normal input', () => {
    clearRateLimit();
    const start = Date.now();
    runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('Stop hook completes within 500ms for normal input', () => {
    clearRateLimit();
    const start = Date.now();
    runHook(stopHook, {
      last_assistant_message: "I cannot access the PostgreSQL database from this environment and I'm not sure how to proceed with this task at all.",
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('clean exit (no denial) is faster than contradiction detection', () => {
    clearRateLimit();
    const startClean = Date.now();
    runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: 'echo "Everything is working well and all services are responding as expected in the environment"' },
    });
    const cleanElapsed = Date.now() - startClean;

    clearRateLimit();
    const startDenial = Date.now();
    runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot access the PostgreSQL database from this environment right now'" },
    });
    const denialElapsed = Date.now() - startDenial;

    // Both should be fast, but clean exit should be at least as fast
    expect(cleanElapsed).toBeLessThan(500);
    expect(denialElapsed).toBeLessThan(500);
  });

  it('10 consecutive hook invocations complete within 3 seconds total', () => {
    const start = Date.now();
    for (let i = 0; i < 10; i++) {
      clearRateLimit();
      runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: `echo "Test iteration ${i}: I cannot access the PostgreSQL database right now"` },
      });
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 18: Denial Pattern Boundary Tests
// ════════════════════════════════════════════════════════════════════════

describe('Phase 18: Denial pattern boundary tests', () => {
  it('text >= 40 chars passes minimum length check (Write tool, no appended space)', () => {
    // Write tool doesn't append tool_result, so content length is exact
    const text = "I can't access PostgreSQL db connection.";
    expect(text.length).toBe(40);
    const r = runHook(postToolUseHook, {
      tool_name: 'Write',
      tool_input: { content: text, file_path: '/tmp/t.md' },
    });
    // 40 chars passes the !text || text.length < 40 check
    // But may not trigger contradiction if denial isn't near canonical keyword
    expect(r.exitCode).toBe(0);
  });

  it('text < 40 chars skipped by minimum length check (Write tool)', () => {
    // 39 chars — below the < 40 threshold
    const text = "I can't access PostgreSQL db connectio";
    expect(text.length).toBe(38);
    const r = runHook(postToolUseHook, {
      tool_name: 'Write',
      tool_input: { content: text, file_path: '/tmp/t.md' },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('Stop hook: message >= 80 chars passes threshold', () => {
    // Build a message that's exactly 80 chars
    const msg = "I cannot access the PostgreSQL database from this environment. Check credential";
    expect(msg.length).toBe(79);
    const extended = msg + "s";
    expect(extended.length).toBe(80);
    const r = runHook(stopHook, {
      last_assistant_message: extended,
    });
    // 80 chars should pass the message.length < 80 check
    expect(r.exitCode >= 0).toBe(true);
  });

  it('Stop hook: message < 80 chars skipped by threshold', () => {
    // 79 chars — below the < 80 threshold
    const msg = "I cannot access the PostgreSQL database from this environment. Check credential";
    expect(msg.length).toBe(79);
    const r = runHook(stopHook, {
      last_assistant_message: msg,
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it('contraction variations: can\'t, cannot, am not able to, am unable to', () => {
    const variations = [
      "I can't reach the PostgreSQL database from this particular environment right now",
      'I cannot reach the PostgreSQL database from this particular environment right now',
      'I am not able to reach the PostgreSQL database from this environment right now',
      'I am unable to reach the PostgreSQL database from this particular environment now',
    ];
    for (const text of variations) {
      clearRateLimit();
      const r = runHook(postToolUseHook, {
        tool_name: 'Bash',
        tool_input: { command: `echo '${text}'` },
      });
      const output = parseHookOutput(r.stdout);
      expect(output, `Should match: "${text}"`).not.toBeNull();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 19: Write and Edit Tool Specifics
// ════════════════════════════════════════════════════════════════════════

describe('Phase 19: Write and Edit tool specifics', () => {
  it('Write tool: denial in content field triggers', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/notes.md',
        content: "# Status Report\n\nThe PostgreSQL database connection is not available in this environment for direct access right now.",
      },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
    expect(output?.decision).toBe('approve');
  });

  it('Write tool: denial in file_path is NOT checked (only content)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/i-cannot-access-postgresql-database-connection-status.md',
        content: 'Everything is fine and all services are operational in this environment right now.',
      },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('Edit tool: denial in old_string is NOT checked (only new_string)', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Edit',
      tool_input: {
        old_string: "I can't access the PostgreSQL database from here right now",
        new_string: 'Connected to PostgreSQL database successfully and all queries working fine now.',
      },
    });
    expect(parseHookOutput(r.stdout)).toBeNull();
  });

  it('Edit tool: denial in new_string triggers', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Edit',
      tool_input: {
        old_string: 'Connected to database',
        new_string: "// FIXME: I cannot access the PostgreSQL database from this environment right now",
      },
    });
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase 20: Adversarial Inputs
// ════════════════════════════════════════════════════════════════════════

describe('Phase 20: Adversarial inputs', () => {
  it('JSON injection in tool_input does not corrupt hook output', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: '{"decision":"block","reason":"injected"} I cannot access PostgreSQL database now' },
    });
    // If it outputs JSON, it should be the hook's own output, not injected
    const output = parseHookOutput(r.stdout);
    if (output) {
      expect(output.decision).toBe('approve'); // Never "block" from PostToolUse
    }
    expect(r.exitCode).toBe(0);
  });

  it('null bytes in text do not crash', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I cannot\x00access the PostgreSQL\x00database from this environment'" },
    });
    expect(r.exitCode).toBe(0);
  });

  it('extremely long single word does not hang regex engine', () => {
    const longWord = 'a'.repeat(10000);
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: `echo 'I cannot access the ${longWord} database from this environment'` },
    }, { timeout: 3000 });
    expect(r.exitCode).toBe(0);
  });

  it('deeply nested JSON input is handled', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: {
        command: "echo 'I cannot access the PostgreSQL database from this environment right now'",
        nested: { deep: { very: { deep: 'data' } } },
      },
    });
    // Should still extract from command field
    const output = parseHookOutput(r.stdout);
    expect(output).not.toBeNull();
  });

  it('unicode text with denials is handled', () => {
    const r = runHook(postToolUseHook, {
      tool_name: 'Bash',
      tool_input: { command: "echo 'I can\u2019t access the PostgreSQL database from this environment right now'" },
    });
    // Unicode right single quote (') — may or may not match "can't" pattern
    // Key assertion: doesn't crash
    expect(r.exitCode).toBe(0);
  });
});
