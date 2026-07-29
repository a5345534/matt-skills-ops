/** Preflight check identifiers for Workflow preflight. */
export type PreflightCheckId =
  | "github-remote"
  | "gh-auth"
  | "target-branch"
  | "matt-skills"
  | "worker-profile"
  /** Canonical GitHub owner/name resolved for coordination and PR delivery. */
  | "canonical-repository"
  /** Write access to the reserved coordination-ref namespace. */
  | "coordination-refs"
  /** Repository-configured allowed merge method (never hard-coded). */
  | "merge-method"
  /** Strict stale-base / required-check protection on the Target branch. */
  | "stale-base-protection"
  /**
   * Branch protection APIs are plan-limited or absent; degraded automation may
   * be active. When ok, this is informational (does not block preflight).
   */
  | "branch-protection-unavailable"
  /** Non-interactive merge authority without manual approval or merge queue. */
  | "merge-authority";

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

/**
 * Why nextActions was empty (or routing-blocked) after a green preflight.
 * Surfaces silent-idle failures without inventing GitHub state.
 */
export type NextActionsDiagnostic = {
  /** Workflow-home route kind when known. */
  routeKind?:
    | "legacy"
    | "bound"
    | "selection-required"
    | "lease-held"
    | "unavailable"
    | "preflight-failed"
    | "unknown";
  /** Operator-visible reason when routing/home cannot produce actions. */
  reason?: string;
  /** Bound or candidate Active workflow id when known. */
  workflowId?: number;
  /** Ready frontier size when ticket progress was loaded. */
  readyCount?: number;
  /** Open ticket count when ticket progress was loaded. */
  openCount?: number;
};

/** Planning / orchestration stage identifiers known to the coordinator. */
export type StageId =
  | "create-spec"
  | "create-tickets"
  | "implement"
  | "integrate"
  | "ci-gate"
  | "workflow-pr"
  /** Target-branch refresh of the Integration branch before automatic merge. */
  | "target-refresh"
  | "cleanup"
  | "rework"
  | "follow-up"
  /** Explicit local Workflow-home binding / resume routing. */
  | "workflow-routing";

/** On-demand CI gate status for an Integration branch. Never polled in the background. */
export type CiStatus = "pending" | "success" | "failure";

/** Recovery choices after a red CI gate check. */
export type CiRecoveryDecision = "inspect" | "retry" | "leave-open";

/** Stage confirmation choices after a reviewable artifact is produced. */
export type StageConfirmationDecision = "publish" | "revise" | "cancel";

/**
 * Implementation disposition after a successful Implementation worker Stage result.
 * Close starts a serialized Integration unit; the GitHub ticket closes only after
 * Integration + CI succeed.
 */
export type ImplementationDispositionDecision =
  | "close"
  | "leave-open"
  | "investigate";

/** Lifecycle of one session-owned Implementation worker attempt (panel / local state). */
export type ImplementationWorkerStatus =
  | "running"
  | "needs-disposition"
  | "completed"
  | "failed"
  | "aborted"
  | "compatibility-recovery";

/** Reviewable Create-spec draft produced by the Matt skills adapter. */
export type SpecDraft = {
  title: string;
  body: string;
};

/**
 * One ticket in a Create-tickets breakdown.
 * `localId` and `blockedBy` are draft-local identifiers; GitHub numbers are
 * assigned only on Stage confirmation Publish.
 */
export type TicketDraft = {
  /** Draft-local id used only within the breakdown for blockedBy references. */
  localId: string;
  title: string;
  /** Ticket body (what to build / acceptance criteria). Parent and Blocked by are applied on publish. */
  body: string;
  /** localIds of tickets that must complete before this one can start. */
  blockedBy: readonly string[];
};

/** Reviewable Create-tickets draft produced by the Matt skills adapter. */
export type TicketsDraft = {
  tickets: readonly TicketDraft[];
};

/**
 * Durable orchestration stage recorded on the Workflow manifest.
 * Extended by later tickets as the workflow advances.
 * - pr-opened: Workflow PR exists (pre-merge)
 * - merged: Workflow PR merged; cleanup still available
 * - completed: post-cleanup; no longer an Active workflow
 */
export type WorkflowStage =
  | "spec-published"
  | "tickets-published"
  | "pr-opened"
  | "merged"
  | "completed";

/**
 * One ticket whose Integration unit has been merged, verified, and pushed.
 * The GitHub ticket remains open until the CI gate succeeds (later ticket).
 */
export type IntegratedTicketRef = {
  number: number;
  attempt: number;
  branchName: string;
};

/** Workflow PR recorded on the Workflow manifest. */
export type WorkflowPrRef = {
  number: number;
  url?: string;
  headBranch: string;
  baseBranch: string;
};

/** GitHub repository identity, resolved from GitHub owner/name rather than a local remote alias. */
export type CanonicalRepositoryIdentity = {
  owner: string;
  name: string;
};

/** One repository Target branch, always expressed as a fully qualified Git ref. */
export type CanonicalTargetIdentity = {
  repository: CanonicalRepositoryIdentity;
  /** For example, `refs/heads/main`; never a local path or remote alias. */
  targetRef: string;
};

/**
 * Checkout-local routing state for one Workflow home. GitHub manifests remain
 * authoritative; this only tells a checkout which Workflow ID it intends to
 * resume for one canonical Target identity.
 */
export type WorkflowHomeBinding = {
  target: CanonicalTargetIdentity;
  workflowId: number;
};

