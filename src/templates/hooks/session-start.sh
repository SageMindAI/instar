#!/bin/bash
# Session Start — INJECTS working memory context at the beginning of every session.
# Bootstraps the agent with relevant knowledge from all memory layers before
# any work begins. This is the "right context at the right moment" — not a dump
# of everything, but a query-driven surface of what's most relevant now.
#
# DESIGN: Runs as a Claude Code UserPromptSubmit hook on first message.
# Outputs context directly (not pointers) — the agent reads it automatically.
#
# Phase 4 of PROP-memory-architecture: Working Memory Assembly.
#
# Installed by instar during setup. Runs as a Claude Code session-start hook.

INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"
CONFIG_FILE="$INSTAR_DIR/config.json"

# Extract prompt from environment or first argument for query building
PROMPT="${CLAUDE_USER_PROMPT:-$1}"

if [ ! -f "$CONFIG_FILE" ]; then
  exit 0
fi

PORT=$(grep -o '"port":[0-9]*' "$CONFIG_FILE" | head -1 | cut -d':' -f2)
if [ -z "$PORT" ]; then
  exit 0
fi

AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('authToken',''))" 2>/dev/null)

# Check if server is alive
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  "http://localhost:${PORT}/health" 2>/dev/null)
if [ "$HEALTH" != "200" ]; then
  exit 0
fi

# Reset scope coherence state — prevents accumulated counts from prior sessions
# leaking into this session and causing false-positive hook triggers.
curl -s -X POST "http://localhost:${PORT}/scope-coherence/reset" -o /dev/null 2>/dev/null || true

# Record session start for reflection metrics (usage-based reflection trigger)
curl -s -X POST "http://localhost:${PORT}/reflection/session-start" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" -o /dev/null 2>/dev/null || true

# Reset homeostasis state for new session (work-velocity awareness)
curl -s -X POST "http://localhost:${PORT}/homeostasis/reset" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" -o /dev/null 2>/dev/null || true

# Check reflection metrics — usage-based reflection suggestion
REFLECTION_CHECK=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" \
  "http://localhost:${PORT}/reflection/metrics" 2>/dev/null)
