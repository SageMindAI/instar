#!/usr/bin/env bash
# slack-reply.sh — Send a message to a Slack channel via the instar server.
#
# Usage:
#   slack-reply.sh CHANNEL_ID "message text"
#   echo "message" | slack-reply.sh CHANNEL_ID
#   cat <<'EOF' | slack-reply.sh CHANNEL_ID
#   Multi-line message here
#   EOF

set -euo pipefail

CHANNEL_ID="$1"
shift

# Read message from args or stdin
if [ $# -gt 0 ]; then
  MESSAGE="$*"
else
  MESSAGE="$(cat)"
fi

if [ -z "$MESSAGE" ]; then
  echo "Error: no message text provided" >&2
  exit 1
fi

# Guard against channel flooding — truncate extremely long messages
MAX_CHARS=4000
if [ ${#MESSAGE} -gt $MAX_CHARS ]; then
  ORIGINAL_LEN=${#MESSAGE}
  MESSAGE="${MESSAGE:0:$MAX_CHARS}

_(Message truncated from ${ORIGINAL_LEN} to ${MAX_CHARS} characters)_"
  echo "Warning: message truncated from ${ORIGINAL_LEN} to ${MAX_CHARS} chars" >&2
fi

# Get port from env or config
PORT="${INSTAR_PORT:-}"
AUTH=""

if [ -f ".instar/config.json" ]; then
  if [ -z "$PORT" ]; then
    CONFIG_PORT=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('port',''))" 2>/dev/null)
    [ -n "$CONFIG_PORT" ] && PORT="$CONFIG_PORT"
  fi
  AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
fi

PORT="${PORT:-4042}"

# JSON-escape the message
ESCAPED=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$MESSAGE" 2>/dev/null)
# Fallback to basic bash escaping if python unavailable
if [ -z "$ESCAPED" ]; then
  ESCAPED="\"$(echo "$MESSAGE" | sed 's/\\/\\\\/g; s/"/\\"/g')\""
fi

# Send via Instar server
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "http://localhost:${PORT}/slack/reply/${CHANNEL_ID}" \
  -H "Content-Type: application/json" \
  ${AUTH:+-H "Authorization: Bearer $AUTH"} \
  -d "{\"text\": ${ESCAPED}}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent ${#MESSAGE} chars to channel ${CHANNEL_ID}"
elif [ "$HTTP_CODE" = "408" ]; then
  # Request timeout on the server side — the outbound path (tone gate + Slack API)
  # exceeded the route's budget. The actual send may have completed anyway.
  # Report AMBIGUOUS and exit 0 so the agent verifies before retrying (a retry
  # would double-send since the first attempt likely went through).
  echo "AMBIGUOUS (HTTP 408): server timed out; the message MAY have been delivered." >&2
  echo "  Do NOT retry blindly — check the channel to verify delivery before resending." >&2
  echo "  If the message is there, proceed; if not, retry with a shorter/simpler version." >&2
  echo "AMBIGUOUS (HTTP 408): outcome unknown — verify in conversation before retrying"
  exit 0
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
  echo "Failed (HTTP ${HTTP_CODE}): ${BODY}" >&2
  exit 1
fi
