import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  implementationBranchName,
  integrationBranchName,
} from "../constants.js";
import type { IntegrationMergeResult, WorkspacePort } from "../ports.js";

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

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
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
 * Dedicated Integration workspace worktree outside the Workflow root.
 * Layout: <parent>/matt-auto-workspaces/<workflowId>/integration
 */
export function integrationWorktreePath(
  workflowRoot: string,
  workflowId: number,
): string {
  return path.join(
    path.dirname(path.resolve(workflowRoot)),
    "matt-auto-workspaces",
    String(workflowId),
    "integration",
  );
}

async function branchExists(root: string, branchName: string): Promise<boolean> {
  const listed = await run(root, "git", [
    "branch",
    "--list",
    "--format=%(refname:short)",
    branchName,
  ]);
  if (listed.code !== 0) return false;
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .includes(branchName);
}

/**
 * Local git worktree/branch operations for Implementation and Integration workspaces.
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

    async ensureIntegrationWorkspace(input) {
      const branchName = integrationBranchName(input.workflowId);
      const worktreePath = integrationWorktreePath(root, input.workflowId);
      const existsBranch = await branchExists(root, branchName);
      const existsWorktree = await pathExists(worktreePath);

      if (existsBranch && existsWorktree) {
        return { branchName, worktreePath };
      }

      if (existsBranch && !existsWorktree) {
        const add = await run(root, "git", [
          "worktree",
          "add",
          worktreePath,
          branchName,
        ]);
        if (add.code !== 0) {
          throw new Error(
            `git worktree add failed for Integration branch ${branchName}: ${add.stderr || add.stdout || `exit ${add.code}`}`,
          );
        }
        return { branchName, worktreePath };
      }

      // Create Integration branch from baseRef and attach worktree.
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
          `git worktree add failed for Integration branch ${branchName}: ${add.stderr || add.stdout || `exit ${add.code}`}`,
        );
      }
      return { branchName, worktreePath };
    },

    async mergeIntoIntegration(input): Promise<IntegrationMergeResult> {
      const branchName = integrationBranchName(input.workflowId);
      const worktreePath = integrationWorktreePath(root, input.workflowId);

      if (!(await pathExists(worktreePath))) {
        return {
          ok: false,
          reason: "error",
          message: `Integration workspace missing at ${worktreePath}`,
        };
      }

      // Ensure the Integration workspace is on the Integration branch.
      const checkout = await run(worktreePath, "git", ["checkout", branchName]);
      if (checkout.code !== 0) {
        return {
          ok: false,
          reason: "error",
          message:
            checkout.stderr ||
            checkout.stdout ||
            `git checkout ${branchName} failed`,
        };
      }

      const merge = await run(worktreePath, "git", [
        "merge",
        "--no-ff",
        input.ticketBranch,
        "-m",
        `matt-auto: integrate ${input.ticketBranch}`,
      ]);

      if (merge.code !== 0) {
        const detail = (merge.stderr || merge.stdout || "").toLowerCase();
        const isConflict =
          detail.includes("conflict") ||
          detail.includes("merge conflict") ||
          detail.includes("automatic merge failed");

        if (isConflict) {
          // Preserve the in-progress merge for a Conflict resolution worker.
          // Never abort here — the installed resolving-merge-conflicts skill resolves it.
          return {
            ok: false,
            reason: "conflict",
            message: merge.stderr || merge.stdout || "merge conflict",
          };
        }

        return {
          ok: false,
          reason: "error",
          message: merge.stderr || merge.stdout || `merge exit ${merge.code}`,
        };
      }

      const sha = await run(worktreePath, "git", ["rev-parse", "HEAD"]);
      const mergeCommitSha =
        sha.code === 0 ? sha.stdout.trim() || undefined : undefined;

      return mergeCommitSha
        ? { ok: true, mergeCommitSha }
        : { ok: true };
    },

    async hasCommitsAhead(input) {
      const head = await run(input.worktreePath, "git", ["rev-parse", "HEAD"]);
      if (head.code !== 0) {
        return { ahead: false, count: 0 };
      }
      const headSha = head.stdout.trim();
      const countResult = await run(input.worktreePath, "git", [
        "rev-list",
        "--count",
        `${input.baseRef}..HEAD`,
      ]);
      if (countResult.code !== 0) {
        // baseRef may be missing in a shallow/orphan worktree; treat any HEAD as ahead.
        return headSha
          ? { ahead: true, headSha, count: 1 }
          : { ahead: false, count: 0 };
      }
      const count = Number(countResult.stdout.trim() || "0");
      if (!Number.isFinite(count) || count <= 0) {
        return { ahead: false, headSha, count: 0 };
      }
      return { ahead: true, headSha, count };
    },

    async listWorkflowBranches(workflowId) {
      const patterns = [
        `matt-auto/${workflowId}`,
        `matt-auto/${workflowId}/*`,
      ];
      const found = new Set<string>();
      for (const pattern of patterns) {
        const listed = await run(root, "git", [
          "branch",
          "--list",
          "--format=%(refname:short)",
          pattern,
        ]);
        if (listed.code !== 0) continue;
        for (const line of listed.stdout.split("\n")) {
          const name = line.trim();
          if (name) found.add(name);
        }
      }
      return [...found].sort();
    },

    async removeLocalBranches(branchNames) {
      const unique = [...new Set(branchNames.filter(Boolean))].sort();
      const removedWorktrees: string[] = [];
      const removedLocalBranches: string[] = [];
      if (unique.length === 0) {
        return { removedWorktrees, removedLocalBranches };
      }

      // Remove worktrees first so branch -D succeeds.
      const listed = await run(root, "git", [
        "worktree",
        "list",
        "--porcelain",
      ]);
      if (listed.code === 0) {
        const entries: Array<{ path?: string; branch?: string }> = [];
        let current: { path?: string; branch?: string } = {};
        for (const line of listed.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (current.path) entries.push(current);
            current = { path: line.slice("worktree ".length).trim() };
          } else if (line.startsWith("branch ")) {
            const ref = line.slice("branch ".length).trim();
            current.branch = ref.replace(/^refs\/heads\//, "");
          } else if (line.trim() === "") {
            if (current.path) entries.push(current);
            current = {};
          }
        }
        if (current.path) entries.push(current);

        for (const entry of entries) {
          if (!entry.path || !entry.branch) continue;
          if (!unique.includes(entry.branch)) continue;
          // Never remove the main Workflow root worktree.
          if (path.resolve(entry.path) === root) continue;
          const removed = await run(root, "git", [
            "worktree",
            "remove",
            "--force",
            entry.path,
          ]);
          if (removed.code === 0) {
            removedWorktrees.push(entry.path);
          }
        }
      }

      for (const branchName of unique) {
        const deleted = await run(root, "git", ["branch", "-D", branchName]);
        if (deleted.code === 0) {
          removedLocalBranches.push(branchName);
        }
      }

      return { removedWorktrees, removedLocalBranches };
    },

    async cleanupWorkflowWorkspaces(workflowId) {
      const branchNames = await this.listWorkflowBranches(workflowId);
      const removed = await this.removeLocalBranches(branchNames);
      const removedWorktrees = [...removed.removedWorktrees];
      const removedLocalBranches = [...removed.removedLocalBranches];

      // Also drop known sibling layout paths if still present without branch mapping.
      const siblingRoot = path.join(
        path.dirname(root),
        "matt-auto-workspaces",
        String(workflowId),
      );
      if (await pathExists(siblingRoot)) {
        const listedAgain = await run(root, "git", [
          "worktree",
          "list",
          "--porcelain",
        ]);
        if (listedAgain.code === 0) {
          for (const line of listedAgain.stdout.split("\n")) {
            if (!line.startsWith("worktree ")) continue;
            const worktreePath = line.slice("worktree ".length).trim();
            if (!worktreePath.startsWith(siblingRoot)) continue;
            if (path.resolve(worktreePath) === root) continue;
            const removedWt = await run(root, "git", [
              "worktree",
              "remove",
              "--force",
              worktreePath,
            ]);
            if (
              removedWt.code === 0 &&
              !removedWorktrees.includes(worktreePath)
            ) {
              removedWorktrees.push(worktreePath);
            }
          }
        }
      }

      return { removedWorktrees, removedLocalBranches };
    },
  };
}
