#!/usr/bin/env bash
# scripts/deploy-to-phone.sh
#
# Push grandpa-bob onto an Android phone over ADB, with sherpa-onnx
# providing local speech-to-text.
#
# Architecture: Android's app sandbox blocks adb from writing inside
# Termux's private data dir, so this script stages everything on
# /sdcard/ (which both adb and Termux can reach) and you run one
# command in Termux to finish the install.
#
# Run from the repo root:
#   ./scripts/deploy-to-phone.sh
#
# Idempotent — re-runs skip already-done steps.

set -euo pipefail

# ---------- config ----------
SHERPA_VERSION="${SHERPA_VERSION:-v1.12.13}"
STT_PORT="${STT_PORT:-8178}"
ADMIN_PORT="${ADMIN_PORT:-8080}"
PHONE_TERMUX_HOME="/data/data/com.termux/files/home"
PHONE_PROJECT_DIR="grandma-bob"
MODEL_DIR_NAME="sherpa-onnx-streaming-zipformer-en-2023-06-26"
STAGE_DIR="/sdcard/Download/grandpa-bob-deploy"
GRANDMA_KAT_URL="${GRANDMA_KAT_URL:-https://github.com/hfxaiguy/grandma-kat.git}"

# ---------- helpers ----------
note() { printf '\033[1;36m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

adb_s() { adb shell "$@"; }
adb_x() { adb shell "$@" 2>&1 | tr -d '\r'; }

# ---------- usage ----------
usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --help              show this help
  --skip-termux       assume Termux is already installed

Env:
  REPO_URL=<url>      override the git URL
  SHERPA_VERSION=vX   sherpa-onnx release tag
  STT_PORT=N          port for the sherpa-onnx HTTP server
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --skip-termux) SKIP_TERMUX=1; shift ;;
    *) die "unknown arg: $1 (try --help)" ;;
  esac
done

# ---------- preflight ----------
command -v adb >/dev/null 2>&1 || die "adb not in PATH"
adb get-state >/dev/null 2>&1 || die "no ADB device. connect phone, enable USB debugging, then: adb devices"
command -v python3 >/dev/null 2>&1 || die "python3 not in PATH"
command -v curl >/dev/null 2>&1   || die "curl not in PATH"
command -v tar >/dev/null 2>&1    || die "tar not in PATH"

DEVICE_MODEL=$(adb_x getprop ro.product.model)
DEVICE_ARCH=$(adb_x  getprop ro.product.cpu.abi)
ANDROID_API=$(adb_x  getprop ro.build.version.sdk)
DEVICE_SERIAL="${ADB_SERIAL:-$(adb get-serialno 2>/dev/null | tr -d '\r')}"
[[ -n "$DEVICE_MODEL" ]] || die "could not read device model — is ADB authorized?"
[[ -n "$DEVICE_SERIAL" ]] || die "could not read device serial — is ADB authorized?"
note "device: $DEVICE_MODEL ($DEVICE_ARCH, Android API $ANDROID_API, serial $DEVICE_SERIAL)"

case "$DEVICE_ARCH" in
  arm64-v8a)   SHERPA_ASSET_GLOB="linux-aarch64-shared-cpu" ;;
  x86_64)      SHERPA_ASSET_GLOB="linux-x64-shared" ;;
  armeabi-v7a) die "32-bit ARM is not supported by sherpa-onnx prebuilts" ;;
  *)           die "unsupported arch: $DEVICE_ARCH" ;;
esac

# derive clone URL
if [[ -z "${REPO_URL:-}" ]]; then
  REMOTE_URL=$(git remote get-url origin 2>/dev/null || true)
  [[ -z "$REMOTE_URL" ]] && die "no REPO_URL set and no 'origin' remote. push the repo first, or set REPO_URL=https://..."
  case "$REMOTE_URL" in
    git@github.com:*) REPO_URL="https://github.com/${REMOTE_URL#git@github.com:}" ;;
    *)               REPO_URL="$REMOTE_URL" ;;
  esac
