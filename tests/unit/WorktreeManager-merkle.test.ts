/**
 * Merkle-chain integrity tests for binding-history-log.jsonl (K3 hardening).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTwoSessionHarness, type HarnessHandle } from '../fixtures/two-session-harness.js';

let h: HarnessHandle;
beforeEach(async () => { h = await createTwoSessionHarness(); });
afterEach(() => { h.cleanup(); });

describe('K3 Merkle chain on binding-history-log', () => {
  it('appendHistoryEvent populates prevEntrySha forming a valid chain', async () => {
    const s = await h.spawn({ topicId: 2317, mode: 'dev' });
    // safe-git-allow: incremental-migration
    const treeHash = execFileSync('git', ['-C', s.cwd!, 'write-tree'], { encoding: 'utf-8' }).trim();
    h.manager.signTrailer({ sessionId: s.sessionId, fencingToken: s.fencingToken!, treeHash, parents: ['0'.repeat(40)] });
    h.manager.signTrailer({ sessionId: s.sessionId, fencingToken: s.fencingToken!, treeHash, parents: ['0'.repeat(40)] });

    expect(h.manager.verifyHistoryChain()).toBeNull();
  });

  it('detects breach when an entry is dropped (rebase-style tampering)', async () => {
    const s = await h.spawn({ topicId: 2317, mode: 'dev' });
    // safe-git-allow: incremental-migration
    const treeHash = execFileSync('git', ['-C', s.cwd!, 'write-tree'], { encoding: 'utf-8' }).trim();
    h.manager.signTrailer({ sessionId: s.sessionId, fencingToken: s.fencingToken!, treeHash, parents: ['0'.repeat(40)] });
    h.manager.signTrailer({ sessionId: s.sessionId, fencingToken: s.fencingToken!, treeHash, parents: ['0'.repeat(40)] });
    h.manager.signTrailer({ sessionId: s.sessionId, fencingToken: s.fencingToken!, treeHash, parents: ['0'.repeat(40)] });

    // Tamper: remove the middle line
    const logPath = path.join(h.stateDir, 'state', 'binding-history-log.jsonl');
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    const tampered = [lines[0], lines[2]].join('\n') + '\n';
    fs.writeFileSync(logPath, tampered);

    const breach = h.manager.verifyHistoryChain();
    expect(breach).not.toBeNull();
    expect(breach!.reason).toBe('merkle-chain-break');
  });

  it('detects breach when a single line is corrupted (HMAC mismatch)', async () => {
    const s = await h.spawn({ topicId: 2317, mode: 'dev' });
    // safe-git-allow: incremental-migration
    const treeHash = execFileSync('git', ['-C', s.cwd!, 'write-tree'], { encoding: 'utf-8' }).trim();
    h.manager.signTrailer({ sessionId: s.sessionId, fencingToken: s.fencingToken!, treeHash, parents: ['0'.repeat(40)] });

    const logPath = path.join(h.stateDir, 'state', 'binding-history-log.jsonl');
    let content = fs.readFileSync(logPath, 'utf-8');
    // Flip a single bit in the JSON portion (before \t signature)
    content = content.replace(/"machineId":/g, '"machineXX":');
    fs.writeFileSync(logPath, content);

    const breach = h.manager.verifyHistoryChain();
    expect(breach).not.toBeNull();
    expect(breach!.reason).toBe('hmac-mismatch');
  });
});
