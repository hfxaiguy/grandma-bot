import fs from "node:fs/promises";
import { config } from "./config.js";
import { ensureRepo } from "./tools/git.js";
import { ToolRegistry } from "./tools/index.js";
import { Agent } from "./agent.js";
import { HistoryStore } from "./history.js";
import { createBot } from "./bot.js";
import { checkWhisper } from "./stt.js";

async function main(): Promise<void> {
  await fs.mkdir(config.workspaceDir, { recursive: true });
  await fs.mkdir(config.tmpDir, { recursive: true });
  await ensureRepo(config.workspaceDir);

  const tools = new ToolRegistry(config.workspaceDir, config.allowedCommands);
  const agent = new Agent({
    baseURL: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    workspace: config.workspaceDir,
    tools,
    maxToolIterations: config.maxToolIterations,
  });
  const history = new HistoryStore(config.historyLimit);

  const whisperOk = await checkWhisper(config.whisperUrl);
  if (!whisperOk) {
    console.warn(
      `[warn] whisper-server not reachable at ${config.whisperUrl} — voice messages will fail.\n` +
        `       start it with: npm run whisper:up`,
    );
  }

  const bot = createBot({
    token: config.telegramToken,
    allowedUserIds: config.allowedUserIds,
    workspace: config.workspaceDir,
    tmpDir: config.tmpDir,
    whisperUrl: config.whisperUrl,
    whisperLanguage: config.whisperLanguage,
    llmBaseUrl: config.llmBaseUrl,
    llmModel: config.llmModel,
    agent,
    history,
  });

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());

  await bot.start({
    onStart: (me) => {
      console.log(`grandma-bot up as @${me.username}`);
      console.log(`workspace : ${config.workspaceDir} (git auto-commit on)`);
      console.log(`llm       : ${config.llmModel} @ ${config.llmBaseUrl}`);
      console.log(`whisper   : ${config.whisperUrl} ${whisperOk ? "(reachable)" : "(NOT reachable)"}`);
      console.log(`users     : ${[...config.allowedUserIds].join(", ")}`);
    },
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
