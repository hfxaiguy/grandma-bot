// Agent pattern — a grandma-kat tree that mirrors the previous
// open-ended tool-calling loop in `agent.ts`:
//
//   1. Call the LLM with the full message history + system prompt.
//   2. If the model returned tool_calls, the runner executes them once and
//      stores the results in the prompt's record (`m.raw.prev[N].toolResults`).
//      We append the assistant message + tool results to `m.messages`.
//   3. Loop until the last LLM call had no tool calls (final answer), bounded
//      by `max(12)` to match the previous `maxToolIterations`.
//
// Per-pass child order:
//   #0  prompt(...)                                  — LLM call + tool execution
//   #1  memoryUpdate("messages", ...)               — append this turn's exchange
//   #2  memory("final", m => m.prev[1])             — capture the prompt's text
//
// At the until check, `m.raw.prev[0]` is the prompt's record from this pass
// (its `.toolCalls` tells us whether to loop). After the until exits, the
// tree's exported value is `m.prev[0]` = the "final" memory write = the
// prompt's text content.
//
// Memory note: `messages` is threaded by the caller. We pass the live array
// reference in via `memory: { messages }`; on each pass the memoryUpdate
// replaces it with a new array containing the prior value plus this turn's
// exchange. The caller copies the final array back onto its own history.
//
// @ts-ignore — grandma-kat ships no .d.ts files.
import { Tree, when, goback, max } from "grandma-kat";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";

const TOOL_NAMES = [
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "run_command",
] as const;

// m.raw.prev[i].toolCalls as grandma-kat stores them: { id, name, arguments }.
interface KatToolCall {
  id: string;
  name: string;
  arguments: string;
}
interface KatToolResult {
  name: string;
  result: unknown;
  isError?: boolean;
}
interface KatPromptRecord {
  content: string;
  toolCalls?: KatToolCall[];
  toolResults?: KatToolResult[];
}

function toOpenAiToolCalls(tcs: KatToolCall[]): ChatCompletionMessageToolCall[] {
  return tcs.map((tc) => ({
    id: tc.id,
    type: "function",
    function: { name: tc.name, arguments: tc.arguments },
  }));
}

function toToolResultString(tr: KatToolResult | undefined): string {
  if (tr === undefined) return "";
  return typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result ?? "");
}

export const agentPattern = Tree.name("agent")
  .model("default")
  .tools(...TOOL_NAMES)
  .prompt((m: { system?: unknown; messages?: unknown }) => {
    const system = typeof m.system === "string" ? m.system : "";
    const history = Array.isArray(m.messages) ? (m.messages as ChatCompletionMessageParam[]) : [];
    return [{ role: "system", content: system }, ...history];
  })
  .memoryUpdate("messages", (m: { raw: { prev: KatPromptRecord[] } }, cur: unknown) => {
    const prev = Array.isArray(cur) ? (cur as ChatCompletionMessageParam[]) : [];
    // m.raw.prev[0] at this point is the prompt's record (just ran above us).
    const r = m.raw.prev[0];
    if (r?.toolCalls?.length) {
      const assistant: ChatCompletionAssistantMessageParam = {
        role: "assistant",
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
    // No tool calls — final assistant text for this turn.
    return [...prev, { role: "assistant", content: r?.content ?? "" }];
  })
  .memory("final", (m: { prev: unknown[] }) => m.prev[1] as string)
  .until(
    (m: { raw: { prev: KatPromptRecord[] } }) => !m.raw.prev[2]?.toolCalls?.length,
    max(12, (m: { error?: unknown }) => `tool-iteration limit: ${m.error ?? "stuck"}`),
  );

// Re-export markers so callers can compose or extend the pattern.
export { when, goback, max };
