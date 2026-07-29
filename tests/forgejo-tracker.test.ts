import { describe, expect, it } from "vitest";
import { createForgejoTrackerPort } from "../src/adapters/forgejo-tracker.js";
import type {
  ForgejoApiClient,
  ForgejoRequest,
} from "../src/adapters/forgejo-api.js";
import type { ForgejoConnection } from "../src/adapters/forge.js";
import { formatWorkflowManifestComment } from "../src/adapters/workflow-manifest.js";
import type { CoordinationWorkflowManifest } from "../src/types.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const connection: ForgejoConnection = {
  provider: "forgejo",
  baseUrl: "http://localhost:3002",
  owner: "a5345534",
  name: "matt-skills-ops",
  remoteName: "origin",
  tokenEnv: "MATT_AUTO_FORGEJO_TOKEN",
};

const repository = {
  owner: "a5345534",
  name: "matt-skills-ops",
  forge: { provider: "forgejo" as const, baseUrl: "http://localhost:3002" },
};

const workerProfile = {
  provider: "openai-codex",
  modelId: "gpt-5.6-terra",
  thinkingLevel: "max",
};

function manifest(workflowId: number): CoordinationWorkflowManifest {
  return {
    schema: "matt-auto/workflow-manifest",
    version: 2,
    workflowId,
    targetBranch: "main",
    stage: "tickets-published",
    workerProfile,
    tickets: [11, 12],
    coordination: {
      target: { repository, targetRef: "refs/heads/main" },
    },
  };
}

type Call = { kind: "request" | "list"; input: ForgejoRequest };

function fakeApi(input: {
  request?: (request: ForgejoRequest) => unknown | Promise<unknown>;
  list?: (request: ForgejoRequest) => readonly unknown[] | Promise<readonly unknown[]>;
}): { api: ForgejoApiClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    api: {
      async request<T>(request: ForgejoRequest): Promise<T> {
        calls.push({ kind: "request", input: request });
        return (await input.request?.(request)) as T;
      },
      async list<T>(request: ForgejoRequest): Promise<readonly T[]> {
        calls.push({ kind: "list", input: request });
        return (await input.list?.(request) ?? []) as readonly T[];
      },
    },
  };
}