fi
note "repo:   $REPO_URL"

# ---------- install Termux + Termux:API ----------
fetch_f_droid_apk() {
  local pkg="$1" out="$2"
  local version_code
  version_code=$(curl -sf "https://f-droid.org/api/v1/packages/$pkg" | \
    python3 -c "import sys, json; print(json.load(sys.stdin)['packages'][-1]['versionCode'])") \
    || die "F-Droid API lookup failed for $pkg"
  local url="https://f-droid.org/repo/${pkg}_${version_code}.apk"
  curl -sfL -o "$out" "$url" || die "download failed: $url"
  note "downloaded $pkg v$version_code ($(du -h "$out" | cut -f1))"
}

if [[ "${SKIP_TERMUX:-0}" == "1" ]]; then
  note "skipping Termux install (--skip-termux)"
elif adb_s pm list packages com.termux 2>/dev/null | grep -q .; then
  note "Termux already installed"
else
  note "installing Termux + Termux:API from F-Droid"
  tmpdir=$(mktemp -d)
  fetch_f_droid_apk com.termux    "$tmpdir/termux.apk"
  fetch_f_droid_apk com.termux.api "$tmpdir/termux-api.apk"
  adb install -r -t "$tmpdir/termux.apk"     >/dev/null || die "Termux install failed"
  adb install -r -t "$tmpdir/termux-api.apk" >/dev/null || die "Termux:API install failed"
  rm -rf "$tmpdir"
  note "Termux installed"
fi

# ensure Termux is open and bootstrapped
note "opening Termux"
adb_s am start -n com.termux/.app.TermuxActivity >/dev/null 2>&1 || true

# ---------- ensure the phone has internet ----------
# Without internet, the in-Termux install.sh can't reach package mirrors,
# git remotes, or the npm registry. Try to bring the phone online by:
#   1) checking if gnirehtet is already running (tun0 with an IP)
#   2) switching the USB function to rndis,adb (some Samsungs reject this)
#   3) starting gnirehtet (a no-root ADB-based reverse-tether that
#      forwards phone traffic through the laptop's internet)
phone_has_internet() {
  # Consider the phone online if EITHER:
  #   (a) there's a default route via a normal interface (Wi-Fi, cellular), OR
  #   (b) there's an active tun* interface with an IP (gnirehtet / VPN)
  adb_s sh -c '
    ip route 2>/dev/null | grep -q "^default " && exit 0
    ip -4 addr 2>/dev/null | awk "/tun[0-9]+:/ {found=1} /inet / && /tun[0-9]+/ {has_ip=1} END{exit !(found && has_ip)}"
  '
}

if phone_has_internet; then
  note "phone already has internet"
