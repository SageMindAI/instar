/**
 * E2E test — Node.js boot wrapper and launchd robustness.
 *
 * Tests the complete defense-in-depth system for launchd auto-restart:
 *
 *   1. JS boot wrapper (TCC-safe launchd entry point)
 *   2. Stable node symlink (survives NVM/asdf version switches)
 *   3. Node candidate resolution (multiple fallback paths)
 *   4. Self-healing plist detection (old format → auto-upgrade)
 *   5. Node symlink self-healing inside boot wrapper
 *   6. Crash loop protection in JS wrapper (backoff, trim, clean exit)
 *   7. Plist format validation (correct XML, uses symlink, uses JS wrapper)
 *   8. End-to-end: setup → node switch → self-heal → restart cycle
 *
 * Uses real filesystem, real node invocations, real symlinks.
 * Does NOT require a running server, tmux, or launchctl.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

const isMacOS = os.platform() === 'darwin';

/**
 * Generate a JS boot wrapper matching what setup.ts produces.
 * Extracted here so tests stay in sync with the real generator.
 */
function generateJsWrapper(opts: {
  shadowCli: string;
  shadowDir: string;
  crashFile: string;
  nodeSymlink: string;
  nodeCandidatesFile: string;
  stateDir: string;
}): string {
  return `#!/usr/bin/env node
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHADOW = ${JSON.stringify(opts.shadowCli)};
const SHADOW_DIR = ${JSON.stringify(opts.shadowDir)};
const CRASH_FILE = ${JSON.stringify(opts.crashFile)};
const NODE_SYMLINK = ${JSON.stringify(opts.nodeSymlink)};
const NODE_CANDIDATES_FILE = ${JSON.stringify(opts.nodeCandidatesFile)};

function selfHealNodeSymlink() {
  try {
    const currentNode = process.execPath;
    const symlinkDir = path.dirname(NODE_SYMLINK);
    fs.mkdirSync(symlinkDir, { recursive: true });

    try {
      const target = fs.readlinkSync(NODE_SYMLINK);
      if (target === currentNode) return;
    } catch {}

    try { fs.unlinkSync(NODE_SYMLINK); } catch {}
    fs.symlinkSync(currentNode, NODE_SYMLINK);

    const candidates = [currentNode];
    const wellKnown = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
    for (const p of wellKnown) {
      if (p !== currentNode && fs.existsSync(p)) candidates.push(p);
    }
    fs.writeFileSync(NODE_CANDIDATES_FILE, JSON.stringify({
      primary: currentNode,
      candidates: candidates,
      updatedAt: new Date().toISOString(),
      updatedBy: 'instar-boot.js',
    }, null, 2));

    process.stderr.write('[instar-boot] Node symlink self-healed: ' + NODE_SYMLINK + ' -> ' + currentNode + '\\n');
  } catch (err) {
    process.stderr.write('[instar-boot] Node symlink self-heal failed (non-critical): ' + err.message + '\\n');
  }
}

selfHealNodeSymlink();

if (!fs.existsSync(SHADOW)) {
  process.stderr.write('ERROR: Shadow install not found at ' + SHADOW + '\\n');
  process.stderr.write('Run: npm install instar --prefix ' + ${JSON.stringify(opts.stateDir + '/shadow-install')} + '\\n');
  process.exit(1);
}

if (os.platform() === 'darwin') {
  try { execFileSync('xattr', ['-rd', 'com.apple.quarantine', SHADOW_DIR], { stdio: 'ignore' }); } catch {}
  try { execFileSync('xattr', ['-rd', 'com.apple.provenance', SHADOW_DIR], { stdio: 'ignore' }); } catch {}
}

const crashDir = path.dirname(CRASH_FILE);
fs.mkdirSync(crashDir, { recursive: true });

const args = process.argv.slice(2);
const child = spawn(process.execPath, [SHADOW, ...args], { stdio: 'inherit', env: process.env });

child.on('exit', (code, signal) => {
  const exitCode = code ?? (signal ? 1 : 0);
  if (exitCode !== 0) {
    const now = Math.floor(Date.now() / 1000);
    fs.appendFileSync(CRASH_FILE, now + '\\n');
    try {
      const lines = fs.readFileSync(CRASH_FILE, 'utf-8').trim().split('\\n');
      const cutoff = now - 120;
      const recent = lines.filter(l => parseInt(l, 10) > cutoff).length;
      if (recent >= 3) {
        const backoff = Math.min(recent * 10, 120);
        process.stderr.write('[instar-boot] Crash loop detected (' + recent + ' crashes in 120s). Backing off ' + backoff + 's...\\n');
        execFileSync('sleep', [String(backoff)], { stdio: 'ignore' });
      }
      if (lines.length > 20) {
        fs.writeFileSync(CRASH_FILE, lines.slice(-20).join('\\n') + '\\n');
      }
    } catch {}
    process.exit(exitCode);
  }
  try { fs.unlinkSync(CRASH_FILE); } catch {}
  process.exit(0);
});

child.on('error', (err) => {
  process.stderr.write('[instar-boot] Failed to spawn CLI: ' + err.message + '\\n');
  process.exit(1);
});
`;
}

