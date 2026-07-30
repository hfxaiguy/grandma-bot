// =============================================================================
// src/patterns/direct.ts
// =============================================================================
//
// Direct branch — runs on the cheap model when the classify step said
// "direct". Single LLM call, no tools, no loop. The branch exports the
// prompt's text (via the "final" memory); the agent's `runTurn` returns
// that text.
//
// Children, in order:
//   #0  prompt(...)                    — cheap LLM call (no tools)
//   #1  memoryUpdate("messages", …)    — append assistant to root history
//   #2  memory("final", m => m.prev[1])— capture the prompt's text
//
// The branch has no `until()`; after children run, the container
// exports with its last child's value (the text).
//
// =============================================================================

// @ts-ignore — grandma-kat ships no .d.ts files.
import { Tree } from "grandma-kat";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { readSystem, readMessages, readPromptText, type KatPromptRecord } from "./shared.js";

export const directBranch = Tree.name("direct")
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
