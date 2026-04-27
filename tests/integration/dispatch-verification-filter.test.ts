/**
 * Integration tests for the dispatch verification + relevance filter pipeline.
 *
 * Tests the end-to-end flow: receive dispatch → verify origin → check relevance
 * → log decision to journal. Validates Milestone 3 of the Discernment Layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DispatchVerifier } from '../../src/core/DispatchVerifier.js';
import { RelevanceFilter } from '../../src/core/RelevanceFilter.js';
import { ContextSnapshotBuilder } from '../../src/core/ContextSnapshotBuilder.js';
import { DispatchDecisionJournal } from '../../src/core/DispatchDecisionJournal.js';
import type { Dispatch } from '../../src/core/DispatchManager.js';
import type { SignedDispatch } from '../../src/core/DispatchVerifier.js';

function generateKeyPair() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function makeDispatch(overrides?: Partial<Dispatch>): Dispatch {
  return {
    dispatchId: overrides?.dispatchId ?? `disp-${Math.random().toString(36).slice(2)}`,
    type: overrides?.type ?? 'lesson',
    title: overrides?.title ?? 'Test dispatch',
    content: overrides?.content ?? 'General improvement content',
    priority: overrides?.priority ?? 'normal',
    createdAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    applied: false,
    minVersion: overrides?.minVersion,
    maxVersion: overrides?.maxVersion,
  };
}

function signDispatch(dispatch: Dispatch, privateKey: string, keyId: string): SignedDispatch {
  const signedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const payload = JSON.stringify({
    content: dispatch.content,
    dispatchId: dispatch.dispatchId,
    expiresAt,
    priority: dispatch.priority,
    signedAt,
    title: dispatch.title,
    type: dispatch.type,
  });
  const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
  return { ...dispatch, signature, signedAt, expiresAt, keyId };
}

describe('Dispatch Verification + Filter Pipeline', () => {
  let tmpDir: string;
  let stateDir: string;
  let keys: { publicKey: string; privateKey: string };
  let verifier: DispatchVerifier;
  let filter: RelevanceFilter;
  let snapshotBuilder: ContextSnapshotBuilder;
  let journal: DispatchDecisionJournal;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvf-int-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });

    keys = generateKeyPair();
    verifier = new DispatchVerifier({
      trustedKeys: { 'portal-key-1': keys.publicKey },
      required: true,
    });
    filter = new RelevanceFilter({ agentVersion: '0.12.0' });
    snapshotBuilder = new ContextSnapshotBuilder({
      projectName: 'TestAgent',
      projectDir: tmpDir,
      stateDir,
    });
    journal = new DispatchDecisionJournal(stateDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Simulate the full dispatch pipeline: verify → filter → log.
   */
  function processDispatch(dispatch: Dispatch) {
    // Step 1: Verify origin
    const verification = verifier.verify(dispatch);
    if (!verification.verified) {
      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision: 'reject',
        reasoning: `Verification failed: ${verification.reason}`,
        evaluationMethod: 'structural',
        tags: ['verification-failed'],
      });
      return { accepted: false, stage: 'verification', reason: verification.reason };
    }

    // Step 2: Relevance filter
    const snapshot = snapshotBuilder.build();
    const relevance = filter.check(dispatch, snapshot);
    if (!relevance.relevant) {
      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision: 'reject',
        reasoning: `Irrelevant: ${relevance.reason}`,
        evaluationMethod: 'structural',
        tags: ['filtered-out'],
        confidence: relevance.confidence,
      });
      return { accepted: false, stage: 'filter', reason: relevance.reason };
    }

    // Step 3: Would proceed to LLM evaluation (Milestone 4)
    // For now, auto-accept
    journal.logDispatchDecision({
      sessionId: '',
      dispatchId: dispatch.dispatchId,
      dispatchType: dispatch.type,
      dispatchPriority: dispatch.priority,
      dispatchDecision: 'accept',
      reasoning: 'Passed verification and relevance filter',
      evaluationMethod: 'structural',
      applied: true,
      tags: ['auto-accepted'],
    });
    return { accepted: true, stage: 'accepted', reason: 'Passed all checks' };
  }

  it('accepts a properly signed, relevant dispatch', () => {
    const dispatch = makeDispatch();
    const signed = signDispatch(dispatch, keys.privateKey, 'portal-key-1');

    const result = processDispatch(signed);
    expect(result.accepted).toBe(true);
    expect(result.stage).toBe('accepted');

    // Check journal
    const entry = journal.getDecisionForDispatch(dispatch.dispatchId);
    expect(entry!.dispatchDecision).toBe('accept');
  });

  it('rejects unsigned dispatch when verification required', () => {
    const dispatch = makeDispatch();

    const result = processDispatch(dispatch);
    expect(result.accepted).toBe(false);
    expect(result.stage).toBe('verification');

    const entry = journal.getDecisionForDispatch(dispatch.dispatchId);
    expect(entry!.dispatchDecision).toBe('reject');
    expect(entry!.tags).toContain('verification-failed');
  });

  it('rejects signed but platform-irrelevant dispatch', () => {
    // Set up agent as Telegram-only
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      messaging: [{ type: 'telegram', enabled: true }],
    }));
    snapshotBuilder.invalidateCache();

    const dispatch = makeDispatch({
      title: 'WhatsApp bot update',
      content: 'Improvements for WhatsApp message handling',
    });
    const signed = signDispatch(dispatch, keys.privateKey, 'portal-key-1');

    const result = processDispatch(signed);
    expect(result.accepted).toBe(false);
    expect(result.stage).toBe('filter');

    const entry = journal.getDecisionForDispatch(dispatch.dispatchId);
    expect(entry!.dispatchDecision).toBe('reject');
    expect(entry!.tags).toContain('filtered-out');
  });

  it('rejects signed but version-gated dispatch', () => {
    const dispatch = makeDispatch({ minVersion: '1.0.0' }); // Agent is 0.12.0
    const signed = signDispatch(dispatch, keys.privateKey, 'portal-key-1');

    const result = processDispatch(signed);
    expect(result.accepted).toBe(false);
    expect(result.stage).toBe('filter');
  });

  it('accepts security dispatches even when platform mismatches', () => {
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      messaging: [{ type: 'telegram', enabled: true }],
    }));
    snapshotBuilder.invalidateCache();

    const dispatch = makeDispatch({
      type: 'security',
      content: 'WhatsApp security vulnerability patch',
    });
    const signed = signDispatch(dispatch, keys.privateKey, 'portal-key-1');

    const result = processDispatch(signed);
    expect(result.accepted).toBe(true); // Security bypasses filter
  });

  it('rejects replay of previously accepted dispatch', () => {
    const dispatch = makeDispatch({ dispatchId: 'replay-target' });
    const signed = signDispatch(dispatch, keys.privateKey, 'portal-key-1');

    // First: accepted
    const first = processDispatch(signed);
    expect(first.accepted).toBe(true);

    // Second: replay rejected
    const second = processDispatch(signed);
    expect(second.accepted).toBe(false);
    expect(second.stage).toBe('verification');
  });

  it('produces correct stats after processing multiple dispatches', () => {
    const dispatches = [
      makeDispatch({ dispatchId: 'accept-1' }),
      makeDispatch({ dispatchId: 'accept-2' }),
      makeDispatch({ dispatchId: 'version-fail', minVersion: '99.0.0' }),
    ];

    for (const d of dispatches) {
      const signed = signDispatch(d, keys.privateKey, 'portal-key-1');
      processDispatch(signed);
    }

    const stats = journal.stats();
    expect(stats.total).toBe(3);
    expect(stats.byDecision.accept).toBe(2);
    expect(stats.byDecision.reject).toBe(1);
    expect(stats.acceptanceRate).toBeCloseTo(2 / 3);
  });

  it('tracks the full pipeline in journal entries', () => {
    const dispatch = makeDispatch({ dispatchId: 'pipeline-track' });
    const signed = signDispatch(dispatch, keys.privateKey, 'portal-key-1');
    processDispatch(signed);

    const entry = journal.getDecisionForDispatch('pipeline-track');
    expect(entry).not.toBeNull();
    expect(entry!.dispatchId).toBe('pipeline-track');
    expect(entry!.dispatchType).toBe('lesson');
    expect(entry!.dispatchPriority).toBe('normal');
    expect(entry!.evaluationMethod).toBe('structural');
    expect(entry!.applied).toBe(true);
  });
});
