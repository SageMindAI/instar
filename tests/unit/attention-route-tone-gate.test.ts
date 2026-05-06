/**
 * Server-side test for POST /attention — verifies that:
 *
 *   1. Candidate attention items run through MessagingToneGate before any
 *      Telegram topic gets created.
 *   2. For category=degradation (and other health-class categories), the
 *      gate is invoked with messageKind="health-alert" so the B12/B13/B14
 *      ruleset fires.
 *   3. When the gate blocks, the route returns 422 and createAttentionItem
 *      is NOT called (no topic spawned, item not persisted).
 *   4. When the gate passes, the item is created normally (201).
 *   5. For non-health categories, messageKind defaults to "reply" — the
 *      health-alert rules do not apply.
 *
 * Regression context: agents using POST /attention were spawning new Telegram
 * topics for every recurring degradation event because /attention was the one
 * outbound path NOT wired through the existing tone-gate authority.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate, type ToneReviewContext } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

interface AttentionItemStub {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'DONE' | 'WONT_DO';
  description?: string;
  sourceContext?: string;
  createdAt: string;
  updatedAt: string;
  topicId?: number;
}

function buildApp(opts: {
  toneGate: MessagingToneGate;
  recordedCalls: ToneReviewContext[];
  createAttention: (item: Omit<AttentionItemStub, 'createdAt' | 'updatedAt' | 'status'>) => Promise<AttentionItemStub>;
  createAttentionCalls: { count: number };
}): express.Express {
  const app = express();
  app.use(express.json());

  // Wrap review() so we can record contexts the route passes in. The wrapping
  // preserves the gate's pass/block decision (driven by the mocked provider).
  const originalReview = opts.toneGate.review.bind(opts.toneGate);
  opts.toneGate.review = async (text: string, context: ToneReviewContext) => {
    opts.recordedCalls.push(context);
    return originalReview(text, context);
  };

  const ctx: any = {
    config: { authToken: 'test', stateDir: '/tmp', port: 0 },
    messagingToneGate: opts.toneGate,
    telegram: {
      createAttentionItem: async (item: Omit<AttentionItemStub, 'createdAt' | 'updatedAt' | 'status'>) => {
        opts.createAttentionCalls.count += 1;
        return opts.createAttention(item);
      },
      // Other adapter methods aren't touched by the POST /attention path under test.
    },
    // All other ctx fields default to undefined; route only touches the above.
  };

  const router = createRoutes(ctx);
  app.use(router);
  return app;
}

function makeProvider(response: { pass: boolean; rule: string; issue: string; suggestion: string }): IntelligenceProvider {
  return {
    evaluate: vi.fn(async () => JSON.stringify(response)),
  } as unknown as IntelligenceProvider;
}

describe('POST /attention — tone-gate wiring', () => {
  let server: TestServer;
  let recordedCalls: ToneReviewContext[];
  let createAttentionCalls: { count: number };

  async function api(path: string, body: object) {
    const res = await fetch(server.url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseBody = await res.json().catch(() => ({}));
    return { status: res.status, body: responseBody };
  }

  beforeEach(() => {
    recordedCalls = [];
    createAttentionCalls = { count: 0 };
  });

  afterEach(async () => {
    await server?.close();
  });

  it('passes a valid candidate through the gate, creates the item (201), and uses messageKind=health-alert for category=degradation', async () => {
    const provider = makeProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const toneGate = new MessagingToneGate(provider);

    const stubItem: AttentionItemStub = {
      id: 'degradation:git-conflict',
      title: 'Degradation: git-conflict',
      summary: 'A git conflict could not auto-resolve. Want me to dig in?',
      category: 'degradation',
      priority: 'NORMAL',
      status: 'OPEN',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      topicId: 42,
    };

    server = await listen(
      buildApp({
        toneGate,
        recordedCalls,
        createAttention: async () => stubItem,
        createAttentionCalls,
      }),
    );

    const r = await api('/attention', {
      id: 'degradation:git-conflict',
      title: 'Degradation: git-conflict',
      summary: 'A git conflict could not auto-resolve. Want me to dig in?',
      category: 'degradation',
      priority: 'NORMAL',
    });

    expect(r.status).toBe(201);
    expect(r.body.id).toBe('degradation:git-conflict');
    expect(createAttentionCalls.count).toBe(1);
    // The route consulted the gate exactly once.
    expect(recordedCalls.length).toBe(1);
    expect(recordedCalls[0].messageKind).toBe('health-alert');
    // Jargon signal must be populated for health-alert kinds (so B12 has evidence).
    expect(recordedCalls[0].signals?.jargon).toBeDefined();
  });

  it('returns 422 and does not create the item when the gate blocks (no-CTA health alert → B14)', async () => {
    const provider = makeProvider({
      pass: false,
      rule: 'B14_HEALTH_ALERT_NO_CTA',
      issue: 'Health-alert candidate does not end with a yes/no question',
      suggestion: 'Add a closing yes/no question the user can answer in one word',
    });
    const toneGate = new MessagingToneGate(provider);

    server = await listen(
      buildApp({
        toneGate,
        recordedCalls,
        createAttention: async () => {
          throw new Error('createAttentionItem must not be invoked when the gate blocks');
        },
        createAttentionCalls,
      }),
    );

    const r = await api('/attention', {
      id: 'degradation:server-degraded',
      title: 'Server degraded',
      summary: 'Git conflict auto-resolution disabled. Priority: LOW',
      category: 'degradation',
      priority: 'LOW',
    });

    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-blocked');
    expect(r.body.rule).toBe('B14_HEALTH_ALERT_NO_CTA');
    expect(createAttentionCalls.count).toBe(0);
    expect(recordedCalls[0].messageKind).toBe('health-alert');
  });

  it('uses messageKind=reply for non-health categories (general, etc.)', async () => {
    const provider = makeProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const toneGate = new MessagingToneGate(provider);

    const stubItem: AttentionItemStub = {
      id: 'review:pr-42',
      title: 'PR ready for review',
      summary: 'I opened a PR; want me to walk you through the changes?',
      category: 'general',
      priority: 'NORMAL',
      status: 'OPEN',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      topicId: 99,
    };

    server = await listen(
      buildApp({
        toneGate,
        recordedCalls,
        createAttention: async () => stubItem,
        createAttentionCalls,
      }),
    );

    const r = await api('/attention', {
      id: 'review:pr-42',
      title: 'PR ready for review',
      summary: 'I opened a PR; want me to walk you through the changes?',
      category: 'general',
      priority: 'NORMAL',
    });

    expect(r.status).toBe(201);
    expect(recordedCalls[0].messageKind).toBe('reply');
    // No jargon signal for non-health-alert kinds — keep the prompt focused
    // on the rules that actually apply.
    expect(recordedCalls[0].signals?.jargon).toBeUndefined();
  });

  it('treats "health" and "alert" categories as health-alert too (alias coverage)', async () => {
    const provider = makeProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const toneGate = new MessagingToneGate(provider);

    const stubItem: AttentionItemStub = {
      id: 'health:rss',
      title: 'Memory pressure',
      summary: 'Memory pressure looks high. Want me to investigate?',
      category: 'health',
      priority: 'NORMAL',
      status: 'OPEN',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      topicId: 100,
    };

    server = await listen(
      buildApp({
        toneGate,
        recordedCalls,
        createAttention: async () => stubItem,
        createAttentionCalls,
      }),
    );

    await api('/attention', {
      id: 'health:rss',
      title: 'Memory pressure',
      summary: 'Memory pressure looks high. Want me to investigate?',
      category: 'health',
      priority: 'NORMAL',
    });

    expect(recordedCalls[0].messageKind).toBe('health-alert');
  });
});
