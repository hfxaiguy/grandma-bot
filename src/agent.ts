import path from "node:path";
// @ts-ignore — grandma-kat ships no .d.ts files.
import grandma from "grandma-kat";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ToolRegistry } from "./tools/index.js";
import type { ModelRegistry } from "./models.js";
import { agentPattern } from "./patterns/agent.js";

export interface AgentDeps {
  /** Named LLM registry (e.g. { cheap, strong }) from models.json or env. */
  models: ModelRegistry;
  /**
   * Workspace directory. The grandma-kat SQLite log lives at
   * `<workspace>/logs/grandma-kat.db` (with WAL/SHM siblings) — it
   * contains user data (prompts, responses, tool calls) so it stays
   * next to the user's files. The directory is created and added to
   * the workspace's `.gitignore` at startup by `index.ts`.
   */
  workspace: string;
  tools: ToolRegistry;
}

/**
 * Gemma 4 emits its reasoning as "<|channel>thought\n…<channel|>" before the final
 * answer (even with thinking disabled, as an empty block). Strip it from user-facing text.
 */
function stripThought(text: string): string {
  return text.replace(/<\|channel\|>thought\n[\s\S]*?<channel\|>/g, "").trim();
}

/**
 * Ping the LLM endpoint's OpenAI-compatible /models route. Returns true on
 * any 2xx, false on transport error or non-2xx. Used at startup so a missing
 * Ollama/llama-server is surfaced as a warning instead of a cryptic first-
 * message failure.
 *
 * `entry` is a single { baseURL, apiKey } slice of the registry.
 */
export async function checkLlmEntry(
  baseURL: string,
  apiKey: string,
  timeoutMs = 3000,
): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      signal: ctrl.signal,
      headers: apiKey && apiKey !== "no-key" ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export class Agent {
  private systemPrompt: string;
  private logDb: string;

  constructor(private deps: AgentDeps) {
    // SQLite log lives inside the workspace, not the project root — it
    // contains user prompts/responses and should travel with the user's
    // data when they back up the workspace. Caller (index.ts) is
    // responsible for creating the directory and updating .gitignore.
    this.logDb = path.resolve(deps.workspace, "logs/grandma-kat.db");
    this.systemPrompt = [
      "You are grandma-bot, a personal coding/assistant agent running locally on the user's machine, chatting via Telegram.",
      `You operate inside the workspace directory: ${deps.workspace}. All file tools are sandboxed to it.`,
      "The workspace is a git repository. Every change made with write_file/edit_file/delete_file is committed automatically — tell the user the commit hash when relevant. Never attempt destructive git operations.",
      "Use tools when the user asks you to create, inspect, modify or organize files, or to run commands. Answer directly when no tools are needed.",
      "Replies are plain text in a Telegram chat: keep them concise, no heavy markdown. When you changed files, summarize briefly what changed.",
      "Voice messages are transcribed locally by Whisper; transcription may contain small errors — interpret generously.",
      "The user can also send photos; analyze them directly when they arrive.",
      `Current date: ${new Date().toISOString().slice(0, 10)}.`,
    ].join("\n");
  }

  /**
   * Run one conversational turn: appends to `messages` (which must not
   * include the system message) until the model produces a final text
   * answer.
   *
   * The control flow is a grandma-kat tree (`patterns/agent.ts`): a
   * cheap model classifies the latest user message as "direct" or
   * "tools"; the former is answered by the cheap model, the latter
   * runs the full tool-using loop on the strong model. The tree's
   * `result` is the final assistant text; `memory.messages` is the
   * updated history. Every LLM call, tool call, and flow-control
   * decision is logged to `<workspace>/logs/grandma-kat.db`.
   */
  async runTurn(messages: ChatCompletionMessageParam[]): Promise<string> {
    const { result, memory } = await grandma.knit(agentPattern, {
      models: this.deps.models,
      tools: this.deps.tools.toKatTools(),
      memory: { messages, system: this.systemPrompt },
      logger: this.logDb,
      logLevel: "info",
    });

    // Copy the updated history back onto the caller's array (same
    // reference the HistoryStore holds). `memory.messages` is the root
    // scope's "messages" slot, which the pattern's memoryUpdate calls
    // wrote to across all until() passes.
    const updated = (memory as { messages?: ChatCompletionMessageParam[] }).messages ?? messages;
    messages.length = 0;
    messages.push(...updated);

    return stripThought(String(result ?? "")) || "(empty response)";
  }
}
