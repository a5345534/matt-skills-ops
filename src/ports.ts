import type {
  ActiveWorkflow,
  AvailableModel,
  SpecDraft,
  TicketsDraft,
  WorkerProfile,
  WorkflowManifest,
} from "./types.js";

/**
 * Environment facts for Workflow preflight on one Workflow root.
 * System boundary: git remotes, gh auth, branch existence.
 */
export type EnvironmentPort = {
  /** Whether the Workflow root has a GitHub remote. */
  hasGitHubRemote(): Promise<boolean>;
  /** Whether `gh` is authenticated for GitHub. */
  isGhAuthenticated(): Promise<boolean>;
  /** Whether the given branch exists locally or on a remote. */
  targetBranchExists(branch: string): Promise<boolean>;
};

/**
 * Outcome of invoking the installed `to-spec` skill as a Planning capability.
 * The adapter never publishes; it only returns a reviewable draft or a failure reason.
 */
export type CreateSpecSkillOutcome =
  | { ok: true; draft: SpecDraft }
  | { ok: false; reason: string };

/**
 * Outcome of invoking the installed `to-tickets` skill as a Planning capability.
 * The adapter never publishes; it only returns a reviewable breakdown or a failure reason.
 */
export type CreateTicketsSkillOutcome =
  | { ok: true; draft: TicketsDraft }
  | { ok: false; reason: string };

/**
 * Matt skills adapter port.
 * System boundary: skill filesystem / Pi skill catalog / runtime invocation.
 * Discovers and invokes installed skills without modifying their definitions.
 */
export type SkillsPort = {
  /** Skill names currently installed and discoverable. */
  installedSkillNames(): Promise<readonly string[]>;
  /**
   * Invoke installed `to-spec` as a Create-spec Planning-stage capability.
   * Must not publish to the issue tracker — the Workflow coordinator owns remote writes.
   * Does not modify, bundle, or pin skill definitions.
   */
  runCreateSpec(): Promise<CreateSpecSkillOutcome>;
  /**
   * Invoke installed `to-tickets` as a Create-tickets Planning-stage capability.
   * Must not publish to the issue tracker — the Workflow coordinator owns remote writes.
   * Does not modify, bundle, or pin skill definitions.
   */
  runCreateTickets(input: {
    workflowId: number;
    title?: string;
  }): Promise<CreateTicketsSkillOutcome>;
};

/**
 * One workflow ticket recovered from GitHub for frontier computation.
 * System boundary fact: issue number, title, state, and native blocked-by edges.
 */
export type TrackerTicket = {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  blockedBy: readonly { number: number; state: "OPEN" | "CLOSED" }[];
};

/**
 * GitHub issue-tracker operations owned by the Workflow coordinator.
 * System boundary: `gh` / GitHub remote writes and reads.
 */
export type TrackerPort = {
  /**
   * Create a GitHub issue. For Create-spec publish, the issue number becomes the Workflow ID.
   */
  createIssue(input: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<{ number: number }>;
  /**
   * Write the managed Workflow manifest comment on a spec issue.
   * Replaces a previous managed manifest comment when one exists.
   */
  writeWorkflowManifest(
    issueNumber: number,
    manifest: WorkflowManifest,
  ): Promise<void>;
  /**
   * Find the Active workflow for a Target branch, if any.
   * Reads GitHub issues + managed Workflow manifest comments.
   */
  findActiveWorkflow(
    targetBranch: string,
  ): Promise<ActiveWorkflow | undefined>;
  /**
   * Load ticket issues by number for frontier / progress computation.
   * Missing issues are omitted from the result.
   */
  listTickets(issueNumbers: readonly number[]): Promise<readonly TrackerTicket[]>;
  /**
   * Add a native GitHub blocked-by relationship:
   * `issueNumber` is blocked by `blockerIssueNumber`.
   */
  addBlockedBy(
    issueNumber: number,
    blockerIssueNumber: number,
  ): Promise<void>;
  /**
   * Link a child ticket as a GitHub sub-issue of the Workflow ID parent.
   */
  addSubIssue(
    parentIssueNumber: number,
    childIssueNumber: number,
  ): Promise<void>;
};

/**
 * Local preferences and rebuildable cache.
 * System boundary: `.pi/matt-auto/` and global Matt Auto prefs.
 *
 * Worker profile layers are stored separately; the Workflow coordinator
 * resolves precedence (snapshot → root → global).
 */
export type PreferencesPort = {
  /**
   * Configured Target branch override for the Workflow root.
   * `undefined` means use the Matt Auto default (`main`).
   */
  getConfiguredTargetBranch(): Promise<string | undefined>;
  /** Global default Worker profile, if set. */
  getGlobalWorkerProfile(): Promise<WorkerProfile | undefined>;
  /** Workflow-root Worker profile override, if set. */
  getRootWorkerProfile(): Promise<WorkerProfile | undefined>;
  /**
   * Worker profile snapshot captured by an Active workflow, if any.
   * Later tickets populate this from the Workflow manifest.
   */
  getWorkflowSnapshotWorkerProfile(): Promise<WorkerProfile | undefined>;
  /** Persist the global default Worker profile. */
  setGlobalWorkerProfile(profile: WorkerProfile): Promise<void>;
  /** Persist the Workflow-root Worker profile override. */
  setRootWorkerProfile(profile: WorkerProfile): Promise<void>;
  /** Clear the Workflow-root Worker profile override. */
  clearRootWorkerProfile(): Promise<void>;
};

/**
 * Pi authenticated available-model catalog.
 * System boundary: Pi ModelRegistry / model runtime.
 * Never mutates the Workflow home currently selected model.
 */
export type ModelsPort = {
  /** Models currently available under authenticated providers. */
  listAvailableModels(): Promise<readonly AvailableModel[]>;
};

/**
 * A nested Git repository found under a parent Workflow root.
 * System boundary: filesystem / git topology (facts only).
 */
export type NestedGitRepository = {
  path: string;
  /** True when this nested repo is a Git submodule of the parent. */
  isSubmodule: boolean;
};

/**
 * Git repository topology for Root selection.
 * System boundary: git roots and nested repository layout.
 * Product rules (submodule exclusion, availability) live in the coordinator.
 */
export type GitTopologyPort = {
  /**
   * Nearest enclosing Git repository for startPath.
   * `undefined` when startPath is not inside a Git repository.
   */
  nearestGitRoot(startPath: string): Promise<string | undefined>;
  /**
   * Nested Git repositories under parentRoot (not including parentRoot itself).
   * Includes both independent clones and submodules; the coordinator filters.
   */
  nestedGitRepositories(
    parentRoot: string,
  ): Promise<readonly NestedGitRepository[]>;
};

/** Root-scoped ports rebound when the selected Workflow root changes. */
export type RootScopedPorts = {
  environment: EnvironmentPort;
  skills: SkillsPort;
  preferences: PreferencesPort;
  tracker: TrackerPort;
};

/** Ports injected into the Workflow coordinator. */
export type WorkflowCoordinatorPorts = {
  /** Working directory used as the Root selection starting point. */
  startPath: string;
  topology: GitTopologyPort;
  /** Pi available-model catalog (session-scoped, not root-scoped). */
  models: ModelsPort;
  /** Create environment / skills / preferences bound to a Workflow root path. */
  forRoot(rootPath: string): RootScopedPorts;
};
