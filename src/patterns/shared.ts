// =============================================================================
// src/patterns/shared.ts
// =============================================================================
//
// Types, converters, and memory-view accessors shared across all branches.
// Every branch file imports from here so the branches stay decoupled from
// each other — a branch only knows about the shared vocabulary, not about
// its siblings.
//
// DESIGN PRINCIPLE: branches are standalone trees
// -----------------------------------------------
// Each branch lives in its own file and exports a single `Tree.name(...)`
// definition. The main tree (`agent.ts`) imports the branches it needs and
// composes them with `.branch()` and `when()` gates. To add a new behavior:
//
//   1. Create `src/patterns/my-branch.ts`, export a named Tree.
//   2. Import it in `src/patterns/agent.ts`.
//   3. `.branch()` it onto the root (with a `when()` gate if conditional).
//
// No registry, no runtime discovery, no plugin system — just imports and
// composition. The branches are plain values; the tree is plain data. If
// a branch needs something from another branch, it reads from the memory
// scope chain (e.g. `m.branch.classify`), not by importing the other
// branch. Branches never import each other.
//
// =============================================================================

import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";

// =============================================================================
// Internal shape definitions
// =============================================================================
//
// grandma-kat stores a prompt leaf's record as a flat object. Tool calls
// are stripped of their OpenAI nesting (`function.name`,
// `function.arguments`) and stored as `{ id, name, arguments }` so a
// single accessor reaches the name. Tool results are stored as
// `{ name, result, isError? }`. We re-shape these back to OpenAI's
// `tool_calls` nesting when we re-emit the assistant message in the
// next turn's history.

/** A tool call as grandma-kat stores it in `m.raw.prev[i].toolCalls`. */
export interface KatToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A tool result as grandma-kat stores it in `m.raw.prev[i].toolResults`. */
export interface KatToolResult {
  name: string;
  result: unknown;
  isError?: boolean;
}

/** The full record for a prompt leaf. We read `.content`, `.reasoning`,
 *  `.toolCalls`, and `.toolResults` from it. `calls` (the per-round
 *  transcript) exists too but we don't use it in this pattern.
 *
 *  `reasoning` is the model's thinking output. For models that return a
 *  separate reasoning field (DeepSeek, Qwen), it's populated by
 *  grandma-kat's built-in extraction. For models that embed thinking
 *  in the content (Gemma 4's `<|channel>thought…<channel|>`), it's
 *  populated by the per-model `transform` hook in `llm.mjs`. After
 *  the transform runs, the content is clean (no thinking tags) and
 *  the reasoning field has the extracted thinking text. */
export interface KatPromptRecord {
  content: string;
  reasoning?: string | null;
  toolCalls?: KatToolCall[];
  toolResults?: KatToolResult[];
}

// =============================================================================
// Shape converters
// =============================================================================

/**
 * Convert grandma-kat's flat `KatToolCall` array back to OpenAI's nested
 * shape. We need this when re-emitting the assistant turn into the
 * conversation history, because the next LLM call expects the nesting
 * (`type: "function"` plus `function.name`/`function.arguments`).
 *
 * `arguments` stays a JSON STRING in both shapes — OpenAI's protocol
 * requires string args, not an object. Parsing happens at the receiver
 * (in `ToolRegistry.dispatch` via `JSON.parse(argsJson)`).
 */
export function toOpenAiToolCalls(tcs: KatToolCall[]): ChatCompletionMessageToolCall[] {
  return tcs.map((tc) => ({
    id: tc.id,
    type: "function",
    function: { name: tc.name, arguments: tc.arguments },
  }));
}

/**
 * Stringify a tool result for the OpenAI `tool` role. The protocol
 * requires a string body. `ToolRegistry.dispatch` already returns a
 * string, so in practice the `else` branch is a safety net.
 */
export function toToolResultString(tr: KatToolResult | undefined): string {
  if (tr === undefined) return "";
  return typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result ?? "");
}

// =============================================================================
// Memory-view accessors
// =============================================================================
//
// The "memory view" `m` passed to every prompt/gate/check/memory fn is
// a Proxy that intercepts `prev`, `branch`, `raw`, and `error`;
// everything else resolves up the scope chain. We type the accessors
// loosely because grandma-kat has no .d.ts — each function declares
// the minimum shape it needs and the cast happens at the use site.

/** Read the system prompt injected at the root via `memory: { system }`. */
export function readSystem(m: { system?: unknown }): string {
  return typeof m.system === "string" ? m.system : "";
}

/** Read the FULL conversation history from the root scope (no branch). */
export function readMessages(m: { messages?: unknown }): ChatCompletionMessageParam[] {
  return Array.isArray(m.messages) ? (m.messages as ChatCompletionMessageParam[]) : [];
}

/** Capture the prompt's text from `m.prev[1]`. Used by the terminal
 *  branches' "final" memory to expose the assistant's reply as the
 *  branch's value (and thus the tree's exported result). */
export function readPromptText(m: { prev: unknown[] }): string {
  return String(m.prev[1] ?? "");
}

/** Normalize the classify answer for the `when()` gate. Accepts case
 *  differences and trailing punctuation (some models append `.` or
 *  `!` to single-word replies). Returns null if the answer is
 *  unrecognised, which causes BOTH `when()` gates to be false — the
 *  classify `.check()` should have rejected that case upstream, but
 *  the null is a safety net. */
export function readClassifyDecision(m: { branch: { classify?: unknown } }): "tools" | "direct" | null {
  const a = String(m.branch.classify ?? "").trim().toLowerCase().replace(/[.!?,]+$/g, "");
  return a === "tools" || a === "direct" ? a : null;
}

// =============================================================================
// History appenders
// =============================================================================

/** Build the OpenAI message array for a prompt's tool exchange. Appends
 *  an `assistant` message (with `tool_calls` if the model called tools,
 *  or plain text otherwise) and, if tools were called, one `tool` message
 *  per call. Returns a fresh array — safe for the caller to mutate. */
export function buildAssistantAndToolMessages(
  r: KatPromptRecord,
  prev: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  if (!r.toolCalls?.length) {
    return [...prev, { role: "assistant", content: r.content ?? "" }];
  }
  const assistant: ChatCompletionAssistantMessageParam = {
    role: "assistant",
    // `null` (not empty string) is the protocol-correct way to say
    // "this assistant turn only called tools; no text content".
    content: r.content || null,
    tool_calls: toOpenAiToolCalls(r.toolCalls),
  };
  const toolMsgs: ChatCompletionToolMessageParam[] = r.toolCalls.map((tc, i) => ({
    role: "tool",
    tool_call_id: tc.id,
    content: toToolResultString(r.toolResults?.[i]),
  }));
  return [...prev, assistant, ...toolMsgs];
}
