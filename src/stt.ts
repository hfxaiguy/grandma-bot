import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface SttOptions {
  /** Direct https://api.telegram.org/file/bot<token>/<file_path> URL */
  fileUrl: string;
  whisperUrl: string;
  tmpDir: string;
  /** Optional language override sent per-request ("en", "de", "auto", ...). */
  language?: string;
}

/** Download a Telegram voice note, convert to 16kHz mono WAV, transcribe via whisper.cpp server. */
export async function transcribeVoice({ fileUrl, whisperUrl, tmpDir, language }: SttOptions): Promise<string> {
  const id = randomUUID();
  const oggPath = path.join(tmpDir, `${id}.ogg`);
  const wavPath = path.join(tmpDir, `${id}.wav`);
  try {
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`voice download failed: HTTP ${res.status}`);
    await fs.writeFile(oggPath, Buffer.from(await res.arrayBuffer()));

    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath,
    ]);

    const wav = await fs.readFile(wavPath);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "json");
    form.append("temperature", "0.0");
    if (language) form.append("language", language);

    const wr = await fetch(`${whisperUrl}/inference`, { method: "POST", body: form });
    if (!wr.ok) throw new Error(`whisper-server failed: HTTP ${wr.status} — ${(await wr.text()).slice(0, 300)}`);
    const json = (await wr.json()) as { text?: string };
    const text = (json.text ?? "").trim();
    if (!text) throw new Error("transcription came back empty (silent or unintelligible audio?)");
    return text;
  } finally {
    await fs.rm(oggPath, { force: true });
    await fs.rm(wavPath, { force: true });
  }
}

/** Quick reachability probe; logs a warning only. */
export async function checkWhisper(whisperUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(whisperUrl + "/", { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}
