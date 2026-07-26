import type {
  ActiveWorkflow,
  AvailableModel,
  CiStatus,
  HomeModelSelection,
  SpecDraft,
  TicketsDraft,
  WorkerProfile,
  WorkerProtocolEvent,
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
  /**
   * Prepare an Implementation worker invocation for the installed `implement` skill.
   * Returns the prompt/command the worker process should run in the Implementation workspace.
   * Does not start a process and does not modify skill definitions.
   */
  prepareImplement(input: {
    ticketNumber: number;
    title: string;
  }): Promise<PrepareImplementOutcome>;
  /**
   * Prepare a Conflict resolution worker for the installed `resolving-merge-conflicts` skill.
   * Returns the prompt/command the worker process should run in the Integration workspace.
   * Does not invent a separate conflict-resolution skill; does not modify skill definitions.
   */
  prepareResolveConflicts(input: {
    ticketNumber: number;
    ticketBranch: string;
    integrationBranch: string;
  }): Promise<PrepareResolveConflictsOutcome>;
};

/** Outcome of preparing the installed `implement` skill for a worker. */
export type PrepareImplementOutcome =
  | {
      ok: true;
      /** Slash command / skill entrypoint, e.g. `/implement`. */
      skillCommand: string;
      /** Full prompt delivered to the worker process. */
      prompt: string;
    }
  | { ok: false; reason: string };

/**
 * Outcome of preparing the installed `resolving-merge-conflicts` skill for a worker.
 * Same shape as PrepareImplementOutcome; separate name for the Matt skills adapter boundary.
 */
export type PrepareResolveConflictsOutcome = PrepareImplementOutcome;

/** Outcome of a local merge into the Integration branch. */
export type IntegrationMergeResult =
  | { ok: true; mergeCommitSha?: string }
  | { ok: false; reason: "conflict" | "error"; message: string };

/**
 * Local Implementation / Integration workspace (branch + worktree) operations.
 * System boundary: git worktree/branch layout outside the Workflow root.
 * Never pushes remotes — workers and workspace setup stay local.
 */
export type WorkspacePort = {
  /**
   * Create an isolated Implementation workspace as a sibling of the Workflow root.
   * Branch: matt-auto/<Workflow ID>/ticket-<n>/r<attempt>
   */
  createImplementationWorkspace(input: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
    /**
     * Base ref to branch from.
     * Target branch until an Integration branch exists; Integration branch after
     * successful Integration units so dependents see integrated code.
     */
    baseRef: string;
  }): Promise<{ branchName: string; worktreePath: string }>;
  /**
   * Ensure an Implementation workspace exists for an existing (or recoverable) attempt.
   * Reattaches a worktree when the attempt branch already exists; creates branch+worktree
   * from baseRef only when neither is present. Used when Resume / re-implement reuses the
   * latest unintegrated attempt instead of opening blind rN+1.
   */
  ensureImplementationWorkspace(input: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
    baseRef: string;
  }): Promise<{ branchName: string; worktreePath: string }>;
  /**
   * Highest existing attempt number for a ticket under this Workflow ID, or 0 if none.
   */
  latestAttempt(workflowId: number, ticketNumber: number): Promise<number>;
  /**
   * Ensure the dedicated Integration workspace exists for this Workflow ID.
   * Branch: matt-auto/<Workflow ID>. Worktree is a sibling outside the Workflow root.
   * Creates the Integration branch from baseRef when it does not yet exist.
   * Local only — never pushes.
   */
  ensureIntegrationWorkspace(input: {
    workflowId: number;
    /** Base ref used only when creating the Integration branch for the first time. */
    baseRef: string;
  }): Promise<{ branchName: string; worktreePath: string }>;
  /**
   * Merge a ticket branch into the Integration branch inside the Integration workspace.
   * Local only — never pushes. On conflict, preserves the in-progress merge for a
   * Conflict resolution worker (does not abort) and advances no remote state.
   */
  mergeIntoIntegration(input: {
    workflowId: number;
    ticketBranch: string;
  }): Promise<IntegrationMergeResult>;
  /**
   * List local matt-auto branches owned by a Workflow ID
   * (Integration branch + ticket attempt branches).
   */
  listWorkflowBranches(workflowId: number): Promise<readonly string[]>;
  /**
   * Remove local Implementation/Integration worktrees and matching local branches
   * for a Workflow ID. Does not touch remotes or GitHub history.
   */
  cleanupWorkflowWorkspaces(workflowId: number): Promise<{
    removedWorktrees: readonly string[];
    removedLocalBranches: readonly string[];
  }>;
  /**
   * Remove specific local worktrees and branches (Run termination T2).
   * Does not touch remotes, GitHub history, or branches not listed.
   */
  removeLocalBranches(branchNames: readonly string[]): Promise<{
    removedWorktrees: readonly string[];
    removedLocalBranches: readonly string[];
  }>;
  /**
   * True when the worktree HEAD has commits not contained in baseRef
   * (used to infer Implementation success if the worker omits Stage result JSON).
   */
  hasCommitsAhead(input: {
    worktreePath: string;
    baseRef: string;
  }): Promise<{ ahead: boolean; headSha?: string; count: number }>;
};

