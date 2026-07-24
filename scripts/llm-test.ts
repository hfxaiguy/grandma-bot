/**
 * Live end-to-end test of the agent against the configured LLM backend:
 * asks the model to create a file via tools and verifies the auto-commit.
 * Uses real .env credentials. Run: npx tsx scripts/llm-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { ToolRegistry } from "../src/tools/index.js";
import { Agent } from "../src/agent.js";
import { ensureRepo, git } from "../src/tools/git.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "grandma-llm-test-"));
await ensureRepo(ws);

const tools = new ToolRegistry(ws, config.allowedCommands);
const agent = new Agent({
  baseURL: config.llmBaseUrl,
  apiKey: config.llmApiKey,
  model: config.llmModel,
  workspace: ws,
  tools,
  maxToolIterations: 6,
});

console.log(`model: ${config.llmModel} @ ${config.llmBaseUrl}`);
const messages: Parameters<Agent["runTurn"]>[0] = [
  { role: "user", content: "Create a file called hello.txt containing exactly: hello from the agent. Then tell me when done." },
];
const answer = await agent.runTurn(messages);
console.log("agent says:", answer);

const content = await fs.readFile(path.join(ws, "hello.txt"), "utf8").catch(() => null);
assert.ok(content?.includes("hello from the agent"), `file content wrong: ${JSON.stringify(content)}`);
const log = await git(ws, ["log", "--oneline"]);
assert.match(log, /agent\(write_file\): hello\.txt/, "auto-commit missing");

await fs.rm(ws, { recursive: true, force: true });
console.log("llm-test: PASS — tool call executed, file written, git commit created");
