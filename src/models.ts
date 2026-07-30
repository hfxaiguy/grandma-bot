// Model registry loader. Reads `models.json` from the working directory if
// present, otherwise builds a single-entry registry from the LLM_BASE_URL /
// LLM_API_KEY / LLM_MODEL env vars (legacy single-backend path).
//
// Each entry has the OpenAI-compatible shape grandma-kat expects:
//   { baseURL: string, apiKey: string, model: string }
//
// String values are interpolated against process.env: "${HF_TOKEN}" becomes
// whatever HF_TOKEN is. Use "$$" for a literal "$". Missing vars are left
// as the empty string (so a stray "${}" yields "", not "undefined").
//
// The pattern in src/patterns/agent.ts always references named slots
// "cheap" and "strong". If the user supplies only the env-var path, both
// slots point to the same model.

import fs from "node:fs/promises";
import path from "node:path";

export type ModelEntry = { baseURL: string; apiKey: string; model: string };
export type ModelRegistry = Record<string, ModelEntry>;

function interpolate(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}

function normalizeEntry(raw: unknown, name: string): ModelEntry {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`models.json: entry "${name}" must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.baseURL !== "string") {
    throw new Error(`models.json: entry "${name}" is missing required string "baseURL"`);
  }
  if (typeof r.model !== "string" || r.model.length === 0) {
    throw new Error(`models.json: entry "${name}" is missing required string "model"`);
  }
  return {
    baseURL: interpolate(r.baseURL),
    apiKey: interpolate(typeof r.apiKey === "string" ? r.apiKey : ""),
    model: interpolate(r.model),
  };
}

async function loadFromFile(cwd: string): Promise<ModelRegistry | null> {
  const file = path.resolve(cwd, "models.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`models.json: invalid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("models.json: top-level value must be an object of name -> entry");
  }
  const out: ModelRegistry = {};
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    out[name] = normalizeEntry(entry, name);
  }
  if (Object.keys(out).length === 0) {
    throw new Error("models.json: no model entries defined");
  }
  return out;
}

function fromEnv(): ModelRegistry {
  const baseURL = (process.env.LLM_BASE_URL ?? "http://127.0.0.1:11434/v1").replace(/\/$/, "");
  const apiKey = process.env.LLM_API_KEY ?? "ollama";
  const model = process.env.LLM_MODEL ?? "gemma4:31b-cloud";
  // Both slots point at the same model so the pattern's .model('cheap'|'strong')
  // references always resolve, even when the user hasn't pulled a separate
  // small model. They can edit models.json to split them.
  return {
    cheap: { baseURL, apiKey, model },
    strong: { baseURL, apiKey, model },
  };
}

export async function loadModels(cwd = process.cwd()): Promise<ModelRegistry> {
  const fromFile = await loadFromFile(cwd);
  if (fromFile) return fromFile;
  return fromEnv();
}
