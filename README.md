# grandma-bot

A local agent harness you chat with from Telegram — text, voice, or photos. It can
read, write and organize files on this machine inside a sandboxed workspace, and
every change it makes is **git-committed automatically**.

- **Telegram**: long polling via grammY. Works in DMs and in **forum-topic groups** —
  each topic is an independent conversation with its own history.
- **Voice → text**: voice notes are transcribed locally by
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp) built with the **Vulkan**
  backend, running on the AMD RX 570. No audio leaves the machine.
- **Brain**: any OpenAI-compatible endpoint (default: Hugging Face router running
  Gemma 4), switchable via `.env`.
- **Tools**: sandboxed file tools + an allowlist of shell commands.

## Architecture

```
 Telegram app (you: text / voice note / photo)
      │
      ▼  getUpdates, long polling (grammY)
┌─────────────────────────────────────────────────────────────┐
│ bot.ts                                                      │
│  · auth gate (ALLOWED_USER_IDS, others silently dropped)    │
│  · forum-topic routing (key = chatId:message_thread_id)     │
│  · per-topic serial queue · typing indicator · msg chunking │
└───┬──────────────────┬──────────────────────┬───────────────┘
    │ text             │ voice                │ photo
    │                  ▼                      ▼
    │          ┌───────────────┐      download largest size
    │          │ stt.ts        │      → base64 data URL
    │          │ .ogg → ffmpeg │      (image-first content order)
    │          │ → 16kHz WAV   │
    │          └──────┬────────┘
    │                 ▼ multipart POST /inference
    │          whisper-server (:8178)
    │          whisper.cpp, Vulkan backend, AMD RX 570
    │                 │ transcript
    ▼                 ▼
┌─────────────────────────────────────────────────────────────┐
│ agent.ts — tool-calling loop (max 12 iterations)            │
│  · system prompt rebuilt fresh each turn                    │
│  · history.ts: per-topic memory, 60 msgs, in-memory only    │
│  · strips Gemma 4 <|channel>thought… tags from replies      │
└───┬─────────────────────────────────────────────────────────┘
    │ OpenAI-compatible POST /v1/chat/completions (+ tool schemas)
    ▼
 LLM endpoint (default: HF router, google/gemma-4-26B-A4B-it:novita)
    │ tool_calls (JSON)
    ▼
┌─────────────────────────────────────────────────────────────┐
│ tools/index.ts — dispatch (errors returned as strings,      │
│ so the model can self-correct)                              │
│   ├─ files.ts: list/read/write/edit/delete ──┐              │
│   └─ shell.ts: run_command                   │              │
│        (allowlist, no shell, git deny-list)  ▼              │
│                                   ~/grandma-workspace       │
│                                   (sandboxed git repo)      │
│                                              │              │
│                                   git.ts: auto-commit       │
│                                   every mutation            │
└─────────────────────────────────────────────────────────────┘
```

### Journey of a voice message ("add milk to shopping.md")

1. grammY receives the voice note; the auth middleware checks your user ID.
2. The job is chained onto this topic's promise queue (previous reply finishes first).
3. `stt.ts` fetches the file path via Bot API `getFile`, downloads the `.ogg`,
   converts it with ffmpeg to 16 kHz mono PCM WAV, and POSTs it to whisper-server.
4. The bot replies `heard: "add milk to shopping.md"` in the same topic.
5. The transcript is appended to the topic's history; `agent.ts` calls the LLM
   with the tool schemas.
6. Gemma decides to call `read_file` → result appended → `edit_file` → result
   appended → final text answer. Each tool error would go back to the model as a
   normal string so it can retry.
7. `edit_file` writes the file, then `git.ts` commits just that path and returns
   the short hash, which flows back into the tool result.
8. The final answer is chunked to ≤4000 chars and sent to the topic.

### Layout

```
src/
  index.ts        entry point: workspace + git init, wiring, bot startup
  config.ts       .env loading/validation
  bot.ts          grammY bot: auth gate, forum topics, text/voice/photo, queues
  agent.ts        LLM tool-calling loop (OpenAI-compatible)
  history.ts      per-topic in-memory conversation history
  stt.ts          Telegram voice download → ffmpeg → whisper-server
  tools/
    index.ts      tool schemas (OpenAI format) + dispatcher
    files.ts      list/read/write/edit/delete, sandboxed, auto-committing
    shell.ts      run_command with allowlist + git deny-list
    git.ts        repo init + auto-commit helpers
  util/paths.ts   workspace path sandbox
scripts/
  smoke.ts        offline tests: tools, sandbox, auto-commit
  llm-test.ts     live end-to-end agent test against the configured LLM
vendor/whisper.cpp/   whisper.cpp Vulkan build (gitignored)
```

