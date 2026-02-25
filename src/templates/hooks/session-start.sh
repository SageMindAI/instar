#!/bin/bash
# Session start hook — injects identity context when a new Claude session begins.
# This is how the agent maintains continuity: every session starts with self-knowledge.
#
# DESIGN: This hook differentiates between session phases:
# - First tool use: Full identity injection (AGENT.md content)
# - Subsequent uses: Lightweight pointer only
# - Server health check on first run
#
# Structure > Willpower: Identity content is OUTPUT, not just pointed to.
#
# Installed by instar during setup. Runs as a Claude Code PostToolUse hook.

INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"
STATE_DIR="$INSTAR_DIR/state"
MARKER_FILE="$STATE_DIR/.session-started"

# Ensure state directory exists
mkdir -p "$STATE_DIR" 2>/dev/null

# Check if this is the first tool use in this session
# The marker file is cleaned up when the process exits or on next session
if [ ! -f "$MARKER_FILE" ]; then
  # First tool use — full identity injection
  echo "$PPID" > "$MARKER_FILE"

  echo "=== SESSION START — IDENTITY LOADED ==="
  echo ""

  # Inject AGENT.md content directly (Structure > Willpower)
  if [ -f "$INSTAR_DIR/AGENT.md" ]; then
    echo "--- YOUR IDENTITY ---"
    cat "$INSTAR_DIR/AGENT.md"
    echo ""
    echo "--- END IDENTITY ---"
    echo ""
  fi

  # Inject USER.md content directly
  if [ -f "$INSTAR_DIR/USER.md" ]; then
    echo "--- YOUR USER ---"
    cat "$INSTAR_DIR/USER.md"
    echo ""
    echo "--- END USER ---"
    echo ""
  fi

  # Inject MEMORY.md if it has substantial content
  if [ -f "$INSTAR_DIR/MEMORY.md" ]; then
    MEMORY_LINES=$(wc -l < "$INSTAR_DIR/MEMORY.md" | tr -d ' ')
    if [ "$MEMORY_LINES" -gt "15" ]; then
      echo "--- YOUR MEMORY (verify claims about external state before acting on them) ---"
      cat "$INSTAR_DIR/MEMORY.md"
      echo ""
      echo "--- END MEMORY ---"
      echo ""
    else
      echo "Memory at .instar/MEMORY.md (minimal — grow it as you learn)."
      echo ""
    fi
  fi

  # Inject last job handoff notes if this is a job session
  if [ -f "$STATE_DIR/active-job.json" ]; then
    ACTIVE_SLUG=$(grep -o '"slug":"[^"]*"' "$STATE_DIR/active-job.json" | head -1 | cut -d'"' -f4)
    if [ -n "$ACTIVE_SLUG" ]; then
      HANDOFF_FILE="$STATE_DIR/job-handoff-${ACTIVE_SLUG}.md"
      if [ -f "$HANDOFF_FILE" ]; then
        echo "--- PREVIOUS JOB RUN NOTES (claims — verify before trusting) ---"
        cat "$HANDOFF_FILE"
        echo ""
        echo "--- END PREVIOUS RUN NOTES ---"
        echo "These are CLAIMS from a previous session. Verify any external state before including in your output."
        echo ""
      fi
    fi
  fi

  # Active dispatch context (behavioral lessons from Dawn)
  if [ -f "$STATE_DIR/dispatch-context.md" ]; then
    DISPATCH_LINES=$(wc -l < "$STATE_DIR/dispatch-context.md" | tr -d ' ')
    if [ "$DISPATCH_LINES" -gt "2" ]; then
      echo "--- ACTIVE DISPATCHES ---"
      cat "$STATE_DIR/dispatch-context.md"
      echo ""
      echo "--- END DISPATCHES ---"
      echo ""
    fi
  fi

  # Relationships count
  if [ -d "$INSTAR_DIR/relationships" ]; then
    REL_COUNT=$(ls -1 "$INSTAR_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
    if [ "$REL_COUNT" -gt "0" ]; then
      echo "You have ${REL_COUNT} tracked relationships in .instar/relationships/."
      echo ""
    fi
  fi

  # Server health check + Telegram topic history
  CONFIG_FILE="$INSTAR_DIR/config.json"
  if [ -f "$CONFIG_FILE" ]; then
    PORT=$(grep -o '"port":[0-9]*' "$CONFIG_FILE" | head -1 | cut -d':' -f2)
    if [ -n "$PORT" ]; then
      HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null)
      if [ "$HEALTH" = "200" ]; then
        echo "Server running on port ${PORT}. Check capabilities: curl http://localhost:${PORT}/capabilities"

        # Inject recent Telegram messages for the lifeline topic — gives the agent
        # thread context without needing to remember what was said before.
        LIFELINE_TOPIC=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('$CONFIG_FILE'))
    # Check messaging array (standard location)
    for m in cfg.get('messaging', []):
        if m.get('type') == 'telegram':
            tid = m.get('config', {}).get('lifelineTopicId')
            if tid:
                print(tid)
                sys.exit(0)
    # Fallback: top-level telegram config
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
            echo "--- RECENT TELEGRAM MESSAGES (Lifeline topic, last ${MSG_COUNT}) ---"
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
        # Truncate long messages
        if len(text) > 200:
            text = text[:197] + '...'
        print(f'[{ts}] {sender}: {text}')
except Exception as e:
    pass
" 2>/dev/null
            echo "--- END RECENT MESSAGES ---"
            echo "Context: These are messages from your Lifeline Telegram topic. Use this to maintain conversation continuity."
          fi
        fi
      else
        echo "WARNING: Server on port ${PORT} is not responding. Run: instar server start"
      fi
    fi
  fi

  echo ""
  echo "=== IDENTITY LOADED — You are grounded. ==="

else
  # Subsequent tool use — check if this is still the same session
  STORED_PID=$(cat "$MARKER_FILE" 2>/dev/null)
  if [ "$STORED_PID" != "$PPID" ]; then
    # Different parent PID — this is a new session, re-inject
    echo "$PPID" > "$MARKER_FILE"
    echo "New session detected. Read .instar/AGENT.md and .instar/MEMORY.md for full context."
  fi
  # Otherwise: same session, no output needed (keep it quiet)
fi
