/**
 * End-to-end acceptance coverage for issue #47:
 * Harden recovery, cleanup, and end-to-end parallel delivery.
 *
 * Uses deterministic fake CoordinationPort + in-memory tracker/workspace ports
 * (no live GitHub). Local bare-remote lease behavior is covered separately by
 * coordination-port tests.
 */
import { describe, expect, it } from "vitest";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import {
  CLEANUP_WORKFLOW_ACTION,
  DEFAULT_COORDINATION_LEASE_TTL_MS,
  MERGE_WORKFLOW_PR_ACTION,
  OPEN_WORKFLOW_PR_ACTION,
  REFRESH_FROM_TARGET_ACTION,
  REQUIRED_MATT_SKILLS,
  filterWorkflowOwnedBranches,
  implementTicketActionId,
  implementationBranchName,
  integrationBranchName,
  isWorkflowOwnedBranch,
} from "../src/constants.js";
import {
  createFakeCoordinationPort,
  createInMemoryCoordinationStore,
} from "../src/adapters/coordination.js";
import { activeWorkflowFromManifest } from "../src/adapters/workflow-manifest.js";
import { canonicalTargetIdentityKey } from "../src/coordination.js";
import {
  DEFAULT_TARGET_BRANCH_TRANSIENT_RETRY_MAX_ATTEMPTS,
  createTargetBranchQueueOrchestrator,
  recordTargetBranchQueueFailure,
  reconstructTargetBranchQueue,
} from "../src/target-branch-queue.js";
import { evaluateMergeFreshness } from "../src/workflow-pr-guard.js";
import type {
  CoordinationPort,
  PreferencesPort,
  RootScopedPorts,
  TrackerPort,
  TranscriptPort,
  WorkerEventSink,
  WorkerLaunchInput,
  WorkersPort,
  WorkflowCoordinatorPorts,
  WorkspacePort,
} from "../src/ports.js";
import type {
  ActiveWorkflow,
  CanonicalTargetIdentity,
  CoordinationLease,
  WorkerProfile,
  WorkerProtocolEvent,
  WorkflowManifest,
  WorkflowMergeMethod,
} from "../src/types.js";

const repository = { owner: "Acme", name: "workflow-tools" };
const target: CanonicalTargetIdentity = {
  repository,
  targetRef: "refs/heads/main",
};
const profile: WorkerProfile = {
  provider: "openai-codex",
  modelId: "gpt-5.6-terra",
  thinkingLevel: "max",
};

function sha(ch: string): string {
  return ch.repeat(40);
}

function cloneActive(active: ActiveWorkflow): ActiveWorkflow {
  return activeWorkflowFromManifest(
    active.coordination
      ? {
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
            ? {
                integratedTickets: active.integratedTickets.map((t) => ({
                  ...t,
                })),
              }
            : {}),
          ...(active.workflowPr
            ? { workflowPr: { ...active.workflowPr } }
            : {}),
          ...(active.followUpOf !== undefined
            ? { followUpOf: active.followUpOf }
            : {}),
          coordination: structuredClone(active.coordination),
        }
      : {
          schema: "matt-auto/workflow-manifest",
          version: 1,
          workflowId: active.workflowId,
          targetBranch: active.targetBranch,
          stage: active.stage,
          workerProfile: { ...active.workerProfile },
          ...(active.tickets ? { tickets: [...active.tickets] } : {}),
          ...(active.integrationBranch
            ? { integrationBranch: active.integrationBranch }
            : {}),
          ...(active.integratedTickets
            ? {
                integratedTickets: active.integratedTickets.map((t) => ({
                  ...t,
                })),
              }
            : {}),
          ...(active.workflowPr
            ? { workflowPr: { ...active.workflowPr } }
            : {}),
          ...(active.followUpOf !== undefined
            ? { followUpOf: active.followUpOf }
            : {}),
        },
    active.title,
  );
}

type TicketState = {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  blockedBy: number[];
  parent?: number;
};

type SharedTrackerState = {
  workflows: Map<number, ActiveWorkflow>;
  tickets: Map<number, TicketState>;
  closedParents: number[];
  createPrCalls: Array<{ head: string; base: string; title: string }>;
  mergePrCalls: Array<{
    number: number;
    mergeMethod?: WorkflowMergeMethod;
    expectedHeadSha?: string;
    expectedTargetSha?: string;
  }>;
  deletedRemoteByHome: Map<string, string[][]>;
  cleanupLocalByHome: Map<string, number[]>;
  prHeadByNumber: Map<number, { headSha: string; baseSha: string }>;
  nextPrNumber: number;
  /** Mutable tip of the Target branch (simulates external advancement). */
  targetSha: string;
  ciStatus: "pending" | "success" | "failure";
  /** Target-branch required status checks (empty = no required CI gate). */
  requiredStatusChecks: { strict: boolean; contexts: string[] };
};

function createSharedTracker(
  initial: readonly ActiveWorkflow[],
  tickets: readonly TicketState[],
): { port: TrackerPort; state: SharedTrackerState } {
  const state: SharedTrackerState = {
    workflows: new Map(initial.map((w) => [w.workflowId, cloneActive(w)])),
    tickets: new Map(tickets.map((t) => [t.number, { ...t, blockedBy: [...t.blockedBy] }])),
    closedParents: [],
    createPrCalls: [],
    mergePrCalls: [],
    deletedRemoteByHome: new Map(),
    cleanupLocalByHome: new Map(),
    prHeadByNumber: new Map(),
    nextPrNumber: 700,
    targetSha: sha("b"),
    ciStatus: "success",
    requiredStatusChecks: { strict: true, contexts: ["ci"] },
  };

  const port: TrackerPort = {
    getCanonicalRepositoryIdentity: async () => ({ ...repository }),
    findActiveWorkflows: async (requested) =>
      canonicalTargetIdentityKey(requested) ===
      canonicalTargetIdentityKey(target)
        ? [...state.workflows.values()]
            .filter((w) => w.stage !== "completed")
            .map(cloneActive)
        : [],
    findActiveWorkflowsForRepository: async (repo) =>
      repo.owner.toLowerCase() === repository.owner.toLowerCase() &&
      repo.name.toLowerCase() === repository.name.toLowerCase()
        ? [...state.workflows.values()]
            .filter((w) => w.stage !== "completed")
            .map(cloneActive)
        : [],
    findActiveWorkflow: async (_branch, workflowId) => {
      if (workflowId !== undefined) {
        const found = state.workflows.get(workflowId);
        return found && found.stage !== "completed" ? cloneActive(found) : undefined;
      }
      const first = [...state.workflows.values()].find((w) => w.stage !== "completed");
      return first ? cloneActive(first) : undefined;
    },
    listTickets: async (numbers) =>
      numbers.flatMap((n) => {
        const t = state.tickets.get(n);
        if (!t) return [];
        return [
          {
            number: t.number,
            title: t.title,
            state: t.state,
            blockedBy: t.blockedBy.map((b) => ({
              number: b,
              state: state.tickets.get(b)?.state ?? "OPEN",
            })),
          },
        ];
      }),
    createIssue: async () => ({ number: 900 }),
    writeWorkflowManifest: async (issueNumber, manifest: WorkflowManifest) => {
      const existing = state.workflows.get(issueNumber);
      const next = activeWorkflowFromManifest(manifest, existing?.title);
      state.workflows.set(issueNumber, next);
    },
    addBlockedBy: async () => {},
    addSubIssue: async () => {},
    closeIssue: async (issueNumber) => {
      const ticket = state.tickets.get(issueNumber);
      if (ticket) {
        ticket.state = "CLOSED";
        return;
      }
      state.closedParents.push(issueNumber);
      const wf = state.workflows.get(issueNumber);
      if (wf) {
        state.workflows.set(issueNumber, { ...wf, stage: "completed" });
      }
    },
    reopenIssue: async (issueNumber) => {
      const ticket = state.tickets.get(issueNumber);
      if (ticket) ticket.state = "OPEN";
    },
    createPullRequest: async (input) => {
      state.createPrCalls.push({
        head: input.head,
        base: input.base,
        title: input.title,
      });
      const number = state.nextPrNumber++;
      const headSha = sha("a");
      state.prHeadByNumber.set(number, {
        headSha,
        baseSha: state.targetSha,
      });
      return { number, url: `https://example.test/pr/${number}` };
    },
    inspectProtectedBranchAutomation: async () => ({
      repository: { ...repository },
      targetRef: target.targetRef,
      coordinationRefsWritable: true,
      requiredStatusChecks: { ...state.requiredStatusChecks },
      requiredApprovingReviewCount: 0,
      allowedMergeMethods: ["squash", "merge"],
      preferredMergeMethod: "squash",
      mergeQueueRequired: false,
      actorCanMergeWithoutApproval: true,
      staleBaseProtectionGuaranteed:
        state.requiredStatusChecks.strict === true &&
        state.requiredStatusChecks.contexts.length > 0,
    }),
    getPullRequestFreshness: async (input) => {
      const recorded = state.prHeadByNumber.get(input.number);
      if (!recorded) throw new Error(`PR #${input.number} freshness missing`);
      return {
        headSha: recorded.headSha,
        baseSha: state.targetSha,
        mergeable: true,
      };
    },
    mergePullRequest: async (input) => {
      state.mergePrCalls.push({
        number: input.number,
        ...(input.mergeMethod ? { mergeMethod: input.mergeMethod } : {}),
        ...(input.expectedHeadSha
          ? { expectedHeadSha: input.expectedHeadSha }
          : {}),
        ...(input.expectedTargetSha
          ? { expectedTargetSha: input.expectedTargetSha }
          : {}),
      });
      if (
        input.expectedTargetSha &&
        input.expectedTargetSha !== state.targetSha
      ) {
        throw new Error(
          `Target SHA mismatch: expected ${input.expectedTargetSha}, live ${state.targetSha}`,
        );
      }
      // Simulate successful merge advancing main.
      state.targetSha = sha(
        String.fromCharCode(
          99 + (state.mergePrCalls.length % 10), // c,d,e...
        ),
      );
    },
  };

  return { port, state };
}

