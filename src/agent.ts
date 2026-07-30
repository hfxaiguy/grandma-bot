import path from "node:path";
// @ts-ignore — grandma-kat ships no .d.ts files.
import grandma from "grandma-kat";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ToolRegistry } from "./tools/index.js";
import { agentPattern } from "./patterns/agent.js";

export interface AgentDeps {
  baseURL: string;
  apiKey: string;
  model: string;
  workspace: string;
  tools: ToolRegistry;
  maxToolIterations: number;
}

/**
 * Gemma 4 emits its reasoning as "<|channel>thought\n…<channel|>" before the final
 * answer (even with thinking disabled, as an empty block). Strip it from user-facing text.
 */
function stripThought(text: string): string {
  return text.replace(/<\|channel\|>thought\n[\s\S]*?<channel\|>/g, "").trim();
}

const LOG_DB = path.resolve(process.cwd(), "logs/grandma-kat.db");

export class Agent {
  private systemPrompt: string;

  constructor(private deps: AgentDeps) {
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
   * Run one conversational turn: appends to `messages` (which must not include
   * the system message) until the model produces a final text answer.
   *
   * The control flow is now a grandma-kat tree (`patterns/agent.ts`): the
   * runner handles prompt → tool execution → history append → loop, bounded
   * by `max(maxToolIterations)`. Every LLM call, tool call, and flow-control
   * decision is logged to `logs/grandma-kat.db`.
   */
  async runTurn(messages: ChatCompletionMessageParam[]): Promise<string> {
    const { result, memory } = await grandma.knit(agentPattern, {
      models: {
        default: { baseURL: this.deps.baseURL, apiKey: this.deps.apiKey, model: this.deps.model },
      },
      tools: this.deps.tools.toKatTools(),
      // Pass the live array reference; the pattern replaces it with a new
      // array each pass as it appends tool exchanges. We copy back below.
      memory: { messages, system: this.systemPrompt },
      logger: LOG_DB,
      logLevel: "info",
    });

    // Copy the updated history back onto the caller's array (same reference
    // the HistoryStore holds). Drop the `system` field — it lives only in
    // runtime memory, never in conversation history.
    const updated = (memory as { messages: ChatCompletionMessageParam[] }).messages;
    messages.length = 0;
    messages.push(...updated);

    const answer = stripThought(String(result ?? "")) || "(empty response)";
    return answer;
  }
}