/** How a local unfinished workflow was discovered without contacting GitHub. */
export type LocalUnfinishedWorkflowSource =
  | "binding"
  | "legacy-pointer"
  | "transcripts";

/**
 * Checkout-local unfinished workflow candidate for the Matt Auto home menu.
 * Built only from local preferences/transcripts; may be stale until drill-in.
 */
export type LocalUnfinishedWorkflow = {
  workflowId: number;
  sources: readonly LocalUnfinishedWorkflowSource[];
  bound: boolean;
  label: string;
};

/**
 * A locally held checkout-ownership guard. It rejects two Workflow homes in
 * one physical checkout; remote coordination leases remain the cross-machine
 * authority.
 */
export type WorkflowHomeLock = {
  holderId: string;
  token: string;
  acquiredAt: string;
};

/** GitHub merge methods Matt Auto may record as repository policy. */
export type WorkflowMergeMethod = "merge" | "squash" | "rebase";

/** Exact PR and Target commit facts required to reason about freshness. */
export type WorkflowPrFreshness = {
  /** Exact Workflow PR head object ID observed by the coordinator. */
  headSha: string;
  /** Target object ID used for the most recent refresh and local validation, when available. */
  validatedTargetSha?: string;
  /** Repository-configured merge method; Matt Auto must not infer one. */
  mergeMethod: WorkflowMergeMethod;
};

/** States of one workflow's reconstructed Target-branch queue candidate. */
export type TargetBranchQueueState =
  | "awaiting-pr-checks"
  | "merge-ready"
  | "refreshing"
  | "retryable"
  | "transient-retry"
  | "merged";

/** A deterministic retryable outcome recorded on the owning workflow manifest. */
export type WorkflowQueueRetry = {
  /** Stable, machine-readable failure reason supplied by the coordinator. */
  reason: string;
  /** Number of attempts that have produced this outcome. */
  attempt: number;
  /** Time at which the retryable outcome was recorded. */
  failedAt: string;
};

/** A retry that is bounded and delayed because its cause is transient. */
export type TransientWorkflowQueueRetry = WorkflowQueueRetry & {
  /** The retry budget; `attempt` must not exceed this value. */
  maxAttempts: number;
  /** Earliest time at which the coordinator may retry. */
  nextRetryAt: string;
};

/**
 * Persisted queue facts. The queue itself is reconstructed from Active manifests;
 * this object never represents a mutable central queue.
 */
export type TargetBranchQueueCandidate =
  | { state: "awaiting-pr-checks" }
  | { state: "merge-ready"; mergeReadyAt: string }
  | { state: "refreshing"; mergeReadyAt?: string }
  | { state: "retryable"; retry: WorkflowQueueRetry }
  | { state: "transient-retry"; retry: TransientWorkflowQueueRetry }
  | { state: "merged" };

/** Lease generations observed by a workflow for diagnostics and fencing context. */
export type WorkflowLeaseGenerationReferences = {
  workflowCoordinator?: number;
  targetBranch?: number;
  repositoryScheduler?: number;
  workerSlot?: number;
};

/** Coordination facts carried only by version 2 workflow manifests. */
export type WorkflowCoordinationFacts = {
  /** Canonical GitHub repository plus fully qualified Target ref. */
  target: CanonicalTargetIdentity;
  /** PR head, validation base, and merge-method facts when a Workflow PR exists. */
  prFreshness?: WorkflowPrFreshness;
  /** Current queue candidate facts, if the workflow has entered delivery. */
  queueCandidate?: TargetBranchQueueCandidate;
  /** Non-authoritative lease-generation observations for diagnostics. */
  observedLeaseGenerations?: WorkflowLeaseGenerationReferences;
};

/** Shared fields preserved across every Workflow manifest version. */
type WorkflowManifestBase = {
  schema: "matt-auto/workflow-manifest";
  workflowId: number;
  /** Legacy unqualified branch name retained for backward-compatible workflow behavior. */
  targetBranch: string;
  stage: WorkflowStage;
  workerProfile: WorkerProfile;
  /** Published ticket issue numbers for this Workflow ID (after Create-tickets). */
  tickets?: readonly number[];
  /** Integration branch name once the first Integration unit has succeeded. */
  integrationBranch?: string;
  /** Tickets whose Integration units have been merged, verified, and pushed. */
  integratedTickets?: readonly IntegratedTicketRef[];
  /** Single Workflow PR from Integration branch to Target branch. */
  workflowPr?: WorkflowPrRef;
  /** When this is a Follow-up workflow, the original completed Workflow ID. */
  followUpOf?: number;
};

/** Existing single-workflow manifest format. It remains supported without migration. */
export type LegacyWorkflowManifest = WorkflowManifestBase & {
  version: 1;
};

/** Coordination-aware manifest format for independently Active workflows. */
export type CoordinationWorkflowManifest = WorkflowManifestBase & {
  version: 2;
  coordination: WorkflowCoordinationFacts;
};

/**
 * Managed Workflow manifest stored as a structured GitHub comment on the spec issue.
 * Does not alter the spec body. Version 1 remains on the legacy single-workflow path.
 */
export type WorkflowManifest =
  | LegacyWorkflowManifest
  | CoordinationWorkflowManifest;

/** Common fields exposed by every renewable remote coordination lease. */
type CoordinationLeaseBase = {
  /** Unique Workflow-home/process identity that currently holds the lease. */
  holderId: string;
  /** Monotonically increasing fencing generation. */
  generation: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  /** Present after an exact conditional release; tombstones preserve fencing monotonicity. */
  releasedAt?: string;
};