function createPreferences(workflowId: number | undefined): PreferencesPort {
  let binding =
    workflowId === undefined
      ? undefined
      : ({ target, workflowId } as const);
  let legacyId: number | undefined = workflowId;
  return {
    getConfiguredTargetBranch: async () => "main",
    getGlobalWorkerProfile: async () => profile,
    getRootWorkerProfile: async () => undefined,
    getWorkflowSnapshotWorkerProfile: async () => undefined,
    setGlobalWorkerProfile: async () => {},
    setRootWorkerProfile: async () => {},
    clearRootWorkerProfile: async () => {},
    getGlobalWorkerConcurrency: async () => undefined,
    getRootWorkerConcurrency: async () => 2,
    setGlobalWorkerConcurrency: async () => {},
    setRootWorkerConcurrency: async () => {},
    clearRootWorkerConcurrency: async () => {},

    getGlobalLiveWaitPollIntervalMs: async () => undefined,
    getRootLiveWaitPollIntervalMs: async () => undefined,
    setGlobalLiveWaitPollIntervalMs: async () => {},
    setRootLiveWaitPollIntervalMs: async () => {},
    clearRootLiveWaitPollIntervalMs: async () => {},
    getActiveWorkflowId: async () => legacyId,
    setActiveWorkflowId: async (_branch, id) => {
      legacyId = id;
    },
    clearActiveWorkflowId: async () => {
      legacyId = undefined;
    },
    getWorkflowHomeBinding: async (requested) =>
      binding &&
      canonicalTargetIdentityKey(requested) ===
        canonicalTargetIdentityKey(binding.target)
        ? { ...binding, target: { ...binding.target, repository: { ...binding.target.repository } } }
        : undefined,
    setWorkflowHomeBinding: async (next) => {
      binding = {
        target: {
          repository: { ...next.target.repository },
          targetRef: next.target.targetRef,
        },
        workflowId: next.workflowId,
      };
      legacyId = next.workflowId;
    },
    clearWorkflowHomeBinding: async () => {
      binding = undefined;
    },
  };
}

type RefreshResult =
  | { ok: true; targetSha: string; mergeCommitSha?: string }
  | {
      ok: false;
      reason: "conflict" | "error";
      message: string;
      targetSha?: string;
    };

type TestWorkspace = WorkspacePort & {
  setRefreshResult(next: RefreshResult): void;
};

function createWorkspace(
  home: string,
  shared: SharedTrackerState,
): TestWorkspace {
  const attempts = new Map<string, number>();
  const creates: Array<{
    workflowId: number;
    ticketNumber: number;
    attempt: number;
    branchName: string;
  }> = [];
  const removed = new Set<string>();
  let refreshResult: RefreshResult = {
    ok: true,
    targetSha: shared.targetSha,
    mergeCommitSha: "refresh-ok",
  };

  const create = async (input: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
    baseRef?: string;
  }) => {
    const branchName = implementationBranchName(
      input.workflowId,
      input.ticketNumber,
      input.attempt,
    );
    attempts.set(`${input.workflowId}:${input.ticketNumber}`, input.attempt);
    creates.push({ ...input, branchName });
    removed.delete(branchName);
    return {
      branchName,
      worktreePath: `/workspaces/${home}/${input.workflowId}/ticket-${input.ticketNumber}/r${input.attempt}`,
    };
  };

  const port: WorkspacePort = {
    latestAttempt: async (workflowId, ticketNumber) =>
      attempts.get(`${workflowId}:${ticketNumber}`) ?? 0,
    createImplementationWorkspace: create,
    ensureImplementationWorkspace: create,
    ensureIntegrationWorkspace: async (input) => {
      const branchName = integrationBranchName(input.workflowId);
      removed.delete(branchName);
      return {
        branchName,
        worktreePath: `/workspaces/${home}/${input.workflowId}/integration`,
      };
    },
    mergeIntoIntegration: async () => ({
      ok: true,
      mergeCommitSha: "merge-sha",
    }),
    refreshIntegrationFromTarget: async () => {
      if (!refreshResult.ok) return refreshResult;
      return {
        ok: true as const,
        targetSha: shared.targetSha,
        mergeCommitSha: refreshResult.mergeCommitSha ?? "refresh-ok",
      };
    },
    listWorkflowBranches: async (workflowId) => {
      const found = new Set<string>();
      const integration = integrationBranchName(workflowId);
      if (!removed.has(integration)) found.add(integration);
      for (const c of creates) {
        if (c.workflowId === workflowId && !removed.has(c.branchName)) {
          found.add(c.branchName);
        }
      }
      return [...found].sort();
    },
    removeLocalBranches: async (branchNames) => {
      const owned: string[] = [];
      for (const b of branchNames) {
        // Tests may pass mixed lists; production cleanup already filters.
        removed.add(b);
        owned.push(b);
      }
      return {
        removedLocalBranches: owned,
        removedWorktrees: owned.map((b) => `/wt/${b}`),
      };
    },
    cleanupWorkflowWorkspaces: async (workflowId) => {
      const list = shared.cleanupLocalByHome.get(home) ?? [];
      list.push(workflowId);
      shared.cleanupLocalByHome.set(home, list);
      const branches = await port.listWorkflowBranches(workflowId);
      return port.removeLocalBranches(branches);
    },
    hasCommitsAhead: async () => ({
      ahead: true,
      headSha: sha("a"),
      count: 1,
    }),
  };

  return Object.assign(port, {
    setRefreshResult(next: RefreshResult) {
      refreshResult = next;
    },
  });
}

