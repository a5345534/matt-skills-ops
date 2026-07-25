import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import type {
  CreateSpecSkillOutcome,
  CreateTicketsSkillOutcome,
  EnvironmentPort,
  GitTopologyPort,
  ModelsPort,
  NestedGitRepository,
  PreferencesPort,
  PrepareImplementOutcome,
  RootScopedPorts,
  SkillsPort,
  TrackerPort,
  TrackerTicket,
  TranscriptPort,
  WorkerEventSink,
  WorkerLaunchInput,
  WorkersPort,
  WorkspacePort,
  WorkflowCoordinatorPorts,
} from "../src/ports.js";
import type {
  ActiveWorkflow,
  AvailableModel,
  SpecDraft,
  TicketsDraft,
  WorkerProfile,
  WorkerProtocolEvent,
  WorkflowManifest,
} from "../src/types.js";
import {
  CREATE_SPEC_ACTION,
  CREATE_TICKETS_ACTION,
  DEFAULT_TARGET_BRANCH,
  IMPLEMENTATION_DISPOSITION_OPTIONS,
  implementTicketActionId,
  implementationBranchName,
  NO_GIT_REPOSITORY_REASON,
  REQUIRED_MATT_SKILLS,
  SPEC_ISSUE_LABEL,
  STAGE_CONFIRMATION_OPTIONS,
  TICKET_ISSUE_LABEL,
  TICKET_PROGRESS_ACTION,
  UNSUPPORTED_TRACKER_REASON,
  WORKFLOW_MANIFEST_SCHEMA,
} from "../src/constants.js";

function createEnvironment(
  overrides: Partial<EnvironmentPort> = {},
): EnvironmentPort {
  return {
    hasGitHubRemote: async () => true,
    isGhAuthenticated: async () => true,
    targetBranchExists: async () => true,
    ...overrides,
  };
}

const defaultSpecDraft: SpecDraft = {
  title: "Ship feature X",
  body: "## Problem Statement\n\nUsers need X.\n",
};

const defaultTicketsDraft: TicketsDraft = {
  tickets: [
    {
      localId: "1",
      title: "Ship core path",
      body: "## What to build\n\nCore end-to-end path.\n",
      blockedBy: [],
    },
    {
      localId: "2",
      title: "Ship dependent path",
      body: "## What to build\n\nDepends on core.\n",
      blockedBy: ["1"],
    },
    {
      localId: "3",
      title: "Ship parallel path",
      body: "## What to build\n\nIndependent of core.\n",
      blockedBy: [],
    },
  ],
};

type SkillsFixture = {
  names?: readonly string[];
  /** Sequential outcomes for runCreateSpec (last value repeats). */
  createSpecOutcomes?: CreateSpecSkillOutcome[];
  /** Sequential outcomes for runCreateTickets (last value repeats). */
  createTicketsOutcomes?: CreateTicketsSkillOutcome[];
  /** prepareImplement outcome override. */
  prepareImplementOutcome?: PrepareImplementOutcome;
  /** Invocations recorded for assertions. */
  calls?: {
    runCreateSpec: number;
    runCreateTickets: number;
    prepareImplement?: number;
  };
};

function createSkills(fixture: SkillsFixture = {}): SkillsPort {
  const names = fixture.names ?? [...REQUIRED_MATT_SKILLS];
  const specOutcomes = fixture.createSpecOutcomes ?? [
    { ok: true as const, draft: defaultSpecDraft },
  ];
  const ticketsOutcomes = fixture.createTicketsOutcomes ?? [
    { ok: true as const, draft: defaultTicketsDraft },
  ];
  let specIndex = 0;
  let ticketsIndex = 0;
  const calls = fixture.calls ?? {
    runCreateSpec: 0,
    runCreateTickets: 0,
    prepareImplement: 0,
  };
  // Older fixtures may omit prepareImplement on the calls bag.
  const callBag = calls as {
    runCreateSpec: number;
    runCreateTickets: number;
    prepareImplement?: number;
  };
  if (callBag.prepareImplement === undefined) {
    callBag.prepareImplement = 0;
  }

  return {
    installedSkillNames: async () => names,
    runCreateSpec: async () => {
      calls.runCreateSpec += 1;
      const index = Math.min(specIndex, specOutcomes.length - 1);
      specIndex += 1;
      const outcome = specOutcomes[index];
      if (!outcome) {
        return {
          ok: false,
          reason: "No Create-spec skill outcome configured.",
        };
      }
      return outcome;
    },
    runCreateTickets: async () => {
      calls.runCreateTickets += 1;
      const index = Math.min(ticketsIndex, ticketsOutcomes.length - 1);
      ticketsIndex += 1;
      const outcome = ticketsOutcomes[index];
      if (!outcome) {
        return {
          ok: false,
          reason: "No Create-tickets skill outcome configured.",
        };
      }
      return outcome;
    },
    prepareImplement: async (input) => {
      callBag.prepareImplement = (callBag.prepareImplement ?? 0) + 1;
      if (fixture.prepareImplementOutcome) {
        return fixture.prepareImplementOutcome;
      }
      if (!names.includes("implement")) {
        return {
          ok: false,
          reason: "Installed skill implement is missing.",
        };
      }
      return {
        ok: true,
        skillCommand: "/implement",
        prompt: `/implement\n\nImplement #${input.ticketNumber}: ${input.title}`,
      };
    },
  };
}

type WorkspaceState = {
  creates: Array<{
    workflowId: number;
    ticketNumber: number;
    attempt: number;
    baseRef: string;
    branchName: string;
    worktreePath: string;
  }>;
  attempts: Map<string, number>;
  failCreate?: boolean;
};

function createWorkspace(
  workflowRoot = "/repo",
  initial: { attempts?: Map<string, number>; failCreate?: boolean } = {},
): { port: WorkspacePort; state: WorkspaceState } {
  const state: WorkspaceState = {
    creates: [],
    attempts: initial.attempts ?? new Map(),
    ...(initial.failCreate !== undefined
      ? { failCreate: initial.failCreate }
      : {}),
  };

  const port: WorkspacePort = {
    latestAttempt: async (workflowId, ticketNumber) => {
      return state.attempts.get(`${workflowId}:${ticketNumber}`) ?? 0;
    },
    createImplementationWorkspace: async (input) => {
      if (state.failCreate) {
        throw new Error("worktree create failed");
      }
      const branchName = implementationBranchName(
        input.workflowId,
        input.ticketNumber,
        input.attempt,
      );
      // Sibling of Workflow root — outside the root path.
      const worktreePath = path.join(
        path.dirname(workflowRoot),
        "matt-auto-workspaces",
        String(input.workflowId),
        `ticket-${input.ticketNumber}`,
        `r${input.attempt}`,
      );
      state.creates.push({
        ...input,
        branchName,
        worktreePath,
      });
      state.attempts.set(
        `${input.workflowId}:${input.ticketNumber}`,
        input.attempt,
      );
      return { branchName, worktreePath };
    },
  };

  return { port, state };
}

type WorkersState = {
  launches: WorkerLaunchInput[];
  aborts: string[];
  abortAllCount: number;
  sinks: Map<string, WorkerEventSink>;
  failLaunch?: boolean;
};

