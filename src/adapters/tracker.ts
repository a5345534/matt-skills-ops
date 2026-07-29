import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  canonicalRepositoryIdentityKey,
  isCanonicalRepositoryIdentity,
  isCanonicalTargetIdentity,
  targetRefFromBranch,
} from "../coordination.js";
import { WORKFLOW_MANIFEST_MARKER } from "../constants.js";
import type { TrackerPort, TrackerTicket } from "../ports.js";
import {
  buildBatchedListTicketsQuery,
  chunkIssueNumbers,
} from "./tracker-queries.js";
import {
  isGraphqlRateLimitMessage,
  noteGraphqlRateLimit,
  recordGraphqlAttempt,
  recordRestAttempt,
} from "./tracker-rate-limit.js";
import type {
  ActiveWorkflow,
  CanonicalRepositoryIdentity,
  CanonicalTargetIdentity,
  WorkflowMergeMethod,
} from "../types.js";
import type { ProtectedBranchAutomationPolicy } from "../workflow-pr-guard.js";
import { isGitObjectId } from "../workflow-pr-guard.js";
import {
  activeWorkflowsFromIssues,
  coordinatedActiveWorkflowsFromIssues,
  formatWorkflowManifestComment,
  type WorkflowManifestIssue,
} from "./workflow-manifest.js";

export {
  activeWorkflowFromManifest,
  activeWorkflowsFromIssues,
  coordinatedActiveWorkflowsFromIssues,
  formatWorkflowManifestComment,
  parseWorkflowManifestComment,
  workflowManifestMatchesTarget,
} from "./workflow-manifest.js";
export type { WorkflowManifestIssue } from "./workflow-manifest.js";

const execFileAsync = promisify(execFile);

/**
 * Parse `gh issue create` stdout. Older gh prints only the issue URL:
 *   https://github.com/owner/repo/issues/42
 * Newer gh with --json is intentionally not required for compatibility.
 */
export function parseIssueNumberFromCreateOutput(
  stdout: string,
): number | undefined {
  const match = stdout.match(/\/issues\/(\d+)\b/);
  if (!match?.[1]) return undefined;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/**
 * Parse `gh pr create` stdout. Older gh (e.g. 2.45) does not support
 * `gh pr create --json` and prints only the PR URL:
 *   https://github.com/owner/repo/pull/13
 */
export function parsePullRequestFromCreateOutput(stdout: string):
  | { number: number; url: string }
  | undefined {
  const match = stdout.match(
    /(https?:\/\/[^\s]+\/pull\/(\d+))\b/,
  );
  if (!match?.[1] || !match[2]) return undefined;
  const number = Number(match[2]);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return { number, url: match[1] };
}

async function run(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const isGraphql =
    command === "gh" && args.includes("api") && args.includes("graphql");
  if (isGraphql) {
    recordGraphqlAttempt();
  } else if (command === "gh") {
    recordRestAttempt();
  }

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
    const stderr = err.stderr ?? err.message ?? "";
    const stdout = err.stdout ?? "";
    const detail = `${stderr}
${stdout}`;
    // gh may surface GraphQL quota errors even on non-graphql subcommands.
    if (isGraphqlRateLimitMessage(detail)) {
      noteGraphqlRateLimit(detail);
    }
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout,
      stderr,
    };
  }
}

async function resolveRepoFullName(
  cwd: string,
): Promise<CanonicalRepositoryIdentity | undefined> {
  const result = await run(cwd, "gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
  ]);
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { nameWithOwner?: string };
    const parts = parsed.nameWithOwner?.split("/");
    if (!parts || parts.length !== 2) return undefined;
    const [owner, name] = parts;
    const repository = { owner, name };
    return isCanonicalRepositoryIdentity(repository) ? repository : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize `gh api --paginate` JSON stdout into one flat item list.
 * Supports:
 * - single merged array of items (common without `--slurp`)
 * - array of pages from `--slurp` (`[[...],[...]]`)
 * - empty stdout / `[]` (no items)
 * - concatenated top-level JSON values (some older paginate modes)
 */
