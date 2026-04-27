// safe-git-allow: this file is the single funnel point for destructive fs invocations.
/**
 * SafeFsExecutor — the single funnel for destructive filesystem invocations.
 *
 * Parallel structure to SafeGitExecutor. Wraps `fs.rm`, `fs.rmSync`,
 * `fs.unlink`, `fs.unlinkSync`, `fs.rmdir`, `fs.rmdirSync` (and their
 * promises-API counterparts). Each wrapper:
 *
 *   1. Canonicalizes `target` via `realpathSync` (or nearest-existing-ancestor
 *      if the target itself doesn't exist — `assertNotInstarSourceTree`
 *      handles this internally).
 *   2. Calls `assertNotInstarSourceTree(target, operation)`. On failure,
 *      throws SourceTreeGuardError BEFORE touching disk.
 *   3. Performs the actual fs operation.
 *   4. Appends a JSON line to .instar/audit/destructive-ops.jsonl.
 *
 * See docs/specs/COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md.
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  assertNotInstarSourceTree,
  SourceTreeGuardError,
} from './SourceTreeGuard.js';
import { appendAuditEntry } from './SafeGitExecutor.js';

export interface SafeFsOptions {
  /** Caller label for error messages and audit log. */
  operation: string;
}

export type SafeRmOptions = fs.RmOptions & SafeFsOptions;
export type SafeRmDirOptions = fs.RmDirOptions & SafeFsOptions;

function captureCallerFrame(): string {
  const e = new Error();
  const stack = (e.stack || '').split('\n');
  return (stack[3] || stack[2] || '').trim();
}

function audit(
  fnName: string,
  operation: string,
  target: string,
  outcome: 'allowed' | 'denied',
  reason?: string,
): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    executor: 'fs',
    operation,
    verb: fnName,
    target,
    outcome,
    caller: captureCallerFrame(),
  };
  if (reason !== undefined) entry.reason = reason;
  appendAuditEntry(entry as never);
}

function canonicalizeTarget(target: string): string {
  try {
    return fs.realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

function guard(target: string, operation: string, fnName: string): string {
  const canonical = canonicalizeTarget(target);
  try {
    assertNotInstarSourceTree(canonical, operation);
  } catch (err) {
    if (err instanceof SourceTreeGuardError) {
      audit(fnName, operation, canonical, 'denied', err.message);
    }
    throw err;
  }
  return canonical;
}

// ── Public API ──────────────────────────────────────────────────────

export class SafeFsExecutor {
  /** Async fs.promises.rm wrapper. */
  static async safeRm(target: string, opts: SafeRmOptions): Promise<void> {
    const { operation, ...rmOpts } = opts;
    const canonical = guard(target, operation, 'safeRm');
    try {
      await fsp.rm(target, rmOpts);
      audit('safeRm', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRm', operation, canonical, 'denied', `rm-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Sync fs.rmSync wrapper. */
  static safeRmSync(target: string, opts: SafeRmOptions): void {
    const { operation, ...rmOpts } = opts;
    const canonical = guard(target, operation, 'safeRmSync');
    try {
      fs.rmSync(target, rmOpts);
      audit('safeRmSync', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRmSync', operation, canonical, 'denied', `rm-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Async fs.promises.unlink wrapper. */
  static async safeUnlink(target: string, opts: SafeFsOptions): Promise<void> {
    const canonical = guard(target, opts.operation, 'safeUnlink');
    try {
      await fsp.unlink(target);
      audit('safeUnlink', opts.operation, canonical, 'allowed');
    } catch (err) {
      audit('safeUnlink', opts.operation, canonical, 'denied', `unlink-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Sync fs.unlinkSync wrapper. */
  static safeUnlinkSync(target: string, opts: SafeFsOptions): void {
    const canonical = guard(target, opts.operation, 'safeUnlinkSync');
    try {
      fs.unlinkSync(target);
      audit('safeUnlinkSync', opts.operation, canonical, 'allowed');
    } catch (err) {
      audit('safeUnlinkSync', opts.operation, canonical, 'denied', `unlink-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Async fs.promises.rmdir wrapper. */
  static async safeRmdir(target: string, opts: SafeRmDirOptions): Promise<void> {
    const { operation, ...rmOpts } = opts;
    const canonical = guard(target, operation, 'safeRmdir');
    try {
      await fsp.rmdir(target, rmOpts);
      audit('safeRmdir', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRmdir', operation, canonical, 'denied', `rmdir-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Sync fs.rmdirSync wrapper. */
  static safeRmdirSync(target: string, opts: SafeRmDirOptions): void {
    const { operation, ...rmOpts } = opts;
    const canonical = guard(target, operation, 'safeRmdirSync');
    try {
      fs.rmdirSync(target, rmOpts);
      audit('safeRmdirSync', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRmdirSync', operation, canonical, 'denied', `rmdir-error: ${(err as Error).message}`);
      throw err;
    }
  }
}

// Re-export the guard error so call-site catch blocks don't have to import
// from two modules.
export { SourceTreeGuardError };
