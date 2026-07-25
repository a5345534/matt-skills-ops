import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { CiCheckResult, CiPort } from "../ports.js";

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

type GhRun = {
  status?: string;
  conclusion?: string | null;
  url?: string;
  displayTitle?: string;
  name?: string;
};

/** On-demand GitHub Actions CI gate. Never polls in a loop. */
export function createCiPort(workflowRoot: string): CiPort {
  const rootPath = path.resolve(workflowRoot);
  return {
    async checkStatus(input): Promise<CiCheckResult> {
      const listed = await run(rootPath, "gh", [
        "run",
        "list",
        "--branch",
        input.branchName,
        "--limit",
        "20",
        "--json",
        "databaseId,status,conclusion,url,displayTitle,name",
      ]);
      if (listed.code !== 0) {
        return {
          status: "failure",
          summary:
            listed.stderr.trim() ||
            `gh run list failed for branch ${input.branchName}`,
        };
      }
      let runs: GhRun[];
      try {
        runs = JSON.parse(listed.stdout) as GhRun[];
      } catch {
        return {
          status: "failure",
          summary: `gh run list returned non-JSON output for branch ${input.branchName}`,
        };
      }
      if (!Array.isArray(runs) || runs.length === 0) {
        return {
          status: "success",
          summary: `No GitHub Actions runs for ${input.branchName}.`,
        };
      }
      const inProgress = runs.find((e) => {
        const s = (e.status ?? "").toLowerCase();
        return ["queued", "in_progress", "waiting", "requested", "pending"].includes(
          s,
        );
      });
      if (inProgress) {
        return {
          status: "pending",
          ...(inProgress.url ? { url: inProgress.url } : {}),
          summary:
            inProgress.displayTitle ||
            inProgress.name ||
            `CI still running on ${input.branchName}`,
        };
      }
      const failed = runs.find((e) => {
        const c = (e.conclusion ?? "").toLowerCase();
        return [
          "failure",
          "cancelled",
          "timed_out",
          "startup_failure",
          "action_required",
        ].includes(c);
      });
      if (failed) {
        return {
          status: "failure",
          ...(failed.url ? { url: failed.url } : {}),
          summary:
            failed.displayTitle ||
            failed.name ||
            `CI failed on ${input.branchName}`,
        };
      }
      const latest = runs[0];
      return {
        status: "success",
        ...(latest?.url ? { url: latest.url } : {}),
        summary:
          latest?.displayTitle ||
          latest?.name ||
          `CI succeeded on ${input.branchName}`,
      };
    },
  };
}
