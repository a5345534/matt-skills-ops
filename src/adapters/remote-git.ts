import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { RemoteGitPort, SafePullResult } from "../ports.js";

const execFileAsync = promisify(execFile);

/**
 * True when delete failed only because the remote branch is already gone.
 * Matches English and common Chinese git/i18n messages.
 */
export function isMissingRemoteBranchError(
  stderr: string,
  stdout = "",
): boolean {
  const detail = `${stderr}
${stdout}`.toLowerCase();
  return (
    detail.includes("remote ref does not exist") ||
    detail.includes("does not exist") ||
    detail.includes("not found") ||
    detail.includes("unable to delete") ||
    // zh_TW / zh_CN git messages seen in the wild
    detail.includes("遠端引用不存在") ||
    detail.includes("远程引用不存在") ||
    detail.includes("無法刪除") ||
    detail.includes("无法删除")
  );
}

async function run(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
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

/**
 * Coordinator-only remote Git writes for a Workflow root.
 * Workers never receive this port.
 */
export function createRemoteGitPort(workflowRoot: string): RemoteGitPort {
  const root = path.resolve(workflowRoot);

  return {
    async pushBranch(branchName) {
      // Push the named local branch to origin without setting upstream tracking
      // beyond the branch itself. Fails closed on non-zero exit.
      const result = await run(root, "git", [
        "push",
        "-u",
        "origin",
        branchName,
      ]);
      if (result.code !== 0) {
        throw new Error(
          `git push origin ${branchName} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
        );
      }
    },

    async deleteRemoteBranches(branchNames) {
      for (const branchName of branchNames) {
        // Prefer skipping branches that are already gone (locale-independent).
        const listed = await run(root, "git", [
          "ls-remote",
          "--heads",
          "origin",
          branchName,
        ]);
        if (listed.code === 0 && listed.stdout.trim().length === 0) {
          continue;
        }

        // `git push origin --delete <branch>` still fails if the remote branch
        // vanished between ls-remote and delete; treat missing as success so
        // paired cleanup stays idempotent across git locales (en/zh).
        const result = await run(root, "git", [
          "push",
          "origin",
          "--delete",
          branchName,
        ]);
        if (result.code === 0) continue;
        if (isMissingRemoteBranchError(result.stderr, result.stdout)) {
          continue;
        }
        throw new Error(
          `git push origin --delete ${branchName} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
        );
      }
    },

    async safePullBranch(branchName) {
      return safePullBranchAtRoot(root, branchName);
    },
  };
}

/**
 * Fast-forward Workflow root to origin/branch when safe.
 * Never force, never reset, never merge with local commits.
 */
export async function safePullBranchAtRoot(
  root: string,
  branchName: string,
): Promise<SafePullResult> {
  const branch = branchName.trim();
  if (!branch) {
    return { ok: false, branch: branchName, reason: "Empty branch name." };
  }

  const head = await run(root, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.code !== 0) {
    return {
      ok: false,
      branch,
      reason: `Cannot read HEAD: ${head.stderr || head.stdout || "git rev-parse failed"}`,
    };
  }
  const current = head.stdout.trim();
  if (current === "HEAD") {
    return {
      ok: true,
      pulled: false,
      skipped: true,
      branch,
      reason: "Detached HEAD — skipped auto-pull (unsafe).",
    };
  }
  if (current !== branch) {
    return {
      ok: true,
      pulled: false,
      skipped: true,
      branch,
      reason: `HEAD is on "${current}", not target "${branch}" — skipped auto-pull.`,
    };
  }

  const porcelain = await run(root, "git", ["status", "--porcelain"]);
  if (porcelain.code !== 0) {
    return {
      ok: false,
      branch,
      reason: `git status failed: ${porcelain.stderr || porcelain.stdout}`,
    };
  }
  if (porcelain.stdout.trim().length > 0) {
    return {
      ok: true,
      pulled: false,
      skipped: true,
      branch,
      reason:
        "Working tree is dirty — skipped auto-pull to avoid clobbering local changes.",
    };
  }

  const fetch = await run(root, "git", ["fetch", "origin", branch]);
  if (fetch.code !== 0) {
    return {
      ok: false,
      branch,
      reason: `git fetch origin ${branch} failed: ${fetch.stderr || fetch.stdout || `exit ${fetch.code}`}`,
    };
  }

  const remoteRef = `origin/${branch}`;
  // Already up to date?
  const headSha = await run(root, "git", ["rev-parse", "HEAD"]);
  const remoteSha = await run(root, "git", ["rev-parse", remoteRef]);
  if (
    headSha.code === 0 &&
    remoteSha.code === 0 &&
    headSha.stdout.trim() === remoteSha.stdout.trim()
  ) {
    return {
      ok: true,
      pulled: false,
      skipped: true,
      branch,
      reason: `Already up to date with ${remoteRef}.`,
    };
  }

  // Require fast-forward: remote must be a descendant of HEAD.
  const canFf = await run(root, "git", [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    remoteRef,
  ]);
  if (canFf.code !== 0) {
    return {
      ok: true,
      pulled: false,
      skipped: true,
      branch,
      reason: `Cannot fast-forward onto ${remoteRef} (local commits or diverged history) — skipped auto-pull.`,
    };
  }

  const pull = await run(root, "git", [
    "merge",
    "--ff-only",
    remoteRef,
  ]);
  if (pull.code !== 0) {
    return {
      ok: false,
      branch,
      reason: `git merge --ff-only ${remoteRef} failed: ${pull.stderr || pull.stdout || `exit ${pull.code}`}`,
    };
  }

  // Align submodule working trees to gitlinks recorded after the pull (safe:
  // does not rewrite parent history; only checks out pinned SHAs).
  let submodulesUpdated = false;
  const sub = await run(root, "git", [
    "submodule",
    "update",
    "--init",
    "--recursive",
  ]);
  if (sub.code === 0) {
    submodulesUpdated = true;
  }

  return {
    ok: true,
    pulled: true,
    branch,
    submodulesUpdated,
  };
}
