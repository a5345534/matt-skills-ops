import { describe, expect, it, vi } from "vitest";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import {
  DEFAULT_COORDINATION_LEASE_HEARTBEAT_INTERVAL_MS,
  REQUIRED_MATT_SKILLS,
  implementTicketActionId,
  implementationBranchName,
} from "../src/constants.js";
import {
  createFakeCoordinationPort,
  createInMemoryCoordinationStore,
} from "../src/adapters/coordination.js";
import { canonicalTargetIdentityKey } from "../src/coordination.js";
import { planRepositoryWorkerSlots } from "../src/worker-capacity.js";
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
  WorkerProfile,
  WorkerProtocolEvent,
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

type Ticket = {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  blockedBy: readonly { number: number; state: "OPEN" | "CLOSED" }[];
};

type WorkflowFixture = {
  workflowId: number;
  tickets: readonly Ticket[];
};

function workflow(fixture: WorkflowFixture): ActiveWorkflow {
  return {
    workflowId: fixture.workflowId,
    targetBranch: "main",
    stage: "tickets-published",
    workerProfile: profile,
    tickets: fixture.tickets.map((ticket) => ticket.number),
    coordination: { target },
  };
}

function cloneActive(active: ActiveWorkflow): ActiveWorkflow {
  return {
    ...active,
    workerProfile: { ...active.workerProfile },
    ...(active.tickets ? { tickets: [...active.tickets] } : {}),
    ...(active.coordination
      ? {
          coordination: {
            ...active.coordination,
            target: {
              repository: { ...active.coordination.target.repository },
              targetRef: active.coordination.target.targetRef,
            },
          },
        }
      : {}),
  };
}

function createTracker(fixtures: readonly WorkflowFixture[]): TrackerPort {
  const workflows = fixtures.map(workflow);
  const tickets = new Map<number, Ticket>(
    fixtures.flatMap((fixture) => fixture.tickets).map((ticket) => [
      ticket.number,
      { ...ticket, blockedBy: [...ticket.blockedBy] },
    ]),
  );

  return {
    getCanonicalRepositoryIdentity: async () => ({ ...repository }),
    findActiveWorkflows: async (requestedTarget) =>
      canonicalTargetIdentityKey(requestedTarget) ===
      canonicalTargetIdentityKey(target)
        ? workflows.map(cloneActive)
        : [],
    findActiveWorkflowsForRepository: async (requestedRepository) =>
      requestedRepository.owner.toLowerCase() === repository.owner.toLowerCase() &&
      requestedRepository.name.toLowerCase() === repository.name.toLowerCase()
        ? workflows.map(cloneActive)
        : [],
    findActiveWorkflow: async (_branch, workflowId) => {
      const found = workflows.find((candidate) => candidate.workflowId === workflowId);
      return found ? cloneActive(found) : undefined;
    },
    listTickets: async (numbers) =>
      numbers.flatMap((number) => {
        const ticket = tickets.get(number);
        return ticket
          ? [
              {
                number: ticket.number,
                title: ticket.title,
                state: ticket.state,
                blockedBy: [...ticket.blockedBy],
              },
            ]
          : [];
      }),
    createIssue: async () => ({ number: 900 }),
    writeWorkflowManifest: async () => {},
    addBlockedBy: async () => {},
    addSubIssue: async () => {},
    closeIssue: async () => {},
    reopenIssue: async () => {},
    createPullRequest: async () => ({ number: 900 }),
    mergePullRequest: async () => {},
  };
}

function createPreferences(
  workflowId: number,
  capacity: number,
): PreferencesPort {
  return {
    getConfiguredTargetBranch: async () => "main",
    getGlobalWorkerProfile: async () => profile,
    getRootWorkerProfile: async () => undefined,
    getWorkflowSnapshotWorkerProfile: async () => undefined,
    setGlobalWorkerProfile: async () => {},
    setRootWorkerProfile: async () => {},
    clearRootWorkerProfile: async () => {},
    getGlobalWorkerConcurrency: async () => undefined,
    getRootWorkerConcurrency: async () => capacity,
    setGlobalWorkerConcurrency: async () => {},
    setRootWorkerConcurrency: async () => {},
    clearRootWorkerConcurrency: async () => {},
    getActiveWorkflowId: async () => undefined,
    setActiveWorkflowId: async () => {},
    clearActiveWorkflowId: async () => {},
    getWorkflowHomeBinding: async (requestedTarget) =>
      canonicalTargetIdentityKey(requestedTarget) ===
      canonicalTargetIdentityKey(target)
        ? { target, workflowId }
        : undefined,
    setWorkflowHomeBinding: async () => {},
    clearWorkflowHomeBinding: async () => {},
  };
}

