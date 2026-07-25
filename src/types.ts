/** Preflight check identifiers for Workflow preflight. */
export type PreflightCheckId =
  | "github-remote"
  | "gh-auth"
  | "target-branch"
  | "matt-skills"
  | "worker-profile";

/** One Workflow preflight check result with corrective guidance. */
export type PreflightCheck = {
  id: PreflightCheckId;
  ok: boolean;
  /** Human-readable status or corrective guidance. Never invents bootstrap actions. */
  guidance: string;
};

/** Full Workflow preflight result. */
export type PreflightResult = {
  ok: boolean;
  /** Resolved Target branch name (configured override or default). */
  targetBranch: string;
  checks: PreflightCheck[];
  /** Effective Worker profile after precedence, when configured. */
  workerProfile?: ResolvedWorkerProfile;
};

/**
 * A Next action currently available from Workflow state.
 * Only available actions are returned; preflight failures yield none.
 */
export type NextAction = {
  id: string;
  label: string;
  description: string;
};

/** Planning / orchestration stage identifiers known to the coordinator. */
export type StageId = "create-spec" | "create-tickets";

/** Stage confirmation choices after a reviewable artifact is produced. */
export type StageConfirmationDecision = "publish" | "revise" | "cancel";

/** Reviewable Create-spec draft produced by the Matt skills adapter. */
export type SpecDraft = {
  title: string;
  body: string;
};

/**
 * Durable orchestration stage recorded on the Workflow manifest.
 * Extended by later tickets as the workflow advances.
 */
export type WorkflowStage = "spec-published";

/**
 * Managed Workflow manifest stored as a structured GitHub comment on the spec issue.
 * Does not alter the spec body.
 */
export type WorkflowManifest = {
  schema: "matt-auto/workflow-manifest";
  version: 1;
  workflowId: number;
  targetBranch: string;
  stage: WorkflowStage;
  workerProfile: WorkerProfile;
};

/**
 * Active workflow recovered from GitHub (spec issue + Workflow manifest).
 * Workflow ID is the published spec issue number.
 */
export type ActiveWorkflow = {
  workflowId: number;
  targetBranch: string;
  stage: WorkflowStage;
  workerProfile: WorkerProfile;
  title?: string;
};

/**
 * One-shot Stage result for completion, failure, confirmation, or recovery.
 * Matt Auto reacts to these; it does not poll for decisions.
 */
export type StageResult =
  | {
      status: "needs-confirmation";
      stage: StageId;
      draft: SpecDraft;
      confirmationOptions: readonly StageConfirmationDecision[];
    }
  | {
      status: "completed";
      stage: StageId;
      workflowId: number;
    }
  | {
      status: "cancelled";
      stage: StageId;
    }
  | {
      status: "failed";
      stage: StageId;
      reason: string;
    }
  | {
      status: "compatibility-recovery";
      stage: StageId;
      reason: string;
    };

/**
 * Model + thinking level used by Implementation workers.
 * Distinct from the Workflow home session model.
 */
export type WorkerProfile = {
  provider: string;
  modelId: string;
  thinkingLevel: string;
};

/**
 * Where an effective Worker profile was resolved from.
 * Precedence: workflow-snapshot → workflow-root → global.
 */
export type WorkerProfileSource =
  | "global"
  | "workflow-root"
  | "workflow-snapshot";

/** Effective Worker profile with the layer that supplied it. */
export type ResolvedWorkerProfile = {
  profile: WorkerProfile;
  source: WorkerProfileSource;
};

/**
 * An authenticated model from Pi’s available-model catalog.
 * Thinking levels are those supported by the model.
 */
export type AvailableModel = {
  provider: string;
  modelId: string;
  /** Human-readable label for menus (provider/id or display name). */
  label: string;
  /** Thinking levels supported by this model (always includes at least "off"). */
  thinkingLevels: readonly string[];
};

