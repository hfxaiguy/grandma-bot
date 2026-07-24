import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`FATAL: missing required env var ${name} (see .env.example)`);
    process.exit(1);
  }
  return v.trim();
}

const root = process.cwd();

const DEFAULT_COMMANDS = [
  "ls", "cat", "head", "tail", "wc", "find", "rg", "grep", "pwd",
  "git", "mkdir", "touch", "date", "file", "stat", "du", "df",
  "diff", "which", "echo", "sort", "uniq",
];

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  allowedUserIds: new Set(
    required("ALLOWED_USER_IDS")
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  ),
  workspaceDir: path.resolve(root, process.env.WORKSPACE_DIR ?? "workspace"),
  tmpDir: path.resolve(root, "tmp"),
  llmBaseUrl: (process.env.LLM_BASE_URL ?? "http://127.0.0.1:8080/v1").replace(/\/$/, ""),
  llmApiKey: process.env.LLM_API_KEY ?? "local",
  llmModel: process.env.LLM_MODEL ?? "local",
  whisperUrl: (process.env.WHISPER_URL ?? "http://127.0.0.1:8178").replace(/\/$/, ""),
  allowedCommands: (process.env.ALLOWED_COMMANDS ?? DEFAULT_COMMANDS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  maxToolIterations: 12,
  historyLimit: 60,
};

export type Config = typeof config;
