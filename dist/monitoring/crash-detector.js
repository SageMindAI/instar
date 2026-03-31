/**
 * Session Crash Detector — JSONL Analysis for Dead Sessions
 *
 * Detects when a Claude Code session has crashed by analyzing the JSONL
 * conversation file in combination with process status. A crash occurs when:
 * 1. The Claude process is no longer alive
 * 2. The JSONL ends in a problematic state (tool_use with no result, error pattern)
 *
 * Also detects error loops — repeated identical errors that suggest the session
 * is stuck retrying the same failing approach.
 *
 * Part of PROP-session-stall-recovery Phase B
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
// ============================================================================
// Crash Detection
// ============================================================================
/**
 * Detect if a Claude Code session has crashed.
 * A crash = process dead + JSONL ends in a non-terminal state.
 *
 * @param jsonlPath - Path to the conversation JSONL file
 * @param processAlive - Whether the Claude process is still running
 * @returns CrashInfo if crashed, null if clean exit or process still alive
 */
export function detectCrashedSession(jsonlPath, processAlive) {
    // If process is still alive, it's not a crash (might be a stall — handled by stall-detector)
    if (processAlive)
        return null;
    const entries = readTailEntries(jsonlPath);
    if (entries.length === 0)
        return null;
    // Find the last entry with a message
    let lastEntry = null;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].message || entries[i].type === 'assistant' || entries[i].type === 'user') {
            lastEntry = entries[i];
            break;
        }
    }
    if (!lastEntry)
        return null;
    const message = lastEntry.message;
    if (!message)
        return null;
    // Clean exit: last message has stop_reason: 'end_turn' — process exited normally
    if (message.stop_reason === 'end_turn')
        return null;
    // Crash indicator 1: Last assistant message has stop_reason: 'tool_use' but no result follows
    if (lastEntry.type === 'assistant' && message.stop_reason === 'tool_use') {
        const toolBlocks = (message.content || []).filter((b) => b.type === 'tool_use');
        const lastTool = toolBlocks[toolBlocks.length - 1];
        return {
            type: 'crash',
            jsonlPath,
            sessionUuid: extractSessionUuid(jsonlPath),
            detectedAt: new Date().toISOString(),
            errorType: 'tool_use_incomplete',
            lastToolName: lastTool?.name,
            lastToolInput: lastTool?.input,
        };
    }
    // Crash indicator 2: Last entry is a tool_result with is_error: true
    if (lastEntry.type === 'user' && Array.isArray(message.content)) {
        const errorResults = message.content.filter((b) => b.type === 'tool_result' && b.is_error);
        if (errorResults.length > 0) {
            const lastError = errorResults[errorResults.length - 1];
            const errorMsg = typeof lastError.content === 'string' ? lastError.content : '';
            return {
                type: 'crash',
                jsonlPath,
                sessionUuid: extractSessionUuid(jsonlPath),
                detectedAt: new Date().toISOString(),
                errorMessage: errorMsg.slice(0, 500),
                errorType: classifyError(errorMsg),
            };
        }
    }
    return null;
}
// ============================================================================
// Error Loop Detection
// ============================================================================
/**
 * Detect if a session is stuck in an error loop — repeating the same failing approach.
 *
 * @param jsonlPath - Path to the conversation JSONL file
 * @param minRepetitions - Minimum number of identical errors to count as a loop (default: 3)
 * @returns ErrorLoopInfo if loop detected, null otherwise
 */
