import { describe, expect, it } from "vitest";
import { createFakeCoordinationPort, createInMemoryCoordinationStore } from "../src/adapters/coordination.js";
import { activeWorkflowFromManifest } from "../src/adapters/workflow-manifest.js";
import {
  createTargetBranchQueueOrchestrator,
  recordTargetBranchQueueFailure,
  reconstructTargetBranchQueue,
  targetBranchQueuePosition,
  type TargetBranchQueueStore,
} from "../src/target-branch-queue.js";
import type { CoordinationPort } from "../src/ports.js";
import type {
  ActiveWorkflow,
  CanonicalTargetIdentity,
  CoordinationWorkflowManifest,
  TargetBranchQueueCandidate,
  WorkflowCoordinatorLease,
  WorkerProfile,
} from "../src/types.js";

const target: CanonicalTargetIdentity = {
  repository: { owner: "Acme", name: "workflow-tools" },
  targetRef: "refs/heads/main",
};

const profile: WorkerProfile = {
  provider: "openai-codex",
  modelId: "gpt-5.6-terra",
  thinkingLevel: "max",
};

type TestClock = {
  now: () => Date;
  advance: (milliseconds: number) => void;
};

function createClock(initial = "2026-07-28T16:00:00.000Z"): TestClock {
  let milliseconds = Date.parse(initial);
  return {
    now: () => new Date(milliseconds),
    advance: (amount) => {
      milliseconds += amount;
    },
  };
}

function sha(character: string): string {
  return character.repeat(40);
}

function workflow(
  workflowId: number,
  candidate: TargetBranchQueueCandidate,
  headSha = sha("a"),
): ActiveWorkflow {
  return {
    workflowId,
    targetBranch: "main",
    stage: "pr-opened",
    workerProfile: profile,
    workflowPr: {
      number: 500 + workflowId,
      headBranch: `matt-auto/${workflowId}/integration`,
      baseBranch: "main",
    },
    coordination: {
      target,
      prFreshness: {
        headSha,
        mergeMethod: "squash",
      },
      queueCandidate: candidate,
    },
  };
}

function manifestFromActive(active: ActiveWorkflow): CoordinationWorkflowManifest {
  if (!active.coordination) {
    throw new Error("Expected a coordination-aware workflow.");
  }
  return {
    schema: "matt-auto/workflow-manifest",
    version: 2,
    workflowId: active.workflowId,
    targetBranch: active.targetBranch,
    stage: active.stage,
    workerProfile: { ...active.workerProfile },
    ...(active.tickets ? { tickets: [...active.tickets] } : {}),
    ...(active.integrationBranch
      ? { integrationBranch: active.integrationBranch }
      : {}),
    ...(active.integratedTickets
      ? { integratedTickets: active.integratedTickets.map((ticket) => ({ ...ticket })) }
      : {}),
    ...(active.workflowPr ? { workflowPr: { ...active.workflowPr } } : {}),
    coordination: structuredClone(active.coordination),
    ...(active.followUpOf !== undefined
      ? { followUpOf: active.followUpOf }
      : {}),
  };
}

function createQueueStore(
  workflows: readonly ActiveWorkflow[],
): { store: TargetBranchQueueStore; state: Map<number, ActiveWorkflow> } {
  const state = new Map(
    workflows.map((entry) => [entry.workflowId, structuredClone(entry)]),
  );
  return {
    state,
    store: {
      listActiveWorkflows: async () =>
        [...state.values()].map((entry) => structuredClone(entry)),
      writeWorkflowManifest: async (workflowId, manifest) => {
        expect(workflowId).toBe(manifest.workflowId);
        state.set(workflowId, activeWorkflowFromManifest(manifest));
      },
    },
  };
}

