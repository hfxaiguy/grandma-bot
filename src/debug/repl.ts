import readline from "node:readline";
import path from "node:path";
import fs from "node:fs/promises";
import "dotenv/config";
import { config } from "../config.js";
import { ensureRepo, ensureWorkspaceGitignore } from "../tools/git.js";
import { ToolRegistry } from "../tools/index.js";
import { Agent, checkLlmEntry } from "../agent.js";
import { loadModels } from "../models.js";
import { EventLogger, type KatEvent } from "./event-logger.js";
import { formatEvent, formatAgentOutput } from "./format.js";

const CONV_KEY = "cli:repl";

/**
 * Minimal composite logger that fans out to multiple loggers.
 * Mirrors grandma-kat's CompositeLogger without depending on internals.
 */
class CompositeLogger {
  constructor(private loggers: { log(event: KatEvent): void; close?(): void }[]) {}

  log(event: KatEvent): void {
    for (const l of this.loggers) l.log(event);
  }
  close(): void {
    for (const l of this.loggers) l.close?.();
  }
  saveCheckpoint(): void {}
  getCheckpoint(): null {
    return null;
  }
  deleteCheckpoint(): void {}
  getEvents(): KatEvent[] {
    return [];
  }
}

/**
 * Create a grandma-kat-compatible logger. The `custom` logger receives
 * real-time events (for the TUI); the SQLite logger persists everything.
 */
function createDebugLogger(dbPath: string, custom: { log(event: KatEvent): void }) {
  // Dynamically import grandma-kat's logger factory if available.
  // Falls back to manual composite if the export isn't accessible.
  try {
    // @ts-ignore — grandma-kat ships no .d.ts files.
    const gk = require("grandma-kat");
    if (typeof gk.createLogger === "function") {
      // Pass custom as the opt; grandma-kat wraps it + adds ConsoleLogger.
      // But we also want SQLite. Use CompositeLogger to combine.
      return new CompositeLogger([custom, createSqliteLogger(dbPath)]);
    }
  } catch {
    // Fall through to manual approach.
  }

  return new CompositeLogger([custom, createSqliteLogger(dbPath)]);
}

/**
 * Minimal SQLite logger matching grandma-kat's schema.
 */
function createSqliteLogger(dbPath: string) {
  // Use node:sqlite if available (Node 22+), else better-sqlite3.
  try {
    const { DatabaseSync } = require("node:sqlite");
    fs.mkdir(path.dirname(dbPath), { recursive: true }).catch(() => {});
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        run_id TEXT NOT NULL,
        definition_id TEXT NOT NULL,
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        branch_path TEXT,
        iteration INTEGER,
        scope_id INTEGER,
        kind TEXT NOT NULL,
        content TEXT
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        resume_positions TEXT NOT NULL
      )`);
    const insert = db.prepare(
      "INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    return {
      log(event: KatEvent) {
        insert.run(
          event.run_id,
          event.definition_id,
          event.branch_path,
          event.iteration,
          event.scope_id ?? null,
          event.kind,
          JSON.stringify(event.content ?? null),
        );
      },
      close() {
        db.close();
      },
    };
  } catch {
    // If node:sqlite isn't available, try better-sqlite3.
    try {
      const Database = require("better-sqlite3");
      fs.mkdir(path.dirname(dbPath), { recursive: true }).catch(() => {});
      const db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS calls (
          run_id TEXT NOT NULL,
          definition_id TEXT NOT NULL,
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          branch_path TEXT,
          iteration INTEGER,
          scope_id INTEGER,
          kind TEXT NOT NULL,
          content TEXT
        );
        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          resume_positions TEXT NOT NULL
        )`);
      const insert = db.prepare(
        "INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      return {
        log(event: KatEvent) {
          insert.run(
            event.run_id,
            event.definition_id,
            event.branch_path,
            event.iteration,
            event.scope_id ?? null,
            event.kind,
            JSON.stringify(event.content ?? null),
          );
        },
        close() {
          db.close();
        },
      };
    } catch {
      // No SQLite available — return no-op logger.
      console.warn("[warn] no SQLite driver found — events won't be persisted");
      return { log() {}, close() {} };
    }
  }
}

async function main(): Promise<void> {
  const debugLevel = process.argv.includes("--debug") ? "debug" : "info";

  await fs.mkdir(config.workspaceDir, { recursive: true });
  await fs.mkdir(config.tmpDir, { recursive: true });
  await ensureRepo(config.workspaceDir);
  await fs.mkdir(path.join(config.workspaceDir, "logs"), { recursive: true });
  await ensureWorkspaceGitignore(config.workspaceDir, ["logs/grandma-kat.db*"]);

  const tools = new ToolRegistry(config.workspaceDir, config.allowedCommands);
  const models = await loadModels();

  // Set up loggers: EventLogger (real-time) + SQLite (persistence).
  const eventLogger = new EventLogger();
  const dbPath = path.join(config.workspaceDir, "logs/grandma-kat.db");
  const logger = createDebugLogger(dbPath, eventLogger);

  const agent = new Agent({
    models,
    workspace: config.workspaceDir,
    tools,
    logger,
    logLevel: debugLevel,
  });

  // Subscribe to events and print formatted output.
  eventLogger.on("event", (event: KatEvent) => {
    // Filter by level: debug shows everything, info shows a subset.
    if (debugLevel === "info") {
      const INFO_KINDS = new Set(["llm_call", "tool_call", "tool_result", "flow", "memory", "emit", "human"]);
      if (!INFO_KINDS.has(event.kind)) return;
    }
    const lines = formatEvent(event);
    for (const line of lines) {
      process.stderr.write(line + "\n");
    }
  });

  // Collect agent output from onEmit.
  let lastOutput = "";
  const onEmit = (value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text) lastOutput = text;
  };

  // Banner.
  process.stderr.write("\n");
  process.stderr.write(`\x1b[1mgrandma-bob debug REPL\x1b[0m\n`);
  process.stderr.write(`workspace : ${config.workspaceDir}\n`);
  process.stderr.write(`log level : ${debugLevel}\n`);
  for (const [name, m] of Object.entries(models)) {
    const reachable = await checkLlmEntry(m.baseURL, m.apiKey, m.protocol);
    const status = reachable ? "\x1b[32mreachable\x1b[0m" : "\x1b[31mNOT reachable\x1b[0m";
    process.stderr.write(`llm ${name.padEnd(6)} : ${m.model} @ ${m.baseURL} (${status})\n`);
  }
  process.stderr.write(`\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36m> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "/clear") {
      agent.clear(CONV_KEY);
      process.stderr.write("\x1b[33mconversation cleared\x1b[0m\n\n");
      rl.prompt();
      return;
    }

    if (input === "/quit" || input === "/exit") {
      rl.close();
      return;
    }

    lastOutput = "";
    try {
      await agent.run(CONV_KEY, input, onEmit);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\x1b[31merror: ${msg}\x1b[0m\n`);
      if (err instanceof Error && err.stack) {
        process.stderr.write(`\x1b[90m${err.stack.split("\n").slice(1, 4).join("\n")}\x1b[0m\n`);
      }
    }

    // Print agent output after the tree pauses.
    if (lastOutput) {
      const lines = formatAgentOutput(lastOutput);
      for (const line of lines) {
        process.stdout.write(line + "\n");
      }
    } else {
      process.stderr.write(`\x1b[90m(no output — check LLM reachability above)\x1b[0m\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    logger.close();
    process.stderr.write("\nbye\n");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