function createWorkspace(home: string): WorkspacePort {
  const attempts = new Map<string, number>();
  const create = async (input: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
  }) => {
    attempts.set(`${input.workflowId}:${input.ticketNumber}`, input.attempt);
    return {
      branchName: implementationBranchName(
        input.workflowId,
        input.ticketNumber,
        input.attempt,
      ),
      worktreePath: `/workspaces/${home}/${input.workflowId}/${input.ticketNumber}/r${input.attempt}`,
    };
  };
  return {
    latestAttempt: async (workflowId, ticketNumber) =>
      attempts.get(`${workflowId}:${ticketNumber}`) ?? 0,
    createImplementationWorkspace: create,
    ensureImplementationWorkspace: create,
    ensureIntegrationWorkspace: async () => ({
      branchName: "unused",
      worktreePath: `/workspaces/${home}/integration`,
    }),
    mergeIntoIntegration: async () => ({ ok: true }),
    listWorkflowBranches: async () => [],
    cleanupWorkflowWorkspaces: async () => ({
      removedWorktrees: [],
      removedLocalBranches: [],
    }),
    removeLocalBranches: async () => ({
      removedWorktrees: [],
      removedLocalBranches: [],
    }),
    hasCommitsAhead: async () => ({ ahead: false, count: 0 }),
  };
}

type WorkerState = {
  launches: WorkerLaunchInput[];
  aborts: string[];
  sinks: Map<string, WorkerEventSink>;
};

function createWorkers(): {
  port: WorkersPort;
  state: WorkerState;
  emit(workerId: string, event: WorkerProtocolEvent): Promise<void>;
} {
  const state: WorkerState = { launches: [], aborts: [], sinks: new Map() };
  return {
    state,
    port: {
      launch: async (input, sink) => {
        state.launches.push(input);
        state.sinks.set(input.workerId, sink);
        return { workerId: input.workerId, pid: 1234, alive: true };
      },
      getRuntime: (workerId) =>
        state.sinks.has(workerId)
          ? { workerId, pid: 1234, alive: true }
          : undefined,
      abort: async (workerId) => {
        state.aborts.push(workerId);
        state.sinks.delete(workerId);
      },
      abortAll: async () => {
        for (const workerId of state.sinks.keys()) state.aborts.push(workerId);
        state.sinks.clear();
      },
    },
    emit: async (workerId, event) => {
      const sink = state.sinks.get(workerId);
      if (!sink) throw new Error(`No worker sink for ${workerId}`);
      await sink.onEvent(event);
    },
  };
}

