import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import type {
  CreateSpecSkillOutcome,
  EnvironmentPort,
  GitTopologyPort,
  ModelsPort,
  NestedGitRepository,
  PreferencesPort,
  RootScopedPorts,
  SkillsPort,
  TrackerPort,
  WorkflowCoordinatorPorts,
} from "../src/ports.js";
import type {
  ActiveWorkflow,
  AvailableModel,
  SpecDraft,
  WorkerProfile,
  WorkflowManifest,
} from "../src/types.js";
import {
  CREATE_SPEC_ACTION,
  CREATE_TICKETS_ACTION,
  DEFAULT_TARGET_BRANCH,
  NO_GIT_REPOSITORY_REASON,
  REQUIRED_MATT_SKILLS,
  SPEC_ISSUE_LABEL,
  STAGE_CONFIRMATION_OPTIONS,
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

type SkillsFixture = {
  names?: readonly string[];
  /** Sequential outcomes for runCreateSpec (last value repeats). */
  createSpecOutcomes?: CreateSpecSkillOutcome[];
  /** Invocations recorded for assertions. */
  calls?: { runCreateSpec: number };
};

function createSkills(fixture: SkillsFixture = {}): SkillsPort {
  const names = fixture.names ?? [...REQUIRED_MATT_SKILLS];
  const outcomes = fixture.createSpecOutcomes ?? [
    { ok: true as const, draft: defaultSpecDraft },
  ];
  let outcomeIndex = 0;
  const calls = fixture.calls ?? { runCreateSpec: 0 };

  return {
    installedSkillNames: async () => names,
    runCreateSpec: async () => {
      calls.runCreateSpec += 1;
      const index = Math.min(outcomeIndex, outcomes.length - 1);
      outcomeIndex += 1;
      const outcome = outcomes[index];
      if (!outcome) {
        return {
          ok: false,
          reason: "No Create-spec skill outcome configured.",
        };
      }
      return outcome;
    },
  };
}

type TrackerState = {
  issues: Array<{
    number: number;
    title: string;
    body: string;
    labels: string[];
  }>;
  manifests: Map<number, WorkflowManifest>;
  createIssueCalls: number;
  writeManifestCalls: number;
  nextNumber: number;
};

function createTracker(
  initial: {
    active?: ActiveWorkflow;
    failCreate?: boolean;
  } = {},
): { port: TrackerPort; state: TrackerState } {
  const state: TrackerState = {
    issues: [],
    manifests: new Map(),
    createIssueCalls: 0,
    writeManifestCalls: 0,
    nextNumber: 100,
  };

  if (initial.active) {
    state.manifests.set(initial.active.workflowId, {
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: initial.active.workflowId,
      targetBranch: initial.active.targetBranch,
      stage: initial.active.stage,
      workerProfile: initial.active.workerProfile,
    });
    state.issues.push({
      number: initial.active.workflowId,
      title: initial.active.title ?? "Existing workflow",
      body: "spec",
      labels: [SPEC_ISSUE_LABEL],
    });
    state.nextNumber = initial.active.workflowId + 1;
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
      });
      return { number };
    },
    writeWorkflowManifest: async (issueNumber, manifest) => {
      state.writeManifestCalls += 1;
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
          if (issue?.title) {
            active.title = issue.title;
          }
          return active;
        }
      }
      return undefined;
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
} {
  const startPath = overrides.startPath ?? "/repo";
  const defaultRoot: RootFixture = overrides.defaultRoot ?? {
    preferences: { globalWorkerProfile: defaultWorkerProfile },
  };
  const roots = overrides.roots ?? {};
  const defaultTracker = defaultRoot.tracker ?? createTracker();

  return {
    startPath,
    topology: overrides.topology ?? createTopology({ nearest: "/repo" }),
    models: overrides.models ?? createModels(),
    __defaultTracker: defaultTracker,
    forRoot(rootPath: string): RootScopedPorts {
      const fixture = roots[rootPath] ?? defaultRoot;
      const skillsFixture: SkillsFixture = fixture.skills
        ? fixture.skills
        : fixture.skillNames
          ? { names: fixture.skillNames }
          : {};
      const tracker = fixture.tracker ?? defaultTracker;
      return {
        environment: createEnvironment(fixture.environment),
        skills: createSkills(skillsFixture),
        preferences: createPreferences(
          fixture.preferences ?? {
            globalWorkerProfile: defaultWorkerProfile,
          },
        ),
        tracker: tracker.port,
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
    const skillsCalls = { runCreateSpec: 0 };
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
    const skillsCalls = { runCreateSpec: 0 };
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
