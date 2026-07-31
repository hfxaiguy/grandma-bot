#!/data/data/com.termux/files/usr/bin/sh
# scripts/sync-workspace.sh — tar the workspace to /sdcard/ so the laptop can pull it.
# Run in Termux on the phone: sh /sdcard/Download/grandpa-bob-deploy/sync-workspace.sh
set -eu

WORKSPACE="$HOME/grandma-workspace"
STAGE="/sdcard/Download/grandpa-bob-deploy"
TARBALL="$STAGE/workspace.tar.gz"

echo "=== syncing workspace to $STAGE ==="

# Create a clean tarball, excluding node_modules and .git internals
tar -czf "$TARBALL" \
  -C "$HOME" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='*.db-wal' \
  --exclude='*.db-shm' \
  grandma-workspace

SIZE=$(du -h "$TARBALL" | cut -f1)
echo "=== workspace.tar.gz ($SIZE) ready at $TARBALL ==="
echo "=== on your laptop run: ==="
echo "  adb pull $TARBALL ."
echo "  tar -xzf workspace.tar.gz"
