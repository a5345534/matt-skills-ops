import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ensureSubmoduleGitlinksPublished,
  gitlinkPublishRef,
  listGitlinksAtHead,
  parseGithubRepo,
  remoteHasCommit,
  verifySubmoduleGitlinksReachable,
} from "../src/adapters/submodule-gate.js";

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
      // Allow file:// remotes in temp fixtures (git 2.38+ defaults to deny).
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.file.allow",
      GIT_CONFIG_VALUE_0: "always",
    },
  });
}

async function initBare(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "--bare", "-b", "main"]);
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
}

describe("parseGithubRepo", () => {
  it("parses https and ssh GitHub remotes", () => {
    expect(
      parseGithubRepo("https://github.com/a5345534/aos-core.git"),
    ).toEqual({ owner: "a5345534", name: "aos-core" });
    expect(parseGithubRepo("https://github.com/a5345534/aos-core")).toEqual({
      owner: "a5345534",
      name: "aos-core",
    });
    expect(parseGithubRepo("git@github.com:a5345534/aos-core.git")).toEqual({
      owner: "a5345534",
      name: "aos-core",
    });
  });

  it("returns undefined for non-GitHub remotes", () => {
    expect(parseGithubRepo("https://gitlab.com/acme/repo.git")).toBeUndefined();
  });
});

describe("gitlinkPublishRef", () => {
  it("builds a stable matt-auto/gitlink ref from the SHA", () => {
    expect(gitlinkPublishRef("88f2fc5da6d700e8aa80f141ea4288a7613d55e6")).toBe(
      "refs/heads/matt-auto/gitlink/88f2fc5da6d7",
    );
  });
});

describe("ensureSubmoduleGitlinksPublished", () => {
  it("pushes a local-only submodule commit then verifies remote reachability", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "matt-submod-"));
    const bareChild = path.join(root, "child.git");
    const childWork = path.join(root, "child-work");
    const parent = path.join(root, "parent");

    await initBare(bareChild);
    await initRepo(childWork);
    await writeFile(path.join(childWork, "README.md"), "child v1\n");
    await git(childWork, ["add", "README.md"]);
    await git(childWork, ["commit", "-m", "child base"]);
    await git(childWork, ["remote", "add", "origin", bareChild]);
    await git(childWork, ["push", "-u", "origin", "main"]);
    const baseSha = (await git(childWork, ["rev-parse", "HEAD"])).stdout.trim();

    // Parent needs an initial commit before `submodule add` (unborn branch fails).
    await initRepo(parent);
    await writeFile(path.join(parent, "ROOT.md"), "parent\n");
    await git(parent, ["add", "ROOT.md"]);
    await git(parent, ["commit", "-m", "parent root"]);
    await git(parent, ["submodule", "add", bareChild, "child"]);
    await git(parent, ["commit", "-m", "add child submodule"]);

    // New local-only commit inside submodule (not pushed yet).
    await writeFile(path.join(parent, "child", "feature.txt"), "local only\n");
    await git(path.join(parent, "child"), ["add", "feature.txt"]);
    await git(path.join(parent, "child"), ["commit", "-m", "local feature"]);
    const localSha = (
      await git(path.join(parent, "child"), ["rev-parse", "HEAD"])
    ).stdout.trim();
    expect(localSha).not.toBe(baseSha);

    // Point parent gitlink at the local-only SHA.
    await git(parent, ["add", "child"]);
    await git(parent, ["commit", "-m", "bump child gitlink"]);

    const links = await listGitlinksAtHead(parent);
    expect(links).toEqual([{ path: "child", sha: localSha }]);

    // Gate alone fails before publish.
    const before = await verifySubmoduleGitlinksReachable(parent);
    expect(before.ok).toBe(false);

    // Ensure publishes then verifies.
    const ensured = await ensureSubmoduleGitlinksPublished(parent);
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) return;
    expect(ensured.published).toHaveLength(1);
    expect(ensured.published[0]?.sha).toBe(localSha);
    expect(ensured.published[0]?.ref).toBe(gitlinkPublishRef(localSha));
    expect(ensured.checked).toEqual([{ path: "child", sha: localSha }]);

    // Remote now has the commit via the publish ref.
    expect(await remoteHasCommit(bareChild, localSha, parent)).toBe(true);
    const after = await verifySubmoduleGitlinksReachable(parent);
    expect(after.ok).toBe(true);

    // Second call is a no-op publish.
    const again = await ensureSubmoduleGitlinksPublished(parent);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.published).toEqual([]);
  }, 30_000);

  it("fails closed when the submodule commit is not available locally either", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "matt-submod-miss-"));
    const bareChild = path.join(root, "child.git");
    const parent = path.join(root, "parent");
    const ghostSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    await initBare(bareChild);
    // Seed bare so clone/submodule add works.
    const seed = path.join(root, "seed");
    await initRepo(seed);
    await writeFile(path.join(seed, "README.md"), "seed\n");
    await git(seed, ["add", "README.md"]);
    await git(seed, ["commit", "-m", "seed"]);
    await git(seed, ["remote", "add", "origin", bareChild]);
    await git(seed, ["push", "-u", "origin", "main"]);

    await initRepo(parent);
    await writeFile(path.join(parent, "ROOT.md"), "parent\n");
    await git(parent, ["add", "ROOT.md"]);
    await git(parent, ["commit", "-m", "parent root"]);
    await git(parent, ["submodule", "add", bareChild, "child"]);
    await git(parent, ["commit", "-m", "add child"]);

    // Force parent tree to a ghost SHA via update-index (object not present).
    // Use a real second commit we never put in parent/child checkout.
    const orphan = path.join(root, "orphan");
    await initRepo(orphan);
    await writeFile(path.join(orphan, "x.txt"), "orphan\n");
    await git(orphan, ["add", "x.txt"]);
    await git(orphan, ["commit", "-m", "orphan"]);
    const orphanSha = (await git(orphan, ["rev-parse", "HEAD"])).stdout.trim();

    // Point gitlink at orphanSha without having the object in parent/child.
    await git(parent, [
      "update-index",
      "--cacheinfo",
      `160000,${orphanSha},child`,
    ]);
    await git(parent, ["commit", "-m", "ghost gitlink"]);

    // Remove child checkout objects path so localHasCommit fails.
    await execFileAsync("rm", ["-rf", path.join(parent, "child")]);
    await mkdir(path.join(parent, "child"), { recursive: true });

    const ensured = await ensureSubmoduleGitlinksPublished(parent);
    expect(ensured.ok).toBe(false);
    if (ensured.ok) return;
    expect(ensured.reason).toMatch(/does not contain commit|missing/i);
    expect(ensured.sha).toBe(orphanSha);
    // silence unused
    expect(ghostSha.length).toBe(40);
  }, 30_000);
});
