import { canonicalRepositoryIdentityKey, targetRefFromBranch } from "../coordination.js";
import type { TrackerPort, TrackerTicket } from "../ports.js";
import type {
  ActiveWorkflow,
  CanonicalRepositoryIdentity,
  CanonicalTargetIdentity,
  WorkflowMergeMethod,
} from "../types.js";
import { isGitObjectId } from "../workflow-pr-guard.js";
import type { ProtectedBranchAutomationPolicy } from "../workflow-pr-guard.js";
import {
  activeWorkflowsFromIssues,
  coordinatedActiveWorkflowsFromIssues,
  formatWorkflowManifestComment,
  type WorkflowManifestIssue,
} from "./workflow-manifest.js";
import {
  createForgejoApiClient,
  ForgejoApiError,
  type ForgejoApiClient,
} from "./forgejo-api.js";
import type { ForgejoConnection } from "./forge.js";
import { WORKFLOW_MANIFEST_MARKER } from "../constants.js";

export type ForgejoTrackerPortOptions = {
  api?: ForgejoApiClient;
};

type ForgejoIssue = {
  number?: unknown;
  title?: unknown;
  state?: unknown;
};

type ForgejoComment = {
  id?: unknown;
  body?: unknown;
};

type ForgejoLabel = {
  id?: unknown;
  name?: unknown;
};

type ForgejoRepository = {
  allow_merge_commits?: unknown;
  allow_squash_merge?: unknown;
  allow_rebase?: unknown;
  permissions?: { admin?: unknown; push?: unknown };
};

type ForgejoBranch = {
  protected?: unknown;
  user_can_merge?: unknown;
  required_approvals?: unknown;
  enable_status_check?: unknown;
  status_check_contexts?: unknown;
  effective_branch_protection_name?: unknown;
};

type ForgejoBranchProtection = {
  rule_name?: unknown;
  branch_name?: unknown;
  block_on_outdated_branch?: unknown;
};

type ForgejoPullRequest = {
  number?: unknown;
  html_url?: unknown;
  head?: { sha?: unknown };
  base?: { sha?: unknown };
  mergeable?: unknown;
};

function repositoryPath(connection: ForgejoConnection): string {
  return `repos/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.name)}`;
}

function canonicalRepository(
  connection: ForgejoConnection,
): CanonicalRepositoryIdentity {
  return {
    owner: connection.owner,
    name: connection.name,
    forge: { provider: "forgejo", baseUrl: connection.baseUrl },
  };
}

