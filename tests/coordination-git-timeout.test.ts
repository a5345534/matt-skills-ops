import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __coordinationGitTestables } from "../src/adapters/coordination.js";
import { DEFAULT_COORDINATION_GIT_TIMEOUT_MS } from "../src/constants.js";

const tempDirs: string[] = [];

afterEach(async () => {
  // Best-effort cleanup; tests never rely on leftover PATH shims.
  tempDirs.length = 0;
});

describe("coordination runGit timeout", () => {
  it("exports a positive default coordination Git timeout", () => {
    expect(DEFAULT_COORDINATION_GIT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("returns a timeout failure when git remote I/O exceeds the budget", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "matt-auto-git-timeout-"));
    tempDirs.push(dir);
    const fakeGit = path.join(dir, "git");
    // Hang longer than the test timeout so Node's execFile timeout fires.
    await writeFile(
      fakeGit,
      `#!/usr/bin/env bash\nsleep 30\nexit 0\n`,
      "utf8",
    );
    await chmod(fakeGit, 0o755);

    const env = {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
    };

    const started = Date.now();
    const result = await __coordinationGitTestables.runGit(
      dir,
      ["ls-remote", "--refs", "origin", "refs/heads/main"],
      env,
      200,
    );
    const elapsed = Date.now() - started;

    expect(result.code).toBe(124);
    expect(result.stderr).toMatch(/timed out after 200ms/i);
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);
});
