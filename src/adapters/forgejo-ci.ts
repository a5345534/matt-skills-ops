import type { CiCheckResult, CiPort } from "../ports.js";
import { createForgejoApiClient, type ForgejoApiClient } from "./forgejo-api.js";
import type { ForgejoConnection } from "./forge.js";

export type ForgejoCiPortOptions = {
  api?: ForgejoApiClient;
};

type ForgejoBranch = {
  commit?: { id?: unknown };
};

type ForgejoActionRun = {
  id?: unknown;
  status?: unknown;
  html_url?: unknown;
  title?: unknown;
  workflow_id?: unknown;
};

type ForgejoActionRuns = {
  workflow_runs?: unknown;
};

function repositoryPath(connection: ForgejoConnection): string {
  return `repos/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.name)}`;
}

function asRuns(value: unknown): ForgejoActionRun[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is ForgejoActionRun =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];
}

function pendingRun(run: ForgejoActionRun): boolean {
  const status = typeof run.status === "string" ? run.status.toLowerCase() : "";
  return ["queued", "in_progress", "waiting", "requested", "pending", "running"].includes(
    status,
  );
}

function failedRun(run: ForgejoActionRun): boolean {
  const status = typeof run.status === "string" ? run.status.toLowerCase() : "";
  return [
    "failure",
    "failed",
    "cancelled",
    "canceled",
    "timed_out",
    "startup_failure",
    "action_required",
  ].includes(status);
}

function runSummary(run: ForgejoActionRun, branchName: string): string {
  if (typeof run.title === "string" && run.title.trim()) return run.title;
  if (typeof run.workflow_id === "string" && run.workflow_id.trim()) {
    return run.workflow_id;
  }
  return `Forgejo Actions run for ${branchName}`;
}

function runUrl(run: ForgejoActionRun): string | undefined {
  return typeof run.html_url === "string" && run.html_url.trim()
    ? run.html_url
    : undefined;
}

/** On-demand Forgejo Actions CI gate. Never polls in a loop. */
export function createForgejoCiPort(
  connection: ForgejoConnection,
  options: ForgejoCiPortOptions = {},
): CiPort {
  const api = options.api ?? createForgejoApiClient(connection);
  const repoPath = repositoryPath(connection);

  return {
    async checkStatus(input): Promise<CiCheckResult> {
      let headSha: string | undefined;
      try {
        const branch = await api.request<ForgejoBranch>({
          path: `${repoPath}/branches/${encodeURIComponent(input.branchName)}`,
        });
        if (typeof branch.commit?.id === "string" && branch.commit.id.trim()) {
          headSha = branch.commit.id;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "failure",
          summary: `Could not resolve Forgejo branch ${input.branchName}: ${message}`,
        };
      }
      if (!headSha) {
        return {
          status: "failure",
          summary: `Forgejo branch ${input.branchName} did not return a commit SHA.`,
        };
      }

      let runs: ForgejoActionRun[];
      try {
        const response = await api.request<ForgejoActionRuns>({
          path: `${repoPath}/actions/runs`,
          query: { head_sha: headSha, limit: 50 },
        });
        runs = asRuns(response.workflow_runs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "failure",
          summary: `Could not list Forgejo Actions runs for ${input.branchName}: ${message}`,
        };
      }

      if (runs.length === 0) {
        return {
          status: "success",
          summary: `No Forgejo Actions runs for ${input.branchName}.`,
        };
      }
      const inProgress = runs.find(pendingRun);
      if (inProgress) {
        const url = runUrl(inProgress);
        return {
          status: "pending",
          ...(url ? { url } : {}),
          summary: runSummary(inProgress, input.branchName),
        };
      }
      const failed = runs.find(failedRun);
      if (failed) {
        const url = runUrl(failed);
        return {
          status: "failure",
          ...(url ? { url } : {}),
          summary: runSummary(failed, input.branchName),
        };
      }
      const latest = runs[0];
      const url = latest ? runUrl(latest) : undefined;
      return {
        status: "success",
        ...(url ? { url } : {}),
        summary: latest
          ? runSummary(latest, input.branchName)
          : `Forgejo Actions succeeded on ${input.branchName}.`,
      };
    },
  };
}