/** One workflow's coordinator lease. */
export type WorkflowCoordinatorLease = CoordinationLeaseBase & {
  kind: "workflow-coordinator";
  scope: {
    repository: CanonicalRepositoryIdentity;
    target: CanonicalTargetIdentity;
    workflowId: number;
  };
};

/** The serial lease for refresh and merge work on one canonical Target branch. */
export type TargetBranchLease = CoordinationLeaseBase & {
  kind: "target-branch";
  scope: { target: CanonicalTargetIdentity };
  /** Workflow currently using the delivery lane, when one is assigned. */
  workflowId?: number;
};

/** Short-lived lease used to allocate repository-wide Implementation worker slots. */
export type RepositorySchedulerLease = CoordinationLeaseBase & {
  kind: "repository-scheduler";
  scope: { repository: CanonicalRepositoryIdentity };
};

/** One repository-wide Implementation worker slot lease. */
export type WorkerSlotLease = CoordinationLeaseBase & {
  kind: "worker-slot";
  scope: { repository: CanonicalRepositoryIdentity; slot: number };
  workflowId: number;
  ticketNumber?: number;
};

/** Lease DTO returned by the future CoordinationPort. */
export type CoordinationLease =
  | WorkflowCoordinatorLease
  | TargetBranchLease
  | RepositorySchedulerLease
  | WorkerSlotLease;

export type CoordinationLeaseKind = CoordinationLease["kind"];
/** Alias retained for adapters that explicitly name their boundary DTOs. */
export type CoordinationLeaseDto = CoordinationLease;

/**
 * Repository-backed worker capacity policy. It is seeded once from local settings,
 * then becomes the authoritative cross-checkout capacity record.
 */
export type RepositoryWorkerCapacityPolicy = {
  schema: "matt-auto/repository-worker-capacity-policy";
  version: 1;
  repository: CanonicalRepositoryIdentity;
  workerCapacity: number;
  generation: number;
  initializedAt: string;
  updatedAt: string;
};

/**
 * Active workflow recovered from GitHub (spec issue + Workflow manifest).
 * Workflow ID is the published spec issue number.
 * Completed (post-cleanup) workflows are not Active.
 */
export type ActiveWorkflow = {
  workflowId: number;
  targetBranch: string;
  stage: WorkflowStage;
  workerProfile: WorkerProfile;
  title?: string;
  /** Published ticket issue numbers when Create-tickets has completed. */
  tickets?: readonly number[];
  /** Integration branch when at least one Integration unit has succeeded. */
  integrationBranch?: string;
  /** Tickets already integrated (ticket issues stay open until CI gate). */
  integratedTickets?: readonly IntegratedTicketRef[];
  /** Single Workflow PR when opened (or after merge, until cleanup). */
  workflowPr?: WorkflowPrRef;
  /** Coordination facts present only for a version 2 manifest. */
  coordination?: WorkflowCoordinationFacts;
  /** When this is a Follow-up workflow, the original completed Workflow ID. */
  followUpOf?: number;
};

/** A ticket that is open and has no open blockers — ready for Implementation. */
export type ReadyTicket = {
  number: number;
  title: string;
};

/**
 * Ticket progress and ready frontier computed from GitHub issue state.
 * Used by Next actions and the Workflow panel after Create-tickets publish.
 */
/** One workflow ticket row for operator lists (run brief / progress). */
export type TicketProgressItem = {
  number: number;
  title: string;
  /** GitHub issue open/closed. */
  state: "OPEN" | "CLOSED";
  /**
   * Workflow-facing status from tracker + integration bookkeeping.
   * Live worker/CI overlays may refine this on the run brief.
   */
  status: "closed" | "awaiting-ci" | "ready" | "blocked";
  /** Present when status is blocked. */
  openBlockers?: readonly number[];
};

export type TicketProgressSummary = {
  workflowId: number;
  total: number;
  open: number;
  closed: number;
  /**
   * Ready frontier: open tickets with no open blockers that are not already
   * integrated (integrated open tickets await the CI gate instead).
   */
  ready: readonly ReadyTicket[];
  /** Open tickets still gated by open blockers. */
  blocked: readonly {
    number: number;
    title: string;
    openBlockers: readonly number[];
  }[];
  /** Open integrated tickets awaiting the on-demand CI gate. */
  awaitingCi: readonly ReadyTicket[];
  /**
   * Every workflow ticket (open + closed), sorted by number, for list UIs.
   * Prefer this over reconstructing status from ready/blocked/awaitingCi alone.
   */
  items: readonly TicketProgressItem[];
};

/** Identity of one Implementation worker attempt (branch + worktree + transcript). */
export type ImplementationAttemptRef = {
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  branchName: string;
  worktreePath: string;
  workerId: string;
};

/**
 * Compact passive Workflow panel snapshot while background work is running.
 * Structured fields are the single source of truth for both the full-screen run
 * brief and the secondary compact Workflow panel (same DTO; no panel-only GitHub reads).
 */
