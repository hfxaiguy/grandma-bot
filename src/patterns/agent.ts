// Agent pattern — a grandma-kat tree that picks one of two paths per turn
// based on a cheap-model classification of the user's latest message:
//
//   1. "classify" branch (cheap model) — reads the full conversation history,
//      answers ONE word: "tools" or "direct". Value lands in m.branch.classify.
//   2. If "direct": "direct" branch (cheap model) — answer without tools.
//   3. If "tools":  "tools"  branch (strong model) — full tool-using loop:
//      prompt → memoryUpdate(msgs) → memory(msgs_out) → until(no toolCalls, max(12)).
//
// Each branch owns a LOCAL "msgs" slot seeded from the root's m.messages,
// and exports the final messages array (root.slots["direct"|"tools"]). The
// agent extracts the last assistant message's content as the user-visible
// text and copies the array back onto the caller's history.
//
// Why local "msgs" instead of memoryUpdate("messages", ...): the runner's
// record() writes the memoryUpdate's return value to the local scope, so
// when a NESTED memoryUpdate targets an ancestor slot (the root's
// "messages"), the local scope accumulates a divergent copy after pass 1
// and the walker's pass-2 lookup hits the local. Owning the slot in the
// branch avoids the shadow entirely.
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

const CLASSIFY_SYSTEM = `Decide whether the user's latest message needs workspace tools (file editing, shell commands, git operations) or can be answered with text alone.

Answer with EXACTLY one word: "tools" or "direct".`;

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

function readSystem(m: { system?: unknown }): string {
  return typeof m.system === "string" ? m.system : "";
}

function readRootMessages(m: { messages?: unknown }): ChatCompletionMessageParam[] {
  return Array.isArray(m.messages) ? (m.messages as ChatCompletionMessageParam[]) : [];
}

function readLocalMsgs(m: { branch: { msgs?: unknown } }): ChatCompletionMessageParam[] {
  return Array.isArray(m.branch.msgs) ? (m.branch.msgs as ChatCompletionMessageParam[]) : [];
}

/** Normalize the classify answer for the when() gate (case + trailing punctuation). */
function readClassifyDecision(m: { branch: { classify?: unknown } }): "tools" | "direct" | null {
  const a = String(m.branch.classify ?? "").trim().toLowerCase().replace(/[.!?,]+$/g, "");
  return a === "tools" || a === "direct" ? a : null;
}

const classifyBranch = Tree.name("classify")
  .model("cheap")
  .prompt((m: { messages?: unknown }) => [
    { role: "system", content: CLASSIFY_SYSTEM },
    ...readRootMessages(m),
  ])
  .check(
    (m: { prev: unknown[] }) => {
      const a = String(m.prev[0] ?? "").trim().toLowerCase().replace(/[.!?,]+$/g, "");
      if (a === "tools" || a === "direct") return true;
      return 'Answer with EXACTLY one word: "tools" or "direct".';
    },
    goback(1, max(2, (m: { error?: unknown }) => `classify never answered validly: ${m.error}`)),
  );

const directBranch = Tree.name("direct")
  .model("cheap")
  .memory("msgs", (m: { messages?: unknown }, cur: unknown) =>
    Array.isArray(cur) ? cur : readRootMessages(m),
  )
  .prompt((m: { system?: unknown }) => [
    { role: "system", content: readSystem(m) },
    ...readLocalMsgs(m as { branch: { msgs?: unknown } }),
  ])
  .memoryUpdate("msgs", (m: { raw: { prev: KatPromptRecord[] }; branch: { msgs?: unknown } }, cur: unknown) => {
    const prev = Array.isArray(cur) ? (cur as ChatCompletionMessageParam[]) : readLocalMsgs(m);
    const r = m.raw.prev[0];
    return [...prev, { role: "assistant", content: r?.content ?? "" }];
  })
  .memory("msgs_out", (m: { branch: { msgs?: unknown } }) => readLocalMsgs(m));

const toolsBranch = Tree.name("tools")
  .model("strong")
  .tools(...TOOL_NAMES)
  .memory("msgs", (m: { messages?: unknown }, cur: unknown) =>
    Array.isArray(cur) ? cur : readRootMessages(m),
  )
  .prompt((m: { system?: unknown }) => [
    { role: "system", content: readSystem(m) },
    ...readLocalMsgs(m as { branch: { msgs?: unknown } }),
  ])
  .memoryUpdate("msgs", (m: { raw: { prev: KatPromptRecord[] }; branch: { msgs?: unknown } }, cur: unknown) => {
    const prev = Array.isArray(cur) ? (cur as ChatCompletionMessageParam[]) : readLocalMsgs(m);
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
    return [...prev, { role: "assistant", content: r?.content ?? "" }];
  })
  .memory("msgs_out", (m: { branch: { msgs?: unknown } }) => readLocalMsgs(m))
  .until(
    (m: { raw: { prev: KatPromptRecord[] } }) => !m.raw.prev[2]?.toolCalls?.length,
    max(12, (m: { error?: unknown }) => `tool-iteration limit: ${m.error ?? "stuck"}`),
  );

export const agentPattern = Tree.name("agent")
  .branch(classifyBranch)
  .branch(
    when((m: { branch: { classify?: unknown } }) => readClassifyDecision(m) === "direct"),
    directBranch,
  )
  .branch(
    when((m: { branch: { classify?: unknown } }) => readClassifyDecision(m) === "tools"),
    toolsBranch,
  );

/** Walk the runner's messages array (root.slots["direct"|"tools"]) to the
 *  final assistant text. Returns "" if no assistant message found. */
export function extractFinalText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatCompletionMessageParam;
    if (m?.role === "assistant" && typeof m.content === "string") return m.content;
  }
  return "";
}

// Re-export markers so callers can compose or extend the pattern.
export { when, goback, max };
