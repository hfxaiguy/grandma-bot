// scripts/admin-server.mjs
//
// A tiny zero-dependency admin server for grandma-bob on the phone.
// Listens on $ADMIN_PORT (default 8080) and serves a small web UI for:
//   - setting up .env credentials (bot token, user ID, HF API key)
//   - viewing bot/sherpa tmux status
//   - tailing bot.log / sherpa.log
//   - restarting the bot tmux session
//   - managing tree-runtime patterns (JSON DSL)
//
// Started by deploy-to-phone.sh's install.sh in a tmux session, so it
// survives reboots (as long as tmux is restarted).
//
// Access from the phone's browser:
//   http://127.0.0.1:8181
// Or, if running gnirehtet on the laptop, from the laptop:
//   http://10.0.0.2:8181

import http from "node:http";
import { readFile, writeFile, readdir, stat, mkdir, unlink, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const execFileAsync = promisify(execFile);

const PORT = parseInt(process.env.ADMIN_PORT || "8080", 10);
const HOME = process.env.HOME || "/data/data/com.termux/files/home";
const PROJECT_DIR = process.env.PROJECT_DIR || `${HOME}/grandpa-bob`;
const ENV_PATH = `${PROJECT_DIR}/.env`;
const BOT_LOG = `${HOME}/bot.log`;
const SHERPA_LOG = `${HOME}/sherpa.log`;
const BOT_SESSION = "bot";
const SHERPA_SESSION = "sherpa";
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || `${HOME}/grandma-workspace`;
const PATTERNS_DIR = `${WORKSPACE_DIR}/patterns`;

// ----- helpers -----
async function tmux(args) {
  try {
    const { stdout, stderr } = await execFileAsync("tmux", args, { timeout: 5000 });
    return { ok: true, out: stdout, err: stderr };
  } catch (e) {
    return { ok: false, out: e.stdout || "", err: e.stderr || e.message };
  }
}

async function readTail(file, lines = 60) {
  try {
    const data = await readFile(file, "utf8");
    return data.split("\n").slice(-lines).join("\n");
  } catch (e) {
    return `(unable to read ${file}: ${e.message})`;
  }
}

function mask(v) {
  if (!v) return "(unset)";
  if (v.length <= 8) return "•".repeat(v.length);
  return v.slice(0, 4) + "•".repeat(Math.max(0, v.length - 8)) + v.slice(-4);
}

async function readEnv() {
  try {
    const data = await readFile(ENV_PATH, "utf8");
    const out = {};
    for (const line of data.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return null;
  }
}

async function writeEnv(updates) {
  let current = {};
  try {
    const data = await readFile(ENV_PATH, "utf8");
    for (const line of data.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) current[m[1]] = m[2];
    }
  } catch { /* no existing file */ }
  const merged = { ...current, ...updates };
  const body = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  await writeFile(ENV_PATH, body, { mode: 0o600 });
}

async function tmuxStatus() {
  const r = await tmux(["list-sessions", "-F", "#{session_name}"]);
  const sessions = new Set();
  if (r.ok) for (const line of r.out.split("\n")) if (line.trim()) sessions.add(line.trim());
  return {
    bot: sessions.has(BOT_SESSION),
    sherpa: sessions.has(SHERPA_SESSION),
  };
}

async function restartBot() {
  await tmux(["kill-session", "-t", BOT_SESSION]);
  await tmux([
    "new-session", "-d", "-s", BOT_SESSION,
    `sh -c 'cd "${PROJECT_DIR}" && exec npm run dev 2>&1 | tee "${HOME}/bot.log'`,
  ]);
}

// ----- pattern registry -----
async function listPatterns() {
  try {
    const files = await readdir(PATTERNS_DIR);
    const patterns = [];
    for (const f of files) {
      if (!f.endsWith(".mjs")) continue;
      try {
        const content = await readFile(path.join(PATTERNS_DIR, f), "utf8");
        // Extract name and description from JSDoc comments
        const nameMatch = content.match(/^\/\/\s*(\S+\.mjs)\s*[—–-]\s*(.+)/m);
        const name = nameMatch ? nameMatch[1].replace(/\.mjs$/, "") : f.replace(/\.mjs$/, "");
        const desc = nameMatch ? nameMatch[2] : "(no description)";
        patterns.push({ file: f, name, description: desc });
      } catch (e) {
        patterns.push({ file: f, name: f, description: `read error: ${e.message}` });
      }
    }
    return patterns;
  } catch {
    return [];
  }
}

async function readPattern(name) {
  try {
    return await readFile(path.join(PATTERNS_DIR, `${name}.mjs`), "utf8");
  } catch {
    return null;
  }
}

async function writePattern(name, content) {
  await mkdir(PATTERNS_DIR, { recursive: true });
  await writeFile(path.join(PATTERNS_DIR, `${name}.mjs`), content, { mode: 0o644 });
}

async function deletePattern(name) {
  try { await (await import("node:fs/promises")).unlink(path.join(PATTERNS_DIR, `${name}.mjs`)); } catch {}
}

// ----- file browser -----
// Path safety: all paths resolve inside WORKSPACE_DIR, no escapes.
function safePath(p) {
  const resolved = path.resolve(WORKSPACE_DIR, p || ".");
  if (!resolved.startsWith(WORKSPACE_DIR)) throw new Error("path outside workspace");
  return resolved;
}

async function listFiles(dir) {
  const resolved = safePath(dir);
  const entries = await readdir(resolved, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(resolved, e.name);
    const s = await stat(full).catch(() => null);
    out.push({
      name: e.name,
      isDir: e.isDirectory(),
      size: s ? s.size : 0,
      mtime: s ? s.mtime.toISOString() : null,
    });
  }
  out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  return out;
}

async function readBinary(p) {
  const resolved = safePath(p);
  return await readFile(resolved);
}

async function saveFile(p, content) {
  const resolved = safePath(p);
  const dir = path.dirname(resolved);
  await mkdir(dir, { recursive: true });
  await writeFile(resolved, content, { mode: 0o644 });
}

async function deleteFile(p) {
  const resolved = safePath(p);
  await unlink(resolved);
}

// Read multipart form data (simple, no external deps)
function readMultipart(req, boundary) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      const str = buf.toString("latin1");
      // find the part after boundary
      const parts = str.split("--" + boundary).slice(1, -1);
      const result = {};
      for (const part of parts) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd < 0) continue;
        const header = part.slice(0, headerEnd);
        const body = part.slice(headerEnd + 4, part.length - 2); // strip trailing \r\n
        const nameMatch = header.match(/name="([^"]+)"/);
        const filenameMatch = header.match(/filename="([^"]+)"/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        if (filenameMatch) {
          result[name] = { filename: filenameMatch[1], content: Buffer.from(body, "latin1") };
        } else {
          result[name] = body;
        }
      }
      resolve(result);
    });
    req.on("error", reject);
  });
}

