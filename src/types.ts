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
export type StageId =
  | "create-spec"
  | "create-tickets"
  | "implement"
  | "integrate"
  | "ci-gate"
  | "workflow-pr"
  | "cleanup"
  | "rework"
  | "follow-up";

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
  ticketProgress?: TicketProgressSummary;
  /** Compact Integration unit status when one is pending retry or resolving conflicts. */
  integration?: {
    ticketNumber: number;
    attempt: number;
    /** running = unit currently executing (do not re-enter / do not P1-settle). */
    status: "pending-retry" | "conflict-resolution" | "running";
    branchName: string;
    reason?: string;
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
  lastStopReason?: "pipeline-pause" | "run-termination";
  /** T1 stop-only vs T2 discard-unintegrated, when last stop was Run termination. */
  terminationMode?: RunTerminationMode;
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
};

/**
 * Exact telemetry captured when a session-owned worker reports successful completion.
 * It is session-local: recovered historical attempts are never inferred.
 */
export type CompletedWorkerTelemetry = {
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  kind: "implementation" | "conflict-resolution";
  /** Native Pi `turn_start` events observed for this worker. */
  turnCount: number;
  /** Frozen elapsed time from launch until the successful Stage result. */
  runtimeMs: number;
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
   * Ticket progress and ready frontier for the Active workflow.
   * `undefined` when there is no Active workflow or tickets are not published yet.
   */
  getTicketProgress(): Promise<TicketProgressSummary | undefined>;
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
   * Effective Worker concurrency after Workflow-root → global → default (2) precedence.
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
   * Pipeline pause: abort session-owned workers and stop auto-advance.
   * Leaves GitHub issues, labels, manifests, and integrated history untouched.
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
   * Confirmation is owned by the UI; this method performs the operation.
   */
  terminateRun(): Promise<RunTerminationResult>;
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