else
  # Check if gnirehtet is already running on the laptop (tun0 on phone has IP)
  if adb_s ip -4 addr show tun0 2>/dev/null | grep -q 'inet '; then
    note "gnirehtet tunnel already up on phone (tun0 has IP) — treating as online"
  else
    note "phone has no internet — trying USB tethering"
    adb_s svc usb setFunctions rndis,adb >/dev/null 2>&1 || true
    sleep 4
    if ! phone_has_internet; then
      note "USB function switch didn't take effect — starting gnirehtet reverse-tether"

      # ---- gnirehtet (no-root reverse-tether over ADB) ----
      GNIREHTET_VERSION="v2.5.1"
      GNIREHTET_DIR="/tmp/gnirehtet-rust-linux64"
      GNIREHTET_BIN="$GNIREHTET_DIR/gnirehtet"
      GNIREHTET_APK="$GNIREHTET_DIR/gnirehtet.apk"
      if [[ ! -x "$GNIREHTET_BIN" || ! -f "$GNIREHTET_APK" ]]; then
        note "downloading gnirehtet $GNIREHTET_VERSION"
        mkdir -p "$GNIREHTET_DIR"
        curl -sSfL -o /tmp/gnirehtet.zip \
          "https://github.com/Genymobile/gnirehtet/releases/download/$GNIREHTET_VERSION/gnirehtet-rust-linux64-$GNIREHTET_VERSION.zip"
        unzip -o /tmp/gnirehtet.zip -d /tmp >/dev/null
        chmod +x "$GNIREHTET_BIN"
      fi
      note "installing gnirehtet client APK on the phone"
      adb install -r "$GNIREHTET_APK" >/dev/null

      # kill any prior relay, then start a fresh one in the background
      pkill -f 'gnirehtet run' 2>/dev/null || true
      sleep 1
      note "starting gnirehtet relay (port 31416) in background"
      setsid nohup "$GNIREHTET_BIN" run "$DEVICE_SERIAL" \
        < /dev/null > /tmp/gnirehtet.log 2>&1 &
      disown
      sleep 3

      if ! phone_has_internet; then
        echo
        echo "  ┌──────────────────────────────────────────────────────────────────┐"
        echo "  │  gnirehtet is running but the phone still has no tunnel.        │"
        echo "  │  ACTION: on the phone, accept the 'Allow gnirehtet to set       │"
        echo "  │  up a VPN connection?' prompt (check 'I trust this app' if      │"
        echo "  │  shown, then tap OK). The script will continue automatically.  │"
        echo "  └──────────────────────────────────────────────────────────────────┘"
        echo
        for i in $(seq 60 -5 5); do
          if phone_has_internet; then
            printf "\r  phone online via gnirehtet, continuing...      \n"
            break
          fi
          printf "\r  waiting for VPN permission on the phone... %2ds " "$i"
          sleep 5
        done
        if ! phone_has_internet; then
          die "phone still offline after 60s. accept the gnirehtet VPN prompt and re-run."
        fi
      fi
    fi
  fi
fi

# ---------- stage everything on /sdcard/ ----------
note "staging files at $STAGE_DIR"
adb_s mkdir -p "$STAGE_DIR" >/dev/null

# -- .env template --
cat > /tmp/grandma-bot-env <<'EOF'
# --- Telegram ---
TELEGRAM_BOT_TOKEN=replace-me
ALLOWED_USER_IDS=replace-me

# --- LLM (remote; runs on your laptop, not the phone) ---
LLM_BASE_URL=https://router.huggingface.co/v1
LLM_API_KEY=hf_replace-me
LLM_MODEL=google/gemma-4-26B-A4B-it:novita

# --- STT (sherpa-onnx HTTP server) ---
STT_BACKEND=sherpa
SHERPA_URL=http://127.0.0.1:8178
STT_LANGUAGE=en

# --- Workspace (sandboxed dir for the bot's file tools) ---
WORKSPACE_DIR=/data/data/com.termux/files/home/grandma-workspace
EOF
adb push /tmp/grandma-bot-env "$STAGE_DIR/.env.template" >/dev/null
rm /tmp/grandma-bot-env

