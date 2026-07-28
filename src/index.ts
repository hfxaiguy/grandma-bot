import fs from "node:fs/promises";
import { config } from "./config.js";
import { ensureRepo } from "./tools/git.js";
import { ToolRegistry } from "./tools/index.js";
import { Agent } from "./agent.js";
import { HistoryStore } from "./history.js";
import { createBot } from "./bot.js";
import { checkStt } from "./stt.js";

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

  const sttUrl = config.sttBackend === "sherpa" ? config.sherpaUrl : config.whisperUrl;
  const sttOk = await checkStt(config.sttBackend, config.whisperUrl, config.sherpaUrl);
  if (!sttOk) {
    console.warn(
      `[warn] ${config.sttBackend}-server not reachable at ${sttUrl} — voice messages will fail.`,
    );
  }

  const bot = createBot({
    token: config.telegramToken,
    allowedUserIds: config.allowedUserIds,
    workspace: config.workspaceDir,
    tmpDir: config.tmpDir,
    sttBackend: config.sttBackend,
    whisperUrl: config.whisperUrl,
    sherpaUrl: config.sherpaUrl,
    sttLanguage: config.sttLanguage,
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
      console.log(`stt       : ${config.sttBackend} @ ${sttUrl} ${sttOk ? "(reachable)" : "(NOT reachable)"}`);
      console.log(`users     : ${[...config.allowedUserIds].join(", ")}`);
    },
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
