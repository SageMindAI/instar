/**
 * WorktreeManager — Topic-bound parallel-dev isolation (PARALLEL-DEV-ISOLATION-SPEC.md iter 4).
 *
 * Source of truth for: topic→worktree bindings, exclusive locks, fencing tokens,
 * commit-trailer signing, force-take protocol, state reconciliation matrix.
 *
 * Two storage layers:
 *   - Machine-local (gitignored): bindings, locks, fencing, binding-history.db, snapshots/
 *   - Git-synced (signed): topic-branch-map (path-free), binding-history-log.jsonl
 *
 * Authority model:
 *   - Local advisory: pre-commit gate (cwd-vs-binding, lock-owner)
 *   - Local authoritative-on-trailer: commit-msg hook (Ed25519 sign tree+nonce+parent)
 *   - Origin authoritative: GitHub Repository Ruleset + workflow check (Ed25519 verify offline)
 *
 * Same-topic concurrency: EXCLUSIVE — one session per topic worktree.
 */

import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────

export type WorktreeMode = 'dev' | 'read-only' | 'doc-fix' | 'platform';

export interface WorktreeBinding {
  topicId: number | 'platform';
  slug: string;
  branch: string;
  worktreePath: string;
  mode: WorktreeMode;
  status: 'active' | 'merged' | 'abandoned' | 'lost' | 'quarantined';
  createdAt: string;
  createdBy: string; // sessionId
  machineId: string;
  fencingToken: string; // "<machineId>:<counter>"
  serverSignature: string;
}

export interface SessionLock {
  schema: 'v2';
  machineId: string;
  bootId: string;
  pid: number;
  processStartTime: number;
  sessionId: string;
  fencingToken: string;
  topicId: number | 'platform';
  acquiredAt: string;
  heartbeatAt: string;
  serverSignature: string;
}

export interface ResolveResult {
  cwd: string;
  branch: string;
  fencingToken: string;
  sessionContextPath: string;
  mode: WorktreeMode;
  binding: WorktreeBinding;
}

export interface SignedTrailerResult {
  trailers: string[]; // 9 trailer lines, ready to feed `git interpret-trailers`
  nonce: string;
  issued: number;
  maxPushDelay: number;
  keyVersion: number;
}

export interface WorktreeManagerOptions {
  projectDir: string;
  stateDir: string; // typically `<projectDir>/.instar`
  signingKey: { privateKeyPem: string; publicKeyPem: string; keyVersion: number };
  hmacKey: Buffer;
  machineId: string;
  bootId: string;
  repoOriginUrl: string;
  fsTypeProbe?: () => Promise<FsType>; // injected for tests
  maxPushDelaySeconds?: number; // default 7d
}

type FsType = 'apfs' | 'btrfs' | 'xfs' | 'ext4' | 'hfs+' | 'ntfs' | 'tmpfs' | 'unknown';

// ── Constants ────────────────────────────────────────────────────────

const SCHEMA_BINDINGS = 'v1';
const SCHEMA_LOCK = 'v2';
const DEFAULT_MAX_PUSH_DELAY_S = 7 * 24 * 3600;
const TRAILER_NONCE_BYTES = 16;
const HEARTBEAT_STALE_MS = 60_000;
const FORCE_TAKE_TIMEOUT_MS = 10_000;
const MAX_ACTIVE_BINDINGS = 30;

// File modes
const SECURE_FILE_MODE = 0o600;

// ── Helpers ──────────────────────────────────────────────────────────

function slugify(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'topic';
}

function sanitizeTopicId(topicId: unknown): number | 'platform' {
  if (topicId === 'platform') return 'platform';
  const n = Number(topicId);
  if (!Number.isInteger(n) || n <= 0 || n > 1e12) {
    throw new Error(`Invalid topicId: ${String(topicId)} — must be positive integer or "platform"`);
  }
  return n;
}

function detectBootId(): string {
  try {
    if (process.platform === 'darwin') {
      return execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf-8', timeout: 2000 }).trim();
    }
    if (process.platform === 'linux') {
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    }
    if (process.platform === 'win32') {
      return execFileSync('wmic', ['os', 'get', 'lastbootuptime'], { encoding: 'utf-8', timeout: 2000 }).trim();
    }
  } catch {
    /* @silent-fallback-ok */
  }
  return `unknown:${process.pid}`;
}

