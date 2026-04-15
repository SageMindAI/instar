/**
 * SharedStateLedger — per-agent integrated-being awareness layer.
 *
 * Problem it solves: an instar agent can have multiple sessions alive at once
 * (user-facing session, threadline message handlers, job runners, etc.). Each
 * session makes decisions and commitments without visibility into what the
 * others are doing. The agent as a whole becomes incoherent: the user-facing
 * session doesn't know about commitments a threadline session just made to
 * another agent; two sessions can agree to contradictory things; the user
 * gets inconsistent answers depending on which session is alive when they
 * ask.
 *
 * Design:
 *   - Append-only JSONL file at `.instar/shared-state.jsonl` (runtime state,
 *     gitignored).
 *   - Every session writes an entry when it does something significant:
 *     makes a commitment to a user or agent, opens a thread, reaches an
 *     agreement, commits a substantive decision.
 *   - A turn-start hook reads recent entries and injects them into each
 *     session's context. Sessions see what the agent as a whole has been
 *     doing without being given raw cross-thread message contents.
 *
 * Security boundary: entries are derived facts, NOT raw message contents.
 * The per-thread security sandboxing specified by Threadline is preserved —
 * this ledger lives at a different layer, summarizing at the "what the agent
 * is engaged in" granularity.
 *
 * See docs/signal-vs-authority.md. This module produces signals for
 * downstream consumers (the session context, the user via the dashboard).
 * It holds no blocking authority and makes no judgment decisions.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type SharedStateEntryKind =
  | 'commitment'       // "I'll do X by Y"
  | 'agreement'        // "Agreed with <party> on <thing>"
  | 'thread-opened'    // "Opened thread with <agent> about <subject>"
  | 'thread-closed'    // "Closed thread <id> — outcome <outcome>"
  | 'decision'         // "Committed to <choice>"
  | 'note';            // Free-form significant event

export interface SharedStateEntry {
  /** Entry id — stable for idempotency. */
  id: string;
  /** ISO timestamp. */
  t: string;
  /** Session id that produced this entry. Used for provenance. */
  sessionId: string;
  /** What kind of event this is. */
  kind: SharedStateEntryKind;
  /** Short human-readable subject line (<= 200 chars). */
  subject: string;
  /**
   * Optional longer summary (<= 2000 chars). Must be DERIVED facts, NOT raw
   * cross-thread message contents. E.g., "Agreed with sagemind on 4-endpoint
   * feedback integration contract" — not "Dawn said: [full message]".
   */
  summary?: string;
  /** Optional counterparty reference (user, agent, thread, etc.). */
  party?: string;
}

export interface SharedStateAppendInput {
  sessionId: string;
  kind: SharedStateEntryKind;
  subject: string;
  summary?: string;
  party?: string;
}

export class SharedStateLedger {
  private readonly file: string;

  /** Maximum chars for subject, enforced on write. */
  static readonly MAX_SUBJECT = 200;
  /**
   * Maximum chars for summary, enforced on write.
   *
   * Chosen to be generous enough for "agreed on a multi-point contract with
   * these bullet details" but small enough that pasting a full agent-to-agent
   * message body would get truncated. The threadline security boundary says
   * raw cross-thread message contents must not land in this ledger — this cap
   * is a programmatic guardrail that backstops the process-level discipline
   * enforced by the /instar-dev skill's side-effects review.
   *
   * A typical threadline message is 1-3KB. 500 chars comfortably holds
   * derived-fact summaries while making it physically inconvenient to paste
   * a whole message.
   */
  static readonly MAX_SUMMARY = 500;
  /**
   * Soft line-count ceiling before the ledger rotates. When exceeded on an
   * append, the current file is renamed to `.jsonl.1` (overwriting any
   * prior rotation) and a fresh file is started. Keeps the read path
   * bounded to this many entries scanned per turn-start.
   */
  static readonly ROTATE_AT_LINES = 5000;

