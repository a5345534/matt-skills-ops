import type {
  ActiveWorkflow,
  AvailableModel,
  CanonicalRepositoryIdentity,
  CanonicalTargetIdentity,
  CiStatus,
  CoordinationLease,
  CoordinationLeaseKind,
  HomeModelSelection,
  RepositoryWorkerCapacityPolicy,
  SpecDraft,
  TicketsDraft,
  WorkerProfile,
  WorkerProtocolEvent,
  WorkflowHomeBinding,
  WorkflowHomeLock,
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
  /**
   * Best-effort default branch for this Workflow root when preferences do not
   * set Target branch: origin/HEAD, then common names that exist (main/master/…).
   * Undefined when nothing can be detected.
   */
  detectDefaultBranch(): Promise<string | undefined>;
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
   * Supports ticket-to-Integration conflicts and Target-branch refresh conflicts.
   * Returns the prompt/command the worker process should run in the Integration workspace.
   * Does not invent a separate conflict-resolution skill; does not modify skill definitions.
   */
  prepareResolveConflicts(
    input: PrepareResolveConflictsInput,
  ): Promise<PrepareResolveConflictsOutcome>;
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
 * Ticket-to-Integration conflict context for the installed resolving-merge-conflicts skill.
 * `kind` is optional for backward-compatible call sites; omitted means ticket-integration.
 */
export type TicketIntegrationConflictInput = {
  kind?: "ticket-integration";
  ticketNumber: number;
  ticketBranch: string;
  integrationBranch: string;
};

/**
 * Target-branch refresh conflict context for the same installed skill.
 * Identifies the Integration branch, Target branch, expected target SHA, and
 * optional lease generation so the worker can resolve without inventing state.
 */
export type TargetRefreshConflictInput = {
  kind: "target-refresh";
  integrationBranch: string;
  targetBranch: string;
  /** Exact Target object ID fetched for this refresh attempt. */
  targetSha: string;
  /** Observed Target-branch lease generation for diagnostics, when known. */
  targetLeaseGeneration?: number;
  workflowId?: number;
};

/** Input for preparing either ticket-to-Integration or Target-refresh conflict resolution. */
export type PrepareResolveConflictsInput =
  | TicketIntegrationConflictInput
  | TargetRefreshConflictInput;

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
 * Outcome of fetching the current Target branch and merging it into the Integration branch.
 * Local only — never rebases and never pushes (especially never to the Target branch).
 * On conflict, preserves the in-progress merge for a Conflict resolution worker.
 */
export type TargetRefreshResult =
  | {
      ok: true;
      /** Exact Target object ID that was merged into the Integration branch. */
      targetSha: string;
      mergeCommitSha?: string;
      /** True when the Integration branch already contained the Target tip. */
      alreadyUpToDate?: boolean;
    }
  | {
      ok: false;
      reason: "conflict" | "error";
      message: string;
      /** Target SHA when fetch succeeded before the merge failed. */
      targetSha?: string;
    };

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
   * Fetch the current Target branch and merge it into the Integration branch
   * inside the Integration workspace. Local only — never rebases, never pushes,
   * and never writes the Target branch. On conflict, preserves the in-progress
   * merge for a Conflict resolution worker (does not abort).
   */
  refreshIntegrationFromTarget(input: {
    workflowId: number;
    /** Bare Target branch name or fully qualified `refs/heads/...` ref. */
    targetBranch: string;
    /** Remote name used to fetch the Target tip (default `origin`). */
    remote?: string;
  }): Promise<TargetRefreshResult>;
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
/**
 * Safe Workflow-root pull after cleanup.
 * Soft outcomes: skip when dirty / wrong branch / non-FF; never force/reset.
 */
export type SafePullResult =
  | {
      ok: true;
      pulled: true;
      branch: string;
      /** True when submodule checkouts were updated to recorded gitlinks. */
      submodulesUpdated?: boolean;
    }
  | {
      ok: true;
      pulled: false;
      skipped: true;
      branch: string;
      reason: string;
    }
  | {
      ok: false;
      branch: string;
      reason: string;
    };

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
  /**
   * Safely fast-forward the Workflow root to origin/<branch> when safe:
   * clean worktree, HEAD on that branch, FF-only. Soft-skips otherwise.
   * Optionally updates submodules to recorded gitlinks after a successful pull.
   */
  safePullBranch(branchName: string): Promise<SafePullResult>;
};

/**
 * Deterministic identity for one remote coordination lease record.
 * The remote CoordinationPort derives its reserved ref name from this key.
 */