export function parsePaginatedApiArray(stdout: string): unknown[] | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.flatMap((page) => (Array.isArray(page) ? page : [page]));
  } catch {
    // Fall through to multi-value parse.
  }

  // Concatenated JSON values: successive page arrays from some paginate modes.
  try {
    const values = parseConcatenatedJsonValues(trimmed);
    if (values === undefined) return undefined;
    return values.flatMap((page) => (Array.isArray(page) ? page : [page]));
  } catch {
    return undefined;
  }
}

function parseConcatenatedJsonValues(text: string): unknown[] | undefined {
  const values: unknown[] = [];
  let offset = 0;
  while (offset < text.length) {
    while (offset < text.length && /\s/.test(text[offset]!)) offset += 1;
    if (offset >= text.length) break;
    const slice = text.slice(offset);
    let parsed: unknown;
    let consumed = 0;
    // Find the shortest prefix that parses as JSON by walking brackets/braces.
    const end = findJsonValueEnd(slice);
    if (end === undefined) return undefined;
    try {
      parsed = JSON.parse(slice.slice(0, end));
      consumed = end;
    } catch {
      return undefined;
    }
    values.push(parsed);
    offset += consumed;
  }
  return values;
}

function findJsonValueEnd(text: string): number | undefined {
  const start = text[0];
  if (start !== "[" && start !== "{") {
    // Primitive — not expected for paginated REST list endpoints.
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

/**
 * `gh api --paginate` without `--slurp`.
 * Older Ubuntu-packaged gh (e.g. 2.45) rejects `--slurp`; modern gh still
 * merges REST list pages into one JSON array without it.
 */
async function runGhApiPaginated(
  cwd: string,
  endpoint: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(cwd, "gh", ["api", "--paginate", endpoint]);
}

function repositoryEndpoint(repository: CanonicalRepositoryIdentity): string {
  return `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function repositoriesMatch(
  left: CanonicalRepositoryIdentity,
  right: CanonicalRepositoryIdentity,
): boolean {
  return (
    canonicalRepositoryIdentityKey(left) === canonicalRepositoryIdentityKey(right)
  );
}

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const results: Output[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(inputs[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(concurrency, 1), inputs.length) }, worker),
  );
  return results;
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
  async function loadIssueComments(
    repository: CanonicalRepositoryIdentity,
    issueNumber: number,
  ): Promise<Array<{ id?: unknown; body?: unknown }> | undefined> {
    const viewed = await runGhApiPaginated(
      cwd,
      `${repositoryEndpoint(repository)}/issues/${issueNumber}/comments?per_page=100`,
    );
    if (viewed.code !== 0) return undefined;
    const entries = parsePaginatedApiArray(viewed.stdout);
    if (!entries) return undefined;
    return entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const comment = entry as { id?: unknown; body?: unknown };
      return [{ id: comment.id, body: comment.body }];
    });
  }

  async function listOpenWorkflowIssues(
    repository: CanonicalRepositoryIdentity,
  ): Promise<
    Array<{ number: number; title?: string; state?: string }> | undefined
  > {
    const listed = await runGhApiPaginated(
      cwd,
      `${repositoryEndpoint(repository)}/issues?state=open&per_page=100`,
    );
    if (listed.code !== 0) return undefined;
    const entries = parsePaginatedApiArray(listed.stdout);
    // Empty repo / empty page is success (`[]`), not discovery failure.
    if (!entries) return undefined;

    const issues = new Map<
      number,
      { number: number; title?: string; state?: string }
    >();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const issue = entry as {
        number?: unknown;
        title?: unknown;
        state?: unknown;
      };
      if (
        typeof issue.number !== "number" ||
        !Number.isInteger(issue.number) ||
        issue.number <= 0
      ) {
        continue;
      }
      issues.set(issue.number, {
        number: issue.number,
        ...(typeof issue.title === "string" ? { title: issue.title } : {}),
        ...(typeof issue.state === "string" ? { state: issue.state } : {}),
      });
    }
    return [...issues.values()];
  }

  async function loadOpenWorkflowIssue(
    repository: CanonicalRepositoryIdentity,
    issueNumber: number,
  ): Promise<{ number: number; title?: string; state?: string } | undefined> {
    const viewed = await run(cwd, "gh", [
      "api",
      `${repositoryEndpoint(repository)}/issues/${issueNumber}`,
    ]);
    if (viewed.code !== 0) return undefined;
    try {
      const issue = JSON.parse(viewed.stdout) as {
        number?: unknown;
        title?: unknown;
        state?: unknown;
      };
      if (
        typeof issue.number !== "number" ||
        !Number.isInteger(issue.number) ||
        issue.number <= 0 ||
        issue.state !== "open"
      ) {
        return undefined;
      }
      return {
        number: issue.number,
        ...(typeof issue.title === "string" ? { title: issue.title } : {}),
        state: issue.state,
      };
    } catch {
      return undefined;
    }
  }

  async function findManagedManifestComment(
    issueNumber: number,
  ): Promise<{ id: string } | undefined> {
    const repository = await resolveRepoFullName(cwd);
    if (!repository) return undefined;
    const comments = await loadIssueComments(repository, issueNumber);
    if (!comments) return undefined;

    // The latest managed comment is authoritative even if malformed, so a write
    // repairs it instead of creating a second managed manifest comment.
    for (let i = comments.length - 1; i >= 0; i -= 1) {
      const comment = comments[i];
      if (
        typeof comment?.body !== "string" ||
        !comment.body.includes(WORKFLOW_MANIFEST_MARKER) ||
        typeof comment.id !== "number"
      ) {
        continue;
      }
      return { id: String(comment.id) };
    }
    return undefined;
  }

  async function loadActiveWorkflowSnapshots(
    repository: CanonicalRepositoryIdentity,
  ): Promise<readonly WorkflowManifestIssue[]> {
    const issues = await listOpenWorkflowIssues(repository);
    if (!issues) {
      throw new Error("Could not paginate open GitHub issues for workflow discovery.");
    }

    return mapWithConcurrency(issues, 8, async (issue) => {
      const comments = await loadIssueComments(repository, issue.number);
      if (!comments) {
        throw new Error(
          `Could not paginate managed comments for workflow issue #${issue.number}.`,
        );
      }
      return {
        number: issue.number,
        ...(issue.title ? { title: issue.title } : {}),
        ...(issue.state ? { state: issue.state } : {}),
        comments,
      } satisfies WorkflowManifestIssue;
    });
  }

  async function discoverActiveWorkflows(
    target: CanonicalTargetIdentity,
  ): Promise<readonly ActiveWorkflow[]> {
    if (!isCanonicalTargetIdentity(target)) return [];
    const repository = await resolveRepoFullName(cwd);
    if (!repository || !repositoriesMatch(repository, target.repository)) {
      return [];
    }
    return activeWorkflowsFromIssues(
      target,
      await loadActiveWorkflowSnapshots(repository),
    );
  }

  async function discoverActiveWorkflowsForRepository(
    requestedRepository: CanonicalRepositoryIdentity,
  ): Promise<readonly ActiveWorkflow[]> {
    if (!isCanonicalRepositoryIdentity(requestedRepository)) return [];
    const repository = await resolveRepoFullName(cwd);
    if (!repository || !repositoriesMatch(repository, requestedRepository)) {
      return [];
    }
    return coordinatedActiveWorkflowsFromIssues(
      repository,
      await loadActiveWorkflowSnapshots(repository),
    );
  }

  async function loadActiveWorkflowById(
    target: CanonicalTargetIdentity,
    workflowId: number,
  ): Promise<ActiveWorkflow | undefined> {
    const repository = await resolveRepoFullName(cwd);
    if (!repository || !repositoriesMatch(repository, target.repository)) {
      return undefined;
    }
    const issue = await loadOpenWorkflowIssue(repository, workflowId);
    if (!issue) return undefined;
    const comments = await loadIssueComments(repository, workflowId);
    if (!comments) return undefined;
    return activeWorkflowsFromIssues(target, [
      {
        number: issue.number,
        ...(issue.title ? { title: issue.title } : {}),
        ...(issue.state ? { state: issue.state } : {}),
        comments,
      },
    ])[0];
  }

  return {
    async getCanonicalRepositoryIdentity() {
      return resolveRepoFullName(cwd);
    },

    async createIssue(input) {
      // Older gh (e.g. 2.45) does not support `gh issue create --json`.
      // Write body via file and parse the issue URL from stdout.
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "matt-auto-issue-"));
      const bodyFile = path.join(tmpDir, "body.md");
      try {
        await writeFile(bodyFile, input.body, "utf8");
        const args = [
          "issue",
          "create",
          "--title",
          input.title,
          "--body-file",
          bodyFile,
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

        const number = parseIssueNumberFromCreateOutput(result.stdout);
        if (number === undefined) {
          throw new Error(
            `gh issue create did not return a recognizable issue URL. Output: ${result.stdout.trim()}`,
          );
        }
        return { number };
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
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

    async findActiveWorkflows(target) {
      return discoverActiveWorkflows(target);
    },

    async findActiveWorkflowsForRepository(repository) {
      return discoverActiveWorkflowsForRepository(repository);
    },

    async findActiveWorkflow(targetBranch, hintWorkflowId) {
      const targetRef = targetRefFromBranch(targetBranch);
      const repository = await resolveRepoFullName(cwd);
      if (!targetRef || !repository) return undefined;
      const target: CanonicalTargetIdentity = { repository, targetRef };

      // A legacy local pointer remains a direct, explicit lookup. It never
      // causes a parallel workflow to be selected by position in a result list.
      if (typeof hintWorkflowId === "number" && hintWorkflowId > 0) {
        const hinted = await loadActiveWorkflowById(target, hintWorkflowId);
        if (hinted) return hinted;
      }

      try {
        const active = await discoverActiveWorkflows(target);
        // Legacy routing has no explicit binding. Preserve its behavior only
        // when exactly one workflow exists; do not pick an arbitrary sibling.
        return active.length === 1 ? active[0] : undefined;
      } catch {
        return undefined;
      }
    },

    async listTickets(issueNumbers) {
      if (issueNumbers.length === 0) return [];

      const repo = await resolveRepoFullName(cwd);
      if (!repo) return [];

      type IssueNode = {
        number: number;
        title: string;
        state: string;
        blockedBy?: { nodes?: Array<{ number: number; state: string }> };
      };

      const tickets: TrackerTicket[] = [];
      // One GraphQL request per chunk instead of one request per issue.
      for (const chunk of chunkIssueNumbers(issueNumbers)) {
        const query = buildBatchedListTicketsQuery(
          repo.owner,
          repo.name,
          chunk,
        );
        const result = await run(cwd, "gh", [
          "api",
          "graphql",
          "-f",
          `query=${query}`,
        ]);
        if (result.code !== 0) {
          const detail = `${result.stderr}
${result.stdout}`;
          if (isGraphqlRateLimitMessage(detail)) {
            noteGraphqlRateLimit(detail);
            // Fail the whole listTickets so callers can keep stale cache.
            throw new Error(
              result.stderr.trim() ||
                "GitHub GraphQL API rate limit exceeded while listing tickets.",
            );
          }
          continue;
        }
        try {
          const parsed = JSON.parse(result.stdout) as {
            data?: {
              repository?: Record<string, IssueNode | null | undefined>;
            };
          };
          const repository = parsed.data?.repository;
          if (!repository) continue;
          for (let index = 0; index < chunk.length; index += 1) {
            const issue = repository[`i${index}`];
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
          }
        } catch {
          // skip malformed chunk
        }
      }
      // Stable order matching input numbers when present.
      const byNumber = new Map(tickets.map((t) => [t.number, t]));
      return issueNumbers
        .map((n) => byNumber.get(n))
        .filter((t): t is TrackerTicket => t !== undefined);
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

    async closeIssue(issueNumber, options) {
      const args = [
        "issue",
        "close",
        String(issueNumber),
        "--reason",
        "completed",
      ];
      if (options?.comment && options.comment.trim()) {
        args.push("--comment", options.comment.trim());
      }
      const result = await run(cwd, "gh", args);
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || "").trim();
        // Idempotent: already-closed parent is success for cleanup completion.
        if (/already closed|not open|is closed/i.test(detail)) {
          return;
        }
        throw new Error(
          detail ||
            `gh issue close failed for #${issueNumber} with exit code ${result.code}`,
        );
      }
    },

    async reopenIssue(issueNumber) {
      const result = await run(cwd, "gh", [
        "issue",
        "reopen",
        String(issueNumber),
      ]);
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `gh issue reopen failed for #${issueNumber} with exit code ${result.code}`,
        );
      }
    },

    async createPullRequest(input) {
      // Older gh (e.g. 2.45) does not support `gh pr create --json`.
      // Write body via file and parse the PR URL from stdout.
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "matt-auto-pr-"));
      const bodyFile = path.join(tmpDir, "body.md");
      try {
        await writeFile(bodyFile, input.body, "utf8");
        const result = await run(cwd, "gh", [
          "pr",
          "create",
          "--base",
          input.base,
          "--head",
          input.head,
          "--title",
          input.title,
          "--body-file",
          bodyFile,
        ]);
        if (result.code !== 0) {
          throw new Error(
            result.stderr.trim() ||
              `gh pr create failed with exit code ${result.code}`,
          );
        }
        const parsed = parsePullRequestFromCreateOutput(result.stdout);
        if (!parsed) {
          throw new Error(
            `gh pr create did not return a recognizable pull request URL. Output: ${result.stdout.trim()}`,
          );
        }
        return { number: parsed.number, url: parsed.url };
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async inspectProtectedBranchAutomation(input) {
      return inspectProtectedBranchAutomation(cwd, input.targetBranch);
    },

    async getPullRequestFreshness(input) {
      const result = await run(cwd, "gh", [
        "pr",
        "view",
        String(input.number),
        "--json",
        "headRefOid,baseRefOid,mergeable",
      ]);
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `gh pr view failed for #${input.number} with exit code ${result.code}`,
        );
      }
      let parsed: {
        headRefOid?: string;
        baseRefOid?: string;
        mergeable?: string | boolean;
      };
      try {
        parsed = JSON.parse(result.stdout) as {
          headRefOid?: string;
          baseRefOid?: string;
          mergeable?: string | boolean;
        };
      } catch {
        throw new Error(
          `gh pr view returned non-JSON output for #${input.number}`,
        );
      }
      if (!isGitObjectId(parsed.headRefOid) || !isGitObjectId(parsed.baseRefOid)) {
        throw new Error(
          `gh pr view did not return exact head/base SHAs for #${input.number}`,
        );
      }
      const mergeable =
        parsed.mergeable === true ||
        (typeof parsed.mergeable === "string" &&
          parsed.mergeable.toUpperCase() === "MERGEABLE");
      return {
        headSha: parsed.headRefOid.toLowerCase(),
        baseSha: parsed.baseRefOid.toLowerCase(),
        ...(parsed.mergeable !== undefined ? { mergeable } : {}),
      };
    },

    async mergePullRequest(input) {
      if (!input.mergeMethod) {
        throw new Error(
          `Cannot merge Workflow PR #${input.number}: repository-configured merge method is required; Matt Auto does not hard-code a merge strategy.`,
        );
      }
      const methodFlag =
        input.mergeMethod === "squash"
          ? "--squash"
          : input.mergeMethod === "rebase"
            ? "--rebase"
            : "--merge";
      const args = ["pr", "merge", String(input.number), methodFlag];
      if (input.expectedHeadSha) {
        if (!isGitObjectId(input.expectedHeadSha)) {
          throw new Error(
            `Cannot merge Workflow PR #${input.number}: expected head SHA is not a valid Git object ID.`,
          );
        }
        args.push("--match-head-commit", input.expectedHeadSha);
      }
      // expectedTargetSha is enforced by the coordinator before this call;
      // GitHub's merge API does not accept an expected base OID.
      const result = await run(cwd, "gh", args);
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `gh pr merge failed for #${input.number} with exit code ${result.code}`,
        );
      }
    },
  };
}

