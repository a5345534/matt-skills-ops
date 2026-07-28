/**
 * Post-merge hygiene for dual-root Matt Auto delivery (issue #31).
 *
 * - Delete remote matt-auto/gitlink/<sha> only when the tip is an ancestor of
 *   the submodule default branch (content already on mainline).
 * - Prune stale local worktrees and delete local matt-auto/<id>/integration-merge
 *   branches when present.
 *
 * Soft by design: never throws for "nothing to do"; callers soft-fail GC errors.
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { detectDefaultBranchName } from "./environment.js";
import {
  listGitlinksAtHead,
  resolveSubmoduleRemoteUrl,
} from "./submodule-gate.js";

const execFileAsync = promisify(execFile);

export type GitlinkGcResult = {
  deletedRemoteRefs: readonly string[];
  keptRemoteRefs: readonly string[];
  deletedLocalBranches: readonly string[];
  worktreePruned: boolean;
  errors: readonly string[];
};

async function run(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
    };
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function exitDetail(
  result: { code: number; stdout: string; stderr: string },
): string {
  return result.stderr || result.stdout || `exit ${result.code}`;
}

/** Parse git ls-remote lines into { sha, branch } for matt-auto/gitlink heads. */
export function parseLsRemoteGitlinkLines(
  stdout: string,
): Array<{ sha: string; branch: string }> {
  const out: Array<{ sha: string; branch: string }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split(/\s+/);
    if (!sha || !ref) continue;
    const m = /^refs\/heads\/(matt-auto\/gitlink\/[0-9a-f]+)$/i.exec(ref);
    if (!m?.[1]) continue;
    out.push({ sha, branch: m[1] });
  }
  return out;
}

/** True when sha is an ancestor of mainlineRef in repoDir. */
export async function isAncestorOf(
  repoDir: string,
  sha: string,
  mainlineRef: string,
): Promise<boolean> {
  const result = await run(repoDir, "git", [
    "merge-base",
    "--is-ancestor",
    sha,
    mainlineRef,
  ]);
  return result.code === 0;
}

/**
 * Delete remote gitlink branches when already on mainline.
 */
export async function gcGitlinkBranchesOnRemote(input: {
  repoDir: string;
  remoteUrl: string;
  defaultBranch: string;
}): Promise<{
  deleted: string[];
  kept: string[];
  errors: string[];
}> {
  const deleted: string[] = [];
  const kept: string[] = [];
  const errors: string[] = [];
  const { repoDir, remoteUrl, defaultBranch } = input;

  const listed = await run(repoDir, "git", [
    "ls-remote",
    "--heads",
    remoteUrl,
    "refs/heads/matt-auto/gitlink/*",
  ]);
  if (listed.code !== 0) {
    errors.push("ls-remote gitlink refs failed: " + exitDetail(listed));
    return { deleted, kept, errors };
  }

  const refs = parseLsRemoteGitlinkLines(listed.stdout);
  if (refs.length === 0) return { deleted, kept, errors };

  const mirrorRef = "refs/matt-auto-gc/" + defaultBranch;
  const fetchMain = await run(repoDir, "git", [
    "fetch",
    remoteUrl,
    "+refs/heads/" + defaultBranch + ":" + mirrorRef,
  ]);

  let mainlineRef = mirrorRef;
  if (fetchMain.code !== 0) {
    const originRef = "refs/remotes/origin/" + defaultBranch;
    const hasOrigin = await run(repoDir, "git", [
      "rev-parse",
      "--verify",
      "--quiet",
      originRef,
    ]);
    if (hasOrigin.code !== 0) {
      errors.push(
        "fetch " +
          defaultBranch +
          " for ancestry check failed: " +
          exitDetail(fetchMain),
      );
      return { deleted, kept, errors };
    }
    mainlineRef = originRef;
  }

  const mainOk = await run(repoDir, "git", [
    "rev-parse",
    "--verify",
    "--quiet",
    mainlineRef,
  ]);
  if (mainOk.code !== 0) {
    errors.push("Cannot resolve mainline ref " + mainlineRef + " for gitlink GC.");
    return { deleted, kept, errors };
  }

  for (const { sha, branch } of refs) {
    const has = await run(repoDir, "git", ["cat-file", "-t", sha]);
    if (has.code !== 0 || has.stdout.trim() !== "commit") {
      await run(repoDir, "git", ["fetch", remoteUrl, sha]);
    }

    const ancestor = await isAncestorOf(repoDir, sha, mainlineRef);
    if (!ancestor) {
      kept.push(branch);
      continue;
    }

    const del = await run(repoDir, "git", [
      "push",
      remoteUrl,
      "--delete",
      branch,
    ]);
    if (del.code === 0) {
      deleted.push(branch);
      continue;
    }
    const detail = (del.stderr || del.stdout || "").toLowerCase();
    if (
      detail.includes("remote ref does not exist") ||
      detail.includes("not found") ||
      detail.includes("does not exist")
    ) {
      deleted.push(branch);
    } else {
      errors.push("delete " + branch + " failed: " + exitDetail(del));
      kept.push(branch);
    }
  }

  return { deleted, kept, errors };
}