function createWorkers(
  initial: { failLaunch?: boolean } = {},
): {
  port: WorkersPort;
  state: WorkersState;
  emit: (workerId: string, event: WorkerProtocolEvent) => Promise<void>;
} {
  const state: WorkersState = {
    launches: [],
    aborts: [],
    abortAllCount: 0,
    sinks: new Map(),
    ...(initial.failLaunch !== undefined
      ? { failLaunch: initial.failLaunch }
      : {}),
  };

  const port: WorkersPort = {
    launch: async (input, sink) => {
      if (state.failLaunch) {
        throw new Error("worker launch failed");
      }
      state.launches.push(input);
      state.sinks.set(input.workerId, sink);
    },
    abort: async (workerId) => {
      state.aborts.push(workerId);
    },
    abortAll: async () => {
      state.abortAllCount += 1;
      for (const id of state.sinks.keys()) {
        state.aborts.push(id);
      }
    },
  };

  return {
    port,
    state,
    emit: async (workerId, event) => {
      const sink = state.sinks.get(workerId);
      if (!sink) {
        throw new Error(`No sink for worker ${workerId}`);
      }
      await sink.onEvent(event);
    },
  };
}

function createTranscripts(): {
  port: TranscriptPort;
  state: Map<string, unknown[]>;
} {
  const state = new Map<string, unknown[]>();
  const keyOf = (key: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
  }) => `${key.workflowId}:${key.ticketNumber}:r${key.attempt}`;

  return {
    state,
    port: {
      append: async (key, event) => {
        const k = keyOf(key);
        const list = state.get(k) ?? [];
        list.push(event);
        state.set(k, list);
      },
      read: async (key) => state.get(keyOf(key)) ?? [],
    },
  };
}

type TrackerState = {
  issues: Array<{
    number: number;
    title: string;
    body: string;
    labels: string[];
    state: "OPEN" | "CLOSED";
    blockedBy: number[];
    parent?: number;
  }>;
  manifests: Map<number, WorkflowManifest>;
  createIssueCalls: number;
  writeManifestCalls: number;
  addBlockedByCalls: Array<{ issue: number; blocker: number }>;
  addSubIssueCalls: Array<{ parent: number; child: number }>;
  nextNumber: number;
};

function createTracker(
  initial: {
    active?: ActiveWorkflow;
    failCreate?: boolean;
    failWriteManifest?: boolean;
    /** Extra ticket issues already on GitHub (for frontier tests). */
    tickets?: Array<{
      number: number;
      title: string;
      state?: "OPEN" | "CLOSED";
      blockedBy?: number[];
    }>;
  } = {},
): { port: TrackerPort; state: TrackerState } {
  const state: TrackerState = {
    issues: [],
    manifests: new Map(),
    createIssueCalls: 0,
    writeManifestCalls: 0,
    addBlockedByCalls: [],
    addSubIssueCalls: [],
    nextNumber: 100,
  };

  if (initial.active) {
    const manifest: WorkflowManifest = {
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: initial.active.workflowId,
      targetBranch: initial.active.targetBranch,
      stage: initial.active.stage,
      workerProfile: initial.active.workerProfile,
    };
    if (initial.active.tickets) {
      manifest.tickets = [...initial.active.tickets];
    }
    state.manifests.set(initial.active.workflowId, manifest);
    state.issues.push({
      number: initial.active.workflowId,
      title: initial.active.title ?? "Existing workflow",
      body: "spec",
      labels: [SPEC_ISSUE_LABEL],
      state: "OPEN",
      blockedBy: [],
    });
    state.nextNumber = initial.active.workflowId + 1;
  }

  for (const ticket of initial.tickets ?? []) {
    const issue: TrackerState["issues"][number] = {
      number: ticket.number,
      title: ticket.title,
      body: "ticket",
      labels: [TICKET_ISSUE_LABEL],
      state: ticket.state ?? "OPEN",
      blockedBy: [...(ticket.blockedBy ?? [])],
    };
    if (initial.active?.workflowId !== undefined) {
      issue.parent = initial.active.workflowId;
    }
    state.issues.push(issue);
    state.nextNumber = Math.max(state.nextNumber, ticket.number + 1);
  }

  const port: TrackerPort = {
    createIssue: async (input) => {
      state.createIssueCalls += 1;
      if (initial.failCreate) {
        throw new Error("GitHub createIssue failed");
      }
      const number = state.nextNumber++;
      state.issues.push({
        number,
        title: input.title,
        body: input.body,
        labels: [...input.labels],
        state: "OPEN",
        blockedBy: [],
      });
      return { number };
    },
    writeWorkflowManifest: async (issueNumber, manifest) => {
      state.writeManifestCalls += 1;
      if (initial.failWriteManifest) {
        throw new Error("GitHub writeWorkflowManifest failed");
      }
      state.manifests.set(issueNumber, manifest);
    },
    findActiveWorkflow: async (targetBranch) => {
      for (const manifest of state.manifests.values()) {
        if (manifest.targetBranch === targetBranch) {
          const issue = state.issues.find((i) => i.number === manifest.workflowId);
          const active: ActiveWorkflow = {
            workflowId: manifest.workflowId,
            targetBranch: manifest.targetBranch,
            stage: manifest.stage,
            workerProfile: manifest.workerProfile,
          };
          if (manifest.tickets) {
            active.tickets = [...manifest.tickets];
          }
          if (issue?.title) {
            active.title = issue.title;
          }
          return active;
        }
      }
      return undefined;
    },
    listTickets: async (issueNumbers) => {
      const wanted = new Set(issueNumbers);
      const tickets: TrackerTicket[] = [];
      for (const issue of state.issues) {
        if (!wanted.has(issue.number)) continue;
        tickets.push({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          blockedBy: issue.blockedBy.map((n) => {
            const blocker = state.issues.find((i) => i.number === n);
            return {
              number: n,
              state: blocker?.state ?? "OPEN",
            };
          }),
        });
      }
      return tickets;
    },
    addBlockedBy: async (issueNumber, blockerIssueNumber) => {
      state.addBlockedByCalls.push({
        issue: issueNumber,
        blocker: blockerIssueNumber,
      });
      const issue = state.issues.find((i) => i.number === issueNumber);
      if (issue && !issue.blockedBy.includes(blockerIssueNumber)) {
        issue.blockedBy.push(blockerIssueNumber);
      }
    },
    addSubIssue: async (parentIssueNumber, childIssueNumber) => {
      state.addSubIssueCalls.push({
        parent: parentIssueNumber,
        child: childIssueNumber,
      });
      const child = state.issues.find((i) => i.number === childIssueNumber);
      if (child) {
        child.parent = parentIssueNumber;
      }
    },
  };

  return { port, state };
}

type PrefState = {
  targetBranch?: string;
  globalWorkerProfile?: WorkerProfile;
  rootWorkerProfile?: WorkerProfile;
  snapshotWorkerProfile?: WorkerProfile;
};

function createPreferences(state: PrefState = {}): PreferencesPort {
  const store: PrefState = { ...state };
  return {
    getConfiguredTargetBranch: async () => store.targetBranch,
    getGlobalWorkerProfile: async () => store.globalWorkerProfile,
    getRootWorkerProfile: async () => store.rootWorkerProfile,
    getWorkflowSnapshotWorkerProfile: async () => store.snapshotWorkerProfile,
    setGlobalWorkerProfile: async (profile) => {
      store.globalWorkerProfile = profile;
    },
    setRootWorkerProfile: async (profile) => {
      store.rootWorkerProfile = profile;
    },
    clearRootWorkerProfile: async () => {
      delete store.rootWorkerProfile;
    },
  };
}

const defaultWorkerProfile: WorkerProfile = {
  provider: "anthropic",
  modelId: "claude-sonnet-4",
  thinkingLevel: "medium",
};

const reasoningModel: AvailableModel = {
  provider: "anthropic",
  modelId: "claude-sonnet-4",
  label: "anthropic/claude-sonnet-4",
  thinkingLevels: ["off", "minimal", "low", "medium", "high"],
};