function createWorkers(): {
  port: WorkersPort;
  state: {
    launches: WorkerLaunchInput[];
    aborts: string[];
    sinks: Map<string, WorkerEventSink>;
  };
  emit(workerId: string, event: WorkerProtocolEvent): Promise<void>;
} {
  const state = {
    launches: [] as WorkerLaunchInput[],
    aborts: [] as string[],
    sinks: new Map<string, WorkerEventSink>(),
  };
  return {
    state,
    port: {
      launch: async (input, sink) => {
        state.launches.push(input);
        state.sinks.set(input.workerId, sink);
        return { workerId: input.workerId, pid: 2000 + state.launches.length, alive: true };
      },
      getRuntime: (workerId) =>
        state.sinks.has(workerId)
          ? { workerId, pid: 2000, alive: true }
          : undefined,
      abort: async (workerId) => {
        state.aborts.push(workerId);
        state.sinks.delete(workerId);
      },
      abortAll: async () => {
        for (const id of state.sinks.keys()) state.aborts.push(id);
        state.sinks.clear();
      },
    },
    emit: async (workerId, event) => {
      const sink = state.sinks.get(workerId);
      if (!sink) throw new Error(`No sink for ${workerId}`);
      await sink.onEvent(event);
    },
  };
}

function createTranscripts(): TranscriptPort {
  const events = new Map<string, unknown[]>();
  const key = (input: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
  }) => `${input.workflowId}:${input.ticketNumber}:${input.attempt}`;
  return {
    append: async (input, event) => {
      const entries = events.get(key(input)) ?? [];
      entries.push(event);
      events.set(key(input), entries);
    },
    read: async (input) => events.get(key(input)) ?? [],
    cleanupWorkflowTranscripts: async () => {},
  };
}

function createHome(input: {
  home: string;
  workflowId?: number;
  tracker: TrackerPort;
  shared: SharedTrackerState;
  coordination?: CoordinationPort;
  /** When true, omit coordination ports so the home uses the legacy v1 path. */
  legacy?: boolean;
}): {
  coordinator: ReturnType<typeof createWorkflowCoordinator>;
  workers: ReturnType<typeof createWorkers>;
  workspace: TestWorkspace;
  remoteDeletes: string[][];
} {
  const workers = createWorkers();
  const workspace = createWorkspace(input.home, input.shared);
  const remoteDeletes: string[][] = [];
  input.shared.deletedRemoteByHome.set(input.home, remoteDeletes);

  const root: RootScopedPorts = {
    environment: {
      hasSupportedTrackerRemote: async () => true,
      isTrackerAuthenticated: async () => true,
      targetBranchExists: async () => true,
      detectDefaultBranch: async () => "main",
    },
    skills: {
      installedSkillNames: async () => REQUIRED_MATT_SKILLS,
      runCreateSpec: async () => ({ ok: false, reason: "unused" }),
      runCreateTickets: async () => ({ ok: false, reason: "unused" }),
      prepareImplement: async (ticket) => ({
        ok: true,
        skillCommand: "/implement",
        prompt: `Implement #${ticket.ticketNumber}`,
      }),
      prepareResolveConflicts: async (ctx) => ({
        ok: true,
        skillCommand: "/resolving-merge-conflicts",
        prompt: [
          "/resolving-merge-conflicts",
          `kind=${"resolutionKind" in ctx ? (ctx as { resolutionKind?: string }).resolutionKind ?? "ticket" : "ticket"}`,
          `targetSha=${"targetSha" in ctx ? String((ctx as { targetSha?: string }).targetSha ?? "") : ""}`,
        ].join("\n"),
      }),
    },
    preferences: createPreferences(input.workflowId),
    tracker: input.tracker,
    workspace,
    workers: workers.port,
    transcripts: createTranscripts(),
    verification: {
      runLocalVerification: async () => ({ ok: true, commands: ["npm test"] }),
    },
    remoteGit: {
      pushBranch: async () => {},
      deleteRemoteBranches: async (branchNames) => {
        remoteDeletes.push([...branchNames]);
      },
      safePullBranch: async (branch) => ({
        ok: true,
        pulled: true,
        branch,
        submodulesUpdated: true,
      }),
    },
    ci: {
      checkStatus: async () => ({
        status: input.shared.ciStatus,
        summary: input.shared.ciStatus,
      }),
    },
    ...(input.legacy
      ? {}
      : input.coordination
        ? { coordination: input.coordination }
        : {}),
  };

  const ports: WorkflowCoordinatorPorts = {
    startPath: `/${input.home}`,
    topology: {
      nearestGitRoot: async () => `/${input.home}`,
      nestedGitRepositories: async () => [],
    },
    models: {
      listAvailableModels: async () => [],
      getHomeModel: async () => undefined,
    },
    forRoot: () => root,
  };

  return {
    coordinator: createWorkflowCoordinator(ports),
    workers,
    workspace,
    remoteDeletes,
  };
}

function integratedTicket(
  workflowId: number,
  ticketNumber: number,
  attempt = 1,
) {
  return {
    number: ticketNumber,
    attempt,
    branchName: implementationBranchName(workflowId, ticketNumber, attempt),
  };
}

function coordinatedWorkflow(
  workflowId: number,
  tickets: readonly number[],
  overrides: Partial<ActiveWorkflow> = {},
): ActiveWorkflow {
  return {
    workflowId,
    targetBranch: "main",
    stage: "tickets-published",
    workerProfile: profile,
    title: `Workflow ${workflowId}`,
    tickets: [...tickets],
    coordination: { target },
    ...overrides,
  };
}

function legacyWorkflow(
  workflowId: number,
  tickets: readonly number[],
  overrides: Partial<ActiveWorkflow> = {},
): ActiveWorkflow {
  return {
    workflowId,
    targetBranch: "main",
    stage: "tickets-published",
    workerProfile: profile,
    title: `Legacy ${workflowId}`,
    tickets: [...tickets],
    ...overrides,
  };
}

function testClock(initial = "2026-07-28T16:00:00.000Z") {
  let ms = Date.parse(initial);
  return {
    now: () => new Date(ms),
    advance: (amount: number) => {
      ms += amount;
    },
  };
}

async function completeImplement(
  home: ReturnType<typeof createHome>,
  workflowId: number,
  ticketNumber: number,
  attempt = 1,
) {
  await home.coordinator.runNextAction(implementTicketActionId(ticketNumber));
  const workerId = `implement-${workflowId}-${ticketNumber}-r${attempt}`;
  await home.workers.emit(workerId, {
    type: "stage-result",
    workerId,
    outcome: { status: "completed", summary: `Done #${ticketNumber}` },
  });
}

async function integrateTicket(
  home: ReturnType<typeof createHome>,
  workflowId: number,
  ticketNumber: number,
  attempt = 1,
) {
  await completeImplement(home, workflowId, ticketNumber, attempt);
  const result = await home.coordinator.confirmDisposition("close");
  expect(result).toMatchObject({
    status: "completed",
    stage: "ci-gate",
    ticketClosed: true,
    ticketNumber,
  });
  return result;
}

describe("workflow branch namespace helpers", () => {
  it("owns only exact workflow id prefixes, never sibling numeric prefixes", () => {
    expect(isWorkflowOwnedBranch(4, "matt-auto/4")).toBe(true);
    expect(isWorkflowOwnedBranch(4, "matt-auto/4/integration")).toBe(true);
    expect(isWorkflowOwnedBranch(4, "matt-auto/4/ticket-9/r1")).toBe(true);
    expect(isWorkflowOwnedBranch(4, "matt-auto/42/integration")).toBe(false);
    expect(isWorkflowOwnedBranch(42, "matt-auto/4/integration")).toBe(false);
    expect(isWorkflowOwnedBranch(42, "main")).toBe(false);
    expect(isWorkflowOwnedBranch(42, "matt-auto/gitlink/abc")).toBe(false);

    expect(
      filterWorkflowOwnedBranches(42, [
        "matt-auto/42/integration",
        "matt-auto/41/integration",
        "matt-auto/42/ticket-55/r1",
        "main",
        "matt-auto/420/ticket-1/r1",
      ]),
    ).toEqual([
      "matt-auto/42/integration",
      "matt-auto/42/ticket-55/r1",
    ]);
  });
});

