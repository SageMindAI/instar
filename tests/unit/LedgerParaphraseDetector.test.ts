/**
 * Integrated-Being v1 — ledger paraphrase cross-check tests.
 *
 * Signal-only per spec; verifies detection rules without adding any blocking
 * authority. See docs/signal-vs-authority.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SharedStateLedger } from '../../src/core/SharedStateLedger.js';
import { LedgerParaphraseDetector } from '../../src/core/LedgerParaphraseDetector.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'paraphrase-test-'));
}

describe('LedgerParaphraseDetector', () => {
  let dir: string;
  let ledger: SharedStateLedger;

  beforeEach(async () => {
    dir = tempDir();
    ledger = new SharedStateLedger({
      stateDir: dir,
      config: { enabled: true, paraphraseCheckEnabled: true },
      salt: 'salt',
    });
    // Seed the ledger with a few distinct agreements with different counterparties.
    await ledger.append({
      emittedBy: { subsystem: 'threadline', instance: 'server' },
      kind: 'agreement',
      subject: 'Integration contract with sagemind',
      summary: 'Aligned on four-endpoint feedback integration contract for sagemind release',
      counterparty: { type: 'agent', name: 'sagemind', trustTier: 'trusted' },
      provenance: 'subsystem-asserted',
      dedupKey: 'agreement:1',
    });
    await ledger.append({
      emittedBy: { subsystem: 'outbound-classifier', instance: 'server' },
      kind: 'commitment',
      subject: 'Classifier-inferred commitment',
      summary: 'Will alert user when memory search drifts below threshold expected output',
      counterparty: { type: 'user', name: 'justin', trustTier: 'trusted' },
      provenance: 'subsystem-inferred',
      source: 'heuristic-classifier',
      dedupKey: 'commitment:inferred:1',
    });
  });

  afterEach(() => {
    ledger.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fires when paraphrasing a trusted agreement to a different counterparty', async () => {
    const d = new LedgerParaphraseDetector(ledger, { enabled: true, paraphraseCheckEnabled: true });
    const signal = await d.check({
      outboundText: 'We aligned on the four-endpoint feedback integration contract for the sagemind release.',
      outboundCounterparty: { type: 'user', name: 'justin' },
    });
    expect(signal.detected).toBe(true);
    expect(signal.similarityScore ?? 0).toBeGreaterThanOrEqual(0.7);
    expect(signal.counterparty?.name).toBe('sagemind');
  });

  it('does NOT fire when same counterparty (legitimate relay)', async () => {
    const d = new LedgerParaphraseDetector(ledger, { enabled: true, paraphraseCheckEnabled: true });
    const signal = await d.check({
      outboundText: 'We aligned on the four-endpoint feedback integration contract for the sagemind release.',
      outboundCounterparty: { type: 'agent', name: 'sagemind' },
    });
    expect(signal.detected).toBe(false);
  });

  it('does NOT fire on subsystem-inferred entries (spec: excluded from corpus)', async () => {
    const d = new LedgerParaphraseDetector(ledger, { enabled: true, paraphraseCheckEnabled: true });
    const signal = await d.check({
      outboundText: 'I will alert the user when memory search drifts below the expected output threshold.',
      // Deliberately use a counterparty different from the inferred entry.
      outboundCounterparty: { type: 'agent', name: 'sagemind' },
    });
    expect(signal.detected).toBe(false);
  });

  it('does NOT fire on unrelated outbound text', async () => {
    const d = new LedgerParaphraseDetector(ledger, { enabled: true, paraphraseCheckEnabled: true });
    const signal = await d.check({
      outboundText: 'The weather is quite nice today, I think I will walk the dog.',
      outboundCounterparty: { type: 'user', name: 'justin' },
    });
    expect(signal.detected).toBe(false);
  });

  it('is disabled when paraphraseCheckEnabled=false', async () => {
    const d = new LedgerParaphraseDetector(ledger, { enabled: true, paraphraseCheckEnabled: false });
    const signal = await d.check({
      outboundText: 'We aligned on the four-endpoint feedback integration contract for sagemind release.',
      outboundCounterparty: { type: 'user', name: 'justin' },
    });
    expect(signal.detected).toBe(false);
  });
});
