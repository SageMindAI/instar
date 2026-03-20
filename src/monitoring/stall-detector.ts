/**
 * Session Stall Detector — JSONL Tail Analysis
 *
 * Detects when a Claude Code session has stalled mid-tool-call by analyzing
 * the conversation JSONL file. A stall occurs when:
 * 1. The last assistant message has stop_reason: "tool_use"
 * 2. No subsequent tool_result has been received
 * 3. The time since the tool_use exceeds the threshold for that tool type
 *
 * Part of PROP-XXX: Session Stall Detection & Auto-Recovery
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StallInfo {
  jsonlPath: string;
  sessionUuid: string;
  stalledAt: string;
  stallDurationMs: number;
  lastToolName: string;
  lastToolInput: Record<string, unknown>;
  lastToolUseId: string;
}

/**
 * Per-tool stall thresholds in milliseconds.
 * Tools that legitimately take longer get higher thresholds.
 */
export const DEFAULT_TOOL_THRESHOLDS: Record<string, number> = {
  // Fast tools — should complete in seconds
  Read: 60_000,
  Write: 60_000,
  Edit: 60_000,
  Glob: 60_000,
  Grep: 60_000,

  // Medium tools — may take a few minutes
  Bash: 10 * 60_000,
  Skill: 5 * 60_000,

  // Slow tools — subagents and complex operations
  Agent: 15 * 60_000,

  // Default for unknown tools
  _default: 3 * 60_000,
};

/**
 * Detect if a Claude Code session has stalled mid-tool-call.
 *
 * @param jsonlPath - Path to the conversation JSONL file
 * @param maxAgeMs - Optional global override for stall threshold (overrides per-tool thresholds)
 * @returns StallInfo if stalled, null otherwise
 */
export function detectToolCallStall(
  jsonlPath: string,
  maxAgeMs?: number
): StallInfo | null {
  // 1. Read the tail of the file (last ~64KB — enough for ~20 JSONL entries)
  // Avoids reading entire 50MB+ files for a check that only needs the last few lines
  let tailContent: string;
  try {
    const stat = fs.statSync(jsonlPath);
    if (stat.size === 0) return null;

    const TAIL_BYTES = 64 * 1024; // 64KB tail read
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const readStart = Math.max(0, stat.size - TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
      fs.readSync(fd, buffer, 0, buffer.length, readStart);
      tailContent = buffer.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch { // @silent-fallback-ok — pure detector function; null means "no stall detected"
    return null; // File doesn't exist or can't be read
  }

  if (!tailContent.trim()) return null; // Empty content

  // 2. Parse JSONL lines from tail (only care about the last ~20 for efficiency)
  const lines = tailContent.trim().split('\n');
  // Skip first line if we started mid-file (likely a partial line)
  const tailLines = lines.length > 20
    ? lines.slice(-20)
    : (lines.length > 1 ? lines.slice(1) : lines); // Skip potentially truncated first line

  const entries: Array<{ type: string; message?: any; timestamp?: string }> = [];
  for (const line of tailLines) {
    try {
      entries.push(JSON.parse(line));
    } catch { // @silent-fallback-ok — skipping corrupt JSONL lines is expected during tail-read parsing
      // Skip corrupt lines
    }
  }

  if (entries.length === 0) return null;

  // 3. Find the last assistant message
  let lastAssistantIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  if (lastAssistantIdx === -1) return null;

  const lastAssistant = entries[lastAssistantIdx];
  const message = lastAssistant.message;
  if (!message) return null;

  // 4. Check if stop_reason is tool_use
  if (message.stop_reason !== 'tool_use') return null;

  // 5. Find the tool_use content blocks
  const contentBlocks = message.content || [];
  const toolUseBlocks = contentBlocks.filter(
    (b: any) => b.type === 'tool_use'
  );

  if (toolUseBlocks.length === 0) return null;

  // 6. Check if any subsequent entry contains a tool_result for these tool_use IDs
  const toolUseIds = new Set(toolUseBlocks.map((b: any) => b.id));
  let hasToolResult = false;

  for (let i = lastAssistantIdx + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === 'user' && entry.message?.content) {
      const resultBlocks = Array.isArray(entry.message.content)
        ? entry.message.content
        : [];
      for (const block of resultBlocks) {
        if (block.type === 'tool_result' && toolUseIds.has(block.tool_use_id)) {
          hasToolResult = true;
          break;
        }
      }
    }
    if (hasToolResult) break;
  }

  if (hasToolResult) return null; // Tool completed — no stall

  // 7. Calculate stall duration
  const toolUseTimestamp = lastAssistant.timestamp;
  if (!toolUseTimestamp) return null;

  const stalledAt = new Date(toolUseTimestamp);
  const now = new Date();
  const stallDurationMs = now.getTime() - stalledAt.getTime();

  // 8. Get the last tool_use block (the one that stalled)
  const lastToolUse = toolUseBlocks[toolUseBlocks.length - 1];
  const toolName: string = lastToolUse.name || 'unknown';

  // 9. Check against threshold
  const threshold = maxAgeMs ?? (DEFAULT_TOOL_THRESHOLDS[toolName] || DEFAULT_TOOL_THRESHOLDS._default);
  if (stallDurationMs < threshold) return null;

  // 10. Extract session UUID from filename
  const sessionUuid = path.basename(jsonlPath, '.jsonl');

  return {
    jsonlPath,
    sessionUuid,
    stalledAt: toolUseTimestamp,
    stallDurationMs,
    lastToolName: toolName,
    lastToolInput: lastToolUse.input || {},
    lastToolUseId: lastToolUse.id || '',
  };
}
