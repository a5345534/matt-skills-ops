import path from "node:path";
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
} from "./constants.js";
import type {
  RootScopedPorts,
  WorkflowCoordinatorPorts,
} from "./ports.js";
import type {
  ActiveWorkflow,
  AvailableModel,
  NextAction,
  PreflightCheck,
  PreflightResult,
  ResolvedWorkerProfile,
  SpecDraft,
  StageConfirmationDecision,
  StageResult,
  WorkerProfile,
  WorkflowCoordinator,
  WorkflowManifest,
  WorkflowRoot,
  WorkflowRootKind,
} from "./types.js";

type PendingCreateSpec = {
  stage: "create-spec";
  draft: SpecDraft;
};

/**
 * Create the Workflow coordinator — the sole product seam for Matt Auto.
 *
 * Product rules (root selection, preflight, Worker profile precedence, Next
 * actions, later stages) live here. Adapters are injected as ports and are not
 * part of this interface.
 */
export function createWorkflowCoordinator(
  ports: WorkflowCoordinatorPorts,
): WorkflowCoordinator {
  let selectedPath: string | undefined;
  let scoped: RootScopedPorts | undefined;
  /** Session-local pending Stage confirmation (never remote until Publish). */
  let pending: PendingCreateSpec | undefined;

  function bindRoot(rootPath: string): void {
    selectedPath = rootPath;
    scoped = ports.forRoot(rootPath);
  }

  async function classifyRoot(
    rootPath: string,
    kind: WorkflowRootKind,
  ): Promise<WorkflowRoot> {
    const { environment } = ports.forRoot(rootPath);
    const hasGitHubRemote = await environment.hasGitHubRemote();
    if (!hasGitHubRemote) {
      return {
        path: rootPath,
        kind,
        status: "unavailable",
        unavailableReason: UNSUPPORTED_TRACKER_REASON,
      };
    }
    return {
      path: rootPath,
      kind,
      status: "available",
    };
  }

  async function discoverRoots(): Promise<WorkflowRoot[]> {
    const nearest = await ports.topology.nearestGitRoot(ports.startPath);

    if (!nearest) {
      const fallback = path.resolve(ports.startPath);
      return [
        {
          path: fallback,
          kind: "nearest",
          status: "unavailable",
          unavailableReason: NO_GIT_REPOSITORY_REASON,
        },
      ];
    }

    const resolvedNearest = path.resolve(nearest);
    const nested = await ports.topology.nestedGitRepositories(resolvedNearest);
    const independent = nested
      .filter((repo) => !repo.isSubmodule)
      .map((repo) => path.resolve(repo.path))
      .sort((a, b) => a.localeCompare(b));

    const candidates: Array<{ path: string; kind: WorkflowRootKind }> = [
      { path: resolvedNearest, kind: "nearest" },
      ...independent.map((nestedPath) => ({
        path: nestedPath,
        kind: "nested-independent" as const,
      })),
    ];

    return Promise.all(
      candidates.map(({ path: rootPath, kind }) =>
        classifyRoot(rootPath, kind),
      ),
    );
  }

  async function ensureSelected(): Promise<WorkflowRoot> {
    const roots = await discoverRoots();
    const defaultRoot = roots[0];
    if (!defaultRoot) {
      // discoverRoots always returns at least the nearest/fallback entry.
      throw new Error("Root selection produced no Workflow roots.");
    }

    if (!selectedPath) {
      bindRoot(defaultRoot.path);
      return defaultRoot;
    }

    const current = roots.find((root) => root.path === selectedPath);
    if (!current) {
      bindRoot(defaultRoot.path);
      return defaultRoot;
    }

    if (!scoped) {
      bindRoot(current.path);
    }
    return current;
  }

  async function requireScoped(): Promise<RootScopedPorts> {
    await ensureSelected();
    if (!scoped) {
      throw new Error("Workflow root ports are not bound.");
    }
    return scoped;
  }

  async function resolveTargetBranch(
    preferences: RootScopedPorts["preferences"],
  ): Promise<string> {
    const configured = await preferences.getConfiguredTargetBranch();
    return configured ?? DEFAULT_TARGET_BRANCH;
  }

  async function loadActiveWorkflow(
    bound: RootScopedPorts,
  ): Promise<ActiveWorkflow | undefined> {
    const targetBranch = await resolveTargetBranch(bound.preferences);
    return bound.tracker.findActiveWorkflow(targetBranch);
  }

  /**
   * Worker profile precedence: workflow-snapshot → workflow-root → global.
   * Snapshot comes from local cache or the Active workflow manifest on GitHub.
   */
  async function resolveWorkerProfile(
    bound: RootScopedPorts,
  ): Promise<ResolvedWorkerProfile | undefined> {
    const snapshot = await bound.preferences.getWorkflowSnapshotWorkerProfile();
    if (snapshot) {
      return { profile: snapshot, source: "workflow-snapshot" };
    }

    const active = await loadActiveWorkflow(bound);
    if (active?.workerProfile) {
      return { profile: active.workerProfile, source: "workflow-snapshot" };
    }

    const root = await bound.preferences.getRootWorkerProfile();
    if (root) {
      return { profile: root, source: "workflow-root" };
    }
    const global = await bound.preferences.getGlobalWorkerProfile();
    if (global) {
      return { profile: global, source: "global" };
    }
    return undefined;
  }

  function isUsableDraft(draft: SpecDraft): boolean {
    return draft.title.trim().length > 0 && draft.body.trim().length > 0;
  }

  async function invokeCreateSpec(
    bound: RootScopedPorts,
  ): Promise<StageResult> {
    const outcome = await bound.skills.runCreateSpec();
    if (!outcome.ok) {
      pending = undefined;
      return {
        status: "compatibility-recovery",
        stage: "create-spec",
        reason: outcome.reason,
      };
    }

    if (!isUsableDraft(outcome.draft)) {
      pending = undefined;
      return {
        status: "compatibility-recovery",
        stage: "create-spec",
        reason:
          "Create-spec skill returned a draft missing a non-empty title or body. Matt Auto entered Compatibility recovery rather than publishing.",
      };
    }

    const draft: SpecDraft = {
      title: outcome.draft.title.trim(),
      body: outcome.draft.body,
    };
    pending = { stage: "create-spec", draft };
    return {
      status: "needs-confirmation",
      stage: "create-spec",
      draft,
      confirmationOptions: [...STAGE_CONFIRMATION_OPTIONS],
    };
  }

  async function findAvailableModel(
    provider: string,
    modelId: string,
  ): Promise<AvailableModel | undefined> {
    const models = await ports.models.listAvailableModels();
    return models.find(
      (model) => model.provider === provider && model.modelId === modelId,
    );
  }

  async function assertValidWorkerProfile(
    profile: WorkerProfile,
  ): Promise<void> {
    if (
      !profile.provider ||
      !profile.modelId ||
      !profile.thinkingLevel ||
      typeof profile.provider !== "string" ||
      typeof profile.modelId !== "string" ||
      typeof profile.thinkingLevel !== "string"
    ) {
      throw new Error(
        "Worker profile requires provider, modelId, and thinkingLevel.",
      );
    }

    const models = await ports.models.listAvailableModels();
    // Empty catalog (tests / offline) skips catalog validation but still
    // requires a non-empty thinking level string.
    if (models.length === 0) {
      return;
    }

    const match = models.find(
      (model) =>
        model.provider === profile.provider && model.modelId === profile.modelId,
    );
    if (!match) {
      throw new Error(
        `Model "${profile.provider}/${profile.modelId}" is not in Pi’s authenticated available-model catalog.`,
      );
    }
    if (!match.thinkingLevels.includes(profile.thinkingLevel)) {
      throw new Error(
        `Thinking level "${profile.thinkingLevel}" is not supported by ${profile.provider}/${profile.modelId}. Supported: ${match.thinkingLevels.join(", ")}.`,
      );
    }
  }

  async function preflight(): Promise<PreflightResult> {
    const bound = await requireScoped();

    const targetBranch = await resolveTargetBranch(bound.preferences);

    const [
      hasGitHubRemote,
      isGhAuthenticated,
      targetBranchExists,
      installedSkills,
      workerProfile,
    ] = await Promise.all([
      bound.environment.hasGitHubRemote(),
      bound.environment.isGhAuthenticated(),
      bound.environment.targetBranchExists(targetBranch),
      bound.skills.installedSkillNames(),
      resolveWorkerProfile(bound),
    ]);

    const installed = new Set(installedSkills);
    const missingSkills = REQUIRED_MATT_SKILLS.filter(
      (name) => !installed.has(name),
    );

    const checks: PreflightCheck[] = [
      {
        id: "github-remote",
        ok: hasGitHubRemote,
        guidance: hasGitHubRemote
          ? "GitHub remote is configured."
          : "No GitHub remote found on this Workflow root. Add a GitHub remote (for example `origin`) pointing at a GitHub repository. Matt Auto V1 does not create repositories or remotes.",
      },
      {
        id: "gh-auth",
        ok: isGhAuthenticated,
        guidance: isGhAuthenticated
          ? "gh is authenticated."
          : "GitHub CLI is not authenticated. Run `gh auth login` and retry Workflow preflight. Matt Auto V1 does not perform login for you.",
      },
      {
        id: "target-branch",
        ok: targetBranchExists,
        guidance: targetBranchExists
          ? `Target branch "${targetBranch}" is available.`
          : `Target branch "${targetBranch}" was not found locally or on a remote. Create or fetch that branch yourself, or configure a different Target branch for this Workflow root. Matt Auto V1 does not create branches or push.`,
      },
      {
        id: "matt-skills",
        ok: missingSkills.length === 0,
        guidance:
          missingSkills.length === 0
            ? "Required Matt skills are installed."
            : `Missing required Matt skills: ${missingSkills.join(", ")}. Install them into a Pi skill location and retry. Matt Auto adapts installed skills and does not bundle them.`,
      },
      {
        id: "worker-profile",
        ok: workerProfile !== undefined,
        guidance:
          workerProfile !== undefined
            ? `Worker profile is set (${workerProfile.profile.provider}/${workerProfile.profile.modelId}, thinking ${workerProfile.profile.thinkingLevel}, source ${workerProfile.source}).`
            : "No Worker profile is configured. Set a global or Workflow-root Worker profile (model + thinking level) before starting Implementation workers.",
      },
    ];

    const result: PreflightResult = {
      ok: checks.every((check) => check.ok),
      targetBranch,
      checks,
    };
    if (workerProfile) {
      result.workerProfile = workerProfile;
    }
    return result;
  }

  async function nextActions(): Promise<NextAction[]> {
    const result = await preflight();
    if (!result.ok) {
      return [];
    }

    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);

    if (!active) {
      return [
        {
          id: CREATE_SPEC_ACTION.id,
          label: CREATE_SPEC_ACTION.label,
          description: CREATE_SPEC_ACTION.description,
        },
      ];
    }

    if (active.stage === "spec-published") {
      return [
        {
          id: CREATE_TICKETS_ACTION.id,
          label: CREATE_TICKETS_ACTION.label,
          description: CREATE_TICKETS_ACTION.description,
        },
      ];
    }

    return [];
  }

  async function runNextAction(actionId: string): Promise<StageResult> {
    if (actionId === CREATE_SPEC_ACTION.id) {
      return startCreateSpec();
    }

    if (actionId === CREATE_TICKETS_ACTION.id) {
      return {
        status: "failed",
        stage: "create-tickets",
        reason:
          "Create-tickets Planning stage is not implemented yet. It lands in a later Matt Auto ticket.",
      };
    }

    return {
      status: "failed",
      stage: "create-spec",
      reason: `Unknown Next action "${actionId}".`,
    };
  }

  async function startCreateSpec(): Promise<StageResult> {
    const bound = await requireScoped();
    const preflightResult = await preflight();
    if (!preflightResult.ok) {
      return {
        status: "failed",
        stage: "create-spec",
        reason:
          "Workflow preflight is incomplete. Resolve preflight checks before running Create-spec.",
      };
    }

    const active = await loadActiveWorkflow(bound);
    if (active) {
      return {
        status: "failed",
        stage: "create-spec",
        reason: `An Active workflow already exists for Target branch "${active.targetBranch}" (Workflow ID #${active.workflowId}). Create-spec is unavailable until that workflow completes.`,
      };
    }

    if (pending) {
      return {
        status: "failed",
        stage: "create-spec",
        reason:
          "A Stage confirmation is already pending. Choose Publish, Revise, or Cancel before starting Create-spec again.",
      };
    }

    // Planning stage: invoke installed to-spec in Workflow home; never publish here.
    return invokeCreateSpec(bound);
  }

  async function confirmStage(
    decision: StageConfirmationDecision,
  ): Promise<StageResult> {
    if (!pending || pending.stage !== "create-spec") {
      return {
        status: "failed",
        stage: "create-spec",
        reason:
          "No pending Stage confirmation. Run Create-spec first and wait for a reviewable draft.",
      };
    }

    if (decision === "cancel") {
      pending = undefined;
      return {
        status: "cancelled",
        stage: "create-spec",
      };
    }

    const bound = await requireScoped();

    if (decision === "revise") {
      // Re-invoke to-spec without any remote writes.
      pending = undefined;
      return invokeCreateSpec(bound);
    }

    // decision === "publish"
    const draft = pending.draft;
    const targetBranch = await resolveTargetBranch(bound.preferences);
    const workerProfile = await resolveWorkerProfile(bound);
    if (!workerProfile) {
      return {
        status: "failed",
        stage: "create-spec",
        reason:
          "Cannot publish Create-spec without a Worker profile. Configure one and retry Stage confirmation Publish.",
      };
    }

    // Remote writes only on Publish, owned by the Workflow coordinator.
    let issueNumber: number;
    try {
      const created = await bound.tracker.createIssue({
        title: draft.title,
        body: draft.body,
        labels: [SPEC_ISSUE_LABEL],
      });
      issueNumber = created.number;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "create-spec",
        reason: `Failed to create the GitHub spec issue: ${message}`,
      };
    }

    const manifest: WorkflowManifest = {
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: issueNumber,
      targetBranch,
      stage: "spec-published",
      workerProfile: workerProfile.profile,
    };

    try {
      await bound.tracker.writeWorkflowManifest(issueNumber, manifest);
    } catch (error) {
      // Issue already exists remotely — drop the session pending draft so a retry
      // cannot create a second spec issue for the same Stage confirmation.
      pending = undefined;
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "create-spec",
        reason: `Spec issue #${issueNumber} was created, but writing the Workflow manifest failed: ${message}. Inspect issue #${issueNumber} and recover the Workflow manifest before continuing.`,
      };
    }

    pending = undefined;
    return {
      status: "completed",
      stage: "create-spec",
      workflowId: issueNumber,
    };
  }

  async function getActiveWorkflow(): Promise<ActiveWorkflow | undefined> {
    const bound = await requireScoped();
    return loadActiveWorkflow(bound);
  }

  async function currentRoot(): Promise<WorkflowRoot> {
    return ensureSelected();
  }

  async function listRoots(): Promise<WorkflowRoot[]> {
    await ensureSelected();
    return discoverRoots();
  }

  async function selectRoot(rootPath: string): Promise<WorkflowRoot> {
    const resolved = path.resolve(rootPath);
    const roots = await discoverRoots();
    const match = roots.find((root) => root.path === resolved);
    if (!match) {
      throw new Error(
        `Path "${rootPath}" is not a discovered Workflow root. Choose a root from listRoots().`,
      );
    }
    bindRoot(match.path);
    return match;
  }

  async function getWorkerProfile(): Promise<
    ResolvedWorkerProfile | undefined
  > {
    const bound = await requireScoped();
    return resolveWorkerProfile(bound);
  }

  async function getGlobalWorkerProfile(): Promise<WorkerProfile | undefined> {
    const bound = await requireScoped();
    return bound.preferences.getGlobalWorkerProfile();
  }

  async function getRootWorkerProfile(): Promise<WorkerProfile | undefined> {
    const bound = await requireScoped();
    return bound.preferences.getRootWorkerProfile();
  }

  async function setGlobalWorkerProfile(profile: WorkerProfile): Promise<void> {
    const bound = await requireScoped();
    await assertValidWorkerProfile(profile);
    await bound.preferences.setGlobalWorkerProfile(profile);
  }

  async function setRootWorkerProfile(profile: WorkerProfile): Promise<void> {
    const bound = await requireScoped();
    await assertValidWorkerProfile(profile);
    await bound.preferences.setRootWorkerProfile(profile);
  }

  async function clearRootWorkerProfile(): Promise<void> {
    const bound = await requireScoped();
    await bound.preferences.clearRootWorkerProfile();
  }

  async function listAvailableModels(): Promise<readonly AvailableModel[]> {
    return ports.models.listAvailableModels();
  }

  async function thinkingLevelsFor(
    provider: string,
    modelId: string,
  ): Promise<readonly string[]> {
    const match = await findAvailableModel(provider, modelId);
    if (!match) return ["off"];
    return match.thinkingLevels;
  }

  return {
    preflight,
    nextActions,
    runNextAction,
    confirmStage,
    getActiveWorkflow,
    currentRoot,
    listRoots,
    selectRoot,
    getWorkerProfile,
    getGlobalWorkerProfile,
    getRootWorkerProfile,
    setGlobalWorkerProfile,
    setRootWorkerProfile,
    clearRootWorkerProfile,
    listAvailableModels,
    thinkingLevelsFor,
  };
}
