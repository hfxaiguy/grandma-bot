// =============================================================================
// src/patterns/agent.ts
// =============================================================================
//
// The agent pattern — a grandma-kat `Tree` that drives one Telegram turn.
//
// -----------------------------------------------------------------------------
// HIGH-LEVEL SHAPE
// -----------------------------------------------------------------------------
//
//   agentPattern                       (root tree, name = "agent")
//     ├─ classify (branch)             cheap model: answers "tools" or "direct"
//     ├─ direct  (branch, gated)      cheap model: text-only answer
//     └─ tools   (branch, gated)      strong model: tool-using loop
//
// The root tree has THREE children. The first always runs (it produces
// the classification). The other two are gated by `when()` on the
// classify branch's output — exactly one of `direct`/`tools` fires,
// never both, never neither (the classify `.check()` guarantees the
// answer is parseable).
//
// -----------------------------------------------------------------------------
// WHY PER-STEP MODEL SELECTION
// -----------------------------------------------------------------------------
//
// Routing a Telegram turn through a small model first lets us spend the
// expensive model only on cases that need it. A "what's the capital of
// France?" turn should not pay for the 31B MoE running a tools loop;
// it can be answered in one cheap-model call. A "create mock.txt with…"
// turn must reach the strong model. The classifier is the gate.
//
// -----------------------------------------------------------------------------
// RETURN CONTRACT
// -----------------------------------------------------------------------------
//
// `agentPattern` exports the FINAL ASSISTANT TEXT as the tree's `result`.
// The terminal branches end with a `.memory("final", …)` child that
// captures the prompt's text via `m.prev[1]` (the second-to-last
// executed child, which is the prompt). The runner records that value
// in the branch's local scope under the name "final"; the branch's
// last child is "final", so the branch's exported value is the text.
//
// The agent reads `memory.messages` for the full updated conversation
// history (including any tool exchanges from this turn) and copies
// that array back onto the caller's `messages`. The text is the
// return value of `agent.runTurn()`.
//
// -----------------------------------------------------------------------------
// HISTORY MANAGEMENT
// -----------------------------------------------------------------------------
//
// The conversation history lives in the ROOT scope under the name
// "messages" (injected by the agent via `memory: { messages, system }`).
// Each terminal branch's `memoryUpdate("messages", …)` appends this
// turn's exchange to that array. Because grandma-kat's runner now
// correctly writes through the scope chain (the previous "ancestor
// shadow" bug was fixed: `record()` reads `outcome._slotScope` and
// writes to the actual target scope, not always the local), the
// walker's pass-2 lookup hits the root and continues updating the
// correct slot across until() iterations.
//
// For the tools branch specifically, the per-pass child order is:
//
//   #0  prompt(...)                                LLM call + tool execution
//   #1  memoryUpdate("messages", …)               append this turn's exchange
//   #2  memory("final", m => m.prev[1])           capture the prompt's text
//   --  until(no toolCalls, max(12))               container loop (not a child)
//
// At the until check, `m.raw.prev[2]` is the prompt's record from
// this pass (its `.toolCalls` array tells us whether to loop).
//
// =============================================================================

// @ts-ignore — grandma-kat ships no .d.ts files.
import { Tree, when, goback, max } from "grandma-kat";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";

/**
 * The six tool names the `tools` branch advertises to the LLM. The
 * implementations live in `src/tools/index.ts` and are wired in at
 * runtime via `ToolRegistry.toKatTools()`. Adding a name here without
 * registering its `execute` will fail grandma-kat's up-front
 * validation (it diffs every `.tools()` reference against the
 * runtime registry and throws with one error per missing name).
 *
 * Order is alphabetical and intentionally stable so the rendered JSON
 * schema in the LLM request doesn't shift across deploys (some
 * models are sensitive to schema ordering).
 */
const TOOL_NAMES = [
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "run_command",
] as const;

/**
 * The system prompt for the `classify` step. The model is asked to
 * reason briefly about whether the user's latest message requires a
 * workspace tool, then emit exactly one of two sentinel words.
 * Anything else is rejected by the branch's `.check()` and the model
 * is retried with feedback (up to `max(2)` retries = 1 initial + 2
 * retries).
 *
 * Why the strict one-word format: a free-form answer ("I think this
 * needs tools because…") would require fuzzy parsing here and would
 * break the `when()` gates downstream. A small model handles the
 * restricted output reliably; the `.check()` enforces it.
 */