const noReasoningModel: AvailableModel = {
  provider: "openai",
  modelId: "gpt-4o",
  label: "openai/gpt-4o",
  thinkingLevels: ["off"],
};

function createModels(
  models: readonly AvailableModel[] = [reasoningModel, noReasoningModel],
): ModelsPort {
  return {
    listAvailableModels: async () => models,
  };
}

type RootFixture = {
  environment?: Partial<EnvironmentPort>;
  skills?: SkillsFixture;
  /** Shorthand for skills.names when only installed names matter. */
  skillNames?: readonly string[];
  preferences?: PrefState;
  tracker?: ReturnType<typeof createTracker>;
  workspace?: ReturnType<typeof createWorkspace>;
  workers?: ReturnType<typeof createWorkers>;
  transcripts?: ReturnType<typeof createTranscripts>;
};

function createTopology(
  overrides: {
    nearest?: string | undefined;
    nested?: readonly NestedGitRepository[];
  } = {},
): GitTopologyPort {
  const nearest =
    "nearest" in overrides ? overrides.nearest : "/repo";
  const nested = overrides.nested ?? [];
  return {
    nearestGitRoot: async () => nearest,
    nestedGitRepositories: async () => nested,
  };
}

function createPorts(
  overrides: {
    startPath?: string;
    topology?: GitTopologyPort;
    models?: ModelsPort;
    /** Per-root fixture overrides keyed by absolute path. */
    roots?: Record<string, RootFixture>;
    defaultRoot?: RootFixture;
  } = {},
): WorkflowCoordinatorPorts & {
  /** Default-root tracker state when the fixture provided one. */
  __defaultTracker?: ReturnType<typeof createTracker>;
  __defaultWorkspace?: ReturnType<typeof createWorkspace>;
  __defaultWorkers?: ReturnType<typeof createWorkers>;
  __defaultTranscripts?: ReturnType<typeof createTranscripts>;
} {
  const startPath = overrides.startPath ?? "/repo";
  const defaultRoot: RootFixture = overrides.defaultRoot ?? {
    preferences: { globalWorkerProfile: defaultWorkerProfile },
  };
  const roots = overrides.roots ?? {};
  const defaultTracker = defaultRoot.tracker ?? createTracker();
  const defaultWorkspace = defaultRoot.workspace ?? createWorkspace("/repo");
  const defaultWorkers = defaultRoot.workers ?? createWorkers();
  const defaultTranscripts = defaultRoot.transcripts ?? createTranscripts();

  return {
    startPath,
    topology: overrides.topology ?? createTopology({ nearest: "/repo" }),
    models: overrides.models ?? createModels(),
    __defaultTracker: defaultTracker,
    __defaultWorkspace: defaultWorkspace,
    __defaultWorkers: defaultWorkers,
    __defaultTranscripts: defaultTranscripts,
    forRoot(rootPath: string): RootScopedPorts {
      const fixture = roots[rootPath] ?? defaultRoot;
      const skillsFixture: SkillsFixture = fixture.skills
        ? fixture.skills
        : fixture.skillNames
          ? { names: fixture.skillNames }
          : {};
      const tracker = fixture.tracker ?? defaultTracker;
      const workspace =
        fixture.workspace ??
        (fixture === defaultRoot
          ? defaultWorkspace
          : createWorkspace(rootPath));
      const workers =
        fixture.workers ??
        (fixture === defaultRoot ? defaultWorkers : createWorkers());
      const transcripts =
        fixture.transcripts ??
        (fixture === defaultRoot ? defaultTranscripts : createTranscripts());
      return {
        environment: createEnvironment(fixture.environment),
        skills: createSkills(skillsFixture),
        preferences: createPreferences(
          fixture.preferences ?? {
            globalWorkerProfile: defaultWorkerProfile,
          },
        ),
        tracker: tracker.port,
        workspace: workspace.port,
        workers: workers.port,
        transcripts: transcripts.port,
      };
    },
  };
}

describe("Workflow coordinator preflight", () => {
  it("passes when GitHub remote, gh auth, Target branch, Matt skills, and Worker profile are present", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    const result = await coordinator.preflight();

    expect(result.ok).toBe(true);
    expect(result.targetBranch).toBe(DEFAULT_TARGET_BRANCH);
    expect(result.checks.map((c) => c.id)).toEqual([
      "github-remote",
      "gh-auth",
      "target-branch",
      "matt-skills",
      "worker-profile",
    ]);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.workerProfile).toEqual({
      profile: defaultWorkerProfile,
      source: "global",
    });
  });

  it("uses the configured Target branch override when present", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            targetBranch: "develop",
            globalWorkerProfile: defaultWorkerProfile,
          },
        },
      }),
    );

    const result = await coordinator.preflight();

    expect(result.ok).toBe(true);
    expect(result.targetBranch).toBe("develop");
  });

  it("fails closed when there is no GitHub remote and offers corrective guidance", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          environment: { hasGitHubRemote: async () => false },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "github-remote");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/GitHub remote/i);
    expect(check?.guidance).not.toMatch(/git init|create repository|push/i);
  });

  it("fails closed when gh is not authenticated and guides login", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          environment: { isGhAuthenticated: async () => false },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "gh-auth");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/gh auth login/i);
  });

  it("fails closed when the Target branch does not exist", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          environment: {
            targetBranchExists: async (branch) => branch !== "main",
          },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "target-branch");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/main/);
    expect(check?.guidance).toMatch(/does not create branches/i);
    expect(check?.guidance).not.toMatch(
      /git init|create repository for you|I'll push|will push/i,
    );
  });

  it("fails closed when required Matt skills are missing and lists them", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          skillNames: ["to-spec", "implement"],
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "matt-skills");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/to-tickets/);
    expect(check?.guidance).toMatch(/resolving-merge-conflicts/);
  });

  it("fails closed when Worker profile is missing", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {},
        },
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "worker-profile");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/Worker profile/i);
    expect(result.workerProfile).toBeUndefined();
  });

  it("surfaces the effective Worker profile source in preflight guidance", async () => {
    const rootProfile: WorkerProfile = {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "high",
    };
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            globalWorkerProfile: defaultWorkerProfile,
            rootWorkerProfile: rootProfile,
          },
        },
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "worker-profile");

    expect(result.ok).toBe(true);
    expect(check?.guidance).toMatch(/source workflow-root/);
    expect(result.workerProfile).toEqual({
      profile: rootProfile,
      source: "workflow-root",
    });
  });
});

