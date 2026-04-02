/**
 * intercept-imsg-send.js — PreToolUse hook to block direct iMessage sending.
 *
 * Layer 2 of the 5-layer outbound safety defense-in-depth.
 *
 * Blocks: imsg send, osascript+Messages.app, common indirect execution patterns.
 * Allows: imsg chats, imsg --version, imsg --help (read-only operations).
 *
 * Known limitations (Phase 1 accepted risks):
 * - Scripts written to files and executed bypass inline pattern matching
 * - Base64-encoded commands bypass regex detection
 * - macOS Shortcuts.app could be invoked to send messages
 * - Addressed structurally in Phase 2 (OS-level permission revocation)
 *
 * Install: Place in .claude/hooks/ and register as PreToolUse hook on Bash tool.
 * Integrity: chmod 444 after install. Server verifies SHA-256 hash periodically.
 */

// Hook receives tool input on stdin
const input = await new Promise((resolve) => {
  let data = '';
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => {
    try { resolve(JSON.parse(data)); }
    catch { resolve({}); }
  });
});

const toolName = input.tool_name || '';
const toolInput = input.tool_input || {};

// Only intercept Bash tool calls
if (toolName !== 'Bash') {
  // Allow all non-Bash tools
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
  process.exit(0);
}

const command = (toolInput.command || '').toString();

// Patterns that indicate direct iMessage sending
const BLOCKED_PATTERNS = [
  // Direct imsg send
  /\bimsg\s+send\b/i,
  // AppleScript targeting Messages.app
  /\bosascript\b.*\bMessages\b/i,
  /\btell\s+application\s+"Messages"/i,
  /\btell\s+application\s+'Messages'/i,
  // Indirect execution with iMessage references
  /\b(?:python3?|node|ruby|perl)\s+(?:-[ce]|--eval)\s+.*\b(?:imsg\s+send|Messages)\b/i,
  // Piped execution
  /\becho\s+.*\b(?:imsg\s+send|Messages)\b.*\|\s*(?:ba)?sh/i,
  // Crontab modification (could schedule sends)
  /\bcrontab\s+-[elr]/i,
  // macOS Shortcuts that could send messages
  /\bshortcuts\s+run\b.*(?:message|sms|imessage|send)/i,
];

const isBlocked = BLOCKED_PATTERNS.some((p) => p.test(command));

if (isBlocked) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: 'Direct iMessage sending is blocked. Use imessage-reply.sh for authorized sends.',
  }));
} else {
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
}
