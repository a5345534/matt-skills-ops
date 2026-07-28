import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import {
  REQUIRED_MATT_SKILLS,
  START_NEW_INDEPENDENT_WORKFLOW_ACTION,
  resumeWorkflowActionId,
} from "../src/constants.js";
import {
  createFakeCoordinationPort,
  createInMemoryCoordinationStore,
  createPreferencesPort,
  createInMemoryWorkflowHomeLockPort,
  createInMemoryWorkflowHomeLockStore,
  createWorkflowHomeLockPort,
} from "../src/adapters/index.js";
import { canonicalTargetIdentityKey } from "../src/coordination.js";
import type {
  CoordinationPort,
  PreferencesPort,
  RootScopedPorts,
  TrackerPort,
  WorkflowHomeLockPort,
  WorkflowCoordinatorPorts,
} from "../src/ports.js";
import type {
  ActiveWorkflow,
  CanonicalTargetIdentity,
  WorkflowHomeBinding,
  WorkflowManifest,
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

function coordinatedWorkflow(workflowId: number, title?: string): ActiveWorkflow {
  return {
    workflowId,
    targetBranch: "main",
    stage: "spec-published",
    workerProfile: profile,
    ...(title ? { title } : {}),
    coordination: { target },
  };
}

type TrackerState = {
  workflows: Map<number, ActiveWorkflow>;
  manifests: Map<number, WorkflowManifest>;
  nextIssueNumber: number;
};

function copyWorkflow(workflow: ActiveWorkflow): ActiveWorkflow {
  return {
    ...workflow,
    workerProfile: { ...workflow.workerProfile },
    ...(workflow.coordination
      ? {
          coordination: {
            ...workflow.coordination,
            target: {
              repository: { ...workflow.coordination.target.repository },
              targetRef: workflow.coordination.target.targetRef,
            },
          },
        }
      : {}),
  };
}

function activeFromManifest(manifest: WorkflowManifest): ActiveWorkflow {
  return {
    workflowId: manifest.workflowId,
    targetBranch: manifest.targetBranch,
    stage: manifest.stage,
    workerProfile: { ...manifest.workerProfile },
    ...(manifest.tickets ? { tickets: [...manifest.tickets] } : {}),
    ...(manifest.integrationBranch
      ? { integrationBranch: manifest.integrationBranch }
      : {}),
    ...(manifest.version === 2 ? { coordination: manifest.coordination } : {}),
    ...(manifest.followUpOf !== undefined
      ? { followUpOf: manifest.followUpOf }
      : {}),
  };
}

function createTracker(
  initial: readonly ActiveWorkflow[],
): { port: TrackerPort; state: TrackerState } {
  const state: TrackerState = {
    workflows: new Map(initial.map((workflow) => [workflow.workflowId, workflow])),
    manifests: new Map(),
    nextIssueNumber: 100,
  };
  const port: TrackerPort = {
    getCanonicalRepositoryIdentity: async () => ({ ...target.repository }),
    createIssue: async () => ({ number: state.nextIssueNumber++ }),
    writeWorkflowManifest: async (issueNumber, manifest) => {
      state.manifests.set(issueNumber, manifest);
      state.workflows.set(issueNumber, activeFromManifest(manifest));
    },
    findActiveWorkflows: async (requestedTarget) => {
      if (
        canonicalTargetIdentityKey(requestedTarget) !==
        canonicalTargetIdentityKey(target)
      ) {
        return [];
      }
      return [...state.workflows.values()]
        .filter((workflow) => workflow.stage !== "completed")
        .map(copyWorkflow)
        .sort((left, right) => left.workflowId - right.workflowId);
    },
    findActiveWorkflow: async (_branch, hint) => {
      const candidates = [...state.workflows.values()]
        .filter((workflow) => workflow.stage !== "completed")
        .sort((left, right) => left.workflowId - right.workflowId);
      const selected =
        hint === undefined
          ? candidates.length === 1
            ? candidates[0]
            : undefined
          : candidates.find((workflow) => workflow.workflowId === hint);
      return selected ? copyWorkflow(selected) : undefined;
    },
    listTickets: async () => [],
    addBlockedBy: async () => {},
    addSubIssue: async () => {},
    closeIssue: async () => {},
    reopenIssue: async () => {},
    createPullRequest: async () => ({ number: 500 }),
    mergePullRequest: async () => {},
  };
  return { port, state };
}

type PreferenceState = {
  binding?: WorkflowHomeBinding;
};

function createPreferences(
  state: PreferenceState = {},
): { port: PreferencesPort; state: PreferenceState } {
  const port: PreferencesPort = {
    getConfiguredTargetBranch: async () => "main",
    getGlobalWorkerProfile: async () => profile,
    getRootWorkerProfile: async () => undefined,
    getWorkflowSnapshotWorkerProfile: async () => undefined,
    setGlobalWorkerProfile: async () => {},
    setRootWorkerProfile: async () => {},
    clearRootWorkerProfile: async () => {},
    getGlobalWorkerConcurrency: async () => undefined,
    getRootWorkerConcurrency: async () => undefined,
    setGlobalWorkerConcurrency: async () => {},
    setRootWorkerConcurrency: async () => {},
    clearRootWorkerConcurrency: async () => {},
    getActiveWorkflowId: async () => undefined,
    setActiveWorkflowId: async () => {},
    clearActiveWorkflowId: async () => {},
    getWorkflowHomeBinding: async (requestedTarget) => {
      if (!state.binding) return undefined;
      return canonicalTargetIdentityKey(requestedTarget) ===
        canonicalTargetIdentityKey(state.binding.target)
        ? {
            workflowId: state.binding.workflowId,
            target: {
              repository: { ...state.binding.target.repository },
              targetRef: state.binding.target.targetRef,
            },
          }
        : undefined;
    },
    setWorkflowHomeBinding: async (binding) => {
      state.binding = {
        workflowId: binding.workflowId,
        target: {
          repository: { ...binding.target.repository },
          targetRef: binding.target.targetRef,
        },
      };
    },
    clearWorkflowHomeBinding: async (requestedTarget) => {
      if (
        state.binding &&
        canonicalTargetIdentityKey(requestedTarget) ===
          canonicalTargetIdentityKey(state.binding.target)
      ) {
        delete state.binding;
      }
    },
  };
  return { port, state };
}

function createCoordinator(input: {
  tracker: TrackerPort;
  coordination: CoordinationPort;
  preferences?: PreferenceState;
  workflowHomeLock?: WorkflowHomeLockPort;
  path: string;
}): {
  coordinator: ReturnType<typeof createWorkflowCoordinator>;
  preferences: PreferenceState;
} {
  const pref = createPreferences(input.preferences);
  const root: RootScopedPorts = {
    environment: {
      hasGitHubRemote: async () => true,
      isGhAuthenticated: async () => true,
      targetBranchExists: async () => true,
      detectDefaultBranch: async () => "main",
    },
    skills: {
      installedSkillNames: async () => REQUIRED_MATT_SKILLS,
      runCreateSpec: async () => ({
        ok: true,
        draft: {
          title: "Independent delivery",
          body: [
            "## Problem Statement",
            "A concise problem statement for an independently routed workflow.",
            "",
            "## Solution",
            "A concise solution with observable acceptance coverage.",
          ].join("\n"),
        },
      }),
      runCreateTickets: async () => ({ ok: false, reason: "not used" }),
      prepareImplement: async () => ({ ok: false, reason: "not used" }),
      prepareResolveConflicts: async () => ({ ok: false, reason: "not used" }),
    },
    preferences: pref.port,
    tracker: input.tracker,
    workspace: {} as RootScopedPorts["workspace"],
    workers: {} as RootScopedPorts["workers"],
    transcripts: {} as RootScopedPorts["transcripts"],
    verification: {} as RootScopedPorts["verification"],
    remoteGit: {} as RootScopedPorts["remoteGit"],
    ci: {} as RootScopedPorts["ci"],
    coordination: input.coordination,
    ...(input.workflowHomeLock
      ? { workflowHomeLock: input.workflowHomeLock }
      : {}),
  };
  const ports: WorkflowCoordinatorPorts = {
    startPath: input.path,
    topology: {
      nearestGitRoot: async () => input.path,
      nestedGitRepositories: async () => [],
    },
    models: {
      listAvailableModels: async () => [],
      getHomeModel: async () => undefined,
    },
    forRoot: () => root,
  };
  return { coordinator: createWorkflowCoordinator(ports), preferences: pref.state };
}

describe("Workflow-home bindings and coordinator leases", () => {
  it("persists a checkout binding by canonical repository and Target ref", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "matt-auto-binding-"));
    try {
      const preferences = createPreferencesPort(root);
      await preferences.setWorkflowHomeBinding?.({ target, workflowId: 41 });
      const reloaded = createPreferencesPort(root);
      await expect(
        reloaded.getWorkflowHomeBinding?.({
          repository: { owner: "acme", name: "workflow-tools" },
          targetRef: "refs/heads/main",
        }),
      ).resolves.toMatchObject({ workflowId: 41, target });
      await reloaded.clearWorkflowHomeBinding?.(target);
      await expect(reloaded.getWorkflowHomeBinding?.(target)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses an atomic local checkout guard and releases it only for its holder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "matt-auto-home-lock-"));
    try {
      const first = createWorkflowHomeLockPort(root);
      const second = createWorkflowHomeLockPort(root);
      const acquired = await first.acquire({ holderId: "home-a" });
      expect(acquired).toMatchObject({ acquired: true });
      const contended = await second.acquire({ holderId: "home-b" });
      expect(contended).toEqual({ acquired: false, holderId: "home-a" });
      if (!acquired.acquired) throw new Error("expected first home lock");
      await expect(first.release(acquired.lock)).resolves.toEqual({ released: true });
      const secondAcquired = await second.acquire({ holderId: "home-b" });
      expect(secondAcquired).toMatchObject({ acquired: true });
      await expect(first.release(acquired.lock)).resolves.toEqual({ released: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reloads only the checkout-bound Active workflow", async () => {
    const tracker = createTracker([
      coordinatedWorkflow(41, "Bound workflow"),
      coordinatedWorkflow(42, "Sibling workflow"),
    ]);
    const coordination = createFakeCoordinationPort({
      store: createInMemoryCoordinationStore(),
    });
    const { coordinator } = createCoordinator({
      tracker: tracker.port,
      coordination,
      preferences: { binding: { target, workflowId: 41 } },
      path: "/checkout-a",
    });

    await expect(coordinator.getActiveWorkflow()).resolves.toMatchObject({
      workflowId: 41,
    });
    await expect(coordinator.nextActions()).resolves.toEqual([
      expect.objectContaining({ id: "create-tickets" }),
    ]);
  });

  it("requires explicit Resume or Start new when no binding exists", async () => {
    const tracker = createTracker([
      coordinatedWorkflow(41, "First sibling"),
      coordinatedWorkflow(42, "Second sibling"),
    ]);
    const coordination = createFakeCoordinationPort({
      store: createInMemoryCoordinationStore(),
    });
    const home = createCoordinator({
      tracker: tracker.port,
      coordination,
      path: "/checkout-a",
    });

    await expect(home.coordinator.getActiveWorkflow()).resolves.toBeUndefined();
    const actions = await home.coordinator.nextActions();
    expect(actions.map((action) => action.id)).toEqual([
      resumeWorkflowActionId(41),
      resumeWorkflowActionId(42),
      START_NEW_INDEPENDENT_WORKFLOW_ACTION.id,
    ]);

    await expect(
      home.coordinator.runNextAction(resumeWorkflowActionId(42)),
    ).resolves.toMatchObject({
      status: "completed",
      stage: "workflow-routing",
      workflowId: 42,
    });
    await expect(home.coordinator.getActiveWorkflow()).resolves.toMatchObject({
      workflowId: 42,
    });
    expect(home.preferences.binding?.workflowId).toBe(42);
  });

  it("rejects a second checkout that tries to operate the same Workflow ID", async () => {
    const tracker = createTracker([coordinatedWorkflow(41)]);
    const store = createInMemoryCoordinationStore();
    const first = createCoordinator({
      tracker: tracker.port,
      coordination: createFakeCoordinationPort({ store }),
      path: "/checkout-a",
    });
    const second = createCoordinator({
      tracker: tracker.port,
      coordination: createFakeCoordinationPort({ store }),
      path: "/checkout-b",
    });

    await expect(
      first.coordinator.runNextAction(resumeWorkflowActionId(41)),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(second.coordinator.getActiveWorkflow()).resolves.toBeUndefined();
    await expect(second.coordinator.nextActions()).resolves.toEqual([
      expect.objectContaining({ id: resumeWorkflowActionId(41) }),
      expect.objectContaining({ id: START_NEW_INDEPENDENT_WORKFLOW_ACTION.id }),
    ]);
    await expect(
      second.coordinator.runNextAction(resumeWorkflowActionId(41)),
    ).resolves.toMatchObject({
      status: "failed",
      stage: "workflow-routing",
      workflowId: 41,
    });
    expect((await second.coordinator.getActiveWorkflow())?.workflowId).toBeUndefined();
  });

  it("allows different checkouts to bind different Workflow IDs for one Target", async () => {
    const tracker = createTracker([
      coordinatedWorkflow(41),
      coordinatedWorkflow(42),
    ]);
    const store = createInMemoryCoordinationStore();
    const first = createCoordinator({
      tracker: tracker.port,
      coordination: createFakeCoordinationPort({ store }),
      path: "/checkout-a",
    });
    const second = createCoordinator({
      tracker: tracker.port,
      coordination: createFakeCoordinationPort({ store }),
      path: "/checkout-b",
    });

    await expect(
      first.coordinator.runNextAction(resumeWorkflowActionId(41)),
    ).resolves.toMatchObject({ status: "completed", workflowId: 41 });
    await expect(
      second.coordinator.runNextAction(resumeWorkflowActionId(42)),
    ).resolves.toMatchObject({ status: "completed", workflowId: 42 });
    await expect(first.coordinator.getActiveWorkflow()).resolves.toMatchObject({
      workflowId: 41,
    });
    await expect(second.coordinator.getActiveWorkflow()).resolves.toMatchObject({
      workflowId: 42,
    });
  });

  it("rejects a shared-checkout attempt locally before it can bind another workflow", async () => {
    const tracker = createTracker([
      coordinatedWorkflow(41),
      coordinatedWorkflow(42),
    ]);
    const coordinationStore = createInMemoryCoordinationStore();
    const lockStore = createInMemoryWorkflowHomeLockStore();
    const first = createCoordinator({
      tracker: tracker.port,
      coordination: createFakeCoordinationPort({ store: coordinationStore }),
      workflowHomeLock: createInMemoryWorkflowHomeLockPort({ store: lockStore }),
      path: "/shared-checkout",
    });
    const second = createCoordinator({
      tracker: tracker.port,
      coordination: createFakeCoordinationPort({ store: coordinationStore }),
      workflowHomeLock: createInMemoryWorkflowHomeLockPort({ store: lockStore }),
      path: "/shared-checkout",
    });

    await expect(
      first.coordinator.runNextAction(resumeWorkflowActionId(41)),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      second.coordinator.runNextAction(resumeWorkflowActionId(42)),
    ).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/checkout/i),
    });
  });

  it("clears a stale binding and creates new workflows as coordination-aware manifests", async () => {
    const tracker = createTracker([coordinatedWorkflow(41)]);
    const coordination = createFakeCoordinationPort({
      store: createInMemoryCoordinationStore(),
    });
    const home = createCoordinator({
      tracker: tracker.port,
      coordination,
      preferences: { binding: { target, workflowId: 999 } },
      path: "/checkout-a",
    });

    const staleActions = await home.coordinator.nextActions();
    expect(staleActions.map((action) => action.id)).toContain(
      resumeWorkflowActionId(41),
    );
    expect(home.preferences.binding).toBeUndefined();

    const freshTracker = createTracker([]);
    const freshHome = createCoordinator({
      tracker: freshTracker.port,
      coordination: createFakeCoordinationPort({
        store: createInMemoryCoordinationStore(),
      }),
      path: "/checkout-new",
    });
    await expect(
      freshHome.coordinator.runNextAction(
        START_NEW_INDEPENDENT_WORKFLOW_ACTION.id,
      ),
    ).resolves.toMatchObject({
      status: "needs-confirmation",
      stage: "create-spec",
    });
    await expect(freshHome.coordinator.confirmStage("publish")).resolves.toMatchObject({
      status: "completed",
      stage: "create-spec",
      workflowId: 100,
    });
    expect(freshTracker.state.manifests.get(100)).toMatchObject({
      version: 2,
      coordination: { target },
    });
    expect(freshHome.preferences.binding?.workflowId).toBe(100);
  });
});