if [ -n "$REFLECTION_CHECK" ]; then
  SUGGESTED=$(echo "$REFLECTION_CHECK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('suggested',False))" 2>/dev/null)
  if [ "$SUGGESTED" = "True" ]; then
    EXCEEDED=$(echo "$REFLECTION_CHECK" | python3 -c "
import sys, json
d = json.load(sys.stdin)
m = d.get('metrics', {})
exceeded = d.get('exceededThresholds', [])
parts = []
if 'toolCalls' in exceeded: parts.append(f'{m.get(\"toolCalls\",0)} tool calls')
if 'sessions' in exceeded: parts.append(f'{m.get(\"sessions\",0)} sessions')
if 'minutes' in exceeded: parts.append(f'{m.get(\"minutesSinceReflection\",0)} min')
print(', '.join(parts))
" 2>/dev/null)
    echo "=== REFLECTION SUGGESTED ==="
    echo "Usage thresholds exceeded: ${EXCEEDED}"
    echo "Consider reflecting before diving into work."
    echo "After reflecting, record it: POST http://localhost:${PORT}/reflection/record"
    echo '  Body: {"type": "quick"} or {"type": "deep"}'
    echo "=== END REFLECTION SUGGESTED ==="
    echo ""
  fi
fi

# Check for pending serendipity findings
SERENDIPITY_DIR="$INSTAR_DIR/state/serendipity"
if [ -d "$SERENDIPITY_DIR" ]; then
  PENDING_COUNT=$(find "$SERENDIPITY_DIR" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$PENDING_COUNT" -gt 0 ]; then
    echo "=== SERENDIPITY: ${PENDING_COUNT} pending finding(s) ==="
    echo "Sub-agents captured discoveries during prior tasks."
    echo "Review with: ls $SERENDIPITY_DIR/*.json"
    for f in "$SERENDIPITY_DIR"/*.json; do
      [ -f "$f" ] || continue
      TITLE=$(python3 -c "import json; print(json.load(open('$f')).get('discovery',{}).get('title','(untitled)'))" 2>/dev/null || echo "(parse error)")
      CAT=$(python3 -c "import json; print(json.load(open('$f')).get('discovery',{}).get('category','?'))" 2>/dev/null || echo "?")
      echo "  - [$CAT] $TITLE"
    done
    echo "=== END SERENDIPITY ==="
    echo ""
  fi
fi

# Check if telemetry opt-in nudge is needed
# Only show once — writes a marker file after first display
TELEMETRY_NUDGE_FILE="$INSTAR_DIR/state/.telemetry-nudge-shown"
TELEMETRY_ENABLED=$(python3 -c "
import json, sys
try:
    c = json.load(open('$CONFIG_FILE'))
    print('true' if c.get('monitoring',{}).get('telemetry',{}).get('enabled') else 'false')
except: print('false')
" 2>/dev/null)

if [ "$TELEMETRY_ENABLED" = "false" ] && [ ! -f "$TELEMETRY_NUDGE_FILE" ]; then
  echo "=== ACTION REQUESTED: Telemetry Opt-In ==="
  echo "Anonymous usage telemetry is not yet enabled for this agent."
  echo "Telemetry helps improve Instar by sending anonymous, aggregate data:"
  echo "  - Instar version, OS, architecture"
  echo "  - Agent count and uptime"
  echo "  - Job/session/skill counts (usage level only)"
  echo "  - NO conversation content, agent names, file paths, or secrets"
  echo ""
  echo "Ask the user if they'd like to enable anonymous telemetry."
  echo "If they agree, call: POST http://localhost:${PORT}/config/telemetry"
  echo '  Body: {"enabled": true, "level": "basic"}'
  echo "  (or level: \"usage\" for aggregate usage counts)"
  echo "If they decline, call the same endpoint with: {\"enabled\": false}"
  echo "Either response dismisses this nudge permanently."
  echo "=== END ACTION REQUESTED ==="
  echo ""
fi

# Build working memory query from prompt
PROMPT_ENCODED=$(python3 -c "
import sys, urllib.parse
prompt = '''${PROMPT}'''[:500]
print(urllib.parse.quote(prompt))
" 2>/dev/null)

# Get active job slug and topicId for job-specific context
JOB_SLUG=""
JOB_TOPIC_ID=""
if [ -f "$INSTAR_DIR/state/active-job.json" ]; then
  JOB_SLUG=$(grep -o '"slug":"[^"]*"' "$INSTAR_DIR/state/active-job.json" 2>/dev/null | head -1 | cut -d'"' -f4)
  JOB_TOPIC_ID=$(python3 -c "
import json, sys
try:
    d = json.load(open('$INSTAR_DIR/state/active-job.json'))
    tid = d.get('topicId')
    print(tid if tid is not None else '')
except:
    print('')
" 2>/dev/null)
fi

# Build query URL
QUERY_URL="http://localhost:${PORT}/context/working-memory?limit=10"
if [ -n "$PROMPT_ENCODED" ]; then
  QUERY_URL="${QUERY_URL}&prompt=${PROMPT_ENCODED}"
fi
if [ -n "$JOB_SLUG" ]; then
  JOB_SLUG_ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${JOB_SLUG}'))" 2>/dev/null)
  QUERY_URL="${QUERY_URL}&jobSlug=${JOB_SLUG_ENCODED}"
fi

WORKING_MEM=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "$QUERY_URL" 2>/dev/null)

if [ -z "$WORKING_MEM" ]; then
  exit 0
fi

python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ctx = data.get('context', '').strip()
    tokens = data.get('estimatedTokens', 0)
    sources = data.get('sources', [])

    if not ctx or tokens == 0:
        sys.exit(0)

    source_summary = ', '.join(
        f'{s[\"count\"]} {s[\"name\"]}' for s in sources if s.get('count', 0) > 0
    )
    print('=== SESSION CONTEXT — WORKING MEMORY ===')
    print(f'[{tokens} tokens from: {source_summary}]')
    print()
    print(ctx)
    print()
    print('=== END SESSION CONTEXT ===')
except Exception:
    sys.exit(0)
" <<< "$WORKING_MEM" 2>/dev/null

# Soul.md fallback injection — until the Being layer is in the self-knowledge tree,
# inject Personality Seed + Core Values at session start for identity grounding.
if [ -f "$INSTAR_DIR/soul.md" ]; then
  SOUL_LINES=$(wc -l < "$INSTAR_DIR/soul.md" | tr -d ' ')
  if [ "$SOUL_LINES" -gt "15" ]; then
    python3 -c "
import sys
content = open('$INSTAR_DIR/soul.md').read()
sections = []
for header in ['## Personality Seed', '## Core Values', '## Current Growth Edge']:
    idx = content.find(header)
    if idx == -1: continue
    after = content[idx:]
    import re
    m = re.search(r'\n---\n|\n## ', after[len(header):])
    section = after[:len(header) + m.start()] if m else after
    text = section.strip()
    # Skip sections that are just comments/empty
    lines = [l for l in text.split('\n') if l.strip() and not l.strip().startswith('<!--')]
    if len(lines) > 2:  # header + description + at least one content line
        sections.append(text)
if sections:
    print('=== SOUL — IDENTITY GROUNDING ===')
    print('\n\n'.join(sections))
    print('=== END SOUL ===')
    print()
" 2>/dev/null
  fi
fi

# Surface job topic ID so agents don't need to hardcode it
if [ -n "$JOB_TOPIC_ID" ]; then
  echo ""
  echo "JOB TELEGRAM TOPIC: This job's Telegram topic ID is ${JOB_TOPIC_ID}."
  echo "To send to this topic: cat <<'EOF' | .instar/scripts/telegram-reply.sh ${JOB_TOPIC_ID}"
  echo "Your message"
  echo "EOF"
  echo ""
fi

# Inject known blocker resolutions from active job's commonBlockers
if [ -f "$INSTAR_DIR/state/active-job.json" ]; then
  python3 -c "
import json, sys
from datetime import datetime, timezone
try:
    data = json.load(open('$INSTAR_DIR/state/active-job.json'))
    blockers = data.get('commonBlockers') or {}
    if not blockers:
        sys.exit(0)
    now = datetime.now(timezone.utc)
    active = []
    for key, b in blockers.items():
        if b.get('status') == 'pending':
            continue
        exp = b.get('expiresAt')
        if exp:
            try:
                exp_dt = datetime.fromisoformat(exp.replace('Z', '+00:00'))
                if exp_dt < now:
                    continue
            except:
                pass
        active.append(b)
    if not active:
        sys.exit(0)
    print('=== KNOWN BLOCKER RESOLUTIONS ===')
    print('These are pre-confirmed solutions. Use them BEFORE escalating to the human.')
    print()
    for b in active:
        print(f'  BLOCKER: {b[\"description\"]}')
        print(f'  RESOLUTION: {b[\"resolution\"]}')
        tools = b.get('toolsNeeded')
        if tools:
            print(f'  TOOLS: {\", \".join(tools)}')
        creds = b.get('credentials')
        if creds:
            if isinstance(creds, list):
                print(f'  CREDENTIALS: {\", \".join(creds)}')
            else:
                print(f'  CREDENTIALS: {creds}')
        count = b.get('successCount', 0)
        if count:
            print(f'  CONFIRMED: {count} time(s)')
        print()
    print('=== END KNOWN BLOCKER RESOLUTIONS ===')
    print()
except Exception:
    sys.exit(0)
" 2>/dev/null
fi

# Shared-State Ledger — integrated-being awareness across sessions.
# Injects recent entries written by any session on this agent so the current
# session sees what other parts of the agent have been doing (commitments
# made, agreements reached, threads opened). Derived facts only — raw
# cross-thread message contents stay sandboxed at the threadline layer.
# See src/core/SharedStateLedger.ts.
SHARED_STATE=$(curl -s --max-time 3 -H "Authorization: Bearer ${AUTH_TOKEN}" \
  "http://localhost:${PORT}/shared-state/render?limit=15" 2>/dev/null)
if [ -n "$SHARED_STATE" ] && ! echo "$SHARED_STATE" | grep -q "no recent entries"; then
  echo ""
  echo "=== INTEGRATED-BEING — RECENT CROSS-SESSION ACTIVITY ==="
  echo "$SHARED_STATE"
  echo "=== END INTEGRATED-BEING ==="
  echo ""
fi

# Feature Discovery — evaluate context for feature surfacing recommendation
# Only runs when: server is alive, evaluator is initialized, autonomy profile is not passive.
# Fail-open: errors/timeouts produce no output, session continues normally.
if [ -n "$PORT" ] && [ -n "$AUTH_TOKEN" ]; then
  # Derive topic category from prompt (first 100 chars, sanitized)
  TOPIC_LABEL=$(echo "${PROMPT:-unknown}" | head -c 100 | tr -cd '[:alnum:] [:space:]' | tr '[:upper:]' '[:lower:]')

  # Classify intent from prompt keywords
  INTENT="unknown"
  case "$PROMPT" in
    *debug*|*error*|*fix*|*bug*|*broken*) INTENT="debugging" ;;
    *config*|*enable*|*disable*|*setup*|*setting*) INTENT="configuring" ;;
    *what*|*how*|*why*|*explain*) INTENT="asking" ;;
    *build*|*create*|*implement*|*add*) INTENT="building" ;;
    *monitor*|*check*|*status*|*health*) INTENT="monitoring" ;;
  esac

  EVAL_RESULT=$(curl -s --max-time 6 -X POST \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    "http://localhost:${PORT}/features/evaluate-context" \
    -d "{\"topicCategory\":\"${TOPIC_LABEL}\",\"conversationIntent\":\"${INTENT}\",\"problemCategories\":[],\"autonomyProfile\":\"collaborative\",\"enabledFeatures\":[]}" \
    2>/dev/null)

  if [ -n "$EVAL_RESULT" ]; then
    DISCOVERY_MSG=$(echo "$EVAL_RESULT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    rec = data.get('recommendation')
    if not rec:
        sys.exit(0)
    fid = rec.get('featureId', '')
    surface_as = rec.get('surfaceAs', 'awareness')
    msg = rec.get('messageForAgent', '')
    if not msg:
        sys.exit(0)
    print('--- FEATURE DISCOVERY SUGGESTION ---')
    print(f'Feature: {fid} (surface as: {surface_as})')
    print(f'Suggested mention: {msg}')
    print()
    print('IMPORTANT: Use this naturally in conversation. Do NOT lead with it.')
    print(f'Record the surfacing: POST /features/{fid}/surface')
    print('--- END DISCOVERY SUGGESTION ---')
except Exception:
    pass
" 2>/dev/null)
    if [ -n "$DISCOVERY_MSG" ]; then
      echo ""
      echo "$DISCOVERY_MSG"
      echo ""
    fi
  fi
fi

exit 0