# -- sherpa-onnx prebuilt --
SHERPA_TARBALL_NAME="sherpa-onnx-$SHERPA_ASSET_GLOB.tar.bz2"
SHERPA_TARBALL="$STAGE_DIR/$SHERPA_TARBALL_NAME"
if ! adb_s test -f "$SHERPA_TARBALL" 2>/dev/null; then
  note "looking up sherpa-onnx $SHERPA_VERSION asset from GitHub"
  RELEASE_JSON=$(curl -sf "https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/$SHERPA_VERSION") \
    || die "GitHub release lookup failed for $SHERPA_VERSION"
  ASSET_URL=$(echo "$RELEASE_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data['assets']:
    n = a['name']
    if n.startswith('sherpa-onnx-$SHERPA_VERSION-$SHERPA_ASSET_GLOB') and n.endswith('.tar.bz2'):
        print(a['browser_download_url']); break
") || true
  [[ -z "${ASSET_URL:-}" ]] && die "no sherpa-onnx asset matching $SHERPA_ASSET_GLOB in $SHERPA_VERSION"

  note "downloading $(basename "$ASSET_URL") to phone"
  curl -sSfL -o /tmp/sherpa.tar.bz2 "$ASSET_URL"
  adb push /tmp/sherpa.tar.bz2 "$SHERPA_TARBALL" >/dev/null
  rm /tmp/sherpa.tar.bz2
else
  note "sherpa-onnx tarball already staged"
fi

# -- Zipformer model --
MODEL_TARBALL_NAME="$MODEL_DIR_NAME.tar.bz2"
MODEL_TARBALL="$STAGE_DIR/$MODEL_TARBALL_NAME"
if ! adb_s test -f "$MODEL_TARBALL" 2>/dev/null; then
  note "downloading streaming Zipformer model (~140 MB)"
  curl -sSfL -o /tmp/zipformer.tar.bz2 \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$MODEL_TARBALL_NAME"
  adb push /tmp/zipformer.tar.bz2 "$MODEL_TARBALL" >/dev/null
  rm /tmp/zipformer.tar.bz2
else
  note "Zipformer model already staged"
fi

# -- install.sh: runs entirely inside Termux --
# Written to be POSIX-sh compatible (Termux's /bin/sh is mksh, not bash).
cat > /tmp/grandma-bot-install.sh <<'REMOTE'
#!/data/data/com.termux/files/usr/bin/sh
# This script runs INSIDE Termux on the phone. It finishes the deploy
# started by deploy-to-phone.sh on the laptop.
set -eu

# Make pkg install non-interactive (debconf prompts otherwise hang us).
export DEBIAN_FRONTEND=noninteractive
export APT_LISTCHANGES_FRONTEND=none

# Write resolv.conf with a public DNS server. The phone's internet comes
# through gnirehtet (reverse tunnel over ADB), so ALL traffic — including
# DNS — goes through the laptop. 8.8.8.8 is resolved by the laptop's DNS.
# This must happen BEFORE pkg update, which overwrites resolv.conf.
echo "nameserver 8.8.8.8" > $PREFIX/etc/resolv.conf
echo "=== DNS fix: wrote nameserver 8.8.8.8 to \$PREFIX/etc/resolv.conf ==="
cat $PREFIX/etc/resolv.conf

STAGE="__STAGE_DIR__"
HOME="$HOME"
LOG="$STAGE/install.log"

# Log everything to a file we can read from the laptop.
exec > "$LOG" 2>&1
echo "=== install.sh started at $(date) ==="

note()  { echo "[+] $*"; }
warn()  { echo "[!] $*"; }
die()   { echo "[x] $*" >&2; exit 1; }

# Grant /sdcard/ access on first run. termux-setup-storage is a no-op once
# the user has tapped "Allow" on the system dialog.
if [ ! -d "$HOME/storage" ]; then
  note "requesting storage permission — check the phone for a system dialog"
  termux-setup-storage
fi

# Bootstrap packages
note "pkg update"
pkg update -y
note "pkg upgrade (may be skipped if up to date)"
pkg upgrade -y || true
note "installing runtime packages"
# glibc-repo adds a repo containing glibc-linked packages; glibc itself
# then provides the loader needed to run the sherpa-onnx prebuilt.
# glibc-repo MUST be installed and pkg update re-run before glibc appears.
pkg install -y git nodejs-lts ffmpeg tmux openssl-tool glibc-repo
pkg update -y
pkg install -y glibc

# Move staged files into HOME
note "setting up $HOME"
mkdir -p "$HOME/sherpa-onnx" "$HOME/models" "$HOME/__PHONE_PROJECT_DIR__"
if [ ! -x "$HOME/sherpa-onnx/bin/sherpa-onnx-offline" ]; then
  note "extracting sherpa-onnx"
  tar -xjf "$STAGE/__SHERPA_TARBALL_NAME__" -C "$HOME/sherpa-onnx" --strip-components=1
fi
if [ ! -f "$HOME/models/__MODEL_DIR_NAME__/tokens.txt" ]; then
  note "extracting Zipformer model"
  tar -xjf "$STAGE/__MODEL_TARBALL_NAME__" -C "$HOME/models"
fi
if [ ! -d "$HOME/__PHONE_PROJECT_DIR__/.git" ]; then
  note "cloning repo"
  git clone "__REPO_URL__" "$HOME/__PHONE_PROJECT_DIR__"
else
  note "repo already cloned — pulling latest"
  git -C "$HOME/__PHONE_PROJECT_DIR__" pull --ff-only
fi

# Write .env if missing
if [ ! -f "$HOME/__PHONE_PROJECT_DIR__/.env" ]; then
  note "writing .env"
  cp "$STAGE/.env.template" "$HOME/__PHONE_PROJECT_DIR__/.env"
  chmod 600 "$HOME/__PHONE_PROJECT_DIR__/.env"
else
  note ".env already exists — leaving it alone"
fi

# npm install
note "npm install"
( cd "$HOME/__PHONE_PROJECT_DIR__" && npm install --no-audit --no-fund )

# Install grandma-kat tree-runtime library (from ../grandma-knits).
# This is a local library, not published to npm, so we install from path.
if [ -d "$HOME/__PHONE_PROJECT_DIR__/node_modules/grandma-kat" ]; then
  note "grandma-kat already installed"
else
  note "installing grandma-kat tree-runtime library"
  # Try local path first (if ../grandma-knits is staged), else git clone
  if [ -d "$STAGE/grandma-knits" ]; then
    cp -r "$STAGE/grandma-knits" "$HOME/__PHONE_PROJECT_DIR__/node_modules/grandma-kat"
  else
    git clone "__GRANDMA_KAT_URL__" "$HOME/__PHONE_PROJECT_DIR__/node_modules/grandma-kat" 2>/dev/null || true
  fi
fi

# Set up pattern registry: JSON pattern files in workspace/patterns/
# Contributors can write their own tree patterns in JSON and share them.
WORKSPACE_DIR="$HOME/grandma-workspace"
mkdir -p "$WORKSPACE_DIR/patterns"
if [ ! -f "$WORKSPACE_DIR/patterns/agent.json" ]; then
  note "creating default agent pattern"
  cat > "$WORKSPACE_DIR/patterns/agent.json" <<'PATTERN_EOF'
{
  "name": "agent",
  "description": "Standard agent loop: LLM → tools → LLM → answer",
  "root": {
    "type": "llm",
    "model": "cheap",
    "messages": "{{messages}}",
    "onToolCall": {
      "type": "toolCall",
      "then": {
        "type": "llm",
        "model": "cheap",
        "messages": "{{messages}} + {{toolResults}}"
      }
    }
  }
}
PATTERN_EOF
fi
if [ ! -f "$WORKSPACE_DIR/patterns/research.json" ]; then
  note "creating research pattern"
  cat > "$WORKSPACE_DIR/patterns/research.json" <<'PATTERN_EOF'
{
  "name": "research",
  "description": "Multi-step research: search → read → summarize → answer",
  "root": {
    "type": "llm",
    "model": "cheap",
    "messages": "{{messages}}",
    "onToolCall": {
      "type": "toolCall",
      "then": {
        "type": "llm",
        "model": "strong",
        "messages": "{{messages}} + {{toolResults}}"
      }
    }
  }
}
PATTERN_EOF
fi
note "pattern registry set up at $WORKSPACE_DIR/patterns/"

# Smoke-test the sherpa prebuilt. The binary's ELF interpreter is
# /lib/ld-linux-aarch64.so.1; Termux ships the loader at
# ~/usr/glibc/lib/. The loader doesn't process glibc's libc.so linker
# script on this Android build, so we have to LD_PRELOAD libc.so.6
# explicitly to bypass the broken script.
SHERPA_DIR="$HOME/sherpa-onnx"
GLIBC_DIR="$HOME/../usr/glibc"
GLIBC_LOADER="$GLIBC_DIR/lib/ld-linux-aarch64.so.1"
# sherpa-onnx-offline-websocket-server is the binary with the HTTP
# /recognize endpoint; sherpa-onnx-offline is CLI-only (no --port).
SHERPA_BIN="$SHERPA_DIR/bin/sherpa-onnx-offline-websocket-server"
# Note: we use `env` here because shell variables don't re-parse
# env-var assignments like LD_PRELOAD=foo cmd.
SHERPA_RUN="env LD_PRELOAD=$GLIBC_DIR/lib/libc.so.6 $GLIBC_LOADER --library-path $GLIBC_DIR/lib:$SHERPA_DIR/lib $SHERPA_BIN"
# NB: do NOT quote $SHERPA_RUN here — the shell must split it into
# a command + args, otherwise it tries to run a file named
# "env LD_PRELOAD=... sherpa-onnx-offline" (with spaces in its name).
if $SHERPA_RUN --help >/dev/null 2>&1; then
  note "sherpa-onnx prebuilt runs OK"
else
  warn "sherpa-onnx prebuilt failed to run. check: $SHERPA_RUN --help"
fi

# Start sherpa-onnx in tmux
SHERPA_SESSION="sherpa"
BOT_SESSION="bot"
MODEL_DIR="$HOME/models/__MODEL_DIR_NAME__"

note "starting sherpa-onnx in tmux session '$SHERPA_SESSION'"
tmux kill-session -t "$SHERPA_SESSION" 2>/dev/null || true
# Model files are the int8 streaming Zipformer (chunk-16-left-128).
# The streaming model works fine with the offline-websocket-server for
# non-streaming use (transcribe a whole audio file at once).
tmux new-session -d -s "$SHERPA_SESSION" "sh -c 'exec env LD_PRELOAD=\"$GLIBC_DIR/lib/libc.so.6\" \"$GLIBC_LOADER\" --library-path \"$GLIBC_DIR/lib:$SHERPA_DIR/lib\" \"$SHERPA_BIN\" --port=__STT_PORT__ --num-threads=4 --tokens=\"$MODEL_DIR/tokens.txt\" --encoder=\"$MODEL_DIR/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx\" --decoder=\"$MODEL_DIR/decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx\" --joiner=\"$MODEL_DIR/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx\" 2>&1 | tee \"$HOME/sherpa.log\"'"

sleep 2
if curl -sSf -m 3 "http://127.0.0.1:__STT_PORT__/" >/dev/null 2>&1; then
  note "sherpa-onnx is reachable on http://127.0.0.1:__STT_PORT__"
else
  warn "sherpa-onnx not responding yet — check: tmux attach -t $SHERPA_SESSION"
fi

# Start bot in tmux
note "starting bot in tmux session '$BOT_SESSION'"
tmux kill-session -t "$BOT_SESSION" 2>/dev/null || true
tmux new-session -d -s "$BOT_SESSION" "sh -c 'cd \"$HOME/__PHONE_PROJECT_DIR__\" && exec npm run dev 2>&1 | tee \"$HOME/bot.log\"'"

# Copy the admin server to $HOME and start it in tmux.
# This is a small zero-dep web UI for credentials + status + logs + patterns.
ADMIN_SESSION="admin"
ADMIN_PORT=__ADMIN_PORT__
note "starting admin UI in tmux session '$ADMIN_SESSION' on port $ADMIN_PORT"
cp "$STAGE/admin-server.mjs" "$HOME/admin-server.mjs" 2>/dev/null || true
tmux kill-session -t "$ADMIN_SESSION" 2>/dev/null || true
tmux new-session -d -s "$ADMIN_SESSION" "sh -c 'exec node \"$HOME/admin-server.mjs\" 2>&1 | tee \"$HOME/admin.log\"'"
sleep 1
if curl -sSf -m 3 "http://127.0.0.1:$ADMIN_PORT/" >/dev/null 2>&1; then
  note "admin UI is reachable on http://127.0.0.1:$ADMIN_PORT"
else
  warn "admin UI not responding yet — check: tmux attach -t $ADMIN_SESSION"
fi

# Signal completion to the laptop
note "all done"
touch "$STAGE/.done"
echo "open Telegram and message the bot to test"
REMOTE
# Substitute placeholders. Use | as the sed delimiter since URLs contain /.
sed -i \
  -e "s|__STAGE_DIR__|$STAGE_DIR|g" \
  -e "s|__SHERPA_TARBALL_NAME__|$SHERPA_TARBALL_NAME|g" \
  -e "s|__MODEL_TARBALL_NAME__|$MODEL_TARBALL_NAME|g" \
  -e "s|__MODEL_DIR_NAME__|$MODEL_DIR_NAME|g" \
  -e "s|__PHONE_PROJECT_DIR__|$PHONE_PROJECT_DIR|g" \
  -e "s|__REPO_URL__|$REPO_URL|g" \
  -e "s|__STT_PORT__|$STT_PORT|g" \
  -e "s|__ADMIN_PORT__|$ADMIN_PORT|g" \
  -e "s|__GRANDMA_KAT_URL__|$GRANDMA_KAT_URL|g" \
  /tmp/grandma-bot-install.sh
adb push /tmp/grandma-bot-install.sh "$STAGE_DIR/install.sh" >/dev/null
rm /tmp/grandma-bot-install.sh

# -- admin server: a small web UI on the phone for credentials + status --
# substitute the port into the admin server before pushing
sed "s|\"8181\"|\"$ADMIN_PORT\"|" \
  "$(dirname "$0")/admin-server.mjs" > /tmp/admin-server.mjs
adb push /tmp/admin-server.mjs "$STAGE_DIR/admin-server.mjs" >/dev/null
rm /tmp/admin-server.mjs

# ---------- final instructions ----------
cat <<EOF

$(printf '\033[1;32m')✓ staging done$(printf '\033[0m')

phone:  $DEVICE_MODEL
stage:  $STAGE_DIR
stt:    sherpa-onnx  http://127.0.0.1:$STT_PORT
llm:    remote (HF router)
admin:  http://127.0.0.1:$ADMIN_PORT  (started after install)
patterns: $HOME/grandma-workspace/patterns/  (JSON tree patterns)

NEXT — run this ONE command in Termux on the phone (it does everything
in one shot: grants /sdcard/ access, installs packages, clones the repo,
extracts sherpa-onnx + model, installs grandma-kat tree-runtime, sets up
the pattern registry, runs npm install, starts tmux sessions):

  sh $STAGE_DIR/install.sh

Then come back here — the script will detect completion automatically.

AFTER THE INSTALL — open the admin UI on the phone's browser:
  http://127.0.0.1:$ADMIN_PORT
Fill in the Telegram bot token, your user ID, and the HF API key. Click
"Save credentials" then "Restart bot". Send a voice note to your bot on
Telegram to test.

PATTERNS — the bot uses tree-runtime patterns for the agent loop.
Contributors can write their own JSON patterns in
  $HOME/grandma-workspace/patterns/
and switch between them in the admin UI.

WATCH LOGS (after the install finishes):
  adb shell tmux attach -t sherpa   # Ctrl-B then D to detach
  adb shell tmux attach -t bot
  adb shell tmux attach -t admin

If sherpa-onnx fails to start (glibc vs Bionic), in Termux run:
  pkg install glibc
  sh $STAGE_DIR/install.sh   # re-runs everything idempotently

UNINSTALL:
  adb uninstall com.termux com.termux.api
  adb shell rm -rf $STAGE_DIR
EOF
