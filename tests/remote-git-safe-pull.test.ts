import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { safePullBranchAtRoot } from "../src/adapters/remote-git.js";

const execFileAsync = promisify(execFile);

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.file.allow",
      GIT_CONFIG_VALUE_0: "always",
    },
  });
}

describe("safePullBranchAtRoot", () => {
  it("FF-pulls when clean and on target branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "matt-pull-"));
    const bare = path.join(root, "remote.git");
    const work = path.join(root, "work");
    await mkdir(bare, { recursive: true });
    await git(bare, ["init", "--bare", "-b", "main"]);

    await mkdir(work, { recursive: true });
    await git(work, ["init", "-b", "main"]);
    await writeFile(path.join(work, "a.txt"), "v1\n");
    await git(work, ["add", "a.txt"]);
    await git(work, ["commit", "-m", "v1"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-u", "origin", "main"]);

    // Advance remote via a second clone.
    const other = path.join(root, "other");
    await git(root, ["clone", bare, other]);
    await writeFile(path.join(other, "b.txt"), "v2\n");
    await git(other, ["add", "b.txt"]);
    await git(other, ["commit", "-m", "v2"]);
    await git(other, ["push", "origin", "main"]);

    const result = await safePullBranchAtRoot(work, "main");
    expect(result).toMatchObject({ ok: true, pulled: true, branch: "main" });
    const headMsg = (await git(work, ["log", "-1", "--oneline"])).stdout;
    expect(headMsg).toContain("v2");
  }, 30_000);

  it("skips when working tree is dirty", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "matt-pull-dirty-"));
    const bare = path.join(root, "remote.git");
    const work = path.join(root, "work");
    await mkdir(bare, { recursive: true });
    await git(bare, ["init", "--bare", "-b", "main"]);
    await mkdir(work, { recursive: true });
    await git(work, ["init", "-b", "main"]);
    await writeFile(path.join(work, "a.txt"), "v1\n");
    await git(work, ["add", "a.txt"]);
    await git(work, ["commit", "-m", "v1"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-u", "origin", "main"]);
    await writeFile(path.join(work, "a.txt"), "dirty\n");

    const result = await safePullBranchAtRoot(work, "main");
    expect(result).toMatchObject({
      ok: true,
      pulled: false,
      skipped: true,
    });
    if (result.ok && !result.pulled) {
      expect(result.reason).toMatch(/dirty/i);
    }
  }, 30_000);

  it("skips when HEAD is not on the target branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "matt-pull-branch-"));
    const work = path.join(root, "work");
    await mkdir(work, { recursive: true });
    await git(work, ["init", "-b", "main"]);
    await writeFile(path.join(work, "a.txt"), "v1\n");
    await git(work, ["add", "a.txt"]);
    await git(work, ["commit", "-m", "v1"]);
    await git(work, ["checkout", "-b", "feature"]);

    const result = await safePullBranchAtRoot(work, "main");
    expect(result).toMatchObject({
      ok: true,
      pulled: false,
      skipped: true,
    });
    if (result.ok && !result.pulled) {
      expect(result.reason).toMatch(/HEAD is on/);
    }
  }, 30_000);
});
