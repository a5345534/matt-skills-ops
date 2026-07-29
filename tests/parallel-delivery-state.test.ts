import { describe, expect, it } from "vitest";
import {
  buildParallelDeliveryPanelState,
  deriveParallelDeliveryWaitingState,
  formatParallelDeliveryBriefLines,
  formatParallelDeliveryCompactLines,
  formatParallelDeliveryWaitingState,
} from "../src/parallel-delivery-state.js";
import type {
  ActiveWorkflow,
  CanonicalTargetIdentity,
  WorkerSlotLease,
  WorkflowCoordinatorLease,
  TargetBranchLease,
} from "../src/types.js";

const target: CanonicalTargetIdentity = {
  repository: { owner: "Acme", name: "widgets" },
  targetRef: "refs/heads/main",
};

const profile = {
  provider: "openai-codex",
  modelId: "gpt-5.6-terra",
  thinkingLevel: "max",
} as const;

function coordinated(
  workflowId: number,
  overrides: {
    title?: string;
    stage?: ActiveWorkflow["stage"];
    workflowPr?: ActiveWorkflow["workflowPr"];
    queueCandidate?: NonNullable<
      ActiveWorkflow["coordination"]
    >["queueCandidate"];
    prFreshness?: NonNullable<ActiveWorkflow["coordination"]>["prFreshness"];
  } = {},
): ActiveWorkflow {
  return {
    workflowId,
    targetBranch: "main",
    stage: overrides.stage ?? "pr-opened",
    workerProfile: { ...profile },
    ...(overrides.title ? { title: overrides.title } : {}),
    workflowPr: overrides.workflowPr ?? {
      number: 100 + workflowId,
      headBranch: `matt-auto/${workflowId}/integration`,
      baseBranch: "main",
    },
    coordination: {
      target,
      ...(overrides.queueCandidate
        ? { queueCandidate: overrides.queueCandidate }
        : {}),
      ...(overrides.prFreshness ? { prFreshness: overrides.prFreshness } : {}),
    },
  };
}

function coordinatorLease(
  overrides: Partial<WorkflowCoordinatorLease> = {},
): WorkflowCoordinatorLease {
  return {
    kind: "workflow-coordinator",
    holderId: "home-a",
    generation: 3,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:30.000Z",
    expiresAt: "2026-01-01T00:02:00.000Z",
    scope: {
      repository: target.repository,
      target,
      workflowId: 42,
    },
    ...overrides,
  };
}

function targetLease(
  overrides: Partial<TargetBranchLease> = {},
): TargetBranchLease {
  return {
    kind: "target-branch",
    holderId: "home-b",
    generation: 5,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:30.000Z",
    expiresAt: "2026-01-01T00:02:00.000Z",
    scope: { target },
    workflowId: 41,
    ...overrides,
  };
}

function slotLease(
  slot: number,
  workflowId: number,
  ticketNumber?: number,
): WorkerSlotLease {
  return {
    kind: "worker-slot",
    holderId: `home-${workflowId}`,
    generation: 1,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:30.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
    scope: { repository: target.repository, slot },
    workflowId,
    ...(ticketNumber !== undefined ? { ticketNumber } : {}),
  };
}