function sameRepository(
  left: CanonicalRepositoryIdentity,
  right: CanonicalRepositoryIdentity,
): boolean {
  return canonicalRepositoryIdentityKey(left) === canonicalRepositoryIdentityKey(right);
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function openOrClosed(value: unknown): "OPEN" | "CLOSED" {
  return typeof value === "string" && value.toLowerCase() === "closed"
    ? "CLOSED"
    : "OPEN";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  if (inputs.length === 0) return [];
  const results: Output[] = new Array(inputs.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(inputs[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, worker),
  );
  return results;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ForgejoApiError && error.status === 404;
}

/**
 * Forgejo REST implementation of the tracker boundary.
 *
 * Forgejo 12 exposes native issue dependency/block APIs but no native
 * sub-issue REST endpoint. The managed Workflow manifest remains the durable
 * membership authority, so `addSubIssue` deliberately succeeds as a no-op.
 */
export function createForgejoTrackerPort(
  connection: ForgejoConnection,
  options: ForgejoTrackerPortOptions = {},
): TrackerPort {
  const api = options.api ?? createForgejoApiClient(connection);
  const repository = canonicalRepository(connection);
  const repoPath = repositoryPath(connection);
  const labelIds = new Map<string, number>();

  async function resolveLabelIds(names: readonly string[]): Promise<number[]> {
    if (names.length === 0) return [];
    const missing = names.filter((name) => !labelIds.has(name));
    if (missing.length > 0) {
      const labels = await api.list<ForgejoLabel>({ path: `${repoPath}/labels` });
      for (const label of labels) {
        const id = numberFrom(label.id);
        if (id && typeof label.name === "string") labelIds.set(label.name, id);
      }
    }
    const unresolved = names.filter((name) => !labelIds.has(name));
    if (unresolved.length > 0) {
      throw new Error(
        `Forgejo label(s) ${unresolved.map((label) => JSON.stringify(label)).join(", ")} are missing on ${connection.owner}/${connection.name}. Create the labels explicitly; Matt Auto does not bootstrap tracker labels.`,
      );
    }
    return names.map((name) => labelIds.get(name)!);
  }

  async function loadIssueComments(
    issueNumber: number,
  ): Promise<readonly ForgejoComment[]> {
    return api.list<ForgejoComment>({
      path: `${repoPath}/issues/${issueNumber}/comments`,
    });
  }

  async function findManagedManifestComment(
    issueNumber: number,
  ): Promise<{ id: number } | undefined> {
    const comments = await loadIssueComments(issueNumber);
    for (let index = comments.length - 1; index >= 0; index -= 1) {
      const comment = comments[index];
      const id = numberFrom(comment?.id);
      if (
        id &&
        typeof comment?.body === "string" &&
        comment.body.includes(WORKFLOW_MANIFEST_MARKER)
      ) {
        return { id };
      }
    }
    return undefined;
  }

  async function listOpenWorkflowIssues(): Promise<readonly ForgejoIssue[]> {
    return api.list<ForgejoIssue>({
      path: `${repoPath}/issues`,
      query: { state: "open" },
    });
  }

  async function loadActiveWorkflowSnapshots(): Promise<readonly WorkflowManifestIssue[]> {
    const issues = await listOpenWorkflowIssues();
    const candidates = issues.flatMap((issue) => {
      const number = numberFrom(issue.number);
      if (!number) return [];
      return [{ number, issue }];
    });
    return mapWithConcurrency(candidates, 8, async ({ number, issue }) => ({
      number,
      ...(typeof issue.title === "string" ? { title: issue.title } : {}),
      ...(typeof issue.state === "string" ? { state: issue.state } : {}),
      comments: await loadIssueComments(number),
    }));
  }

  async function discoverActiveWorkflows(
    target: CanonicalTargetIdentity,
  ): Promise<readonly ActiveWorkflow[]> {
    if (!sameRepository(repository, target.repository)) return [];
    return activeWorkflowsFromIssues(target, await loadActiveWorkflowSnapshots());
  }

  async function loadActiveWorkflowById(
    target: CanonicalTargetIdentity,
    workflowId: number,
  ): Promise<ActiveWorkflow | undefined> {
    if (!sameRepository(repository, target.repository)) return undefined;
    try {
      const issue = await api.request<ForgejoIssue>({
        path: `${repoPath}/issues/${workflowId}`,
      });
      if (openOrClosed(issue.state) !== "OPEN") return undefined;
      const workflow = activeWorkflowsFromIssues(target, [
        {
          number: workflowId,
          ...(typeof issue.title === "string" ? { title: issue.title } : {}),
          ...(typeof issue.state === "string" ? { state: issue.state } : {}),
          comments: await loadIssueComments(workflowId),
        },
      ]);
      return workflow[0];
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async function inspectProtectedBranchAutomation(
    targetBranch: string,
  ): Promise<ProtectedBranchAutomationPolicy> {
    const policy: ProtectedBranchAutomationPolicy = {
      repository,
    };
    const targetRef = targetRefFromBranch(targetBranch);
    if (targetRef) policy.targetRef = targetRef;

    try {
      const repo = await api.request<ForgejoRepository>({ path: repoPath });
      const allowed: WorkflowMergeMethod[] = [];
      if (repo.allow_merge_commits === true) allowed.push("merge");
      if (repo.allow_squash_merge === true) allowed.push("squash");
      if (repo.allow_rebase === true) allowed.push("rebase");
      policy.allowedMergeMethods = allowed;
      if (allowed.includes("squash")) policy.preferredMergeMethod = "squash";
      else if (allowed.length === 1 && allowed[0]) {
        policy.preferredMergeMethod = allowed[0];
      }
      const canPush =
        repo.permissions?.admin === true || repo.permissions?.push === true;
      policy.actorCanMergeWithoutApproval = canPush;
    } catch {
      // The evaluator receives incomplete facts and fails closed at merge time.
    }

    let branch: ForgejoBranch | undefined;
    try {
      branch = await api.request<ForgejoBranch>({
        path: `${repoPath}/branches/${encodeURIComponent(targetBranch)}`,
      });
    } catch {
      policy.branchProtectionObservation = "unknown-error";
      return policy;
    }

    if (typeof branch.user_can_merge === "boolean") {
      policy.actorCanMergeWithoutApproval = branch.user_can_merge;
    }
    if (typeof branch.required_approvals === "number") {
      policy.requiredApprovingReviewCount = branch.required_approvals;
      if (branch.required_approvals > 0) {
        policy.actorCanMergeWithoutApproval = false;
      }
    }

    const contexts = stringList(branch.status_check_contexts);
    if (branch.enable_status_check === true) {
      policy.requiredStatusChecks = { strict: false, contexts };
    }
    if (branch.protected !== true) {
      policy.branchProtectionObservation = "absent";
      return policy;
    }

    try {
      const protections = await api.list<ForgejoBranchProtection>({
        path: `${repoPath}/branch_protections`,
      });
      const effectiveName =
        typeof branch.effective_branch_protection_name === "string"
          ? branch.effective_branch_protection_name
          : undefined;
      const protection = protections.find(
        (entry) =>
          entry.rule_name === effectiveName ||
          entry.branch_name === effectiveName ||
          entry.rule_name === targetBranch ||
          entry.branch_name === targetBranch,
      );
      const strict =
        branch.enable_status_check === true &&
        contexts.length > 0 &&
        protection?.block_on_outdated_branch === true;
      policy.requiredStatusChecks = {
        strict,
        contexts,
      };
      policy.staleBaseProtectionGuaranteed = strict;
      policy.branchProtectionObservation = strict
        ? "strict"
        : "configured-non-strict";
    } catch {
      policy.branchProtectionObservation = "unknown-error";
    }
    return policy;
  }

  return {
    async getCanonicalRepositoryIdentity() {
      return repository;
    },

    async createIssue(input) {
      const labels = await resolveLabelIds(input.labels);
      const created = await api.request<ForgejoIssue>({
        method: "POST",
        path: `${repoPath}/issues`,
        body: { title: input.title, body: input.body, labels },
      });
      const number = numberFrom(created.number);
      if (!number) {
        throw new Error("Forgejo issue creation did not return an issue number.");
      }
      return { number };
    },

    async writeWorkflowManifest(issueNumber, manifest) {
      const body = formatWorkflowManifestComment(manifest);
      const existing = await findManagedManifestComment(issueNumber);
      if (existing) {
        await api.request({
          method: "PATCH",
          path: `${repoPath}/issues/comments/${existing.id}`,
          body: { body },
        });
        return;
      }
      await api.request({
        method: "POST",
        path: `${repoPath}/issues/${issueNumber}/comments`,
        body: { body },
      });
    },

    async findActiveWorkflows(target) {
      return discoverActiveWorkflows(target);
    },

    async findActiveWorkflowsForRepository(requestedRepository) {
      if (!sameRepository(repository, requestedRepository)) return [];
      return coordinatedActiveWorkflowsFromIssues(
        repository,
        await loadActiveWorkflowSnapshots(),
      );
    },

    async findActiveWorkflow(targetBranch, hintWorkflowId) {
      const targetRef = targetRefFromBranch(targetBranch);
      if (!targetRef) return undefined;
      const target: CanonicalTargetIdentity = { repository, targetRef };
      if (typeof hintWorkflowId === "number" && hintWorkflowId > 0) {
        return loadActiveWorkflowById(target, hintWorkflowId);
      }
      const active = await discoverActiveWorkflows(target);
      return active.length === 1 ? active[0] : undefined;
    },

    async listTickets(issueNumbers) {
      return mapWithConcurrency<number, TrackerTicket | undefined>(
        issueNumbers,
        8,
        async (number) => {
        try {
          const [issue, dependencies] = await Promise.all([
            api.request<ForgejoIssue>({ path: `${repoPath}/issues/${number}` }),
            api.list<ForgejoIssue>({
              path: `${repoPath}/issues/${number}/dependencies`,
            }),
          ]);
          const issueNumber = numberFrom(issue.number);
          if (!issueNumber) return undefined;
          const ticket: TrackerTicket = {
            number: issueNumber,
            title: typeof issue.title === "string" ? issue.title : `Issue #${number}`,
            state: openOrClosed(issue.state),
            blockedBy: dependencies.flatMap((dependency) => {
              const blockerNumber = numberFrom(dependency.number);
              return blockerNumber
                ? [{ number: blockerNumber, state: openOrClosed(dependency.state) }]
                : [];
            }),
          };
          return ticket;
        } catch (error) {
          if (isNotFound(error)) return undefined;
          throw error;
        }
      },
      ).then((tickets) =>
        tickets.filter((ticket): ticket is TrackerTicket => ticket !== undefined),
      );
    },

    async addBlockedBy(issueNumber, blockerIssueNumber) {
      await api.request({
        method: "POST",
        path: `${repoPath}/issues/${issueNumber}/dependencies`,
        body: {
          owner: connection.owner,
          repo: connection.name,
          index: blockerIssueNumber,
        },
      });
    },

    async addSubIssue(_parentIssueNumber, _childIssueNumber) {
      // Forgejo v12 has no native sub-issue REST endpoint. Workflow membership
      // is already persisted atomically in the parent manifest before the
      // coordinator uses ticket frontier state, so no duplicate relationship is
      // invented in issue text or labels here.
    },

    async closeIssue(issueNumber, options) {
      if (options?.comment?.trim()) {
        await api.request({
          method: "POST",
          path: `${repoPath}/issues/${issueNumber}/comments`,
          body: { body: options.comment.trim() },
        });
      }
      try {
        await api.request({
          method: "PATCH",
          path: `${repoPath}/issues/${issueNumber}`,
          body: { state: "closed" },
        });
      } catch (error) {
        if (/already closed|is closed/i.test(String(error))) return;
        throw error;
      }
    },

    async reopenIssue(issueNumber) {
      await api.request({
        method: "PATCH",
        path: `${repoPath}/issues/${issueNumber}`,
        body: { state: "open" },
      });
    },

    async createPullRequest(input) {
      const created = await api.request<ForgejoPullRequest>({
        method: "POST",
        path: `${repoPath}/pulls`,
        body: {
          head: input.head,
          base: input.base,
          title: input.title,
          body: input.body,
        },
      });
      const number = numberFrom(created.number);
      if (!number) {
        throw new Error("Forgejo pull request creation did not return a number.");
      }
      return {
        number,
        ...(typeof created.html_url === "string" ? { url: created.html_url } : {}),
      };
    },

    async inspectProtectedBranchAutomation(input) {
      return inspectProtectedBranchAutomation(input.targetBranch);
    },

    async getPullRequestFreshness(input) {
      const pullRequest = await api.request<ForgejoPullRequest>({
        path: `${repoPath}/pulls/${input.number}`,
      });
      const headSha = pullRequest.head?.sha;
      const baseSha = pullRequest.base?.sha;
      if (!isGitObjectId(headSha) || !isGitObjectId(baseSha)) {
        throw new Error(
          `Forgejo pull request #${input.number} did not return exact head/base SHAs.`,
        );
      }
      return {
        headSha: headSha.toLowerCase(),
        baseSha: baseSha.toLowerCase(),
        ...(typeof pullRequest.mergeable === "boolean"
          ? { mergeable: pullRequest.mergeable }
          : {}),
      };
    },

    async mergePullRequest(input) {
      if (!input.mergeMethod) {
        throw new Error(
          `Cannot merge Workflow PR #${input.number}: repository-configured merge method is required.`,
        );
      }
      if (input.expectedHeadSha && !isGitObjectId(input.expectedHeadSha)) {
        throw new Error(
          `Cannot merge Workflow PR #${input.number}: expected head SHA is not a valid Git object ID.`,
        );
      }
      await api.request({
        method: "POST",
        path: `${repoPath}/pulls/${input.number}/merge`,
        body: {
          Do: input.mergeMethod,
          ...(input.expectedHeadSha
            ? { head_commit_id: input.expectedHeadSha }
            : {}),
        },
      });
    },
  };
}