async function acquireWorkflowLease(
  coordination: CoordinationPort,
  holderId: string,
  workflowId: number,
  ttlMs = 10_000,
): Promise<WorkflowCoordinatorLease> {
  const acquired = await coordination.acquireLease({
    kind: "workflow-coordinator",
    repository: target.repository,
    target,
    workflowId,
    holderId,
    ttlMs,
  });
  expect(acquired.acquired).toBe(true);
  if (!acquired.acquired || acquired.lease.kind !== "workflow-coordinator") {
    throw new Error("Expected workflow coordinator lease.");
  }
  return acquired.lease;
}

describe("Target-branch queue reconstruction", () => {
  it("orders only merge-ready coordination candidates FIFO with workflow ID timestamp ties", () => {
    const queue = reconstructTargetBranchQueue(target, [
      workflow(44, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:01:00.000Z",
      }),
      workflow(42, {
        state: "merge-ready",
        // The manifest parser permits ISO seconds without a fractional part.
        mergeReadyAt: "2026-07-28T16:00:00Z",
      }),
      workflow(41, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:00:00.000Z",
      }),
      workflow(45, { state: "awaiting-pr-checks" }),
      workflow(46, {
        state: "retryable",
        retry: {
          reason: "verification-failed",
          attempt: 1,
          failedAt: "2026-07-28T15:59:00.000Z",
        },
      }),
      workflow(47, {
        state: "transient-retry",
        retry: {
          reason: "github-api-timeout",
          attempt: 1,
          maxAttempts: 3,
          failedAt: "2026-07-28T15:59:00.000Z",
          nextRetryAt: "2026-07-28T16:02:00.000Z",
        },
      }),
    ]);

    expect(queue.entries.map((entry) => entry.workflowId)).toEqual([41, 42, 44]);
    expect(targetBranchQueuePosition(queue, 41)).toBe(1);
    expect(targetBranchQueuePosition(queue, 42)).toBe(2);
    expect(targetBranchQueuePosition(queue, 45)).toBeUndefined();
  });
});

describe("Target-branch queue retry policy", () => {
  it("bounds consecutive transient infrastructure failures with exponential backoff", () => {
    const clock = createClock();
    const first = recordTargetBranchQueueFailure({
      candidate: { state: "awaiting-pr-checks" },
      kind: "transient",
      reason: "github-api-timeout",
      now: clock.now(),
      retryPolicy: { maxAttempts: 2, baseBackoffMs: 1_000 },
    });
    expect(first).toMatchObject({
      state: "transient-retry",
      retry: { attempt: 1, nextRetryAt: "2026-07-28T16:00:01.000Z" },
    });

    clock.advance(1_000);
    const second = recordTargetBranchQueueFailure({
      candidate: first,
      kind: "transient",
      reason: "github-api-timeout",
      now: clock.now(),
      retryPolicy: { maxAttempts: 2, baseBackoffMs: 1_000 },
    });
    expect(second).toMatchObject({
      state: "transient-retry",
      retry: { attempt: 2, nextRetryAt: "2026-07-28T16:00:03.000Z" },
    });

    clock.advance(2_000);
    expect(
      recordTargetBranchQueueFailure({
        candidate: second,
        kind: "transient",
        reason: "github-api-timeout",
        now: clock.now(),
        // A later caller cannot widen the persisted budget from two attempts.
        retryPolicy: { maxAttempts: 99, baseBackoffMs: 1_000 },
      }),
    ).toMatchObject({
      state: "retryable",
      retry: {
        reason: "transient-retry-exhausted:github-api-timeout",
        attempt: 3,
      },
    });
  });
});

