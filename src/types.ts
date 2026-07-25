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

/** Public Workflow coordinator seam. */
export type WorkflowCoordinator = {
  /** Run Workflow preflight against injected environment ports. */
  preflight(): Promise<PreflightResult>;
  /**
   * Return only currently available Next actions.
   * Empty when preflight fails or no stage is available yet.
   */
  nextActions(): Promise<NextAction[]>;
};