export function detectErrorLoop(jsonlPath, minRepetitions = 3) {
    const entries = readTailEntries(jsonlPath, 50); // Look at more entries for loop detection
    if (entries.length === 0)
        return null;
    // Collect all error results
    const errors = [];
    const commands = new Map(); // toolUseId -> command
    for (const entry of entries) {
        // Track tool_use commands
        if (entry.type === 'assistant' && entry.message?.content) {
            for (const block of entry.message.content) {
                if (block.type === 'tool_use' && block.id) {
                    const cmd = block.input?.command || block.input?.file_path || block.name || '';
                    commands.set(block.id, String(cmd));
                }
            }
        }
        // Collect errors
        if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
            for (const block of entry.message.content) {
                if (block.type === 'tool_result' && block.is_error) {
                    const content = typeof block.content === 'string' ? block.content : '';
                    errors.push({
                        content: normalizeError(content),
                        toolUseId: block.tool_use_id || '',
                    });
                }
            }
        }
    }
    if (errors.length < minRepetitions)
        return null;
    // Check for repeated identical errors (by normalized content)
    const errorCounts = new Map();
    for (const err of errors) {
        const count = (errorCounts.get(err.content) || 0) + 1;
        errorCounts.set(err.content, count);
    }
    for (const [pattern, count] of Array.from(errorCounts.entries())) {
        if (count >= minRepetitions) {
            // Find the associated command
            const matchingError = errors.find(e => e.content === pattern);
            const failingCommand = matchingError ? commands.get(matchingError.toolUseId) : undefined;
            return {
                type: 'error_loop',
                jsonlPath,
                sessionUuid: extractSessionUuid(jsonlPath),
                detectedAt: new Date().toISOString(),
                loopCount: count,
                failingPattern: pattern.slice(0, 200),
                failingCommand,
            };
        }
    }
    return null;
}
// ============================================================================
// Helpers
// ============================================================================
/**
 * Read the tail entries of a JSONL file.
 */
function readTailEntries(jsonlPath, maxEntries = 20) {
    let tailContent;
    try {
        const stat = fs.statSync(jsonlPath);
        if (stat.size === 0)
            return [];
        const TAIL_BYTES = 128 * 1024; // 128KB for crash/loop detection (need more context)
        const fd = fs.openSync(jsonlPath, 'r');
        try {
            const readStart = Math.max(0, stat.size - TAIL_BYTES);
            const buffer = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
            fs.readSync(fd, buffer, 0, buffer.length, readStart);
            tailContent = buffer.toString('utf-8');
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch { // @silent-fallback-ok — pure detector function; empty array means "no crash detected"
        return [];
    }
    if (!tailContent.trim())
        return [];
    const lines = tailContent.trim().split('\n');
    const tailLines = lines.length > maxEntries
        ? lines.slice(-maxEntries)
        : (lines.length > 1 ? lines.slice(1) : lines); // Skip potentially truncated first line
    const entries = [];
    for (const line of tailLines) {
        try {
            entries.push(JSON.parse(line));
        }
        catch {
            // Skip corrupt lines
        }
    }
    return entries;
}
/**
 * Normalize an error message for comparison (strip variable parts like timestamps, PIDs).
 */
function normalizeError(error) {
    return error
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, '<TIMESTAMP>')
        .replace(/pid\s*[:=]\s*\d+/gi, 'pid:<PID>')
        .replace(/port\s*[:=]\s*\d+/gi, 'port:<PORT>')
        .trim();
}
/**
 * Classify an error message into a type.
 */
function classifyError(errorMessage) {
    const lower = errorMessage.toLowerCase();
    if (lower.includes('parsing') || lower.includes('json') || lower.includes('syntax')) {
        return 'parsing';
    }
    if (lower.includes('api') || lower.includes('rate limit') || lower.includes('invalid_request_error') || lower.includes('overloaded_error') || lower.includes('429') || lower.includes('400') || lower.includes('500') || lower.includes('502') || lower.includes('503')) {
        return 'api';
    }
    if (lower.includes('internal') || lower.includes('segfault') || lower.includes('heap')) {
        return 'internal';
    }
    return 'unknown';
}
/**
 * Extract session UUID from JSONL filename.
 */
function extractSessionUuid(jsonlPath) {
    return path.basename(jsonlPath, '.jsonl');
}
//# sourceMappingURL=crash-detector.js.map