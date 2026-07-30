/**
 * Mock-LLM test of the agent pattern. Verifies the tree structure without
 * needing a live LLM endpoint. Exercises both paths of the routing tree:
 *
 *   1. The "tools" path: classify -> "tools" -> strong model writes a file
 *      and returns the final text. Asserts the tool call, the result in
 *      history, and the auto-commit on disk.
 *   2. The "direct" path: classify -> "direct" -> cheap model answers
 *      without tools. Asserts no tool calls and no history mutations.
 *
 * Each call receives a `model` field on the ctx (the entry name from
 * models.json), so the script can branch the response on which model is
 * being called.
 *
 * Run: npx tsx scripts/agent-mock-test.ts
 */
import assert from "node:assert/strict";
// @ts-ignore — grandma-kat ships no .d.ts files.
import grandma from "grandma-kat";
import { agentPattern } from "../src/patterns/agent.js";
import { ToolRegistry } from "../src/tools/index.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureRepo, git } from "../src/tools/git.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "grandma-mock-test-"));
await ensureRepo(ws);

const tools = new ToolRegistry(ws, ["git", "cat", "ls"]);
const system = "You are a test agent.";

// Each model entry has its own call counter; the handler dispatches on
// the `model` field (which grandma-kat passes as the entry's .model name,
// i.e. "cheap" or "strong"). This lets the test verify per-model routing.
type Ctx = { tools?: { function: { name: string } }[]; model: string };
const calls: { model: string; messages: ChatCompletionMessageParam[] }[] = [];

const handler = async (messages: ChatCompletionMessageParam[], ctx: Ctx) => {
  calls.push({ model: ctx.model, messages: messages.map((m) => ({ ...m })) });
  if (ctx.model === "cheap") {
    // Cheap handles BOTH classify and direct. The classify step asks for
    // "tools" or "direct" via a focused system prompt; the direct branch
    // asks the full system-prompted question. Distinguish by the system
    // prompt's first sentence, then look at the user's intent to pick
    // a classification.
    const systemText =
      typeof messages[0]?.content === "string" ? messages[0].content : "";
    if (systemText.startsWith("Decide whether")) {
      // Classify step: "create mock.txt..." -> "tools"; otherwise "direct".
      const userText = typeof messages[1]?.content === "string" ? messages[1].content : "";
      return {
        content: /create|file|write|edit|delete|run/i.test(userText) ? "tools" : "direct",
        reasoning: null,
        tool_calls: [],
      };
    }
    return { content: "Direct answer from cheap model.", reasoning: null, tool_calls: [] };
  }
  // Strong model: first call writes a file, second call returns the final text.
  const strongCallsForThisRun = calls.filter((c) => c.model === "strong").length;
  if (strongCallsForThisRun === 1) {
    return {
      content: "",
      reasoning: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "mock.txt", content: "mock content\n" }),
          },
        },
      ],
    };
  }
  return { content: "Done — wrote mock.txt.", reasoning: null, tool_calls: [] };
};

