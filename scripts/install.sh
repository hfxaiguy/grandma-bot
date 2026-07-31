#!/data/data/com.termux/files/usr/bin/sh
# scripts/install.sh — runs inside Termux on the phone.
# Does everything: install, update, sync. Idempotent.
#
# First run (install):
#   sh /sdcard/Download/grandma-bob-deploy/install.sh
#
# Later runs (update):
#   sh /sdcard/Download/grandpa-bob-deploy/install.sh
set -eu

# ---------- paths ----------
# Full paths — $PREFIX may be unset when invoked via adb.
PFX="/data/data/com.termux/files/usr"
STAGE="__STAGE_DIR__"
HOME_DIR="$HOME"
PROJECT="__PHONE_PROJECT_DIR__"
WORKSPACE="$HOME_DIR/grandma-workspace"
LOG="$STAGE/install.log"

# ---------- logging ----------
# Write everything to a file the laptop can read.
exec > "$LOG" 2>&1
echo "=== install.sh started at $(date) ==="
note() { echo "[+] $*"; }
warn() { echo "[!] $*"; }

# ---------- DNS fix ----------
# On some Wi-Fi networks Termux's standalone binaries can't resolve
# hostnames. Write a resolv.conf with a public DNS server so apt/git
# work through gnirehtet or direct Wi-Fi.
echo "nameserver 8.8.8.8" > $PFX/etc/resolv.conf 2>/dev/null || true

# ---------- storage permission ----------
if [ ! -d "$HOME_DIR/storage" ]; then
  note "requesting storage permission — check the phone for a system dialog"
  termux-setup-storage
fi

# ---------- packages ----------
# Skip if the core packages are already installed (saves minutes on
# restricted networks where pkg update fails).
if command -v git >/dev/null && command -v node >/dev/null && command -v ffmpeg >/dev/null && command -v tmux >/dev/null; then
  note "core packages already installed, skipping bootstrap"
else
  note "pkg update"
  pkg update -y || warn "pkg update failed (DNS?), continuing"
  note "pkg upgrade"
  pkg upgrade -y || true
  note "installing runtime packages"
  pkg install -y git nodejs-lts ffmpeg tmux openssl-tool
  # glibc-runner from pacman provides the glibc dynamic linker needed
  # by sherpa-onnx's glibc-linked prebuilt.
  note "installing glibc dynamic linker"
  if pacman -S --noconfirm glibc-runner 2>/dev/null; then
    note "glibc-runner installed"
  else
    note "pacman failed, trying glibc-repo + glibc via pkg"
    pkg install -y glibc-repo || warn "glibc-repo failed"
    pkg update -y || true
    pkg install -y glibc || warn "glibc failed"
  fi
fi

# ---------- project ----------
mkdir -p "$HOME_DIR/$PROJECT"
if [ ! -d "$HOME_DIR/$PROJECT/.git" ]; then
  note "cloning repo"
  git clone "__REPO_URL__" "$HOME_DIR/$PROJECT"
else
  note "pulling latest"
  git -C "$HOME_DIR/$PROJECT" pull --ff-only || warn "git pull failed, using existing code"
fi

# ---------- .env + models.json ----------
if [ ! -f "$HOME_DIR/$PROJECT/.env" ]; then
  note "writing .env"
  cp "$STAGE/.env.template" "$HOME_DIR/$PROJECT/.env"
  chmod 600 "$HOME_DIR/$PROJECT/.env"
else
  note ".env already exists"
fi
if [ -f "$STAGE/models.json" ]; then
  if [ ! -f "$HOME_DIR/$PROJECT/models.json" ]; then
    note "writing models.json"
    cp "$STAGE/models.json" "$HOME_DIR/$PROJECT/models.json"
  else
    note "models.json already exists"
  fi
fi

# ---------- npm ----------
note "npm install"
cd "$HOME_DIR/$PROJECT"
npm install --no-audit --no-fund || warn "npm install failed"

# ---------- grandma-kat tree-runtime ----------
# npm install wipes node_modules; grandma-kat is not in package.json
# so it gets removed. Re-clone it every time.
note "re-cloning grandma-kat tree-runtime"
rm -rf node_modules/grandma-kat
git clone "https://github.com/hfxaiguy/grandma-kat.git" node_modules/grandma-kat 2>/dev/null \
  || warn "grandma-kat clone failed"

