#!/data/data/com.termux/files/usr/bin/sh
# scripts/update-phone.sh — pull latest from GitHub, npm install, restart bot.
# Run from Termux on the phone: sh /sdcard/Download/grandpa-bob-deploy/update.sh
# Or from the laptop: adb shell sh /sdcard/Download/grandpa-bob-deploy/update.sh
set -eu

PROJECT="$HOME/grandma-bob"
STAGE="/sdcard/Download/grandpa-bob-deploy"

echo "=== pulling latest from GitHub ==="
cd "$PROJECT"
git pull --ff-only || { echo "git pull failed"; exit 1; }

echo "=== npm install ==="
npm install --no-audit --no-fund

echo "=== re-cloning grandma-kat ==="
# npm install wipes node_modules, and grandma-kat is not in package.json
rm -rf node_modules/grandma-kat
git clone https://github.com/hfxaiguy/grandma-kat.git node_modules/grandma-kat 2>&1

echo "=== restarting bot ==="
tmux kill-session -t bot 2>/dev/null || true
tmux new-session -d -s bot "sh -c 'cd \"$PROJECT\" && npm run dev 2>&1 | tee \"$HOME/bot.log\"'"

sleep 5
echo "=== bot.log last 10 lines ==="
tail -10 "$HOME/bot.log"
echo
echo "=== tmux sessions ==="
tmux ls