export type CoordinationLeaseKey =
  | {
      kind: "workflow-coordinator";
      repository: CanonicalRepositoryIdentity;
      target: CanonicalTargetIdentity;
      workflowId: number;
    }
  | {
      kind: "target-branch";
      target: CanonicalTargetIdentity;
    }
  | {
      kind: "repository-scheduler";
      repository: CanonicalRepositoryIdentity;
    }
  | {
      kind: "worker-slot";
      repository: CanonicalRepositoryIdentity;
      slot: number;
    };

/** Lease-acquisition request. `holderId` must identify one live Workflow home/process. */
export type AcquireCoordinationLeaseInput =
  | (Extract<CoordinationLeaseKey, { kind: "workflow-coordinator" }> & {
      holderId: string;
      /** Optional positive TTL override, primarily useful for deterministic tests. */
      ttlMs?: number;
    })
  | (Extract<CoordinationLeaseKey, { kind: "target-branch" }> & {
      holderId: string;
      /** Workflow currently assigned the serial delivery lane, when any. */
      workflowId?: number;
      ttlMs?: number;
    })
  | (Extract<CoordinationLeaseKey, { kind: "repository-scheduler" }> & {
      holderId: string;
      ttlMs?: number;
    })
  | (Extract<CoordinationLeaseKey, { kind: "worker-slot" }> & {
      holderId: string;
      workflowId: number;
      ticketNumber?: number;
      ttlMs?: number;
    });

/** Result of conditionally acquiring one lease from its observed remote ref state. */
export type AcquireCoordinationLeaseResult =
  | { acquired: true; lease: CoordinationLease }
  | {
      acquired: false;
      /** `held` is an observed live holder; `contended` changed during acquisition. */
      reason: "held" | "contended";
      lease?: CoordinationLease;
    };

/** Result of a conditional heartbeat/renewal. */
export type RenewCoordinationLeaseResult =
  | { renewed: true; lease: CoordinationLease }
  | {
      renewed: false;
      reason: "not-found" | "lost" | "expired" | "contended";
      lease?: CoordinationLease;
    };

/** Result of a conditional release. A stale holder never releases a newer generation. */
export type ReleaseCoordinationLeaseResult =
  | { released: true }
  | { released: false; reason: "not-found" | "lost" | "contended" };

/** Current fencing/expiry check for an already acquired lease. */
export type VerifyCoordinationLeaseResult =
  | { valid: true; lease: CoordinationLease }
  | {
      valid: false;
      reason: "not-found" | "lost" | "expired";
      lease?: CoordinationLease;
    };

/** Result of atomically seeding the repository-wide worker-capacity policy once. */
export type EnsureRepositoryWorkerCapacityPolicyResult = {
  policy: RepositoryWorkerCapacityPolicy;
  /** True only for the contender whose exact absent-ref create succeeded. */
  initialized: boolean;
};

/** Result of a conditional policy generation update. */
export type UpdateRepositoryWorkerCapacityPolicyResult =
  | { updated: true; policy: RepositoryWorkerCapacityPolicy }
  | { updated: false; reason: "not-found" }
  | {
      updated: false;
      reason: "generation-mismatch" | "contended";
      policy: RepositoryWorkerCapacityPolicy;
    };

/**
 * Remote coordination boundary. It owns reserved-ref names, record validation,
 * exact conditional updates, fencing checks, expiry recovery, and the
 * repository-wide worker-capacity policy. Workflow coordinators never issue
 * raw coordination-ref Git commands themselves.
 */
