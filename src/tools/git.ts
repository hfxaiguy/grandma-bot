import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Make sure `dir` is a git repo with a usable (repo-local) committer identity. */
export async function ensureRepo(dir: string): Promise<void> {
  try {
    await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    await git(dir, ["init"]);
  }
  try {
    // succeeds if an identity exists (global or local)
    await git(dir, ["config", "user.name"]);
    await git(dir, ["config", "user.email"]);
  } catch {
    await git(dir, ["config", "user.name", "grandma-bot"]);
    await git(dir, ["config", "user.email", "grandma-bot@localhost"]);
  }
}

/**
 * Stage and commit the given workspace-relative paths.
 * Returns the short commit hash, "no-changes", or "failed" (never throws —
 * a broken repo must not break file tools).
 */
export async function autoCommit(dir: string, relPaths: string[], message: string): Promise<string> {
  try {
    await git(dir, ["add", "-A", "--", ...relPaths]);
    const status = await git(dir, ["status", "--porcelain", "--", ...relPaths]);
    if (!status.trim()) return "no-changes";
    await git(dir, ["commit", "-q", "-m", message, "--", ...relPaths]);
    const hash = (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
    return hash;
  } catch (err) {
    console.error("[git] auto-commit failed:", err);
    return "failed";
  }
}
