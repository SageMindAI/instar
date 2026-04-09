#!/bin/bash
# Skill Usage Telemetry — PostToolUse hook for Skill tool.
#
# Logs every skill invocation to .instar/skill-telemetry.jsonl
# for future pattern detection (which skills are used, when, how often).
#
# Cross-pollinated from Dawn's Portal project (2026-04-09).
# Lightweight: appends one JSONL line, no network calls.
#
# Hook type: PostToolUse on Skill tool

# Read hook input from stdin
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
if [ "$TOOL_NAME" != "Skill" ]; then
  exit 0
fi

INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"
TELEMETRY_FILE="$INSTAR_DIR/skill-telemetry.jsonl"

# Extract skill details
SKILL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('skill','unknown'))" 2>/dev/null)
SKILL_ARGS=$(echo "$INPUT" | python3 -c "import json,sys; a=json.load(sys.stdin).get('tool_input',{}).get('args',''); print(a[:200])" 2>/dev/null)
OUTPUT_LEN=$(echo "$INPUT" | python3 -c "import json,sys; print(len(str(json.load(sys.stdin).get('tool_output',''))))" 2>/dev/null)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Session ID from environment or marker files
SESSION_ID="${INSTAR_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
  # Try reading from session marker
  MARKER=$(ls -t "$INSTAR_DIR"/.session-marker-* 2>/dev/null | head -1)
  if [ -n "$MARKER" ]; then
    SESSION_ID=$(python3 -c "import json; print(json.load(open('$MARKER')).get('session_id',''))" 2>/dev/null)
  fi
fi

# Ensure directory exists
mkdir -p "$INSTAR_DIR"

# Append JSONL entry
echo "{\"timestamp\":\"$TIMESTAMP\",\"skill\":\"$SKILL_NAME\",\"args\":\"$SKILL_ARGS\",\"session_id\":\"$SESSION_ID\",\"output_length\":$OUTPUT_LEN}" >> "$TELEMETRY_FILE"
