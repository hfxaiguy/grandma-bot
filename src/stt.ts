import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type SttBackend = "whisper" | "sherpa";

export interface SttOptions {
  /** Direct https://api.telegram.org/file/bot<token>/<file_path> URL */
  fileUrl: string;
  /** Which STT backend to use. */
  backend: SttBackend;
  /** whisper.cpp server URL (used when backend === "whisper"). */
  whisperUrl: string;
  /** sherpa-onnx HTTP server URL (used when backend === "sherpa"). */
  sherpaUrl: string;
  tmpDir: string;
  /** Optional language override sent per-request ("en", "de", "auto", ...). */
  language?: string;
}

/** Download a Telegram voice note, convert to 16kHz mono WAV, transcribe via the configured backend. */
export async function transcribeVoice({ fileUrl, backend, whisperUrl, sherpaUrl, tmpDir, language }: SttOptions): Promise<string> {
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

    return backend === "sherpa"
      ? await transcribeWithSherpa(wav, sherpaUrl, language)
      : await transcribeWithWhisper(wav, whisperUrl, language);
  } finally {
    await fs.rm(oggPath, { force: true });
    await fs.rm(wavPath, { force: true });
  }
}

async function transcribeWithWhisper(wav: Buffer, whisperUrl: string, language?: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  if (language) form.append("language", language);

  const wr = await fetch(`${whisperUrl}/inference`, { method: "POST", body: form });
  if (!wr.ok) throw new Error(`whisper-server failed: HTTP ${wr.status} — ${(await wr.text()).slice(0, 300)}`);
  const json = (await wr.json()) as { text?: string };
  const text = (json.text ?? "").trim();
  if (!text) throw new Error("transcription came back empty (silent or unintelligible audio?)");
  return text;
}

async function transcribeWithSherpa(wav: Buffer, sherpaUrl: string, language?: string): Promise<string> {
  // sherpa-onnx HTTP server /recognize: JSON body, "wave" = base64 of a full WAV file
  // (server auto-parses the WAV header so sample_rate isn't required).
  const body: Record<string, unknown> = { wave: wav.toString("base64") };
  if (language) body.language = language;

  const sr = await fetch(`${sherpaUrl}/recognize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!sr.ok) throw new Error(`sherpa-onnx failed: HTTP ${sr.status} — ${(await sr.text()).slice(0, 300)}`);
  const json = (await sr.json()) as { text?: string; transcript?: string };
  const text = (json.text ?? json.transcript ?? "").trim();
  if (!text) throw new Error("transcription came back empty (silent or unintelligible audio?)");
  return text;
}

/** Quick reachability probe for whichever backend is active. */
export async function checkStt(backend: SttBackend, whisperUrl: string, sherpaUrl: string): Promise<boolean> {
  const url = backend === "sherpa" ? sherpaUrl : whisperUrl;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url + "/", { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Backwards-compat alias for callers still using the old name. */
export const checkWhisper = checkStt;