describe("cleanup isolation for parallel workflows", () => {
  it("never deletes sibling branches, slots, leases, queue facts, or capacity policy", async () => {
    const clock = testClock();
    const store = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store, now: clock.now });
    await coordination.ensureWorkerCapacityPolicy({
      repository,
      seedWorkerCapacity: 2,
    });

    const wf42 = coordinatedWorkflow(42, [55], {
      stage: "merged",
      integrationBranch: integrationBranchName(42),
      integratedTickets: [
        integratedTicket(42, 55, 1),
      ],
      workflowPr: {
        number: 701,
        headBranch: integrationBranchName(42),
        baseBranch: "main",
      },
      // Intentionally include a sibling branch name on the completed unit to
      // prove cleanup re-filters by Workflow namespace.
    });
    // Force a corrupt integratedTickets entry that names a sibling branch.
    wf42.integratedTickets = [
      integratedTicket(41, 50, 1),
      integratedTicket(42, 55, 1),
    ];
    // Keep only one integrated ticket with both names via integrationBranch sibling poison:
    wf42.integrationBranch = integrationBranchName(42);

    const wf41 = coordinatedWorkflow(41, [50], {
      stage: "pr-opened",
      integrationBranch: integrationBranchName(41),
      integratedTickets: [
        integratedTicket(41, 50, 1),
      ],
      workflowPr: {
        number: 702,
        headBranch: integrationBranchName(41),
        baseBranch: "main",
      },
      coordination: {
        target,
        prFreshness: {
          headSha: sha("a"),
          mergeMethod: "squash",
          validatedTargetSha: sha("b"),
        },
        queueCandidate: {
          state: "merge-ready",
          mergeReadyAt: "2026-07-28T16:05:00.000Z",
        },
      },
    });

    const tracker = createSharedTracker(
      [wf42, wf41],
      [
        { number: 55, title: "T55", state: "CLOSED", blockedBy: [], parent: 42 },
        { number: 50, title: "T50", state: "CLOSED", blockedBy: [], parent: 41 },
      ],
    );

    // Seed local branches for both workflows under home-a.
    const home = createHome({
      home: "home-a",
      workflowId: 42,
      tracker: tracker.port,
      shared: tracker.state,
      coordination,
    });
    // Create local branches by ensuring workspaces.
    await home.workspace.ensureIntegrationWorkspace({
      workflowId: 42,
      baseRef: "main",
    });
    await home.workspace.createImplementationWorkspace({
      workflowId: 42,
      ticketNumber: 55,
      attempt: 1,
      baseRef: "main",
    });
    await home.workspace.ensureIntegrationWorkspace({
      workflowId: 41,
      baseRef: "main",
    });
    await home.workspace.createImplementationWorkspace({
      workflowId: 41,
      ticketNumber: 50,
      attempt: 1,
      baseRef: "main",
    });

    // Sibling worker slot + target lease + coordinator lease for 41.
    const siblingSlot = await coordination.acquireLease({
      kind: "worker-slot",
      repository,
      slot: 1,
      holderId: "sibling-home",
      workflowId: 41,
      ticketNumber: 50,
    });
    expect(siblingSlot.acquired).toBe(true);

    const siblingCoordinator = await coordination.acquireLease({
      kind: "workflow-coordinator",
      repository,
      target,
      workflowId: 41,
      holderId: "sibling-home",
    });
    expect(siblingCoordinator.acquired).toBe(true);

    // Ensure home-a holds 42's coordinator lease via a next-actions read.
    await home.coordinator.nextActions();

    const cleaned = await home.coordinator.runNextAction(
      CLEANUP_WORKFLOW_ACTION.id,
    );
    expect(cleaned).toMatchObject({
      status: "completed",
      stage: "cleanup",
      workflowId: 42,
      cleanedLocal: true,
      cleanedRemote: true,
    });

    const deleted = home.remoteDeletes.flat();
    expect(deleted.every((b) => isWorkflowOwnedBranch(42, b))).toBe(true);
    expect(deleted).not.toContain(integrationBranchName(41));
    expect(deleted).not.toContain(implementationBranchName(41, 50, 1));
    // Corrupt sibling branch name from manifest must be filtered out.
    expect(deleted).not.toContain(implementationBranchName(41, 50, 1));

    // Sibling local branches remain listable (cleanup only removed 42).
    const remaining41 = await home.workspace.listWorkflowBranches(41);
    expect(remaining41).toContain(integrationBranchName(41));
    expect(remaining41).toContain(implementationBranchName(41, 50, 1));

    // Sibling slot + coordinator lease intact.
    const slotAfter = await coordination.getLease({
      kind: "worker-slot",
      repository,
      slot: 1,
    });
    expect(slotAfter?.releasedAt).toBeUndefined();
    expect(slotAfter?.holderId).toBe("sibling-home");

    const coord41 = await coordination.getLease({
      kind: "workflow-coordinator",
      repository,
      target,
      workflowId: 41,
    });
    expect(coord41?.releasedAt).toBeUndefined();
    expect(coord41?.holderId).toBe("sibling-home");

    // Capacity policy survives.
    const policy = await coordination.getWorkerCapacityPolicy(repository);
    expect(policy?.workerCapacity).toBe(2);

    // Sibling queue facts untouched.
    const sibling = tracker.state.workflows.get(41);
    expect(sibling?.coordination?.queueCandidate).toEqual({
      state: "merge-ready",
      mergeReadyAt: "2026-07-28T16:05:00.000Z",
    });
    expect(sibling?.stage).toBe("pr-opened");

    // Completed workflow marked completed, parent closed.
    expect(tracker.state.workflows.get(42)?.stage).toBe("completed");
    expect(tracker.state.closedParents).toContain(42);
  });
});

