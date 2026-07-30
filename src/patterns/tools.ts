// =============================================================================
// src/patterns/tools.ts
// =============================================================================
//
// Tools branch — runs on the strong model when the classify step said
// "tools". The tool-using loop: prompt the model, execute any returned
// tool calls, append the exchange to the history, re-prompt with the
// updated history, repeat until the model stops calling tools (or until
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
//
// =============================================================================

// @ts-ignore — grandma-kat ships no .d.ts files.
import { Tree, max } from "grandma-kat";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  readSystem,
  readMessages,
  readPromptText,
  buildAssistantAndToolMessages,
  type KatPromptRecord,
} from "./shared.js";

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

export const toolsBranch = Tree.name("tools")
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
