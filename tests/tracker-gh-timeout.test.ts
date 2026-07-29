import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __trackerRunTestables } from "../src/adapters/tracker.js";
import { DEFAULT_TRACKER_GH_TIMEOUT_MS } from "../src/constants.js";

const tempDirs: string[] = [];

afterEach(() => {
  tempDirs.length = 0;
});

describe("tracker gh exec timeout", () => {
  it("exports a positive default tracker gh timeout", () => {
    expect(DEFAULT_TRACKER_GH_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(__trackerRunTestables.timeoutMs).toBe(DEFAULT_TRACKER_GH_TIMEOUT_MS);
  });

  it("returns a timeout failure when gh exceeds the budget", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "matt-auto-gh-timeout-"));
    tempDirs.push(dir);
    const fakeGh = path.join(dir, "gh");
    await writeFile(fakeGh, "#!/usr/bin/env bash\nsleep 30\nexit 0\n", "utf8");
    await chmod(fakeGh, 0o755);

    // Point PATH at the hang shim; run() invokes the command name as given.
    const prevPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${prevPath ?? ""}`;
    try {
      const started = Date.now();
      const result = await __trackerRunTestables.run(
        dir,
        "gh",
        ["issue", "list"],
        200,
      );
      const elapsed = Date.now() - started;
      expect(result.code).toBe(124);
      expect(result.stderr).toMatch(/timed out after 200ms/i);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      process.env.PATH = prevPath;
    }
  }, 10_000);
});