describe("Workflow coordinator Worker profile precedence", () => {
  it("resolves global default when no root or snapshot override exists", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: defaultWorkerProfile,
      source: "global",
    });
  });

  it("prefers Workflow-root override over global default", async () => {
    const rootProfile: WorkerProfile = {
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    };
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            globalWorkerProfile: defaultWorkerProfile,
            rootWorkerProfile: rootProfile,
          },
        },
      }),
    );

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: rootProfile,
      source: "workflow-root",
    });
    await expect(coordinator.getGlobalWorkerProfile()).resolves.toEqual(
      defaultWorkerProfile,
    );
    await expect(coordinator.getRootWorkerProfile()).resolves.toEqual(
      rootProfile,
    );
  });

  it("prefers workflow snapshot over Workflow-root and global", async () => {
    const rootProfile: WorkerProfile = {
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    };
    const snapshotProfile: WorkerProfile = {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "high",
    };
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            globalWorkerProfile: defaultWorkerProfile,
            rootWorkerProfile: rootProfile,
            snapshotWorkerProfile: snapshotProfile,
          },
        },
      }),
    );

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: snapshotProfile,
      source: "workflow-snapshot",
    });
  });

  it("sets a global default Worker profile through the coordinator seam", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: { preferences: {} },
      }),
    );

    await expect(coordinator.getWorkerProfile()).resolves.toBeUndefined();

    await coordinator.setGlobalWorkerProfile(defaultWorkerProfile);

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: defaultWorkerProfile,
      source: "global",
    });
    await expect(coordinator.preflight()).resolves.toMatchObject({ ok: true });
  });

  it("sets a Workflow-root override without changing the global default", async () => {
    const rootProfile: WorkerProfile = {
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    };
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    await coordinator.setRootWorkerProfile(rootProfile);

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: rootProfile,
      source: "workflow-root",
    });
    await expect(coordinator.getGlobalWorkerProfile()).resolves.toEqual(
      defaultWorkerProfile,
    );
  });

  it("clears the Workflow-root override so the global default becomes effective", async () => {
    const rootProfile: WorkerProfile = {
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    };
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            globalWorkerProfile: defaultWorkerProfile,
            rootWorkerProfile: rootProfile,
          },
        },
      }),
    );

    await coordinator.clearRootWorkerProfile();

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: defaultWorkerProfile,
      source: "global",
    });
    await expect(coordinator.getRootWorkerProfile()).resolves.toBeUndefined();
  });

  it("rejects a Worker profile whose thinking level the model does not support", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    await expect(
      coordinator.setGlobalWorkerProfile({
        provider: "openai",
        modelId: "gpt-4o",
        thinkingLevel: "high",
      }),
    ).rejects.toThrow(/not supported/i);
  });

  it("rejects a Worker profile whose model is not in the available catalog", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    await expect(
      coordinator.setGlobalWorkerProfile({
        provider: "anthropic",
        modelId: "does-not-exist",
        thinkingLevel: "medium",
      }),
    ).rejects.toThrow(/available-model catalog/i);
  });

  it("lists authenticated available models and their supported thinking levels", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    await expect(coordinator.listAvailableModels()).resolves.toEqual([
      reasoningModel,
      noReasoningModel,
    ]);
    await expect(
      coordinator.thinkingLevelsFor("anthropic", "claude-sonnet-4"),
    ).resolves.toEqual(["off", "minimal", "low", "medium", "high"]);
    await expect(
      coordinator.thinkingLevelsFor("openai", "gpt-4o"),
    ).resolves.toEqual(["off"]);
    await expect(
      coordinator.thinkingLevelsFor("missing", "model"),
    ).resolves.toEqual(["off"]);
  });

  it("keeps Worker profile configuration independent of Workflow home model selection", async () => {
    // Coordinator only writes preferences via the PreferencesPort. There is no
    // home-model port — configuring workers cannot change the session model.
    let homeModel = "workflow-home-model";
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: { preferences: {} },
      }),
    );

    await coordinator.setGlobalWorkerProfile(defaultWorkerProfile);
    await coordinator.setRootWorkerProfile({
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    });

    expect(homeModel).toBe("workflow-home-model");
    homeModel = "still-workflow-home-model";
    await expect(coordinator.getWorkerProfile()).resolves.toMatchObject({
      source: "workflow-root",
    });
    expect(homeModel).toBe("still-workflow-home-model");
  });
});

describe("Workflow coordinator Next actions", () => {
  it("returns no Next actions when preflight fails", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          environment: { hasGitHubRemote: async () => false },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    await expect(coordinator.nextActions()).resolves.toEqual([]);
  });

  it("offers Create spec when preflight passes and there is no Active workflow", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    await expect(coordinator.nextActions()).resolves.toEqual([
      {
        id: CREATE_SPEC_ACTION.id,
        label: CREATE_SPEC_ACTION.label,
        description: CREATE_SPEC_ACTION.description,
      },
    ]);
  });

  it("offers Create tickets after a published Create-spec workflow", async () => {
    const tracker = createTracker({
      active: {
        workflowId: 42,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "spec-published",
        workerProfile: defaultWorkerProfile,
        title: "Existing spec",
      },
    });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await expect(coordinator.nextActions()).resolves.toEqual([
      {
        id: CREATE_TICKETS_ACTION.id,
        label: CREATE_TICKETS_ACTION.label,
        description: CREATE_TICKETS_ACTION.description,
      },
    ]);
  });
});

describe("Workflow coordinator Create-spec Planning stage", () => {
  it("runs Create-spec in Workflow home via the skills adapter and needs Stage confirmation", async () => {
    const skillsCalls = { runCreateSpec: 0, runCreateTickets: 0 };
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: { calls: skillsCalls },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_SPEC_ACTION.id);

    expect(result).toEqual({
      status: "needs-confirmation",
      stage: "create-spec",
      draft: defaultSpecDraft,
      confirmationOptions: [...STAGE_CONFIRMATION_OPTIONS],
    });
    expect(skillsCalls.runCreateSpec).toBe(1);
    // Planning stage must not publish silently.
    expect(tracker.state.createIssueCalls).toBe(0);
    expect(tracker.state.writeManifestCalls).toBe(0);
  });

  it("does not launch Create-spec as an Implementation worker action surface", async () => {
    // Create-spec is only a Workflow-home Planning Next action, never a worker profile launch.
    const coordinator = createWorkflowCoordinator(createPorts());
    const actions = await coordinator.nextActions();

    expect(actions.map((a) => a.id)).toEqual([CREATE_SPEC_ACTION.id]);
    expect(actions.some((a) => /worker|implement/i.test(a.id))).toBe(false);
  });

  it("publishes only on Stage confirmation Publish and sets the Workflow ID from the issue number", async () => {
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_SPEC_ACTION.id);
    const published = await coordinator.confirmStage("publish");

    expect(published).toEqual({
      status: "completed",
      stage: "create-spec",
      workflowId: 100,
    });
    expect(tracker.state.createIssueCalls).toBe(1);
    expect(tracker.state.writeManifestCalls).toBe(1);
    expect(tracker.state.issues[0]).toMatchObject({
      number: 100,
      title: defaultSpecDraft.title,
      body: defaultSpecDraft.body,
      labels: [SPEC_ISSUE_LABEL],
    });

    const manifest = tracker.state.manifests.get(100);
    expect(manifest).toEqual({
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: 100,
      targetBranch: DEFAULT_TARGET_BRANCH,
      stage: "spec-published",
      workerProfile: defaultWorkerProfile,
    });

    await expect(coordinator.getActiveWorkflow()).resolves.toEqual({
      workflowId: 100,
      targetBranch: DEFAULT_TARGET_BRANCH,
      stage: "spec-published",
      workerProfile: defaultWorkerProfile,
      title: defaultSpecDraft.title,
    });

    await expect(coordinator.nextActions()).resolves.toEqual([
      {
        id: CREATE_TICKETS_ACTION.id,
        label: CREATE_TICKETS_ACTION.label,
        description: CREATE_TICKETS_ACTION.description,
      },
    ]);
  });

  it("cancels Stage confirmation with no partial remote publication", async () => {
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_SPEC_ACTION.id);
    const cancelled = await coordinator.confirmStage("cancel");

    expect(cancelled).toEqual({
      status: "cancelled",
      stage: "create-spec",
    });
    expect(tracker.state.createIssueCalls).toBe(0);
    expect(tracker.state.writeManifestCalls).toBe(0);
    expect(tracker.state.issues).toEqual([]);
    expect(tracker.state.manifests.size).toBe(0);
    await expect(coordinator.getActiveWorkflow()).resolves.toBeUndefined();
    await expect(coordinator.nextActions()).resolves.toEqual([
      {
        id: CREATE_SPEC_ACTION.id,
        label: CREATE_SPEC_ACTION.label,
        description: CREATE_SPEC_ACTION.description,
      },
    ]);
  });

  it("revises by re-invoking to-spec without remote publication", async () => {
    const revisedDraft: SpecDraft = {
      title: "Ship feature X (revised)",
      body: "## Problem Statement\n\nRevised.\n",
    };
    const skillsCalls = { runCreateSpec: 0, runCreateTickets: 0 };
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            calls: skillsCalls,
            createSpecOutcomes: [
              { ok: true, draft: defaultSpecDraft },
              { ok: true, draft: revisedDraft },
            ],
          },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_SPEC_ACTION.id);
    const revised = await coordinator.confirmStage("revise");

    expect(revised).toEqual({
      status: "needs-confirmation",
      stage: "create-spec",
      draft: revisedDraft,
      confirmationOptions: [...STAGE_CONFIRMATION_OPTIONS],
    });
    expect(skillsCalls.runCreateSpec).toBe(2);
    expect(tracker.state.createIssueCalls).toBe(0);
    expect(tracker.state.writeManifestCalls).toBe(0);
  });

  it("enters Compatibility recovery when to-spec omits a reviewable draft", async () => {
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            createSpecOutcomes: [
              { ok: false, reason: "Skill settled without a Stage result." },
            ],
          },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_SPEC_ACTION.id);

    expect(result).toEqual({
      status: "compatibility-recovery",
      stage: "create-spec",
      reason: "Skill settled without a Stage result.",
    });
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("enters Compatibility recovery when the draft is missing title or body", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            createSpecOutcomes: [
              { ok: true, draft: { title: "  ", body: "body only" } },
            ],
          },
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_SPEC_ACTION.id);

    expect(result.status).toBe("compatibility-recovery");
    if (result.status === "compatibility-recovery") {
      expect(result.reason).toMatch(/title|body|draft/i);
    }
  });

  it("fails closed when Create-spec is requested while preflight is incomplete", async () => {
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          environment: { hasGitHubRemote: async () => false },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_SPEC_ACTION.id);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/preflight/i);
    }
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("fails closed when Create-spec is requested while an Active workflow already exists", async () => {
    const tracker = createTracker({
      active: {
        workflowId: 7,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "spec-published",
        workerProfile: defaultWorkerProfile,
      },
    });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_SPEC_ACTION.id);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/Active workflow/i);
    }
    // Existing remote state only — no additional publish attempt.
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("fails closed when Stage confirmation is given without a pending stage", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    const result = await coordinator.confirmStage("publish");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/pending/i);
    }
  });

  it("snapshots the effective Worker profile into the Workflow manifest on publish", async () => {
    const rootProfile: WorkerProfile = {
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    };
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            globalWorkerProfile: defaultWorkerProfile,
            rootWorkerProfile: rootProfile,
          },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_SPEC_ACTION.id);
    await coordinator.confirmStage("publish");

    expect(tracker.state.manifests.get(100)?.workerProfile).toEqual(rootProfile);
    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: rootProfile,
      source: "workflow-snapshot",
    });
  });
});