describe("deriveParallelDeliveryWaitingState", () => {
  it("distinguishes queue waiting, CI pending, refresh, retryable, and lost lease", () => {
    expect(
      deriveParallelDeliveryWaitingState({
        queueCandidate: {
          state: "merge-ready",
          mergeReadyAt: "2026-01-01T00:00:00.000Z",
        },
        coordinatorLease: {
          status: "held",
          generation: 1,
          holderId: "home-a",
          expiresAt: "2026-01-01T00:02:00.000Z",
          heldByUs: true,
        },
        targetBranchLease: {
          status: "held-by-other",
          workflowId: 41,
          holderId: "home-b",
        },
      }),
    ).toBe("queue-waiting");

    expect(
      deriveParallelDeliveryWaitingState({
        queueCandidate: { state: "awaiting-pr-checks" },
        coordinatorLease: { status: "absent" },
      }),
    ).toBe("ci-pending");

    expect(
      deriveParallelDeliveryWaitingState({
        queueCandidate: { state: "refreshing" },
        coordinatorLease: {
          status: "held",
          generation: 1,
          holderId: "home-a",
          expiresAt: "x",
          heldByUs: true,
        },
      }),
    ).toBe("target-refresh");

    expect(
      deriveParallelDeliveryWaitingState({
        queueCandidate: {
          state: "retryable",
          retry: {
            reason: "verification-failed",
            attempt: 1,
            failedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        coordinatorLease: { status: "absent" },
      }),
    ).toBe("retryable-failure");

    expect(
      deriveParallelDeliveryWaitingState({
        queueCandidate: { state: "awaiting-pr-checks" },
        coordinatorLease: { status: "lost" },
      }),
    ).toBe("lost-lease");
  });

  it("formats distinct waiting labels for operator surfaces", () => {
    expect(formatParallelDeliveryWaitingState("queue-waiting")).toMatch(/queue/i);
    expect(formatParallelDeliveryWaitingState("ci-pending")).toMatch(/PR checks/i);
    expect(formatParallelDeliveryWaitingState("target-refresh")).toMatch(/Refresh/i);
    expect(formatParallelDeliveryWaitingState("retryable-failure")).toMatch(/Retryable/i);
    expect(formatParallelDeliveryWaitingState("lost-lease")).toMatch(/Lost/i);
  });
});

describe("buildParallelDeliveryPanelState", () => {
  it("returns undefined for legacy v1 workflows without coordination facts", () => {
    const legacy: ActiveWorkflow = {
      workflowId: 42,
      targetBranch: "main",
      stage: "tickets-published",
      workerProfile: { ...profile },
    };
    expect(
      buildParallelDeliveryPanelState({
        boundWorkflowId: 42,
        active: legacy,
        siblingsOnTarget: [legacy],
        holderId: "home-a",
      }),
    ).toBeUndefined();
  });

  it("observes target identity, queue position, siblings, and worker slots from live facts", () => {
    const bound = coordinated(42, {
      title: "Bound workflow",
      queueCandidate: {
        state: "merge-ready",
        mergeReadyAt: "2026-01-01T00:01:00.000Z",
      },
      prFreshness: {
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        validatedTargetSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        mergeMethod: "squash",
      },
    });
    const sibling = coordinated(41, {
      title: "Sibling A",
      queueCandidate: {
        state: "merge-ready",
        mergeReadyAt: "2026-01-01T00:00:00.000Z",
      },
      prFreshness: {
        headSha: "cccccccccccccccccccccccccccccccccccccccc",
        mergeMethod: "squash",
      },
    });
    const other = coordinated(43, {
      title: "Sibling B",
      queueCandidate: { state: "awaiting-pr-checks" },
      prFreshness: {
        headSha: "dddddddddddddddddddddddddddddddddddddddd",
        mergeMethod: "squash",
      },
    });

    const state = buildParallelDeliveryPanelState({
      boundWorkflowId: 42,
      active: bound,
      siblingsOnTarget: [sibling, bound, other],
      coordinatorLease: coordinatorLease(),
      coordinatorLeaseHeldByUs: true,
      targetBranchLease: targetLease(),
      workerSlotLeases: [
        slotLease(1, 42, 55),
        slotLease(2, 41, 50),
      ],
      workerCapacity: 2,
      holderId: "home-a",
      nowMs: Date.parse("2026-01-01T00:01:00.000Z"),
    });

    expect(state).toBeDefined();
    expect(state!.target).toEqual(target);
    expect(state!.boundWorkflowId).toBe(42);
    expect(state!.waitingState).toBe("queue-waiting");
    expect(state!.queuePosition).toBe(2);
    expect(state!.queueLength).toBe(2);
    expect(state!.prHeadSha).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(state!.validatedTargetSha).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(state!.coordinatorLease).toMatchObject({
      status: "held",
      heldByUs: true,
      generation: 3,
    });
    expect(state!.targetBranchLease).toMatchObject({
      status: "held-by-other",
      workflowId: 41,
    });
    expect(state!.siblings).toEqual([
      expect.objectContaining({
        workflowId: 41,
        title: "Sibling A",
        queueState: "merge-ready",
        heldWorkerSlots: 1,
        workflowPr: { number: 141, status: "open" },
      }),
      expect.objectContaining({
        workflowId: 43,
        title: "Sibling B",
        queueState: "awaiting-pr-checks",
        heldWorkerSlots: 0,
      }),
    ]);
    // Sibling summaries never invent action ownership fields.
    for (const siblingSummary of state!.siblings) {
      expect(siblingSummary).not.toHaveProperty("actions");
      expect(siblingSummary).not.toHaveProperty("canPause");
      expect(siblingSummary).not.toHaveProperty("canTerminate");
    }
    expect(state!.workerSlots).toEqual({
      capacity: 2,
      freeSlotCount: 0,
      boundWorkflowHeldCount: 1,
      occupied: [
        {
          slot: 1,
          workflowId: 42,
          ticketNumber: 55,
          ownedByBoundWorkflow: true,
        },
        {
          slot: 2,
          workflowId: 41,
          ticketNumber: 50,
          ownedByBoundWorkflow: false,
        },
      ],
    });
  });

  it("renders brief and compact lines from observed delivery facts only", () => {
    const bound = coordinated(42, {
      queueCandidate: {
        state: "merge-ready",
        mergeReadyAt: "2026-01-01T00:01:00.000Z",
      },
      prFreshness: {
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        validatedTargetSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        mergeMethod: "squash",
      },
    });
    const sibling = coordinated(41, {
      title: "Other",
      queueCandidate: {
        state: "merge-ready",
        mergeReadyAt: "2026-01-01T00:00:00.000Z",
      },
      prFreshness: {
        headSha: "cccccccccccccccccccccccccccccccccccccccc",
        mergeMethod: "squash",
      },
    });
    const state = buildParallelDeliveryPanelState({
      boundWorkflowId: 42,
      active: bound,
      siblingsOnTarget: [sibling, bound],
      coordinatorLease: coordinatorLease(),
      coordinatorLeaseHeldByUs: true,
      targetBranchLease: targetLease(),
      workerSlotLeases: [slotLease(1, 42)],
      workerCapacity: 2,
      holderId: "home-a",
      nowMs: Date.parse("2026-01-01T00:01:00.000Z"),
    })!;

    const brief = formatParallelDeliveryBriefLines(state);
    expect(brief.join("\n")).toContain("Acme/widgets refs/heads/main");
    expect(brief.join("\n")).toContain("Bound workflow: #42");
    expect(brief.join("\n")).toContain("Waiting in Target-branch queue");
    expect(brief.join("\n")).toContain("Queue position: 2 of 2");
    expect(brief.join("\n")).toContain("Validated target SHA:");
    expect(brief.join("\n")).toContain("#41 · Other");
    expect(brief.join("\n")).not.toMatch(/Pause|Terminate|Resume/i);

    const compact = formatParallelDeliveryCompactLines(state);
    expect(compact.join("\n")).toContain("Acme/widgets refs/heads/main");
    expect(compact.join("\n")).toContain("Siblings: #41");
    expect(compact.join("\n")).toMatch(/slots 1\/2/);
  });
});