// ── Subtest 1: tools path ────────────────────────────────────────────────
{
  const messages: ChatCompletionMessageParam[] = [
    { role: "user", content: "create mock.txt with 'mock content'" },
  ];
  calls.length = 0;
  const { result, memory } = await grandma.knit(agentPattern, {
    models: {
      cheap: { model: "cheap", handler },
      strong: { model: "strong", handler },
    },
    tools: tools.toKatTools(),
    memory: { messages, system },
    logger: false,
  });

  console.log("--- tools path ---");
  console.log("calls:", calls.map((c) => `${c.model}(${c.messages.length}m)`).join(", "));

  // 1 classify (cheap) + 1 strong(tool_call) + 1 strong(final) = 3 calls.
  const cheapCalls = calls.filter((c) => c.model === "cheap");
  const strongCalls = calls.filter((c) => c.model === "strong");
  assert.equal(cheapCalls.length, 1, "expected 1 cheap call (classify)");
  assert.equal(strongCalls.length, 2, `expected 2 strong calls (tool + final), got ${strongCalls.length}`);

  // The classify call gets the system + user (2 messages, no tool schemas).
  assert.equal(cheapCalls[0].messages.length, 2);
  assert.ok(
    String(cheapCalls[0].messages[0].content).startsWith("Decide whether"),
    "first cheap call should use the classify system prompt",
  );

  // The first strong call sees the FULL main system prompt (not the
  // classify one) plus the 1-message history. It then returns a tool call.
  const firstStrong = strongCalls[0];
  assert.ok(
    String(firstStrong.messages[0].content).includes("test agent"),
    "strong calls should use the main system prompt",
  );
  assert.equal(firstStrong.messages.length, 2, "first strong call: system + 1 user msg");

  // The second strong call sees the assistant(tool_call) + tool(result) added.
  assert.equal(strongCalls[1].messages.length, 4);
  assert.equal(strongCalls[1].messages[2].role, "assistant");
  assert.ok(Array.isArray(strongCalls[1].messages[2].tool_calls));
  assert.equal(strongCalls[1].messages[3].role, "tool");
  assert.equal(strongCalls[1].messages[3].tool_call_id, "call_1");

  // The result is the updated messages array from the tools branch;
  // extract the last assistant text for the assertion.
  const resultHistory = result as ChatCompletionMessageParam[];
  assert.ok(Array.isArray(resultHistory), "result should be the messages array");
  assert.equal(resultHistory.length, 4);
  const lastAssistant = resultHistory[resultHistory.length - 1];
  assert.equal(lastAssistant.role, "assistant");
  assert.equal(lastAssistant.content, "Done — wrote mock.txt.");

  // The user's history got the full exchange appended.
  const finalHistory = (memory as { direct?: unknown; tools?: unknown }).tools;
  assert.ok(Array.isArray(finalHistory), "tools branch should export an array");
  const hist = finalHistory as ChatCompletionMessageParam[];
  assert.equal(hist.length, 4, `expected 4 history messages, got ${hist.length}`);

  // Side effect: file written + auto-committed.
  const content = await fs.readFile(path.join(ws, "mock.txt"), "utf8");
  assert.equal(content, "mock content\n");
  const log = await git(ws, ["log", "--oneline"]);
  assert.match(log, /agent\(write_file\): mock\.txt/, "auto-commit missing");
}

// ── Subtest 2: direct path ───────────────────────────────────────────────
{
  // Reset repo so we can verify the direct path doesn't touch the workspace.
  await fs.rm(ws, { recursive: true, force: true });
  await fs.mkdir(ws, { recursive: true });
  await ensureRepo(ws);

  const messages: ChatCompletionMessageParam[] = [
    { role: "user", content: "what's the capital of France?" },
  ];
  calls.length = 0;
  const { result, memory } = await grandma.knit(agentPattern, {
    models: {
      cheap: { model: "cheap", handler },
      strong: { model: "strong", handler },
    },
    tools: tools.toKatTools(),
    memory: { messages, system },
    logger: false,
  });

  console.log("--- direct path ---");
  console.log("calls:", calls.map((c) => `${c.model}(${c.messages.length}m)`).join(", "));

  const cheapCalls = calls.filter((c) => c.model === "cheap");
  const strongCalls = calls.filter((c) => c.model === "strong");
  assert.equal(cheapCalls.length, 2, "expected 2 cheap calls (classify + direct)");
  assert.equal(strongCalls.length, 0, "strong model must not be called on the direct path");

  // Result is the messages array; extract the last assistant text.
  const resultHistory = result as ChatCompletionMessageParam[];
  assert.ok(Array.isArray(resultHistory), "result should be the messages array");
  assert.equal(resultHistory.length, 2);
  assert.equal(resultHistory[1].role, "assistant");
  assert.equal(resultHistory[1].content, "Direct answer from cheap model.");
}

await fs.rm(ws, { recursive: true, force: true });
console.log("agent-mock-test: PASS — both paths (tools/direct) route to the right model");