describe("expired lease recovery and stale-holder fencing", () => {
  it("lets a contender reclaim expired coordinator/target/worker-slot leases and blocks stale holders", async () => {
    const clock = testClock();
    const store = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store, now: clock.now });
    await coordination.ensureWorkerCapacityPolicy({
      repository,
      seedWorkerCapacity: 2,
    });

    const staleCoordinator = await coordination.acquireLease({
      kind: "workflow-coordinator",
      repository,
      target,
      workflowId: 42,
      holderId: "stale-home",
      ttlMs: 1_000,
    });
    expect(staleCoordinator.acquired).toBe(true);
    const staleTarget = await coordination.acquireLease({
      kind: "target-branch",
      target,
      holderId: "stale-home",
      workflowId: 42,
      ttlMs: 1_000,
    });
    expect(staleTarget.acquired).toBe(true);
    const staleSlot = await coordination.acquireLease({
      kind: "worker-slot",
      repository,
      slot: 1,
      holderId: "stale-home",
      workflowId: 42,
      ticketNumber: 55,
      ttlMs: 1_000,
    });
    expect(staleSlot.acquired).toBe(true);

    clock.advance(DEFAULT_COORDINATION_LEASE_TTL_MS + 5_000);

    const freshCoordinator = await coordination.acquireLease({
      kind: "workflow-coordinator",
      repository,
      target,
      workflowId: 42,
      holderId: "fresh-home",
    });
    expect(freshCoordinator.acquired).toBe(true);
    if (!freshCoordinator.acquired) throw new Error("expected reclaim");
    expect(freshCoordinator.lease.generation).toBeGreaterThan(
      staleCoordinator.acquired ? staleCoordinator.lease.generation : 0,
    );

    const freshTarget = await coordination.acquireLease({
      kind: "target-branch",
      target,
      holderId: "fresh-home",
      workflowId: 42,
    });
    expect(freshTarget.acquired).toBe(true);

    const freshSlot = await coordination.acquireLease({
      kind: "worker-slot",
      repository,
      slot: 1,
      holderId: "fresh-home",
      workflowId: 42,
      ticketNumber: 55,
    });
    expect(freshSlot.acquired).toBe(true);

    // Stale holder cannot renew, release, or pass fencing verification.
    if (!staleCoordinator.acquired || !staleTarget.acquired || !staleSlot.acquired) {
      throw new Error("stale leases missing");
    }
    const renewStale = await coordination.renewLease({
      lease: staleCoordinator.lease,
    });
    expect(renewStale.renewed).toBe(false);

    const releaseStale = await coordination.releaseLease(staleCoordinator.lease);
    expect(releaseStale.released).toBe(false);

    const verifyStale = await coordination.verifyLease(staleCoordinator.lease);
    expect(verifyStale.valid).toBe(false);

    // A stale fencing token (old generation) cannot authorize automatic merge
    // even when the live Target SHA and PR checks still look green.
    if (!freshTarget.acquired || freshTarget.lease.kind !== "target-branch") {
      throw new Error("fresh target lease missing");
    }
    const freshness = evaluateMergeFreshness({
      heldLease: freshTarget.lease,
      expectedGeneration: staleTarget.lease.generation,
      expectedHolderId: "stale-home",
      validatedTargetSha: sha("b"),
      currentTargetSha: sha("b"),
      expectedHeadSha: sha("a"),
      currentHeadSha: sha("a"),
      requiredChecks: { headSha: sha("a"), status: "success" },
    });
    expect(freshness.ok).toBe(false);

    // Fresh holder can still write remotely (renew + verify).
    const renewFresh = await coordination.renewLease({
      lease: freshCoordinator.lease,
    });
    expect(renewFresh.renewed).toBe(true);
    const verifyFresh = await coordination.verifyLease(freshCoordinator.lease);
    expect(verifyFresh.valid).toBe(true);
  });

  it("blocks a Workflow home that lost its coordinator lease from remote cleanup writes", async () => {
    const clock = testClock();
    const store = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store, now: clock.now });
    await coordination.ensureWorkerCapacityPolicy({
      repository,
      seedWorkerCapacity: 2,
    });

    const wf = coordinatedWorkflow(42, [55], {
      stage: "merged",
      integrationBranch: integrationBranchName(42),
      integratedTickets: [
        integratedTicket(42, 55, 1),
      ],
      workflowPr: {
        number: 710,
        headBranch: integrationBranchName(42),
        baseBranch: "main",
      },
    });
    const tracker = createSharedTracker(
      [wf],
      [{ number: 55, title: "T55", state: "CLOSED", blockedBy: [] }],
    );

    const home = createHome({
      home: "home-stale",
      workflowId: 42,
      tracker: tracker.port,
      shared: tracker.state,
      coordination,
    });

    // Acquire via nextActions, then expire and reclaim under another holder.
    await home.coordinator.nextActions();
    const held = (
      await coordination.listLeases({
        repository,
        kind: "workflow-coordinator",
      })
    ).find(
      (l) =>
        l.kind === "workflow-coordinator" &&
        l.scope.workflowId === 42 &&
        !l.releasedAt,
    );
    expect(held).toBeDefined();

    clock.advance(DEFAULT_COORDINATION_LEASE_TTL_MS + 5_000);
    const reclaimed = await coordination.acquireLease({
      kind: "workflow-coordinator",
      repository,
      target,
      workflowId: 42,
      holderId: "other-home",
    });
    expect(reclaimed.acquired).toBe(true);

    const cleaned = await home.coordinator.runNextAction(
      CLEANUP_WORKFLOW_ACTION.id,
    );
    expect(cleaned.status).toBe("failed");
    expect(String((cleaned as { reason?: string }).reason ?? "")).toMatch(
      /already operated by another Workflow home|coordinator lease/i,
    );
    // No remote branch deletion when authority is lost.
    expect(home.remoteDeletes).toEqual([]);
  });
});

describe("legacy v1 workflow recovery path", () => {
  it("completes implement → integrate → PR → merge → cleanup without coordination ports", async () => {
    const wf = legacyWorkflow(42, [55], {
      stage: "tickets-published",
    });
    const tracker = createSharedTracker(
      [wf],
      [{ number: 55, title: "Legacy ticket", state: "OPEN", blockedBy: [] }],
    );
    const home = createHome({
      home: "legacy-home",
      workflowId: 42,
      tracker: tracker.port,
      shared: tracker.state,
      legacy: true,
    });

    await integrateTicket(home, 42, 55);

    const open = await home.coordinator.runNextAction(OPEN_WORKFLOW_PR_ACTION.id);
    expect(open).toMatchObject({
      status: "completed",
      stage: "workflow-pr",
      workflowId: 42,
    });
    expect(tracker.state.createPrCalls).toHaveLength(1);

    const merge = await home.coordinator.runNextAction(
      MERGE_WORKFLOW_PR_ACTION.id,
    );
    expect(merge).toMatchObject({
      status: "completed",
      stage: "workflow-pr",
      workflowId: 42,
    });
    expect(tracker.state.mergePrCalls).toHaveLength(1);

    const cleaned = await home.coordinator.runNextAction(
      CLEANUP_WORKFLOW_ACTION.id,
    );
    expect(cleaned).toMatchObject({
      status: "completed",
      stage: "cleanup",
      workflowId: 42,
      cleanedLocal: true,
      cleanedRemote: true,
    });
    expect(tracker.state.workflows.get(42)?.stage).toBe("completed");
    // Legacy path never touches coordination refs.
    expect(tracker.state.workflows.get(42)?.coordination).toBeUndefined();
  });
});

