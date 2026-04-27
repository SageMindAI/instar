/**
 * droppedMessages — persistence + user-visible notification for messages
 * the lifeline could not deliver to the server.
 *
 * When `replayQueue` exhausts MAX_REPLAY_FAILURES for a message, the message
 * is about to be lost. Before we drop it we:
 *   1. Append a record to `<stateDir>/state/dropped-messages.json` (so an
 *      operator — or the `/lifeline queue` command later — can surface it).
 *   2. Emit a DegradationReporter event so the normal fallback-is-a-bug
 *      pipeline files a feedback report and alerts the attention topic.
 *   3. Send the original sender a plain-English Telegram notice asking
 *      them to resend.
 *
 * This module is a pure signal producer. It makes dropped messages LOUD,
 * not silent; it does not make any block/allow decision.
 *
 * NOTE on a sibling system: `MessageRouter`/`MessageStore` in src/messaging/
 * already implements a server-side dead-letter queue. The lifeline uses its
 * own file-backed record because it runs in a separate process without
 * access to the server's in-memory MessageStore. See spec §Scope for the
 * process-boundary rationale.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

/** Maximum preview length stored per dropped record. */
const TEXT_PREVIEW_MAX = 200;
/** Ring-buffer cap on the on-disk dropped-messages history. */
const HISTORY_CAP = 500;
/** Timeout for the best-effort per-sender Telegram notice. */
const NOTICE_SEND_TIMEOUT_MS = 5000;
/** DegradationReporter feature name for message forwarding drops. */
const FEATURE_FORWARD = 'TelegramLifeline.forwardToServer';
/**
 * DegradationReporter feature name for the distinct case where the durable
 * persistence ITSELF failed. Separate feature → independent 1h cooldown, so
 * a pathological correlated failure (persist throws while FEATURE_FORWARD
 * is in cooldown) still produces exactly one loud operator-visible signal.
 */
const FEATURE_PERSIST_FAIL = 'TelegramLifeline.dropRecordPersist';

export interface DroppedMessageRecord {
  timestamp: string;
  topicId: number;
  messageId: string;
  senderName: string;
  textPreview: string;
  retryCount: number;
  reason: string;
}

/**
 * Append a dropped-message record to state/dropped-messages.json.
 * Atomic file swap: writes to a .tmp file then renames. If the rename
 * fails the existing file is left untouched (the caller will see the
 * throw). Read-modify-write is not atomic across concurrent callers;
 * the lifeline's exclusive lockfile ensures there is only one writer.
 */
export function appendDroppedMessage(
  stateDir: string,
  record: Omit<DroppedMessageRecord, 'timestamp'>,
): void {
  const stateSub = path.join(stateDir, 'state');
  fs.mkdirSync(stateSub, { recursive: true });
  const filePath = path.join(stateSub, 'dropped-messages.json');

  const existing = readDroppedMessages(stateDir);
  const full: DroppedMessageRecord = {
    timestamp: new Date().toISOString(),
    ...record,
    textPreview: record.textPreview.slice(0, TEXT_PREVIEW_MAX),
  };
  existing.push(full);

  const trimmed = existing.length > HISTORY_CAP
    ? existing.slice(-HISTORY_CAP)
    : existing;

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(trimmed, null, 2));
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Read the dropped-messages history. Returns [] if the file does not
 * exist or is corrupt (never throws — corruption shouldn't poison callers).
 */
export function readDroppedMessages(stateDir: string): DroppedMessageRecord[] {
  const filePath = path.join(stateDir, 'state', 'dropped-messages.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface NotifyMessageDroppedArgs {
  stateDir: string;
  topicId: number;
  messageId: string;
  senderName: string;
  /** The full original message text. Truncated internally for storage / notice. */
  text: string;
  retryCount: number;
  reason: string;
  /** Best-effort sender. Failures and slow responses are swallowed. */
  sendToTopic: (topicId: number, text: string) => Promise<unknown>;
}

/**
 * Build the user-visible notice. The preview quotes the original message
 * inside a Markdown code fence. Because `sendToTopic` uses
 * `parse_mode: 'Markdown'`, any `_`, `*`, backtick, or `[` characters in
 * raw text would otherwise be interpreted as formatting — enabling
 * rendered links or bold text attributed to the agent. Wrapping in a
 * fenced code block disables Markdown parsing inside; stripping triple
 * backticks from the preview prevents breakout.
 */
function buildNotice(textPreview: string): string {
  const safe = textPreview.replace(/```/g, "'''");
  return (
    `⚠️ I couldn't deliver a message you just sent — something on my end kept failing. Could you resend it?\n\n` +
    `What I missed:\n\`\`\`\n${safe}\n\`\`\``
  );
}

/**
 * Race a promise against a timeout. Resolves to the promise's value or
 * rejects on timeout. Used to bound best-effort Telegram notices when the
 * Telegram API itself may be the failure cause.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Handle a dropped message: persist + report + tell the sender.
 *
 * All three side-effects are best-effort in the sense that a single one
 * failing should not block the others. If persistence throws, a distinct
 * DegradationReporter feature (`TelegramLifeline.dropRecordPersist`) is
 * also fired — its independent cooldown guarantees a loud signal even
 * when the primary feature is mid-cooldown.
 */
export async function notifyMessageDropped(args: NotifyMessageDroppedArgs): Promise<void> {
  const textPreview = args.text.slice(0, TEXT_PREVIEW_MAX);

  let persistError: unknown = null;
  try {
    appendDroppedMessage(args.stateDir, {
      topicId: args.topicId,
      messageId: args.messageId,
      senderName: args.senderName,
      textPreview,
      retryCount: args.retryCount,
      reason: args.reason,
    });
  } catch (err) {
    persistError = err;
  }

  try {
    DegradationReporter.getInstance().report({
      feature: FEATURE_FORWARD,
      primary: 'Forwarding incoming Telegram messages to the server via /internal/telegram-forward',
      fallback: 'Message dropped — not delivered to the agent',
      reason: args.reason,
      impact: `A message from ${args.senderName} was not delivered; the sender has been asked to resend`,
    });
  } catch {
    // DegradationReporter has its own @silent-fallback-ok fallbacks; best-effort.
  }

  if (persistError) {
    // Distinct feature so its cooldown is independent of FEATURE_FORWARD.
    // Guarantees one loud operator signal even in correlated-failure paths.
    try {
      DegradationReporter.getInstance().report({
        feature: FEATURE_PERSIST_FAIL,
        primary: 'Persisting dropped-message record to state/dropped-messages.json',
        fallback: 'No durable record of this drop on disk',
        reason: persistError instanceof Error ? persistError.message : String(persistError),
        impact: `Drop of message ${args.messageId} from ${args.senderName} has no durable record; investigate disk/permissions`,
      });
    } catch {
      // Best-effort.
    }
  }

  try {
    await withTimeout(
      Promise.resolve(args.sendToTopic(args.topicId, buildNotice(textPreview))),
      NOTICE_SEND_TIMEOUT_MS,
      'sendToTopic notice',
    );
  } catch {
    // Best-effort; the persisted record + degradation report are the authoritative signals.
  }

  if (persistError) {
    // eslint-disable-next-line no-console
    console.error(
      `[Lifeline] Failed to persist dropped-message record for ${args.messageId}:`,
      persistError instanceof Error ? persistError.message : persistError,
    );
  }
}
