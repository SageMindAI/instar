/**
 * Unit tests for the serendipity-capture.sh helper script.
 *
 * Tests the shell script directly in a temp directory, verifying:
 * - Argument validation (required fields, categories, readiness)
 * - Field length limits
 * - Secret scanning (blocking)
 * - Symlink rejection for patch files
 * - Patch file size limits and path traversal detection
 * - Rate limiting
 * - HMAC signing and JSON structure
 * - Atomic write (no partial .json files)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

// ── Test Setup ──────────────────────────────────────────────────

let tmpDir: string;
let scriptPath: string;
let configFile: string;
let serendipityDir: string;
const AUTH_TOKEN = 'test-auth-token-for-serendipity';
const SESSION_ID = 'test-session-123';

function runCapture(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const fullEnv = {
    ...process.env,
    CLAUDE_SESSION_ID: SESSION_ID,
    CLAUDE_AGENT_TYPE: 'general-purpose',
    CLAUDE_TASK_DESCRIPTION: 'test task',
    HOME: os.homedir(),
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin',
    ...env,
  };

  try {
    const stdout = execFileSync(scriptPath, args, {
      cwd: tmpDir,
      env: fullEnv,
      timeout: 10_000,
      encoding: 'utf-8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function baseArgs(overrides: Record<string, string> = {}): string[] {
  const defaults: Record<string, string> = {
    '--title': 'Test finding title',
    '--description': 'A detailed description of what was found',
    '--category': 'improvement',
    '--rationale': 'This matters because it improves code quality',
    '--readiness': 'idea-only',
  };
  const merged = { ...defaults, ...overrides };
  const args: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value !== '') {
      args.push(key, value);
    }
  }
  return args;
}

function listFindings(): string[] {
  if (!fs.existsSync(serendipityDir)) return [];
  return fs.readdirSync(serendipityDir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
}

function readFinding(filename: string): any {
  return JSON.parse(fs.readFileSync(path.join(serendipityDir, filename), 'utf-8'));
}

beforeAll(() => {
  // Create temp project structure
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-serendipity-test-'));
  const instarDir = path.join(tmpDir, '.instar');
  const scriptsDir = path.join(instarDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  // Copy the script from templates
  const templateScript = path.resolve(__dirname, '../../src/templates/scripts/serendipity-capture.sh');
  scriptPath = path.join(scriptsDir, 'serendipity-capture.sh');
  fs.copyFileSync(templateScript, scriptPath);
  fs.chmodSync(scriptPath, 0o755);

  // Create config with auth token
  configFile = path.join(instarDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ authToken: AUTH_TOKEN, serendipity: { enabled: true, maxPerSession: 5 } }));

  serendipityDir = path.join(instarDir, 'state', 'serendipity');
});

afterAll(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Clean serendipity directory between tests
  if (fs.existsSync(serendipityDir)) {
    // safe-git-allow: incremental-migration
    fs.rmSync(serendipityDir, { recursive: true, force: true });
  }
});

// ── Tests ──────────────────────────────────────────────────────

describe('serendipity-capture.sh', () => {
  describe('argument validation', () => {
    it('requires --title', () => {
      const result = runCapture(['--description', 'desc', '--category', 'bug', '--rationale', 'why', '--readiness', 'idea-only']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--title is required');
    });

    it('requires --description', () => {
      const result = runCapture(['--title', 'title', '--category', 'bug', '--rationale', 'why', '--readiness', 'idea-only']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--description is required');
    });

    it('requires --category', () => {
      const result = runCapture(['--title', 'title', '--description', 'desc', '--rationale', 'why', '--readiness', 'idea-only']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--category is required');
    });

    it('requires --rationale', () => {
      const result = runCapture(['--title', 'title', '--description', 'desc', '--category', 'bug', '--readiness', 'idea-only']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--rationale is required');
    });

    it('requires --readiness', () => {
      const result = runCapture(['--title', 'title', '--description', 'desc', '--category', 'bug', '--rationale', 'why']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--readiness is required');
    });

    it('rejects unknown arguments', () => {
      const result = runCapture([...baseArgs(), '--unknown', 'value']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Unknown argument');
    });
  });

  describe('category validation', () => {
    const validCategories = ['bug', 'improvement', 'feature', 'pattern', 'refactor', 'security'];

    for (const cat of validCategories) {
      it(`accepts valid category: ${cat}`, () => {
        const result = runCapture(baseArgs({ '--category': cat }));
        expect(result.status).toBe(0);
      });
    }

    it('rejects invalid category', () => {
      const result = runCapture(baseArgs({ '--category': 'invalid-cat' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--category must be one of');
    });
  });

  describe('readiness validation', () => {
    const validReadiness = ['idea-only', 'partially-implemented', 'implementation-complete', 'tested'];

    for (const r of validReadiness) {
      it(`accepts valid readiness: ${r}`, () => {
        const result = runCapture(baseArgs({ '--readiness': r }));
        expect(result.status).toBe(0);
      });
    }

    it('rejects invalid readiness', () => {
      const result = runCapture(baseArgs({ '--readiness': 'maybe' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--readiness must be one of');
    });
  });

  describe('field length limits', () => {
    it('rejects title over 120 characters', () => {
      const result = runCapture(baseArgs({ '--title': 'x'.repeat(121) }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('exceeds 120 characters');
    });

    it('rejects description over 2000 characters', () => {
      const result = runCapture(baseArgs({ '--description': 'x'.repeat(2001) }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('exceeds 2000 characters');
    });

    it('rejects rationale over 1000 characters', () => {
      const result = runCapture(baseArgs({ '--rationale': 'x'.repeat(1001) }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('exceeds 1000 characters');
    });

    it('accepts title at exactly 120 characters', () => {
      const result = runCapture(baseArgs({ '--title': 'x'.repeat(120) }));
      expect(result.status).toBe(0);
    });
  });

  describe('successful capture', () => {
    it('creates a JSON file with correct schema', () => {
      const result = runCapture(baseArgs());
      expect(result.status).toBe(0);

      const files = listFindings();
      expect(files.length).toBe(1);

      const finding = readFinding(files[0]);
      expect(finding.schemaVersion).toBe(1);
      expect(finding.id).toMatch(/^srdp-[a-f0-9]{8}$/);
      expect(finding.hmac).toBeTruthy();
      expect(finding.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(finding.status).toBe('pending');

      // Discovery fields
      expect(finding.discovery.title).toBe('Test finding title');
      expect(finding.discovery.description).toBe('A detailed description of what was found');
      expect(finding.discovery.category).toBe('improvement');
      expect(finding.discovery.rationale).toBe('This matters because it improves code quality');

      // Source fields
      expect(finding.source.sessionId).toBe(SESSION_ID);
      expect(finding.source.agentType).toBe('general-purpose');

      // Readiness
      expect(finding.readiness).toBe('idea-only');
    });

    it('creates unique IDs for each finding', () => {
      runCapture(baseArgs({ '--title': 'Finding 1' }));
      runCapture(baseArgs({ '--title': 'Finding 2' }));

      const files = listFindings();
      expect(files.length).toBe(2);

      const id1 = readFinding(files[0]).id;
      const id2 = readFinding(files[1]).id;
      expect(id1).not.toBe(id2);
    });

    it('creates serendipity directory lazily', () => {
      expect(fs.existsSync(serendipityDir)).toBe(false);

      runCapture(baseArgs());

      expect(fs.existsSync(serendipityDir)).toBe(true);
    });
  });

  describe('HMAC signing', () => {
    it('produces a valid HMAC signature', () => {
      runCapture(baseArgs());

      const files = listFindings();
      const finding = readFinding(files[0]);

      // Derive signing key the same way the script does
      const keyMaterial = `serendipity-v1:${SESSION_ID}`;
      const signingKey = crypto
        .createHmac('sha256', AUTH_TOKEN)
        .update(keyMaterial)
        .digest('hex');

      // Build canonical signed payload
      const signedData: Record<string, unknown> = {
        id: finding.id,
        createdAt: finding.createdAt,
        discovery: finding.discovery,
        source: finding.source,
      };
      if (finding.artifacts) {
        signedData.artifacts = finding.artifacts;
      }
      const canonical = JSON.stringify(signedData, Object.keys(signedData).sort(), undefined)
        // JSON.stringify with sort_keys equivalent
        .replace(/\s/g, '');

      // Actually, python's sort_keys + separators=(',', ':') produces a different
      // format. Let's use python-style canonical JSON.
      const canonicalPython = jsonCanonical(signedData);

      const expected = crypto
        .createHmac('sha256', signingKey)
        .update(canonicalPython)
        .digest('hex');

      expect(finding.hmac).toBe(expected);
    });
  });

  describe('secret scanning', () => {
    it('blocks AWS access keys in title', () => {
      const result = runCapture(baseArgs({ '--title': 'Found key AKIAIOSFODNN7EXAMPLE' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('secret/credential detected');
    });

    it('blocks GitHub tokens in description', () => {
      const result = runCapture(baseArgs({ '--description': 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1234' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('secret/credential detected');
    });

    it('blocks OpenAI-style keys in rationale', () => {
      const result = runCapture(baseArgs({ '--rationale': 'Uses sk-abcdefghijklmnopqrstuvwx' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('secret/credential detected');
    });

    it('blocks private keys', () => {
      const result = runCapture(baseArgs({ '--description': '-----BEGIN PRIVATE KEY-----' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('secret/credential detected');
    });

    it('blocks secrets in patch files', () => {
      const patchFile = path.join(tmpDir, 'secret.patch');
      fs.writeFileSync(patchFile, `--- a/config.ts\n+++ b/config.ts\n@@ -1 +1 @@\n-old\n+const key = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1234"\n`);

      const result = runCapture([...baseArgs(), '--patch-file', patchFile]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('secret/credential detected in patch');
    });

    it('allows normal text without secrets', () => {
      const result = runCapture(baseArgs({ '--description': 'This is a normal description about improving error handling' }));
      expect(result.status).toBe(0);
    });
  });

  describe('patch file handling', () => {
    it('accepts a valid patch file', () => {
      const patchFile = path.join(tmpDir, 'valid.patch');
      fs.writeFileSync(patchFile, `--- a/src/utils.ts\n+++ b/src/utils.ts\n@@ -1 +1 @@\n-old code\n+new code\n`);

      const result = runCapture([...baseArgs(), '--patch-file', patchFile]);
      expect(result.status).toBe(0);

      const files = listFindings();
      const finding = readFinding(files[0]);
      expect(finding.artifacts).toBeDefined();
      expect(finding.artifacts.patchFile).toMatch(/^srdp-.*\.patch$/);
      expect(finding.artifacts.patchSha256).toBeTruthy();

      // Verify the patch was copied
      const patchCopy = path.join(serendipityDir, finding.artifacts.patchFile);
      expect(fs.existsSync(patchCopy)).toBe(true);
    });

    it('rejects missing patch file', () => {
      const result = runCapture([...baseArgs(), '--patch-file', '/nonexistent/file.patch']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Patch file not found');
    });

    it('rejects symlink patch files', () => {
      const realFile = path.join(tmpDir, 'real.patch');
      const symlinkFile = path.join(tmpDir, 'symlink.patch');
      fs.writeFileSync(realFile, 'patch content');
      fs.symlinkSync(realFile, symlinkFile);

      const result = runCapture([...baseArgs(), '--patch-file', symlinkFile]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('symlink');
    });

    it('rejects oversized patch files (>10KB)', () => {
      const bigPatch = path.join(tmpDir, 'big.patch');
      fs.writeFileSync(bigPatch, 'x'.repeat(10241));

      const result = runCapture([...baseArgs(), '--patch-file', bigPatch]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('exceeds');
    });

    it('rejects patch files with path traversal in diff headers', () => {
      const traversalPatch = path.join(tmpDir, 'traversal.patch');
      fs.writeFileSync(traversalPatch, `--- a/src/utils.ts\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-old\n+new\n`);

      const result = runCapture([...baseArgs(), '--patch-file', traversalPatch]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('path traversal');
    });

    it('includes patchSha256 in HMAC-signed payload when patch is present', () => {
      const patchFile = path.join(tmpDir, 'hmac-test.patch');
      fs.writeFileSync(patchFile, 'patch content for hmac test');

      runCapture([...baseArgs(), '--patch-file', patchFile]);

      const files = listFindings();
      const finding = readFinding(files[0]);

      // Verify artifacts are in the finding
      expect(finding.artifacts).toBeDefined();
      expect(finding.artifacts.patchSha256).toBeTruthy();

      // The HMAC should cover the artifacts field (including patchSha256)
      // Verify by recomputing
      const keyMaterial = `serendipity-v1:${SESSION_ID}`;
      const signingKey = crypto
        .createHmac('sha256', AUTH_TOKEN)
        .update(keyMaterial)
        .digest('hex');

      const signedData = {
        id: finding.id,
        createdAt: finding.createdAt,
        discovery: finding.discovery,
        source: finding.source,
        artifacts: finding.artifacts,
      };
      const canonical = jsonCanonical(signedData);
      const expected = crypto
        .createHmac('sha256', signingKey)
        .update(canonical)
        .digest('hex');

      expect(finding.hmac).toBe(expected);
    });
  });

  describe('rate limiting', () => {
    it('allows up to maxPerSession findings', () => {
      for (let i = 0; i < 5; i++) {
        const result = runCapture(baseArgs({ '--title': `Finding ${i + 1}` }));
        expect(result.status).toBe(0);
      }
      expect(listFindings().length).toBe(5);
    });

    it('blocks findings beyond maxPerSession', () => {
      for (let i = 0; i < 5; i++) {
        runCapture(baseArgs({ '--title': `Finding ${i + 1}` }));
      }

      const result = runCapture(baseArgs({ '--title': 'One too many' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Rate limit reached');
    });

    it('counts per session, not globally', () => {
      // Create 5 findings with SESSION_ID
      for (let i = 0; i < 5; i++) {
        runCapture(baseArgs({ '--title': `Session 1 finding ${i + 1}` }));
      }

      // A different session should still be able to create findings
      const result = runCapture(
        baseArgs({ '--title': 'Different session finding' }),
        { CLAUDE_SESSION_ID: 'different-session-456' },
      );
      expect(result.status).toBe(0);
    });
  });

  describe('disabled via config', () => {
    it('exits with error when serendipity is disabled', () => {
      // Temporarily disable
      const origConfig = fs.readFileSync(configFile, 'utf-8');
      fs.writeFileSync(configFile, JSON.stringify({ authToken: AUTH_TOKEN, serendipity: { enabled: false } }));

      try {
        const result = runCapture(baseArgs());
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('disabled');
      } finally {
        fs.writeFileSync(configFile, origConfig);
      }
    });
  });

  describe('atomic writes', () => {
    it('does not leave .tmp files after successful capture', () => {
      runCapture(baseArgs());

      const allFiles = fs.readdirSync(serendipityDir);
      const tmpFiles = allFiles.filter(f => f.endsWith('.tmp'));
      expect(tmpFiles.length).toBe(0);
    });

    it('creates .json files (not .json.tmp)', () => {
      runCapture(baseArgs());

      const files = listFindings();
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.json$/);
      expect(files[0]).not.toMatch(/\.tmp$/);
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Produce Python-equivalent canonical JSON: sorted keys, no whitespace.
 * Matches json.dumps(data, sort_keys=True, separators=(',', ':'))
 */
function jsonCanonical(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(jsonCanonical).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map(k => `${JSON.stringify(k)}:${jsonCanonical((obj as Record<string, unknown>)[k])}`);
  return '{' + pairs.join(',') + '}';
}
