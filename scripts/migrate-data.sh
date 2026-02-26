#!/usr/bin/env bash
set -e

OLD_DIR="$HOME/.claude-mem"
NEW_DIR="$HOME/.claude/ai-mem-data"

if [ ! -d "$OLD_DIR" ]; then
  echo "No existing data at $OLD_DIR. Nothing to migrate."
  exit 0
fi

if [ -d "$NEW_DIR" ]; then
  echo "Target directory $NEW_DIR already exists. Aborting."
  exit 1
fi

echo "Migrating data from $OLD_DIR to $NEW_DIR..."
mkdir -p "$(dirname "$NEW_DIR")"
cp -R "$OLD_DIR" "$NEW_DIR"

# Rename database file
if [ -f "$NEW_DIR/claude-mem.db" ]; then
  mv "$NEW_DIR/claude-mem.db" "$NEW_DIR/ai-mem.db"
  # Handle WAL and SHM files
  [ -f "$NEW_DIR/claude-mem.db-wal" ] && mv "$NEW_DIR/claude-mem.db-wal" "$NEW_DIR/ai-mem.db-wal"
  [ -f "$NEW_DIR/claude-mem.db-shm" ] && mv "$NEW_DIR/claude-mem.db-shm" "$NEW_DIR/ai-mem.db-shm"
fi

echo "Migration complete. Old data preserved at $OLD_DIR."
echo "After verifying, you can remove it: rm -rf $OLD_DIR"
