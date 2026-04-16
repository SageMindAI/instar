#!/bin/bash
# telegram-reply.sh — Send a message back to a Telegram topic via instar server.
#
# Usage:
#   ./telegram-reply.sh TOPIC_ID "message text"
#   echo "message text" | ./telegram-reply.sh TOPIC_ID
#   cat <<'EOF' | ./telegram-reply.sh TOPIC_ID
#   Multi-line message here
#   EOF
#
# Reads INSTAR_PORT from environment (default: 4040).

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

PORT="${INSTAR_PORT:-4040}"

# Read auth token from config (if present)
AUTH_TOKEN=""
if [ -f ".instar/config.json" ]; then
  AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
fi

# Escape for JSON
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
if [ -z "$JSON_MSG" ]; then
  # Fallback if python3 not available: basic escape
  JSON_MSG="\"$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')\""
fi

if [ -n "$AUTH_TOKEN" ]; then
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:${PORT}/telegram/reply/${TOPIC_ID}" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -d "{\"text\":${JSON_MSG}}")
else
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:${PORT}/telegram/reply/${TOPIC_ID}" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":${JSON_MSG}}")
fi

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to topic $TOPIC_ID"
elif [ "$HTTP_CODE" = "408" ]; then
  # Request timeout on the server side — the outbound path (tone gate + Telegram API)
  # exceeded the route's budget. The actual send may have completed anyway, because
  # the handler's async work continues after the middleware fires 408. Treating this
  # as a hard failure (exit 1) causes the agent to regenerate and retry, which
  # double-sends the message. Instead report the outcome as AMBIGUOUS and exit 0 —
  # the agent should check the conversation before retrying.
  echo "AMBIGUOUS (HTTP 408): server timed out; the message MAY have been delivered." >&2
  echo "  Do NOT retry blindly — check the conversation to verify delivery before resending." >&2
  echo "  If the message is there, proceed; if not, retry with a shorter/simpler version." >&2
  echo "AMBIGUOUS (HTTP 408): outcome unknown — verify in conversation before retrying"
  exit 0
elif [ "$HTTP_CODE" = "422" ]; then
  # Tone gate blocked the message — surface the issue + suggestion to the agent
  ISSUE=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("issue","unknown"))' 2>/dev/null || echo "unknown")
  SUGGESTION=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("suggestion",""))' 2>/dev/null || echo "")
  echo "BLOCKED by tone gate — message not sent to user." >&2
  echo "  Issue: $ISSUE" >&2
  if [ -n "$SUGGESTION" ]; then
    echo "  Suggestion: $SUGGESTION" >&2
  fi
  echo "  Revise the message (remove CLI commands, file paths, config syntax, API endpoints) and retry." >&2
  exit 1
else
  echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