describe("end-to-end parallel delivery across two Workflow homes", () => {
  it("runs concurrent implementation, shared capacity, two PRs, FIFO merge, refresh after first merge", async () => {
    const clock = testClock();
    const store = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store, now: clock.now });
    await coordination.ensureWorkerCapacityPolicy({
      repository,
      seedWorkerCapacity: 2,
    });

    const wf41 = coordinatedWorkflow(41, [50]);
    const wf42 = coordinatedWorkflow(42, [55]);
    const tracker = createSharedTracker(
      [wf41, wf42],
      [
        { number: 50, title: "Ticket 50", state: "OPEN", blockedBy: [], parent: 41 },
        { number: 55, title: "Ticket 55", state: "OPEN", blockedBy: [], parent: 42 },
      ],
    );

    const home41 = createHome({
      home: "home-41",
      workflowId: 41,
      tracker: tracker.port,
      shared: tracker.state,
      coordination,
    });
    const home42 = createHome({
      home: "home-42",
      workflowId: 42,
      tracker: tracker.port,
      shared: tracker.state,
      coordination,
    });

    // Concurrent implementation under shared capacity=2.
    await home41.coordinator.runNextAction(implementTicketActionId(50));
    await home42.coordinator.runNextAction(implementTicketActionId(55));
    expect(home41.workers.state.launches).toHaveLength(1);
    expect(home42.workers.state.launches).toHaveLength(1);

    const liveSlots = (
      await coordination.listLeases({ repository, kind: "worker-slot" })
    ).filter((l) => l.kind === "worker-slot" && !l.releasedAt);
    expect(liveSlots).toHaveLength(2);

    // Complete both implementation units and integrate.
    await home41.workers.emit("implement-41-50-r1", {
      type: "stage-result",
      workerId: "implement-41-50-r1",
      outcome: { status: "completed", summary: "Done #50" },
    });
    await home42.workers.emit("implement-42-55-r1", {
      type: "stage-result",
      workerId: "implement-42-55-r1",
      outcome: { status: "completed", summary: "Done #55" },
    });
    await home41.coordinator.confirmDisposition("close");
    await home42.coordinator.confirmDisposition("close");

    // Two direct PRs (no waiting on the sibling).
    const pr41 = await home41.coordinator.runNextAction(OPEN_WORKFLOW_PR_ACTION.id);
    const pr42 = await home42.coordinator.runNextAction(OPEN_WORKFLOW_PR_ACTION.id);
    expect(pr41).toMatchObject({ status: "completed", stage: "workflow-pr" });
    expect(pr42).toMatchObject({ status: "completed", stage: "workflow-pr" });
    expect(tracker.state.createPrCalls).toHaveLength(2);
    expect(tracker.state.createPrCalls.map((c) => c.head).sort()).toEqual([
      "matt-auto/41/integration",
      "matt-auto/42/integration",
    ]);

    // Admit both PRs to merge-ready with FIFO timestamps (observe-pr-checks).
    // 41 becomes ready first so it is the Target-branch queue head.
    tracker.state.ciStatus = "success";
    function admitMergeReady(workflowId: number, mergeReadyAt: string) {
      const current = tracker.state.workflows.get(workflowId);
      if (!current?.coordination?.prFreshness) {
        throw new Error(`Workflow #${workflowId} missing prFreshness`);
      }
      tracker.state.workflows.set(workflowId, {
        ...current,
        coordination: {
          ...current.coordination,
          queueCandidate: { state: "merge-ready", mergeReadyAt },
        },
      });
    }
    admitMergeReady(41, "2026-07-28T16:01:00.000Z");
    admitMergeReady(42, "2026-07-28T16:02:00.000Z");

    const preRefresh = await tracker.port.findActiveWorkflows(target);
    const preQueue = reconstructTargetBranchQueue(target, preRefresh);
    expect(preQueue.entries.map((c) => c.workflowId)).toEqual([41, 42]);

    // Queue head refreshes first and records validated Target SHA.
    const refresh41 = await home41.coordinator.runNextAction(
      REFRESH_FROM_TARGET_ACTION.id,
    );
    expect(refresh41).toMatchObject({ status: "completed" });
    expect(
      tracker.state.workflows.get(41)?.coordination?.prFreshness?.validatedTargetSha,
    ).toBe(tracker.state.targetSha);

    // After refresh, 41 is awaiting re-checks. Re-admit only 41 so it remains
    // the sole merge-ready queue head (42 waits until after 41 merges).
    const waiting42 = tracker.state.workflows.get(42)!;
    tracker.state.workflows.set(42, {
      ...waiting42,
      coordination: {
        ...waiting42.coordination!,
        queueCandidate: { state: "awaiting-pr-checks" },
      },
    });
    admitMergeReady(41, "2026-07-28T16:03:00.000Z");

    const merge41 = await home41.coordinator.runNextAction(
      MERGE_WORKFLOW_PR_ACTION.id,
    );
    expect(merge41).toMatchObject({ status: "completed", stage: "workflow-pr" });
    expect(tracker.state.mergePrCalls.length).toBeGreaterThanOrEqual(1);

    // First merge advanced main. 42 still has no/old validated SHA relative to tip.
    const targetAfterFirstMerge = tracker.state.targetSha;

    // 42 may still be merge-ready from earlier; if it somehow has a validated SHA
    // for the old tip, merge must fail closed and demand refresh.
    const pre42 = tracker.state.workflows.get(42)!;
    tracker.state.workflows.set(42, {
      ...pre42,
      coordination: {
        ...pre42.coordination!,
        prFreshness: {
          headSha: sha("a"),
          mergeMethod: "squash",
          // Stale validated tip from before the first merge.
          validatedTargetSha: sha("b"),
        },
        queueCandidate: {
          state: "merge-ready",
          mergeReadyAt: "2026-07-28T16:02:00.000Z",
        },
      },
    });
    expect(targetAfterFirstMerge).not.toBe(sha("b"));

    const staleMerge = await home42.coordinator.runNextAction(
      MERGE_WORKFLOW_PR_ACTION.id,
    );
    expect(staleMerge.status).toBe("failed");
    expect(String((staleMerge as { reason?: string }).reason ?? "")).toMatch(
      /refresh|target|fresh|stale|SHA|advanced/i,
    );

    // Re-admit and refresh against the post-merge tip, then merge safely.
    admitMergeReady(42, "2026-07-28T16:04:00.000Z");
    const reRefresh = await home42.coordinator.runNextAction(
      REFRESH_FROM_TARGET_ACTION.id,
    );
    expect(reRefresh).toMatchObject({ status: "completed" });
    expect(
      tracker.state.workflows.get(42)?.coordination?.prFreshness?.validatedTargetSha,
    ).toBe(tracker.state.targetSha);

    admitMergeReady(42, "2026-07-28T16:05:00.000Z");
    const merge42 = await home42.coordinator.runNextAction(
      MERGE_WORKFLOW_PR_ACTION.id,
    );
    expect(merge42).toMatchObject({ status: "completed", stage: "workflow-pr" });
    expect(tracker.state.mergePrCalls.length).toBeGreaterThanOrEqual(2);
    // silence unused pr open results in typecheck-friendly way
    expect(pr41.status).toBe("completed");
    expect(pr42.status).toBe("completed");

    // Cleanup 41 must not touch 42's branches.
    await home41.workspace.createImplementationWorkspace({
      workflowId: 41,
      ticketNumber: 50,
      attempt: 1,
      baseRef: "main",
    });
    await home41.workspace.ensureIntegrationWorkspace({
      workflowId: 41,
      baseRef: "main",
    });
    // Seed 42 branches under home-41 workspace listing path (shared FS simulation
    // is per-home; ensure home-42 still has its branches after home-41 cleanup).
    await home42.workspace.createImplementationWorkspace({
      workflowId: 42,
      ticketNumber: 55,
      attempt: 1,
      baseRef: "main",
    });
    await home42.workspace.ensureIntegrationWorkspace({
      workflowId: 42,
      baseRef: "main",
    });

    const cleaned41 = await home41.coordinator.runNextAction(
      CLEANUP_WORKFLOW_ACTION.id,
    );
    expect(cleaned41).toMatchObject({
      status: "completed",
      stage: "cleanup",
      workflowId: 41,
    });
    const deleted41 = home41.remoteDeletes.flat();
    expect(deleted41.every((b) => isWorkflowOwnedBranch(41, b))).toBe(true);
    expect(deleted41).not.toContain(integrationBranchName(42));

    const remaining42 = await home42.workspace.listWorkflowBranches(42);
    expect(remaining42).toContain(integrationBranchName(42));
  });
});