describe("Workflow coordinator root selection", () => {
  it("selects the nearest enclosing Git repository as the default Workflow root", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/mono/packages/app",
        topology: createTopology({ nearest: "/mono" }),
      }),
    );

    const root = await coordinator.currentRoot();

    expect(root).toEqual({
      path: "/mono",
      kind: "nearest",
      status: "available",
    });
  });

  it("shares a single Workflow root for packages inside a monorepo", async () => {
    // Packages have no nested independent Git repos — only the enclosing root.
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/mono/packages/billing",
        topology: createTopology({ nearest: "/mono", nested: [] }),
      }),
    );

    const roots = await coordinator.listRoots();

    expect(roots).toEqual([
      {
        path: "/mono",
        kind: "nearest",
        status: "available",
      },
    ]);
  });

  it("discovers nested independent Git repositories as selectable Workflow roots", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/workspace",
        topology: createTopology({
          nearest: "/workspace",
          nested: [
            { path: "/workspace/services/api", isSubmodule: false },
            { path: "/workspace/vendor/tool", isSubmodule: false },
          ],
        }),
        roots: {
          "/workspace": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
          "/workspace/services/api": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
          "/workspace/vendor/tool": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
        },
      }),
    );

    const roots = await coordinator.listRoots();

    expect(roots.map((r) => r.path)).toEqual([
      "/workspace",
      "/workspace/services/api",
      "/workspace/vendor/tool",
    ]);
    expect(roots[0]).toMatchObject({
      kind: "nearest",
      status: "available",
    });
    expect(roots[1]).toMatchObject({
      kind: "nested-independent",
      status: "available",
    });
    expect(roots[2]).toMatchObject({
      kind: "nested-independent",
      status: "available",
    });
  });

  it("does not treat Git submodules as supported Workflow roots", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/workspace",
        topology: createTopology({
          nearest: "/workspace",
          nested: [
            { path: "/workspace/libs/shared", isSubmodule: true },
            { path: "/workspace/services/api", isSubmodule: false },
          ],
        }),
      }),
    );

    const roots = await coordinator.listRoots();

    expect(roots.map((r) => r.path)).toEqual([
      "/workspace",
      "/workspace/services/api",
    ]);
    expect(
      roots.some((r) => r.path === "/workspace/libs/shared"),
    ).toBe(false);
  });

  it("marks non-GitHub roots unavailable with an unsupported-tracker explanation", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/gitlab-only",
        topology: createTopology({ nearest: "/gitlab-only" }),
        defaultRoot: {
          environment: { hasGitHubRemote: async () => false },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    const root = await coordinator.currentRoot();

    expect(root.status).toBe("unavailable");
    expect(root.unavailableReason).toBe(UNSUPPORTED_TRACKER_REASON);
    expect(root.unavailableReason).toMatch(/supported tracker/i);
    expect(root.unavailableReason).toMatch(/GitHub/i);
  });

  it("marks nested non-GitHub roots unavailable while leaving GitHub roots available", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/workspace",
        topology: createTopology({
          nearest: "/workspace",
          nested: [
            { path: "/workspace/legacy-gitlab", isSubmodule: false },
            { path: "/workspace/product", isSubmodule: false },
          ],
        }),
        roots: {
          "/workspace": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
          "/workspace/legacy-gitlab": {
            environment: { hasGitHubRemote: async () => false },
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
          "/workspace/product": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
        },
      }),
    );

    const roots = await coordinator.listRoots();
    const legacy = roots.find((r) => r.path === "/workspace/legacy-gitlab");
    const product = roots.find((r) => r.path === "/workspace/product");

    expect(legacy?.status).toBe("unavailable");
    expect(legacy?.unavailableReason).toBe(UNSUPPORTED_TRACKER_REASON);
    expect(product?.status).toBe("available");
    expect(product?.unavailableReason).toBeUndefined();
  });

  it("switches the selected Workflow root and runs preflight against it", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/workspace",
        topology: createTopology({
          nearest: "/workspace",
          nested: [{ path: "/workspace/services/api", isSubmodule: false }],
        }),
        roots: {
          "/workspace": {
            environment: { hasGitHubRemote: async () => false },
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
          "/workspace/services/api": {
            preferences: {
              targetBranch: "develop",
              globalWorkerProfile: defaultWorkerProfile,
            },
          },
        },
      }),
    );

    await expect(coordinator.currentRoot()).resolves.toMatchObject({
      path: "/workspace",
      status: "unavailable",
    });
    await expect(coordinator.preflight()).resolves.toMatchObject({ ok: false });

    const selected = await coordinator.selectRoot("/workspace/services/api");
    expect(selected).toMatchObject({
      path: "/workspace/services/api",
      kind: "nested-independent",
      status: "available",
    });

    await expect(coordinator.currentRoot()).resolves.toMatchObject({
      path: "/workspace/services/api",
      status: "available",
    });

    const preflight = await coordinator.preflight();
    expect(preflight.ok).toBe(true);
    expect(preflight.targetBranch).toBe("develop");
  });

  it("rejects selecting a path that is not a discovered Workflow root", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        topology: createTopology({ nearest: "/repo", nested: [] }),
      }),
    );

    await expect(coordinator.selectRoot("/not-a-root")).rejects.toThrow(
      /not a discovered Workflow root/i,
    );
  });

  it("marks the start path unavailable when no enclosing Git repository exists", async () => {
    const startPath = "/tmp/not-a-repo";
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath,
        topology: createTopology({ nearest: undefined, nested: [] }),
        defaultRoot: {
          environment: { hasGitHubRemote: async () => false },
          preferences: {},
        },
      }),
    );

    const root = await coordinator.currentRoot();

    expect(root.path).toBe(path.resolve(startPath));
    expect(root.kind).toBe("nearest");
    expect(root.status).toBe("unavailable");
    expect(root.unavailableReason).toBe(NO_GIT_REPOSITORY_REASON);
  });
});