// ----- HTML -----
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>grandpa-bob admin</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --fg:#e2e8f0; --muted:#94a3b8; --accent:#3b82f6; --green:#10b981; --red:#ef4444; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 16px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  h2 { font-size: 16px; margin: 24px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .card { background: var(--card); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .status { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot.on { background: var(--green); }
  .dot.off { background: var(--red); }
  label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
  input { width: 100%; padding: 10px 12px; background: #0b1224; color: var(--fg);
          border: 1px solid #334155; border-radius: 6px; font: 14px ui-monospace, monospace; }
  input:focus { outline: none; border-color: var(--accent); }
  button { background: var(--accent); color: white; border: none; padding: 10px 18px;
           border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button.secondary { background: #475569; }
  button.danger { background: var(--red); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  pre { background: #0b1224; color: #cbd5e1; padding: 12px; border-radius: 6px;
        font: 12px ui-monospace, monospace; max-height: 280px; overflow: auto;
        white-space: pre-wrap; word-break: break-all; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .toast { position: fixed; top: 16px; right: 16px; background: var(--green); color: white;
           padding: 10px 16px; border-radius: 6px; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .toast.err { background: var(--red); }
  a { color: var(--accent); }
  small { color: var(--muted); }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 600px) { .grid-2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>grandpa-bob admin</h1>

<div class="card">
  <div class="row">
    <span class="status"><span id="dot-bot" class="dot"></span> bot</span>
    <span class="status"><span id="dot-sherpa" class="dot"></span> sherpa-onnx</span>
    <span class="status"><span id="dot-admin" class="dot on"></span> admin (this)</span>
    <span style="margin-left:auto"><small id="uptime"></small></span>
  </div>
  <div class="actions">
    <button onclick="restartBot()">Restart bot</button>
    <button class="secondary" onclick="refreshAll()">Refresh</button>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Credentials</h2>
  <form id="envForm" onsubmit="saveEnv(event)">
    <div class="grid-2">
      <div>
        <label>Telegram bot token <span id="cur-token" style="float:right"></span></label>
        <input id="f-token" type="password" placeholder="123456:ABC-DEF...">
      </div>
      <div>
        <label>Your Telegram user ID <span id="cur-uid" style="float:right"></span></label>
        <input id="f-uid" type="text" inputmode="numeric" placeholder="123456789">
      </div>
    </div>
    <label>Hugging Face API key <span id="cur-hf" style="float:right"></span></label>
    <input id="f-hf" type="password" placeholder="hf_...">
    <small>Other settings (LLM model, STT, workspace) live in <code>.env</code> and can be edited by hand on the phone.</small>
    <div class="actions">
      <button type="submit">Save credentials</button>
    </div>
  </form>
</div>

<div class="card">
  <h2 style="margin-top:0">Logs</h2>
  <div class="row" style="margin-bottom:8px">
    <button class="secondary" onclick="loadLog('bot')">bot.log</button>
    <button class="secondary" onclick="loadLog('sherpa')">sherpa.log</button>
    <span style="margin-left:auto"><small>last 60 lines</small></span>
  </div>
  <pre id="log">(click a log button)</pre>
</div>

<div class="card">
  <h2 style="margin-top:0">Tree patterns</h2>
  <p style="margin:4px 0"><small>JSON tree-runtime patterns for the agent loop. Contributors can write their own in <code>$HOME/grandma-workspace/patterns/</code> and share them.</small></p>
  <div id="pattern-list">(loading...)</div>
  <div class="actions">
    <button class="secondary" onclick="refreshPatterns()">Refresh</button>
    <button onclick="showNewPattern()">New pattern</button>
  </div>
  <div id="pattern-editor" style="display:none; margin-top:12px">
    <label>Pattern name (no spaces, e.g. "my-pattern")</label>
    <input id="p-name" type="text" placeholder="my-pattern">
    <label>Pattern code (.mjs — export default async function)</label>
    <textarea id="p-code" style="width:100%; min-height:200px; background:#0b1224; color:#cbd5e1;
      border:1px solid #334155; border-radius:6px; padding:12px;
      font:12px ui-monospace,monospace; resize:vertical"></textarea>
    <div class="actions">
      <button onclick="savePattern()">Save pattern</button>
      <button class="secondary" onclick="hideNewPattern()">Cancel</button>
    </div>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Access</h2>
  <p style="margin:4px 0"><small>This UI runs on the phone at <code>http://127.0.0.1:${PORT}</code>.</small></p>
  <p style="margin:4px 0"><small>If you're on the same Wi-Fi, open <code>http://<phone-ip>:${PORT}</code> from your laptop.</small></p>
  <p style="margin:4px 0"><small>To expose to the internet, run an SSH reverse tunnel or use Termux's <code>pkg install cloudflared</code>.</small></p>
</div>

<div class="card">
  <h2 style="margin-top:0">Files</h2>
  <p style="margin:4px 0"><small>Browse, upload, and download files in the workspace.</small></p>
  <div id="file-nav" class="row" style="margin-bottom:8px; flex-wrap:wrap">
    <button class="secondary" onclick="filesBrowse()">↻ Refresh</button>
    <span id="file-path" style="margin-left:auto; font-size:12px; color:var(--muted)">/</span>
  </div>
  <div id="file-list" style="max-height:300px; overflow:auto; border:1px solid #334155; border-radius:6px; padding:8px; background:#0b1224; font:12px ui-monospace,monospace">(loading...)</div>
  <div class="actions" style="margin-top:8px">
    <input id="file-upload-input" type="file" style="display:none" onchange="uploadFile(this)" multiple />
    <button onclick="document.getElementById('file-upload-input').click()">Upload file</button>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let startedAt = Date.now();

function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  setTimeout(() => t.className = "toast" + (isErr ? " err" : ""), 2000);
}

async function api(path, opts) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { toast(data.error || \`HTTP \${r.status}\`, true); throw new Error(data.error); }
  return data;
}

async function refreshStatus() {
  const s = await api("/api/status");
  $("dot-bot").className = "dot " + (s.bot ? "on" : "off");
  $("dot-sherpa").className = "dot " + (s.sherpa ? "on" : "off");
  $("cur-token").textContent = s.env.TELEGRAM_BOT_TOKEN ? "current: " + s.env.TELEGRAM_BOT_TOKEN : "current: (unset)";
  $("cur-uid").textContent = s.env.ALLOWED_USER_IDS ? "current: " + s.env.ALLOWED_USER_IDS : "current: (unset)";
  $("cur-hf").textContent = s.env.LLM_API_KEY ? "current: " + s.env.LLM_API_KEY : "current: (unset)";
}

async function refreshAll() {
  try { await refreshStatus(); toast("refreshed"); } catch (e) {}
}

async function saveEnv(e) {
  e.preventDefault();
  const body = {};
  if ($("f-token").value) body.TELEGRAM_BOT_TOKEN = $("f-token").value;
  if ($("f-uid").value) body.ALLOWED_USER_IDS = $("f-uid").value;
  if ($("f-hf").value) body.LLM_API_KEY = $("f-hf").value;
  if (Object.keys(body).length === 0) { toast("nothing to save", true); return; }
  try {
    await api("/api/env", { method: "POST", body: JSON.stringify(body) });
    toast("saved");
    $("f-token").value = $("f-uid").value = $("f-hf").value = "";
    await refreshStatus();
  } catch {}
}

async function restartBot() {
  try { await api("/api/restart-bot", { method: "POST" }); toast("bot restarting..."); setTimeout(refreshStatus, 2000); } catch {}
}

async function loadLog(name) {
  try {
    const r = await api("/api/log?file=" + name);
    $("log").textContent = r.content || "(empty)";
  } catch {}
}

async function refreshPatterns() {
  try {
    const r = await api("/api/patterns");
    const list = $("pattern-list");
    if (r.patterns.length === 0) {
      list.innerHTML = '<small style="color:var(--muted)">No patterns yet. Click "New pattern" to create one.</small>';
      return;
    }
    list.innerHTML = r.patterns.map(p => {
      const name = p.name || p.file;
      const desc = p.description || "(no description)";
      return \`<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #334155">
        <div>
          <strong>\${name}</strong> <small style="color:var(--muted)">— \${desc}</small>
        </div>
        <div>
          <button class="secondary" style="padding:4px 8px; font-size:12px" onclick="viewPattern('\${name}')">View</button>
          <button class="danger" style="padding:4px 8px; font-size:12px" onclick="deletePattern('\${name}')">Delete</button>
        </div>
      </div>\`;
    }).join("");
  } catch {}
}

async function viewPattern(name) {
  try {
    const r = await api("/api/patterns/" + name);
    $("p-name").value = r.name || name;
    $("p-code").value = r.content || "";
    $("pattern-editor").style.display = "block";
  } catch {}
}

function showNewPattern() {
  $("p-name").value = "";
  $("p-code").value = `// my-pattern.mjs — description of what this pattern does
//
// Available in state:
//   state.llm.chat(model, messages) — call the LLM
//   state.tools.execute(toolCalls) — execute tool calls
//   state.messages — the conversation history
//
// model names: "cheap" (fast, routing) or "strong" (slow, tool-heavy)

export default async function myPattern(state) {
  const response = await state.llm.chat("cheap", state.messages);
  if (response.toolCalls && response.toolCalls.length > 0) {
    const results = await state.tools.execute(response.toolCalls);
    const followup = await state.llm.chat("cheap", [...state.messages, ...results]);
    return followup.content;
  }
  return response.content;
}
`;
  $("pattern-editor").style.display = "block";
}

function hideNewPattern() {
  $("pattern-editor").style.display = "none";
}

async function savePattern() {
  const name = $("p-name").value.trim();
  if (!name) { toast("pattern name required", true); return; }
  const content = $("p-code").value;
  if (!content.trim()) { toast("pattern code required", true); return; }
  try {
    await api("/api/patterns", { method: "POST", body: JSON.stringify({ name, content }) });
    toast("pattern saved");
    hideNewPattern();
    refreshPatterns();
  } catch {}
}

async function deletePattern(name) {
  if (!confirm(\`Delete pattern "\${name}"?\`)) return;
  try {
    await api("/api/patterns/" + name, { method: "DELETE" });
    toast("pattern deleted");
    refreshPatterns();
  } catch {}
}

setInterval(() => {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(sec / 60), s = sec % 60;
  $("uptime").textContent = \`uptime: \${m}m \${s}s\`;
}, 1000);

// ----- file browser -----
let currentDir = "";

async function filesBrowse(dir) {
  if (dir !== undefined) currentDir = dir;
  try {
    const r = await api("/api/files?path=" + encodeURIComponent(currentDir));
    $("file-path").textContent = "/" + (r.dir || "(root)");
    const list = $("file-list");
    if (r.files.length === 0) {
      list.innerHTML = '<small style="color:var(--muted)">(empty directory)</small>';
      return;
    }
    list.innerHTML = r.files.map(f => {
      const size = f.isDir ? "dir" : formatSize(f.size);
      const mtime = f.mtime ? new Date(f.mtime).toLocaleString() : "";
      const click = f.isDir ? \`onclick="filesBrowse('\${escapePath(r.dir, f.name)}')"\` : "";
      const dl = !f.isDir ? \`<a href="/api/files/download?path=\${escapePath(r.dir, f.name)}" style="color:var(--accent); text-decoration:none; font-size:11px">↓</a>\` : "";
      const rm = !f.isDir ? \`<button class="danger" style="padding:2px 6px; font-size:11px" onclick="deleteFile('\${escapePath(r.dir, f.name)}', '\${f.name}')">×</button>\` : "";
      return \`<div style="display:flex; align-items:center; padding:3px 0; border-bottom:1px solid #1e293b">
        <span \${click} style="cursor:\${f.isDir ? 'pointer' : 'default'}; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
          \${f.isDir ? '📁 ' : '📄 '}\${f.name}
        </span>
        <span style="width:60px; text-align:right; color:var(--muted); font-size:11px">\${size}</span>
        <span style="width:140px; text-align:right; color:var(--muted); font-size:11px">\${mtime}</span>
        <span style="width:30px; text-align:center">\${dl}\${rm}</span>
      </div>\`;
    }).join("");
  } catch (e) {
    $("file-list").textContent = "error: " + e.message;
  }
}

function escapePath(dir, name) {
  const p = dir ? dir + "/" + name : name;
  return p.replace(/'/g, "\\'");
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

async function deleteFile(p, name) {
  if (!confirm('Delete "' + name + '"?')) return;
  try {
    await api("/api/files?path=" + encodeURIComponent(p), { method: "DELETE" });
    toast("deleted " + name);
    filesBrowse();
  } catch {}
}

async function uploadFile(input) {
  const files = input.files;
  if (!files.length) return;
  for (const file of files) {
    const fd = new FormData();
    fd.append("path", currentDir);
    fd.append("file", file);
    try {
      const r = await fetch("/api/files/upload", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) { toast(d.error || "upload failed", true); continue; }
      toast("uploaded " + file.name);
    } catch (e) {
      toast("upload failed: " + e.message, true);
    }
  }
  input.value = "";
  filesBrowse();
}

refreshStatus();
refreshPatterns();
filesBrowse();
</script>
</body>
</html>
`;

// ----- HTTP server -----
async function handleJson(fn) {
  return async (req, res) => {
    try {
      const data = await fn(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      const [env, status] = await Promise.all([readEnv(), tmuxStatus()]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ env: env || {}, ...status }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/env") {
      const body = await readBody(req);
      const updates = JSON.parse(body);
      await writeEnv(updates);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/restart-bot") {
      await restartBot();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/log") {
      const file = url.searchParams.get("file");
      const path = file === "bot" ? BOT_LOG : file === "sherpa" ? SHERPA_LOG : null;
      if (!path) { res.writeHead(400); res.end('{"error":"file must be bot or sherpa"}'); return; }
      const content = await readTail(path, 60);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/patterns") {
      const patterns = await listPatterns();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ patterns }));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/patterns/")) {
      const name = url.pathname.split("/").pop();
      const content = await readPattern(name);
      if (content === null) { res.writeHead(404); res.end('{"error":"pattern not found"}'); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name, content }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/patterns") {
      const body = await readBody(req);
      const p = JSON.parse(body);
      if (!p.name || !p.content) { res.writeHead(400); res.end('{"error":"pattern must have name and content"}'); return; }
      await writePattern(p.name, p.content);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/patterns/")) {
      const name = url.pathname.split("/").pop();
      await deletePattern(name);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // --- file browser API ---
    if (req.method === "GET" && url.pathname === "/api/files") {
      const dir = url.searchParams.get("path") || "";
      const files = await listFiles(dir);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ dir, files }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/files/download") {
      const p = url.searchParams.get("path");
      if (!p) { res.writeHead(400); res.end('{"error":"path required"}'); return; }
      const content = await readBinary(p);
      const filename = path.basename(p);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${filename}"` });
      res.end(content);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/files/upload") {
      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("multipart/form-data")) { res.writeHead(400); res.end('{"error":"multipart required"}'); return; }
      const boundary = contentType.split("boundary=")[1];
      if (!boundary) { res.writeHead(400); res.end('{"error":"no boundary"}'); return; }
      const parts = await readMultipart(req, boundary);
      const file = parts.file;
      const destPath = parts.path || "";
      if (!file || !file.filename) { res.writeHead(400); res.end('{"error":"no file"}'); return; }
      const saveTo = path.join(destPath, file.filename);
      await saveFile(saveTo, file.content);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: saveTo, size: file.content.length }));
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/files") {
      const p = url.searchParams.get("path");
      if (!p) { res.writeHead(400); res.end('{"error":"path required"}'); return; }
      await deleteFile(p);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("error: " + e.message);
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`grandma-bob admin UI: http://0.0.0.0:${PORT} (bound on all interfaces)`);
});

// also print the Wi-Fi IP if we can find it (best-effort, non-blocking)
import { execFile as _execFile } from "node:child_process";
import { promisify as _promisify } from "node:util";
const _execFileAsync = _promisify(_execFile);
_execFileAsync("/system/bin/ip", ["-4", "addr", "show", "wlan0"])
  .then(({ stdout }) => {
    const m = stdout.match(/inet (\S+)/);
    if (m) console.log(`Open on your laptop: http://${m[1]}:${PORT}`);
  })
  .catch(() => {});