export type WorkflowPanelState = {
  workflowId: number;
  /** Spec issue title when known (Active workflow recovery). */
  title?: string;
  /**
   * Coordinator-built compact lines (legacy/summary).
   * UI surfaces prefer `buildCompactWorkflowPanel` / `buildRunBriefViewModel` from
   * the structured fields so panel and brief stay on one derivation path.
   */
  lines: readonly string[];
  workers: readonly {
    ticketNumber: number;
    attempt: number;
    status: ImplementationWorkerStatus;
    progress?: string;
    branchName: string;
    /** Stable attempt id (e.g. implement-255-257-r2). */
    workerId?: string;
    /**
     * Exact profile passed to this worker's `pi --model` launch argument.
     * Frozen at launch, so it remains accurate if the configured profile changes.
     */
    workerProfile?: WorkerProfile;
    /** Number of Pi agent turns observed since this worker launched. */
    turnCount?: number;
    /** Epoch ms when Pi emitted the most recent `turn_start` for this worker. */
    lastTurnStartedAtMs?: number;
    /** OS pid of the `pi --mode json` child when known. */
    pid?: number;
    worktreePath?: string;
    /** Local transcript path — primary place to "go look" (no Pi session). */
    transcriptPath?: string;
    /** False when panel still says running but the OS process is gone. */
    processAlive?: boolean;
    /** Epoch ms when this worker attempt was launched (for R1 runtime). */
    startedAtMs?: number;
    /**
     * Elapsed ms for the current attempt (R1). Frozen while pipeline is paused.
     */
    runtimeMs?: number;
  }[];
  /**
   * Successful worker runs retained after they leave `workers`.
   * Exact completion facts are local transcript-backed; legacy transcripts may
   * contribute only directly observed turn counts and omit runtime.
   */
  completedWorkerRuns?: readonly CompletedWorkerTelemetry[];
  /**
   * Ready tickets temporarily withheld from Implement after Compatibility recovery.
   * Session-local; cleared on successful relaunch or after the cooldown elapses.
   */
  implementationRecovery?: readonly ImplementationRecoveryState[];
  ticketProgress?: TicketProgressSummary;
  /** Compact Integration unit status when one is pending retry or resolving conflicts. */
  integration?: {
    ticketNumber: number;
    attempt: number;
    /** running = unit currently executing (do not re-enter / do not P1-settle). */
    status: "pending-retry" | "conflict-resolution" | "running";
    branchName: string;
    reason?: string;
    /** Live elapsed while status is running (ticks on local panel polls). */
    runtimeMs?: number;
  };
  /** Compact CI gate status for open integrated tickets (no background polling). */
  ci?: readonly {
    ticketNumber: number;
    attempt: number;
    status: "awaiting-check" | "failure";
    integrationBranch: string;
    summary?: string;
    url?: string;
  }[];
  /** Compact Workflow PR status when opened or merged (pre-cleanup). */
  workflowPr?: {
    number: number;
    status: "open" | "merged";
    url?: string;
    baseBranch: string;
    headBranch: string;
  };
  /**
   * Observed parallel-delivery diagnostics for coordination-aware workflows.
   * Populated only from current manifests, coordination refs, worker processes,
   * CI facts, and persisted transcripts — never from inferred history.
   */
  parallelDelivery?: ParallelDeliveryPanelState;
  /** True when Pipeline pause is active for this coordinator session. */
  pipelinePaused: boolean;
  /** True after Run termination until a new pipeline run begins. */
  runTerminated?: boolean;
  /**
   * Wall-clock ms since `/matt-auto run` (or beginPipelineRun) started.
   * Frozen at pause start while pipeline is paused (same freeze rule as worker R1).
   */
  runElapsedMs?: number;
  /** Epoch ms when the current pipeline run began. */
  runStartedAtMs?: number;
  /** Last operator stop control that affected the run loop. */
  lastStopReason?:
    | "pipeline-pause"
    | "run-termination"
    | "emergency-stop";
  /** T1 stop-only vs T2 discard-unintegrated, when last stop was Run termination. */
  terminationMode?: RunTerminationMode;
};

/**
 * Distilled waiting/delivery state for a coordination-aware workflow.
 * Derived only from currently observed queue, lease, and PR facts.
 */
export type ParallelDeliveryWaitingState =
  | "queue-waiting"
  | "ci-pending"
  | "target-refresh"
  | "retryable-failure"
  | "lost-lease"
  | "merge-ready"
  | "merged"
  | "not-in-delivery";

/** Observed Workflow coordinator lease health for the bound workflow. */
export type CoordinatorLeaseHealthObservation =
  | {
      status: "held";
      generation: number;
      holderId: string;
      expiresAt: string;
      /** True when this Workflow home holds the live lease. */
      heldByUs: boolean;
    }
  | { status: "lost" }
  | { status: "absent" }
  | { status: "unavailable" };

/** Observed Target-branch lease holder / phase for the canonical Target. */
export type TargetBranchLeaseObservation = {
  status: "held-by-us" | "held-by-other" | "absent" | "expired" | "lost";
  holderId?: string;
  workflowId?: number;
  generation?: number;
  expiresAt?: string;
  /** Present only when this home is actively driving a known delivery phase. */
  phase?: "refresh" | "validation" | "pr-update" | "merge";
};

/**
 * Sibling Active workflow facts visible to the bound home.
 * Delivery observations only — never grants cross-workflow action ownership.
 */
export type SiblingWorkflowSummary = {
  workflowId: number;
  title?: string;
  queueState?: TargetBranchQueueState;
  workflowPr?: { number: number; status: "open" | "merged" };
  prHeadSha?: string;
  validatedTargetSha?: string;
  mergeReadyAt?: string;
  /** Live repository worker slots currently held by this sibling. */
  heldWorkerSlots: number;
};

/** One occupied repository-wide Implementation worker slot. */
export type WorkerSlotAllocationEntry = {
  slot: number;
  workflowId: number;
  ticketNumber?: number;
  /** True when the bound workflow home holds this slot. */
  ownedByBoundWorkflow: boolean;
};