type GhRepoSettings = {
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
  permissions?: { push?: boolean; admin?: boolean; maintain?: boolean };
  viewerPermission?: string;
};

type GhBranchProtection = {
  required_status_checks?: {
    strict?: boolean;
    contexts?: string[];
    checks?: Array<{ context?: string }>;
  } | null;
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
  } | null;
  allow_force_pushes?: { enabled?: boolean } | boolean | null;
};

async function inspectProtectedBranchAutomation(
  cwd: string,
  targetBranch: string,
): Promise<ProtectedBranchAutomationPolicy> {
  const repository = await resolveRepoFullName(cwd);
  const policy: ProtectedBranchAutomationPolicy = {};
  if (repository) {
    policy.repository = repository;
    const targetRef = targetRefFromBranch(targetBranch);
    if (targetRef) policy.targetRef = targetRef;
  }

  const repoResult = await run(cwd, "gh", [
    "api",
    "repos/{owner}/{repo}",
    "--jq",
    "{allow_merge_commit,allow_squash_merge,allow_rebase_merge,permissions,viewerPermission:.viewerPermission}",
  ]);
  if (repoResult.code === 0) {
    try {
      const repo = JSON.parse(repoResult.stdout) as GhRepoSettings;
      const allowed: WorkflowMergeMethod[] = [];
      if (repo.allow_merge_commit) allowed.push("merge");
      if (repo.allow_squash_merge) allowed.push("squash");
      if (repo.allow_rebase_merge) allowed.push("rebase");
      policy.allowedMergeMethods = allowed;
      // Prefer squash when available (common protected-branch default), else
      // the single allowed method / deterministic order handled by the evaluator.
      if (allowed.includes("squash")) {
        policy.preferredMergeMethod = "squash";
      } else if (allowed.length === 1 && allowed[0]) {
        policy.preferredMergeMethod = allowed[0];
      }
      const push =
        repo.permissions?.push === true ||
        repo.permissions?.admin === true ||
        repo.permissions?.maintain === true;
      policy.actorCanMergeWithoutApproval = push;
    } catch {
      // Fall through with incomplete observations; evaluator fail-closes.
    }
  }

  const protectionResult = await run(cwd, "gh", [
    "api",
    `repos/{owner}/{repo}/branches/${encodeURIComponent(targetBranch)}/protection`,
  ]);
  if (protectionResult.code === 0) {
    try {
      const protection = JSON.parse(protectionResult.stdout) as GhBranchProtection;
      const contexts = [
        ...(protection.required_status_checks?.contexts ?? []),
        ...((protection.required_status_checks?.checks ?? [])
          .map((check) => check.context)
          .filter((context): context is string => typeof context === "string") ??
          []),
      ];
      const uniqueContexts = [...new Set(contexts)];
      if (protection.required_status_checks) {
        policy.requiredStatusChecks = {
          strict: protection.required_status_checks.strict === true,
          contexts: uniqueContexts,
        };
        policy.staleBaseProtectionGuaranteed =
          protection.required_status_checks.strict === true &&
          uniqueContexts.length > 0;
        policy.branchProtectionObservation =
          policy.staleBaseProtectionGuaranteed === true
            ? "strict"
            : "configured-non-strict";
      } else {
        // Classic protection exists without required status checks.
        policy.branchProtectionObservation = "configured-non-strict";
      }
      const approvals =
        protection.required_pull_request_reviews?.required_approving_review_count;
      if (typeof approvals === "number") {
        policy.requiredApprovingReviewCount = approvals;
        if (approvals > 0) {
          policy.actorCanMergeWithoutApproval = false;
        }
      }
    } catch {
      policy.branchProtectionObservation = "unknown-error";
    }
  } else {
    const detail = `${protectionResult.stderr}
${protectionResult.stdout}`;
    const protectionPlanLimited = isGithubPlanLimitedProtectionError(detail);
    const protectionAbsent = /404|Not Found|Branch not protected/i.test(detail);

    // Probe rulesets when classic protection is absent or plan-limited.
    const rulesResult = await run(cwd, "gh", [
      "api",
      `repos/{owner}/{repo}/rules/branches/${encodeURIComponent(targetBranch)}`,
    ]);
    if (rulesResult.code === 0) {
      try {
        const rules = JSON.parse(rulesResult.stdout) as Array<{
          type?: string;
          parameters?: {
            required_status_checks?: Array<{ context?: string }>;
            strict_required_status_checks_policy?: boolean;
            required_approving_review_count?: number;
          };
        }>;
        if (Array.isArray(rules)) {
          if (rules.some((rule) => rule.type === "merge_queue")) {
            policy.mergeQueueRequired = true;
          }
          const checkRule = rules.find(
            (rule) => rule.type === "required_status_checks",
          );
          if (checkRule?.parameters) {
            const contexts = (checkRule.parameters.required_status_checks ?? [])
              .map((entry) => entry.context)
              .filter((context): context is string => typeof context === "string");
            const strict =
              checkRule.parameters.strict_required_status_checks_policy === true;
            policy.requiredStatusChecks = { strict, contexts };
            policy.staleBaseProtectionGuaranteed =
              strict && contexts.length > 0;
            policy.branchProtectionObservation =
              policy.staleBaseProtectionGuaranteed === true
                ? "strict"
                : "configured-non-strict";
          } else if (rules.length === 0) {
            policy.branchProtectionObservation = protectionPlanLimited
              ? "plan-limited"
              : "absent";
          } else if (!policy.branchProtectionObservation) {
            // Rules exist but none encode required status checks.
            policy.branchProtectionObservation = "configured-non-strict";
          }
          const reviewRule = rules.find(
            (rule) => rule.type === "pull_request",
          );
          const approvals =
            reviewRule?.parameters?.required_approving_review_count;
          if (typeof approvals === "number") {
            policy.requiredApprovingReviewCount = approvals;
            if (approvals > 0) {
              policy.actorCanMergeWithoutApproval = false;
            }
          }
        }
      } catch {
        policy.branchProtectionObservation =
          policy.branchProtectionObservation ?? "unknown-error";
      }
    } else {
      const rulesDetail = `${rulesResult.stderr}
${rulesResult.stdout}`;
      if (
        protectionPlanLimited ||
        isGithubPlanLimitedProtectionError(rulesDetail)
      ) {
        policy.branchProtectionObservation = "plan-limited";
      } else if (protectionAbsent || /404|Not Found/i.test(rulesDetail)) {
        policy.branchProtectionObservation = "absent";
      } else {
        policy.branchProtectionObservation = "unknown-error";
      }
    }

    if (!policy.branchProtectionObservation) {
      if (protectionPlanLimited) {
        policy.branchProtectionObservation = "plan-limited";
      } else if (protectionAbsent) {
        policy.branchProtectionObservation = "absent";
      } else {
        policy.branchProtectionObservation = "unknown-error";
      }
    }
  }

  return policy;
}

/** True when GitHub refuses protection/ruleset APIs due to plan/visibility limits. */
function isGithubPlanLimitedProtectionError(detail: string): boolean {
  return (
    /403/i.test(detail) &&
    (/Upgrade to GitHub Pro/i.test(detail) ||
      /make this repository public/i.test(detail) ||
      /not available/i.test(detail) ||
      /Upgrade to GitHub/i.test(detail))
  );
}
