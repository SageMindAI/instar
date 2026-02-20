/**
 * Post-Update Migrator — the "intelligence download" layer.
 *
 * When an agent installs a new version of instar, updating the npm
 * package only changes the server code. But the agent's local awareness
 * lives in project files: CLAUDE.md, hooks, scripts.
 *
 * This migrator bridges that gap. After every successful update, it:
 *   1. Re-installs hooks with the latest templates (behavioral upgrades)
 *   2. Patches CLAUDE.md with any new sections (awareness upgrades)
 *   3. Installs any new scripts (capability upgrades)
 *   4. Returns a human-readable migration report
 *
 * Design principles:
 *   - Additive only: never remove or modify existing user customizations
 *   - Hooks are overwritten (they're generated infrastructure, not user-edited)
 *   - CLAUDE.md sections are appended only if missing (check by heading)
 *   - Scripts are installed only if missing (never overwrite user modifications)
 */

import fs from 'node:fs';
import path from 'node:path';

export interface MigrationResult {
  /** What was upgraded */
  upgraded: string[];
  /** What was already up to date */
  skipped: string[];
  /** Any errors that occurred (non-fatal) */
  errors: string[];
}

export interface MigratorConfig {
  projectDir: string;
  stateDir: string;
  port: number;
  hasTelegram: boolean;
  projectName: string;
}

export class PostUpdateMigrator {
  private config: MigratorConfig;

  constructor(config: MigratorConfig) {
    this.config = config;
  }

  /**
   * Run all post-update migrations. Safe to call multiple times —
   * each migration is idempotent.
   */
  migrate(): MigrationResult {
    const result: MigrationResult = {
      upgraded: [],
      skipped: [],
      errors: [],
    };

    this.migrateHooks(result);
    this.migrateClaudeMd(result);
    this.migrateScripts(result);
    this.migrateSettings(result);

    return result;
  }