/** Local hygiene: worktree prune + delete matt-auto/<id>/integration-merge. */
export async function pruneLocalMattAutoArtifacts(
  workflowRoot: string,
): Promise<{
  deletedLocalBranches: string[];
  worktreePruned: boolean;
  errors: string[];
}> {
  const deletedLocalBranches: string[] = [];
  const errors: string[] = [];

  const prune = await run(workflowRoot, "git", ["worktree", "prune"]);
  const worktreePruned = prune.code === 0;
  if (!worktreePruned) {
    errors.push("git worktree prune failed: " + exitDetail(prune));
  }

  const branches = await run(workflowRoot, "git", [
    "branch",
    "--list",
    "matt-auto/*",
  ]);
  if (branches.code === 0) {
    for (const line of branches.stdout.split("\n")) {
      const name = line.replace(/^\*?\s+/, "").trim();
      if (!name) continue;
      if (!/^matt-auto\/\d+\/integration-merge$/.test(name)) continue;
      const del = await run(workflowRoot, "git", ["branch", "-D", name]);
      if (del.code === 0) deletedLocalBranches.push(name);
    }
  }

  return { deletedLocalBranches, worktreePruned, errors };
}

/**
 * Full soft GC for a Workflow root after successful PR merge / cleanup.
 */
export async function gcMattAutoGitlinkArtifacts(
  workflowRoot: string,
): Promise<GitlinkGcResult> {
  const deletedRemoteRefs: string[] = [];
  const keptRemoteRefs: string[] = [];
  const errors: string[] = [];

  const local = await pruneLocalMattAutoArtifacts(workflowRoot);
  errors.push(...local.errors);

  const gitlinks = await listGitlinksAtHead(workflowRoot);
  const seenRemotes = new Set<string>();

  for (const link of gitlinks) {
    const remote = await resolveSubmoduleRemoteUrl(workflowRoot, link.path);
    if (!remote || seenRemotes.has(remote)) continue;
    seenRemotes.add(remote);

    const subDir = path.join(workflowRoot, link.path);
    if (!(await pathExists(subDir))) {
      errors.push(
        "Skip gitlink GC for " +
          link.path +
          ": checkout missing at " +
          subDir,
      );
      continue;
    }

    const top = await run(subDir, "git", ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
      errors.push("Skip gitlink GC for " + link.path + ": not a git checkout");
      continue;
    }
    const repoDir = top.stdout.trim() || subDir;
    const defaultBranch =
      (await detectDefaultBranchName(repoDir)) ?? "main";

    const gc = await gcGitlinkBranchesOnRemote({
      repoDir,
      remoteUrl: remote,
      defaultBranch,
    });
    deletedRemoteRefs.push(...gc.deleted);
    keptRemoteRefs.push(...gc.kept);
    errors.push(...gc.errors);
  }

  return {
    deletedRemoteRefs,
    keptRemoteRefs,
    deletedLocalBranches: local.deletedLocalBranches,
    worktreePruned: local.worktreePruned,
    errors,
  };
}
