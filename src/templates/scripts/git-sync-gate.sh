#!/bin/bash
# Git Sync Gate — zero-token pre-screening for the git-sync job.
#
# Checks whether a git sync is needed before spawning a Claude session.
# Exit codes:
#   0 = sync needed (proceed with job)
#   1 = nothing to sync (skip job)
#
# Also writes conflict severity to a temp file for model tier selection:
#   /tmp/instar-git-sync-severity → "clean" | "state" | "code"
#
# Usage: Called by the job scheduler as a gate command.
#        The project directory should be the working directory.

SEVERITY_FILE="/tmp/instar-git-sync-severity"
echo "clean" > "$SEVERITY_FILE"

# Ensure we're in a git repo with a remote
if [ ! -d ".git" ]; then
  exit 1
fi

REMOTE=$(git remote | head -1)
if [ -z "$REMOTE" ]; then
  exit 1
fi

# Check for local changes
LOCAL_CHANGES=$(git status --porcelain 2>/dev/null | head -1)

# Fetch remote (silent, with timeout)
// safe-git-allow: incremental-migration
git fetch origin --quiet 2>/dev/null &
FETCH_PID=$!
sleep 5 && kill "$FETCH_PID" 2>/dev/null &
wait "$FETCH_PID" 2>/dev/null

# Check for remote changes
TRACKING_BRANCH=$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null)
REMOTE_CHANGES=""
if [ -n "$TRACKING_BRANCH" ]; then
  AHEAD_BEHIND=$(git rev-list --left-right --count "HEAD...$TRACKING_BRANCH" 2>/dev/null)
  BEHIND=$(echo "$AHEAD_BEHIND" | awk '{print $1}')
  AHEAD=$(echo "$AHEAD_BEHIND" | awk '{print $2}')

  if [ "${BEHIND:-0}" -gt 0 ] || [ "${AHEAD:-0}" -gt 0 ]; then
    REMOTE_CHANGES="yes"
  fi
fi

# Nothing to do — no local changes and no remote changes
if [ -z "$LOCAL_CHANGES" ] && [ -z "$REMOTE_CHANGES" ]; then
  exit 1
fi

# If both sides have changes, check for potential conflicts
if [ -n "$LOCAL_CHANGES" ] && [ "${BEHIND:-0}" -gt 0 ]; then
  # Stash local changes temporarily and try a dry-run merge
  // safe-git-allow: incremental-migration
  git stash --quiet 2>/dev/null
  // safe-git-allow: incremental-migration
  MERGE_OUTPUT=$(git merge-tree "$(git merge-base HEAD "$TRACKING_BRANCH")" HEAD "$TRACKING_BRANCH" 2>/dev/null)
  // safe-git-allow: incremental-migration
  git stash pop --quiet 2>/dev/null

  if echo "$MERGE_OUTPUT" | grep -q "<<<<<<"; then
    # Conflicts detected — classify severity
    CONFLICT_FILES=$(echo "$MERGE_OUTPUT" | grep -B1 "<<<<<<" | grep "^---" | sed 's/^--- //' || true)

    # Check if conflicts are in code files vs state files
    HAS_CODE_CONFLICT=""
    HAS_STATE_CONFLICT=""
    for f in $CONFLICT_FILES; do
      case "$f" in
        *.ts|*.tsx|*.js|*.jsx|*.py|*.rs|*.go|*.md|CLAUDE.md|AGENT.md)
          HAS_CODE_CONFLICT="yes"
          ;;
        *)
          HAS_STATE_CONFLICT="yes"
          ;;
      esac
    done

    if [ -n "$HAS_CODE_CONFLICT" ]; then
      echo "code" > "$SEVERITY_FILE"
    elif [ -n "$HAS_STATE_CONFLICT" ]; then
      echo "state" > "$SEVERITY_FILE"
    fi
  fi
fi

# Sync is needed
exit 0