/** Outcome of Local verification in the Integration workspace. */
export type LocalVerificationResult =
  | { ok: true; commands: readonly string[] }
  | { ok: false; reason: string; commands: readonly string[] };

/** On-demand CI gate check result for one branch. Never polled in a loop. */
export type CiCheckResult = {
  status: CiStatus;
  url?: string;
  summary?: string;
};

/**
 * GitHub Actions / checks CI gate.
 * On-demand only — the Workflow coordinator never starts a background poll loop.
 */
export type CiPort = {
  checkStatus(input: { branchName: string }): Promise<CiCheckResult>;
};

/**
 * Project-discoverable Local verification checks.
 * System boundary: package scripts / project tooling inside a worktree.
 * Runs only after a local Integration unit merge and before any remote push.
 */
export type VerificationPort = {
  /**
   * Discover and run project checks in the given worktree (Integration workspace).
   * Empty discovery is success (nothing to fail). Command failure fails closed.
   */
  runLocalVerification(worktreePath: string): Promise<LocalVerificationResult>;
};

/**
 * Remote Git writes owned exclusively by the Workflow coordinator.
 * System boundary: `git push` to the Workflow root remote.
 * Workers never receive this port.
 */
export type RemoteGitPort = {
  /**
   * Push a local branch to the Workflow root remote.
   * Only the Workflow coordinator may call this after Local verification succeeds.
   */
  pushBranch(branchName: string): Promise<void>;
  /**
   * Delete remote branches (paired Workflow cleanup).
   * Only the Workflow coordinator may call this after Workflow PR merge.
   */
  deleteRemoteBranches(branchNames: readonly string[]): Promise<void>;
};

/** Launch parameters for one session-owned Implementation worker. */
export type WorkerLaunchInput = {
  workerId: string;
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  worktreePath: string;
  branchName: string;
  workerProfile: WorkerProfile;
  ticketTitle: string;
  /** Prompt produced by the Matt skills adapter for `/implement`. */
  prompt: string;
  skillCommand: string;
};

/**
 * Live OS process identity for a session-owned worker.
 * Workers use `pi --no-session` — there is no Pi session to open; inspect via
 * pid + worktree + transcript instead.
 */
export type WorkerRuntimeInfo = {
  workerId: string;
  /** OS process id when known. */
  pid?: number;
  /** True when the child is still in the process table. */
  alive: boolean;
};

/**
 * Sink for Worker protocol events mapped from the worker's Pi JSON event stream.
 * The Workflow coordinator processes Stage results and progress; the sink carries
 * no GitHub mutation authority.
 */
export type WorkerEventSink = {
  onEvent(event: WorkerProtocolEvent): void | Promise<void>;
};

/**
 * Session-owned Implementation worker processes.
 * System boundary: Pi child process / JSON event stream.
 * Workers only modify, test, and commit inside local worktrees.
 */
export type WorkersPort = {
  /**
   * Start a session-owned Implementation worker that runs `/implement` in the workspace.
   * Lifetime is bound to Workflow home; abort on shutdown/reload/root switch.
   * Returns the OS process identity for logs / panel inspection.
   */
  launch(
    input: WorkerLaunchInput,
    sink: WorkerEventSink,
  ): Promise<WorkerRuntimeInfo>;
  /** Current OS runtime for a launched worker (undefined if not tracked). */
  getRuntime(workerId: string): WorkerRuntimeInfo | undefined;
  /** Abort one worker cleanly. */
  abort(workerId: string): Promise<void>;
  /** Abort all workers owned by this session. */
  abortAll(): Promise<void>;
};

