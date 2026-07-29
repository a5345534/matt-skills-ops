import { describe, expect, it } from "vitest";
import {
  canonicalRepositoryIdentityKey,
  canonicalTargetIdentityKey,
  isCanonicalTargetIdentity,
  targetBranchFromRef,
  targetRefFromBranch,
} from "../src/coordination.js";
import {
  activeWorkflowsFromIssues,
  coordinatedActiveWorkflowsFromIssues,
  formatWorkflowManifestComment,
  parseWorkflowManifestComment,
  workflowManifestMatchesTarget,
} from "../src/adapters/tracker.js";
import { WORKFLOW_MANIFEST_MARKER } from "../src/constants.js";
import type {
  CanonicalTargetIdentity,
  CoordinationWorkflowManifest,
  LegacyWorkflowManifest,
  WorkerProfile,
} from "../src/types.js";

const workerProfile: WorkerProfile = {
  provider: "openai-codex",
  modelId: "gpt-5.6-terra",
  thinkingLevel: "max",
};

const target: CanonicalTargetIdentity = {
  repository: { owner: "Acme", name: "workflow-tools" },
  targetRef: "refs/heads/main",
};

const headSha = "a".repeat(40);
const targetSha = "b".repeat(40);

function legacyManifest(workflowId: number): LegacyWorkflowManifest {
  return {
    schema: "matt-auto/workflow-manifest",
    version: 1,
    workflowId,
    targetBranch: "main",
    stage: "pr-opened",
    workerProfile,
    tickets: [101, 102],
    integrationBranch: `matt-auto/${workflowId}/integration`,
    integratedTickets: [
      {
        number: 101,
        attempt: 1,
        branchName: `matt-auto/${workflowId}/ticket-101/r1`,
      },
    ],
    workflowPr: {
      number: 500,
      url: "https://github.com/Acme/workflow-tools/pull/500",
      headBranch: `matt-auto/${workflowId}/integration`,
      baseBranch: "main",
    },
    followUpOf: 7,
  };
}

function coordinatedManifest(
  workflowId: number,
): CoordinationWorkflowManifest {
  return {
    schema: "matt-auto/workflow-manifest",
    version: 2,
    workflowId,
    targetBranch: "main",
    stage: "pr-opened",
    workerProfile,
    workflowPr: {
      number: 600,
      headBranch: `matt-auto/${workflowId}/integration`,
      baseBranch: "main",
    },
    coordination: {
      target,
      prFreshness: {
        headSha,
        validatedTargetSha: targetSha,
        mergeMethod: "squash",
      },
      queueCandidate: {
        state: "transient-retry",
        retry: {
          reason: "github-api-timeout",
          attempt: 1,
          maxAttempts: 3,
          failedAt: "2026-07-28T16:00:00.000Z",
          nextRetryAt: "2026-07-28T16:05:00.000Z",
        },
      },
      observedLeaseGenerations: {
        workflowCoordinator: 3,
        targetBranch: 7,
        repositoryScheduler: 11,
        workerSlot: 4,
      },
    },
  };
}

