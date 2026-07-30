// Model registry loader. Reads `models.json` from the working directory if
// present, otherwise builds a single-entry registry from the LLM_BASE_URL /
// LLM_API_KEY / LLM_MODEL env vars (legacy single-backend path).
//
// Each entry has the OpenAI-compatible shape grandma-kat expects:
//   { baseURL: string, apiKey: string, model: string, transform?: string }
//
// String values are interpolated against process.env: "${HF_TOKEN}" becomes
// whatever HF_TOKEN is. Use "$$" for a literal "$". Missing vars are left
// as the empty string (so a stray "${}" yields "", not "undefined").
//
// The `transform` field is an optional response-transform name. It
// references a built-in function that runs inside grandma-kat's llm.mjs
// AFTER the library's own thinking-model handling (</think> extraction) but
// BEFORE the response reaches the runner. This is where model-specific
// tag formats go — e.g. Gemma 4's <|channel>thought…<channel|>.
//
// Available built-in transforms:
//   "gemma4Thinking"  — strips Gemma 4 channel-wrapped thinking tags
//                       from content and populates the reasoning field.
//
// The pattern in src/patterns/agent.ts always references named slots
// "cheap" and "strong". If the user supplies only the env-var path, both
// slots point to the same model.

import fs from "node:fs/promises";
import path from "node:path";

/**
 * A response-transform function. Receives the LLM's response (after
 * grandma-kat's built-in thinking-model handling) and returns a
 * (possibly modified) partial response. Only the fields you return
 * are overwritten; undefined fields are left as-is.
 *
 * `ctx` provides the messages and tools that were sent to the LLM,
 * plus the model name — useful if the transform needs to behave
 * differently per model or per prompt shape.
 */
export type ModelTransform = (
  response: {
    content: string;
    reasoning: string | null;
    tool_calls: unknown[] | null;
    raw: unknown;
  },
  ctx: { messages: unknown; tools: unknown; model: string },
) => {
  content?: string;
  reasoning?: string | null;
  tool_calls?: unknown[] | null;
} | null | undefined;

export type ModelEntry = {
  baseURL: string;
  apiKey: string;
  model: string;
  transform?: ModelTransform;
};

export type ModelRegistry = Record<string, ModelEntry>;

function interpolate(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}

// ── Built-in response transforms ──────────────────────────────────────────
//
// Each transform runs inside grandma-kat's llm.mjs AFTER the library's
// own thinking-model handling (</think> extraction). The transform sees the
// final content, reasoning, and tool_calls, and can modify any of them.
//
// To register a new built-in, add it here and reference it by name in
// models.json: `"transform": "myTransform"`.

const BUILTIN_TRANSFORMS: Record<string, ModelTransform> = {
  /**
   * Strip Gemma 4's channel-wrapped thinking tags from content and
   * populate the reasoning field from the thinking block.
   *
   * Gemma 4 emits reasoning as:
   *   <|channel>thought\n[thinking text]<channel|>[answer text]
   *
   * This format is NOT handled by grandma-kat's built-in </think>
   * extraction (which is for Qwen-style models). The transform:
   * 1. Extracts the thinking text into `reasoning`
   * 2. Strips the <|channel> block from `content`
   *
   * After this transform, `m.raw.prev[i].reasoning` has the full
   * thinking text and the pattern sees clean content in `m.prev[i]`.
   * The SQLite log records both fields.
   */
  gemma4Thinking: (r) => {
    const m = r.content.match(/<\|channel\|>thought\n([\s\S]*?)<channel\|>/);
    return {
      content: r.content.replace(/<\|channel\|>thought\n[\s\S]*?<channel\|>/g, "").trim(),
      reasoning: r.reasoning || (m?.[1]?.trim() ?? null),
    };
  },
};

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
  const entry: ModelEntry = {
    baseURL: interpolate(r.baseURL),
    apiKey: interpolate(typeof r.apiKey === "string" ? r.apiKey : ""),
    model: interpolate(r.model),
  };
  // Wire the transform. In models.json the value is a string name
  // referencing a built-in above. If the field is missing or empty,
  // no transform runs (passthrough).
  if (typeof r.transform === "string" && r.transform.length > 0) {
    const t = BUILTIN_TRANSFORMS[r.transform];
    if (!t) {
      throw new Error(
        `models.json: entry "${name}" references unknown transform "${r.transform}". ` +
          `Available: ${Object.keys(BUILTIN_TRANSFORMS).join(", ") || "(none)"}`,
      );
    }
    entry.transform = t;
  }
  return entry;
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
  // Auto-detect Gemma 4 models and apply the channel-thinking transform.
  const transform = /gemma.?4/i.test(model) ? BUILTIN_TRANSFORMS.gemma4Thinking : undefined;
  return {
    cheap: { baseURL, apiKey, model, transform },
    strong: { baseURL, apiKey, model, transform },
  };
}

export async function loadModels(cwd = process.cwd()): Promise<ModelRegistry> {
  const fromFile = await loadFromFile(cwd);
  if (fromFile) return fromFile;
  return fromEnv();
}
