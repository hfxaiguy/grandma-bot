/**
 * Mock-LLM test of the agent pattern. Verifies the tree structure without
 * needing a live LLM endpoint:
 *
 *   1. Tree builds (no validation errors)
 *   2. Tool call → result → looped back to prompt (next LLM call sees the
 *      tool result in the message history)
 *   3. No tool calls → loop exits, result = final text
 *   4. The caller's `messages` array has been updated in place
 *
 * Run: npx tsx scripts/agent-mock-test.ts
 */
import assert from "node:assert/strict";
// @ts-ignore — grandma-kat ships no .d.ts files.
import grandma from "grandma-kat";
import { agentPattern } from "../src/patterns/agent.js";
import { ToolRegistry } from "../src/tools/index.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// Build a real ToolRegistry against a tmp dir; the write_file tool actually
// runs and we verify its side effect after the agent turn.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureRepo, git } from "../src/tools/git.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "grandma-mock-test-"));
await ensureRepo(ws);

const tools = new ToolRegistry(ws, ["git", "cat", "ls"]);
const system = "You are a test agent.";

// Scripted LLM: first call writes a file, second call returns the final text.
let callIndex = 0;
const calls: ChatCompletionMessageParam[][] = [];
const handler = async (
  messages: ChatCompletionMessageParam[],
  ctx: { tools?: { function: { name: string } }[] },
) => {
  console.log("[handler] call #", callIndex + 1, "tools passed:", ctx.tools?.length ?? 0);
  calls.push(messages.map((m) => ({ ...m })));
  callIndex++;
  if (callIndex === 1) {
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

const messages: ChatCompletionMessageParam[] = [
  { role: "user", content: "create mock.txt with 'mock content'" },
];

const { result, memory } = await grandma.knit(agentPattern, {
  models: { default: { model: "mock", handler } },
  tools: tools.toKatTools(),
  memory: { messages, system },
  logger: false,
});

console.log("result:", result);
console.log("calls made:", calls.length);
console.log("final history length:", (memory as { messages: ChatCompletionMessageParam[] }).messages.length);

// --- assertions ---

// 1. Two LLM calls (one with tool, one final).
assert.equal(calls.length, 2, `expected exactly 2 LLM calls, got ${calls.length}`);

// 2. First call: 2 messages (system + user).
assert.equal(calls[0].length, 2, "first call should have system + user only");
assert.equal(calls[0][0].role, "system");
assert.equal(calls[0][1].role, "user");

// 3. Second call: 4 messages (system + user + assistant(tool_call) + tool(result)).
const second = calls[1];
assert.equal(second.length, 4, `second call should have 4 messages, got ${second.length}`);
assert.equal(second[2].role, "assistant");
assert.ok(Array.isArray(second[2].tool_calls) && second[2].tool_calls.length === 1);
assert.equal(second[3].role, "tool");
assert.equal(second[3].tool_call_id, "call_1");
assert.ok(
  String(second[3].content).includes("wrote") || String(second[3].content).includes("mock content"),
  `tool result should mention the write: ${second[3].content}`,
);

// 4. The returned result is the final text.
assert.equal(result, "Done — wrote mock.txt.");

// 5. The pattern produced the full updated history in m.messages:
//    user + assistant(tool_call) + tool(result) + assistant(final) = 4.
const finalHistory = (memory as { messages: ChatCompletionMessageParam[] }).messages;
assert.equal(finalHistory.length, 4, `final history should have 4 messages, got ${finalHistory.length}`);
assert.equal(finalHistory[0].role, "user");
assert.equal(finalHistory[1].role, "assistant");
assert.ok(Array.isArray(finalHistory[1].tool_calls));
assert.equal(finalHistory[2].role, "tool");
assert.equal(finalHistory[3].role, "assistant");
assert.equal(finalHistory[3].content, "Done — wrote mock.txt.");

// 6. The file was actually written and committed.
const content = await fs.readFile(path.join(ws, "mock.txt"), "utf8");
assert.equal(content, "mock content\n");
const log = await git(ws, ["log", "--oneline"]);
assert.match(log, /agent\(write_file\): mock\.txt/, "auto-commit missing");

await fs.rm(ws, { recursive: true, force: true });
console.log("agent-mock-test: PASS — 2 LLM calls, tool executed, history threaded, final text returned");