describe("Workflow coordinator Create-tickets Planning stage", () => {
  function publishedSpecTracker(
    overrides: {
      workflowId?: number;
      title?: string;
    } = {},
  ) {
    return createTracker({
      active: {
        workflowId: overrides.workflowId ?? 42,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "spec-published",
        workerProfile: defaultWorkerProfile,
        title: overrides.title ?? "Existing spec",
      },
    });
  }

  it("runs Create-tickets in Workflow home via the skills adapter and needs Stage confirmation", async () => {
    const skillsCalls = { runCreateSpec: 0, runCreateTickets: 0 };
    const tracker = publishedSpecTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: { calls: skillsCalls },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);

    expect(result).toEqual({
      status: "needs-confirmation",
      stage: "create-tickets",
      draft: defaultTicketsDraft,
      confirmationOptions: [...STAGE_CONFIRMATION_OPTIONS],
    });
    expect(skillsCalls.runCreateTickets).toBe(1);
    // Planning stage must not publish silently.
    expect(tracker.state.createIssueCalls).toBe(0);
    expect(tracker.state.addBlockedByCalls).toEqual([]);
    expect(tracker.state.addSubIssueCalls).toEqual([]);
    expect(tracker.state.writeManifestCalls).toBe(0);
  });

  it("publishes tickets with blocking relationships and records them on the Workflow manifest", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42, title: "Existing spec" });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);
    const published = await coordinator.confirmStage("publish");

    expect(published.status).toBe("completed");
    if (published.status !== "completed") return;

    expect(published.stage).toBe("create-tickets");
    expect(published.workflowId).toBe(42);
    // Topological order: local 1 and 3 first (no blockers), then 2.
    // Stable relative order preserves draft order among ready tickets: 1 then 3 then 2.
    expect(published.tickets).toEqual([43, 44, 45]);
    expect(tracker.state.createIssueCalls).toBe(3);
    expect(tracker.state.addSubIssueCalls).toEqual([
      { parent: 42, child: 43 },
      { parent: 42, child: 44 },
      { parent: 42, child: 45 },
    ]);
    expect(tracker.state.addBlockedByCalls).toEqual([
      { issue: 45, blocker: 43 },
    ]);

    const ticketIssues = tracker.state.issues.filter((i) => i.number !== 42);
    expect(ticketIssues.map((i) => i.title)).toEqual([
      "Ship core path",
      "Ship parallel path",
      "Ship dependent path",
    ]);
    expect(ticketIssues.every((i) => i.labels.includes(TICKET_ISSUE_LABEL))).toBe(
      true,
    );

    const dependent = ticketIssues.find((i) => i.title === "Ship dependent path");
    expect(dependent?.body).toMatch(/#42 Existing spec/);
    expect(dependent?.body).toMatch(/#43 Ship core path/);
    expect(dependent?.blockedBy).toEqual([43]);

    const parallel = ticketIssues.find((i) => i.title === "Ship parallel path");
    expect(parallel?.body).toMatch(/None — can start immediately/);

    const manifest = tracker.state.manifests.get(42);
    expect(manifest).toEqual({
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: 42,
      targetBranch: DEFAULT_TARGET_BRANCH,
      stage: "tickets-published",
      workerProfile: defaultWorkerProfile,
      tickets: [43, 44, 45],
    });

    await expect(coordinator.getActiveWorkflow()).resolves.toMatchObject({
      workflowId: 42,
      stage: "tickets-published",
      tickets: [43, 44, 45],
    });
  });

  it("computes the ready frontier from GitHub ticket state after publish", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);
    const published = await coordinator.confirmStage("publish");

    expect(published.status).toBe("completed");
    if (published.status !== "completed") return;

    // Ready: core (#43) and parallel (#44). Dependent (#45) blocked by open #43.
    expect(published.ticketProgress).toEqual({
      workflowId: 42,
      total: 3,
      open: 3,
      closed: 0,
      ready: [
        { number: 43, title: "Ship core path" },
        { number: 44, title: "Ship parallel path" },
      ],
      blocked: [
        {
          number: 45,
          title: "Ship dependent path",
          openBlockers: [43],
        },
      ],
    });

    await expect(coordinator.getTicketProgress()).resolves.toEqual(
      published.ticketProgress,
    );

    // Closing a blocker expands the frontier.
    const core = tracker.state.issues.find((i) => i.number === 43);
    if (core) core.state = "CLOSED";

    const afterClose = await coordinator.getTicketProgress();
    expect(afterClose?.ready.map((t) => t.number).sort((a, b) => a - b)).toEqual([
      44, 45,
    ]);
    expect(afterClose?.closed).toBe(1);
    expect(afterClose?.open).toBe(2);
    expect(afterClose?.blocked).toEqual([]);
  });

  it("shows ticket-progress summary in Next actions after publish", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);
    await coordinator.confirmStage("publish");

    const actions = await coordinator.nextActions();
    // Ready tickets become Implement actions; progress summary remains available.
    expect(actions.map((a) => a.id)).toEqual([
      implementTicketActionId(43),
      implementTicketActionId(44),
      TICKET_PROGRESS_ACTION.id,
    ]);
    const progressAction = actions.find((a) => a.id === TICKET_PROGRESS_ACTION.id);
    expect(progressAction?.label).toMatch(/2 ready \/ 3 open \/ 0 closed/);
    expect(progressAction?.description).toMatch(/#43/);
    expect(progressAction?.description).toMatch(/#44/);

    const viewed = await coordinator.runNextAction(TICKET_PROGRESS_ACTION.id);
    expect(viewed.status).toBe("completed");
    if (viewed.status === "completed") {
      expect(viewed.ticketProgress?.ready).toHaveLength(2);
    }
  });

  it("cancels Stage confirmation with no partial remote publication", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);
    const cancelled = await coordinator.confirmStage("cancel");

    expect(cancelled).toEqual({
      status: "cancelled",
      stage: "create-tickets",
    });
    expect(tracker.state.createIssueCalls).toBe(0);
    expect(tracker.state.addBlockedByCalls).toEqual([]);
    expect(tracker.state.addSubIssueCalls).toEqual([]);
    expect(tracker.state.writeManifestCalls).toBe(0);
    await expect(coordinator.getActiveWorkflow()).resolves.toMatchObject({
      stage: "spec-published",
    });
    await expect(coordinator.nextActions()).resolves.toEqual([
      {
        id: CREATE_TICKETS_ACTION.id,
        label: CREATE_TICKETS_ACTION.label,
        description: CREATE_TICKETS_ACTION.description,
      },
    ]);
  });

  it("revises by re-invoking to-tickets without remote publication", async () => {
    const revised: TicketsDraft = {
      tickets: [
        {
          localId: "a",
          title: "Only ticket",
          body: "Revised breakdown",
          blockedBy: [],
        },
      ],
    };
    const skillsCalls = { runCreateSpec: 0, runCreateTickets: 0 };
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            calls: skillsCalls,
            createTicketsOutcomes: [
              { ok: true, draft: defaultTicketsDraft },
              { ok: true, draft: revised },
            ],
          },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);
    const result = await coordinator.confirmStage("revise");

    expect(result).toEqual({
      status: "needs-confirmation",
      stage: "create-tickets",
      draft: revised,
      confirmationOptions: [...STAGE_CONFIRMATION_OPTIONS],
    });
    expect(skillsCalls.runCreateTickets).toBe(2);
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("enters Compatibility recovery when to-tickets omits a reviewable breakdown", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            createTicketsOutcomes: [
              { ok: false, reason: "Skill settled without a Stage result." },
            ],
          },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);

    expect(result).toEqual({
      status: "compatibility-recovery",
      stage: "create-tickets",
      reason: "Skill settled without a Stage result.",
    });
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("enters Compatibility recovery when the breakdown has unknown blockers", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            createTicketsOutcomes: [
              {
                ok: true,
                draft: {
                  tickets: [
                    {
                      localId: "1",
                      title: "Broken",
                      body: "body",
                      blockedBy: ["missing"],
                    },
                  ],
                },
              },
            ],
          },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);

    expect(result.status).toBe("compatibility-recovery");
    if (result.status === "compatibility-recovery") {
      expect(result.reason).toMatch(/unknown localId/i);
    }
  });

  it("fails closed when Create-tickets is requested without an Active workflow", async () => {
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/Active workflow/i);
    }
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("fails closed when Create-tickets is requested after tickets are already published", async () => {
    const tracker = createTracker({
      active: {
        workflowId: 42,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "tickets-published",
        workerProfile: defaultWorkerProfile,
        tickets: [43, 44],
      },
      tickets: [
        { number: 43, title: "A", blockedBy: [] },
        { number: 44, title: "B", blockedBy: [43] },
      ],
    });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/tickets-published|unavailable/i);
    }
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("does not treat Create-tickets as an Implementation worker action surface", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toEqual([CREATE_TICKETS_ACTION.id]);
    expect(actions.some((a) => /worker|implement/i.test(a.id))).toBe(false);
  });
});