/** Key for a retained Worker transcript attempt. */
export type TranscriptKey = {
  workflowId: number;
  ticketNumber: number;
  attempt: number;
};

/**
 * Local Worker transcript storage.
 * System boundary: rebuildable Matt Auto run storage under `.pi/matt-auto/`.
 * Transcripts are local and uncommitted; never published to GitHub.
 */
export type TranscriptPort = {
  /** Append one structured JSON event for a Worker attempt. */
  append(key: TranscriptKey, event: unknown): Promise<void>;
  /** Read retained transcript events for an attempt (empty when none). */
  read(key: TranscriptKey): Promise<readonly unknown[]>;
  /**
   * Remove all local Worker transcripts for a Workflow ID (paired cleanup).
   * Never touches GitHub history.
   */
  cleanupWorkflowTranscripts(workflowId: number): Promise<void>;
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
   * When `hintWorkflowId` is set, only that issue is loaded (fast path).
   */
  findActiveWorkflow(
    targetBranch: string,
    hintWorkflowId?: number,
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
  /**
   * Close a GitHub issue (ticket after CI gate, or parent Workflow spec after cleanup).
   * Optional comment is posted with the close when supported by gh.
   */
  closeIssue(
    issueNumber: number,
    options?: { comment?: string },
  ): Promise<void>;
  /**
   * Reopen a closed GitHub issue for a pre-merge Rework attempt.
   * Does not mutate completed workflow history after a Workflow PR merges.
   */
  reopenIssue(issueNumber: number): Promise<void>;
  /**
   * Open one Workflow PR from the Integration branch to the Target branch.
   * Only the Workflow coordinator may create the Workflow PR.
   */
  createPullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url?: string }>;
  /**
   * Merge the Workflow PR as a Next action (no manual GitHub UI required).
   */
  mergePullRequest(input: { number: number }): Promise<void>;
};

/**
 * Local preferences and rebuildable cache.
 * System boundary: `.pi/matt-auto/` and global Matt Auto prefs.
 *
 * Worker profile layers are stored separately; the Workflow coordinator
 * resolves precedence (snapshot → root → global).
 *
 * Worker concurrency layers are stored separately; the Workflow coordinator
 * resolves precedence (root → global → default 2). Local prefs only — never GitHub.
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
  /**
   * Global default Worker concurrency, if set.
   * Positive integer only; invalid stored values are treated as unset.
   */
  getGlobalWorkerConcurrency(): Promise<number | undefined>;
  /**
   * Workflow-root Worker concurrency override, if set.
   * Positive integer only; invalid stored values are treated as unset.
   */
  getRootWorkerConcurrency(): Promise<number | undefined>;
  /**
   * Persist the global default Worker concurrency.
   * Rejects non-integers and values < 1.
   */
  setGlobalWorkerConcurrency(concurrency: number): Promise<void>;
  /**
   * Persist the Workflow-root Worker concurrency override.
   * Rejects non-integers and values < 1.
   */
  setRootWorkerConcurrency(concurrency: number): Promise<void>;
  /** Clear the Workflow-root Worker concurrency override. */
  clearRootWorkerConcurrency(): Promise<void>;
  /**
   * Rebuildable local pointer to the Active workflow id for a Target branch.
   * GitHub remains authoritative; this avoids scanning every open issue on each menu open.
   */
  getActiveWorkflowId(targetBranch: string): Promise<number | undefined>;
  setActiveWorkflowId(
    targetBranch: string,
    workflowId: number,
  ): Promise<void>;
  clearActiveWorkflowId(targetBranch: string): Promise<void>;
};

/**
 * Pi authenticated available-model catalog.
 * System boundary: Pi ModelRegistry / model runtime.
 * Never mutates the Workflow home currently selected model.
 */
export type ModelsPort = {
  /** Models currently available under authenticated providers. */
  listAvailableModels(): Promise<readonly AvailableModel[]>;
  /**
   * Current Workflow home model + thinking level, if Pi has a selection.
   * Read-only; Matt Auto never changes the home model through this port.
   */
  getHomeModel(): Promise<HomeModelSelection | undefined>;
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
  workspace: WorkspacePort;
  workers: WorkersPort;
  transcripts: TranscriptPort;
  /** Project-discoverable Local verification (Integration workspace). */
  verification: VerificationPort;
  /** Coordinator-only remote Git writes (push). */
  remoteGit: RemoteGitPort;
  /** On-demand GitHub Actions CI gate (no background polling). */
  ci: CiPort;
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
