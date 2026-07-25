import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import type {
  EnvironmentPort,
  GitTopologyPort,
  ModelsPort,
  NestedGitRepository,
  PreferencesPort,
  RootScopedPorts,
  SkillsPort,
  WorkflowCoordinatorPorts,
} from "../src/ports.js";
import type { AvailableModel, WorkerProfile } from "../src/types.js";
import {
  DEFAULT_TARGET_BRANCH,
  NO_GIT_REPOSITORY_REASON,
  REQUIRED_MATT_SKILLS,
  UNSUPPORTED_TRACKER_REASON,
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

function createSkills(
  names: readonly string[] = [...REQUIRED_MATT_SKILLS],
): SkillsPort {
  return {
    installedSkillNames: async () => names,
  };
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
  skills?: readonly string[];
  preferences?: PrefState;
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
): WorkflowCoordinatorPorts {
  const startPath = overrides.startPath ?? "/repo";
  const defaultRoot: RootFixture = overrides.defaultRoot ?? {
    preferences: { globalWorkerProfile: defaultWorkerProfile },
  };
  const roots = overrides.roots ?? {};

  return {
    startPath,
    topology: overrides.topology ?? createTopology({ nearest: "/repo" }),
    models: overrides.models ?? createModels(),
    forRoot(rootPath: string): RootScopedPorts {
      const fixture = roots[rootPath] ?? defaultRoot;
      return {
        environment: createEnvironment(fixture.environment),
        skills: createSkills(fixture.skills),
        preferences: createPreferences(
          fixture.preferences ?? {
            globalWorkerProfile: defaultWorkerProfile,
          },
        ),
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
          skills: ["to-spec", "implement"],
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

  it("returns no planning or implementation Next actions yet when preflight passes", async () => {
    // Stages land in later tickets.
    const coordinator = createWorkflowCoordinator(createPorts());

    await expect(coordinator.nextActions()).resolves.toEqual([]);
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
