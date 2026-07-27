import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createEnvironmentPort,
  detectDefaultBranchName,
} from "../src/adapters/environment.js";

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

describe("detectDefaultBranchName", () => {
  it("reads origin/HEAD when set (master)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "matt-def-"));
    const bare = path.join(root, "remote.git");
    const work = path.join(root, "work");
    await mkdir(bare, { recursive: true });
    await git(bare, ["init", "--bare", "-b", "master"]);
    await mkdir(work, { recursive: true });
    await git(work, ["init", "-b", "master"]);
    await writeFile(path.join(work, "a.txt"), "v1\n");
    await git(work, ["add", "a.txt"]);
    await git(work, ["commit", "-m", "v1"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-u", "origin", "master"]);
    // Ensure origin/HEAD points at master
    await git(work, ["remote", "set-head", "origin", "master"]);

    await expect(detectDefaultBranchName(work)).resolves.toBe("master");
    const env = createEnvironmentPort(work);
    await expect(env.detectDefaultBranch()).resolves.toBe("master");
  }, 30_000);

  it("falls back to a common local branch when origin/HEAD is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "matt-def-local-"));
    await mkdir(root, { recursive: true });
    await git(root, ["init", "-b", "master"]);
    await writeFile(path.join(root, "a.txt"), "v1\n");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-m", "v1"]);

    await expect(detectDefaultBranchName(root)).resolves.toBe("master");
  }, 30_000);
});