describe("Forgejo TrackerPort", () => {
  it("creates issues with resolved Forgejo label ids and exposes a forge-aware identity", async () => {
    const fake = fakeApi({
      list: (request) =>
        request.path.endsWith("/labels")
          ? [{ id: 7, name: "ready-for-agent" }]
          : [],
      request: (request) =>
        request.path.endsWith("/issues")
          ? { number: 41 }
          : undefined,
    });
    const tracker = createForgejoTrackerPort(connection, { api: fake.api });

    await expect(tracker.getCanonicalRepositoryIdentity?.()).resolves.toEqual(
      repository,
    );
    await expect(
      tracker.createIssue({
        title: "Workflow spec",
        body: "body",
        labels: ["ready-for-agent"],
      }),
    ).resolves.toEqual({ number: 41 });
    expect(fake.calls).toContainEqual({
      kind: "request",
      input: expect.objectContaining({
        method: "POST",
        path: "repos/a5345534/matt-skills-ops/issues",
        body: { title: "Workflow spec", body: "body", labels: [7] },
      }),
    });
  });

  it("discovers Forgejo manifest workflows and preserves the forge identity", async () => {
    const body = formatWorkflowManifestComment(manifest(40));
    const fake = fakeApi({
      list: (request) => {
        if (request.path.endsWith("/issues")) {
          return [{ number: 40, title: "Workflow", state: "open" }];
        }
        if (request.path.endsWith("/issues/40/comments")) {
          return [{ id: 5, body }];
        }
        return [];
      },
    });
    const tracker = createForgejoTrackerPort(connection, { api: fake.api });

    await expect(
      tracker.findActiveWorkflows({
        repository,
        targetRef: "refs/heads/main",
      }),
    ).resolves.toMatchObject([{ workflowId: 40, coordination: { target: { repository } } }]);
  });

  it("uses Forgejo dependencies for blocked-by frontier facts and treats sub-issues as manifest-only", async () => {
    const fake = fakeApi({
      request: (request) => {
        if (request.path.endsWith("/issues/11")) {
          return { number: 11, title: "Blocked ticket", state: "open" };
        }
        if (request.path.endsWith("/issues/12")) {
          return { number: 12, title: "Closed ticket", state: "closed" };
        }
        return undefined;
      },
      list: (request) => {
        if (request.path.endsWith("/issues/11/dependencies")) {
          return [{ number: 12, state: "closed" }];
        }
        if (request.path.endsWith("/issues/12/dependencies")) return [];
        return [];
      },
    });
    const tracker = createForgejoTrackerPort(connection, { api: fake.api });

    await expect(tracker.listTickets([11, 12])).resolves.toEqual([
      {
        number: 11,
        title: "Blocked ticket",
        state: "OPEN",
        blockedBy: [{ number: 12, state: "CLOSED" }],
      },
      {
        number: 12,
        title: "Closed ticket",
        state: "CLOSED",
        blockedBy: [],
      },
    ]);

    const before = fake.calls.length;
    await tracker.addSubIssue(40, 11);
    expect(fake.calls).toHaveLength(before);

    await tracker.addBlockedBy(11, 12);
    expect(fake.calls.at(-1)).toEqual({
      kind: "request",
      input: expect.objectContaining({
        method: "POST",
        path: "repos/a5345534/matt-skills-ops/issues/11/dependencies",
        body: { owner: "a5345534", repo: "matt-skills-ops", index: 12 },
      }),
    });
  });

  it("maps protected Forgejo branch facts into strict merge policy", async () => {
    const fake = fakeApi({
      request: (request) => {
        if (request.path === "repos/a5345534/matt-skills-ops") {
          return {
            allow_merge_commits: true,
            allow_squash_merge: true,
            allow_rebase: false,
            permissions: { push: true },
          };
        }
        if (request.path.endsWith("/branches/main")) {
          return {
            protected: true,
            user_can_merge: true,
            required_approvals: 0,
            enable_status_check: true,
            status_check_contexts: ["verify"],
            effective_branch_protection_name: "main",
          };
        }
        return undefined;
      },
      list: (request) =>
        request.path.endsWith("/branch_protections")
          ? [{ rule_name: "main", block_on_outdated_branch: true }]
          : [],
    });
    const tracker = createForgejoTrackerPort(connection, { api: fake.api });

    await expect(
      tracker.inspectProtectedBranchAutomation?.({ targetBranch: "main" }),
    ).resolves.toMatchObject({
      repository,
      targetRef: "refs/heads/main",
      allowedMergeMethods: ["merge", "squash"],
      preferredMergeMethod: "squash",
      actorCanMergeWithoutApproval: true,
      requiredStatusChecks: { strict: true, contexts: ["verify"] },
      staleBaseProtectionGuaranteed: true,
      branchProtectionObservation: "strict",
    });
  });

  it("uses Forgejo merge head_commit_id fencing and live PR SHAs", async () => {
    const fake = fakeApi({
      request: (request) => {
        if (request.path.endsWith("/pulls/55") && request.method === undefined) {
          return { head: { sha: HEAD }, base: { sha: BASE }, mergeable: true };
        }
        return {};
      },
    });
    const tracker = createForgejoTrackerPort(connection, { api: fake.api });

    await expect(tracker.getPullRequestFreshness?.({ number: 55 })).resolves.toEqual({
      headSha: HEAD,
      baseSha: BASE,
      mergeable: true,
    });
    await tracker.mergePullRequest({
      number: 55,
      mergeMethod: "squash",
      expectedHeadSha: HEAD,
    });
    expect(fake.calls.at(-1)).toEqual({
      kind: "request",
      input: expect.objectContaining({
        method: "POST",
        path: "repos/a5345534/matt-skills-ops/pulls/55/merge",
        body: { Do: "squash", head_commit_id: HEAD },
      }),
    });
  });
});