describe("Target-branch queue orchestration", () => {
  it("drops a pending candidate from FIFO and gives it a new timestamp when its current PR head becomes green again", async () => {
    const clock = createClock();
    const coordination = createFakeCoordinationPort({ now: clock.now });
    const { store, state } = createQueueStore([
      workflow(41, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:00:00.000Z",
      }),
      workflow(42, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:01:00.000Z",
      }),
    ]);
    const lease = await acquireWorkflowLease(
      coordination,
      "home-41",
      41,
      300_000,
    );
    const queue = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 41,
      holderId: "home-41",
      coordination,
      store,
      now: clock.now,
    });

    const pending = await queue.transition({
      kind: "observe-pr-checks",
      workflowCoordinatorLease: lease,
      observation: { headSha: sha("a"), status: "pending" },
    });
    expect(pending).toMatchObject({
      ok: true,
      action: "observed-pr-checks",
      candidate: { state: "awaiting-pr-checks" },
    });
    expect(
      reconstructTargetBranchQueue(target, [...state.values()]).entries.map(
        (entry) => entry.workflowId,
      ),
    ).toEqual([42]);

    clock.advance(120_000);
    const ready = await queue.transition({
      kind: "observe-pr-checks",
      workflowCoordinatorLease: lease,
      observation: { headSha: sha("a"), status: "success" },
    });
    expect(ready).toMatchObject({
      ok: true,
      candidate: {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:02:00.000Z",
      },
    });
    expect(
      reconstructTargetBranchQueue(target, [...state.values()]).entries.map(
        (entry) => entry.workflowId,
      ),
    ).toEqual([42, 41]);
  });

  it("does not admit stale or failed PR observations to the merge-ready queue", async () => {
    const clock = createClock();
    const coordination = createFakeCoordinationPort({ now: clock.now });
    const { store, state } = createQueueStore([
      workflow(41, { state: "awaiting-pr-checks" }, sha("a")),
    ]);
    const lease = await acquireWorkflowLease(coordination, "home-41", 41);
    const queue = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 41,
      holderId: "home-41",
      coordination,
      store,
      now: clock.now,
    });

    const stale = await queue.transition({
      kind: "observe-pr-checks",
      workflowCoordinatorLease: lease,
      observation: { headSha: sha("b"), status: "success" },
    });
    expect(stale).toMatchObject({
      ok: true,
      candidate: { state: "awaiting-pr-checks" },
    });

    const failed = await queue.transition({
      kind: "observe-pr-checks",
      workflowCoordinatorLease: lease,
      observation: { headSha: sha("a"), status: "failure" },
    });
    expect(failed).toMatchObject({
      ok: true,
      candidate: {
        state: "retryable",
        retry: { reason: "required-pr-checks-failed", attempt: 1 },
      },
    });
    expect(reconstructTargetBranchQueue(target, [...state.values()]).entries).toEqual([]);
  });

  it("serializes a queue head through a Target-branch lease and lets the next candidate recover after expiry", async () => {
    const clock = createClock();
    const store = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store, now: clock.now });
    const { store: queueStore, state } = createQueueStore([
      workflow(41, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:00:00.000Z",
      }),
      workflow(42, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:01:00.000Z",
      }),
    ]);
    const lease41 = await acquireWorkflowLease(coordination, "home-41", 41);
    const lease42 = await acquireWorkflowLease(coordination, "home-42", 42);
    const first = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 41,
      holderId: "home-41",
      coordination,
      store: queueStore,
      now: clock.now,
    });
    const second = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 42,
      holderId: "home-42",
      coordination,
      store: queueStore,
      now: clock.now,
    });

    const acquired = await first.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: lease41,
      phase: "refresh",
      ttlMs: 1_000,
    });
    expect(acquired).toMatchObject({
      ok: true,
      action: "target-lease-acquired",
      phase: "refresh",
      lease: { kind: "target-branch", workflowId: 41, generation: 1 },
      candidate: { state: "refreshing" },
    });

    const blocked = await second.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: lease42,
      phase: "refresh",
      ttlMs: 1_000,
    });
    expect(blocked).toMatchObject({ ok: false, code: "target-lease-held" });

    clock.advance(1_001);
    const recovered = await second.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: lease42,
      phase: "refresh",
      ttlMs: 1_000,
    });
    expect(recovered).toMatchObject({
      ok: true,
      action: "target-lease-acquired",
      lease: { kind: "target-branch", workflowId: 42, generation: 2 },
      candidate: { state: "refreshing" },
    });
    expect(state.get(41)?.coordination).toMatchObject({
      queueCandidate: { state: "refreshing" },
      observedLeaseGenerations: {
        workflowCoordinator: 1,
        targetBranch: 1,
      },
    });
  });

  it("records an expired refreshing lease as a retryable recovery outcome for a newly leased Workflow home", async () => {
    const clock = createClock();
    const shared = createInMemoryCoordinationStore();
    const firstPort = createFakeCoordinationPort({ store: shared, now: clock.now });
    const { store, state } = createQueueStore([
      workflow(41, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:00:00.000Z",
      }),
    ]);
    const firstWorkflowLease = await acquireWorkflowLease(
      firstPort,
      "home-41-first",
      41,
      1_000,
    );
    const first = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 41,
      holderId: "home-41-first",
      coordination: firstPort,
      store,
      now: clock.now,
    });
    await first.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: firstWorkflowLease,
      phase: "refresh",
      ttlMs: 1_000,
    });

    clock.advance(1_001);
    const recoveredPort = createFakeCoordinationPort({ store: shared, now: clock.now });
    const recoveredWorkflowLease = await acquireWorkflowLease(
      recoveredPort,
      "home-41-recovered",
      41,
      10_000,
    );
    const recovered = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 41,
      holderId: "home-41-recovered",
      coordination: recoveredPort,
      store,
      now: clock.now,
    });

    await expect(
      recovered.transition({
        kind: "recover-expired-target-lease",
        workflowCoordinatorLease: recoveredWorkflowLease,
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: "expired-lease-recovered",
      candidate: {
        state: "transient-retry",
        retry: {
          reason: "target-branch-lease-expired",
          attempt: 1,
          nextRetryAt: "2026-07-28T16:00:02.001Z",
        },
      },
    });
    expect(state.get(41)?.coordination?.queueCandidate).toMatchObject({
      state: "transient-retry",
    });
  });

  it("allows only the current Target-branch lease holder to leave a refresh phase", async () => {
    const clock = createClock();
    const shared = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store: shared, now: clock.now });
    const { store, state } = createQueueStore([
      workflow(41, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:00:00.000Z",
      }),
    ]);
    const lease = await acquireWorkflowLease(coordination, "home-41", 41);
    const owner = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 41,
      holderId: "home-41",
      coordination,
      store,
      now: clock.now,
    });
    const intruder = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 41,
      holderId: "home-intruder",
      coordination,
      store,
      now: clock.now,
    });
    await owner.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: lease,
      phase: "refresh",
    });

    const rejected = await intruder.transition({
      kind: "release-for-pr-checks",
      workflowCoordinatorLease: lease,
    });
    const rejectedMerge = await intruder.transition({
      kind: "mark-merged",
      workflowCoordinatorLease: lease,
    });
    expect(rejected).toMatchObject({ ok: false, code: "target-lease-not-held" });
    expect(rejectedMerge).toMatchObject({
      ok: false,
      code: "target-lease-not-held",
    });
    expect(state.get(41)?.coordination?.queueCandidate).toMatchObject({
      state: "refreshing",
    });

    const released = await owner.transition({
      kind: "release-for-pr-checks",
      workflowCoordinatorLease: lease,
    });
    expect(released).toMatchObject({
      ok: true,
      action: "released-for-pr-checks",
      candidate: { state: "awaiting-pr-checks" },
    });
    await expect(
      coordination.getLease({ kind: "target-branch", target }),
    ).resolves.toMatchObject({ releasedAt: "2026-07-28T16:00:00.000Z" });
  });

  it("fails closed and releases the Target-branch lane when Workflow coordinator authority expires", async () => {
    const clock = createClock();
    const coordination = createFakeCoordinationPort({ now: clock.now });
    const { store } = createQueueStore([
      workflow(41, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:00:00.000Z",
      }),
    ]);
    const workflowLease = await acquireWorkflowLease(
      coordination,
      "home-41",
      41,
      1_000,
    );
    const queue = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 41,
      holderId: "home-41",
      coordination,
      store,
      now: clock.now,
    });
    await queue.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: workflowLease,
      phase: "validation",
      ttlMs: 10_000,
    });

    clock.advance(1_001);
    await expect(
      queue.transition({
        kind: "release-for-pr-checks",
        workflowCoordinatorLease: workflowLease,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "workflow-authority-lost",
    });
    await expect(
      coordination.getLease({ kind: "target-branch", target }),
    ).resolves.toMatchObject({ releasedAt: "2026-07-28T16:00:01.001Z" });
  });

  it("records bounded transient retries, releases the lease, and requires explicit recovery for deterministic failures", async () => {
    const clock = createClock();
    const coordination = createFakeCoordinationPort({ now: clock.now });
    const { store, state } = createQueueStore([
      workflow(41, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:00:00.000Z",
      }),
    ]);
    const lease = await acquireWorkflowLease(coordination, "home-41", 41);
    const queue = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 41,
      holderId: "home-41",
      coordination,
      store,
      now: clock.now,
    });

    await queue.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: lease,
      phase: "validation",
    });
    const transient = await queue.transition({
      kind: "record-failure",
      workflowCoordinatorLease: lease,
      failureKind: "transient",
      reason: "github-api-timeout",
      retryPolicy: { maxAttempts: 2, baseBackoffMs: 1_000 },
    });
    expect(transient).toMatchObject({
      ok: true,
      action: "failure-recorded",
      candidate: {
        state: "transient-retry",
        retry: {
          reason: "github-api-timeout",
          attempt: 1,
          maxAttempts: 2,
          nextRetryAt: "2026-07-28T16:00:01.000Z",
        },
      },
    });
    await expect(
      coordination.getLease({ kind: "target-branch", target }),
    ).resolves.toMatchObject({ releasedAt: "2026-07-28T16:00:00.000Z" });

    const tooEarly = await queue.transition({
      kind: "requeue-retry",
      workflowCoordinatorLease: lease,
      retryKind: "transient",
    });
    expect(tooEarly).toMatchObject({ ok: false, code: "retry-not-due" });

    clock.advance(1_000);
    const requeued = await queue.transition({
      kind: "requeue-retry",
      workflowCoordinatorLease: lease,
      retryKind: "transient",
    });
    expect(requeued).toMatchObject({
      ok: true,
      candidate: { state: "awaiting-pr-checks" },
    });
    const reentered = await queue.transition({
      kind: "observe-pr-checks",
      workflowCoordinatorLease: lease,
      observation: { headSha: sha("a"), status: "success" },
    });
    expect(reentered).toMatchObject({
      ok: true,
      candidate: {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:00:01.000Z",
      },
    });

    await queue.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: lease,
      phase: "merge",
    });
    const deterministic = await queue.transition({
      kind: "record-failure",
      workflowCoordinatorLease: lease,
      failureKind: "deterministic",
      reason: "verification-failed",
    });
    expect(deterministic).toMatchObject({
      ok: true,
      candidate: {
        state: "retryable",
        retry: { reason: "verification-failed", attempt: 1 },
      },
    });

    const stillClosed = await queue.transition({
      kind: "observe-pr-checks",
      workflowCoordinatorLease: lease,
      observation: { headSha: sha("a"), status: "success" },
    });
    expect(stillClosed).toMatchObject({
      ok: true,
      candidate: { state: "retryable" },
    });
    const explicitRetry = await queue.transition({
      kind: "requeue-retry",
      workflowCoordinatorLease: lease,
      retryKind: "deterministic",
    });
    expect(explicitRetry).toMatchObject({
      ok: true,
      candidate: { state: "awaiting-pr-checks" },
    });
    expect(reconstructTargetBranchQueue(target, [...state.values()]).entries).toEqual([]);
  });
});
