import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { implementationBranchName } from "../constants.js";
import type { WorkspacePort } from "../ports.js";

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
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

/**
 * Sibling worktree root outside the Workflow root.
 * Layout: <parent>/matt-auto-workspaces/<workflowId>/ticket-<n>/r<attempt>
 */
export function implementationWorktreePath(
  workflowRoot: string,
  workflowId: number,
  ticketNumber: number,
  attempt: number,
): string {
  return path.join(
    path.dirname(path.resolve(workflowRoot)),
    "matt-auto-workspaces",
    String(workflowId),
    `ticket-${ticketNumber}`,
    `r${attempt}`,
  );
}

/**
 * Local git worktree/branch operations for Implementation workspaces.
 * Never pushes remotes.
 */
export function createWorkspacePort(workflowRoot: string): WorkspacePort {
  const root = path.resolve(workflowRoot);

  return {
    async latestAttempt(workflowId, ticketNumber) {
      const pattern = `matt-auto/${workflowId}/ticket-${ticketNumber}/r*`;
      const listed = await run(root, "git", [
        "branch",
        "--list",
        "--format=%(refname:short)",
        pattern,
      ]);
      if (listed.code !== 0) return 0;

      let max = 0;
      for (const line of listed.stdout.split("\n")) {
        const name = line.trim();
        const match = /\/r(\d+)$/.exec(name);
        if (!match?.[1]) continue;
        const attempt = Number(match[1]);
        if (Number.isInteger(attempt) && attempt > max) {
          max = attempt;
        }
      }
      return max;
    },

    async createImplementationWorkspace(input) {
      const branchName = implementationBranchName(
        input.workflowId,
        input.ticketNumber,
        input.attempt,
      );
      const worktreePath = implementationWorktreePath(
        root,
        input.workflowId,
        input.ticketNumber,
        input.attempt,
      );

      // Branch from the local base ref only — never push.
      const add = await run(root, "git", [
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        input.baseRef,
      ]);
      if (add.code !== 0) {
        throw new Error(
          `git worktree add failed for ${branchName}: ${add.stderr || add.stdout || `exit ${add.code}`}`,
        );
      }

      return { branchName, worktreePath };
    },
  };
}
