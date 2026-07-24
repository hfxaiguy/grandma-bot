import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ToolRegistry } from "./tools/index.js";

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

export class Agent {
  private client: OpenAI;
  private systemPrompt: string;

  constructor(private deps: AgentDeps) {
    this.client = new OpenAI({ baseURL: deps.baseURL, apiKey: deps.apiKey });
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
   */
  async runTurn(messages: ChatCompletionMessageParam[]): Promise<string> {
    const full: ChatCompletionMessageParam[] = [{ role: "system", content: this.systemPrompt }, ...messages];

    for (let i = 0; i < this.deps.maxToolIterations; i++) {
      const resp = await this.client.chat.completions.create({
        model: this.deps.model,
        messages: full,
        tools: this.deps.tools.definitions,
        tool_choice: "auto",
      });
      const msg = resp.choices[0]?.message;
      if (!msg) return "(no response from model)";

      full.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const answer = stripThought(msg.content ?? "") || "(empty response)";
        // persist assistant turn (final text only; per Gemma 4 guidance, no thoughts in history)
        messages.push({ role: "assistant", content: answer });
        return answer;
      }

      for (const call of msg.tool_calls) {
        if (call.type !== "function") continue;
        console.log(`[tool] ${call.function.name} ${call.function.arguments.slice(0, 200)}`);
        const result = await this.deps.tools.dispatch(call.function.name, call.function.arguments);
        full.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    return "(stopped: reached the tool-iteration limit)";
  }
}