/**
 * Relationship of a discovered Workflow root to the discovery start path.
 * - nearest: nearest enclosing Git repository (default selection)
 * - nested-independent: independent Git repo nested under the nearest root
 */
export type WorkflowRootKind = "nearest" | "nested-independent";

/** Whether Matt Auto can operate on this Workflow root in the MVP. */
export type WorkflowRootStatus = "available" | "unavailable";

/**
 * A Workflow root candidate from Root selection.
 * Monorepo packages share their enclosing root; submodules are never listed.
 */
export type WorkflowRoot = {
  /** Absolute path of the Git repository (or start path when none exists). */
  path: string;
  kind: WorkflowRootKind;
  status: WorkflowRootStatus;
  /**
   * Present when status is "unavailable".
   * Non-GitHub roots always explain the unsupported-tracker limit.
   */
  unavailableReason?: string;
};

/** Public Workflow coordinator seam. */
export type WorkflowCoordinator = {
  /** Run Workflow preflight against the currently selected Workflow root. */
  preflight(): Promise<PreflightResult>;
  /**
   * Return only currently available Next actions.
   * Empty when preflight fails or no stage is available yet.
   */
  nextActions(): Promise<NextAction[]>;
  /**
   * Run a Next action by id (for example Create-spec Planning stage).
   * Planning stages execute in Workflow home and never publish silently.
   */
  runNextAction(actionId: string): Promise<StageResult>;
  /**
   * Apply Stage confirmation (Publish / Revise / Cancel) for a pending stage.
   * Publish is the only path that performs remote publication.
   */
  confirmStage(decision: StageConfirmationDecision): Promise<StageResult>;
  /**
   * Active workflow for the current Target branch, if any.
   * Recovered from GitHub (Workflow ID + Workflow manifest).
   */
  getActiveWorkflow(): Promise<ActiveWorkflow | undefined>;
  /**
   * Currently selected Workflow root (defaults to nearest enclosing Git root).
   */
  currentRoot(): Promise<WorkflowRoot>;
  /**
   * Discover selectable Workflow roots: nearest + nested independent.
   * Excludes Git submodules. Marks non-GitHub roots unavailable.
   */
  listRoots(): Promise<WorkflowRoot[]>;
  /**
   * Switch the selected Workflow root to a previously discovered path.
   * Throws if the path is not in the discovered set.
   */
  selectRoot(rootPath: string): Promise<WorkflowRoot>;
  /**
   * Effective Worker profile after global → Workflow-root → snapshot precedence.
   * `undefined` when no layer is configured.
   */
  getWorkerProfile(): Promise<ResolvedWorkerProfile | undefined>;
  /** Configured global default Worker profile (no root/snapshot override). */
  getGlobalWorkerProfile(): Promise<WorkerProfile | undefined>;
  /** Configured Workflow-root Worker profile override for the current root. */
  getRootWorkerProfile(): Promise<WorkerProfile | undefined>;
  /**
   * Persist a global default Worker profile.
   * Does not change the Workflow home currently selected model.
   * Thinking level must be supported by the selected model when the catalog is available.
   */
  setGlobalWorkerProfile(profile: WorkerProfile): Promise<void>;
  /**
   * Persist a Workflow-root Worker profile override for the current root.
   * Does not change the Workflow home currently selected model.
   */
  setRootWorkerProfile(profile: WorkerProfile): Promise<void>;
  /** Remove the Workflow-root Worker profile override (global default remains). */
  clearRootWorkerProfile(): Promise<void>;
  /**
   * Authenticated available models from Pi’s catalog.
   * Used by Worker profile menus; never mutates the home model.
   */
  listAvailableModels(): Promise<readonly AvailableModel[]>;
  /**
   * Thinking levels supported by a model in the available catalog.
   * Returns `["off"]` when the model is unknown or has no reasoning support.
   */
  thinkingLevelsFor(
    provider: string,
    modelId: string,
  ): Promise<readonly string[]>;
};
