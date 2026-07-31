#!/data/data/com.termux/files/usr/bin/sh
# scripts/sync-workspace.sh
#
# Start sshd on the phone and print the rsync command for the laptop
# to pull the workspace (including SQLite databases).
#
# The SQLite database is backed up with .backup first (consistent
# snapshot, safe to run while the bot is writing).
#
# Run on the phone once (after each reboot or reboot of sshd):
#   sh /sdcard/Download/grandpa-bob-deploy/sync-workspace.sh
#
# Then on the laptop, run the printed rsync command.
set -eu

STAGE="/sdcard/Download/grandma-bob-deploy"
PORT=8022

echo "=== installing rsync, openssh, sqlite ==="
pkg install -y rsync openssh sqlite 2>&1 | tail -5

echo "=== starting sshd ==="
pkill sshd 2>/dev/null || true
sleep 1
sshd
sleep 1
echo "sshd started (pid $(pgrep sshd))"

MYIP=$(ip -4 addr show wlan0 2>/dev/null | awk '/inet / {split($2, a, "/"); print a[1]}')
[ -z "$MYIP" ] && MYIP="192.168.2.17"

echo
echo "=== sshd is listening on port $PORT ==="
echo
echo "On your laptop, run:"
echo
echo "  rsync -avz --progress -e \"ssh -p $PORT\" u0_a209@${MYIP}:~/grandma-workspace/ \\"
echo "    /home/love/Documents/Code/grandma-workspace/"
echo
echo "=== first time only — accept the host key when prompted ==="
