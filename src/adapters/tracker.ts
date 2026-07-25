import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  WORKFLOW_MANIFEST_MARKER,
  WORKFLOW_MANIFEST_SCHEMA,
} from "../constants.js";
import type { TrackerPort, TrackerTicket } from "../ports.js";
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
  return value === "spec-published" || value === "tickets-published";
}

function isTicketNumberList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)
  );
}

function isIntegratedTicketList(
  value: unknown,
): value is NonNullable<WorkflowManifest["integratedTickets"]> {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as {
      number?: unknown;
      attempt?: unknown;
      branchName?: unknown;
    };
    return (
      typeof item.number === "number" &&
      Number.isInteger(item.number) &&
      item.number > 0 &&
      typeof item.attempt === "number" &&
      Number.isInteger(item.attempt) &&
      item.attempt > 0 &&
      typeof item.branchName === "string" &&
      item.branchName.length > 0
    );
  });
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
    const manifest: WorkflowManifest = {
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: parsed.workflowId,
      targetBranch: parsed.targetBranch,
      stage: parsed.stage,
      workerProfile: parsed.workerProfile,
    };
    if (isTicketNumberList(parsed.tickets)) {
      manifest.tickets = parsed.tickets;
    }
    if (
      typeof parsed.integrationBranch === "string" &&
      parsed.integrationBranch.length > 0
    ) {
      manifest.integrationBranch = parsed.integrationBranch;
    }
    if (isIntegratedTicketList(parsed.integratedTickets)) {
      manifest.integratedTickets = [...parsed.integratedTickets];
    }
    return manifest;
  } catch {
    return undefined;
  }
}

async function resolveRepoFullName(
  cwd: string,
): Promise<{ owner: string; name: string } | undefined> {
  const result = await run(cwd, "gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
  ]);
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { nameWithOwner?: string };
    const full = parsed.nameWithOwner;
    if (!full || !full.includes("/")) return undefined;
    const [owner, name] = full.split("/");
    if (!owner || !name) return undefined;
    return { owner, name };
  } catch {
    return undefined;
  }
}

async function resolveIssueNodeId(
  cwd: string,
  owner: string,
  name: string,
  issueNumber: number,
): Promise<string | undefined> {
  const result = await run(cwd, "gh", [
    "api",
    "graphql",
    "-f",
    `query=query { repository(owner:"${owner}", name:"${name}") { issue(number:${issueNumber}) { id } } }`,
  ]);
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as {
      data?: { repository?: { issue?: { id?: string } } };
    };
    return parsed.data?.repository?.issue?.id;
  } catch {
    return undefined;
  }
}

/**
 * Real TrackerPort backed by `gh` in a Workflow root.
 * Creates issues, native blocked-by edges, sub-issues, and managed manifests.
 */
