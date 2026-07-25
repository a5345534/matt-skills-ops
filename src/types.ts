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

/** Model + thinking level used by Implementation workers. */
export type WorkerProfile = {
  modelId: string;
  thinkingLevel: string;
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
};
