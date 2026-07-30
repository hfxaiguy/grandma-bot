import type OpenAI from "openai";
import { FileTools } from "./files.js";
import { ShellTools } from "./shell.js";

type Json = Record<string, unknown>;

export class ToolRegistry {
  private files: FileTools;
  private shell: ShellTools;

  constructor(workspace: string, allowedCommands: string[]) {
    this.files = new FileTools(workspace);
    this.shell = new ShellTools(workspace, allowedCommands);
  }

  readonly definitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories in the workspace. Directories end with '/'.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative directory path, default '.'" },
            recursive: { type: "boolean", description: "Recurse into subdirectories (default true)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file's full contents (truncated if huge). Directories are listed instead.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative file path" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Create or fully overwrite a file (creates parent dirs). The change is git-committed automatically.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative file path" },
            content: { type: "string", description: "Full new file content" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Replace an exact string in a file. Fails if old_string is not found or occurs multiple times (unless replace_all). The change is git-committed automatically.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_string: { type: "string", description: "Exact text to replace (must match literally)" },
            new_string: { type: "string" },
            replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_file",
        description: "Delete a file (or empty directory). The change is git-committed automatically.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run an allowlisted command in the workspace (no shell, so no pipes/redirection). " +
          "git is allowed except destructive/remote subcommands. File changes are NOT auto-committed by this tool — prefer the file tools.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Base command name, e.g. 'git'" },
            args: { type: "array", items: { type: "string" }, description: "Arguments, e.g. ['status', '--short']" },
          },
          required: ["command"],
        },
      },
    },
  ];

  /** Execute a tool call; always returns a string (errors included) so the agent can recover. */
  async dispatch(name: string, argsJson: string): Promise<string> {
    let args: Json;
    try {
      args = JSON.parse(argsJson || "{}") as Json;
    } catch {
      return `error: invalid JSON arguments for ${name}`;
    }
    try {
      switch (name) {
        case "list_files":
          return await this.files.listFiles(
            (args.path as string) ?? ".",
            (args.recursive as boolean) ?? true,
          );
        case "read_file":
          return await this.files.readFile(String(args.path ?? ""));
        case "write_file":
          return await this.files.writeFile(String(args.path ?? ""), String(args.content ?? ""));
        case "edit_file":
          return await this.files.editFile(
            String(args.path ?? ""),
            String(args.old_string ?? ""),
            String(args.new_string ?? ""),
            (args.replace_all as boolean) ?? false,
          );
        case "delete_file":
          return await this.files.deleteFile(String(args.path ?? ""));
        case "run_command":
          return await this.shell.runCommand(
            String(args.command ?? ""),
            Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [],
          );
        default:
          return `error: unknown tool ${name}`;
      }
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Build a grandma-kat tool registry from the OpenAI schemas above.
   * `execute(args)` calls `dispatch(name, JSON.stringify(args))` so error
   * handling is identical to the OpenAI tool-call path. Errors that start with
   * "error" are detected by the runner and surface in m.raw.prev[0].toolResults
   * with isError=true.
   */
  toKatTools(): Record<
    string,
    {
      description: string;
      parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
      execute: (args: Json) => Promise<string>;
    }
  > {
    const out: Record<
      string,
      {
        description: string;
        parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
        execute: (args: Json) => Promise<string>;
      }
    > = {};
    for (const d of this.definitions) {
      if (d.type !== "function") continue;
      const fn = d.function;
      const name = fn.name;
      out[name] = {
        description: fn.description ?? "",
        parameters: (fn.parameters ?? { type: "object" }) as {
          type: "object";
          properties?: Record<string, unknown>;
          required?: string[];
        },
        execute: async (args: Json) => this.dispatch(name, JSON.stringify(args ?? {})),
      };
    }
    return out;
  }
}
