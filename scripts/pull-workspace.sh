#!/usr/bin/env bash
# scripts/pull-workspace.sh
#
# Pull the workspace from the phone via rsync (SSH).
# Uses sqlite3 .backup for a consistent database snapshot (no need to
# stop the bot — the backup is safe while writes are happening).
#
# Prerequisites:
#   1. Run `sh /sdcard/Download/grandpa-bob-deploy/sync-workspace.sh`
#      on the phone (starts sshd, installs rsync/sqlite).
#   2. Phone and laptop on the same network.
#   3. rsync + ssh on the laptop.

set -euo pipefail

PHONE_IP="${PHONE_IP:-192.168.2.17}"
SSHD_PORT="${SSHD_PORT:-8022}"
PHONE_USER="${PHONE_USER:-u0_a209}"
WORKSPACE="$HOME/Documents/Code/grandma-workspace"

note() { printf '\033[1;36m[+]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

command -v rsync >/dev/null 2>&1 || die "rsync not in PATH"

note "backing up SQLite on phone (consistent snapshot, bot keeps running)"
adb shell 'sqlite3 ~/grandma-workspace/logs/grandma-kat.db ".backup /sdcard/Download/grandpa-bob-deploy/grandma-kat.db"' 2>/dev/null || true

note "pulling workspace via rsync (SSH → $PHONE_USER@$PHONE_IP:$SSHD_PORT)"
mkdir -p "$WORKSPACE"
rsync -avz --progress \
  -e "ssh -p $SSHD_PORT -o StrictHostKeyChecking=accept-new" \
  "$PHONE_USER@$PHONE_IP:~/grandma-workspace/" \
  "$WORKSPACE/" \
  || die "rsync failed — is sshd running on the phone? Run: sh /sdcard/Download/grandpa-bob-deploy/sync-workspace.sh"

note "done — workspace synced to $WORKSPACE"
echo "  workspace:"
ls "$WORKSPACE" | head -5