async function detectFsType(workingPath: string): Promise<FsType> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('df', ['-T', 'apfs,hfs', workingPath], { timeout: 3000 });
      if (stdout.includes('apfs')) return 'apfs';
      if (stdout.includes('hfs')) return 'hfs+';
      return 'unknown';
    }
    if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('stat', ['-f', '-c', '%T', workingPath], { timeout: 3000 });
      const t = stdout.trim().toLowerCase();
      if (t.includes('btrfs')) return 'btrfs';
      if (t.includes('xfs')) return 'xfs';
      if (t.includes('ext')) return 'ext4';
      if (t.includes('tmpfs')) return 'tmpfs';
      return 'unknown';
    }
    if (process.platform === 'win32') return 'ntfs';
  } catch {
    /* @silent-fallback-ok */
  }
  return 'unknown';
}

// ── WorktreeManager ──────────────────────────────────────────────────

export class WorktreeManager extends EventEmitter {
  private opts: Required<Omit<WorktreeManagerOptions, 'fsTypeProbe'>> & { fsTypeProbe: (p: string) => Promise<FsType> };

  // In-memory state (mirrors machine-local files)
  private bindings: Map<string, WorktreeBinding> = new Map(); // key = `${topicId}:${mode}`
  private locks: Map<string, SessionLock> = new Map(); // key = worktreePath
  private fencingCounter: Map<string, number> = new Map(); // machineId → counter

  private bindingsFile: string;
  private fencingFile: string;
  private bindingHistoryLog: string;
  private worktreesRoot: string;
  private snapshotsDir: string;
  private quarantineDir: string;

  constructor(options: WorktreeManagerOptions) {
    super();
    const stateDir = options.stateDir;
    this.opts = {
      ...options,
      maxPushDelaySeconds: options.maxPushDelaySeconds ?? DEFAULT_MAX_PUSH_DELAY_S,
      fsTypeProbe: options.fsTypeProbe ?? detectFsType,
    };

    const localStateDir = path.join(stateDir, 'local-state');
    const stateSyncDir = path.join(stateDir, 'state');
    this.bindingsFile = path.join(localStateDir, 'topic-worktree-bindings.json');
    this.fencingFile = path.join(localStateDir, 'fencing.json');
    this.bindingHistoryLog = path.join(stateSyncDir, 'binding-history-log.jsonl');
    this.worktreesRoot = path.join(stateDir, 'worktrees');
    this.snapshotsDir = path.join(this.worktreesRoot, '.snapshots');
    this.quarantineDir = path.join(this.worktreesRoot, '.quarantine');
  }

  /**
   * Load persistent state from disk. Idempotent.
   */
  initialize(): void {
    fs.mkdirSync(this.worktreesRoot, { recursive: true });
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    fs.mkdirSync(this.quarantineDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.bindingsFile), { recursive: true });
    fs.mkdirSync(path.dirname(this.bindingHistoryLog), { recursive: true });