describe("target-refresh, CI pending, retries, external advancement, controls", () => {
  it("covers target-refresh conflict success and failure through the queue", async () => {
    const clock = testClock();

    // --- Failure path: workspace conflict launches conflict worker or fails closed.
    {
      const store = createInMemoryCoordinationStore();
      const coordination = createFakeCoordinationPort({ store, now: clock.now });
      const active = coordinatedWorkflow(44, [60], {
        stage: "pr-opened",
        integrationBranch: integrationBranchName(44),
        integratedTickets: [
          integratedTicket(44, 60, 1),
        ],
        workflowPr: {
          number: 800,
          headBranch: integrationBranchName(44),
          baseBranch: "main",
        },
        coordination: {
          target,
          prFreshness: { headSha: sha("a"), mergeMethod: "squash" },
          queueCandidate: {
            state: "merge-ready",
            mergeReadyAt: clock.now().toISOString(),
          },
        },
      });
      const tracker = createSharedTracker(
        [active],
        [{ number: 60, title: "T60", state: "CLOSED", blockedBy: [] }],
      );
      const home = createHome({
        home: "home-refresh-conflict",
        workflowId: 44,
        tracker: tracker.port,
        shared: tracker.state,
        coordination,
      });
      home.workspace.setRefreshResult({
        ok: false,
        reason: "conflict",
        message: "CONFLICT on main.txt",
        targetSha: tracker.state.targetSha,
      });
      const conflicted = await home.coordinator.runNextAction(
        REFRESH_FROM_TARGET_ACTION.id,
      );
      expect(["running", "failed"]).toContain(conflicted.status);
      if (conflicted.status === "running") {
        expect(
          home.workers.state.launches.some(
            (l) =>
              l.workerId.includes("conflict") ||
              l.prompt.includes("resolving-merge-conflicts") ||
              l.skillCommand === "/resolving-merge-conflicts",
          ),
        ).toBe(true);
      } else {
        // Fail-closed path records a retryable queue outcome and releases the lane.
        const candidate = tracker.state.workflows.get(44)?.coordination?.queueCandidate;
        expect(
          candidate?.state === "retryable" ||
            candidate?.state === "transient-retry" ||
            candidate?.state === "merge-ready",
        ).toBe(true);
        const targetLease = await coordination.getLease({
          kind: "target-branch",
          target,
        });
        expect(
          !targetLease || targetLease.releasedAt !== undefined,
        ).toBe(true);
      }
    }

    // --- Success path: clean refresh records validatedTargetSha and releases lease.
    {
      const store = createInMemoryCoordinationStore();
      const coordination = createFakeCoordinationPort({ store, now: clock.now });
      const active = coordinatedWorkflow(44, [60], {
        stage: "pr-opened",
        integrationBranch: integrationBranchName(44),
        integratedTickets: [
          integratedTicket(44, 60, 1),
        ],
        workflowPr: {
          number: 800,
          headBranch: integrationBranchName(44),
          baseBranch: "main",
        },
        coordination: {
          target,
          prFreshness: { headSha: sha("a"), mergeMethod: "squash" },
          queueCandidate: {
            state: "merge-ready",
            mergeReadyAt: clock.now().toISOString(),
          },
        },
      });
      const tracker = createSharedTracker(
        [active],
        [{ number: 60, title: "T60", state: "CLOSED", blockedBy: [] }],
      );
      const home = createHome({
        home: "home-refresh-ok",
        workflowId: 44,
        tracker: tracker.port,
        shared: tracker.state,
        coordination,
      });
      home.workspace.setRefreshResult({
        ok: true,
        targetSha: tracker.state.targetSha,
      });
      const ok = await home.coordinator.runNextAction(
        REFRESH_FROM_TARGET_ACTION.id,
      );
      expect(ok).toMatchObject({ status: "completed", stage: "target-refresh" });
      const after = tracker.state.workflows.get(44);
      expect(after?.coordination?.prFreshness?.validatedTargetSha).toBe(
        tracker.state.targetSha,
      );
      const targetLease = await coordination.getLease({
        kind: "target-branch",
        target,
      });
      expect(!targetLease || targetLease.releasedAt !== undefined).toBe(true);
    }
  });

  it("releases the Target-branch lease while PR CI is pending", async () => {
    const clock = testClock();
    const store = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store, now: clock.now });
    const active = coordinatedWorkflow(45, [61], {
      stage: "pr-opened",
      integrationBranch: integrationBranchName(45),
      integratedTickets: [
        integratedTicket(45, 61, 1),
      ],
      workflowPr: {
        number: 801,
        headBranch: integrationBranchName(45),
        baseBranch: "main",
      },
      coordination: {
        target,
        prFreshness: {
          headSha: sha("a"),
          mergeMethod: "squash",
          validatedTargetSha: sha("b"),
        },
        queueCandidate: {
          state: "merge-ready",
          mergeReadyAt: clock.now().toISOString(),
        },
      },
    });
    const tracker = createSharedTracker(
      [active],
      [{ number: 61, title: "T61", state: "CLOSED", blockedBy: [] }],
    );
    tracker.state.ciStatus = "pending";
    tracker.state.prHeadByNumber.set(801, {
      headSha: sha("a"),
      baseSha: sha("b"),
    });
    tracker.state.targetSha = sha("b");

    const home = createHome({
      home: "home-ci-pending",
      workflowId: 45,
      tracker: tracker.port,
      shared: tracker.state,
      coordination,
    });

    const merge = await home.coordinator.runNextAction(MERGE_WORKFLOW_PR_ACTION.id);
    expect(merge.status).toBe("failed");

    const targetLease = await coordination.getLease({
      kind: "target-branch",
      target,
    });
    // Lease must not remain held after CI-pending fail-closed path.
    expect(
      !targetLease ||
        targetLease.releasedAt !== undefined ||
        targetLease.holderId === undefined,
    ).toBe(true);
  });

  it("exhausts bounded transient retries into a deterministic retryable state", () => {
    const clock = testClock();
    let candidate = recordTargetBranchQueueFailure({
      kind: "transient",
      reason: "github-flaky",
      now: clock.now(),
      retryPolicy: { maxAttempts: DEFAULT_TARGET_BRANCH_TRANSIENT_RETRY_MAX_ATTEMPTS },
    });
    expect(candidate.state).toBe("transient-retry");

    for (let i = 0; i < DEFAULT_TARGET_BRANCH_TRANSIENT_RETRY_MAX_ATTEMPTS; i++) {
      clock.advance(60_000);
      candidate = recordTargetBranchQueueFailure({
        candidate,
        kind: "transient",
        reason: "github-flaky",
        now: clock.now(),
      });
    }
    expect(candidate.state).toBe("retryable");
    if (candidate.state === "retryable") {
      expect(candidate.retry.reason).toMatch(/transient-retry-exhausted/);
    }
  });

  it("rejects merge when the Target branch advances externally after green checks", () => {
    const held = {
      kind: "target-branch" as const,
      scope: { target },
      holderId: "home-a",
      generation: 3,
      acquiredAt: "2026-07-28T16:00:00.000Z",
      heartbeatAt: "2026-07-28T16:00:00.000Z",
      expiresAt: "2026-07-28T16:05:00.000Z",
    };
    const result = evaluateMergeFreshness({
      heldLease: held,
      expectedGeneration: 3,
      expectedHolderId: "home-a",
      validatedTargetSha: sha("b"),
      currentTargetSha: sha("c"), // external advancement
      expectedHeadSha: sha("a"),
      currentHeadSha: sha("a"),
      requiredChecks: { headSha: sha("a"), status: "success" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("requeue-refresh");
    }
  });

  it("scopes Pause and Terminate to the bound workflow without releasing sibling slots", async () => {
    const store = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store });
    await coordination.ensureWorkerCapacityPolicy({
      repository,
      seedWorkerCapacity: 2,
    });

    const bound = coordinatedWorkflow(42, [55]);
    const sibling = coordinatedWorkflow(41, [50]);
    const tracker = createSharedTracker(
      [bound, sibling],
      [
        { number: 55, title: "T55", state: "OPEN", blockedBy: [] },
        { number: 50, title: "T50", state: "OPEN", blockedBy: [] },
      ],
    );
    const home = createHome({
      home: "home-controls",
      workflowId: 42,
      tracker: tracker.port,
      shared: tracker.state,
      coordination,
    });

    const siblingSlot = await coordination.acquireLease({
      kind: "worker-slot",
      repository,
      slot: 2,
      holderId: "sibling-home",
      workflowId: 41,
      ticketNumber: 50,
    });
    expect(siblingSlot.acquired).toBe(true);

    await home.coordinator.runNextAction(implementTicketActionId(55));
    const paused = await home.coordinator.pausePipeline();
    expect(paused.pipelinePaused).toBe(true);
    expect(paused.releasedWorkerSlotCount).toBeGreaterThanOrEqual(1);

    const stillSibling = await coordination.getLease({
      kind: "worker-slot",
      repository,
      slot: 2,
    });
    expect(stillSibling?.releasedAt).toBeUndefined();
    expect(stillSibling?.holderId).toBe("sibling-home");

    // Resume and launch again, then terminate.
    await home.coordinator.resumePipeline();
    await home.coordinator.runNextAction(implementTicketActionId(55));
    const terminated = await home.coordinator.terminateRun();
    expect(terminated.runTerminated).toBe(true);
    expect(terminated.releasedWorkerSlotCount).toBeGreaterThanOrEqual(1);

    const stillSiblingAfter = await coordination.getLease({
      kind: "worker-slot",
      repository,
      slot: 2,
    });
    expect(stillSiblingAfter?.releasedAt).toBeUndefined();
    expect(stillSiblingAfter?.holderId).toBe("sibling-home");
  });

  it("Emergency stop aborts workers and releases the bound coordinator lease", async () => {
    const store = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store });
    await coordination.ensureWorkerCapacityPolicy({
      repository,
      seedWorkerCapacity: 2,
    });
    const bound = coordinatedWorkflow(42, [55]);
    const tracker = createSharedTracker(
      [bound],
      [{ number: 55, title: "T55", state: "OPEN", blockedBy: [] }],
    );
    const home = createHome({
      home: "home-emergency",
      workflowId: 42,
      tracker: tracker.port,
      shared: tracker.state,
      coordination,
    });

    await home.coordinator.runNextAction(implementTicketActionId(55));
    await home.coordinator.nextActions();

    const before = await coordination.getLease({
      kind: "workflow-coordinator",
      repository,
      target,
      workflowId: 42,
    });
    expect(before && !before.releasedAt).toBe(true);

    const result = await home.coordinator.emergencyStop();
    expect(result.lastStopReason).toBe("emergency-stop");
    expect(result.releasedCoordinatorLease).toBe(true);
    expect(home.workers.state.aborts.length).toBeGreaterThanOrEqual(1);

    const after = await coordination.getLease({
      kind: "workflow-coordinator",
      repository,
      target,
      workflowId: 42,
    });
    expect(!after || after.releasedAt !== undefined).toBe(true);
  });

  it("queue orchestrator recovers an expired Target-branch lease for the next candidate", async () => {
    const clock = testClock();
    const store = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store, now: clock.now });

    const first = coordinatedWorkflow(41, [50], {
      stage: "pr-opened",
      workflowPr: {
        number: 901,
        headBranch: integrationBranchName(41),
        baseBranch: "main",
      },
      coordination: {
        target,
        prFreshness: {
          headSha: sha("a"),
          mergeMethod: "squash",
          validatedTargetSha: sha("b"),
        },
        queueCandidate: {
          state: "merge-ready",
          mergeReadyAt: "2026-07-28T16:00:00.000Z",
        },
      },
    });
    const second = coordinatedWorkflow(42, [55], {
      stage: "pr-opened",
      workflowPr: {
        number: 902,
        headBranch: integrationBranchName(42),
        baseBranch: "main",
      },
      coordination: {
        target,
        prFreshness: {
          headSha: sha("a"),
          mergeMethod: "squash",
          validatedTargetSha: sha("b"),
        },
        queueCandidate: {
          state: "merge-ready",
          mergeReadyAt: "2026-07-28T16:01:00.000Z",
        },
      },
    });
    const workflows = new Map<number, ActiveWorkflow>([
      [41, first],
      [42, second],
    ]);

    const lease41 = await coordination.acquireLease({
      kind: "workflow-coordinator",
      repository,
      target,
      workflowId: 41,
      holderId: "home-41",
      ttlMs: 1_000,
    });
    expect(lease41.acquired).toBe(true);
    if (!lease41.acquired || lease41.lease.kind !== "workflow-coordinator") {
      throw new Error("lease41");
    }

    const queue = createTargetBranchQueueOrchestrator({
      target,
      coordination,
      workflowId: 41,
      holderId: "home-41",
      now: clock.now,
      store: {
        listActiveWorkflows: async () =>
          [...workflows.values()].map((w) => cloneActive(w)),
        writeWorkflowManifest: async (id, manifest) => {
          workflows.set(id, activeWorkflowFromManifest(manifest));
        },
      },
    });

    const acquired = await queue.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: lease41.lease,
      phase: "refresh",
    });
    expect(acquired.ok).toBe(true);

    clock.advance(DEFAULT_COORDINATION_LEASE_TTL_MS + 5_000);

    const lease42 = await coordination.acquireLease({
      kind: "workflow-coordinator",
      repository,
      target,
      workflowId: 42,
      holderId: "home-42",
    });
    expect(lease42.acquired).toBe(true);
    if (!lease42.acquired || lease42.lease.kind !== "workflow-coordinator") {
      throw new Error("lease42");
    }

    const queue42 = createTargetBranchQueueOrchestrator({
      target,
      coordination,
      workflowId: 42,
      holderId: "home-42",
      now: clock.now,
      store: {
        listActiveWorkflows: async () =>
          [...workflows.values()].map((w) => cloneActive(w)),
        writeWorkflowManifest: async (id, manifest) => {
          workflows.set(id, activeWorkflowFromManifest(manifest));
        },
      },
    });
    const recovered = await queue42.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: lease42.lease,
      phase: "refresh",
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.lease?.holderId).toBe("home-42");
  });
});

