import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { RemoteGitPort } from "../ports.js";

const execFileAsync = promisify(execFile);

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
        // `git push origin --delete <branch>` fails if the remote branch is already gone;
        // treat missing remotes as success so paired cleanup stays idempotent.
        const result = await run(root, "git", [
          "push",
          "origin",
          "--delete",
          branchName,
        ]);
        if (result.code === 0) continue;
        const detail = (result.stderr || result.stdout || "").toLowerCase();
        const missing =
          detail.includes("remote ref does not exist") ||
          detail.includes("does not exist") ||
          detail.includes("not found") ||
          detail.includes("unable to delete");
        if (!missing) {
          throw new Error(
            `git push origin --delete ${branchName} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
          );
        }
      }
    },
  };
}