# ---------- sherpa-onnx ----------
SHERPA_DIR="$HOME_DIR/sherpa-onnx"
GLIBC_DIR="$HOME_DIR/../usr/glibc"
GLIBC_LOADER="$GLIBC_DIR/lib/ld-linux-aarch64.so.1"
SHERPA_BIN="$SHERPA_DIR/bin/sherpa-onnx-offline-websocket-server"
SHERPA_TMP="$HOME_DIR/tmp"
mkdir -p "$SHERPA_TMP"

if [ ! -x "$SHERPA_BIN" ]; then
  note "extracting sherpa-onnx"
  tar -xjf "$STAGE/__SHERPA_TARBALL_NAME__" -C "$SHERPA_DIR" --strip-components=1
fi

if [ ! -f "$HOME_DIR/models/__MODEL_DIR_NAME__/tokens.txt" ]; then
  note "extracting Zipformer model"
  mkdir -p "$HOME_DIR/models"
  tar -xjf "$STAGE/__MODEL_TARBALL_NAME__" -C "$HOME_DIR/models"
fi

# ---------- pattern registry ----------
mkdir -p "$WORKSPACE/patterns"
if [ ! -f "$WORKSPACE/patterns/agent.mjs" ]; then
  note "creating default agent pattern"
  cat > "$WORKSPACE/patterns/agent.mjs" <<'PATTERN'
// agent.mjs — Standard agent loop: LLM → tools → LLM → answer
export default async function agent(state) {
  const response = await state.llm.chat("cheap", state.messages);
  if (response.toolCalls && response.toolCalls.length > 0) {
    const results = await state.tools.execute(response.toolCalls);
    const followup = await state.llm.chat("cheap", [...state.messages, ...results]);
    return followup.content;
  }
  return response.content;
}
PATTERN
fi
if [ ! -f "$WORKSPACE/patterns/research.mjs" ]; then
  note "creating research pattern"
  cat > "$WORKSPACE/patterns/research.mjs" <<'PATTERN'
// research.mjs — cheap model routes, strong model answers
export default async function research(state) {
  const routing = await state.llm.chat("cheap", state.messages);
  if (routing.toolCalls && routing.toolCalls.length > 0) {
    const results = await state.tools.execute(routing.toolCalls);
    const synthesis = await state.llm.chat("strong", [...state.messages, ...results]);
    return synthesis.content;
  }
  return routing.content;
}
PATTERN
fi

# ---------- sherpa smoke test ----------
SHERPA_RUN="env TMPDIR=$SHERPA_TMP LD_PRELOAD=$GLIBC_DIR/lib/libc.so.6 $GLIBC_LOADER --library-path $GLIBC_DIR/lib:$SHERPA_DIR/lib $SHERPA_BIN"
if $SHERPA_RUN --help >/dev/null 2>&1; then
  note "sherpa-onnx runs OK"
else
  warn "sherpa-onnx failed — try: pkg install glibc"
fi

# ---------- start services ----------
MODEL_DIR="$HOME_DIR/models/__MODEL_DIR_NAME__"
SHERPA_SESSION="sherpa"
BOT_SESSION="bot"

note "starting sherpa-onnx"
tmux kill-session -t "$SHERPA_SESSION" 2>/dev/null || true
tmux new-session -d -s "$SHERPA_SESSION" \
  "sh -c 'exec env TMPDIR=$SHERPA_TMP LD_PRELOAD=$GLIBC_DIR/lib/libc.so.6 $GLIBC_LOADER --library-path $GLIBC_DIR/lib:$SHERPA_DIR/lib $SHERPA_BIN --port=__STT_PORT__ --num-threads=4 --tokens=$MODEL_DIR/tokens.txt --encoder=$MODEL_DIR/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx --decoder=$MODEL_DIR/decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx --joiner=$MODEL_DIR/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx 2>&1 | tee $HOME_DIR/sherpa.log'"
sleep 2
if curl -sSf -m 3 http://127.0.0.1:__STT_PORT__/ >/dev/null 2>&1; then
  note "sherpa-onnx listening on port __STT_PORT__"
else
  warn "sherpa-onnx not responding yet"
fi

note "starting bot (admin UI on port __ADMIN_PORT__)"
tmux kill-session -t "$BOT_SESSION" 2>/dev/null || true
tmux new-session -d -s "$BOT_SESSION" \
  "sh -c 'cd $HOME_DIR/$PROJECT && export ADMIN_PORT=__ADMIN_PORT__ && exec npm run dev 2>&1 | tee $HOME_DIR/bot.log'"
sleep 5
tail -10 "$HOME_DIR/bot.log" 2>/dev/null || true

# ---------- done ----------
note "all done"
touch "$STAGE/.done"
