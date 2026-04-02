#!/bin/bash
# imessage-reply.sh — Send a reply via iMessage with validate-before-send safety.
#
# Usage:
#   ./imessage-reply.sh RECIPIENT "message text"
#   echo "message text" | ./imessage-reply.sh RECIPIENT
#   cat <<'EOF' | ./imessage-reply.sh RECIPIENT
#   Multi-line message here
#   EOF
#
# RECIPIENT is a phone number (+14081234567) or email (user@icloud.com).
#
# This script implements Layer 1 of the 5-layer outbound safety defense:
#   1. Validates recipient with server BEFORE sending (gets single-use token)
#   2. Sends the iMessage via `imsg send` CLI (requires Automation permission)
#   3. Confirms delivery to server with token (for logging + stall tracking)
#
# If validation fails, the message is NOT sent. This is the reverse of the
# original flow which sent first and notified second.

RECIPIENT="$1"
shift

if [ -z "$RECIPIENT" ]; then
  echo "Usage: imessage-reply.sh RECIPIENT [message]" >&2
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

# ── Setup ─────────────────────────────────────────────────────────────

PORT="${INSTAR_PORT:-4042}"

AUTH_TOKEN=""
if [ -f ".instar/config.json" ]; then
  AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
fi

# Escape message for JSON
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
if [ -z "$JSON_MSG" ]; then
  JSON_MSG="\"$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')\""
fi

# URL-encode the recipient
ENCODED_RECIPIENT=$(printf '%s' "$RECIPIENT" | python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=""))' 2>/dev/null)
if [ -z "$ENCODED_RECIPIENT" ]; then
  ENCODED_RECIPIENT="$RECIPIENT"
fi

AUTH_HEADER=""
if [ -n "$AUTH_TOKEN" ]; then
  AUTH_HEADER="Authorization: Bearer ${AUTH_TOKEN}"
fi

# ── Step 1: Validate with server BEFORE sending (get single-use token) ──

VALIDATE_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "http://localhost:${PORT}/imessage/validate-send/${ENCODED_RECIPIENT}" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H 'Content-Type: application/json' \
  -d "{\"text\":${JSON_MSG}}" 2>/dev/null)

VALIDATE_BODY=$(echo "$VALIDATE_RESPONSE" | head -n -1)
VALIDATE_CODE=$(echo "$VALIDATE_RESPONSE" | tail -n 1)

if [ "$VALIDATE_CODE" != "200" ]; then
  # Validation failed — DO NOT SEND
  REASON=$(echo "$VALIDATE_BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("reason","unknown"))' 2>/dev/null || echo "unknown")
  echo "BLOCKED: $REASON" >&2

  # Log blocked attempt locally as backup
  echo "{\"blocked\":true,\"recipient\":\"${RECIPIENT}\",\"reason\":\"${REASON}\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >> .instar/imessage-outbound-local.jsonl 2>/dev/null

  exit 1
fi

# Extract send token
SEND_TOKEN=$(echo "$VALIDATE_BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)

if [ -z "$SEND_TOKEN" ]; then
  echo "BLOCKED: no send token received from server" >&2
  exit 1
fi

# ── Step 2: Send via imsg CLI (only after validation passes) ──────────

IMSG="${IMSG_PATH:-imsg}"
if ! command -v "$IMSG" &>/dev/null; then
  for candidate in /opt/homebrew/bin/imsg /usr/local/bin/imsg "$HOME/homebrew/bin/imsg"; do
    if [ -x "$candidate" ]; then
      IMSG="$candidate"
      break
    fi
  done
fi

if ! command -v "$IMSG" &>/dev/null && [ ! -x "$IMSG" ]; then
  echo "imsg not found. Install: brew install steipete/tap/imsg" >&2
  exit 1
fi

"$IMSG" send --to "$RECIPIENT" --text "$MSG" --service imessage 2>/dev/null
SEND_STATUS=$?

if [ $SEND_STATUS -ne 0 ]; then
  echo "imsg send failed (exit $SEND_STATUS)" >&2
  exit 1
fi

# ── Step 3: Confirm delivery to server (with token to bind validate→send) ──

curl -s -o /dev/null -w "" -X POST "http://localhost:${PORT}/imessage/reply/${ENCODED_RECIPIENT}" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H 'Content-Type: application/json' \
  -d "{\"text\":${JSON_MSG},\"sendToken\":\"${SEND_TOKEN}\"}" 2>/dev/null || \
  echo "Warning: server confirmation failed (message was sent)" >&2

echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to $RECIPIENT"