function createTranscripts(): TranscriptPort {
  const events = new Map<string, unknown[]>();
  const key = (input: { workflowId: number; ticketNumber: number; attempt: number }) =>
    `${input.workflowId}:${input.ticketNumber}:${input.attempt}`;
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
  workflowId: number;
  capacity: number;
  tracker: TrackerPort;
  coordination: CoordinationPort;
}): {
  coordinator: ReturnType<typeof createWorkflowCoordinator>;
  workers: ReturnType<typeof createWorkers>;
} {
  const workers = createWorkers();
  const root: RootScopedPorts = {
    environment: {
      hasGitHubRemote: async () => true,
      isGhAuthenticated: async () => true,
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
      prepareResolveConflicts: async () => ({ ok: false, reason: "unused" }),
    },
    preferences: createPreferences(input.workflowId, input.capacity),
    tracker: input.tracker,
    workspace: createWorkspace(input.home),
    workers: workers.port,
    transcripts: createTranscripts(),
    verification: {
      runLocalVerification: async () => ({ ok: true, commands: [] }),
    },
    remoteGit: {
      pushBranch: async () => {},
      deleteRemoteBranches: async () => {},
      safePullBranch: async (branch) => ({ ok: true, pulled: true, branch }),
    },
    ci: { checkStatus: async () => ({ status: "pending" }) },
    coordination: input.coordination,
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
  return { coordinator: createWorkflowCoordinator(ports), workers };
}

function testClock(initial = "2026-07-28T16:00:00.000Z"): {
  now(): Date;
  advance(ms: number): void;
} {
  let ms = Date.parse(initial);
  return {
    now: () => new Date(ms),
    advance: (amount) => {
      ms += amount;
    },
  };
}

describe("repository worker-slot allocation", () => {
  it("allocates one slot per eligible workflow before giving either a second", () => {
    const plan = planRepositoryWorkerSlots({
      capacity: 4,
      occupied: [],
      demands: [
        { workflowId: 20, readyTicketNumbers: [201, 202] },
        { workflowId: 10, readyTicketNumbers: [101, 102] },
      ],
    });

    expect(plan.assignments).toEqual([
      { slot: 1, workflowId: 10, ticketNumber: 101 },
      { slot: 2, workflowId: 20, ticketNumber: 201 },
      { slot: 3, workflowId: 10, ticketNumber: 102 },
      { slot: 4, workflowId: 20, ticketNumber: 202 },
    ]);
    expect(plan.claimable).toEqual([
      { workflowId: 10, ticketNumber: 101 },
      { workflowId: 20, ticketNumber: 201 },
    ]);
  });

  it("is work-conserving when another workflow has no ready ticket", () => {
    const plan = planRepositoryWorkerSlots({
      capacity: 3,
      occupied: [],
      demands: [
        { workflowId: 10, readyTicketNumbers: [101, 102, 103] },
        { workflowId: 20, readyTicketNumbers: [] },
      ],
    });

    expect(plan.assignments).toEqual([
      { slot: 1, workflowId: 10, ticketNumber: 101 },
      { slot: 2, workflowId: 10, ticketNumber: 102 },
      { slot: 3, workflowId: 10, ticketNumber: 103 },
    ]);
  });

  it("enforces one shared capacity across homes and prevents a second first-home slot", async () => {
    const tracker = createTracker([
      {
        workflowId: 10,
        tickets: [
          { number: 101, title: "A first", state: "OPEN", blockedBy: [] },
          { number: 102, title: "A second", state: "OPEN", blockedBy: [] },
        ],
      },
      {
        workflowId: 20,
        tickets: [
          { number: 201, title: "B first", state: "OPEN", blockedBy: [] },
        ],
      },
    ]);
    const store = createInMemoryCoordinationStore();
    const first = createHome({
      home: "home-a",
      workflowId: 10,
      capacity: 2,
      tracker,
      coordination: createFakeCoordinationPort({ store }),
    });
    const second = createHome({
      home: "home-b",
      workflowId: 20,
      capacity: 2,
      tracker,
      coordination: createFakeCoordinationPort({ store }),
    });

    const [firstResult, secondResult] = await Promise.all([
      first.coordinator.runNextAction(implementTicketActionId(101)),
      second.coordinator.runNextAction(implementTicketActionId(201)),
    ]);
    expect(firstResult).toMatchObject({ status: "running", ticketNumber: 101 });
    expect(secondResult).toMatchObject({ status: "running", ticketNumber: 201 });
    await expect(
      first.coordinator.runNextAction(implementTicketActionId(102)),
    ).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/capacity|fair slot/i),
    });

    const slots = await createFakeCoordinationPort({ store }).listLeases({
      repository,
      kind: "worker-slot",
    });
    expect(slots.filter((slot) => slot.releasedAt === undefined)).toHaveLength(2);
    expect(first.workers.state.launches).toHaveLength(1);
    expect(second.workers.state.launches).toHaveLength(1);
  });

  it("lets either equal-share home claim the first slot instead of idling it", async () => {
    const tracker = createTracker([
      {
        workflowId: 10,
        tickets: [
          { number: 101, title: "A first", state: "OPEN", blockedBy: [] },
        ],
      },
      {
        workflowId: 20,
        tickets: [
          { number: 201, title: "B first", state: "OPEN", blockedBy: [] },
        ],
      },
    ]);
    const store = createInMemoryCoordinationStore();
    const second = createHome({
      home: "home-b",
      workflowId: 20,
      capacity: 1,
      tracker,
      coordination: createFakeCoordinationPort({ store }),
    });

    await expect(
      second.coordinator.runNextAction(implementTicketActionId(201)),
    ).resolves.toMatchObject({ status: "running", ticketNumber: 201 });
    expect(second.workers.state.launches).toHaveLength(1);
  });

  it("uses spare shared capacity when sibling workflows have no ready work", async () => {
    const tracker = createTracker([
      {
        workflowId: 10,
        tickets: [
          { number: 101, title: "A first", state: "OPEN", blockedBy: [] },
          { number: 102, title: "A second", state: "OPEN", blockedBy: [] },
        ],
      },
      {
        workflowId: 20,
        tickets: [
          { number: 201, title: "B complete", state: "CLOSED", blockedBy: [] },
        ],
      },
    ]);
    const store = createInMemoryCoordinationStore();
    const first = createHome({
      home: "home-a",
      workflowId: 10,
      capacity: 2,
      tracker,
      coordination: createFakeCoordinationPort({ store }),
    });

    await expect(
      first.coordinator.runNextAction(implementTicketActionId(101)),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      first.coordinator.runNextAction(implementTicketActionId(102)),
    ).resolves.toMatchObject({ status: "running" });
    expect(first.workers.state.launches.map((launch) => launch.ticketNumber)).toEqual([
      101,
      102,
    ]);
  });

  it("heartbeats a running worker slot and releases it when the worker reports completion", async () => {
    vi.useFakeTimers();
    try {
      const tracker = createTracker([
        {
          workflowId: 10,
          tickets: [
            { number: 101, title: "A first", state: "OPEN", blockedBy: [] },
          ],
        },
      ]);
      const store = createInMemoryCoordinationStore();
      const home = createHome({
        home: "home-a",
        workflowId: 10,
        capacity: 1,
        tracker,
        coordination: createFakeCoordinationPort({
          store,
          now: () => new Date(Date.now()),
        }),
      });

      const started = await home.coordinator.runNextAction(
        implementTicketActionId(101),
      );
      expect(started).toMatchObject({ status: "running" });
      const workerId = home.workers.state.launches[0]?.workerId;
      if (!workerId) throw new Error("worker did not launch");
      const before = await createFakeCoordinationPort({
        store,
        now: () => new Date(Date.now()),
      }).getLease({ kind: "worker-slot", repository, slot: 1 });

      await vi.advanceTimersByTimeAsync(
        DEFAULT_COORDINATION_LEASE_HEARTBEAT_INTERVAL_MS + 1,
      );
      await home.coordinator.getPanelState();
      const renewed = await createFakeCoordinationPort({
        store,
        now: () => new Date(Date.now()),
      }).getLease({ kind: "worker-slot", repository, slot: 1 });
      expect(Date.parse(renewed?.heartbeatAt ?? "")).toBeGreaterThan(
        Date.parse(before?.heartbeatAt ?? ""),
      );
      expect(home.workers.state.aborts).toEqual([]);

      await home.workers.emit(workerId, {
        type: "stage-result",
        workerId,
        outcome: { status: "completed" },
      });
      await expect(
        createFakeCoordinationPort({ store }).getLease({
          kind: "worker-slot",
          repository,
          slot: 1,
        }),
      ).resolves.toMatchObject({ releasedAt: expect.any(String) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a worker after its reclaimed slot is no longer owned and does not launch over full capacity", async () => {
    const clock = testClock();
    const tracker = createTracker([
      {
        workflowId: 10,
        tickets: [
          { number: 101, title: "A first", state: "OPEN", blockedBy: [] },
          { number: 102, title: "A second", state: "OPEN", blockedBy: [] },
        ],
      },
    ]);
    const store = createInMemoryCoordinationStore();
    const home = createHome({
      home: "home-a",
      workflowId: 10,
      capacity: 1,
      tracker,
      // Coordinator leases use the fake port default, while worker slots pass
      // Matt Auto's explicit 60s TTL. This isolates a worker-slot loss.
      coordination: createFakeCoordinationPort({
        store,
        now: clock.now,
        defaultLeaseTtlMs: 120_000,
      }),
    });

    await expect(
      home.coordinator.runNextAction(implementTicketActionId(101)),
    ).resolves.toMatchObject({ status: "running" });
    const original = await createFakeCoordinationPort({ store, now: clock.now }).getLease({
      kind: "worker-slot",
      repository,
      slot: 1,
    });
    expect(original?.releasedAt).toBeUndefined();

    clock.advance(60_001);
    await expect(
      createFakeCoordinationPort({ store, now: clock.now }).acquireLease({
        kind: "worker-slot",
        repository,
        slot: 1,
        holderId: "replacement-home",
        workflowId: 99,
        ticketNumber: 999,
      }),
    ).resolves.toMatchObject({ acquired: true });

    await home.coordinator.getPanelState();
    expect(home.workers.state.aborts).toHaveLength(1);
    await expect(
      home.coordinator.runNextAction(implementTicketActionId(102)),
    ).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/capacity/i),
    });
    expect(home.workers.state.launches).toHaveLength(1);
  });
});
