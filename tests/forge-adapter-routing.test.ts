import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCiPort } from "../src/adapters/ci.js";
import { FORGE_CONFIG_RELATIVE_PATH } from "../src/adapters/forge.js";
import { createEnvironmentPort } from "../src/adapters/environment.js";
import { createTrackerPort } from "../src/adapters/tracker.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const TOKEN_ENV = "MATT_AUTO_TEST_FORGEJO_TOKEN";

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env[TOKEN_ENV];
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function forgejoRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "matt-auto-forge-routing-"));
  tempDirs.push(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync(
    "git",
    [
      "remote",
      "add",
      "origin",
      "http://localhost:3002/a5345534/matt-skills-ops.git",
    ],
    { cwd: root },
  );
  const configPath = path.join(root, FORGE_CONFIG_RELATIVE_PATH);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      provider: "forgejo",
      baseUrl: "http://localhost:3002",
      tokenEnv: TOKEN_ENV,
    }),
  );
  return root;
}

describe("forge-aware adapter routing", () => {
  it("routes tracker, authentication, and CI to configured Forgejo without gh", async () => {
    const root = await forgejoRoot();
    process.env[TOKEN_ENV] = "test-token";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/user") {
        return new Response(JSON.stringify({ login: "a5345534" }), { status: 200 });
      }
      if (url.pathname.endsWith("/branches/main")) {
        return new Response(
          JSON.stringify({ commit: { id: "a".repeat(40) } }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/actions/runs")) {
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);

    const tracker = createTrackerPort(root);
    await expect(tracker.getCanonicalRepositoryIdentity?.()).resolves.toEqual({
      owner: "a5345534",
      name: "matt-skills-ops",
      forge: { provider: "forgejo", baseUrl: "http://localhost:3002" },
    });

    const environment = createEnvironmentPort(root);
    await expect(environment.hasSupportedTrackerRemote()).resolves.toBe(true);
    await expect(environment.isTrackerAuthenticated()).resolves.toBe(true);

    await expect(createCiPort(root).checkStatus({ branchName: "main" })).resolves.toEqual({
      status: "success",
      summary: "No Forgejo Actions runs for main.",
    });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://localhost:3002/api/v1/user",
        "http://localhost:3002/api/v1/repos/a5345534/matt-skills-ops/branches/main",
      ]),
    );
  });
});
