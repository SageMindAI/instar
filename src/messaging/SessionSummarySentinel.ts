/**
 * SessionSummarySentinel — maintains real-time summaries of active sessions
 * for intelligent message routing.
 *
 * Per Phase 2 of INTER-AGENT-MESSAGING-SPEC v3.1:
 * - Periodically captures tmux output from each active session
 * - Uses hash-based change detection to skip unnecessary LLM calls
 * - Calls Haiku to generate structured summaries
 * - Enables intelligent routing via `session: "best"`
 * - Falls back to keyword matching when LLM is unavailable
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Session, IntelligenceProvider } from '../core/types.js';

// ── Types ───────────────────────────────────────────────────────

export type SessionPhase =
  | 'planning'
  | 'building'
  | 'testing'
  | 'debugging'
  | 'deploying'
  | 'engaging'
  | 'idle';

export interface SessionSummary {
  sessionId: string;
  tmuxSession: string;
  task: string;
  phase: SessionPhase;
  files: string[];
  topics: string[];
  blockers: string | null;
  lastActivity: string;
  updatedAt: string;
  stale: boolean;
  outputHash: string;
}

export interface SentinelConfig {
  stateDir: string;
  /** LLM provider for summary generation (Haiku-tier) */
  intelligence?: IntelligenceProvider;
  /** Function to list active sessions */
  getActiveSessions: () => Session[];
  /** Function to capture tmux pane output */
  captureOutput: (tmuxSession: string) => string | null;
  /** Interval between sentinel scans in ms (default: 30_000) */
  scanIntervalMs?: number;
  /** Lines of tmux output to capture (default: 100) */
  captureLines?: number;
  /** Summaries older than this are stale (default: 10 minutes) */
  stalenessMinutes?: number;
  /** Misroute threshold before fallback (default: 3 in 10 min) */
  misrouteThreshold?: number;
}

export interface RoutingScore {
  sessionId: string;
  tmuxSession: string;
  score: number;
  reason: string;
}

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_CAPTURE_LINES = 100;
const DEFAULT_STALENESS_MINUTES = 10;
const DEFAULT_MISROUTE_THRESHOLD = 3;
const MISROUTE_WINDOW_MS = 10 * 60_000;
const FALLBACK_DURATION_MS = 30 * 60_000;
const ROUTING_SCORE_THRESHOLD = 0.3;

const SUMMARY_PROMPT = `Given this terminal output from an active Claude session, produce a
structured JSON summary. Respond with ONLY valid JSON, no markdown.

{
  "task": "one-sentence description of current work",
  "phase": "planning|building|testing|debugging|deploying|engaging|idle",
  "files": ["list of files being actively modified"],
  "topics": ["semantic tags: database, frontend, security, messaging, etc."],
  "blockers": "any blockers or waiting states, or null"
}

Terminal output:
`;

// ── Implementation ──────────────────────────────────────────────

export class SessionSummarySentinel {
  private readonly config: SentinelConfig;
  private readonly summaryDir: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Last output hash per session — skip LLM if unchanged */
  private readonly outputHashes = new Map<string, string>();

  /** Misroute tracking for fallback */
  private readonly misroutes: number[] = [];
  private fallbackUntil: number = 0;

  constructor(config: SentinelConfig) {
    this.config = config;
    this.summaryDir = path.join(config.stateDir, 'sessions');
    fs.mkdirSync(this.summaryDir, { recursive: true });
  }

  /** Start periodic scanning */
  start(): void {
    if (this.timer) return;
    const interval = this.config.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.timer = setInterval(() => this.scan(), interval);
  }

  /** Stop periodic scanning */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single scan across all active sessions */
  async scan(): Promise<{ updated: number; skipped: number; errors: number }> {
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    const sessions = this.config.getActiveSessions();

    for (const session of sessions) {
      try {
        const output = this.config.captureOutput(session.tmuxSession);
        if (!output || output.trim().length === 0) {
          skipped++;
          continue;
        }

        // Hash-based change detection
        const hash = crypto.createHash('md5').update(output).digest('hex');
        if (this.outputHashes.get(session.id) === hash) {
          // Mark staleness on existing summary
          await this.updateStaleness(session.id);
          skipped++;
          continue;
        }

        // Generate summary
        const summary = await this.generateSummary(session, output, hash);
        if (summary) {
          await this.saveSummary(summary);
          this.outputHashes.set(session.id, hash);
          updated++;
        } else {
          skipped++;
        }
      } catch {
        errors++;
      }
    }

    return { updated, skipped, errors };
  }

