import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { ensureRepo, ensureWorkspaceGitignore } from "./tools/git.js";
import { ToolRegistry } from "./tools/index.js";
import { Agent, checkLlmEntry } from "./agent.js";
import { loadModels } from "./models.js";
import { createBot } from "./bot.js";
import { checkStt } from "./stt.js";
import { startAdmin } from "./admin.js";

async function main(): Promise<void> {
  await fs.mkdir(config.workspaceDir, { recursive: true });
  await fs.mkdir(config.tmpDir, { recursive: true });
  await ensureRepo(config.workspaceDir);
  // The grandma-kat SQLite log lives under the workspace, not the project
  // root — it contains user prompts/responses. Create the dir up front and
  // exclude it from the workspace's git history.
  await fs.mkdir(path.join(config.workspaceDir, "logs"), { recursive: true });
  await ensureWorkspaceGitignore(config.workspaceDir, ["logs/grandma-kat.db*"]);

  const tools = new ToolRegistry(config.workspaceDir, config.allowedCommands, config.exaApiKey);
  const models = await loadModels();
  const agent = new Agent({ models, workspace: config.workspaceDir, tools });

  const modelReachable = await Promise.all(
    Object.entries(models).map(async ([name, m]) => [name, await checkLlmEntry(m.baseURL, m.apiKey, m.protocol)] as const),
  );
  for (const [name, ok] of modelReachable) {
    if (!ok) {
      console.warn(
        `[warn] LLM "${name}" (${models[name].model} @ ${models[name].baseURL}) not reachable.`,
      );
    }
  }

  const sttUrl = config.sttBackend === "sherpa" ? config.sherpaUrl : config.whisperUrl;
  const sttOk = await checkStt(config.sttBackend, config.whisperUrl, config.sherpaUrl);
  if (!sttOk) {
    console.warn(
      `[warn] ${config.sttBackend}-server not reachable at ${sttUrl} — voice messages will fail.`,
    );
  }

  // Start admin UI (web interface for credentials, status, logs, patterns, files).
  const adminPort = parseInt(process.env.ADMIN_PORT || "8080", 10);
  startAdmin({ port: adminPort });

  const bot = createBot({
    token: config.telegramToken,
    allowedUserIds: config.allowedUserIds,
    workspace: config.workspaceDir,
    tmpDir: config.tmpDir,
    sttBackend: config.sttBackend,
    whisperUrl: config.whisperUrl,
    sherpaUrl: config.sherpaUrl,
    sttLanguage: config.sttLanguage,
    models,
    agent,
  });

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());

  await bot.start({
    onStart: (me) => {
      console.log(`grandma-bot up as @${me.username}`);
      console.log(`workspace : ${config.workspaceDir} (git auto-commit on)`);
      for (const [name, m] of Object.entries(models)) {
        const reachable = modelReachable.find(([n]) => n === name)?.[1];
        console.log(`llm ${name.padEnd(6)} : ${m.model} @ ${m.baseURL} ${reachable ? "(reachable)" : "(NOT reachable)"}`);
      }
      console.log(`stt       : ${config.sttBackend} @ ${sttUrl} ${sttOk ? "(reachable)" : "(NOT reachable)"}`);
      console.log(`users     : ${[...config.allowedUserIds].join(", ")}`);
    },
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
