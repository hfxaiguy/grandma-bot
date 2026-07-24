/**
 * Offline smoke test: file tools, git auto-commit, sandboxing, shell allowlist.
 * No Telegram token or LLM required. Run: npm run smoke
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileTools } from "../src/tools/files.js";
import { ShellTools } from "../src/tools/shell.js";
import { ensureRepo, git } from "../src/tools/git.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "grandma-smoke-"));
await ensureRepo(ws);
const files = new FileTools(ws);
const shell = new ShellTools(ws, ["ls", "git", "echo"]);

// write_file creates parent dirs and auto-commits
await files.writeFile("notes/hello.txt", "hello world");
let log = await git(ws, ["log", "--oneline"]);
assert.match(log, /agent\(write_file\): notes\/hello\.txt/, "write_file should auto-commit");

// read_file
assert.equal(await files.readFile("notes/hello.txt"), "hello world");

// edit_file + auto-commit, tree stays clean
await files.editFile("notes/hello.txt", "world", "grandma");
assert.equal(await files.readFile("notes/hello.txt"), "hello grandma");
log = await git(ws, ["log", "--oneline"]);
assert.match(log, /agent\(edit_file\): notes\/hello\.txt/, "edit_file should auto-commit");
assert.equal((await git(ws, ["status", "--porcelain"])).trim(), "", "working tree must be clean after auto-commit");

// list_files
const listing = await files.listFiles(".");
assert.match(listing, /notes\//);
assert.match(listing, /notes\/hello\.txt/);

// edit_file errors: missing string, ambiguous string
await assert.rejects(() => files.editFile("notes/hello.txt", "zzz", "x"), /not found/);
await files.writeFile("dup.txt", "a a a");
await assert.rejects(() => files.editFile("dup.txt", "a", "b"), /occurs 3 times/);
await files.editFile("dup.txt", "a", "b", true);
assert.equal(await files.readFile("dup.txt"), "b b b");

// sandbox escapes are rejected
await assert.rejects(() => files.writeFile("../escape.txt", "nope"), /escapes workspace/);
await assert.rejects(() => files.readFile("/etc/passwd"), /escapes workspace/);

// delete_file + auto-commit
await files.deleteFile("dup.txt");
log = await git(ws, ["log", "--oneline"]);
assert.match(log, /agent\(delete_file\): dup\.txt/, "delete_file should auto-commit");

// run_command: allowlist + git deny list
const out = await shell.runCommand("echo", ["hi"]);
assert.match(out, /hi/);
await assert.rejects(() => shell.runCommand("bash", ["-c", "echo nope"]), /not allowed/);
await assert.rejects(() => shell.runCommand("git", ["push", "origin", "main"]), /not allowed/);
const gs = await shell.runCommand("git", ["status", "--short"]);
assert.match(gs, /exit 0/);

await fs.rm(ws, { recursive: true, force: true });
console.log("smoke: all checks passed");
