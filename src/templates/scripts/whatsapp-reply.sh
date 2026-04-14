#!/bin/bash
# whatsapp-reply.sh — Send a message back to a WhatsApp JID via instar server.
#
# Usage:
#   ./whatsapp-reply.sh JID "message text"
#   echo "message text" | ./whatsapp-reply.sh JID
#   cat <<'EOF' | ./whatsapp-reply.sh JID
#   Multi-line message here
#   EOF
#
# JID format: phone@s.whatsapp.net (e.g., 12345678901@s.whatsapp.net)
# Reads INSTAR_PORT from environment (default: 4040).

JID="$1"
shift

if [ -z "$JID" ]; then
  echo "Usage: whatsapp-reply.sh JID [message]" >&2
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
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:${PORT}/whatsapp/send/${JID}" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -d "{\"text\":${JSON_MSG}}")
else
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:${PORT}/whatsapp/send/${JID}" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":${JSON_MSG}}")
fi

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to $JID"
elif [ "$HTTP_CODE" = "422" ]; then
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
