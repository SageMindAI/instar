/**
 * Two-session harness for parallel-dev isolation acceptance tests (AC-39).
 *
 * Spawns two stub WorktreeManager-backed sessions against a shared in-process
 * server. Used by AC-3, AC-4, AC-11, AC-17, AC-18, etc.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeManager, type WorktreeMode } from '../../src/core/WorktreeManager.js';

export interface HarnessSession {
  sessionId: string;
  pid: number;
  cwd?: string;
  fencingToken?: string;
}

export interface HarnessHandle {
  manager: WorktreeManager;
  projectDir: string;
  stateDir: string;
  publicKeyPem: string;
  /** Spawn a virtual session — calls WorktreeManager.resolve. */
  spawn(s: { topicId: number | 'platform'; mode?: WorktreeMode; sessionId?: string; pid?: number; slug?: string }): Promise<HarnessSession>;
  /** Release a session's lock. */
  release(s: HarnessSession): { released: boolean };
  /** Force-take a topic worktree. */
  forceTake(args: { topicId: number | 'platform'; mode?: WorktreeMode; bySessionId: string; pid?: number }): Promise<unknown>;
  cleanup(): void;
}

export async function createTwoSessionHarness(): Promise<HarnessHandle> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-twoses-'));
  const projectDir = path.join(tmp, 'repo');
  const stateDir = path.join(projectDir, '.instar');

  fs.mkdirSync(projectDir, { recursive: true });
  // Initialize a real git repo so `git worktree add` works
  execFileSync('git', ['-C', projectDir, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'test@instar.local']);
  execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'Test Harness']);
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# test\n');
  execFileSync('git', ['-C', projectDir, 'add', 'README.md']);
  execFileSync('git', ['-C', projectDir, 'commit', '-q', '-m', 'init']);

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'worktrees'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'local-state'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });

  // Real Ed25519 keypair so signTrailer/verifyTrailer can be exercised end-to-end
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const hmacKey = crypto.randomBytes(32);
  const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
  const repoOriginUrl = `file://${projectDir}.git`;

  const manager = new WorktreeManager({
    projectDir,
    stateDir,
    signingKey: { privateKeyPem: privateKey, publicKeyPem: publicKey, keyVersion: 1 },
    hmacKey,
    machineId,
    bootId: 'test-boot-id',
    repoOriginUrl,
  });
  manager.initialize();

  return {
    manager,
    projectDir,
    stateDir,
    publicKeyPem: publicKey,
    async spawn(s) {
      const sessionId = s.sessionId ?? crypto.randomUUID();
      const pid = s.pid ?? process.pid;
      const result = await manager.resolve({
        topicId: s.topicId,
        mode: s.mode ?? 'dev',
        sessionId,
        pid,
        processStartTime: Math.floor(Date.now() / 1000),
        slug: s.slug ?? `topic-${s.topicId}`,
      });
      return { sessionId, pid, cwd: result.cwd, fencingToken: result.fencingToken };
    },
    release(s) {
      if (!s.fencingToken) return { released: false };
      return manager.release({ sessionId: s.sessionId, fencingToken: s.fencingToken });
    },
    async forceTake(args) {
      return manager.forceTake({
        topicId: args.topicId,
        mode: args.mode ?? 'dev',
        bySessionId: args.bySessionId,
        pid: args.pid ?? process.pid,
        processStartTime: Math.floor(Date.now() / 1000),
      });
    },
    cleanup() {
      try { fs.rmSync(tmp, { recursive: true, force: true }); }
      catch { /* @silent-fallback-ok */ }
    },
  };
}