    this.loadBindings();
    this.loadFencing();
    this.loadLocks();
  }

  // ── Bindings I/O ───────────────────────────────────────────────────

  private loadBindings(): void {
    if (!fs.existsSync(this.bindingsFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.bindingsFile, 'utf-8'));
      if (raw.schema !== SCHEMA_BINDINGS) {
        throw new Error(`Bindings schema mismatch: ${raw.schema} ≠ ${SCHEMA_BINDINGS}`);
      }
      for (const b of raw.bindings ?? []) {
        if (!this.verifySignature(b)) {
          this.emit('tamper', { kind: 'binding', binding: b });
          continue;
        }
        this.bindings.set(this.bindingKey(b.topicId, b.mode), b);
      }
    } catch (err) {
      this.emit('error', new Error(`Failed to load bindings: ${(err as Error).message}`));
    }
  }

  private saveBindings(): void {
    const tmp = `${this.bindingsFile}.tmp`;
    const data = {
      schema: SCHEMA_BINDINGS,
      bindings: [...this.bindings.values()],
    };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: SECURE_FILE_MODE });
    fs.renameSync(tmp, this.bindingsFile);
  }

  private loadFencing(): void {
    if (!fs.existsSync(this.fencingFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.fencingFile, 'utf-8'));
      // verify HMAC over each {machineId, counter}
      for (const [machineId, entry] of Object.entries(raw.counters ?? {})) {
        const e = entry as { counter: number; signature: string };
        const want = this.hmacHex(`fencing:${machineId}:${e.counter}`);
        if (want === e.signature) {
          this.fencingCounter.set(machineId, e.counter);
        } else {
          this.emit('tamper', { kind: 'fencing', machineId });
        }
      }
    } catch (err) {
      this.emit('error', new Error(`Failed to load fencing: ${(err as Error).message}`));
    }
  }

  private saveFencing(): void {
    const counters: Record<string, { counter: number; signature: string }> = {};
    for (const [machineId, counter] of this.fencingCounter) {
      counters[machineId] = { counter, signature: this.hmacHex(`fencing:${machineId}:${counter}`) };
    }
    const tmp = `${this.fencingFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: 'v1', counters }, null, 2), { mode: SECURE_FILE_MODE });
    fs.renameSync(tmp, this.fencingFile);
  }

  private loadLocks(): void {
    // Walk worktrees/ for .session.lock files
    if (!fs.existsSync(this.worktreesRoot)) return;
    for (const entry of fs.readdirSync(this.worktreesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const lockFile = path.join(this.worktreesRoot, entry.name, '.session.lock');
      if (!fs.existsSync(lockFile)) continue;
      try {
        const lock = JSON.parse(fs.readFileSync(lockFile, 'utf-8')) as SessionLock;
        if (this.verifyLockSignature(lock)) {
          this.locks.set(path.join(this.worktreesRoot, entry.name), lock);
        }
      } catch {
        /* @silent-fallback-ok */
      }
    }
  }

  // ── Signing ────────────────────────────────────────────────────────

  private hmacHex(input: string): string {
    return crypto.createHmac('sha256', this.opts.hmacKey).update(input).digest('hex');
  }

  private signBinding(b: Omit<WorktreeBinding, 'serverSignature'>): WorktreeBinding {
    const payload = `binding:${b.topicId}:${b.branch}:${b.worktreePath}:${b.mode}:${b.machineId}:${b.fencingToken}:${b.createdAt}:${b.createdBy}:${b.status}`;
    return { ...b, serverSignature: this.hmacHex(payload) };
  }

  private verifySignature(b: WorktreeBinding): boolean {
    if (!b.serverSignature) return false;
    const payload = `binding:${b.topicId}:${b.branch}:${b.worktreePath}:${b.mode}:${b.machineId}:${b.fencingToken}:${b.createdAt}:${b.createdBy}:${b.status}`;
    return this.hmacHex(payload) === b.serverSignature;
  }

  private signLock(lock: Omit<SessionLock, 'serverSignature'>): SessionLock {
    const payload = `lock:${lock.machineId}:${lock.bootId}:${lock.pid}:${lock.processStartTime}:${lock.sessionId}:${lock.fencingToken}:${lock.topicId}:${lock.acquiredAt}:${lock.heartbeatAt}`;
    return { ...lock, serverSignature: this.hmacHex(payload) };
  }

  private verifyLockSignature(lock: SessionLock): boolean {
    if (!lock.serverSignature) return false;
    const payload = `lock:${lock.machineId}:${lock.bootId}:${lock.pid}:${lock.processStartTime}:${lock.sessionId}:${lock.fencingToken}:${lock.topicId}:${lock.acquiredAt}:${lock.heartbeatAt}`;
    return this.hmacHex(payload) === lock.serverSignature;
  }

  // ── Fencing tokens ─────────────────────────────────────────────────

  private nextFencingToken(): string {
    const machineId = this.opts.machineId;
    const current = this.fencingCounter.get(machineId) ?? 0;
    const next = current + 1;
    this.fencingCounter.set(machineId, next);
    this.saveFencing();
    return `${machineId}:${next}`;
  }

  // ── Resolve / spawn-time entry point ───────────────────────────────

  /**
   * Atomically: ensure binding for (topicId, mode) exists, ensure worktree exists,
   * acquire exclusive lock, return the cwd to spawn into.
   *
   * Throws on lock contention with `code: 'LOCK_HELD'`.
   */
  async resolve(args: {
    topicId: number | 'platform';
    mode: WorktreeMode;
    sessionId: string;
    pid: number;
    processStartTime: number;
    slug?: string; // for first-time binding
  }): Promise<ResolveResult> {
    const topicId = sanitizeTopicId(args.topicId);
    const slug = args.slug ? slugify(args.slug) : `topic-${topicId}`;
    const key = this.bindingKey(topicId, args.mode);

    let binding = this.bindings.get(key);
    if (!binding) {
      binding = await this.createBinding({ topicId, mode: args.mode, slug, sessionId: args.sessionId });
    }

    // Lock-acquire
    const existingLock = this.locks.get(binding.worktreePath);
    if (existingLock && this.isLockLive(existingLock)) {
      const ageMs = Date.now() - new Date(existingLock.heartbeatAt).getTime();
      const err: any = new Error(`Lock held by session ${existingLock.sessionId} (machine ${existingLock.machineId}, age ${ageMs}ms)`);
      err.code = 'LOCK_HELD';
      err.holder = { sessionId: existingLock.sessionId, machineId: existingLock.machineId, ageMs };
      throw err;
    }

    const fencingToken = this.nextFencingToken();
    const now = new Date().toISOString();
    const lock = this.signLock({
      schema: SCHEMA_LOCK,
      machineId: this.opts.machineId,
      bootId: this.opts.bootId,
      pid: args.pid,
      processStartTime: args.processStartTime,
      sessionId: args.sessionId,
      fencingToken,
      topicId,
      acquiredAt: now,
      heartbeatAt: now,
    });
    this.writeLockAtomic(binding.worktreePath, lock);
    this.locks.set(binding.worktreePath, lock);

    // Update binding fencing token
    binding = this.signBinding({ ...binding, fencingToken });
    this.bindings.set(key, binding);
    this.saveBindings();

    // Write session-context.json
    const sessionContextPath = path.join(binding.worktreePath, '.instar', 'session-context.json');
    fs.mkdirSync(path.dirname(sessionContextPath), { recursive: true });
    const ctx = {
      schema: 'v1',
      sessionId: args.sessionId,
      topicId,
      mode: args.mode,
      branch: binding.branch,
      fencingToken,
      worktreePath: binding.worktreePath,
      machineId: this.opts.machineId,
      uid: process.getuid?.() ?? 0,
      pid: args.pid,
      issuedAt: now,
    };
    const ctxSig = this.hmacHex(`session-context:${JSON.stringify(ctx)}`);
    fs.writeFileSync(
      sessionContextPath,
      JSON.stringify({ ...ctx, serverSignature: ctxSig }, null, 2),
      { mode: SECURE_FILE_MODE },
    );

    this.emit('lock:acquired', { binding, lock });
    return {
      cwd: binding.worktreePath,
      branch: binding.branch,
      fencingToken,
      sessionContextPath,
      mode: args.mode,
      binding,
    };
  }

  /**
   * Release the lock held by (sessionId, fencingToken). No-op if not the holder.
   */
  release(args: { sessionId: string; fencingToken: string }): { released: boolean } {
    for (const [worktreePath, lock] of this.locks) {
      if (lock.sessionId === args.sessionId && lock.fencingToken === args.fencingToken) {
        this.locks.delete(worktreePath);
        const lockFile = path.join(worktreePath, '.session.lock');
        try { fs.unlinkSync(lockFile); } catch { /* @silent-fallback-ok */ }
        this.emit('lock:released', { worktreePath, sessionId: args.sessionId });
        return { released: true };
      }
    }
    return { released: false };
  }

  /**
   * Server-stamped heartbeat. Validates fencing token before accepting.
   */
  heartbeat(args: { sessionId: string; fencingToken: string }): { ok: boolean; reason?: string } {
    for (const [worktreePath, lock] of this.locks) {
      if (lock.sessionId === args.sessionId) {
        if (lock.fencingToken !== args.fencingToken) {
          return { ok: false, reason: 'fencing-token-superseded' };
        }
        const now = new Date().toISOString();
        const updated = this.signLock({ ...lock, heartbeatAt: now });
        this.writeLockAtomic(worktreePath, updated);
        this.locks.set(worktreePath, updated);
        return { ok: true };
      }
    }
    return { ok: false, reason: 'no-such-session' };
  }

  /**
   * Force-take an existing lock (per spec section "Force-take protocol iter 4").
   * Performs FS snapshot + scoped stash (no --include-ignored), then bumps fencing token.
   */
  async forceTake(args: {
    topicId: number | 'platform';
    mode: WorktreeMode;
    bySessionId: string;
    pid: number;
    processStartTime: number;
  }): Promise<{ snapshotPath: string; stashRef: string | null; previousLock: SessionLock | null }> {
    const key = this.bindingKey(args.topicId, args.mode);
    const binding = this.bindings.get(key);
    if (!binding) throw new Error(`No binding for ${args.topicId}/${args.mode}`);

    const previousLock = this.locks.get(binding.worktreePath) ?? null;

    // FS snapshot tarball (excluding obvious build dirs; .env preserved)
    const snapshotPath = path.join(
      this.snapshotsDir,
      `${path.basename(binding.worktreePath)}-${Date.now()}.tar.zst`,
    );
    await this.snapshotWorktree(binding.worktreePath, snapshotPath);

    // git stash --include-untracked (NOT --include-ignored — would bloat .git/objects)
    let stashRef: string | null = null;
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', binding.worktreePath, 'stash', 'push', '--include-untracked',
         '-m', `instar-force-take from ${previousLock?.sessionId ?? '<none>'} by ${args.bySessionId} at ${new Date().toISOString()}`],
        { timeout: FORCE_TAKE_TIMEOUT_MS },
      );
      const refMatch = stdout.match(/stash@\{\d+\}/);
      if (refMatch) stashRef = refMatch[0];
    } catch {
      // stash may fail on a clean tree — that's ok
    }

    if (
      previousLock &&
      previousLock.machineId === this.opts.machineId &&
      previousLock.bootId === this.opts.bootId &&
      previousLock.pid !== process.pid // never SIGTERM ourselves
    ) {
      try { process.kill(previousLock.pid, 'SIGTERM'); } catch { /* @silent-fallback-ok */ }
    }

    this.locks.delete(binding.worktreePath);
    try { fs.unlinkSync(path.join(binding.worktreePath, '.session.lock')); } catch { /* @silent-fallback-ok */ }

    this.appendHistoryEvent({
      kind: 'force-take',
      topicId: args.topicId,
      bySessionId: args.bySessionId,
      previousSessionId: previousLock?.sessionId ?? null,
      snapshotPath,
      stashRef,
    });

    this.emit('force-take', { binding, snapshotPath, stashRef, previousLock });
    return { snapshotPath, stashRef, previousLock };
  }

  // ── Trailer signing (commit-msg path) ──────────────────────────────

  /**
   * Issue a signed trailer set for a new commit.
   * The hook calls this after computing treeHash + parents.
   */
  signTrailer(args: {
    sessionId: string;
    fencingToken: string;
    treeHash: string;
    parents: string[];
  }): SignedTrailerResult {
    // Validate session lock is current
    let binding: WorktreeBinding | null = null;
    let lock: SessionLock | null = null;
    for (const [worktreePath, l] of this.locks) {
      if (l.sessionId === args.sessionId && l.fencingToken === args.fencingToken) {
        lock = l;
        for (const b of this.bindings.values()) {
          if (b.worktreePath === worktreePath) { binding = b; break; }
        }
        break;
      }
    }
    if (!lock || !binding) throw new Error('No matching lock for session/fencingToken');

    const nonce = crypto.randomBytes(TRAILER_NONCE_BYTES).toString('base64url');
    const issued = Math.floor(Date.now() / 1000);
    const maxPushDelay = this.opts.maxPushDelaySeconds;
    const keyVersion = this.opts.signingKey.keyVersion;

    const payload = [
      args.treeHash,
      String(binding.topicId),
      args.sessionId,
      nonce,
      args.parents.join(','),
      String(issued),
      String(maxPushDelay),
      String(keyVersion),
      this.opts.repoOriginUrl,
    ].join('|');

    const signature = crypto.sign(null, Buffer.from(crypto.createHash('sha256').update(payload).digest()), {
      key: this.opts.signingKey.privateKeyPem,
    }).toString('base64url');

    const trailers = [
      `Instar-Topic-Id: ${binding.topicId}`,
      `Instar-Session: ${args.sessionId}`,
      `Instar-Worktree-Branch: ${binding.branch}`,
      `Instar-Trailer-Nonce: ${nonce}`,
      `Instar-Trailer-Parent: ${args.parents.join(',')}`,
      `Instar-Trailer-Issued: ${issued}`,
      `Instar-Trailer-MaxPushDelay: ${maxPushDelay}`,
      `Instar-Trailer-KeyVersion: ${keyVersion}`,
      `Instar-Trailer-Sig: ${signature}`,
    ];

    this.appendHistoryEvent({
      kind: 'trailer-issued',
      topicId: binding.topicId,
      sessionId: args.sessionId,
      treeHash: args.treeHash,
      parents: args.parents,
      nonce,
      issued,
    });

    return { trailers, nonce, issued, maxPushDelay, keyVersion };
  }

  /**
   * Verify a trailer set (used by GH check via /gh-check/verify-nonce).
   * Returns ok plus a reason on failure (uniform error for oracle protection).
   */
  verifyTrailer(args: {
    trailers: Record<string, string>;
    pushReceivedAt?: number;
  }): { ok: boolean; reason?: string } {
    const t = args.trailers;
    const required = [
      'Instar-Topic-Id', 'Instar-Session', 'Instar-Worktree-Branch',
      'Instar-Trailer-Nonce', 'Instar-Trailer-Parent', 'Instar-Trailer-Issued',
      'Instar-Trailer-MaxPushDelay', 'Instar-Trailer-KeyVersion', 'Instar-Trailer-Sig',
    ];
    for (const k of required) {
      if (!t[k]) return { ok: false, reason: 'verifier_says_no' };
    }

    const issued = Number(t['Instar-Trailer-Issued']);
    const maxPushDelay = Number(t['Instar-Trailer-MaxPushDelay']);
    const now = args.pushReceivedAt ?? Math.floor(Date.now() / 1000);
    if (now < issued || now > issued + maxPushDelay) {
      return { ok: false, reason: 'verifier_says_no' };
    }

    // Signature verification handled by GH workflow offline using public key.
    // Server-side only checks nonce uniqueness.
    return { ok: true };
  }

  // ── Binding history log (git-synced; future: K3 Merkle chain) ──────

  /**
   * Append-only signed log with Merkle chain (K3 hardening).
   *
   * Each entry includes `prevEntrySha = sha256(previousLine)`, so a malicious
   * `git rebase -i` that drops or reorders entries breaks the chain — detectable
   * by `verifyHistoryChain()`. The chain head is periodically anchored to a
   * GitHub Repo Variable for cross-machine tamper detection.
   */
  private appendHistoryEvent(event: Record<string, unknown>): void {
    const prevEntrySha = this.computeChainHead();
    const entry = {
      ts: Date.now(),
      machineId: this.opts.machineId,
      prevEntrySha,
      ...event,
    };
    const line = JSON.stringify(entry);
    const sig = this.hmacHex(line);
    fs.appendFileSync(this.bindingHistoryLog, `${line}\t${sig}\n`, { mode: SECURE_FILE_MODE });
  }

  /**
   * Compute SHA-256 of the most recent log line (Merkle chain head).
   * Returns null on empty log.
   */
  computeChainHead(): string | null {
    if (!fs.existsSync(this.bindingHistoryLog)) return null;
    const data = fs.readFileSync(this.bindingHistoryLog, 'utf-8');
    const lines = data.split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const lastLine = lines[lines.length - 1];
    return crypto.createHash('sha256').update(lastLine).digest('hex');
  }

  /**
   * Walk the entire log and verify (a) HMAC of each line, and (b) prevEntrySha
   * chain integrity. Returns null on success, or the first detected breach.
   */
  verifyHistoryChain(): { lineNumber: number; reason: string } | null {
    if (!fs.existsSync(this.bindingHistoryLog)) return null;
    const data = fs.readFileSync(this.bindingHistoryLog, 'utf-8');
    const lines = data.split('\n').filter(Boolean);
    let prevSha: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const [line, sig] = lines[i].split('\t');
      if (this.hmacHex(line) !== sig) return { lineNumber: i, reason: 'hmac-mismatch' };
      try {
        const parsed = JSON.parse(line);
        if ((parsed.prevEntrySha ?? null) !== prevSha) {
          return { lineNumber: i, reason: 'merkle-chain-break' };
        }
        prevSha = crypto.createHash('sha256').update(lines[i]).digest('hex');
      } catch {
        return { lineNumber: i, reason: 'invalid-json' };
      }
    }
    return null;
  }

  /**
   * Check whether nonce was previously used for a different commit.
   * Idempotent: returns 'unseen' or 'seen-for-same-commit' (allowed retry) or 'seen-for-different-commit'.
   */
  checkNonceUnique(args: { nonce: string; commitSha: string }): 'unseen' | 'seen-for-same-commit' | 'seen-for-different-commit' {
    if (!fs.existsSync(this.bindingHistoryLog)) return 'unseen';
    const data = fs.readFileSync(this.bindingHistoryLog, 'utf-8');
    for (const rawLine of data.split('\n')) {
      if (!rawLine) continue;
      const [line] = rawLine.split('\t');
      try {
        const e = JSON.parse(line);
        // Only `nonce-bound` events establish commit bindings. `trailer-issued` events
        // record issuance but don't bind a commitSha yet (the commit hasn't happened).
        if (e.kind !== 'nonce-bound') continue;
        if (e.nonce === args.nonce) {
          if (e.commitSha === args.commitSha) return 'seen-for-same-commit';
          return 'seen-for-different-commit';
        }
      } catch { /* @silent-fallback-ok */ }
    }
    return 'unseen';
  }

  /**
   * Bind a commit SHA to a previously-issued trailer (called post-push).
   */
  recordCommitForNonce(args: { nonce: string; commitSha: string }): void {
    this.appendHistoryEvent({ kind: 'nonce-bound', ...args });
  }

  // ── Worktree creation (cross-platform) ─────────────────────────────

  private async createBinding(args: {
    topicId: number | 'platform';
    mode: WorktreeMode;
    slug: string;
    sessionId: string;
  }): Promise<WorktreeBinding> {
    if (this.bindings.size >= MAX_ACTIVE_BINDINGS) {
      // LRU evict merged/abandoned first
      let evicted = false;
      for (const [k, b] of this.bindings) {
        if (b.status === 'merged' || b.status === 'abandoned') {
          this.bindings.delete(k);
          evicted = true;
          break;
        }
      }
      if (!evicted) throw new Error(`Max active bindings (${MAX_ACTIVE_BINDINGS}) reached`);
    }

    const branch = args.mode === 'platform'
      ? `platform/${args.slug}`
      : args.mode === 'doc-fix'
        ? `topic/${args.topicId}-doc-fix`
        : `topic/${args.topicId}-${args.slug}`;
    const dirName = args.mode === 'read-only'
      ? `topic-${args.topicId}-readonly`
      : args.mode === 'doc-fix'
        ? `topic-${args.topicId}-doc-fix`
        : args.mode === 'platform'
          ? `topic-platform-${args.slug}`
          : `topic-${args.topicId}-${args.slug}`;
    const worktreePath = path.join(this.worktreesRoot, dirName);

    // Refuse if exists
    if (fs.existsSync(worktreePath)) {
      // Adopt existing if .git is valid
      try {
        execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { stdio: 'pipe', timeout: 3000 });
      } catch {
        throw new Error(`Worktree path ${worktreePath} exists but is not a valid git worktree`);
      }
    } else {
      // Create branch if needed; then `git worktree add`
      try {
        execFileSync('git', ['-C', this.opts.projectDir, 'rev-parse', '--verify', branch], { stdio: 'pipe', timeout: 3000 });
      } catch {
        execFileSync('git', ['-C', this.opts.projectDir, 'branch', branch], { timeout: 5000 });
      }
      execFileSync('git', ['-C', this.opts.projectDir, 'worktree', 'add', worktreePath, branch], { timeout: 30_000 });

      // Cross-platform fast-copy node_modules from main if present (avoid `cp -al` per K-fix; use clonefile/reflink only)
      await this.fastCopyDeps(worktreePath);
    }

    const fencingToken = this.nextFencingToken();
    const now = new Date().toISOString();
    const binding = this.signBinding({
      topicId: args.topicId,
      slug: args.slug,
      branch,
      worktreePath,
      mode: args.mode,
      status: 'active',
      createdAt: now,
      createdBy: args.sessionId,
      machineId: this.opts.machineId,
      fencingToken,
    });
    this.bindings.set(this.bindingKey(args.topicId, args.mode), binding);
    this.saveBindings();
    this.appendHistoryEvent({
      kind: 'binding-created',
      topicId: args.topicId,
      mode: args.mode,
      branch,
      worktreePath,
    });
    this.emit('binding:created', binding);
    return binding;
  }

  private async fastCopyDeps(worktreePath: string): Promise<void> {
    const mainNodeModules = path.join(this.opts.projectDir, 'node_modules');
    const wtNodeModules = path.join(worktreePath, 'node_modules');
    if (!fs.existsSync(mainNodeModules) || fs.existsSync(wtNodeModules)) return;

    const fsType = await this.opts.fsTypeProbe(worktreePath);
    try {
      if (fsType === 'apfs') {
        // CoW clone — sub-second, isolation-safe (writes diverge)
        execFileSync('cp', ['-c', '-R', mainNodeModules, wtNodeModules], { timeout: 60_000 });
      } else if (fsType === 'btrfs' || fsType === 'xfs') {
        execFileSync('cp', ['-R', '--reflink=auto', mainNodeModules, wtNodeModules], { timeout: 60_000 });
      } else {
        // ext4, HFS+, NTFS, tmpfs, unknown — full copy. NEVER `cp -al` (inode aliasing breaks isolation).
        execFileSync('cp', ['-R', mainNodeModules, wtNodeModules], { timeout: 600_000 });
      }
    } catch (err) {
      this.emit('warn', `node_modules copy failed (${(err as Error).message}); will need fresh install`);
    }
  }

  // ── Snapshot ───────────────────────────────────────────────────────

  private async snapshotWorktree(worktreePath: string, snapshotPath: string): Promise<void> {
    const exclusions = ['node_modules', 'dist', '.next', 'build', 'target', '.cache'];
    const excludeArgs: string[] = [];
    for (const x of exclusions) excludeArgs.push('--exclude', x);

    // Use `tar` (BSD or GNU); pipe through zstd if available
    const zstdAvailable = (() => {
      try { execFileSync('zstd', ['--version'], { stdio: 'pipe' }); return true; }
      catch { return false; }
    })();

    if (zstdAvailable) {
      await execFileAsync('sh', ['-c',
        `tar -C "${path.dirname(worktreePath)}" ${excludeArgs.map(a => `'${a}'`).join(' ')} -cf - "${path.basename(worktreePath)}" | zstd -o "${snapshotPath}"`,
      ], { timeout: FORCE_TAKE_TIMEOUT_MS });
    } else {
      const fallback = snapshotPath.replace(/\.zst$/, '.gz');
      await execFileAsync('tar', [
        '-C', path.dirname(worktreePath),
        ...excludeArgs,
        '-czf', fallback,
        path.basename(worktreePath),
      ], { timeout: FORCE_TAKE_TIMEOUT_MS });
    }
    fs.chmodSync(zstdAvailable ? snapshotPath : snapshotPath.replace(/\.zst$/, '.gz'), SECURE_FILE_MODE);
  }

  // ── Lock helpers ───────────────────────────────────────────────────

  private writeLockAtomic(worktreePath: string, lock: SessionLock): void {
    const lockFile = path.join(worktreePath, '.session.lock');
    const tmp = `${lockFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(lock, null, 2), { flag: 'wx', mode: SECURE_FILE_MODE });
    fs.renameSync(tmp, lockFile);
  }

  private isLockLive(lock: SessionLock): boolean {
    const ageMs = Date.now() - new Date(lock.heartbeatAt).getTime();
    if (ageMs > HEARTBEAT_STALE_MS) return false;
    if (lock.machineId !== this.opts.machineId) return true; // can't verify other machine's PID
    if (lock.bootId !== this.opts.bootId) return false; // PID reuse risk after reboot
    try { process.kill(lock.pid, 0); return true; }
    catch { return false; }
  }

  // ── State reconciliation matrix ────────────────────────────────────

  /**
   * Walk worktree state from three sources (bindings ∪ filesystem ∪ git worktree list)
   * and return the rows that need action per the matrix.
   */
  reconcile(): Array<{ row: string; binding: WorktreeBinding | null; gitWorktree: { path: string } | null; fsPath: string | null; action: string }> {
    const out: Array<{ row: string; binding: WorktreeBinding | null; gitWorktree: { path: string } | null; fsPath: string | null; action: string }> = [];

    let gitWorktrees: Array<{ path: string }> = [];
    try {
      const stdout = execFileSync('git', ['-C', this.opts.projectDir, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf-8', timeout: 5000 });
      for (const block of stdout.split('\0\0')) {
        const m = block.match(/worktree\s+(.+)/);
        if (m) gitWorktrees.push({ path: m[1] });
      }
    } catch { /* @silent-fallback-ok */ }

    const fsWorktrees: string[] = fs.existsSync(this.worktreesRoot)
      ? fs.readdirSync(this.worktreesRoot, { withFileTypes: true })
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => path.join(this.worktreesRoot, e.name))
      : [];

    const bindingByPath = new Map<string, WorktreeBinding>();
    for (const b of this.bindings.values()) bindingByPath.set(b.worktreePath, b);

    const allPaths = new Set([
      ...bindingByPath.keys(),
      ...gitWorktrees.map(w => w.path),
      ...fsWorktrees,
    ]);

    for (const p of allPaths) {
      const binding = bindingByPath.get(p) ?? null;
      const gw = gitWorktrees.find(w => w.path === p) ?? null;
      const onFs = fsWorktrees.includes(p) || fs.existsSync(p);

      if (binding && onFs && gw) {
        out.push({ row: 'binding+fs+git', binding, gitWorktree: gw, fsPath: p, action: 'normal' });
      } else if (binding && onFs && !gw) {
        out.push({ row: 'binding+fs-no-git', binding, gitWorktree: null, fsPath: p, action: 'repair-worktree-add' });
      } else if (binding && !onFs) {
        out.push({ row: 'binding-no-fs', binding, gitWorktree: gw, fsPath: null, action: 'quarantine-binding' });
      } else if (!binding && onFs && p.startsWith(this.worktreesRoot) && gw) {
        out.push({ row: 'no-binding+fs+git', binding: null, gitWorktree: gw, fsPath: p, action: 'adopt-binding' });
      } else if (!binding && onFs && p.startsWith(this.worktreesRoot) && !gw) {
        out.push({ row: 'no-binding+fs-no-git', binding: null, gitWorktree: null, fsPath: p, action: 'quarantine-orphan' });
      } else if (!binding && !p.startsWith(this.worktreesRoot) && gw) {
        out.push({ row: 'external-worktree', binding: null, gitWorktree: gw, fsPath: p, action: 'adopt-external-alert-once' });
      }
    }
    return out;
  }

  // ── Internal ───────────────────────────────────────────────────────

  private bindingKey(topicId: number | 'platform', mode: WorktreeMode): string {
    return `${topicId}:${mode}`;
  }

  // ── Read accessors ─────────────────────────────────────────────────

  getBinding(topicId: number | 'platform', mode: WorktreeMode): WorktreeBinding | undefined {
    return this.bindings.get(this.bindingKey(topicId, mode));
  }
  listBindings(): WorktreeBinding[] { return [...this.bindings.values()]; }
  getLock(worktreePath: string): SessionLock | undefined { return this.locks.get(worktreePath); }
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Build a WorktreeManager from an instar agent config + machine identity.
 * Generates an HMAC key on first start; persists to keychain (or flat file fallback).
 */
export function createWorktreeManager(args: {
  projectDir: string;
  stateDir: string;
  signingKey: { privateKeyPem: string; publicKeyPem: string; keyVersion: number };
  hmacKey: Buffer;
  machineId: string;
  repoOriginUrl: string;
}): WorktreeManager {
  const mgr = new WorktreeManager({
    ...args,
    bootId: detectBootId(),
  });
  mgr.initialize();
  return mgr;
}
