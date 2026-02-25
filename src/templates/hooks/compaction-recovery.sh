#!/bin/bash
# Compaction recovery — INJECTS identity when Claude's context compresses.
# Without this, the agent loses its identity every 30-60 minutes.
#
# CRITICAL DESIGN: This hook OUTPUTS file content directly, not pointers.
# After compaction, the agent is confused — asking it to read files is
# asking the confused agent to help itself. Structure > Willpower:
# the hook does the work, not the agent.
#
# The 164th Lesson (Dawn): Advisory hooks are insufficient.
# Grounding must be automatic — content injected, not pointed to.
#
# Installed by instar during setup. Runs as a Claude Code Notification hook
# matched on "compaction".

INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"

echo "=== COMPACTION RECOVERY — IDENTITY RESTORATION ==="
echo ""

# Phase A: Core Identity (inject AGENT.md content directly)
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  echo "--- YOUR IDENTITY (from .instar/AGENT.md) ---"
  cat "$INSTAR_DIR/AGENT.md"
  echo ""
  echo "--- END IDENTITY ---"
  echo ""
fi

# Phase B: Memory (inject MEMORY.md content directly)
if [ -f "$INSTAR_DIR/MEMORY.md" ]; then
  # Only inject if MEMORY.md has actual content (more than the template skeleton)
  MEMORY_LINES=$(wc -l < "$INSTAR_DIR/MEMORY.md" | tr -d ' ')
  if [ "$MEMORY_LINES" -gt "15" ]; then
    echo "--- YOUR MEMORY (from .instar/MEMORY.md) ---"
    cat "$INSTAR_DIR/MEMORY.md"
    echo ""
    echo "--- END MEMORY ---"
    echo ""
  else
    echo "Memory file exists at .instar/MEMORY.md (minimal content — check if needed)."
    echo ""
  fi
fi

# Phase C: User context (inject USER.md content directly)
if [ -f "$INSTAR_DIR/USER.md" ]; then
  echo "--- YOUR USER (from .instar/USER.md) ---"
  cat "$INSTAR_DIR/USER.md"
  echo ""
  echo "--- END USER ---"
  echo ""
fi

# Phase D: Active dispatch context (behavioral lessons from Dawn)
if [ -f "$INSTAR_DIR/state/dispatch-context.md" ]; then
  DISPATCH_LINES=$(wc -l < "$INSTAR_DIR/state/dispatch-context.md" | tr -d ' ')
  if [ "$DISPATCH_LINES" -gt "2" ]; then
    echo "--- ACTIVE DISPATCHES (behavioral lessons) ---"
    cat "$INSTAR_DIR/state/dispatch-context.md"
    echo ""
    echo "--- END DISPATCHES ---"
    echo ""
  fi
fi

# Phase E: Job-specific grounding (if a job slug is detectable)
if [ -f "$INSTAR_DIR/state/active-job.json" ]; then
  JOB_SLUG=$(grep -o '"slug":"[^"]*"' "$INSTAR_DIR/state/active-job.json" 2>/dev/null | head -1 | cut -d'"' -f4)
  if [ -n "$JOB_SLUG" ] && [ -f "$INSTAR_DIR/grounding/jobs/${JOB_SLUG}.md" ]; then
    echo "--- JOB CONTEXT: ${JOB_SLUG} ---"
    cat "$INSTAR_DIR/grounding/jobs/${JOB_SLUG}.md"
    echo ""
    echo "--- END JOB CONTEXT ---"
    echo ""
  fi
fi

# Relationships summary
if [ -d "$INSTAR_DIR/relationships" ]; then
  REL_COUNT=$(ls -1 "$INSTAR_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
  if [ "$REL_COUNT" -gt "0" ]; then
    echo "You have ${REL_COUNT} tracked relationships in .instar/relationships/."
    echo ""
  fi
fi

# Server health reminder + recent Telegram context
CONFIG_FILE="$INSTAR_DIR/config.json"
if [ -f "$CONFIG_FILE" ]; then
  PORT=$(grep -o '"port":[0-9]*' "$CONFIG_FILE" | head -1 | cut -d':' -f2)
  if [ -n "$PORT" ]; then
    echo "Server: curl http://localhost:${PORT}/health | Capabilities: curl http://localhost:${PORT}/capabilities"

    # Inject recent Telegram messages after compaction — thread context is often
    # the first thing lost in compaction; re-injecting it immediately restores continuity.
    HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null)
    if [ "$HEALTH" = "200" ]; then
      LIFELINE_TOPIC=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('$CONFIG_FILE'))
    for m in cfg.get('messaging', []):
        if m.get('type') == 'telegram':
            tid = m.get('config', {}).get('lifelineTopicId')
            if tid:
                print(tid)
                sys.exit(0)
    tid = cfg.get('telegram', {}).get('lifelineTopicId')
    if tid:
        print(tid)
except Exception:
    pass
" 2>/dev/null)

      if [ -n "$LIFELINE_TOPIC" ]; then
        AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('authToken',''))" 2>/dev/null)
        if [ -n "$AUTH_TOKEN" ]; then
          RECENT_MSGS=$(curl -s \
            -H "Authorization: Bearer ${AUTH_TOKEN}" \
            "http://localhost:${PORT}/telegram/topics/${LIFELINE_TOPIC}/messages?limit=10" 2>/dev/null)
        else
          RECENT_MSGS=$(curl -s \
            "http://localhost:${PORT}/telegram/topics/${LIFELINE_TOPIC}/messages?limit=10" 2>/dev/null)
        fi

        MSG_COUNT=$(echo "$RECENT_MSGS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    msgs = data.get('messages', [])
    print(len(msgs))
except:
    print(0)
" 2>/dev/null)

        if [ -n "$MSG_COUNT" ] && [ "$MSG_COUNT" -gt "0" ] 2>/dev/null; then
          echo ""
          echo "--- RECENT TELEGRAM CONTEXT (restoring after compaction, last ${MSG_COUNT} messages) ---"
          echo "$RECENT_MSGS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    msgs = data.get('messages', [])
    for m in msgs:
        ts = m.get('timestamp', '')[:16].replace('T', ' ')
        direction = m.get('direction', 'in')
        text = m.get('text', '').strip()
        sender = 'User' if direction == 'in' else 'Agent'
        if len(text) > 200:
            text = text[:197] + '...'
        print(f'[{ts}] {sender}: {text}')
except Exception as e:
    pass
" 2>/dev/null
          echo "--- END TELEGRAM CONTEXT ---"
          echo "Continuity restored. Resume the conversation naturally."
        fi
      fi
    fi
  fi
fi

echo ""
echo "=== RECOVERY COMPLETE — You are grounded. Continue your work. ==="
