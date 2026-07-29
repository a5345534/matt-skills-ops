import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORGE_CONFIG_RELATIVE_PATH,
  parseGitRemoteUrl,
  resolveForge,
  resolveForgejoToken,
  type ForgejoConnection,
} from "../src/adapters/forge.js";
import {
  canonicalRepositoryIdentityKey,
  canonicalTargetIdentitiesEqual,
} from "../src/coordination.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryGitRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "matt-auto-forge-"));
  tempDirs.push(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  return root;
}

describe("parseGitRemoteUrl", () => {
  it("parses a Forgejo HTTP remote and preserves an instance subpath", () => {
    expect(
      parseGitRemoteUrl(
        "https://forge.example.test/forge/a5345534/matt-skills-ops.git",
      ),
    ).toEqual({
      host: "forge.example.test",
      inferredBaseUrl: "https://forge.example.test/forge",
      owner: "a5345534",
      name: "matt-skills-ops",
    });
  });

  it("parses SSH and scp-style remotes without inventing an API URL", () => {
    expect(
      parseGitRemoteUrl("ssh://git@localhost:2222/a5345534/matt-skills-ops.git"),
    ).toEqual({
      host: "localhost",
      owner: "a5345534",
      name: "matt-skills-ops",
    });
    expect(
      parseGitRemoteUrl("git@forge.local:a5345534/matt-skills-ops.git"),
    ).toEqual({
      host: "forge.local",
      owner: "a5345534",
      name: "matt-skills-ops",
    });
  });
});

describe("resolveForge", () => {
  it("keeps a GitHub origin on the legacy provider path", async () => {
    const root = await temporaryGitRoot();
    await execFileAsync("git", [
      "remote",
      "add",
      "origin",
      "https://github.com/a5345534/matt-skills-ops.git",
    ], { cwd: root });

    await expect(resolveForge(root)).resolves.toEqual({ provider: "github" });
  });

  it("selects Forgejo only through an explicit root configuration", async () => {
    const root = await temporaryGitRoot();
    await execFileAsync("git", [
      "remote",
      "add",
      "origin",
      "http://localhost:3002/a5345534/matt-skills-ops.git",
    ], { cwd: root });
    const configPath = path.join(root, FORGE_CONFIG_RELATIVE_PATH);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        provider: "forgejo",
        baseUrl: "http://localhost:3002/",
        tokenFile: ".pi/matt-auto/forgejo.token",
      }),
    );

    await expect(resolveForge(root)).resolves.toEqual({
      provider: "forgejo",
      connection: {
        provider: "forgejo",
        baseUrl: "http://localhost:3002",
        owner: "a5345534",
        name: "matt-skills-ops",
        remoteName: "origin",
        tokenEnv: "MATT_AUTO_FORGEJO_TOKEN",
        tokenFile: path.join(root, ".pi", "matt-auto", "forgejo.token"),
      },
    });
  });

  it("rejects a Forgejo config whose repository does not match its remote", async () => {
    const root = await temporaryGitRoot();
    await execFileAsync("git", [
      "remote",
      "add",
      "origin",
      "http://localhost:3002/a5345534/matt-skills-ops.git",
    ], { cwd: root });
    const configPath = path.join(root, FORGE_CONFIG_RELATIVE_PATH);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        provider: "forgejo",
        baseUrl: "http://localhost:3002",
        owner: "other-owner",
      }),
    );

    await expect(resolveForge(root)).resolves.toMatchObject({
      provider: "unsupported",
      reason: expect.stringMatching(/does not match/i),
    });
  });
});

describe("resolveForgejoToken", () => {
  const connection: ForgejoConnection = {
    provider: "forgejo",
    baseUrl: "http://localhost:3002",
    owner: "a5345534",
    name: "matt-skills-ops",
    remoteName: "origin",
    tokenEnv: "MATT_AUTO_FORGEJO_TOKEN",
  };

  it("prefers an explicit environment token over a token file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "matt-auto-forge-token-"));
    tempDirs.push(root);
    const tokenFile = path.join(root, "token");
    await writeFile(tokenFile, "from-file\n", { mode: 0o600 });

    await expect(
      resolveForgejoToken(
        { ...connection, tokenFile },
        { MATT_AUTO_FORGEJO_TOKEN: "from-environment" },
      ),
    ).resolves.toBe("from-environment");
  });
});

describe("forge-aware canonical identity", () => {
  it("keeps legacy GitHub keys stable while separating the same owner/name on Forgejo", () => {
    const github = { owner: "a5345534", name: "matt-skills-ops" };
    const forgejo = {
      ...github,
      forge: { provider: "forgejo" as const, baseUrl: "http://localhost:3002" },
    };
    expect(canonicalRepositoryIdentityKey(github)).toBe(
      "a5345534/matt-skills-ops",
    );
    expect(canonicalRepositoryIdentityKey(forgejo)).toBe(
      "forgejo:http://localhost:3002/a5345534/matt-skills-ops",
    );
    expect(
      canonicalTargetIdentitiesEqual(
        { repository: github, targetRef: "refs/heads/main" },
        { repository: forgejo, targetRef: "refs/heads/main" },
      ),
    ).toBe(false);
  });
});