export type CoordinationPort = {
  /** Read a lease record, including expired or conditionally released tombstones a contender may reclaim. */
  getLease(key: CoordinationLeaseKey): Promise<CoordinationLease | undefined>;
  /** List valid lease records for one repository; expired and released tombstones are included. */
  listLeases(input: {
    repository: CanonicalRepositoryIdentity;
    kind?: CoordinationLeaseKind;
  }): Promise<readonly CoordinationLease[]>;
  /** Conditionally acquire an absent or expired lease with a new fencing generation. */
  acquireLease(
    input: AcquireCoordinationLeaseInput,
  ): Promise<AcquireCoordinationLeaseResult>;
  /** Conditionally update heartbeat/expiry only when holder and generation still match. */
  renewLease(input: {
    lease: CoordinationLease;
    ttlMs?: number;
  }): Promise<RenewCoordinationLeaseResult>;
  /** Conditionally mark only the exact holder/generation released, preserving its fence tombstone. */
  releaseLease(lease: CoordinationLease): Promise<ReleaseCoordinationLeaseResult>;
  /** Verify current holder, fencing generation, and TTL before an irreversible action. */
  verifyLease(lease: CoordinationLease): Promise<VerifyCoordinationLeaseResult>;
  /** Read the authoritative repository-wide worker-capacity policy. */
  getWorkerCapacityPolicy(
    repository: CanonicalRepositoryIdentity,
  ): Promise<RepositoryWorkerCapacityPolicy | undefined>;
  /**
   * Seed policy from an existing local concurrency value exactly once. Once a
   * policy exists, every contender receives that remote authoritative value.
   */
  ensureWorkerCapacityPolicy(input: {
    repository: CanonicalRepositoryIdentity;
    seedWorkerCapacity: number;
  }): Promise<EnsureRepositoryWorkerCapacityPolicyResult>;
  /**
   * Change capacity only when the caller observed the current policy generation.
   * This is intentionally separate from first-time initialization.
   */
  updateWorkerCapacityPolicy(input: {
    repository: CanonicalRepositoryIdentity;
    workerCapacity: number;
    expectedGeneration: number;
  }): Promise<UpdateRepositoryWorkerCapacityPolicyResult>;
};

/** Result of attempting to own one physical Workflow-home checkout. */
export type AcquireWorkflowHomeLockResult =
  | { acquired: true; lock: WorkflowHomeLock }
  | { acquired: false; holderId?: string };

/**
 * Checkout-local ownership guard. It rejects two Workflow homes in the same
 * clone/worktree; CoordinationPort remains the cross-machine authority.
 */
export type WorkflowHomeLockPort = {
  acquire(input: { holderId: string }): Promise<AcquireWorkflowHomeLockResult>;
  renew(lock: WorkflowHomeLock): Promise<{ renewed: boolean }>;
  release(lock: WorkflowHomeLock): Promise<{ released: boolean }>;
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
   * Resolve the canonical GitHub owner/name identity for this Workflow root.
   * Optional while legacy version-1 workflow routing remains supported.
   */
  getCanonicalRepositoryIdentity?(): Promise<CanonicalRepositoryIdentity | undefined>;
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
   * Discover every Active workflow for one canonical GitHub repository and fully
   * qualified Target ref. Implementations must paginate all candidate issues and
   * never select an arbitrary first match.
   */
  findActiveWorkflows(
    target: CanonicalTargetIdentity,
  ): Promise<readonly ActiveWorkflow[]>;
  /**
   * Discover coordination-aware Active workflows across every Target branch in
   * one canonical repository. Repository worker scheduling uses this broader
   * view because worker capacity is repository-scoped, not checkout- or
   * Target-scoped. Optional while older test/third-party TrackerPorts migrate;
   * callers fail closed or fall back to their exact Target snapshot.
   */
  findActiveWorkflowsForRepository?(
    repository: CanonicalRepositoryIdentity,
  ): Promise<readonly ActiveWorkflow[]>;
  /**
   * Legacy single-workflow lookup used only by version 1 coordinator routing.
   * When no hint is available, implementations return a workflow only if exactly
   * one matches; parallel manifests are never collapsed to an arbitrary result.
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
   * Legacy rebuildable local pointer to the Active workflow ID for a bare
   * Target branch. New coordination-aware homes use WorkflowHomeBinding below;
   * this remains only for version-1 compatibility and one-time migration.
   */
  getActiveWorkflowId(targetBranch: string): Promise<number | undefined>;
  setActiveWorkflowId(
    targetBranch: string,
    workflowId: number,
  ): Promise<void>;
  clearActiveWorkflowId(targetBranch: string): Promise<void>;
  /**
   * Checkout-local Workflow-home binding keyed by canonical repository + fully
   * qualified Target ref. It is routing state only; GitHub remains authoritative.
   * Optional while old preference files and legacy v1 routing remain supported.
   */
  getWorkflowHomeBinding?(
    target: CanonicalTargetIdentity,
  ): Promise<WorkflowHomeBinding | undefined>;
  setWorkflowHomeBinding?(binding: WorkflowHomeBinding): Promise<void>;
  clearWorkflowHomeBinding?(target: CanonicalTargetIdentity): Promise<void>;
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
  /** Remote fenced lease records for coordination-aware Workflow manifests. */
  coordination?: CoordinationPort;
  /** Local guard against two Workflow homes sharing this exact checkout. */
  workflowHomeLock?: WorkflowHomeLockPort;
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