The **workspace** (agent sandbox + git repo) lives OUTSIDE the project by default
(`~/grandma-workspace`, see `WORKSPACE_DIR`) so its git history is fully
independent of the harness.

## Setup

1. **Telegram bot**: create one with @BotFather, copy the token. Get your numeric
   user id from @userinfobot.
2. `cp .env.example .env` and fill in `TELEGRAM_BOT_TOKEN` and `ALLOWED_USER_IDS`.
3. `npm install`
4. whisper.cpp is already built under `vendor/` (Vulkan) with the `base` model.
   To rebuild or change the model:
   ```sh
   git clone --depth 1 https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp
   cmake -S vendor/whisper.cpp -B vendor/whisper.cpp/build -DGGML_VULKAN=1 -DBUILD_SHARED_LIBS=OFF
   cmake --build vendor/whisper.cpp/build -j --target whisper-server
   vendor/whisper.cpp/models/download-ggml-model.sh base   # or small / base.en / ...
   ```
   If you change the model, update the path in the `whisper:up` script in `package.json`.
5. **LLM backend** — Hugging Face router by default (already set in `.env.example`):
   create a token at https://huggingface.co/settings/tokens with
   *Inference Providers* permission and paste it as `LLM_API_KEY`.
   Default model is `google/gemma-4-26B-A4B-it:novita` — multimodal (photos work)
   with tool calling. **Caution:** tool support is per-provider; e.g. Gemma 4 on
   DeepInfra has it disabled. Check `supports_tools` at
   https://router.huggingface.co/v1/models before changing `LLM_MODEL`.
   `openai/gpt-oss-120b:deepinfra` is a cheap text-only alternative.
   Alternatives (see commented blocks in `.env.example`):
   - local: build [llama.cpp](https://github.com/ggml-org/llama.cpp) with
     `-DGGML_VULKAN=ON` and run `llama-server -m model.gguf --jinja -c 8192`
     (`--jinja` needed so the chat template renders tools), or
   - any other OpenAI-compatible API via `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`.

   Note: small local models vary a lot in tool-calling quality — if the agent
   misuses tools, switch models before debugging anything else.

## Run

```sh
npm run whisper:up   # terminal 1: whisper-server on 127.0.0.1:8178
npm run dev          # terminal 2: the bot
```

Useful checks: `npm run typecheck`, `npm run smoke` (offline tool/git tests),
`npx tsx scripts/llm-test.ts` (live agent test against the real LLM).

## Telegram usage

- DM the bot, or add it to a **group with Topics enabled**
  (Group settings → Topics). The bot replies inside the same topic; every topic
  keeps a separate conversation history.
- Send text, send a **photo** (caption optional) for image analysis, or hold the
  mic and send a **voice message** — you'll get `heard: "…"` plus the agent's reply.
- Commands: `/clear` (reset this topic's history), `/status` (workspace, git, LLM, whisper).

## Git integration (summary)

`WORKSPACE_DIR` is a git repository (auto-initialized on first start), kept outside
the project directory so its history is completely separate from the harness's own.
Every `write_file` / `edit_file` / `delete_file` is immediately committed.
See the FAQ below for exactly how that works.

## FAQ

### Git & workspace

**How exactly does auto-commit work?**
After a file tool writes/edits/deletes a path, `autoCommit()` in `src/tools/git.ts`
runs: `git add -A -- <path>` → `git status --porcelain -- <path>` (skips with
`no-changes` if clean) → `git commit -q -m "agent(<tool>): <path>" -- <path>` →
returns `git rev-parse --short HEAD`. The hash goes into the tool result, so the
model can report it to you (and `/status` shows the latest commit).

**Will the bot commit *my* uncommitted changes in the workspace?**
No. Both `add` and `commit` use a **pathspec** limited to the file the tool just
touched. `git commit -- <path>` commits only that path's staged state, so your
other staged or dirty files are never swept in.

**What if the commit fails (broken repo, weird permissions)?**
`autoCommit` never throws — it logs and returns the string `"failed"`. The file
change itself stands; you just lose that commit. The agent sees the `"failed"`
result and can tell you.

**Why do bot commits show up as *me* in `git log`?**
`ensureRepo()` probes `git config user.name` / `user.email`, which succeed via your
*global* git config — so no repo-local identity is set and commits are yours. To
distinguish bot commits:
```sh
git -C ~/grandma-workspace config user.name grandma-bot
git -C ~/grandma-workspace config user.email grandma-bot@localhost
```

**What happens if I delete the workspace directory?**
On the next boot, `index.ts` recreates it (`mkdir -p`) and `ensureRepo` runs
`git init`. You lose the git history, nothing else. The bot never stores state
anywhere else except in-memory conversation history.

**Can I use the workspace repo myself — branches, remotes, my own commits?**
Yes. It's a plain git repo. Add a remote and push for backup, commit your own
files, whatever you like. The bot only ever commits the paths its tools touch.
(It *can* run read-only git commands itself — see the deny-list question below.)

**Why does the workspace live outside the project?**
Two independent lifecycles: the harness is code you hack on; the workspace is data
the bot maintains. Separate directories → separate git histories → `git log` in
the workspace is purely the bot's audit trail, and `workspace/` never appears in
the project's status.

### Agent & LLM

**What does one agent turn actually look like?**
`runTurn()` prepends a fresh system prompt to the topic's history and calls
`chat.completions.create` with the six tool schemas. If the reply contains
`tool_calls`, each is executed and its result appended as a `tool` message, then
the loop repeats — up to `maxToolIterations` (12). The first reply *without* tool
calls is the final answer: thought tags are stripped, it's persisted to history,
and returned.

**Why do tool errors not crash the turn?**
`ToolRegistry.dispatch` wraps every tool in try/catch and returns errors as plain
strings (`"error: old_string not found in notes.md"`). The model sees the failure
as a normal tool result and typically self-corrects (re-reads the file, adjusts).
Only LLM/transport errors propagate up to the user as "Something went wrong".

**What happens at the 12-iteration limit?**
The turn ends with `"(stopped: reached the tool-iteration limit)"`. This is the
runaway-loop guard: a confused model ping-ponging between tools can't burn tokens
forever. Your user message stays in history (the abandoned tool-call trace does
not), so `/clear` is your friend if a conversation goes sideways.

**Why does tool support depend on the *provider*, not just the model?**
On the HF router, each provider serves the same weights with its own chat template
and generation config. Tools only work if the provider's template renders them.
That's why the model name pins a provider (`google/gemma-4-26B-A4B-it:novita`) and
why `gemma-4-31B-it:deepinfra` (same family!) reports `supports_tools: false`.
Check per-provider flags at https://router.huggingface.co/v1/models.

**What's the `<|channel>thought…` thing?**
Gemma 4 emits its reasoning wrapped in `<|channel>thought\n…<channel|>` — as an
empty block even with thinking disabled. `stripThought()` in `agent.ts` removes
these from the final answer before it's shown to you or stored in history. This
also follows the model card's guidance: no thoughts in multi-turn history —
*except* tool-call turns, whose raw content is kept within the turn (the model may
need its own reasoning to interpret tool results).

**What gets remembered, and for how long?**
(See "So… are there sessions?" for the full model.) Per topic, in RAM only: up
to 60 messages (`historyLimit`), FIFO-trimmed. The
system prompt is *not* stored — it's rebuilt each turn (so the date is always
current). Restarting the bot wipes all conversation memory; `/clear` wipes one
topic. The workspace and its git log are the only persistent memory.

**Do photos get re-billed every turn?**
Yes — images stay in history as base64 data URLs and are re-sent (and re-charged
as image tokens) on every subsequent turn until they rotate out of the 60-message
window. Gemma 4 uses 70–1120 tokens per image depending on provider settings, so
this is modest, but worth knowing before a photo-heavy session.

### Telegram & topics

**So… are there sessions?**
Not as a formal object — a "session" is just one entry in the `HistoryStore`
(`src/history.ts`): a `Map<chatId:threadId, messages[]>` created lazily on the
first message. Lifecycle: **born** on the topic's first message; **trimmed**
FIFO at 60 messages (no summarization — old pairs just drop off); **dies** on
`/clear` or a bot restart (RAM only, never written to disk). A session holds
*only* user messages and final assistant answers — not the system prompt
(rebuilt fresh each turn), not tool-call traces (those live only within their
own turn; next turn the model sees its own summary, not raw tool outputs), and
no other state — no profiles, settings, or counters. Turns within a session are
strictly serialized by the per-topic promise queue; across sessions everything
runs in parallel. Net effect: each LLM call sees the system prompt plus at most
the last 60 messages of *that one topic*, and after a restart every conversation
starts cold — the workspace (files + `git log`) is the only long-term memory,
which the agent can always re-read to re-orient.

**How do forum topics become separate conversations?**
Every message in a topic group carries `message_thread_id`. The bot keys history
as `chatId:message_thread_id` (DMs/non-forum chats use `0`) and passes the same
`message_thread_id` back when replying, so answers land in the topic they came
from. Two topics in one group are as isolated as two DMs.

**What happens if I send three voice notes in a row?**
Per topic, jobs are chained on a promise queue (`Map<key, Promise>`): each waits
for the previous transcription + agent turn to finish, so replies stay ordered and
agent runs never interleave. Different topics/chats run fully in parallel.

**Why did the bot ignore my message while it was restarting?**
Two reasons: messages older than 120 s at delivery time are dropped (prevents
replaying a stale backlog after downtime), and in-memory history means the bot
wouldn't have the context anyway.

**How are long answers sent?**
Telegram caps messages at 4096 chars. Replies are chunked at 4000, splitting on
the last newline before the cut (hard cut if no good newline exists).

### Voice pipeline

**What exactly happens to a voice note?**
`getFile` → download `.ogg` (OPUS) from `api.telegram.org/file/...` →
`ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le` → multipart POST to
`whisper-server /inference` (form fields `response_format=json`,
`temperature=0.0`) → trimmed transcript → shown to you as `heard: "…"` → fed to
the agent as ordinary user text. Both temp files are deleted in a `finally`,
success or failure.

**Why a persistent whisper-server instead of running whisper-cli per message?**
Model load + Vulkan backend init costs seconds; paying that per voice note would
make voice chat painful. The server loads `ggml-base.bin` (~147 MB) onto the GPU
once and each transcription is then a fast HTTP call. The bot warns at startup if
the server is unreachable (`npm run whisper:up` starts it).

**Why Vulkan and not ROCm or CUDA?**
The RX 570 (Polaris) has no CUDA (AMD) and ROCm dropped Polaris support long ago.
Vulkan via Mesa's RADV driver is fully supported on this card, and whisper.cpp's
`ggml-vulkan` backend runs the whole model there. Same reason a local
`llama-server` would be built with `-DGGML_VULKAN=ON`.

**How do I get better transcription quality?**
Download a bigger model (`download-ggml-model.sh small` or `medium`) and update
the path in the `whisper:up` npm script. `base` is the speed/quality sweet spot;
`.en` variants are faster but English-only. GPU VRAM usage stays tiny either way.

### Security

**What stops a stranger from using my bot?**
A grammY middleware checks `ctx.from.id` against `ALLOWED_USER_IDS` before any
handler runs; everyone else is silently dropped (logged to console). This applies
in DMs *and* groups — add the bot to a group and only listed users get answers.

**How airtight is the workspace sandbox?**
Every tool path goes through `resolveInWorkspace()`: `path.resolve(workspace, rel)`
plus a prefix check, rejecting `..` escapes and absolute paths outright.
`run_command` uses `execFile` **without a shell** — no pipes, redirects, globbing,
or `$(...)` — and matches the binary by basename against `ALLOWED_COMMANDS`. That
said, it's a guardrail, not a security boundary: the agent can write any file in
the workspace (including e.g. git hooks there), so keep the workspace
non-critical and skim `git log` occasionally.

**Which git commands can the agent run?**
`git` is on the command allowlist, but `run_command` refuses destructive/remote
subcommands: `push, reset, clean, rebase, remote, config, checkout, switch,
restore, update-index, filter-branch, gc`. What remains is effectively
read/log/diff/status/add/commit/branch — enough for the agent to inspect its own
history, not enough to publish or destroy it.

**Can the agent read my `.env` or the bot token?**
Not through its tools: `.env` lives outside the workspace and file tools can't
reach it. Be careful what you add to `ALLOWED_COMMANDS` though — something like
`env` or a shell would punch a hole (which is why they're not in the defaults).

**Why does the bot ignore updates older than two minutes?**
So a backlog of messages sent while it was offline doesn't trigger a burst of
agent runs (and LLM spend) on startup.

## Safety notes

- Only Telegram user IDs in `ALLOWED_USER_IDS` can talk to the bot; others are ignored.
- File tools cannot escape `WORKSPACE_DIR` (`..` and absolute paths are rejected).
- `run_command` uses no shell (no pipes/redirection), only runs allowlisted
  binaries, and refuses destructive/remote git subcommands.
- The allowlist is a guardrail, not a security boundary — run the bot as your own
  user, keep the workspace non-critical, and review `git log` if you're curious.
- Keep `.env` out of the workspace; the workspace dir is the only thing the
  agent can touch.
