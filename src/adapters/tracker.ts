import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  WORKFLOW_MANIFEST_MARKER,
  WORKFLOW_MANIFEST_SCHEMA,
} from "../constants.js";
import type { TrackerPort } from "../ports.js";
import type {
  ActiveWorkflow,
  WorkerProfile,
  WorkflowManifest,
  WorkflowStage,
} from "../types.js";

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

function isWorkerProfile(value: unknown): value is WorkerProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as WorkerProfile;
  return (
    typeof profile.provider === "string" &&
    profile.provider.length > 0 &&
    typeof profile.modelId === "string" &&
    profile.modelId.length > 0 &&
    typeof profile.thinkingLevel === "string" &&
    profile.thinkingLevel.length > 0
  );
}

function isWorkflowStage(value: unknown): value is WorkflowStage {
  return value === "spec-published";
}

/** Serialize a Workflow manifest into the managed GitHub comment body. */
export function formatWorkflowManifestComment(
  manifest: WorkflowManifest,
): string {
  return `${WORKFLOW_MANIFEST_MARKER}\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n`;
}

/** Parse a managed Workflow manifest from a GitHub comment body, if present. */
export function parseWorkflowManifestComment(
  body: string,
): WorkflowManifest | undefined {
  if (!body.includes(WORKFLOW_MANIFEST_MARKER)) {
    return undefined;
  }

  const jsonMatch = /```json\s*([\s\S]*?)```/i.exec(body);
  const raw = jsonMatch?.[1]?.trim();
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as Partial<WorkflowManifest>;
    if (
      parsed.schema !== WORKFLOW_MANIFEST_SCHEMA ||
      parsed.version !== 1 ||
      typeof parsed.workflowId !== "number" ||
      typeof parsed.targetBranch !== "string" ||
      !isWorkflowStage(parsed.stage) ||
      !isWorkerProfile(parsed.workerProfile)
    ) {
      return undefined;
    }
    return {
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: parsed.workflowId,
      targetBranch: parsed.targetBranch,
      stage: parsed.stage,
      workerProfile: parsed.workerProfile,
    };
  } catch {
    return undefined;
  }
}

/**
 * Real TrackerPort backed by `gh` in a Workflow root.
 * Creates issues and managed Workflow manifest comments; never invents repos.
 */
export function createTrackerPort(cwd: string): TrackerPort {
  return {
    async createIssue(input) {
      const args = [
        "issue",
        "create",
        "--title",
        input.title,
        "--body",
        input.body,
        "--json",
        "number,url",
      ];
      for (const label of input.labels) {
        args.push("--label", label);
      }

      const result = await run(cwd, "gh", args);
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `gh issue create failed with exit code ${result.code}`,
        );
      }

      let parsed: { number?: number };
      try {
        parsed = JSON.parse(result.stdout) as { number?: number };
      } catch {
        throw new Error("gh issue create returned non-JSON output.");
      }
      if (typeof parsed.number !== "number") {
        throw new Error("gh issue create did not return an issue number.");
      }
      return { number: parsed.number };
    },

    async writeWorkflowManifest(issueNumber, manifest) {
      const body = formatWorkflowManifestComment(manifest);
      const created = await run(cwd, "gh", [
        "issue",
        "comment",
        String(issueNumber),
        "--body",
        body,
      ]);
      if (created.code !== 0) {
        throw new Error(
          created.stderr.trim() ||
            `gh issue comment failed with exit code ${created.code}`,
        );
      }
    },

    async findActiveWorkflow(targetBranch) {
      const list = await run(cwd, "gh", [
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        "50",
        "--json",
        "number,title",
      ]);
      if (list.code !== 0) {
        return undefined;
      }

      let items: Array<{ number: number; title: string }>;
      try {
        items = JSON.parse(list.stdout) as Array<{
          number: number;
          title: string;
        }>;
      } catch {
        return undefined;
      }

      for (const issue of items) {
        const viewed = await run(cwd, "gh", [
          "issue",
          "view",
          String(issue.number),
          "--json",
          "number,title,comments",
        ]);
        if (viewed.code !== 0) continue;

        let detail: {
          number: number;
          title: string;
          comments?: Array<{ body?: string }>;
        };
        try {
          detail = JSON.parse(viewed.stdout) as typeof detail;
        } catch {
          continue;
        }

        for (const comment of detail.comments ?? []) {
          const manifest = parseWorkflowManifestComment(comment.body ?? "");
          if (!manifest) continue;
          if (manifest.targetBranch !== targetBranch) continue;
          if (manifest.workflowId !== issue.number) continue;

          const active: ActiveWorkflow = {
            workflowId: manifest.workflowId,
            targetBranch: manifest.targetBranch,
            stage: manifest.stage,
            workerProfile: manifest.workerProfile,
          };
          const title = detail.title ?? issue.title;
          if (title) {
            active.title = title;
          }
          return active;
        }
      }

      return undefined;
    },
  };
}