export function createTrackerPort(cwd: string): TrackerPort {
  async function findManagedManifestComment(
    issueNumber: number,
  ): Promise<{ id: string } | undefined> {
    const viewed = await run(cwd, "gh", [
      "api",
      `repos/{owner}/{repo}/issues/${issueNumber}/comments`,
      "--paginate",
    ]);
    if (viewed.code !== 0) return undefined;

    try {
      const comments = JSON.parse(viewed.stdout) as Array<{
        id?: number;
        body?: string;
      }>;
      // Prefer the latest managed manifest comment if several exist.
      for (let i = comments.length - 1; i >= 0; i -= 1) {
        const comment = comments[i];
        if (!comment?.body || typeof comment.id !== "number") continue;
        if (parseWorkflowManifestComment(comment.body)) {
          return { id: String(comment.id) };
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

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
      const existing = await findManagedManifestComment(issueNumber);

      // Write via a temp body file so multiline JSON is preserved.
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "matt-auto-manifest-"));
      const bodyFile = path.join(tmpDir, "body.md");
      const jsonFile = path.join(tmpDir, "payload.json");
      try {
        await writeFile(bodyFile, body, "utf8");

        if (existing) {
          await writeFile(jsonFile, JSON.stringify({ body }), "utf8");
          const updated = await run(cwd, "gh", [
            "api",
            "-X",
            "PATCH",
            `repos/{owner}/{repo}/issues/comments/${existing.id}`,
            "--input",
            jsonFile,
          ]);
          if (updated.code !== 0) {
            throw new Error(
              updated.stderr.trim() ||
                `gh issue comment update failed with exit code ${updated.code}`,
            );
          }
          return;
        }

        const created = await run(cwd, "gh", [
          "issue",
          "comment",
          String(issueNumber),
          "--body-file",
          bodyFile,
        ]);
        if (created.code !== 0) {
          throw new Error(
            created.stderr.trim() ||
              `gh issue comment failed with exit code ${created.code}`,
          );
        }
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
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

        // Prefer the last managed manifest comment on the issue.
        let found: WorkflowManifest | undefined;
        for (const comment of detail.comments ?? []) {
          const manifest = parseWorkflowManifestComment(comment.body ?? "");
          if (manifest) found = manifest;
        }
        if (!found) continue;
        if (found.targetBranch !== targetBranch) continue;
        if (found.workflowId !== issue.number) continue;

        const active: ActiveWorkflow = {
          workflowId: found.workflowId,
          targetBranch: found.targetBranch,
          stage: found.stage,
          workerProfile: found.workerProfile,
        };
        if (found.tickets) {
          active.tickets = [...found.tickets];
        }
        if (found.integrationBranch) {
          active.integrationBranch = found.integrationBranch;
        }
        if (found.integratedTickets) {
          active.integratedTickets = [...found.integratedTickets];
        }
        const title = detail.title ?? issue.title;
        if (title) {
          active.title = title;
        }
        return active;
      }

      return undefined;
    },

    async listTickets(issueNumbers) {
      if (issueNumbers.length === 0) return [];

      const repo = await resolveRepoFullName(cwd);
      if (!repo) return [];

      const tickets: TrackerTicket[] = [];
      for (const number of issueNumbers) {
        const result = await run(cwd, "gh", [
          "api",
          "graphql",
          "-f",
          `query=query {
            repository(owner: "${repo.owner}", name: "${repo.name}") {
              issue(number: ${number}) {
                number
                title
                state
                blockedBy(first: 50) {
                  nodes { number state }
                }
              }
            }
          }`,
        ]);
        if (result.code !== 0) continue;
        try {
          const parsed = JSON.parse(result.stdout) as {
            data?: {
              repository?: {
                issue?: {
                  number: number;
                  title: string;
                  state: string;
                  blockedBy?: {
                    nodes?: Array<{ number: number; state: string }>;
                  };
                } | null;
              };
            };
          };
          const issue = parsed.data?.repository?.issue;
          if (!issue) continue;
          const state = issue.state === "CLOSED" ? "CLOSED" : "OPEN";
          tickets.push({
            number: issue.number,
            title: issue.title,
            state,
            blockedBy: (issue.blockedBy?.nodes ?? []).map((node) => ({
              number: node.number,
              state: node.state === "CLOSED" ? "CLOSED" : "OPEN",
            })),
          });
        } catch {
          // skip malformed
        }
      }
      return tickets;
    },

    async addBlockedBy(issueNumber, blockerIssueNumber) {
      const repo = await resolveRepoFullName(cwd);
      if (!repo) {
        throw new Error("Could not resolve repository for addBlockedBy.");
      }
      const [issueId, blockerId] = await Promise.all([
        resolveIssueNodeId(cwd, repo.owner, repo.name, issueNumber),
        resolveIssueNodeId(cwd, repo.owner, repo.name, blockerIssueNumber),
      ]);
      if (!issueId || !blockerId) {
        throw new Error(
          `Could not resolve GraphQL ids for #${issueNumber} blocked by #${blockerIssueNumber}.`,
        );
      }

      const result = await run(cwd, "gh", [
        "api",
        "graphql",
        "-f",
        `query=mutation {
          addBlockedBy(input: { issueId: "${issueId}", blockingIssueId: "${blockerId}" }) {
            issue { number }
          }
        }`,
      ]);
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `addBlockedBy failed for #${issueNumber} blocked by #${blockerIssueNumber}`,
        );
      }
      if (result.stdout.includes('"errors"')) {
        throw new Error(
          `addBlockedBy GraphQL error for #${issueNumber} blocked by #${blockerIssueNumber}: ${result.stdout}`,
        );
      }
    },

    async addSubIssue(parentIssueNumber, childIssueNumber) {
      const repo = await resolveRepoFullName(cwd);
      if (!repo) {
        throw new Error("Could not resolve repository for addSubIssue.");
      }
      const [parentId, childId] = await Promise.all([
        resolveIssueNodeId(cwd, repo.owner, repo.name, parentIssueNumber),
        resolveIssueNodeId(cwd, repo.owner, repo.name, childIssueNumber),
      ]);
      if (!parentId || !childId) {
        throw new Error(
          `Could not resolve GraphQL ids for parent #${parentIssueNumber} / child #${childIssueNumber}.`,
        );
      }

      const result = await run(cwd, "gh", [
        "api",
        "graphql",
        "-f",
        `query=mutation {
          addSubIssue(input: { issueId: "${parentId}", subIssueId: "${childId}", replaceParent: true }) {
            issue { number }
          }
        }`,
      ]);
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `addSubIssue failed for parent #${parentIssueNumber} / child #${childIssueNumber}`,
        );
      }
      if (result.stdout.includes('"errors"')) {
        throw new Error(
          `addSubIssue GraphQL error for parent #${parentIssueNumber} / child #${childIssueNumber}: ${result.stdout}`,
        );
      }
    },

    async closeIssue(issueNumber) {
      const result = await run(cwd, "gh", [
        "issue",
        "close",
        String(issueNumber),
        "--reason",
        "completed",
      ]);
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `gh issue close failed for #${issueNumber} with exit code ${result.code}`,
        );
      }
    },
  };
}
