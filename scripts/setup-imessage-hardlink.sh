#!/bin/bash
# setup-imessage-hardlink.sh
#
# Creates hardlinks from ~/Library/Messages/chat.db files to an agent's
# .instar/imessage/ directory. Lets the iMessage adapter read messages
# without requiring Full Disk Access on the node binary.
#
# Must be run from a user session that HAS Full Disk Access (e.g., Terminal).
# After the hardlinks exist, no FDA is needed by the reading process.
#
# Usage:
#   ./scripts/setup-imessage-hardlink.sh [agent-dir]
#
# If agent-dir is omitted, uses the current directory (must be an agent root).

set -e

AGENT_DIR="${1:-$(pwd)}"

if [ ! -d "$AGENT_DIR/.instar" ]; then
  echo "Error: $AGENT_DIR is not an Instar agent directory (no .instar/ found)" >&2
  echo "Usage: $0 [agent-dir]" >&2
  exit 1
fi

MESSAGES_DIR="$HOME/Library/Messages"
TARGET_DIR="$AGENT_DIR/.instar/imessage"

if [ ! -f "$MESSAGES_DIR/chat.db" ]; then
  echo "Error: $MESSAGES_DIR/chat.db not found — is Messages.app signed in?" >&2
  exit 1
fi

# Test FDA by trying to read chat.db
if ! sqlite3 "$MESSAGES_DIR/chat.db" "SELECT 1" &>/dev/null; then
  echo "Error: Cannot read $MESSAGES_DIR/chat.db" >&2
  echo "Grant Full Disk Access to your terminal: System Settings → Privacy & Security → Full Disk Access" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

echo "Creating hardlinks in $TARGET_DIR..."
for f in chat.db chat.db-wal chat.db-shm; do
  if [ -f "$MESSAGES_DIR/$f" ]; then
    # Remove existing link/file if present
    [ -e "$TARGET_DIR/$f" ] && rm "$TARGET_DIR/$f"
    ln "$MESSAGES_DIR/$f" "$TARGET_DIR/$f"
    echo "  ✓ $f"
  fi
done

# Verify same inode (hardlink worked)
ORIG_INODE=$(stat -f '%i' "$MESSAGES_DIR/chat.db")
LINK_INODE=$(stat -f '%i' "$TARGET_DIR/chat.db")
if [ "$ORIG_INODE" != "$LINK_INODE" ]; then
  echo "Error: hardlink verification failed (different inodes)" >&2
  exit 1
fi

echo ""
echo "Done. Configure the iMessage adapter in your config.json:"
echo ""
echo '  "messaging": [{'
echo '    "type": "imessage",'
echo '    "enabled": true,'
echo '    "config": {'
echo "      \"dbPath\": \"$TARGET_DIR/chat.db\","
echo '      "authorizedContacts": ["+1..."]'
echo '    }'
echo '  }]'
echo ""
echo "After this, the iMessage adapter can read chat.db without Full Disk Access."
