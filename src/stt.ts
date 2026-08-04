import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type SttBackend = "whisper" | "sherpa" | "parakeet";

export interface SttOptions {
  /** Direct https://api.telegram.org/file/bot<token>/<file_path> URL */
  fileUrl: string;
  /** Which STT backend to use. */
  backend: SttBackend;
  /** whisper.cpp server URL (used when backend === "whisper"). */
  whisperUrl: string;
  /** sherpa-onnx websocket server URL (used when backend === "sherpa" or "parakeet"). */
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
        ? await transcribeWithSherpa(wav, sherpaUrl)
        : backend === "parakeet"
          ? await transcribeWithParakeet(wav, sherpaUrl)
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

async function transcribeWithSherpa(wav: Buffer, sherpaUrl: string): Promise<string> {
  // sherpa-onnx-online-websocket-server protocol (see online-websocket-server-impl.cc):
  // (1) connect via WebSocket
  // (2) send binary frames: raw float32 samples (LE), normalized to [-1, 1]
  //     (no header — the sample rate is fixed by the server config)
  // (3) send the text message "Done" to signal end of audio
  // (4) the server replies with text messages: JSON results { text, is_final, is_eof }
  //     and finally the literal text "Done!" when all samples are processed
  //
  // On endpoint detection (pauses between sentences) the server marks the
  // result is_final and RESETS its recognizer, so later partials only contain
  // the new segment. Accumulate is_final segments; partials are per-segment
  // previews and must not overwrite the accumulated transcript.
  //
  // The streaming zipformer en model emits uppercase-only text and the
  // websocket server has no truecaser, so we restore sentence case below.
  const wsUrl = sherpaUrl.replace(/^http/, "ws");
  const samples = wavToFloat32Samples(wav);

  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`sherpa-onnx timed out (no response within 30s): ${wsUrl}`));
    }, 30_000);

    let finished = "";
    let lastPartial = "";

    ws.onopen = () => {
      ws.send(samples);
      ws.send("Done");
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      if (ev.data === "Done!") {
        clearTimeout(timer);
        ws.close();
        const trimmed = (finished || lastPartial).trim();
        if (!trimmed) reject(new Error("transcription came back empty (silent or unintelligible audio?)"));
        else resolve(truecase(trimmed));
        return;
      }
      try {
        const json = JSON.parse(ev.data) as { text?: string; is_final?: boolean };
        if (typeof json.text !== "string") return;
        if (json.is_final) {
          const segment = json.text.trim();
          if (segment) finished += (finished ? " " : "") + segment;
        } else {
          lastPartial = json.text;
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`sherpa-onnx websocket error: ${wsUrl}`));
    };
  });
}

async function transcribeWithParakeet(wav: Buffer, sherpaUrl: string): Promise<string> {
  // sherpa-onnx-offline-websocket-server protocol (offline-websocket-server-impl.cc):
  // (1) connect via WebSocket
  // (2) first binary frame carries a header of two int32 LE values
  //     [sample_rate][expected_byte_size], followed by the raw float32
  //     samples (LE), normalized to [-1, 1]
  // (3) the server decodes once the whole buffer has arrived and replies
  //     with one JSON message containing { "text": ... }
  // (4) the client sends "Done" so the server closes the connection
  const wsUrl = sherpaUrl.replace(/^http/, "ws");
  const samples = wavToFloat32Samples(wav);

  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    // Offline decoding of a long note can take a while on a phone, so scale
    // the timeout with the audio length instead of a fixed cap.
    const durationMs = Math.round((samples.length / 16000) * 1000);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`parakeet (offline) timed out after ${Math.round((durationMs * 3) / 1000)}s: ${wsUrl}`));
    }, Math.max(60_000, durationMs * 3));

    let text = "";

    ws.onopen = () => {
      const frame = new Uint8Array(8 + samples.byteLength);
      const view = new DataView(frame.buffer);
      view.setInt32(0, 16000, true);
      view.setInt32(4, samples.byteLength, true);
      frame.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 8);
      ws.send(frame);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const json = JSON.parse(ev.data) as { text?: string };
        if (typeof json.text === "string") text += json.text;
      } catch {
        // ignore non-JSON messages
      }
      ws.send("Done");
    };

    ws.onclose = () => {
      clearTimeout(timer);
      const trimmed = text.trim();
      if (!trimmed) reject(new Error("transcription came back empty (silent or unintelligible audio?)"));
      else resolve(trimmed);
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`parakeet (offline) websocket error: ${wsUrl}`));
    };
  });
}

/** Restore sentence case to all-caps text (the zipformer en model emits uppercase-only transcripts). */
function truecase(text: string): string {
  let out = "";
  let capNext = true;
  for (const ch of text.toLowerCase()) {
    if (capNext && /[a-z]/.test(ch)) {
      out += ch.toUpperCase();
      capNext = false;
    } else {
      out += ch;
      if (ch === "." || ch === "!" || ch === "?") capNext = true;
    }
  }
  return out;
}

/** Convert a 16-bit PCM WAV into a Float32Array of normalized samples in [-1, 1]. */
function wavToFloat32Samples(wav: Buffer): Float32Array {
  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size;
  }
  if (dataOffset < 0) throw new Error("sherpa-onnx: WAV has no data chunk");

  const sampleCount = Math.floor(dataLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = wav.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return samples;
}

/** Quick reachability probe for whichever backend is active. */
export async function checkStt(backend: SttBackend, whisperUrl: string, sherpaUrl: string): Promise<boolean> {
  const url = backend === "sherpa" ? sherpaUrl : whisperUrl;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url + "/", { signal: ctrl.signal });
    clearTimeout(t);
    // sherpa-onnx is a WebSocket server — plain HTTP GET returns 426
    // (Upgrade Required). That's not an error, the server is alive.
    // Accept any non-5xx response as "reachable".
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Backwards-compat alias for callers still using the old name. */
export const checkWhisper = checkStt;