describe("issue #57: no required checks must not stall on awaiting-pr-checks", () => {
  it("offers Refresh after open PR and completes Refresh → Merge without CI", async () => {
    const clock = testClock();
    const store = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store, now: clock.now });
    await coordination.ensureWorkerCapacityPolicy({
      repository,
      seedWorkerCapacity: 2,
    });

    const wf = coordinatedWorkflow(57, [70]);
    const tracker = createSharedTracker(
      [wf],
      [{ number: 70, title: "No-CI ticket", state: "OPEN", blockedBy: [] }],
    );
    // No required status checks on Target (private free / local-only delivery).
    tracker.state.requiredStatusChecks = { strict: false, contexts: [] };
    // Ticket-level CI green for integrate; PR CI will stay pending after open.
    tracker.state.ciStatus = "success";

    const home = createHome({
      home: "home-57",
      workflowId: 57,
      tracker: tracker.port,
      shared: tracker.state,
      coordination,
    });

    await integrateTicket(home, 57, 70);
    // Simulate Actions never starting after Workflow PR open.
    tracker.state.ciStatus = "pending";

    const open = await home.coordinator.runNextAction(OPEN_WORKFLOW_PR_ACTION.id);
    expect(open).toMatchObject({ status: "completed", stage: "workflow-pr" });

    const afterOpen = tracker.state.workflows.get(57);
    expect(afterOpen?.coordination?.prFreshness?.validatedTargetSha).toBeUndefined();
    expect(afterOpen?.coordination?.queueCandidate?.state).toBe("merge-ready");

    const idsAfterOpen = (await home.coordinator.nextActions()).map((a) => a.id);
    expect(idsAfterOpen).toContain(REFRESH_FROM_TARGET_ACTION.id);
    expect(idsAfterOpen).not.toContain(MERGE_WORKFLOW_PR_ACTION.id);

    const refreshed = await home.coordinator.runNextAction(
      REFRESH_FROM_TARGET_ACTION.id,
    );
    expect(refreshed).toMatchObject({ status: "completed" });
    expect(
      tracker.state.workflows.get(57)?.coordination?.prFreshness?.validatedTargetSha,
    ).toBe(tracker.state.targetSha);

    const idsAfterRefresh = (await home.coordinator.nextActions()).map((a) => a.id);
    expect(idsAfterRefresh).toContain(MERGE_WORKFLOW_PR_ACTION.id);

    const merged = await home.coordinator.runNextAction(MERGE_WORKFLOW_PR_ACTION.id);
    expect(merged).toMatchObject({ status: "completed", stage: "workflow-pr" });
    expect(tracker.state.mergePrCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("still offers Refresh from awaiting-pr-checks when validatedTargetSha is missing", async () => {
    const clock = testClock();
    const store = createInMemoryCoordinationStore();
    const coordination = createFakeCoordinationPort({ store, now: clock.now });
    await coordination.ensureWorkerCapacityPolicy({
      repository,
      seedWorkerCapacity: 2,
    });

    const wf = coordinatedWorkflow(58, [71], {
      stage: "pr-opened",
      integrationBranch: integrationBranchName(58),
      integratedTickets: [integratedTicket(58, 71, 1)],
      workflowPr: {
        number: 858,
        headBranch: integrationBranchName(58),
        baseBranch: "main",
      },
      coordination: {
        target,
        prFreshness: {
          headSha: sha("a"),
          mergeMethod: "squash",
        },
        queueCandidate: { state: "awaiting-pr-checks" },
      },
    });
    const tracker = createSharedTracker(
      [wf],
      [{ number: 71, title: "Stuck awaiting", state: "CLOSED", blockedBy: [] }],
    );
    // Required checks configured — still must surface Refresh when freshness is missing.
    tracker.state.requiredStatusChecks = { strict: true, contexts: ["ci"] };
    tracker.state.ciStatus = "pending";
    tracker.state.prHeadByNumber.set(858, {
      headSha: sha("a"),
      baseSha: tracker.state.targetSha,
    });

    const home = createHome({
      home: "home-58",
      workflowId: 58,
      tracker: tracker.port,
      shared: tracker.state,
      coordination,
    });
    await home.workspace.ensureIntegrationWorkspace({
      workflowId: 58,
      baseRef: "main",
    });

    const ids = (await home.coordinator.nextActions()).map((a) => a.id);
    expect(ids).toContain(REFRESH_FROM_TARGET_ACTION.id);
    expect(ids).not.toContain(MERGE_WORKFLOW_PR_ACTION.id);

    const refreshed = await home.coordinator.runNextAction(
      REFRESH_FROM_TARGET_ACTION.id,
    );
    expect(refreshed).toMatchObject({ status: "completed" });
    expect(
      tracker.state.workflows.get(58)?.coordination?.prFreshness?.validatedTargetSha,
    ).toBe(tracker.state.targetSha);
  });
});
