import path from "node:path";
// @ts-ignore — grandma-kat ships no .d.ts files.
import grandma from "grandma-kat";
import type { ToolRegistry } from "./tools/index.js";
import type { ModelRegistry } from "./models.js";
import { loadPattern } from "./pattern-loader.js";

export interface AgentDeps {
  /** Named LLM registry (e.g. { cheap, strong }) from models.json or env. */
  models: ModelRegistry;
  /**
   * Workspace directory. The grandma-kat SQLite log lives at
   * `<workspace>/logs/grandma-kat.db` — it contains user data
   * (prompts, responses, tool calls) so it stays next to the user's
   * files.
   */
  workspace: string;
  tools: ToolRegistry;
}

export interface AgentRunResult {
  /** "waiting" = tree paused at .human(), continuation stored. */
  status: "waiting";
  /** Continuation token (checkpoint ID). Store for next run. */
  continuation: string;
}

/**
 * Ping the LLM endpoint to check reachability. Returns true on any 2xx,
 * false on transport error or non-2xx. Used at startup so a missing
 * Ollama/llama-server is surfaced as a warning instead of a cryptic
 * first-message failure.
 *
 * For OpenAI-compat endpoints, pings `/models`. For native Ollama
 * (`protocol: "ollama"`), pings `/api/tags`.
 */
export async function checkLlmEntry(
  baseURL: string,
  apiKey: string,
  protocol?: string,
  timeoutMs = 3000,
): Promise<boolean> {
  const path = protocol === "ollama" ? "/api/tags" : "/models";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${baseURL.replace(/\/$/, "")}${path}`, {
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
  private logDb: string;
  private continuations = new Map<string, string>();

  constructor(private deps: AgentDeps) {
    this.logDb = path.resolve(deps.workspace, "logs/grandma-kat.db");
  }

  /**
   * Run one turn of a continuous conversation. The tree pauses at
   * `.human()` between messages; the continuation token persists the
   * full tree state (memory, history, scope chain) in the SQLite log.
   *
   * @param key         Conversation key (e.g. "chatId:threadId").
   * @param humanInput  The user's message text.
   * @param onEmit      Callback for non-blocking output (`.emit()` calls).
   * @returns           `{ status: "waiting", continuation }` — store the
   *                    continuation for the next run.
   */
  async run(
    key: string,
    humanInput: string | unknown[],
    onEmit?: (value: unknown) => void | Promise<void>,
  ): Promise<AgentRunResult> {
    const cont = this.continuations.get(key);
    const katTools = this.deps.tools.toKatTools();
    const pattern = await loadPattern(this.deps.workspace);

    const runtime: Record<string, unknown> = {
      models: this.deps.models,
      tools: katTools,
      logger: this.logDb,
      logLevel: "info",
      onEmit,
    };

    let outcome: { status?: string; continuation?: string };

    if (cont) {
      // Resume from checkpoint.
      outcome = await grandma.knit(pattern, {
        ...runtime,
        _continuation: cont,
        humanInput: { main_input: humanInput },
      });
    } else {
      // First run: inject system prompt and start the tree.
      // The tree pauses immediately at .human() — no LLM call yet.
      outcome = await grandma.knit(pattern, {
        ...runtime,
        memory: {
          messages: [],
          workspace: this.deps.workspace,
          main_input: humanInput,
        },
      });
    }

    if (outcome.status === "waiting" && outcome.continuation) {
      this.continuations.set(key, outcome.continuation);
      return { status: "waiting", continuation: outcome.continuation };
    }

    // Shouldn't happen with the agent pattern (it always pauses at .human()),
    // but handle gracefully.
    throw new Error("agent tree completed unexpectedly — should loop at .human()");
  }

  /**
   * Clear the continuation for a conversation. The next `run()` will
   * start a fresh tree. Used for `/clear` or error recovery.
   */
  clear(key: string): void {
    this.continuations.delete(key);
  }
}