  /** Generate a summary for a session using LLM or keyword extraction */
  private async generateSummary(
    session: Session,
    output: string,
    hash: string,
  ): Promise<SessionSummary | null> {
    const useLlm = this.config.intelligence && !this.isInFallbackMode();
    const lines = this.config.captureLines ?? DEFAULT_CAPTURE_LINES;
    const trimmedOutput = output.split('\n').slice(-lines).join('\n');

    if (useLlm) {
      try {
        const response = await this.config.intelligence!.evaluate(
          SUMMARY_PROMPT + trimmedOutput,
          { model: 'fast', maxTokens: 1000 },
        );

        const parsed = this.parseLlmResponse(response);
        if (parsed) {
          return {
            sessionId: session.id,
            tmuxSession: session.tmuxSession,
            task: parsed.task,
            phase: parsed.phase as SessionPhase,
            files: parsed.files ?? [],
            topics: parsed.topics ?? [],
            blockers: parsed.blockers ?? null,
            lastActivity: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            stale: false,
            outputHash: hash,
          };
        }
      } catch { // @silent-fallback-ok — LLM failure falls through to keyword extraction
      }
    }

    // Keyword-based fallback
    return this.extractKeywordSummary(session, trimmedOutput, hash);
  }

  /** Parse LLM JSON response with validation */
  private parseLlmResponse(response: string): {
    task: string;
    phase: string;
    files: string[];
    topics: string[];
    blockers: string | null;
  } | null {
    try {
      // Strip markdown code fences if present
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);

      if (!parsed.task || typeof parsed.task !== 'string') return null;
      if (!parsed.phase || typeof parsed.phase !== 'string') return null;

      const validPhases = ['planning', 'building', 'testing', 'debugging', 'deploying', 'engaging', 'idle'];
      if (!validPhases.includes(parsed.phase)) {
        parsed.phase = 'building'; // Default to building if invalid
      }

      return {
        task: parsed.task,
        phase: parsed.phase,
        files: Array.isArray(parsed.files) ? parsed.files.filter((f: unknown) => typeof f === 'string') : [],
        topics: Array.isArray(parsed.topics) ? parsed.topics.filter((t: unknown) => typeof t === 'string') : [],
        blockers: typeof parsed.blockers === 'string' ? parsed.blockers : null,
      };
    } catch { // @silent-fallback-ok — malformed JSON response, return null to trigger keyword fallback
      return null;
    }
  }

  /** Keyword-based summary extraction (fallback when LLM unavailable) */
  private extractKeywordSummary(
    session: Session,
    output: string,
    hash: string,
  ): SessionSummary {
    const lines = output.split('\n');

    // Extract files from output (common patterns)
    const filePattern = /(?:^|\s)([\w/.-]+\.(?:ts|js|tsx|jsx|py|rs|go|json|md|yaml|yml|toml|sql|prisma|css|html))\b/g;
    const files = new Set<string>();
    for (const line of lines) {
      for (const match of line.matchAll(filePattern)) {
        files.add(match[1]);
      }
    }

    // Extract topics via keyword matching
    const topics = new Set<string>();
    const topicKeywords: Record<string, string[]> = {
      database: ['prisma', 'sql', 'migrate', 'schema', 'query', 'database', 'db'],
      frontend: ['component', 'react', 'css', 'html', 'ui', 'page', 'render'],
      testing: ['test', 'spec', 'vitest', 'jest', 'cypress', 'expect', 'assert'],
      security: ['auth', 'token', 'encrypt', 'hmac', 'signature', 'permission'],
      messaging: ['message', 'envelope', 'relay', 'deliver', 'mqtt', 'websocket'],
      deployment: ['deploy', 'build', 'ci', 'cd', 'docker', 'vercel', 'npm publish'],
      api: ['endpoint', 'route', 'api', 'rest', 'graphql', 'fetch', 'request'],
      monitoring: ['metric', 'health', 'alert', 'sentinel', 'watchdog', 'quota'],
    };

    const lowerOutput = output.toLowerCase();
    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (keywords.some(kw => lowerOutput.includes(kw))) {
        topics.add(topic);
      }
    }

    // Detect phase from output patterns
    let phase: SessionPhase = 'building';
    if (/(?:test|spec|vitest|jest|PASS|FAIL|expect\()/i.test(output)) phase = 'testing';
    else if (/(?:error|Error|ERR|bug|fix|debug|stack trace)/i.test(output)) phase = 'debugging';
    else if (/(?:plan|design|spec|proposal|architecture)/i.test(output)) phase = 'planning';
    else if (/(?:deploy|publish|release|build.*success)/i.test(output)) phase = 'deploying';
    else if (/(?:tweet|post|comment|reply|engage|substack|reddit)/i.test(output)) phase = 'engaging';

    // Use session prompt as task description if available
    const task = session.prompt
      ? session.prompt.slice(0, 100)
      : `Session ${session.id} (${phase})`;

    return {
      sessionId: session.id,
      tmuxSession: session.tmuxSession,
      task,
      phase,
      files: [...files].slice(0, 20),
      topics: [...topics],
      blockers: null,
      lastActivity: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stale: false,
      outputHash: hash,
    };
  }

  /** Save a summary to disk */
  private async saveSummary(summary: SessionSummary): Promise<void> {
    const sessionDir = path.join(this.summaryDir, summary.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, 'summary.json');
    fs.writeFileSync(filePath, JSON.stringify(summary, null, 2));
  }

  /** Get a summary for a specific session */
  getSummary(sessionId: string): SessionSummary | null {
    const filePath = path.join(this.summaryDir, sessionId, 'summary.json');
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data) as SessionSummary;
    } catch { // @silent-fallback-ok — summary file not found
      return null;
    }
  }

  /** Get all current summaries */
  getAllSummaries(): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    try {
      const entries = fs.readdirSync(this.summaryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const summaryPath = path.join(this.summaryDir, entry.name, 'summary.json');
        try {
          const data = fs.readFileSync(summaryPath, 'utf-8');
          summaries.push(JSON.parse(data) as SessionSummary);
        } catch { // @silent-fallback-ok — skip unreadable summary
          continue;
        }
      }
    } catch { // @silent-fallback-ok — summaries directory not found
      // Directory doesn't exist yet
    }
    return summaries;
  }

  /** Update staleness flag on an existing summary */
  private async updateStaleness(sessionId: string): Promise<void> {
    const summary = this.getSummary(sessionId);
    if (!summary) return;

    const stalenessMinutes = this.config.stalenessMinutes ?? DEFAULT_STALENESS_MINUTES;
    const updatedAt = new Date(summary.updatedAt).getTime();
    const isStale = Date.now() - updatedAt > stalenessMinutes * 60_000;

    if (isStale !== summary.stale) {
      summary.stale = isStale;
      await this.saveSummary(summary);
    }
  }

  // ── Intelligent Routing ─────────────────────────────────────

  /**
   * Find the best session to deliver a message to.
   * Returns scored sessions sorted by relevance, or empty if no good match.
   *
   * `excludeSession` (optional): a session id (or tmux session name) to omit
   * from candidates. Used by MessageRouter.send to prevent the sender's own
   * session from being selected as the target, which would otherwise trip
   * echo prevention when resolving `to.session === 'best'` for self-directed
   * routing.
   */
  findBestSession(
    subject: string,
    body: string,
    targetAgent: string,
    excludeSession?: string,
  ): RoutingScore[] {
    const summaries = this.getAllSummaries();
    const activeSessions = this.config.getActiveSessions();
    const activeIds = new Set(activeSessions.map(s => s.id));

    // Only score sessions that are still active, and exclude the sender's
    // own session if provided (matched by sessionId OR tmuxSession name).
    const activeSummaries = summaries.filter(s =>
      activeIds.has(s.sessionId)
      && (!excludeSession || (s.sessionId !== excludeSession && s.tmuxSession !== excludeSession))
    );

    if (activeSummaries.length === 0) return [];

    const messageText = `${subject} ${body}`.toLowerCase();
    const messageWords = this.extractKeywords(messageText);

    const scores: RoutingScore[] = activeSummaries.map(summary => {
      let score = 0;
      const reasons: string[] = [];

      // Topic overlap (0-0.4)
      const topicOverlap = summary.topics.filter(t =>
        messageWords.some(w => t.includes(w) || w.includes(t))
      ).length;
      const topicScore = Math.min(topicOverlap * 0.15, 0.4);
      score += topicScore;
      if (topicOverlap > 0) reasons.push(`${topicOverlap} topic(s) overlap`);

      // File overlap (0-0.3)
      const fileOverlap = summary.files.filter(f =>
        messageWords.some(w => f.includes(w))
      ).length;
      const fileScore = Math.min(fileOverlap * 0.1, 0.3);
      score += fileScore;
      if (fileOverlap > 0) reasons.push(`${fileOverlap} file(s) match`);

      // Task keyword match (0-0.2)
      const taskWords = this.extractKeywords(summary.task.toLowerCase());
      const taskOverlap = taskWords.filter(w => messageWords.includes(w)).length;
      const taskScore = Math.min(taskOverlap * 0.1, 0.2);
      score += taskScore;
      if (taskOverlap > 0) reasons.push(`task matches (${taskOverlap} words)`);

      // Phase compatibility (penalty for deploying/engaging)
      if (summary.phase === 'deploying') {
        score *= 0.5;
        reasons.push('penalized: deploying');
      }
      if (summary.phase === 'engaging') {
        score *= 0.7;
        reasons.push('penalized: engaging');
      }

      // Recency bonus (0-0.1)
      const updatedAt = new Date(summary.lastActivity).getTime();
      const ageMinutes = (Date.now() - updatedAt) / 60_000;
      if (ageMinutes < 5) {
        score += 0.1;
        reasons.push('recently active');
      }

      // Staleness penalty
      if (summary.stale) {
        score *= 0.7;
        reasons.push('stale summary');
      }

      return {
        sessionId: summary.sessionId,
        tmuxSession: summary.tmuxSession,
        score,
        reason: reasons.join(', ') || 'no matches',
      };
    });

    // Sort by score descending, filter above threshold
    return scores
      .sort((a, b) => b.score - a.score)
      .filter(s => s.score >= ROUTING_SCORE_THRESHOLD);
  }

  /** Extract meaningful keywords from text */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      'and', 'or', 'not', 'this', 'that', 'it', 'as', 'but', 'if',
      'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should',
      'has', 'have', 'had', 'my', 'your', 'his', 'her', 'its', 'our',
    ]);

    return text
      .split(/\W+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  }

  // ── Misroute Tracking ───────────────────────────────────────

  /** Record a misroute event (message delivered to wrong session) */
  recordMisroute(): void {
    this.misroutes.push(Date.now());
    // Clean old misroutes
    const cutoff = Date.now() - MISROUTE_WINDOW_MS;
    while (this.misroutes.length > 0 && this.misroutes[0] < cutoff) {
      this.misroutes.shift();
    }

    const threshold = this.config.misrouteThreshold ?? DEFAULT_MISROUTE_THRESHOLD;
    if (this.misroutes.length >= threshold) {
      this.fallbackUntil = Date.now() + FALLBACK_DURATION_MS;
    }
  }

  /** Check if currently in fallback mode (LLM disabled due to misroutes) */
  isInFallbackMode(): boolean {
    return Date.now() < this.fallbackUntil;
  }

  /** Get sentinel status for monitoring */
  getStatus(): {
    summaryCount: number;
    staleCount: number;
    inFallback: boolean;
    recentMisroutes: number;
    outputHashCount: number;
  } {
    const summaries = this.getAllSummaries();
    return {
      summaryCount: summaries.length,
      staleCount: summaries.filter(s => s.stale).length,
      inFallback: this.isInFallbackMode(),
      recentMisroutes: this.misroutes.length,
      outputHashCount: this.outputHashes.size,
    };
  }
}