function manifestComment(value: unknown): string {
  return `${WORKFLOW_MANIFEST_MARKER}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

describe("canonical coordination identity", () => {
  it("uses GitHub owner/name and a fully qualified branch ref", () => {
    expect(isCanonicalTargetIdentity(target)).toBe(true);
    expect(targetRefFromBranch("release/2026.07")).toBe(
      "refs/heads/release/2026.07",
    );
    expect(targetRefFromBranch("refs/heads/main")).toBeUndefined();
    expect(targetBranchFromRef("refs/heads/release/2026.07")).toBe(
      "release/2026.07",
    );
    expect(targetBranchFromRef("origin/main")).toBeUndefined();
    expect(
      canonicalRepositoryIdentityKey({ owner: "ACME", name: "Workflow-Tools" }),
    ).toBe("acme/workflow-tools");
    expect(canonicalTargetIdentityKey(target)).toBe(
      "acme/workflow-tools:refs/heads/main",
    );
  });

  it("rejects paths, aliases, and bare branch names as a canonical Target", () => {
    expect(
      isCanonicalTargetIdentity({
        repository: { owner: "acme/workflow-tools", name: "ignored" },
        targetRef: "refs/heads/main",
      }),
    ).toBe(false);
    expect(
      isCanonicalTargetIdentity({
        repository: { owner: "acme", name: "workflow-tools" },
        targetRef: "main",
      }),
    ).toBe(false);
  });
});

describe("Workflow manifest parser", () => {
  it("round-trips the complete legacy v1 shape without migration", () => {
    const manifest = legacyManifest(39);

    expect(parseWorkflowManifestComment(formatWorkflowManifestComment(manifest))).toEqual(
      manifest,
    );
  });

  it("parses a coordination-aware v2 manifest with freshness, queue, retry, and lease facts", () => {
    const manifest = coordinatedManifest(40);

    expect(parseWorkflowManifestComment(formatWorkflowManifestComment(manifest))).toEqual(
      manifest,
    );
  });

  it.each([
    [
      "a bare canonical Target ref",
      {
        ...coordinatedManifest(40),
        coordination: {
          ...coordinatedManifest(40).coordination,
          target: { ...target, targetRef: "main" },
        },
      },
    ],
    [
      "a Target ref that disagrees with the retained legacy target branch",
      {
        ...coordinatedManifest(40),
        coordination: {
          ...coordinatedManifest(40).coordination,
          target: { ...target, targetRef: "refs/heads/develop" },
        },
      },
    ],
    [
      "a malformed PR head object ID",
      {
        ...coordinatedManifest(40),
        coordination: {
          ...coordinatedManifest(40).coordination,
          prFreshness: {
            ...coordinatedManifest(40).coordination.prFreshness!,
            headSha: "short",
          },
        },
      },
    ],
    [
      "an exhausted transient retry that exceeds its bounded budget",
      {
        ...coordinatedManifest(40),
        coordination: {
          ...coordinatedManifest(40).coordination,
          queueCandidate: {
            state: "transient-retry",
            retry: {
              reason: "github-api-timeout",
              attempt: 4,
              maxAttempts: 3,
              failedAt: "2026-07-28T16:00:00.000Z",
              nextRetryAt: "2026-07-28T16:05:00.000Z",
            },
          },
        },
      },
    ],
    [
      "queue state without the PR freshness fact it requires",
      {
        ...coordinatedManifest(40),
        coordination: {
          target,
          queueCandidate: { state: "awaiting-pr-checks" },
        },
      },
    ],
    [
      "malformed optional legacy fields",
      { ...legacyManifest(39), tickets: ["not-an-issue-number"] },
    ],
  ])("rejects %s", (_description, manifest) => {
    expect(parseWorkflowManifestComment(manifestComment(manifest))).toBeUndefined();
  });
});

describe("Active workflow discovery projection", () => {
  it("returns every matching legacy and coordination-aware manifest without a first-match fallback", () => {
    const legacy = legacyManifest(39);
    const coordinated = coordinatedManifest(40);
    const otherRepository: CoordinationWorkflowManifest = {
      ...coordinatedManifest(41),
      coordination: {
        ...coordinatedManifest(41).coordination,
        target: {
          repository: { owner: "other", name: "repo" },
          targetRef: "refs/heads/main",
        },
      },
    };
    const completed: LegacyWorkflowManifest = {
      ...legacyManifest(42),
      stage: "completed",
    };

    const active = activeWorkflowsFromIssues(target, [
      { number: 39, title: "Legacy", state: "OPEN", comments: [{ body: formatWorkflowManifestComment(legacy) }] },
      { number: 40, title: "Coordinated", state: "OPEN", comments: [{ body: formatWorkflowManifestComment(coordinated) }] },
      { number: 41, state: "OPEN", comments: [{ body: formatWorkflowManifestComment(otherRepository) }] },
      { number: 42, state: "OPEN", comments: [{ body: formatWorkflowManifestComment(completed) }] },
      {
        number: 43,
        state: "OPEN",
        comments: [
          { body: formatWorkflowManifestComment(legacyManifest(43)) },
          { body: manifestComment({ schema: "matt-auto/workflow-manifest", version: 2 }) },
        ],
      },
    ]);

    expect(active.map((workflow) => workflow.workflowId)).toEqual([39, 40]);
    expect(active[0]?.title).toBe("Legacy");
    expect(active[1]?.coordination?.target).toEqual(target);
    expect(workflowManifestMatchesTarget(legacy, target)).toBe(true);
    expect(workflowManifestMatchesTarget(coordinated, target)).toBe(true);
    expect(workflowManifestMatchesTarget(otherRepository, target)).toBe(false);
  });

  it("finds coordination-aware workflows across Target branches for repository scheduling", () => {
    const main = coordinatedManifest(40);
    const release: CoordinationWorkflowManifest = {
      ...coordinatedManifest(41),
      targetBranch: "release/2026.07",
      workflowPr: {
        ...coordinatedManifest(41).workflowPr!,
        baseBranch: "release/2026.07",
      },
      coordination: {
        ...coordinatedManifest(41).coordination,
        target: {
          repository: target.repository,
          targetRef: "refs/heads/release/2026.07",
        },
      },
    };

    const active = coordinatedActiveWorkflowsFromIssues(target.repository, [
      {
        number: 39,
        state: "OPEN",
        comments: [{ body: formatWorkflowManifestComment(legacyManifest(39)) }],
      },
      {
        number: 40,
        state: "OPEN",
        comments: [{ body: formatWorkflowManifestComment(main) }],
      },
      {
        number: 41,
        state: "OPEN",
        comments: [{ body: formatWorkflowManifestComment(release) }],
      },
    ]);

    expect(active.map((workflow) => workflow.workflowId)).toEqual([40, 41]);
  });
});