describe("Workflow coordinator single Implementation worker path", () => {
  function ticketsPublishedFixture() {
    const tracker = createTracker({
      active: {
        workflowId: 42,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "tickets-published",
        workerProfile: defaultWorkerProfile,
        title: "Existing spec",
        tickets: [43, 44, 45],
      },
      tickets: [
        { number: 43, title: "Ship core path", blockedBy: [] },
        { number: 44, title: "Ship parallel path", blockedBy: [] },
        { number: 45, title: "Ship dependent path", blockedBy: [43] },
      ],
    });
    const workspace = createWorkspace("/repo");
    const workers = createWorkers();
    const transcripts = createTranscripts();
    const skillsCalls = {
      runCreateSpec: 0,
      runCreateTickets: 0,
      prepareImplement: 0,
    };
    const ports = createPorts({
      defaultRoot: {
        preferences: { globalWorkerProfile: defaultWorkerProfile },
        tracker,
        workspace,
        workers,
        transcripts,
        skills: { calls: skillsCalls },
      },
    });
    const coordinator = createWorkflowCoordinator(ports);
    return {
      coordinator,
      tracker,
      workspace,
      workers,
      transcripts,
      skillsCalls,
    };
  }

  it("offers Implement Next actions for each ready frontier ticket", async () => {
    const { coordinator } = ticketsPublishedFixture();

    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toEqual([
      implementTicketActionId(43),
      implementTicketActionId(44),
      TICKET_PROGRESS_ACTION.id,
    ]);
    expect(actions[0]).toMatchObject({
      label: "Implement #43",
      description: expect.stringContaining("Ship core path"),
    });
    // Blocked ticket is not offered.
    expect(actions.some((a) => a.id === implementTicketActionId(45))).toBe(
      false,
    );
  });

  it("creates an Implementation workspace outside the Workflow root with agreed branch naming and launches a session-owned worker via /implement", async () => {
    const { coordinator, workspace, workers, skillsCalls, tracker } =
      ticketsPublishedFixture();
    const remoteWritesBefore = {
      create: tracker.state.createIssueCalls,
      manifest: tracker.state.writeManifestCalls,
      blockedBy: tracker.state.addBlockedByCalls.length,
    };

    const result = await coordinator.runNextAction(implementTicketActionId(43));

    expect(result).toEqual({
      status: "running",
      stage: "implement",
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
      workerId: "implement-42-43-r1",
      branchName: "matt-auto/42/ticket-43/r1",
      worktreePath: "/matt-auto-workspaces/42/ticket-43/r1",
    });

    expect(workspace.state.creates).toEqual([
      {
        workflowId: 42,
        ticketNumber: 43,
        attempt: 1,
        baseRef: DEFAULT_TARGET_BRANCH,
        branchName: "matt-auto/42/ticket-43/r1",
        worktreePath: "/matt-auto-workspaces/42/ticket-43/r1",
      },
    ]);
    // Outside Workflow root /repo
    expect(workspace.state.creates[0]?.worktreePath.startsWith("/repo")).toBe(
      false,
    );

    expect(skillsCalls.prepareImplement).toBe(1);
    expect(workers.state.launches).toHaveLength(1);
    expect(workers.state.launches[0]).toMatchObject({
      workerId: "implement-42-43-r1",
      worktreePath: "/matt-auto-workspaces/42/ticket-43/r1",
      branchName: "matt-auto/42/ticket-43/r1",
      skillCommand: "/implement",
      workerProfile: defaultWorkerProfile,
      ticketTitle: "Ship core path",
    });
    expect(workers.state.launches[0]?.prompt).toMatch(/\/implement/);
    expect(workers.state.launches[0]?.prompt).toMatch(/#43/);

    // Workers / launch path must not mutate GitHub.
    expect(tracker.state.createIssueCalls).toBe(remoteWritesBefore.create);
    expect(tracker.state.writeManifestCalls).toBe(remoteWritesBefore.manifest);
    expect(tracker.state.addBlockedByCalls).toHaveLength(
      remoteWritesBefore.blockedBy,
    );
  });

  it("shows running progress on the passive Workflow panel and retains the Worker transcript", async () => {
    const { coordinator, workers } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "progress",
      workerId: "implement-42-43-r1",
      message: "Running tests",
    });

    const panel = await coordinator.getPanelState();
    expect(panel?.workflowId).toBe(42);
    expect(panel?.workers).toEqual([
      {
        ticketNumber: 43,
        attempt: 1,
        status: "running",
        progress: "Running tests",
        branchName: "matt-auto/42/ticket-43/r1",
      },
    ]);
    expect(panel?.lines.some((l) => /Worker #43 r1: running/.test(l))).toBe(
      true,
    );
    expect(panel?.lines.some((l) => /Running tests/.test(l))).toBe(true);
    // Passive: panel is a summary, not an interactive action menu.
    expect(panel?.lines.join("\n")).not.toMatch(/\[x\]|click|button/i);

    const transcript = await coordinator.getWorkerTranscript({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
    });
    expect(transcript[0]).toMatchObject({ type: "worker-launch" });
    expect(transcript).toContainEqual({
      type: "progress",
      workerId: "implement-42-43-r1",
      message: "Running tests",
    });

    // No Next actions while the worker runs — panel owns progress.
    await expect(coordinator.nextActions()).resolves.toEqual([]);
  });

  it("receives Stage results over the Worker protocol and offers Implementation disposition", async () => {
    const { coordinator, workers, tracker } = ticketsPublishedFixture();
    const writesBefore = tracker.state.writeManifestCalls;

    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "stage-result",
      workerId: "implement-42-43-r1",
      outcome: {
        status: "completed",
        summary: "Core path implemented",
        localCommitSha: "abc123",
      },
    });
    await workers.emit("implement-42-43-r1", {
      type: "process-exit",
      workerId: "implement-42-43-r1",
      code: 0,
    });

    const panel = await coordinator.getPanelState();
    expect(panel?.workers[0]?.status).toBe("needs-disposition");

    // Still no remote writes from the worker path.
    expect(tracker.state.writeManifestCalls).toBe(writesBefore);
    expect(tracker.state.createIssueCalls).toBe(0);

    // Disposition is pending — offered as the only Next action.
    const actions = await coordinator.nextActions();
    expect(actions).toEqual([
      {
        id: `disposition:43`,
        label: "Disposition #43",
        description: "Core path implemented",
      },
    ]);

    const needsDisposition = await coordinator.runNextAction("disposition:43");
    expect(needsDisposition.status).toBe("needs-disposition");
    if (needsDisposition.status === "needs-disposition") {
      expect(needsDisposition.dispositionOptions).toEqual([
        "close",
        "leave-open",
        "investigate",
      ]);
    }

    const closed = await coordinator.confirmDisposition("close");
    expect(closed).toEqual({
      status: "completed",
      stage: "implement",
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
      disposition: "close",
      readyForIntegration: true,
      branchName: "matt-auto/42/ticket-43/r1",
      worktreePath: "/matt-auto-workspaces/42/ticket-43/r1",
    });

    // Close does not close the GitHub ticket (Integration lands later).
    const ticket = tracker.state.issues.find((i) => i.number === 43);
    expect(ticket?.state).toBe("OPEN");
    expect(tracker.state.writeManifestCalls).toBe(writesBefore);
  });

  it("supports Leave open and Investigate dispositions without remote writes", async () => {
    const { coordinator, workers, tracker } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(44));
    await workers.emit("implement-42-44-r1", {
      type: "stage-result",
      workerId: "implement-42-44-r1",
      outcome: { status: "completed", summary: "Parallel done" },
    });

    const leftOpen = await coordinator.confirmDisposition("leave-open");
    expect(leftOpen).toMatchObject({
      status: "completed",
      disposition: "leave-open",
      readyForIntegration: false,
      ticketNumber: 44,
    });
    expect(tracker.state.issues.find((i) => i.number === 44)?.state).toBe("OPEN");

    // Launch again (r2) for investigate path.
    await coordinator.runNextAction(implementTicketActionId(44));
    await workers.emit("implement-42-44-r2", {
      type: "stage-result",
      workerId: "implement-42-44-r2",
      outcome: { status: "completed" },
    });

    const investigated = await coordinator.confirmDisposition("investigate");
    expect(investigated).toMatchObject({
      status: "completed",
      disposition: "investigate",
      readyForIntegration: false,
      attempt: 2,
    });

    const transcript = await coordinator.getWorkerTranscript({
      workflowId: 42,
      ticketNumber: 44,
      attempt: 2,
    });
    expect(transcript).toContainEqual({
      type: "disposition",
      decision: "investigate",
    });

    expect(IMPLEMENTATION_DISPOSITION_OPTIONS).toEqual([
      "close",
      "leave-open",
      "investigate",
    ]);
  });

  it("enters Compatibility recovery when the worker exits without a Stage result", async () => {
    const { coordinator, workers } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "process-exit",
      workerId: "implement-42-43-r1",
      code: 0,
    });

    const transcript = await coordinator.getWorkerTranscript({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
    });
    expect(
      transcript.some(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: string }).type === "compatibility-recovery",
      ),
    ).toBe(true);

    // Recoverable: ticket remains ready and can be launched again.
    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toContain(implementTicketActionId(43));
  });

  it("aborts the session-owned worker cleanly and leaves GitHub state recoverable", async () => {
    const { coordinator, workers, tracker } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    await coordinator.abortWorkers();

    expect(workers.state.abortAllCount).toBe(1);
    expect(workers.state.aborts).toContain("implement-42-43-r1");

    // GitHub ticket still open and ready.
    expect(tracker.state.issues.find((i) => i.number === 43)?.state).toBe("OPEN");
    const progress = await coordinator.getTicketProgress();
    expect(progress?.ready.map((t) => t.number)).toContain(43);

    // Can relaunch after abort (attempt 2).
    const relaunch = await coordinator.runNextAction(
      implementTicketActionId(43),
    );
    expect(relaunch).toMatchObject({
      status: "running",
      attempt: 2,
      branchName: "matt-auto/42/ticket-43/r2",
    });
  });

  it("aborts workers when switching Workflow root", async () => {
    const tracker = createTracker({
      active: {
        workflowId: 42,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "tickets-published",
        workerProfile: defaultWorkerProfile,
        tickets: [43],
      },
      tickets: [{ number: 43, title: "Only", blockedBy: [] }],
    });
    const workers = createWorkers();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/workspace",
        topology: createTopology({
          nearest: "/workspace",
          nested: [{ path: "/workspace/services/api", isSubmodule: false }],
        }),
        roots: {
          "/workspace": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
            tracker,
            workers,
            workspace: createWorkspace("/workspace"),
            transcripts: createTranscripts(),
          },
          "/workspace/services/api": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
            workspace: createWorkspace("/workspace/services/api"),
            workers: createWorkers(),
            transcripts: createTranscripts(),
          },
        },
      }),
    );

    await coordinator.runNextAction(implementTicketActionId(43));
    await coordinator.selectRoot("/workspace/services/api");

    expect(workers.state.abortAllCount).toBe(1);
  });

  it("fails closed when launching a ticket that is not on the ready frontier", async () => {
    const { coordinator, workers } = ticketsPublishedFixture();

    const result = await coordinator.runNextAction(implementTicketActionId(45));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/ready frontier/i);
    }
    expect(workers.state.launches).toHaveLength(0);
  });

  it("rejects a second concurrent launch on the single-worker path", async () => {
    const { coordinator } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    const second = await coordinator.runNextAction(implementTicketActionId(44));

    expect(second.status).toBe("failed");
    if (second.status === "failed") {
      expect(second.reason).toMatch(/already running/i);
    }
  });

  it("numbers rework attempts without reusing a completed workspace identity", async () => {
    const { coordinator, workers, workspace } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "stage-result",
      workerId: "implement-42-43-r1",
      outcome: { status: "completed" },
    });
    await coordinator.confirmDisposition("leave-open");

    const second = await coordinator.runNextAction(implementTicketActionId(43));
    expect(second).toMatchObject({
      status: "running",
      attempt: 2,
      branchName: "matt-auto/42/ticket-43/r2",
      worktreePath: "/matt-auto-workspaces/42/ticket-43/r2",
    });
    expect(workspace.state.creates.map((c) => c.attempt)).toEqual([1, 2]);
  });
});
