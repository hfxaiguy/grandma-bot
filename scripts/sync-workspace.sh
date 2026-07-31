#!/data/data/com.termux/files/usr/bin/sh
# scripts/sync-workspace.sh
#
# Install rsync and start sshd on the phone, then give the laptop
# the rsync command to run. The phone acts as an SSH server; the laptop
# pulls the workspace via rsync.
#
# Run on the phone once to set up:
#   sh /sdcard/Download/grandpa-bob-deploy/sync-workspace.sh
#
# Then on the laptop, run the printed rsync command to pull the workspace.
set -eu

WORKSPACE="$HOME/grandma-workspace"
STAGE="/sdcard/Download/grandpa-bob-deploy"
PORT=8022

echo "=== installing rsync and openssh ==="
pkg install -y rsync openssh 2>&1 | tail -5

echo "=== starting sshd ==="
# sshd runs on port 8022 by default in Termux
if pgrep sshd >/dev/null 2>&1; then
  echo "sshd already running (pid $(pgrep sshd))"
else
  sshd
  sleep 1
  echo "sshd started (pid $(pgrep sshd))"
fi

MYIP=$(ip -4 addr show wlan0 2>/dev/null | awk '/inet / {split($2, a, "/"); print a[1]}')
[ -z "$MYIP" ] && MYIP="192.168.2.17"

echo
echo "=== done. On your laptop, run: ==="
echo
echo "  cd ~/Documents/Code/grandma-bob"
echo "  rsync -avz --progress -e \"ssh -p $PORT\" u0_a209@${MYIP}:~/grandma-workspace/ \\"
echo "    /home/love/Documents/Code/grandma-workspace/"
echo
echo "=== first time only — accept the host key when prompted ==="