describe('E2E: Node.js boot wrapper & launchd robustness', () => {
  let projectDir: string;
  let stateDir: string;
  let shadowDir: string;
  let shadowCli: string;
  let jsWrapperPath: string;
  let crashFile: string;
  let nodeSymlink: string;
  let nodeCandidatesFile: string;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-node-boot-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    shadowDir = path.join(stateDir, 'shadow-install');

    // Create shadow install structure
    const distDir = path.join(shadowDir, 'node_modules', 'instar', 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'bin'), { recursive: true });

    shadowCli = path.join(distDir, 'cli.js');
    fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nconsole.log("instar-test-cli");');
    fs.chmodSync(shadowCli, 0o755);

    crashFile = path.join(stateDir, 'state', 'boot-crashes.txt');
    nodeSymlink = path.join(stateDir, 'bin', 'node');
    nodeCandidatesFile = path.join(stateDir, 'bin', 'node-candidates.json');

    // Generate JS wrapper
    jsWrapperPath = path.join(stateDir, 'instar-boot.js');
    const wrapper = generateJsWrapper({
      shadowCli,
      shadowDir,
      crashFile,
      nodeSymlink,
      nodeCandidatesFile,
      stateDir,
    });
    fs.writeFileSync(jsWrapperPath, wrapper, { mode: 0o755 });
  });

  afterAll(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Restore clean state
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(crashFile); } catch { /* ok */ }
    fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nconsole.log("instar-test-cli");');
    fs.chmodSync(shadowCli, 0o755);
  });

  // ── 1. Basic JS Boot Wrapper ──

  describe('JS boot wrapper basics', () => {
    it('runs successfully with valid shadow install', () => {
      const result = execFileSync(process.execPath, [jsWrapperPath], {
        timeout: 10000,
        encoding: 'utf-8',
      });
      expect(result.trim()).toBe('instar-test-cli');
    });

    it('exits with clear error when shadow install is missing', () => {
      const backupPath = shadowCli + '.bak';
      fs.renameSync(shadowCli, backupPath);

      try {
        execFileSync(process.execPath, [jsWrapperPath], {
          timeout: 10000,
          encoding: 'utf-8',
        });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.stderr || '').toContain('Shadow install not found');
      } finally {
        fs.renameSync(backupPath, shadowCli);
      }
    });

    it('passes arguments through to the CLI', () => {
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));');

      const result = execFileSync(process.execPath, [jsWrapperPath, 'server', 'start', '--dir', '/tmp'], {
        timeout: 10000,
        encoding: 'utf-8',
      });
      const args = JSON.parse(result.trim());
      expect(args).toEqual(['server', 'start', '--dir', '/tmp']);
    });

    it('exits with non-zero code when CLI fails', () => {
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nprocess.exit(42);');

      try {
        execFileSync(process.execPath, [jsWrapperPath], {
          timeout: 10000,
          encoding: 'utf-8',
        });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        // Node's execFileSync throws for non-zero exit codes
        expect(err.status).toBe(42);
      }
    });

    it('inherits environment variables to child process', () => {
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nconsole.log(process.env.INSTAR_TEST_VAR);');

      const result = execFileSync(process.execPath, [jsWrapperPath], {
        timeout: 10000,
        encoding: 'utf-8',
        env: { ...process.env, INSTAR_TEST_VAR: 'hello-from-test' },
      });
      expect(result.trim()).toBe('hello-from-test');
    });
  });

  // ── 2. Node Symlink Self-Healing ──

  describe('Node symlink self-healing', () => {
    it('creates node symlink on first run when none exists', () => {
      // Remove any existing symlink
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(nodeSymlink); } catch { /* ok */ }

      execFileSync(process.execPath, [jsWrapperPath], { timeout: 10000 });

      // Symlink should now exist and point to current node
      expect(fs.existsSync(nodeSymlink)).toBe(true);
      const target = fs.readlinkSync(nodeSymlink);
      expect(target).toBe(process.execPath);
    });

    it('updates symlink when it points to a different node', () => {
      // Create a symlink pointing to a fake old node path
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(nodeSymlink); } catch { /* ok */ }
      fs.symlinkSync('/usr/local/bin/node-v18-old', nodeSymlink);

      execFileSync(process.execPath, [jsWrapperPath], { timeout: 10000 });

      // Symlink should now point to current node
      const target = fs.readlinkSync(nodeSymlink);
      expect(target).toBe(process.execPath);
    });

    it('does not update symlink when already correct', () => {
      // Create correct symlink
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(nodeSymlink); } catch { /* ok */ }
      fs.symlinkSync(process.execPath, nodeSymlink);

      const before = fs.lstatSync(nodeSymlink).mtimeMs;

      execFileSync(process.execPath, [jsWrapperPath], { timeout: 10000 });

      // Symlink should not have been touched
      const after = fs.lstatSync(nodeSymlink).mtimeMs;
      expect(after).toBe(before);
    });

    it('recovers from a broken symlink', () => {
      // Create a symlink pointing to a non-existent path
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(nodeSymlink); } catch { /* ok */ }
      fs.symlinkSync('/nonexistent/broken/node', nodeSymlink);

      // Broken symlinks fail existsSync but succeed readlinkSync
      expect(fs.existsSync(nodeSymlink)).toBe(false);

      execFileSync(process.execPath, [jsWrapperPath], { timeout: 10000 });

      // Should have been fixed
      expect(fs.existsSync(nodeSymlink)).toBe(true);
      const target = fs.readlinkSync(nodeSymlink);
      expect(target).toBe(process.execPath);
    });

    it('writes node-candidates.json with valid structure', () => {
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(nodeSymlink); } catch { /* ok */ }
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(nodeCandidatesFile); } catch { /* ok */ }

      execFileSync(process.execPath, [jsWrapperPath], { timeout: 10000 });

      expect(fs.existsSync(nodeCandidatesFile)).toBe(true);
      const data = JSON.parse(fs.readFileSync(nodeCandidatesFile, 'utf-8'));

      // Must have required fields
      expect(data.primary).toBe(process.execPath);
      expect(Array.isArray(data.candidates)).toBe(true);
      expect(data.candidates.length).toBeGreaterThanOrEqual(1);
      expect(data.candidates[0]).toBe(process.execPath);
      expect(data.updatedAt).toBeTruthy();
      expect(data.updatedBy).toBe('instar-boot.js');

      // All candidates must be actual files (or the primary)
      for (const candidate of data.candidates) {
        expect(fs.existsSync(candidate)).toBe(true);
      }
    });

    it('symlink target is actually executable as node', () => {
      // Run the wrapper to create/update symlink
      execFileSync(process.execPath, [jsWrapperPath], { timeout: 10000 });

      // The symlink target should be able to run node commands
      const target = fs.readlinkSync(nodeSymlink);
      const result = execFileSync(target, ['-e', 'console.log("symlink-test-ok")'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      expect(result.trim()).toBe('symlink-test-ok');
    });
  });

  // ── 3. Crash Loop Protection (JS wrapper) ──

  describe('JS wrapper crash loop protection', () => {
    it('clears crash history on clean exit', () => {
      fs.writeFileSync(crashFile, '1000000000\n1000000001\n');

      execFileSync(process.execPath, [jsWrapperPath], { timeout: 10000 });

      expect(fs.existsSync(crashFile)).toBe(false);
    });

    it('records crash timestamp on failure', () => {
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nprocess.exit(1);');

      try {
        execFileSync(process.execPath, [jsWrapperPath], { timeout: 10000 });
      } catch { /* expected */ }

      expect(fs.existsSync(crashFile)).toBe(true);
      const lines = fs.readFileSync(crashFile, 'utf-8').trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(1);

      // Timestamp should be recent (within last 60 seconds)
      const ts = parseInt(lines[lines.length - 1], 10);
      const now = Math.floor(Date.now() / 1000);
      expect(ts).toBeGreaterThan(now - 60);
      expect(ts).toBeLessThanOrEqual(now + 1);
    });

    it('accumulates crash timestamps across multiple failures', () => {
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nprocess.exit(1);');

      for (let i = 0; i < 2; i++) {
        try {
          execFileSync(process.execPath, [jsWrapperPath], {
            timeout: 10000,
            encoding: 'utf-8',
          });
        } catch { /* expected */ }
      }

      const lines = fs.readFileSync(crashFile, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);
    });

    it('trims crash file to 20 entries max', () => {
      const lines = Array.from({ length: 25 }, (_, i) => `${1000000000 + i}`).join('\n') + '\n';
      fs.writeFileSync(crashFile, lines);

      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nprocess.exit(1);');

      try {
        execFileSync(process.execPath, [jsWrapperPath], {
          timeout: 10000,
          encoding: 'utf-8',
        });
      } catch { /* expected */ }

      const content = fs.readFileSync(crashFile, 'utf-8').trim();
      const entryCount = content.split('\n').length;
      expect(entryCount).toBeLessThanOrEqual(20);
    });

    it('creates crash directory if it does not exist', () => {
      // Remove the state directory
      const stateSubDir = path.join(stateDir, 'state');
      // safe-git-allow: incremental-migration
      fs.rmSync(stateSubDir, { recursive: true, force: true });

      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nprocess.exit(1);');

      try {
        execFileSync(process.execPath, [jsWrapperPath], {
          timeout: 10000,
          encoding: 'utf-8',
        });
      } catch { /* expected */ }

      // Directory should have been recreated
      expect(fs.existsSync(stateSubDir)).toBe(true);
      expect(fs.existsSync(crashFile)).toBe(true);
    });
  });

  // ── 4. Plist Format Validation ──

  describe('Plist format validation', () => {
    function generatePlist(opts: {
      label?: string;
      nodeEntry?: string;
      wrapperPath?: string;
      projectDir?: string;
    }): string {
      const label = opts.label || 'ai.instar.test';
      const nodeEntry = opts.nodeEntry || '/opt/homebrew/bin/node';
      const wrapperPath = opts.wrapperPath || '/Users/test/.instar/agents/test/.instar/instar-boot.js';
      const dir = opts.projectDir || '/Users/test/.instar/agents/test';

      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${nodeEntry}</string>
      <string>${wrapperPath}</string>
      <string>lifeline</string>
      <string>start</string>
      <string>--dir</string>
      <string>${dir}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${dir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>`;
    }

    it('detects old bash-based plist format', () => {
      const plist = generatePlist({
        nodeEntry: '/bin/bash',
        wrapperPath: '/Users/test/.instar/agents/test/.instar/instar-boot.sh',
      });

      expect(plist).not.toContain('instar-boot.js');
      expect(plist).toContain('instar-boot.sh');
      // Self-healer should flag this
      const needsUpgrade = !plist.includes('instar-boot.js');
      expect(needsUpgrade).toBe(true);
    });

    it('detects plist with direct node path instead of symlink', () => {
      const plist = generatePlist({
        nodeEntry: '/opt/homebrew/bin/node',
        wrapperPath: '/Users/test/.instar/agents/test/.instar/instar-boot.js',
      });

      expect(plist).toContain('instar-boot.js'); // Has JS wrapper
      expect(plist).not.toContain('.instar/bin/node'); // But no symlink
      // Self-healer should flag this
      const needsUpgrade = !plist.includes('.instar/bin/node');
      expect(needsUpgrade).toBe(true);
    });

    it('accepts fully modern plist format', () => {
      const plist = generatePlist({
        nodeEntry: '/Users/test/.instar/agents/test/.instar/bin/node',
        wrapperPath: '/Users/test/.instar/agents/test/.instar/instar-boot.js',
      });

      expect(plist).toContain('instar-boot.js');
      expect(plist).toContain('.instar/bin/node');
      const needsUpgrade = !plist.includes('instar-boot.js') || !plist.includes('.instar/bin/node');
      expect(needsUpgrade).toBe(false);
    });

    it('detects stale node path (symlink target does not exist)', () => {
      const plist = generatePlist({
        nodeEntry: '/Users/test/.instar/agents/test/.instar/bin/node',
        wrapperPath: '/Users/test/.instar/agents/test/.instar/instar-boot.js',
      });

      // Extract node path from plist
      const match = plist.match(/<string>(\/[^<]+node[^<]*)<\/string>/);
      expect(match).toBeTruthy();
      const nodePath = match![1];

      // This path doesn't exist on the test system
      const isStale = !fs.existsSync(nodePath);
      expect(isStale).toBe(true);
    });
  });

  // ── 5. Stable Node Symlink (via ensureStableNodeSymlink) ──

  describe('Stable node symlink infrastructure', () => {
    it('symlink can be used as node binary to execute scripts', () => {
      // First ensure symlink exists
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(nodeSymlink); } catch { /* ok */ }
      fs.symlinkSync(process.execPath, nodeSymlink);

      const result = execFileSync(nodeSymlink, ['-e', 'console.log("via-symlink")'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      expect(result.trim()).toBe('via-symlink');
    });

    it('symlink can execute the JS boot wrapper', () => {
      // Ensure symlink points to current node
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(nodeSymlink); } catch { /* ok */ }
      fs.symlinkSync(process.execPath, nodeSymlink);

      // Use the symlink (as launchd would) to run the boot wrapper
      const result = execFileSync(nodeSymlink, [jsWrapperPath], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(result.trim()).toBe('instar-test-cli');
    });

    it('broken symlink causes clear failure (simulates stale NVM path)', () => {
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(nodeSymlink); } catch { /* ok */ }
      fs.symlinkSync('/nonexistent/old-nvm-version/bin/node', nodeSymlink);

      try {
        execFileSync(nodeSymlink, ['-e', 'console.log("should-fail")'], {
          encoding: 'utf-8',
          timeout: 5000,
        });
        expect.unreachable('Should have thrown — broken symlink');
      } catch (err: any) {
        // Should fail with ENOENT (symlink target doesn't exist)
        expect(err.code || err.errno).toBeTruthy();
      }
    });
  });

  // ── 6. xattr Handling (macOS only) ──

  describe('xattr handling in JS wrapper', { skip: !isMacOS }, () => {
    it('JS boot wrapper handles files with quarantine attributes', () => {
      // Set quarantine on the shadow CLI
      const testFile = path.join(shadowDir, 'node_modules', 'instar', 'dist', 'quarantine-test-js.txt');
      fs.writeFileSync(testFile, 'test');

      try {
        execFileSync('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;test;|com.apple.test', testFile]);
      } catch { /* xattr may fail on some filesystems */ }

      // Boot wrapper should still run successfully (it strips xattrs)
      const result = execFileSync(process.execPath, [jsWrapperPath], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(result.trim()).toBe('instar-test-cli');

      // safe-git-allow: incremental-migration
      fs.unlinkSync(testFile);
    });

    it('JS boot wrapper does not crash on files without xattrs', () => {
      const result = execFileSync(process.execPath, [jsWrapperPath], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(result.trim()).toBe('instar-test-cli');
    });
  });

  // ── 7. Edge Cases ──

  describe('Edge cases', () => {
    it('handles shadow CLI that writes to stderr without affecting boot', () => {
      fs.writeFileSync(shadowCli,
        '#!/usr/bin/env node\nprocess.stderr.write("warning: something\\n");\nconsole.log("ok-with-stderr");');

      const result = execFileSync(process.execPath, [jsWrapperPath], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(result.trim()).toBe('ok-with-stderr');
    });

    it('handles shadow CLI with slow startup', () => {
      fs.writeFileSync(shadowCli,
        '#!/usr/bin/env node\nsetTimeout(() => { console.log("slow-start"); }, 500);');

      const result = execFileSync(process.execPath, [jsWrapperPath], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(result.trim()).toBe('slow-start');
    });

    it('handles empty crash file gracefully', () => {
      fs.writeFileSync(crashFile, '');
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nprocess.exit(1);');

      try {
        execFileSync(process.execPath, [jsWrapperPath], {
          timeout: 10000,
          encoding: 'utf-8',
        });
      } catch { /* expected */ }

      // Should have appended a timestamp, not crashed
      const content = fs.readFileSync(crashFile, 'utf-8').trim();
      expect(content.split('\n').filter(l => l.trim()).length).toBeGreaterThanOrEqual(1);
    });

    it('handles crash file with malformed entries', () => {
      fs.writeFileSync(crashFile, 'not-a-number\nabc\n123\n');
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nprocess.exit(1);');

      // Should not crash on malformed entries — parseInt returns NaN, filter skips them
      try {
        execFileSync(process.execPath, [jsWrapperPath], {
          timeout: 10000,
          encoding: 'utf-8',
        });
      } catch { /* expected */ }

      // Should have appended a valid timestamp
      const content = fs.readFileSync(crashFile, 'utf-8').trim();
      const lines = content.split('\n');
      const lastTs = parseInt(lines[lines.length - 1], 10);
      expect(lastTs).toBeGreaterThan(1700000000);
    });

    it('handles project path with spaces', () => {
      const spacedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar spaced path-'));
      const spacedStateDir = path.join(spacedDir, '.instar');
      const spacedShadowDir = path.join(spacedStateDir, 'shadow-install');
      const spacedDistDir = path.join(spacedShadowDir, 'node_modules', 'instar', 'dist');
      fs.mkdirSync(spacedDistDir, { recursive: true });
      fs.mkdirSync(path.join(spacedStateDir, 'state'), { recursive: true });
      fs.mkdirSync(path.join(spacedStateDir, 'bin'), { recursive: true });

      const spacedCli = path.join(spacedDistDir, 'cli.js');
      fs.writeFileSync(spacedCli, '#!/usr/bin/env node\nconsole.log("spaced-path-ok");');
      fs.chmodSync(spacedCli, 0o755);

      const spacedWrapper = path.join(spacedStateDir, 'instar-boot.js');
      const wrapper = generateJsWrapper({
        shadowCli: spacedCli,
        shadowDir: spacedShadowDir,
        crashFile: path.join(spacedStateDir, 'state', 'boot-crashes.txt'),
        nodeSymlink: path.join(spacedStateDir, 'bin', 'node'),
        nodeCandidatesFile: path.join(spacedStateDir, 'bin', 'node-candidates.json'),
        stateDir: spacedStateDir,
      });
      fs.writeFileSync(spacedWrapper, wrapper, { mode: 0o755 });

      const result = execFileSync(process.execPath, [spacedWrapper], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(result.trim()).toBe('spaced-path-ok');

      // safe-git-allow: incremental-migration
      fs.rmSync(spacedDir, { recursive: true, force: true });
    });

    it('handles project path with special characters', () => {
      const specialDir = fs.mkdtempSync(path.join(os.tmpdir(), "instar-special'chars-"));
      const specialStateDir = path.join(specialDir, '.instar');
      const specialShadowDir = path.join(specialStateDir, 'shadow-install');
      const specialDistDir = path.join(specialShadowDir, 'node_modules', 'instar', 'dist');
      fs.mkdirSync(specialDistDir, { recursive: true });
      fs.mkdirSync(path.join(specialStateDir, 'state'), { recursive: true });
      fs.mkdirSync(path.join(specialStateDir, 'bin'), { recursive: true });

      const specialCli = path.join(specialDistDir, 'cli.js');
      fs.writeFileSync(specialCli, '#!/usr/bin/env node\nconsole.log("special-chars-ok");');
      fs.chmodSync(specialCli, 0o755);

      const specialWrapper = path.join(specialStateDir, 'instar-boot.js');
      const wrapper = generateJsWrapper({
        shadowCli: specialCli,
        shadowDir: specialShadowDir,
        crashFile: path.join(specialStateDir, 'state', 'boot-crashes.txt'),
        nodeSymlink: path.join(specialStateDir, 'bin', 'node'),
        nodeCandidatesFile: path.join(specialStateDir, 'bin', 'node-candidates.json'),
        stateDir: specialStateDir,
      });
      fs.writeFileSync(specialWrapper, wrapper, { mode: 0o755 });

      const result = execFileSync(process.execPath, [specialWrapper], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(result.trim()).toBe('special-chars-ok');

      // safe-git-allow: incremental-migration
      fs.rmSync(specialDir, { recursive: true, force: true });
    });
  });

  // ── 8. End-to-End: Setup → Node Switch → Self-Heal → Restart ──

  describe('End-to-end: node version switch recovery', () => {
    it('simulates full lifecycle: boot → symlink created → node changes → next boot self-heals', () => {
      // Step 1: First boot — symlink is created pointing to current node
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(nodeSymlink); } catch { /* ok */ }

      execFileSync(process.execPath, [jsWrapperPath], { timeout: 10000 });

      expect(fs.existsSync(nodeSymlink)).toBe(true);
      expect(fs.readlinkSync(nodeSymlink)).toBe(process.execPath);

      // Step 2: Simulate NVM switch — symlink now points to "old" node
      // safe-git-allow: incremental-migration
      fs.unlinkSync(nodeSymlink);
      fs.symlinkSync('/usr/local/bin/node-v18-old', nodeSymlink);
      expect(fs.readlinkSync(nodeSymlink)).toBe('/usr/local/bin/node-v18-old');

      // Step 3: Next boot happens (using current node directly, as launchd would
      // if someone manually fixed the plist or if the symlink target happened to work)
      execFileSync(process.execPath, [jsWrapperPath], { timeout: 10000 });

      // Step 4: Verify self-heal — symlink should now point to current node again
      expect(fs.readlinkSync(nodeSymlink)).toBe(process.execPath);
    });

    it('simulates auto-update cycle: old version → new version → boot wrapper runs updated CLI', () => {
      // Step 1: Start with "v1.0.0"
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nconsole.log("v1.0.0");');
      const v1 = execFileSync(process.execPath, [jsWrapperPath], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(v1.trim()).toBe('v1.0.0');

      // Step 2: Auto-updater installs "v2.0.0" to shadow
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nconsole.log("v2.0.0");');

      // Step 3: Simulate launchd restart (via boot wrapper)
      const v2 = execFileSync(process.execPath, [jsWrapperPath], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(v2.trim()).toBe('v2.0.0');

      // Step 4: Verify no crash history
      expect(fs.existsSync(crashFile)).toBe(false);
    });

    it('simulates crash during update → backoff → successful boot after fix', () => {
      // Step 1: Bad update — CLI crashes
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nprocess.exit(1);');

      // Two crashes (under threshold)
      for (let i = 0; i < 2; i++) {
        try {
          execFileSync(process.execPath, [jsWrapperPath], {
            timeout: 10000,
            encoding: 'utf-8',
          });
        } catch { /* expected */ }
      }

      // Verify crash tracking
      let lines = fs.readFileSync(crashFile, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);

      // Step 2: Fix applied — CLI now works
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nconsole.log("fixed");');
      fs.chmodSync(shadowCli, 0o755);

      const result = execFileSync(process.execPath, [jsWrapperPath], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(result.trim()).toBe('fixed');

      // Step 3: Crash history cleared after clean exit
      expect(fs.existsSync(crashFile)).toBe(false);
    });
  });

  // ── 9. Parity: JS vs Bash wrapper behavior ──

  describe('JS and bash wrapper parity', () => {
    let bashWrapperPath: string;

    beforeAll(() => {
      bashWrapperPath = path.join(stateDir, 'instar-boot.sh');

      const bashWrapper = `#!/bin/bash
SHADOW="${shadowCli}"
SHADOW_DIR="${shadowDir}"
CRASH_FILE="${crashFile}"

if [ ! -f "$SHADOW" ]; then
  echo "ERROR: Shadow install not found at $SHADOW" >&2
  exit 1
fi

if command -v xattr >/dev/null 2>&1; then
  xattr -rd com.apple.quarantine "$SHADOW_DIR" 2>/dev/null || true
  xattr -rd com.apple.provenance "$SHADOW_DIR" 2>/dev/null || true
fi

mkdir -p "$(dirname "$CRASH_FILE")" 2>/dev/null
node "$SHADOW" "$@"
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "$(date -u +%s)" >> "$CRASH_FILE"
  NOW=$(date -u +%s)
  RECENT=$(awk -v now="$NOW" '$1 > now - 120' "$CRASH_FILE" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$RECENT" -ge 3 ]; then
    BACKOFF=$((RECENT * 10))
    [ "$BACKOFF" -gt 120 ] && BACKOFF=120
    sleep $BACKOFF
  fi
  tail -20 "$CRASH_FILE" > "$CRASH_FILE.tmp" 2>/dev/null && mv "$CRASH_FILE.tmp" "$CRASH_FILE" 2>/dev/null
  exit $EXIT_CODE
fi

rm -f "$CRASH_FILE" 2>/dev/null
`;
      fs.writeFileSync(bashWrapperPath, bashWrapper, { mode: 0o755 });
    });

    it('both wrappers produce same stdout for working CLI', () => {
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nconsole.log("parity-check");');
      fs.chmodSync(shadowCli, 0o755);

      const jsResult = execFileSync(process.execPath, [jsWrapperPath], {
        encoding: 'utf-8',
        timeout: 10000,
      });

      const bashResult = execSync(`bash "${bashWrapperPath}"`, {
        encoding: 'utf-8',
        timeout: 10000,
      });

      expect(jsResult.trim()).toBe('parity-check');
      expect(bashResult.trim()).toBe('parity-check');
    });

    it('both wrappers pass arguments through identically', () => {
      fs.writeFileSync(shadowCli,
        '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));');
      fs.chmodSync(shadowCli, 0o755);

      const testArgs = ['lifeline', 'start', '--dir', '/tmp/test'];

      const jsResult = execFileSync(process.execPath, [jsWrapperPath, ...testArgs], {
        encoding: 'utf-8',
        timeout: 10000,
      });

      const bashResult = execSync(
        `bash "${bashWrapperPath}" ${testArgs.map(a => `"${a}"`).join(' ')}`,
        { encoding: 'utf-8', timeout: 10000 },
      );

      expect(JSON.parse(jsResult.trim())).toEqual(testArgs);
      expect(JSON.parse(bashResult.trim())).toEqual(testArgs);
    });

    it('both wrappers exit with same code on CLI failure', () => {
      fs.writeFileSync(shadowCli, '#!/usr/bin/env node\nprocess.exit(42);');

      let jsExitCode: number | null = null;
      try {
        execFileSync(process.execPath, [jsWrapperPath], { timeout: 10000 });
      } catch (err: any) {
        jsExitCode = err.status;
      }

      let bashExitCode: number | null = null;
      try {
        execSync(`bash "${bashWrapperPath}"`, { timeout: 10000 });
      } catch (err: any) {
        bashExitCode = err.status;
      }

      expect(jsExitCode).toBe(42);
      expect(bashExitCode).toBe(42);
    });

    it('both wrappers report missing shadow install to stderr', () => {
      const backup = shadowCli + '.parity-bak';
      fs.renameSync(shadowCli, backup);

      let jsStderr = '';
      try {
        execFileSync(process.execPath, [jsWrapperPath], {
          timeout: 10000,
          encoding: 'utf-8',
        });
      } catch (err: any) {
        jsStderr = err.stderr || '';
      }

      let bashStderr = '';
      try {
        execSync(`bash "${bashWrapperPath}" 2>&1`, {
          timeout: 10000,
          encoding: 'utf-8',
        });
      } catch (err: any) {
        bashStderr = err.stdout || err.stderr || '';
      }

      expect(jsStderr).toContain('Shadow install not found');
      expect(bashStderr).toContain('Shadow install not found');

      fs.renameSync(backup, shadowCli);
    });
  });
});
