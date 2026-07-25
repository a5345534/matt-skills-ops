import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { RemoteGitPort } from "../ports.js";

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
  };
}