/** Repository-wide worker-slot allocation observed from live leases + policy. */
export type WorkerSlotAllocationSummary = {
  capacity: number;
  occupied: readonly WorkerSlotAllocationEntry[];
  freeSlotCount: number;
  boundWorkflowHeldCount: number;
};

/**
 * Parallel-delivery panel DTO. All fields are optional observations; missing
 * values mean "not currently observed", never invented history.
 */
export type ParallelDeliveryPanelState = {
  /** Canonical repository + fully qualified Target ref for the bound workflow. */
  target: CanonicalTargetIdentity;
  /** Bound Workflow ID (same as panel.workflowId; repeated for delivery context). */
  boundWorkflowId: number;
  coordinatorLease: CoordinatorLeaseHealthObservation;
  targetBranchLease?: TargetBranchLeaseObservation;
  /** Observed queue candidate for the bound workflow. */
  queueCandidate?: TargetBranchQueueCandidate;
  /** Distilled waiting/delivery state for UI labels. */
  waitingState: ParallelDeliveryWaitingState;
  /** 1-based FIFO position among merge-ready candidates when applicable. */
  queuePosition?: number;
  /** Number of merge-ready candidates in the reconstructed Target-branch queue. */
  queueLength?: number;
  /** Exact PR head SHA from current freshness facts, when observed. */
  prHeadSha?: string;
  /** Target SHA used for the most recent refresh/validation, when observed. */
  validatedTargetSha?: string;
  /** Sibling Active workflows on the same Target (facts only). */
  siblings: readonly SiblingWorkflowSummary[];
  /** Repository-wide Implementation worker-slot allocation, when observed. */
  workerSlots?: WorkerSlotAllocationSummary;
};

/** Run termination mode: T1 stop-only vs T2 discard unintegrated attempts. */
export type RunTerminationMode = "stop-only" | "discard-unintegrated";

/** One session-owned worker attempt affected by Pause / Terminate. */
export type PipelineAffectedAttempt = {
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  kind: "implementation" | "conflict-resolution";
};

/** Outcome of Pipeline pause (abort workers + stop auto-advance). */
export type PipelinePauseResult = {
  abortedWorkerCount: number;
  affectedAttempts: readonly PipelineAffectedAttempt[];
  pipelinePaused: true;
  /** True when this home released its held Target-branch lease during Pause. */
  releasedTargetBranchLease: boolean;
  /** Number of repository worker-slot leases released for the bound workflow. */
  releasedWorkerSlotCount: number;
};

/** Outcome of resuming after Pipeline pause. */
export type PipelineResumeResult = {
  pipelinePaused: false;
};

/** Outcome of Run termination (T1 stop-only or T2 discard-unintegrated). */
export type RunTerminationResult = {
  mode: RunTerminationMode;
  abortedWorkerCount: number;
  affectedAttempts: readonly PipelineAffectedAttempt[];
  discardedBranches: readonly string[];
  discardedWorktrees: readonly string[];
  runTerminated: true;
  /** True when this home released its held Target-branch lease during Terminate. */
  releasedTargetBranchLease: boolean;
  /** Number of repository worker-slot leases released for the bound workflow. */
  releasedWorkerSlotCount: number;
};

/**
 * Outcome of a repository-scoped emergency stop.
 * Distinct from Pause/Terminate: releases the bound workflow's coordinator lease
 * in addition to workers, slots, and any held Target-branch lease.
 */
export type EmergencyStopResult = {
  abortedWorkerCount: number;
  affectedAttempts: readonly PipelineAffectedAttempt[];
  releasedTargetBranchLease: boolean;
  releasedWorkerSlotCount: number;
  releasedCoordinatorLease: boolean;
  runTerminated: true;
  lastStopReason: "emergency-stop";
};

/** One ticket withheld from auto Implement after a failed worker attempt. */
export type ImplementationRecoveryState = {
  ticketNumber: number;
  /** Epoch ms when recovery cooldown began. */
  sinceMs: number;
  /** Epoch ms when Implement may be offered again. */
  untilMs: number;
  /** Remaining cooldown in ms at the time of observation (>= 0). */
  remainingMs: number;
  /** Observed failure reason when known (provider error, missing Stage result, …). */
  reason?: string;
};

/**
 * Exact telemetry captured when a session-owned worker reports successful completion.
 * It is persisted locally in the attempt transcript and restored after reload.
 * Legacy transcripts may supply only their directly observed turn count.
 */
export type CompletedWorkerTelemetry = {
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  kind: "implementation" | "conflict-resolution";
  /** Native Pi `turn_start` events observed for this worker. */
  turnCount: number;
  /** Exact launch time when retained by the completion transcript event. */
  startedAtMs?: number;
  /** Exact successful Stage-result time when retained by the transcript event. */
  completedAtMs?: number;
  /** Frozen elapsed time from launch until the successful Stage result. */
  runtimeMs?: number;
};

/**
 * Worker protocol events derived from a worker's Pi JSON event stream.
 * Carries turn telemetry, progress, and Stage results only — no GitHub mutation authority.
 */