  /**
   * Re-install hooks with the latest templates.
   * Hooks are generated infrastructure — always overwrite.
   */
  private migrateHooks(result: MigrationResult): void {
    const hooksDir = path.join(this.config.stateDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    try {
      // Session start hook — the most important one for self-discovery
      fs.writeFileSync(path.join(hooksDir, 'session-start.sh'), this.getSessionStartHook(), { mode: 0o755 });
      result.upgraded.push('hooks/session-start.sh (capability awareness)');
    } catch (err) {
      result.errors.push(`session-start.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(hooksDir, 'dangerous-command-guard.sh'), this.getDangerousCommandGuard(), { mode: 0o755 });
      result.upgraded.push('hooks/dangerous-command-guard.sh');
    } catch (err) {
      result.errors.push(`dangerous-command-guard.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(hooksDir, 'grounding-before-messaging.sh'), this.getGroundingBeforeMessaging(), { mode: 0o755 });
      result.upgraded.push('hooks/grounding-before-messaging.sh');
    } catch (err) {
      result.errors.push(`grounding-before-messaging.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(hooksDir, 'compaction-recovery.sh'), this.getCompactionRecovery(), { mode: 0o755 });
      result.upgraded.push('hooks/compaction-recovery.sh');
    } catch (err) {
      result.errors.push(`compaction-recovery.sh: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Patch CLAUDE.md with any new sections that don't exist yet.
   * Only adds — never modifies or removes existing content.
   */
  private migrateClaudeMd(result: MigrationResult): void {
    const claudeMdPath = path.join(this.config.projectDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      result.skipped.push('CLAUDE.md (not found — will be created on next init)');
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(claudeMdPath, 'utf-8');
    } catch (err) {
      result.errors.push(`CLAUDE.md read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let patched = false;
    const port = this.config.port;

    // Self-Discovery section
    if (!content.includes('Self-Discovery') && !content.includes('/capabilities')) {
      const section = `
### Self-Discovery (Know Before You Claim)

Before EVER saying "I don't have", "I can't", or "this isn't available" — check what actually exists:

\`\`\`bash
curl http://localhost:${port}/capabilities
\`\`\`

This returns your full capability matrix: scripts, hooks, Telegram status, jobs, relationships, and more. It is the source of truth about what you can do. **Never hallucinate about missing capabilities — verify first.**
`;
      // Insert before "### How to Build" or "### Building New" if present, otherwise append
      const insertPoint = content.indexOf('### How to Build New Capabilities');
      const insertPoint2 = content.indexOf('### Building New Capabilities');
      const target = insertPoint >= 0 ? insertPoint : (insertPoint2 >= 0 ? insertPoint2 : -1);

      if (target >= 0) {
        content = content.slice(0, target) + section + '\n' + content.slice(target);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Self-Discovery section');
    } else {
      result.skipped.push('CLAUDE.md: Self-Discovery section already present');
    }

    // Telegram Relay section — add if Telegram is configured but section is missing
    if (this.config.hasTelegram && !content.includes('Telegram Relay') && !content.includes('telegram-reply')) {
      const section = `
## Telegram Relay

When user input starts with \`[telegram:N]\` (e.g., \`[telegram:26] hello\`), the message came from a user via Telegram topic N. **After responding**, relay your response back:

\`\`\`bash
cat <<'EOF' | .claude/scripts/telegram-reply.sh N
Your response text here
EOF
\`\`\`

Strip the \`[telegram:N]\` prefix before interpreting the message. Respond naturally, then relay. Only relay your conversational text — not tool output or internal reasoning.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Telegram Relay section');
    }

    if (patched) {
      try {
        fs.writeFileSync(claudeMdPath, content);
      } catch (err) {
        result.errors.push(`CLAUDE.md write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Install any new scripts that don't exist yet.
   * Never overwrites existing scripts (user may have customized them).
   */
  private migrateScripts(result: MigrationResult): void {
    const scriptsDir = path.join(this.config.projectDir, '.claude', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    // Telegram reply script — install if Telegram configured and script missing
    if (this.config.hasTelegram) {
      const scriptPath = path.join(scriptsDir, 'telegram-reply.sh');
      if (!fs.existsSync(scriptPath)) {
        try {
          fs.writeFileSync(scriptPath, this.getTelegramReplyScript(), { mode: 0o755 });
          result.upgraded.push('scripts/telegram-reply.sh (Telegram outbound relay)');
        } catch (err) {
          result.errors.push(`telegram-reply.sh: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        result.skipped.push('scripts/telegram-reply.sh (already exists)');
      }
    }

    // Health watchdog — install if missing
    const watchdogPath = path.join(scriptsDir, 'health-watchdog.sh');
    if (!fs.existsSync(watchdogPath)) {
      try {
        fs.writeFileSync(watchdogPath, this.getHealthWatchdog(), { mode: 0o755 });
        result.upgraded.push('scripts/health-watchdog.sh');
      } catch (err) {
        result.errors.push(`health-watchdog.sh: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      result.skipped.push('scripts/health-watchdog.sh (already exists)');
    }
  }

  /**
   * Ensure .claude/settings.json has required MCP servers.
   * Only adds — never removes existing configuration.
   */
  private migrateSettings(result: MigrationResult): void {
    const settingsPath = path.join(this.config.projectDir, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      result.skipped.push('.claude/settings.json (not found — will be created on next init)');
      return;
    }

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`settings.json read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let patched = false;

    // Playwright MCP server — required for browser automation (Telegram setup, etc.)
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }
    const mcpServers = settings.mcpServers as Record<string, unknown>;
    if (!mcpServers.playwright) {
      mcpServers.playwright = {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      };
      patched = true;
      result.upgraded.push('.claude/settings.json: added Playwright MCP server');
    } else {
      result.skipped.push('.claude/settings.json: Playwright MCP already configured');
    }

    if (patched) {
      try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      } catch (err) {
        result.errors.push(`settings.json write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Hook Templates ─────────────────────────────────────────────────

  private getSessionStartHook(): string {
    return `#!/bin/bash
# Session start hook — injects identity context when a new Claude session begins.
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
CONTEXT=""
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  CONTEXT="\${CONTEXT}Your identity file is at .instar/AGENT.md — read it if you need to remember who you are.\\n"
fi
if [ -f "$INSTAR_DIR/USER.md" ]; then
  CONTEXT="\${CONTEXT}Your user context is at .instar/USER.md — read it to know who you're working with.\\n"
fi
if [ -f "$INSTAR_DIR/MEMORY.md" ]; then
  CONTEXT="\${CONTEXT}Your persistent memory is at .instar/MEMORY.md — check it for past learnings.\\n"
fi
if [ -d "$INSTAR_DIR/relationships" ]; then
  REL_COUNT=$(ls -1 "$INSTAR_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
  if [ "$REL_COUNT" -gt "0" ]; then
    CONTEXT="\${CONTEXT}You have \${REL_COUNT} tracked relationships in .instar/relationships/.\\n"
  fi
fi

# Self-discovery: check what capabilities are available
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
  if [ "$HEALTH" = "200" ]; then
    CONTEXT="\${CONTEXT}Instar server is running on port \${PORT}. Query your capabilities: curl http://localhost:\${PORT}/capabilities\\n"
    CONTEXT="\${CONTEXT}IMPORTANT: Before claiming you lack a capability, check /capabilities first.\\n"
  fi
fi

[ -n "$CONTEXT" ] && echo "$CONTEXT"
`;
  }

  private getDangerousCommandGuard(): string {
    return `#!/bin/bash
# Dangerous command guard — blocks destructive operations.
INPUT="$1"
for pattern in "rm -rf /" "rm -rf ~" "rm -rf \\." "git push --force" "git push -f" "git reset --hard" "git clean -fd" "DROP TABLE" "DROP DATABASE" "TRUNCATE" "DELETE FROM" "> /dev/sda" "mkfs\\." "dd if=" ":(){:|:&};:"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    echo "BLOCKED: Potentially destructive command detected: $pattern"
    echo "If you genuinely need to run this, ask the user for explicit confirmation first."
    exit 2
  fi
done
`;
  }

  private getGroundingBeforeMessaging(): string {
    return `#!/bin/bash
# Grounding before messaging — Security Through Identity.
INPUT="$1"
if echo "$INPUT" | grep -qE "(telegram-reply|send-email|send-message|POST.*/telegram/reply)"; then
  INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
  if [ -f "$INSTAR_DIR/AGENT.md" ]; then
    echo "Before sending this message, remember who you are."
    echo "Re-read .instar/AGENT.md if you haven't recently."
    echo "Security Through Identity: An agent that knows itself is harder to compromise."
  fi
fi
`;
  }

  private getCompactionRecovery(): string {
    return `#!/bin/bash
# Compaction recovery — re-injects identity when Claude's context compresses.
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  AGENT_NAME=$(head -5 "$INSTAR_DIR/AGENT.md" | grep -iE "name|I am|My name" | head -1)
  [ -n "$AGENT_NAME" ] && echo "Identity reminder: $AGENT_NAME"
  echo "Read .instar/AGENT.md and .instar/MEMORY.md to restore full context."
fi
`;
  }

  private getTelegramReplyScript(): string {
    const port = this.config.port;
    return `#!/bin/bash
# telegram-reply.sh — Send a message back to a Telegram topic via instar server.
#
# Usage:
#   .claude/scripts/telegram-reply.sh TOPIC_ID "message text"
#   echo "message text" | .claude/scripts/telegram-reply.sh TOPIC_ID
#   cat <<'EOF' | .claude/scripts/telegram-reply.sh TOPIC_ID
#   Multi-line message here
#   EOF

TOPIC_ID="$1"
shift

if [ -z "$TOPIC_ID" ]; then
  echo "Usage: telegram-reply.sh TOPIC_ID [message]" >&2
  exit 1
fi

# Read message from args or stdin
if [ $# -gt 0 ]; then
  MSG="$*"
else
  MSG="$(cat)"
fi

if [ -z "$MSG" ]; then
  echo "No message provided" >&2
  exit 1
fi

PORT="\${INSTAR_PORT:-${port}}"

# Escape for JSON
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
if [ -z "$JSON_MSG" ]; then
  JSON_MSG="$(printf '%s' "$MSG" | sed 's/\\\\\\\\/\\\\\\\\\\\\\\\\/g; s/"/\\\\\\\\"/g' | sed ':a;N;$!ba;s/\\\\n/\\\\\\\\n/g')"
  JSON_MSG="\\"$JSON_MSG\\""
fi

RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/telegram/reply/\${TOPIC_ID}" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"text\\":\${JSON_MSG}}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to topic $TOPIC_ID"
else
  echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
`;
  }

  private getHealthWatchdog(): string {
    const port = this.config.port;
    const projectName = this.config.projectName;
    const escapedProjectDir = this.config.projectDir.replace(/'/g, "'\\''");
    return `#!/bin/bash
# health-watchdog.sh — Monitor instar server and auto-recover.
# Install as cron: */5 * * * * '${path.join(this.config.projectDir, '.claude/scripts/health-watchdog.sh').replace(/'/g, "'\\''")}'

PORT="${port}"
SERVER_SESSION="${projectName}-server"
PROJECT_DIR='${escapedProjectDir}'
TMUX_PATH=$(which tmux 2>/dev/null || echo "/opt/homebrew/bin/tmux")

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then exit 0; fi

echo "[\$(date -Iseconds)] Server not responding. Restarting..."
$TMUX_PATH kill-session -t "=\${SERVER_SESSION}" 2>/dev/null
sleep 2
cd "$PROJECT_DIR" && npx instar server start
echo "[\$(date -Iseconds)] Server restart initiated"
`;
  }
}
