#!/usr/bin/env bash
# scripts/pull-workspace.sh
#
# Pull the workspace from the phone via rsync (SSH) and restart the bot.
# Run on the laptop:
#   ./scripts/pull-workspace.sh
#
# Prerequisites:
#   1. Run `sh /sdcard/Download/grandpa-bob-deploy/sync-workspace.sh` on
#      the phone first (starts sshd).
#   2. The phone must be on the same network as the laptop.
#   3. rsync and ssh must be installed on the laptop.

set -euo pipefail

PHONE_IP="${PHONE_IP:-192.168.2.17}"
SSHD_PORT="${SSHD_PORT:-8022}"
PHONE_USER="${PHONE_USER:-u0_a209}"
WORKSPACE="$HOME/Documents/Code/grandma-workspace"

note() { printf '\033[1;36m[+]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

command -v rsync >/dev/null 2>&1 || die "rsync not in PATH (pacman -S rsync or brew install rsync)"
command -v adb >/dev/null 2>&1   || die "adb not in PATH"

note "stopping bot on phone (for SQLite consistency)"
adb shell tmux kill-session -t bot 2>/dev/null || true
sleep 2

note "pulling workspace via rsync (SSH → $PHONE_USER@$PHONE_IP:$SSHD_PORT)"
mkdir -p "$WORKSPACE"
rsync -avz --progress \
  -e "ssh -p $SSHD_PORT -o StrictHostKeyChecking=accept-new" \
  "$PHONE_USER@$PHONE_IP:~/grandma-workspace/" \
  "$WORKSPACE/" \
  || die "rsync failed — is sshd running on the phone? Run: sh /sdcard/Download/grandpa-bob-deploy/sync-workspace.sh"

note "restarting bot on phone"
adb shell tmux new-session -d -s bot "sh -c 'cd ~/grandma-bob && npm run dev 2>&1 | tee ~/bot.log'"
sleep 3

note "done — workspace synced to $WORKSPACE"