export type WorkerProtocolEvent =
  | {
      /** One Pi agent turn began; timestamp comes from Pi's JSON event stream. */
      type: "turn-start";
      workerId: string;
      timestampMs: number;
    }
  | {
      type: "progress";
      workerId: string;
      message: string;
    }
  | {
      /** Provider/model failure observed on the worker JSON stream (usage limit, 403, …). */
      type: "worker-error";
      workerId: string;
      message: string;
    }
  | {
      type: "stage-result";
      workerId: string;
      outcome:
        | {
            status: "completed";
            summary?: string;
            /** Local commit only; workers never push. */
            localCommitSha?: string;
          }
        | { status: "failed"; reason: string };
    }
  | {
      type: "process-exit";
      workerId: string;
      /** Process exit code; null when terminated by signal. */
      code: number | null;
    };

/**
 * One-shot Stage result for completion, failure, confirmation, or recovery.
 * Matt Auto reacts to these; it does not poll for decisions.
 */
export type StageResult =
  | {
      status: "needs-confirmation";
      stage: "create-spec";
      draft: SpecDraft;
      confirmationOptions: readonly StageConfirmationDecision[];
    }
  | {
      status: "needs-confirmation";
      stage: "create-tickets";
      draft: TicketsDraft;
      confirmationOptions: readonly StageConfirmationDecision[];
    }
  | {
      status: "running";
      stage: "implement";
      workflowId: number;
      ticketNumber: number;
      attempt: number;
      workerId: string;
      branchName: string;
      worktreePath: string;
    }
  | {
      status: "running";
      stage: "integrate";
      workflowId: number;
      ticketNumber: number;
      attempt: number;
      workerId: string;
      /** Integration branch (merge target / conflict workspace). */
      integrationBranch: string;
      /** Integration workspace when a conflict worker or known worktree exists. */
      integrationWorktreePath?: string;
      /** True when a Conflict resolution worker owns the unit. */
      conflictResolution?: true;
    }
  | {
      status: "running";
      stage: "target-refresh";
      workflowId: number;
      attempt: number;
      workerId: string;
      integrationBranch: string;
      integrationWorktreePath?: string;
      targetBranch: string;
      /** Exact Target SHA being merged, when known. */
      targetSha?: string;
      /** True when a Conflict resolution worker owns the Target-refresh merge. */
      conflictResolution?: true;
    }
  | {
      status: "needs-disposition";
      stage: "implement";
      workflowId: number;
      ticketNumber: number;
      attempt: number;
      branchName: string;
      worktreePath: string;
      workerId: string;
      summary?: string;
      dispositionOptions: readonly ImplementationDispositionDecision[];
    }
  | {
      status: "completed";
      stage: StageId;
      workflowId: number;
      /** Ticket issue numbers after Create-tickets publish. */
      tickets?: readonly number[];
      /** Ticket progress snapshot after Create-tickets publish. */
      ticketProgress?: TicketProgressSummary;
      /** Set when an Implementation disposition or Integration unit completes. */
      ticketNumber?: number;
      attempt?: number;
      disposition?: ImplementationDispositionDecision;
      /**
       * True when Close ran a successful Integration unit.
       * The GitHub ticket remains open until the CI gate succeeds.
       */
      integrated?: boolean;
      /** Integration branch after a successful Integration unit. */
      integrationBranch?: string;
      /** Integration workspace path after a successful Integration unit. */
      integrationWorktreePath?: string;
      /** Local verification summary after a successful Integration unit. */
      localVerification?: {
        ok: true;
        commands: readonly string[];
      };
      /** Branches pushed by the Workflow coordinator (never by workers). */
      pushedBranches?: readonly string[];
      branchName?: string;
      worktreePath?: string;
      /** On-demand CI gate status after an Integration unit or Check CI action. */
      ciStatus?: CiStatus;
      /** True when the CI gate closed the GitHub ticket. */
      ticketClosed?: boolean;
      /** Optional CI run URL for inspect recovery. */
      ciUrl?: string;
      /** Optional CI summary for panel / recovery. */
      ciSummary?: string;
      /** Workflow PR number after open or merge. */
      workflowPrNumber?: number;
      /** Workflow PR URL when available. */
      workflowPrUrl?: string;
      /** Target branch for the Workflow PR. */
      targetBranch?: string;
      /** Exact Target object ID used for the most recent Target-branch refresh. */
      validatedTargetSha?: string;
      /** Exact Integration / PR head SHA after a Target-branch refresh. */
      headSha?: string;
      /** Branches removed by paired Workflow cleanup (local + remote). */
      removedBranches?: readonly string[];
      /** True when paired cleanup removed local workspaces/transcripts. */
      cleanedLocal?: boolean;
      /** True when paired cleanup removed matching remote matt-auto branches. */
      cleanedRemote?: boolean;
      /** True when cleanup closed the parent Workflow spec issue (Workflow ID). */
      parentSpecClosed?: boolean;
      /** Soft-fail detail when parent close failed after artifact cleanup. */
      parentSpecCloseWarning?: string;
      /**
       * Safe auto-pull of Workflow root target branch after cleanup.
       * Soft-skipped when dirty / wrong branch / non-FF; never fails cleanup.
       */
      localPull?: {
        pulled: boolean;
        skipped?: boolean;
        branch: string;
        reason?: string;
        submodulesUpdated?: boolean;
      };
      /** Soft hygiene for dual-root gitlink refs / worktrees (issue #31). */
      gitlinkGc?: {
        deletedRemoteRefs: readonly string[];
        keptRemoteRefs: readonly string[];
        deletedLocalBranches: readonly string[];
        worktreePruned: boolean;
        errors: readonly string[];
      };
      /** Original Workflow ID when a Follow-up workflow was created. */
      followUpOf?: number;
      /** True when this Stage result is a pre-merge Rework attempt. */
      rework?: boolean;
    }
  | {
      status: "pending-ci";
      stage: "ci-gate";
      workflowId: number;
      ticketNumber: number;
      attempt: number;
      integrationBranch: string;
      integrated: true;
      ciStatus: "pending";
      ticketClosed: false;
      ciUrl?: string;
      ciSummary?: string;
      pushedBranches?: readonly string[];
      localVerification?: { ok: true; commands: readonly string[] };
      integrationWorktreePath?: string;
      branchName?: string;
      worktreePath?: string;
    }
  | {
      status: "needs-ci-recovery";
      stage: "ci-gate";
      workflowId: number;
      ticketNumber: number;
      attempt: number;
      integrationBranch: string;
      integrated: true;
      ciStatus: "failure";
      ticketClosed: false;
      recoveryOptions: readonly CiRecoveryDecision[];
      ciUrl?: string;
      ciSummary?: string;
      branchName?: string;
      worktreePath?: string;
    }
  | {
      status: "cancelled";
      stage: StageId;
    }
  | {
      status: "failed";
      stage: StageId;
      reason: string;
      ticketNumber?: number;
      attempt?: number;
      workflowId?: number;
      workflowPrNumber?: number;
      workflowPrUrl?: string;
      integrationBranch?: string;
      targetBranch?: string;
      removedBranches?: readonly string[];
      cleanedLocal?: boolean;
      cleanedRemote?: boolean;
      followUpOf?: number;
      rework?: boolean;
    }
  | {
      status: "compatibility-recovery";
      stage: StageId;
      reason: string;
      ticketNumber?: number;
      attempt?: number;
      rework?: boolean;
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
 * Workflow home's currently selected model + thinking level.
 * Offered as a one-tap Worker profile choice; never mutated by Matt Auto.
 */
export type HomeModelSelection = {
  provider: string;
  modelId: string;
  thinkingLevel: string;
  label: string;
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
   * Compact diagnostic from the most recent nextActions() call.
   * Used so /matt-auto run never reports bare idle when routing failed.
   */
  getNextActionsDiagnostic(): NextActionsDiagnostic | undefined;
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
   * Active workflow bound to this Workflow home, if any. GitHub manifests are
   * authoritative; an unbound checkout never receives an arbitrary sibling.
   */
  getActiveWorkflow(): Promise<ActiveWorkflow | undefined>;
  /**
   * Active workflows for the current Target (GitHub), for Resume / take-over UI.
   * Does not bind this home; call resume / runNextAction to take over.
   */
  listResumableActiveWorkflows(): Promise<readonly ActiveWorkflow[]>;
  /**
   * Ticket progress and ready frontier for the Active workflow.
   * `undefined` when there is no Active workflow or tickets are not published yet.
   */
  getTicketProgress(): Promise<TicketProgressSummary | undefined>;
  /**
   * Currently selected Workflow root (defaults to nearest enclosing Git root).
   */
  currentRoot(): Promise<WorkflowRoot>;
  /**
   * List unfinished workflows known only from checkout-local state.
   * Never contacts GitHub; used by the Matt Auto home menu open path.
   */
  listLocalUnfinishedWorkflows(): Promise<readonly LocalUnfinishedWorkflow[]>;
  /**
   * Point this checkout at a local unfinished Workflow ID before drill-in.
   * Local prefs only — GitHub is consulted by the subsequent workflow surface.
   */
  selectLocalUnfinishedWorkflow(workflowId: number): Promise<void>;
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
   * Replace the Active workflow's Worker profile snapshot on its GitHub manifest.
   * Required for mid-workflow model changes: snapshot outranks root/global prefs.
   * Does not change the Workflow home currently selected model.
   */
  setActiveWorkflowWorkerProfile(profile: WorkerProfile): Promise<void>;
  /**
   * Local effective Worker concurrency after Workflow-root → global → default
   * (2) precedence. It seeds a repository worker-capacity policy once for a
   * coordination-aware workflow; thereafter Implementation launch capacity is
   * the GitHub-backed repository policy, not this per-checkout value.
   * Always a positive integer; never writes to GitHub.
   */
  getEffectiveWorkerConcurrency(): Promise<number>;
  /** Configured global default Worker concurrency (no root override). */
  getGlobalWorkerConcurrency(): Promise<number | undefined>;
  /** Configured Workflow-root Worker concurrency override for the current root. */
  getRootWorkerConcurrency(): Promise<number | undefined>;
  /**
   * Persist a global default Worker concurrency.
   * Rejects non-integers and values < 1. Local prefs only — never GitHub.
   */
  setGlobalWorkerConcurrency(concurrency: number): Promise<void>;
  /**
   * Persist a Workflow-root Worker concurrency override for the current root.
   * Rejects non-integers and values < 1. Local prefs only — never GitHub.
   */
  setRootWorkerConcurrency(concurrency: number): Promise<void>;
  /** Remove the Workflow-root Worker concurrency override (global default remains). */
    clearRootWorkerConcurrency(): Promise<void>;
  /**
   * Effective live run-brief poll interval after root → global → default (500ms).
   */
  getEffectiveLiveWaitPollIntervalMs(): Promise<number>;
  getGlobalLiveWaitPollIntervalMs(): Promise<number | undefined>;
  getRootLiveWaitPollIntervalMs(): Promise<number | undefined>;
  setGlobalLiveWaitPollIntervalMs(intervalMs: number): Promise<void>;
  setRootLiveWaitPollIntervalMs(intervalMs: number): Promise<void>;
  clearRootLiveWaitPollIntervalMs(): Promise<void>;
  /**
   * Authenticated available models from Pi’s catalog.
   * Used by Worker profile menus; never mutates the home model.
   */
  listAvailableModels(): Promise<readonly AvailableModel[]>;
  /**
   * Current Workflow home model + thinking level, when Pi has one selected.
   * Used so Worker profile menus can offer "use home model".
   */
  getHomeModel(): Promise<HomeModelSelection | undefined>;
  /**
   * Thinking levels supported by a model in the available catalog.
   * Returns `["off"]` when the model is unknown or has no reasoning support.
   */
  thinkingLevelsFor(
    provider: string,
    modelId: string,
  ): Promise<readonly string[]>;
  /**
   * Passive Workflow panel snapshot for the Active workflow.
   * `undefined` when there is no Active workflow.
   *
   * `mode: "local"` — use cached Active workflow + ticket progress; only refresh
   * in-memory workers (for wait-loop ticks). Avoids GitHub GraphQL every poll.
   * `mode: "full"` (default) — reload Active workflow and ticket progress from GitHub.
   */
  getPanelState(options?: {
    mode?: "full" | "local";
  }): Promise<WorkflowPanelState | undefined>;
  /**
   * Session-local successful worker telemetry retained after workers leave the
   * live panel, so completion summaries can include already-completed tickets.
   */
  getCompletedWorkerTelemetry(
    workflowId: number,
  ): readonly CompletedWorkerTelemetry[];
  /**
   * Session-local Implementation recovery cooldowns that withhold ready tickets
   * from auto Implement after Compatibility recovery.
   */
  getImplementationRecoveryStates(): readonly ImplementationRecoveryState[];
  /** Wall-clock elapsed time for the current `/matt-auto run`, when known. */
  getPipelineRunElapsedMs(): number | undefined;
  /**
   * Apply Implementation disposition (Close / Leave open / Investigate)
   * after a successful Implementation worker Stage result.
   * Close starts a serialized Integration unit (merge + Local verification +
   * coordinator remote writes). The GitHub ticket is not closed yet.
   */
  confirmDisposition(
    decision: ImplementationDispositionDecision,
  ): Promise<StageResult>;
  /**
   * Abort all session-owned Implementation workers.
   * Used on Workflow home shutdown, reload, or Workflow-root switching.
   * Leaves GitHub state recoverable (tickets remain open / ready).
   */
  abortWorkers(): Promise<void>;
  /**
   * Release this checkout's local ownership guard and its held Workflow
   * coordinator lease. Workflow state remains recoverable on GitHub.
   * Called when a Workflow home session shuts down or switches roots.
   */
  releaseWorkflowHome(): Promise<void>;
  /**
   * Pipeline pause: abort session-owned workers and stop auto-advance.
   * Leaves GitHub issues, labels, manifests, and integrated history untouched.
   * Scoped to the bound workflow: releases its workers, slots, and any held
   * Target-branch lease without interrupting sibling workflows.
   * Confirmation is owned by the UI; this method performs the operation.
   */
  pausePipeline(): Promise<PipelinePauseResult>;
  /**
   * Clear Pipeline pause so orchestration can select Next actions again.
   * Does not resume aborted worker dialogue — orchestration-only.
   */
  resumePipeline(): Promise<PipelineResumeResult>;
  /**
   * Run termination: end the run and abort session-owned workers.
   * T2 (no successful integrate and no Workflow PR): may discard unintegrated
   * attempt workspaces/branches only. T1 (integratedTickets or workflowPr):
   * stop-only — never rewrites integrated history or reopens closed tickets.
   * Scoped to the bound workflow: releases its workers, slots, and any held
   * Target-branch lease without interrupting sibling workflows.
   * Confirmation is owned by the UI; this method performs the operation.
   */
  terminateRun(): Promise<RunTerminationResult>;
  /**
   * Repository-scoped emergency stop for this Workflow home.
   * Distinct from Pause/Terminate: aborts session-owned workers, releases the
   * bound workflow's slots, any held Target-branch lease, and the Workflow
   * coordinator lease. Sibling homes are not directly controlled; fencing
   * prevents releasing leases this home does not hold.
   * Confirmation is owned by the UI; this method performs the operation.
   */
  emergencyStop(): Promise<EmergencyStopResult>;
  /** True when Pipeline pause is active (auto-advance must not continue). */
  isPipelinePaused(): boolean;
  /** True after Run termination until {@link beginPipelineRun}. */
  isRunTerminated(): boolean;
  /**
   * Abort running Implementation workers whose tickets are blocked by open
   * upstream tickets (e.g. after Rework reopens a closed blocker).
   * Safe to call repeatedly; no-op when the frontier still lists them ready.
   */
  reconcileBlockedRunningWorkers(): Promise<{
    abortedWorkerCount: number;
    affectedAttempts: readonly PipelineAffectedAttempt[];
  }>;
  /**
   * Clear Pipeline pause / Run termination so a new auto-advance run can start.
   * Called at the start of `/matt-auto run` (or equivalent).
   */
  beginPipelineRun(): void;
  /**
   * True when auto-advance / preferred Next must not continue the run loop
   * (Pipeline pause or Run termination).
   */
  isAutoAdvanceBlocked(): boolean;
  /**
   * Retained Worker transcript events for one attempt (local, uncommitted).
   */
  getWorkerTranscript(input: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
  }): Promise<readonly unknown[]>;
};