const CLASSIFY_SYSTEM = `Decide whether the user's latest message needs workspace tools (file editing, shell commands, git operations) or can be answered with text alone.

Answer with EXACTLY one word: "tools" or "direct".`;

// =============================================================================
// Internal shape definitions
// =============================================================================
//
// grandma-kat stores a prompt leaf's record as a flat object. Tool
// calls are stripped of their OpenAI nesting (`function.name`,
// `function.arguments`) and stored as `{ id, name, arguments }` so a
// single accessor reaches the name. Tool results are stored as
// `{ name, result, isError? }`. We re-shape these back to OpenAI's
// `tool_calls` nesting when we re-emit the assistant message in the
// next turn's history.

/** A tool call as grandma-kat stores it in `m.raw.prev[i].toolCalls`. */
interface KatToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A tool result as grandma-kat stores it in `m.raw.prev[i].toolResults`. */
interface KatToolResult {
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
interface KatPromptRecord {
  content: string;
  reasoning?: string | null;
  toolCalls?: KatToolCall[];
  toolResults?: KatToolResult[];
}

// =============================================================================
// Shape converters
// =============================================================================

/**
 * Convert grandma-kat's flat `KatToolCall` array back to OpenAI's
 * nested shape. We need this when re-emitting the assistant turn into
 * the conversation history, because the next LLM call expects the
 * nesting (`type: "function"` plus `function.name`/`function.arguments`).
 *
 * `arguments` stays a JSON STRING in both shapes — OpenAI's protocol
 * requires string args, not an object. Parsing happens at the
 * receiver (in `ToolRegistry.dispatch` via `JSON.parse(argsJson)`).
 */
function toOpenAiToolCalls(tcs: KatToolCall[]): ChatCompletionMessageToolCall[] {
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
function toToolResultString(tr: KatToolResult | undefined): string {
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
function readSystem(m: { system?: unknown }): string {
  return typeof m.system === "string" ? m.system : "";
}

/** Read the FULL conversation history from the root scope (no branch). */
function readMessages(m: { messages?: unknown }): ChatCompletionMessageParam[] {
  return Array.isArray(m.messages) ? (m.messages as ChatCompletionMessageParam[]) : [];
}

/** Capture the prompt's text from `m.prev[1]`. Used by the terminal
 *  branches' "final" memory to expose the assistant's reply as the
 *  branch's value (and thus the tree's exported result). */
function readPromptText(m: { prev: unknown[] }): string {
  return String(m.prev[1] ?? "");
}

/** Normalize the classify answer for the `when()` gate. Accepts case
 *  differences and trailing punctuation (some models append `.` or
 *  `!` to single-word replies). Returns null if the answer is
 *  unrecognised, which causes BOTH `when()` gates to be false — the
 *  classify `.check()` should have rejected that case upstream, but
 *  the null is a safety net. */
function readClassifyDecision(m: { branch: { classify?: unknown } }): "tools" | "direct" | null {
  const a = String(m.branch.classify ?? "").trim().toLowerCase().replace(/[.!?,]+$/g, "");
  return a === "tools" || a === "direct" ? a : null;
}

// =============================================================================
// History appenders (shared by direct and tools branches)
// =============================================================================

/** Build the OpenAI `tool` messages from a prompt's toolResults.
 *  `readMessages` returns a fresh array on each call so the caller can
 *  safely mutate the result. */
function buildAssistantAndToolMessages(
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

// =============================================================================
// Branch: classify
// =============================================================================
//
// Runs on the cheap model. The branch's exported value is the prompt's
// text (the model's reply), which the runner stores in
// `m.branch.classify` in the parent's scope — that's the slot the
// root tree's `when()` gates on.
//
//   Tree.name("classify")
//     .model("cheap")
//     .prompt(...)                       — asks "tools" or "direct"
//     .check(...)                        — retries with feedback if malformed
//
// Why this branch is NOT gated: the root tree always needs a
// classification before it can decide whether to run `direct` or
// `tools`. Gating `classify` would deadlock the tree.

const classifyBranch = Tree.name("classify")
  // Use the cheap model — the classification task is trivial (a few
  // hundred input tokens, one output token). Spending the strong
  // model here is pure waste.
  .model("cheap")

  // The prompt sees the FULL conversation history, not just the
  // latest user message. The classifier needs prior context to
  // disambiguate terse follow-ups like "do it" or "fix that" (which
  // "it"?). On the first turn, that's just [system + user]; on later
  // turns it grows.
  .prompt((m: { messages?: unknown }) => [
    { role: "system", content: CLASSIFY_SYSTEM },
    ...readMessages(m),
  ])

  // Validate the answer. If the model emits anything other than
  // exactly "tools" or "direct" (after case + punctuation
  // normalisation), the check fails with feedback and
  // `goback(1, max(2))` rewinds to the prompt and retries. Total
  // budget: 1 initial + 2 retries = 3 calls. Exhaustion throws
  // `KnitError` (the max()'s `errFn` becomes the thrown message);
  // the agent catches and surfaces "Something went wrong" to the
  // user. The `m.error` interpolation in `errFn` is the last
  // check-feedback string the model saw.
  .check(
    (m: { prev: unknown[] }) => {
      const a = String(m.prev[0] ?? "").trim().toLowerCase().replace(/[.!?,]+$/g, "");
      if (a === "tools" || a === "direct") return true;
      return 'Answer with EXACTLY one word: "tools" or "direct".';
    },
    goback(1, max(2, (m: { error?: unknown }) => `classify never answered validly: ${m.error}`)),
  );

// =============================================================================
// Branch: direct
// =============================================================================
//
// Runs on the cheap model when the classify step said "direct". Single
// LLM call, no tools, no loop. The branch exports the prompt's text
// (via the "final" memory); the agent's `runTurn` returns that text.
//
// Children, in order:
//   #0  prompt(...)                    — cheap LLM call (no tools)
//   #1  memoryUpdate("messages", …)    — append assistant to root history
//   #2  memory("final", m => m.prev[1])— capture the prompt's text
//
// The branch has no `until()`; after children run, the container
// exports with its last child's value (the text).

const directBranch = Tree.name("direct")
  // Cheap model: single call, no tool loop. The strong model isn't
  // needed for direct answers.
  .model("cheap")

  // Build the LLM payload: system prompt + the full conversation
  // history from the root. No tools — direct questions get text-only
  // answers.
  .prompt((m: { system?: unknown; messages?: unknown }) => [
    { role: "system", content: readSystem(m) },
    ...readMessages(m),
  ])

  // Append the new assistant turn to the ROOT's "messages" slot.
  // The runner walks the scope chain, finds the slot in the root
  // (it was injected by the agent), reads the current value, hands
  // it to the fn, and writes the new value back to the root.
  //
  // m.raw.prev[0] is the prompt's record (just ran above us); its
  // `content` is the model's text reply. The direct branch never has
  // tool_calls, so we only synthesise the assistant message.
  .memoryUpdate("messages", (m: { raw: { prev: KatPromptRecord[] } }, cur: unknown) => {
    const prev = Array.isArray(cur) ? (cur as ChatCompletionMessageParam[]) : readMessages(m as { messages?: unknown });
    const r = m.raw.prev[0];
    return [...prev, { role: "assistant", content: r?.content ?? "" }];
  })

  // Capture the prompt's text as the branch's value. At the time
  // "final" runs, m.prev = [memoryUpdate, prompt], so m.prev[1] is
  // the prompt's value (a string). The branch's exported value is
  // "final"'s value, which becomes the tree's `result`.
  .memory("final", readPromptText);

// =============================================================================
// Branch: tools
// =============================================================================
//
// Runs on the strong model when the classify step said "tools". The
// tool-using loop: prompt the model, execute any returned tool calls,
// append the exchange to the history, re-prompt with the updated
// history, repeat until the model stops calling tools (or until
// max(12) attempts).
//
// Children, in order:
//   #0  prompt(...)                       LLM call + tool execution
//   #1  memoryUpdate("messages", …)      append this turn's exchange
//   #2  memory("final", m => m.prev[1])   capture the prompt's text
//   --  until(no toolCalls, max(12))      container loop (not a child)
//
// Per-pass m.prev ordering (most-recent-first):
//   m.prev[0] = "final" memory's value      (text)
//   m.prev[1] = memoryUpdate's value       (the new messages array)
//   m.prev[2] = prompt's record             (content, toolCalls, toolResults)
//
// The until check at m.raw.prev[2] reads the PROMPT's record. Its
// `.toolCalls` is the array the model returned (empty if the model
// answered with text). Truthy toolCalls → loop; empty/undefined →
// exit and the branch's value (final text) flows up.

const toolsBranch = Tree.name("tools")
  // Strong model: where the 31B MoE earns its cost — reasoning about
  // which tool to call, formatting args, interpreting results,
  // deciding when to stop.
  .model("strong")

  // Advertise the six tools. Default is no tools; `.tools(...)` is
  // a whitelist. If we add nested branches that need different
  // tool subsets, they'd override per branch.
  .tools(...TOOL_NAMES)

  // Build the LLM payload. system + the full conversation history
  // from the root (which includes any prior tool exchanges — the
  // memoryUpdate below updates this same slot each pass).
  .prompt((m: { system?: unknown; messages?: unknown }) => [
    { role: "system", content: readSystem(m) },
    ...readMessages(m),
  ])

  // Append this turn's exchange to the ROOT's "messages" slot.
  // m.raw.prev[0] is the prompt's record — it ALWAYS reflects the
  // most recent LLM call (the runner updates m.prev before invoking
  // the next child). If the model returned tool_calls, we emit:
  //
  //   assistant { tool_calls: [...nested...] }
  //   tool      { tool_call_id, content: "<dispatch result>" }
  //   ... one tool message per call
  //
  // If no tool_calls, just one assistant message with the final
  // text. The `tool_calls: null` (vs omitting the field) follows
  // OpenAI's protocol: "assistant said nothing" vs "assistant only
  // called tools" are distinct states.
  //
  // The defensive `Array.isArray(cur) ? cur : readMessages(m)` is a
  // belt-and-braces: in theory the slot always exists (the agent
  // injects it), but if some future code path drops the injection
  // we'd otherwise `[...undefined, …]` throw.
  .memoryUpdate("messages", (m: { raw: { prev: KatPromptRecord[] }; messages?: unknown }, cur: unknown) => {
    const prev = Array.isArray(cur) ? (cur as ChatCompletionMessageParam[]) : readMessages(m);
    const r = m.raw.prev[0];
    return buildAssistantAndToolMessages(r, prev);
  })

  // Capture the prompt's text as the branch's value. Same trick as
  // the direct branch — m.prev[1] is the prompt's record.
  .memory("final", readPromptText)

  // The loop. The check fires AFTER all children have run; if it
  // returns truthy the container exports, if falsy the children
  // re-run from the top with a fresh `m.prev` array. We look at
  // m.raw.prev[2] (the prompt's record — see the per-pass ordering
  // comment above): truthy `toolCalls` means the model called tools,
  // so we loop and let the model see the tool results on the next
  // pass.
  //
  // Bound: max(12) = 1 initial run + 12 retries. Exhaustion throws
  // KnitError; the errFn message ("tool-iteration limit: …") surfaces
  // in `agent.runTurn`'s catch and shows up in Telegram as
  // "Something went wrong: tool-iteration limit: …". 12 is enough
  // for realistic agent tasks (most turns use 0–3 tool calls);
  // ping-pong on a tool error is typically a feedback-routing
  // issue, not a budget one.
  .until(
    (m: { raw: { prev: KatPromptRecord[] } }) => !m.raw.prev[2]?.toolCalls?.length,
    max(12, (m: { error?: unknown }) => `tool-iteration limit: ${m.error ?? "stuck"}`),
  );

// =============================================================================
// Root tree
// =============================================================================
//
// Three children: classify (always runs), then the two terminal
// branches, each gated on the classify decision. The root tree's
// exported value is whichever terminal branch ran last — both
// terminals end with `.memory("final", …)` which holds the prompt's
// text, so `result` is a string.
//
// The agent reads `memory.messages` for the full updated history
// (including any tool exchanges from this turn). The agent's
// `runTurn()` returns `result` as the user-visible reply.

export const agentPattern = Tree.name("agent")
  .branch(classifyBranch)
  .branch(
    // Direct gate: only fires when classify said "direct" (case- and
    // punctuation-normalised). If classify's answer is malformed
    // the check exhausts and KnitError throws before we reach here.
    when((m: { branch: { classify?: unknown } }) => readClassifyDecision(m) === "direct"),
    directBranch,
  )
  .branch(
    // Tools gate: only fires when classify said "tools". Mutually
    // exclusive with the direct branch — exactly one terminal fires.
    when((m: { branch: { classify?: unknown } }) => readClassifyDecision(m) === "tools"),
    toolsBranch,
  );

// Re-export the three grandma-kat markers so callers who want to
// compose or extend this pattern (e.g. add a "summarize" branch gated
// on long histories) can import them from a single place.
export { when, goback, max };
