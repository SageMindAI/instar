/**
 * E2E test — TopicMemory full lifecycle.
 *
 * Tests the complete flow:
 *   1. Server starts with TopicMemory initialized
 *   2. JSONL import populates the database
 *   3. New messages are dual-written (JSONL + SQLite)
 *   4. FTS5 search finds messages across topics
 *   5. Summary generation via mock intelligence
 *   6. Context retrieval includes summary + recent messages
 *   7. Database survives rebuild from JSONL
 *
 * This tests the system as a whole — all components wired together.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicSummarizer } from '../../src/memory/TopicSummarizer.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';

describe('TopicMemory E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let topicMemory: TopicMemory;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-e2e-topic-memory';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Step 1: Create JSONL with existing conversation history
    const jsonlPath = path.join(stateDir, 'telegram-messages.jsonl');
    const messages = [];
    for (let i = 0; i < 40; i++) {
      messages.push(JSON.stringify({
        messageId: i,
        topicId: 500,
        text: i % 2 === 0
          ? `User: Let's work on the authentication system (msg ${i})`
          : `Agent: I'll implement OAuth2 with PKCE flow (msg ${i})`,
        fromUser: i % 2 === 0,
        timestamp: new Date(2026, 1, 24, 10, i).toISOString(),
        sessionName: i % 2 === 0 ? null : 'auth-session',
      }));
    }
    // Second topic with fewer messages
    for (let i = 0; i < 8; i++) {
      messages.push(JSON.stringify({
        messageId: 100 + i,
        topicId: 600,
        text: `Quick chat about styling (msg ${i})`,
        fromUser: i % 2 === 0,
        timestamp: new Date(2026, 1, 24, 14, i).toISOString(),
        sessionName: null,
      }));
    }
    fs.writeFileSync(jsonlPath, messages.join('\n'));

    // Step 2: Initialize TopicMemory and import from JSONL
    topicMemory = new TopicMemory(stateDir);
    await topicMemory.open();
    const importCount = await topicMemory.importFromJsonl(jsonlPath);
    expect(importCount).toBe(48);

    // Step 3: Start server
    const state = new StateManager(stateDir);
    const mockSM = createMockSessionManager();

    const config: InstarConfig = {
      projectName: 'test-e2e-topic',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000,
      version: '0.9.1',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
      topicMemory,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    topicMemory.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Phase 1: Verify import worked ──────────────────────────

  it('imported messages are searchable via API', async () => {
    const res = await request(app)
      .get('/topic/search?q=authentication')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results[0].topicId).toBe(500);
  });

  it('topic list shows both topics', async () => {
    const res = await request(app)
      .get('/topic/list')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.body.topics).toHaveLength(2);
    const topic500 = res.body.topics.find((t: any) => t.topicId === 500);
    expect(topic500.messageCount).toBe(40);
  });

  // ── Phase 2: New messages (simulate dual-write) ────────────

  it('new messages are insertable and immediately searchable', async () => {
    // Simulate a new message arriving (dual-write path)
    topicMemory.insertMessage({
      messageId: 200,
      topicId: 500,
      text: 'User: What about the WebSocket implementation?',
      fromUser: true,
      timestamp: new Date().toISOString(),
      sessionName: null,
    });

    const res = await request(app)
      .get('/topic/search?q=WebSocket&topic=500')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(res.body.results[0].text).toContain('WebSocket');
  });

  // ── Phase 3: Summary generation ────────────────────────────

  it('generates and saves topic summary', async () => {
    // Verify topic needs summary (40+ messages, no summary yet)
    const preSummarize = await request(app)
      .post('/topic/summarize')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ topicId: 500 })
      .expect(200);

    expect(preSummarize.body.needsUpdate).toBe(true);
    expect(preSummarize.body.currentSummary).toBeNull();

    // Generate summary using mock intelligence
    const mockIntelligence: IntelligenceProvider = {
      evaluate: async () => 'User and agent are implementing an OAuth2 authentication system with PKCE flow. They also discussed WebSocket implementation.',
    };
    const summarizer = new TopicSummarizer(mockIntelligence, topicMemory, { messageThreshold: 20 });

    const result = await summarizer.summarize(500);
    expect(result).not.toBeNull();
    expect(result!.summary).toContain('OAuth2');

    // Verify summary appears in context
    const context = await request(app)
      .get('/topic/context/500')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(context.body.summary).toContain('OAuth2');
    expect(context.body.totalMessages).toBe(41); // 40 original + 1 WebSocket
    expect(context.body.recentMessages.length).toBeGreaterThan(0);
  });

  it('topic without enough messages does not get summarized', async () => {
    const mockIntelligence: IntelligenceProvider = {
      evaluate: async () => 'Should not be called.',
    };
    const summarizer = new TopicSummarizer(mockIntelligence, topicMemory, { messageThreshold: 20 });

    const result = await summarizer.summarize(600);
    expect(result).toBeNull(); // Only 8 messages, threshold is 20
  });

  // ── Phase 4: Cross-topic search ────────────────────────────

  it('cross-topic search returns results from multiple topics', async () => {
    const res = await request(app)
      .get('/topic/search?q=msg')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    const topicIds = new Set(res.body.results.map((r: any) => r.topicId));
    expect(topicIds.size).toBeGreaterThanOrEqual(2);
  });

  // ── Phase 5: Rebuild preserves summaries ───────────────────

  it('rebuild reimports from JSONL and preserves summaries', async () => {
    const res = await request(app)
      .post('/topic/rebuild')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.body.rebuilt).toBe(true);
    // Original JSONL has 48 messages (the WebSocket message was only in SQLite)
    expect(res.body.messagesImported).toBe(48);

    // Summary should still exist (rebuild preserves summaries)
    const summary = topicMemory.getTopicSummary(500);
    expect(summary).not.toBeNull();
    expect(summary!.summary).toContain('OAuth2');
  });

  // ── Phase 6: Stats accuracy ────────────────────────────────

  it('stats reflect current state after all operations', async () => {
    const res = await request(app)
      .get('/topic/stats')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.body.totalMessages).toBe(48); // After rebuild from JSONL
    expect(res.body.totalTopics).toBe(2);
    expect(res.body.topicsWithSummaries).toBe(1); // Topic 500 only
    expect(res.body.dbSizeBytes).toBeGreaterThan(0);
  });
});