  constructor(projectDir: string) {
    const dir = path.join(projectDir, '.instar');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'shared-state.jsonl');
  }

  /** Append an entry. Returns the written entry including id+timestamp. */
  append(input: SharedStateAppendInput): SharedStateEntry {
    const subject = (input.subject || '').slice(0, SharedStateLedger.MAX_SUBJECT).trim();
    if (!subject) {
      throw new Error('SharedStateLedger.append: subject is required');
    }
    const summary = input.summary
      ? input.summary.slice(0, SharedStateLedger.MAX_SUMMARY).trim()
      : undefined;

    const entry: SharedStateEntry = {
      id: crypto.randomBytes(6).toString('hex'),
      t: new Date().toISOString(),
      sessionId: input.sessionId,
      kind: input.kind,
      subject,
      ...(summary !== undefined ? { summary } : {}),
      ...(input.party !== undefined ? { party: input.party } : {}),
    };

    // Rotate if the ledger has grown past the soft ceiling. Cheap check:
    // statSync is O(1), and we only actually count lines when size suggests
    // we might be over. Keeps the read path bounded.
    this.maybeRotate();

    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf-8');
    return entry;
  }

  /**
   * If the ledger file has more than ROTATE_AT_LINES lines, rename it to
   * `.jsonl.1` (overwriting any prior rotation) and start fresh. Bounded
   * retention without hiding old data — the previous ledger remains on disk.
   */
  private maybeRotate(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      // Fast path: if file is small, it's definitely under the limit.
      const stat = fs.statSync(this.file);
      // Assume average line length ~200 bytes; rotate if size suggests we
      // might be near ROTATE_AT_LINES. Exact count only if we're close.
      if (stat.size < SharedStateLedger.ROTATE_AT_LINES * 100) return;

      const content = fs.readFileSync(this.file, 'utf-8');
      const lineCount = (content.match(/\n/g) || []).length;
      if (lineCount < SharedStateLedger.ROTATE_AT_LINES) return;

      const rotated = this.file + '.1';
      fs.renameSync(this.file, rotated);
    } catch {
      // Best-effort — rotation failing never breaks the append
    }
  }

  /**
   * Read the most recent `limit` entries, oldest-to-newest.
   * Returns [] if the ledger file does not exist yet.
   */
  recent(limit = 20): SharedStateEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const content = fs.readFileSync(this.file, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const tail = lines.slice(Math.max(0, lines.length - limit));
    const out: SharedStateEntry[] = [];
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line);
        if (this.isValidEntry(parsed)) out.push(parsed);
      } catch {
        // Skip malformed lines; ledger is best-effort observable state.
      }
    }
    return out;
  }

  /**
   * Render recent entries as a compact human-readable summary suitable for
   * injection into a session's context at turn start. Keeps output bounded.
   */
  renderForInjection(limit = 20): string {
    const entries = this.recent(limit);
    if (entries.length === 0) {
      return '[shared-state] no recent entries — this agent has no active cross-session state.';
    }
    const lines = ['[shared-state] recent cross-session activity (most recent last):'];
    for (const e of entries) {
      const partySuffix = e.party ? ` [party: ${e.party}]` : '';
      const summaryLine = e.summary ? `\n    ${e.summary}` : '';
      lines.push(`  - ${e.t} (${e.kind}) ${e.subject}${partySuffix}${summaryLine}`);
    }
    return lines.join('\n');
  }

  /**
   * For tests and inspection: the full path to the ledger file.
   */
  get filePath(): string {
    return this.file;
  }

  private isValidEntry(parsed: unknown): parsed is SharedStateEntry {
    if (!parsed || typeof parsed !== 'object') return false;
    const e = parsed as Record<string, unknown>;
    return (
      typeof e['id'] === 'string' &&
      typeof e['t'] === 'string' &&
      typeof e['sessionId'] === 'string' &&
      typeof e['kind'] === 'string' &&
      typeof e['subject'] === 'string'
    );
  }
}
